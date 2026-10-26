-- Real ask, 2026-10-26: "how is this system working right now... the
-- out station city purchase is working like the charges of fuel will be
-- calculated from the destination to that purchasing point and return
-- to that destination point — how would our this system work with the
-- calculation on the UI for rider and driver?"
--
-- Traced the real gap: TWO disconnected pricing systems coexist.
--
-- 1. The authoritative one (495/701/710, untouched since): at ACCEPT
--    time, accept_city_purchase_request already computes a genuine
--    round-trip distance fare — `v_leg_fare := ci.distance_km *
--    vehicle.per_km_pkr; v_distance_fare := v_leg_fare * 2` (there AND
--    back) — plus a detour-fuel top-up for how far the actual pickup
--    shop sits from the city's reference point, plus the driver's own
--    entered service fee. This is the REAL charge (`total_fare_pkr`)
--    and already does exactly what was asked, for every request
--    regardless of city/out-of-city — it's inherent to `cities.
--    distance_km` (home city ≈ small, other cities ≈ larger), not
--    gated by the `area` flag at all.
-- 2. The cosmetic one (732, this session): at CREATE time, the rider
--    sees a totally different number — a flat area base fee (Rs
--    300/600) + Rs 8/km one-way haversine(pickup, delivery) + tip. This
--    `estimated_fee_pkr` is stored but never read again after creation
--    — the real charge computed at accept() ignores it completely, and
--    also silently drops the rider's own tip_pkr (never added into
--    total_fare_pkr).
--
-- Net effect: what a rider sees before sending a request has nothing to
-- do with what they're actually charged once a driver accepts, and an
-- offered tip never actually reaches the total. This migration makes
-- city_purchase_fee_estimate call the SAME real distance_km/per_km_pkr
-- round-trip math as accept time (using a configurable "typical" rate
-- since no specific vehicle is assigned yet — same reasoning fare_band_
-- for already uses elsewhere), and fixes accept_city_purchase_request
-- to actually add the tip into total_fare_pkr.
--
-- NOT fixed here (flagged for the committee, not silently changed):
-- `cities` currently has two rows with is_home_city = true for the same
-- tenant (Chakwal and Mandra) — a real data-integrity issue since only
-- one city is supposed to be "home." Left alone since picking one would
-- be a business-data decision, not a code fix.

INSERT INTO site_settings (key, value, description) VALUES
  ('city_purchase_typical_per_km_pkr', '20', 'City Purchase: typical per-km rate used for the rider''s upfront estimate before a driver accepts (their own vehicle''s real rate decides the final charge)')
ON CONFLICT (tenant_id, key) DO NOTHING;

DROP FUNCTION IF EXISTS city_purchase_fee_estimate(decimal, varchar, decimal);

CREATE OR REPLACE FUNCTION city_purchase_fee_estimate(p_city_id uuid, p_pickup_lat decimal, p_pickup_lng decimal, p_tip_pkr decimal DEFAULT 0) RETURNS jsonb AS $$
DECLARE
  ci cities%ROWTYPE; v_per_km decimal; v_detour_free_km decimal;
  v_leg_fare decimal; v_distance_fare decimal; v_detour_fuel decimal := 0;
BEGIN
  SELECT * INTO ci FROM cities WHERE id = p_city_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'city_purchase_typical_per_km_pkr'), 20) INTO v_per_km;
  v_leg_fare := round_to_10(COALESCE(ci.distance_km, 0) * v_per_km);
  v_distance_fare := v_leg_fare * 2;

  IF p_pickup_lat IS NOT NULL AND p_pickup_lng IS NOT NULL AND ci.lat IS NOT NULL AND ci.lng IS NOT NULL THEN
    SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'city_purchase_detour_free_km'), 2) INTO v_detour_free_km;
    v_detour_fuel := round_to_10(GREATEST(0, haversine_km(p_pickup_lat, p_pickup_lng, ci.lat, ci.lng) - v_detour_free_km) * v_per_km);
  END IF;

  RETURN jsonb_build_object(
    'distance_fare_pkr', v_distance_fare, 'detour_fuel_pkr', v_detour_fuel,
    'tip_pkr', GREATEST(COALESCE(p_tip_pkr, 0), 0),
    'total_fee_pkr', v_distance_fare + v_detour_fuel + GREATEST(COALESCE(p_tip_pkr, 0), 0)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_fee_estimate(uuid, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_fee_estimate(uuid, decimal, decimal, decimal) TO authenticated;

-- create_city_purchase_request: same signature — just calls the
-- estimate with the city/pickup it already resolved instead of a
-- haversine(pickup, delivery) distance that had nothing to do with the
-- real accept-time formula.
CREATE OR REPLACE FUNCTION create_city_purchase_request(
  p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_goods_budget_pkr decimal DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL, p_urgency varchar DEFAULT 'standard',
  p_delivery_label text DEFAULT NULL, p_delivery_lat decimal DEFAULT NULL, p_delivery_lng decimal DEFAULT NULL,
  p_area varchar DEFAULT 'city', p_ride_type varchar DEFAULT 'bike',
  p_scheduled_date date DEFAULT NULL, p_scheduled_time time DEFAULT NULL,
  p_tip_pkr decimal DEFAULT 0, p_payment_method varchar DEFAULT 'cash'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_count int; v_estimate jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;
  IF p_urgency NOT IN ('standard', '1hr', '2hr', 'urgent') THEN RAISE EXCEPTION 'Invalid urgency.' USING ERRCODE = 'P0001'; END IF;
  IF p_area NOT IN ('city', 'out_of_city') THEN RAISE EXCEPTION 'Invalid area.' USING ERRCODE = 'P0001'; END IF;
  IF p_ride_type NOT IN ('bike', 'car') THEN RAISE EXCEPTION 'Invalid ride type.' USING ERRCODE = 'P0001'; END IF;
  IF p_area = 'out_of_city' AND p_ride_type = 'bike' THEN RAISE EXCEPTION 'A motorbike is not available for an out-of-city delivery — choose a car.' USING ERRCODE = 'P0001'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'Pick a date for this job.' USING ERRCODE = 'P0001'; END IF;
  IF p_target_vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You cannot request your own vehicle.' USING ERRCODE = 'P0001';
  END IF;

  v_estimate := city_purchase_fee_estimate(p_city_id, p_pickup_lat, p_pickup_lng, p_tip_pkr);

  INSERT INTO city_purchase_requests (
    initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status, urgency,
    delivery_label, delivery_lat, delivery_lng, area, ride_type, scheduled_date, scheduled_time, tip_pkr, payment_method, estimated_fee_pkr
  )
  VALUES (
    v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing', p_urgency,
    NULLIF(p_delivery_label, ''), p_delivery_lat, p_delivery_lng, p_area, p_ride_type, p_scheduled_date, p_scheduled_time, GREATEST(COALESCE(p_tip_pkr, 0), 0), COALESCE(p_payment_method, 'cash'),
    (v_estimate->>'total_fee_pkr')::decimal
  )
  RETURNING id INTO v_request_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM vehicles v JOIN cities ci ON ci.id = p_city_id
      WHERE v.id = p_target_vehicle_id AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city)
    ) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency, v_portal_user_id) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination) VALUES (v_request_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency, v_portal_user_id) c;
  END IF;

  SELECT count(*) INTO v_count FROM city_purchase_invitations WHERE request_id = v_request_id;
  IF v_count = 0 THEN
    UPDATE city_purchase_requests SET status = 'no_answer' WHERE id = v_request_id;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'city_purchase_invited', 'City purchase request', p_item, '/portal/marketplace/city-purchase/' || v_request_id
    FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.request_id = v_request_id AND v.portal_user_id IS NOT NULL;
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid, varchar, text, decimal, decimal, varchar, varchar, date, time, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid, varchar, text, decimal, decimal, varchar, varchar, date, time, decimal, varchar) TO authenticated;

-- accept_city_purchase_request: real bug fix — the rider's own upfront
-- tip (tip_pkr, added in 732) was captured on the request row but never
-- actually added into total_fare_pkr here, so it silently never reached
-- the driver or the rider's final charge. Same signature, no DROP
-- needed.
CREATE OR REPLACE FUNCTION accept_city_purchase_request(p_request_id uuid, p_vehicle_id uuid, p_addon_fee_pkr decimal) RETURNS jsonb AS $$
DECLARE
  v vehicles%ROWTYPE; r city_purchase_requests%ROWTYPE; ci cities%ROWTYPE;
  v_addon_min decimal; v_addon_max decimal; v_leg_fare decimal; v_distance_fare decimal;
  v_committed_tier varchar; v_detour_free_km decimal; v_detour_fuel decimal := 0; v_total decimal;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.per_km_pkr IS NULL THEN
    RAISE EXCEPTION 'Your per-km rate has not been set yet — ask the committee to set it before accepting jobs.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'ringing' THEN RAISE EXCEPTION 'This request is no longer open.' USING ERRCODE = 'P0001'; END IF;
  IF r.initiator_portal_user_id = current_portal_user_id() THEN
    RAISE EXCEPTION 'You cannot accept your own request.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(value::decimal, 100) INTO v_addon_min FROM site_settings WHERE key = 'city_purchase_addon_min_pkr';
  SELECT COALESCE(value::decimal, 1000) INTO v_addon_max FROM site_settings WHERE key = 'city_purchase_addon_max_pkr';
  IF p_addon_fee_pkr IS NULL OR p_addon_fee_pkr < v_addon_min OR p_addon_fee_pkr > v_addon_max THEN
    RAISE EXCEPTION 'Your service fee must be between % and %.', v_addon_min, v_addon_max USING ERRCODE = 'P0001';
  END IF;

  v_committed_tier := vehicle_committed_urgency_tier(p_vehicle_id);
  IF v_committed_tier IS NOT NULL AND v_committed_tier <> r.urgency THEN
    RAISE EXCEPTION 'You are committed to % deliveries right now — finish those before accepting a different urgency tier.', v_committed_tier USING ERRCODE = 'P0001';
  END IF;

  UPDATE city_purchase_invitations SET status = 'accepted', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this request, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;

  UPDATE city_purchase_invitations SET status = 'expired', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  SELECT * INTO ci FROM cities WHERE id = r.city_id;
  v_leg_fare := round_to_10(ci.distance_km * v.per_km_pkr);
  v_distance_fare := v_leg_fare * 2;

  IF r.pickup_lat IS NOT NULL AND r.pickup_lng IS NOT NULL AND ci.lat IS NOT NULL AND ci.lng IS NOT NULL THEN
    SELECT COALESCE(value::decimal, 2) INTO v_detour_free_km FROM site_settings WHERE key = 'city_purchase_detour_free_km';
    v_detour_fuel := round_to_10(GREATEST(0, haversine_km(r.pickup_lat, r.pickup_lng, ci.lat, ci.lng) - v_detour_free_km) * v.per_km_pkr);
  END IF;

  v_total := v_distance_fare + p_addon_fee_pkr + v_detour_fuel + COALESCE(r.tip_pkr, 0);

  UPDATE city_purchase_requests SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id,
    distance_fare_pkr = v_distance_fare, addon_fee_pkr = p_addon_fee_pkr, detour_fuel_pkr = v_detour_fuel,
    total_fare_pkr = v_total
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_accepted', 'City purchase accepted', v.owner_name || ' — Rs ' || v_total::text, '/portal/marketplace/city-purchase/' || p_request_id);

  RETURN city_purchase_request_detail(p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_city_purchase_request(uuid, uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_city_purchase_request(uuid, uuid, decimal) TO authenticated;

-- city_purchase_request_detail: same shape as 701's own definition
-- (including its is_party_to_city_purchase authorization check, kept
-- exactly) — only addition is tip_pkr/area/ride_type/estimated_fee_pkr
-- so the detail page can show the tip line and the original upfront
-- estimate alongside the real priced breakdown.
CREATE OR REPLACE FUNCTION city_purchase_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'request', jsonb_build_object(
      'id', r.id, 'item', r.item, 'has_item_attachment', (r.item_attachment_path IS NOT NULL), 'pickup_label', r.pickup_label,
      'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'goods_budget_pkr', r.goods_budget_pkr, 'status', r.status,
      'urgency', r.urgency,
      'distance_fare_pkr', r.distance_fare_pkr, 'addon_fee_pkr', r.addon_fee_pkr, 'detour_fuel_pkr', r.detour_fuel_pkr, 'total_fare_pkr', r.total_fare_pkr,
      'tip_pkr', r.tip_pkr, 'area', r.area, 'ride_type', r.ride_type, 'estimated_fee_pkr', r.estimated_fee_pkr,
      'actual_goods_cost_pkr', r.actual_goods_cost_pkr, 'has_bill_attachment', (r.bill_attachment_path IS NOT NULL),
      'city_name', ci.name, 'city_name_ur', ci.name_ur, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
      'initiator_portal_user_id', r.initiator_portal_user_id,
      'created_at', r.created_at
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'source', i.source, 'reference_destination', i.reference_destination,
        'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at
      ) ORDER BY i.invited_at)
      FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.request_id = r.id
    ), '[]'::jsonb)
  )
  FROM city_purchase_requests r
  JOIN cities ci ON ci.id = r.city_id
  LEFT JOIN vehicles av ON av.id = r.accepted_vehicle_id
  WHERE r.id = p_request_id AND is_party_to_city_purchase(r.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_request_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_request_detail(uuid) TO authenticated;
