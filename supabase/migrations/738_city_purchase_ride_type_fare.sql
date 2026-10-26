-- Real bug, reported live: "when I tried to chose between the bike and
-- car in city purchase both fare remained same lol." Confirmed:
-- city_purchase_fee_estimate (733) never took ride_type as an input at
-- all — one flat "typical per-km" rate regardless of whether the rider
-- picked bike or car, so the create-time preview could never differ
-- between them. Same class of bug as the trip-share return-fare one
-- (737): a real toggle existed in the UI with no corresponding branch
-- in the pricing formula.
--
-- Two separate "typical" per-km knobs instead of one — a bike is
-- genuinely cheaper to run than a car, same real-world reasoning
-- city_purchase_base_fee_city/outstation (732) already used for area.
-- Not committee-approved numbers, just reasonable placeholders
-- (bike cheaper than car) admin-editable like every other fare knob
-- this session has added.

INSERT INTO site_settings (key, value, description) VALUES
  ('city_purchase_typical_per_km_bike_pkr', '12', 'City Purchase: typical per-km rate for a motorbike delivery, used for the rider''s upfront estimate before a driver accepts'),
  ('city_purchase_typical_per_km_car_pkr', '20', 'City Purchase: typical per-km rate for a car delivery, used for the rider''s upfront estimate before a driver accepts')
ON CONFLICT (tenant_id, key) DO NOTHING;

DROP FUNCTION IF EXISTS city_purchase_fee_estimate(uuid, decimal, decimal, decimal);

CREATE OR REPLACE FUNCTION city_purchase_fee_estimate(p_city_id uuid, p_pickup_lat decimal, p_pickup_lng decimal, p_tip_pkr decimal DEFAULT 0, p_ride_type varchar DEFAULT 'bike') RETURNS jsonb AS $$
DECLARE
  ci cities%ROWTYPE; v_per_km decimal; v_detour_free_km decimal;
  v_leg_fare decimal; v_distance_fare decimal; v_detour_fuel decimal := 0;
BEGIN
  SELECT * INTO ci FROM cities WHERE id = p_city_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key =
    CASE WHEN p_ride_type = 'car' THEN 'city_purchase_typical_per_km_car_pkr' ELSE 'city_purchase_typical_per_km_bike_pkr' END),
    CASE WHEN p_ride_type = 'car' THEN 20 ELSE 12 END) INTO v_per_km;
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
REVOKE ALL ON FUNCTION city_purchase_fee_estimate(uuid, decimal, decimal, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_fee_estimate(uuid, decimal, decimal, decimal, varchar) TO authenticated;

-- create_city_purchase_request: same signature as 733's body — just
-- forwards p_ride_type (already a real param here) into the estimate
-- call it already makes.
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

  v_estimate := city_purchase_fee_estimate(p_city_id, p_pickup_lat, p_pickup_lng, p_tip_pkr, p_ride_type);

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
