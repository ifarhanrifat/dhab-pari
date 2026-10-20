-- Migration 710: real bug found live — a villager who also owns a
-- registered vehicle could get their OWN vehicle invited to their OWN
-- City Purchase / Parcel Delivery request (candidate-matching never
-- excluded the requester). They'd land on the driver-facing "ringing"
-- screen for their own request, fill in a service fee meant for a
-- responding driver, and then see "Waiting for the villager to approve
-- the price" about themselves. city_purchase_candidate_vehicles() is
-- shared verbatim by both City Purchase (701/705) and Parcel Delivery
-- (702/705) per their own header comments, so one fix covers both.
--
-- city_purchase_candidate_vehicles/city_purchase_candidates gain a
-- trailing p_exclude_portal_user_id (new arg count -> drop the exact
-- current 4-arg signatures first, same stale-overload discipline used
-- throughout this project).
DROP FUNCTION IF EXISTS city_purchase_candidate_vehicles(uuid, decimal, decimal, varchar);
DROP FUNCTION IF EXISTS city_purchase_candidates(uuid, decimal, decimal, varchar);

CREATE OR REPLACE FUNCTION city_purchase_candidate_vehicles(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL, p_urgency varchar DEFAULT NULL, p_exclude_portal_user_id uuid DEFAULT NULL)
RETURNS TABLE(vehicle_id uuid, source varchar, reference_destination text, distance_km decimal, trust_score int, trust_tier varchar) AS $$
  WITH ci AS (SELECT * FROM cities WHERE id = p_city_id),
  today AS (SELECT (now() AT TIME ZONE 'Asia/Karachi')::date AS d),
  floor_score AS (SELECT COALESCE((SELECT value::int FROM site_settings WHERE key = 'vehicle_trust_floor_score'), 15) AS v),
  candidates AS (
    SELECT v.id AS vehicle_id, 'route'::varchar AS source,
      (r.destination || CASE WHEN r.destination_ur IS NOT NULL THEN ' / ' || r.destination_ur ELSE '' END) AS reference_destination,
      CASE WHEN p_pickup_lat IS NOT NULL AND r.destination_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, r.destination_lat, r.destination_lng) END AS distance_km,
      1 AS priority
    FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id, ci, today, floor_score
    WHERE r.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (p_exclude_portal_user_id IS NULL OR v.portal_user_id IS DISTINCT FROM p_exclude_portal_user_id)
      AND (r.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND r.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (r.days_of_week && ARRAY[extract(dow FROM today.d)::int, extract(dow FROM today.d + 1)::int])
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
    UNION ALL
    SELECT v.id, 'trip_offer',
      (o.destination || CASE WHEN o.destination_ur IS NOT NULL THEN ' / ' || o.destination_ur ELSE '' END),
      CASE WHEN p_pickup_lat IS NOT NULL AND o.dest_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, o.dest_lat, o.dest_lng) END,
      1
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id, ci, today, floor_score
    WHERE o.status = 'open' AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (p_exclude_portal_user_id IS NULL OR v.portal_user_id IS DISTINCT FROM p_exclude_portal_user_id)
      AND o.travel_date BETWEEN today.d AND today.d + 1
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
    UNION ALL
    SELECT v.id, 'presence', NULL, NULL, 2
    FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id, ci, floor_score
    WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (p_exclude_portal_user_id IS NULL OR v.portal_user_id IS DISTINCT FROM p_exclude_portal_user_id)
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
  )
  SELECT DISTINCT ON (c.vehicle_id) c.vehicle_id, c.source, c.reference_destination, c.distance_km,
    vehicle_trust_score(c.vehicle_id), (vehicle_trust(c.vehicle_id)->>'tier')::varchar
  FROM candidates c
  ORDER BY c.vehicle_id, c.priority;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal, varchar, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION city_purchase_candidates(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL, p_urgency varchar DEFAULT NULL, p_exclude_portal_user_id uuid DEFAULT NULL) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type,
    'source', c.source, 'reference_destination', c.reference_destination, 'distance_km', c.distance_km,
    'trust_score', c.trust_score, 'trust_tier', c.trust_tier
  ) ORDER BY c.trust_score DESC, c.distance_km NULLS LAST, c.source, v.owner_name), '[]'::jsonb)
  FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency, p_exclude_portal_user_id) c JOIN vehicles v ON v.id = c.vehicle_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidates(uuid, decimal, decimal, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidates(uuid, decimal, decimal, varchar, uuid) TO authenticated;

-- create_city_purchase_request: same signature (no new params the rider
-- types), pass the initiator's own id through as the exclusion, and
-- reject a direct-invite of the requester's own vehicle outright (the
-- broadcast path already can't surface it once excluded above, but a
-- direct target-vehicle invite bypasses that filter, so this needs its
-- own explicit check).
CREATE OR REPLACE FUNCTION create_city_purchase_request(
  p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_goods_budget_pkr decimal DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL, p_urgency varchar DEFAULT 'standard'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;
  IF p_urgency NOT IN ('standard', '1hr', '2hr', 'urgent') THEN RAISE EXCEPTION 'Invalid urgency.' USING ERRCODE = 'P0001'; END IF;
  IF p_target_vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You cannot request your own vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO city_purchase_requests (initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status, urgency)
  VALUES (v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing', p_urgency)
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

-- create_parcel_delivery: identical fix.
CREATE OR REPLACE FUNCTION create_parcel_delivery(
  p_city_id uuid, p_description text,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_dropoff_label text DEFAULT NULL, p_dropoff_lat decimal DEFAULT NULL, p_dropoff_lng decimal DEFAULT NULL,
  p_recipient_name varchar DEFAULT NULL, p_recipient_mobile varchar DEFAULT NULL, p_target_vehicle_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_delivery_id uuid; v_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_description IS NULL OR trim(p_description) = '' THEN RAISE EXCEPTION 'Describe the parcel first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_target_vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You cannot request your own vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO parcel_deliveries (initiator_portal_user_id, city_id, description, recipient_name, recipient_mobile, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, status)
  VALUES (v_portal_user_id, p_city_id, trim(p_description), NULLIF(p_recipient_name, ''), NULLIF(p_recipient_mobile, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, NULLIF(p_dropoff_label, ''), p_dropoff_lat, p_dropoff_lng, 'ringing')
  RETURNING id INTO v_delivery_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM vehicles v JOIN cities ci ON ci.id = p_city_id
      WHERE v.id = p_target_vehicle_id AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city)
    ) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO parcel_delivery_invitations (delivery_id, vehicle_id, source, reference_destination)
    SELECT v_delivery_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, NULL, v_portal_user_id) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO parcel_delivery_invitations (delivery_id, vehicle_id, source, reference_destination) VALUES (v_delivery_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO parcel_delivery_invitations (delivery_id, vehicle_id, source, reference_destination)
    SELECT v_delivery_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, NULL, v_portal_user_id) c;
  END IF;

  SELECT count(*) INTO v_count FROM parcel_delivery_invitations WHERE delivery_id = v_delivery_id;
  IF v_count = 0 THEN
    UPDATE parcel_deliveries SET status = 'no_answer' WHERE id = v_delivery_id;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'parcel_delivery_invited', 'Parcel delivery request', p_description, '/portal/marketplace/parcel/' || v_delivery_id
    FROM parcel_delivery_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.delivery_id = v_delivery_id AND v.portal_user_id IS NOT NULL;
  END IF;

  RETURN v_delivery_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- accept_city_purchase_request / accept_parcel_delivery: defense-in-depth
-- -- the broadcast/direct-invite paths above should never offer the
-- requester's own vehicle any more, but guard the accept step itself too
-- rather than relying solely on an empty invitation list.
CREATE OR REPLACE FUNCTION accept_city_purchase_request(p_request_id uuid, p_vehicle_id uuid, p_addon_fee_pkr decimal) RETURNS jsonb AS $$
DECLARE
  v vehicles%ROWTYPE; r city_purchase_requests%ROWTYPE; ci cities%ROWTYPE;
  v_addon_min decimal; v_addon_max decimal; v_leg_fare decimal; v_distance_fare decimal;
  v_committed_tier varchar; v_detour_free_km decimal; v_detour_fuel decimal := 0;
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

  -- First accept wins — every other still-ringing invitation closes out.
  UPDATE city_purchase_invitations SET status = 'expired', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  SELECT * INTO ci FROM cities WHERE id = r.city_id;
  v_leg_fare := round_to_10(ci.distance_km * v.per_km_pkr);
  v_distance_fare := v_leg_fare * 2;

  IF r.pickup_lat IS NOT NULL AND r.pickup_lng IS NOT NULL AND ci.lat IS NOT NULL AND ci.lng IS NOT NULL THEN
    SELECT COALESCE(value::decimal, 2) INTO v_detour_free_km FROM site_settings WHERE key = 'city_purchase_detour_free_km';
    v_detour_fuel := round_to_10(GREATEST(0, haversine_km(r.pickup_lat, r.pickup_lng, ci.lat, ci.lng) - v_detour_free_km) * v.per_km_pkr);
  END IF;

  UPDATE city_purchase_requests SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id,
    distance_fare_pkr = v_distance_fare, addon_fee_pkr = p_addon_fee_pkr, detour_fuel_pkr = v_detour_fuel,
    total_fare_pkr = v_distance_fare + p_addon_fee_pkr + v_detour_fuel
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_accepted', 'City purchase accepted', v.owner_name || ' — Rs ' || (v_distance_fare + p_addon_fee_pkr + v_detour_fuel)::text, '/portal/marketplace/city-purchase/' || p_request_id);

  RETURN city_purchase_request_detail(p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION accept_parcel_delivery(p_delivery_id uuid, p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v vehicles%ROWTYPE; d parcel_deliveries%ROWTYPE; ci cities%ROWTYPE;
  v_leg_fare decimal; v_distance_fare decimal; v_detour_free_km decimal; v_detour_fuel decimal := 0;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.per_km_pkr IS NULL THEN
    RAISE EXCEPTION 'Your per-km rate has not been set yet — ask the committee to set it before accepting jobs.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found.' USING ERRCODE = 'P0001'; END IF;
  IF d.status <> 'ringing' THEN RAISE EXCEPTION 'This delivery is no longer open.' USING ERRCODE = 'P0001'; END IF;
  IF d.initiator_portal_user_id = current_portal_user_id() THEN
    RAISE EXCEPTION 'You cannot accept your own request.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE parcel_delivery_invitations SET status = 'accepted', responded_at = now()
    WHERE delivery_id = p_delivery_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this delivery, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;

  -- First accept wins — every other still-ringing invitation closes out.
  UPDATE parcel_delivery_invitations SET status = 'expired', responded_at = now()
    WHERE delivery_id = p_delivery_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  SELECT * INTO ci FROM cities WHERE id = d.city_id;
  v_leg_fare := round_to_10(ci.distance_km * v.per_km_pkr);
  v_distance_fare := v_leg_fare * 2;

  IF d.pickup_lat IS NOT NULL AND d.pickup_lng IS NOT NULL AND ci.lat IS NOT NULL AND ci.lng IS NOT NULL THEN
    SELECT COALESCE(value::decimal, 2) INTO v_detour_free_km FROM site_settings WHERE key = 'city_purchase_detour_free_km';
    v_detour_fuel := round_to_10(GREATEST(0, haversine_km(d.pickup_lat, d.pickup_lng, ci.lat, ci.lng) - v_detour_free_km) * v.per_km_pkr);
  END IF;

  UPDATE parcel_deliveries SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id,
    distance_fare_pkr = v_distance_fare, detour_fuel_pkr = v_detour_fuel, total_fare_pkr = v_distance_fare + v_detour_fuel
  WHERE id = p_delivery_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (d.initiator_portal_user_id, 'parcel_delivery_accepted', 'Parcel delivery accepted', v.owner_name || ' — Rs ' || (v_distance_fare + v_detour_fuel)::text, '/portal/marketplace/parcel/' || p_delivery_id);

  RETURN parcel_delivery_detail(p_delivery_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
