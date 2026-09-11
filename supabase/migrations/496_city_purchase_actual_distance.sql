-- Migration 496: real distance in the City Purchase candidate list,
-- plus a genuine bug fix found while building it.
--
-- ── Bug found: 494's place_trip_offer redefinition was a stale overload,
-- not a real fix ──────────────────────────────────────────────────────
-- 494 added an online/ride-eligibility guard to place_trip_offer, but
-- wrote it as CREATE OR REPLACE against the OLD 10-arg signature (no
-- p_trip_type, no p_distance_km) — the exact signature 484 itself had
-- already DROPped and replaced with a 12-arg version. 494 never checked
-- the live signature first, so instead of patching the real function it
-- silently created a second, orphaned 10-arg overload. The app has
-- always called place_trip_offer with p_trip_type and p_distance_km
-- (my-vehicle's Post Trip form, unchanged since 484), so every real
-- call keeps resolving to 484's original 12-arg version — the one
-- WITHOUT 494's guard. A driver could still post a trip while offline
-- or class-ineligible for rides this whole time; the guard only ever
-- ran inside my own test script, which — same mistake — called the
-- function without p_trip_type and so exercised the orphaned overload
-- instead of the real one. Both stale signatures are dropped here and
-- merged into one real function carrying every prior addition
-- (trip_type, distance_km) plus the 494 guard, correctly this time,
-- plus this migration's own two new params.
--
-- ── Actual distance ───────────────────────────────────────────────────
-- vehicle_routes already has destination_lat/destination_lng (399,
-- already editable via the admin route form's map-pin picker) —
-- reused as-is, zero new work needed for route-sourced candidates.
-- vehicle_trip_offers never had an equivalent, so it gets one here
-- (dest_lat/dest_lng, driver-set via the same map-pin-click UX on the
-- Post Trip form). Presence-sourced candidates still have no
-- destination point at all — "checked into the city" isn't a specific
-- place — so distance stays null for those; the UI says "distance
-- unknown" rather than fabricating a number. Uses the existing
-- haversine_km helper (475) against the request's own pickup pin
-- (already captured on city_purchase_requests) — same honesty
-- convention as every other distance figure in this app: real when the
-- inputs are real, visibly absent rather than guessed when they aren't.

-- The 494 mistake, dropped: that stray 10-arg overload.
DROP FUNCTION IF EXISTS place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal);
-- The REAL 12-arg signature (484) — also dropped, since this migration
-- is about to add two more trailing params and CREATE OR REPLACE only
-- replaces an exact signature match, not "the function with this name."
DROP FUNCTION IF EXISTS place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal, decimal);

ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS dest_lat decimal;
ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS dest_lng decimal;

CREATE OR REPLACE FUNCTION place_trip_offer(
  p_vehicle_id uuid, p_trip_type varchar, p_origin varchar, p_origin_ur varchar, p_destination varchar, p_destination_ur varchar,
  p_classification varchar, p_travel_date date, p_departure_time_estimate time, p_seats_available int, p_listed_fare_per_seat_pkr decimal,
  p_distance_km decimal DEFAULT NULL, p_dest_lat decimal DEFAULT NULL, p_dest_lng decimal DEFAULT NULL
) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean; v_is_online boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT allows_out_of_city, is_online INTO v_allows_out_of_city, v_is_online FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_is_online THEN RAISE EXCEPTION 'Go online first — you can''t post a new trip while offline.' USING ERRCODE = 'P0001'; END IF;
  IF NOT vehicle_ride_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for rides — ask the committee.' USING ERRCODE = 'P0001';
  END IF;
  IF p_trip_type NOT IN ('oneway', 'return') THEN RAISE EXCEPTION 'Pick one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_classification = 'out_of_city' AND NOT v_allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for trips within the home city — ask the committee if you need out-of-station enabled.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal, decimal, decimal, decimal) TO authenticated;

-- city_purchase_candidate_vehicles (495) — now also reports distance_km
-- to the request's pickup pin, when both ends have a real point. Two
-- new trailing params means a different signature, not a replacement of
-- the 1-arg version — dropped explicitly, same discipline as above.
DROP FUNCTION IF EXISTS city_purchase_candidate_vehicles(uuid);
CREATE OR REPLACE FUNCTION city_purchase_candidate_vehicles(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL)
RETURNS TABLE(vehicle_id uuid, source varchar, reference_destination text, distance_km decimal) AS $$
  WITH ci AS (SELECT * FROM cities WHERE id = p_city_id),
  today AS (SELECT (now() AT TIME ZONE 'Asia/Karachi')::date AS d),
  candidates AS (
    SELECT v.id AS vehicle_id, 'route'::varchar AS source,
      (r.destination || CASE WHEN r.destination_ur IS NOT NULL THEN ' / ' || r.destination_ur ELSE '' END) AS reference_destination,
      CASE WHEN p_pickup_lat IS NOT NULL AND r.destination_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, r.destination_lat, r.destination_lng) END AS distance_km,
      1 AS priority
    FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id, ci, today
    WHERE r.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id)
      AND (r.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND r.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (r.days_of_week && ARRAY[extract(dow FROM today.d)::int, extract(dow FROM today.d + 1)::int])
    UNION ALL
    SELECT v.id, 'trip_offer',
      (o.destination || CASE WHEN o.destination_ur IS NOT NULL THEN ' / ' || o.destination_ur ELSE '' END),
      CASE WHEN p_pickup_lat IS NOT NULL AND o.dest_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, o.dest_lat, o.dest_lng) END,
      1
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id, ci, today
    WHERE o.status = 'open' AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id)
      AND o.travel_date BETWEEN today.d AND today.d + 1
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
    UNION ALL
    SELECT v.id, 'presence', NULL, NULL, 2
    FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id
    WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id)
  )
  SELECT DISTINCT ON (vehicle_id) vehicle_id, source, reference_destination, distance_km
  FROM candidates
  ORDER BY vehicle_id, priority;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal) TO authenticated;

DROP FUNCTION IF EXISTS city_purchase_candidates(uuid);
CREATE OR REPLACE FUNCTION city_purchase_candidates(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type,
    'source', c.source, 'reference_destination', c.reference_destination, 'distance_km', c.distance_km
  ) ORDER BY c.distance_km NULLS LAST, c.source, v.owner_name), '[]'::jsonb)
  FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c JOIN vehicles v ON v.id = c.vehicle_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidates(uuid, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidates(uuid, decimal, decimal) TO authenticated;

-- create_city_purchase_request (495) — pass the pickup pin through to
-- candidate discovery too, purely so the invited set (and its stored
-- reference_destination) is computed by the exact same ordering the
-- villager already saw; the pin itself isn't priced into anything.
CREATE OR REPLACE FUNCTION create_city_purchase_request(
  p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_goods_budget_pkr decimal DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO city_purchase_requests (initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status)
  VALUES (v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing')
  RETURNING id INTO v_request_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND is_active AND is_online AND vehicle_delivery_eligible(id)) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination) VALUES (v_request_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c;
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
REVOKE ALL ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid) TO authenticated;
