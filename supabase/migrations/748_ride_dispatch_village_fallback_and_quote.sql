-- Real ask, 2026-10-28: while a ride request is out, the rider should
-- see how many drivers of that category are actually online right now
-- — and if there are genuinely none, be offered a real fallback: call
-- any driver from the home village instead, who then has to travel out
-- to the pickup point and back (a real round trip) before the ride
-- itself even starts. That detour has to be priced and shown BEFORE
-- the rider commits to it, same transparency principle the City
-- Purchase round-trip fee already established (733) — reused here via
-- the same haversine_km + category rate-card math, not reinvented.

ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS village_detour_pkr decimal NOT NULL DEFAULT 0;
ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS used_village_driver boolean NOT NULL DEFAULT false;

-- One call gives the rider everything needed to decide: how many
-- drivers of this category are online right now, the normal fare, and
-- — only useful if online_count is 0 — what calling a village driver
-- would cost instead (round-trip village-to-pickup detour added on top).
CREATE OR REPLACE FUNCTION ride_dispatch_quote(p_category_id uuid, p_pickup_lat decimal, p_pickup_lng decimal, p_distance_km decimal) RETURNS jsonb AS $$
DECLARE
  v_category vehicle_categories%ROWTYPE; v_online_count int; v_home_lat decimal; v_home_lng decimal;
  v_base_fare decimal; v_village_km decimal; v_village_detour decimal;
BEGIN
  SELECT * INTO v_category FROM vehicle_categories WHERE id = p_category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_online_count FROM vehicles v WHERE v.category_id = p_category_id AND v.is_active AND v.is_online;
  v_base_fare := round(v_category.base_fare_pkr + v_category.per_km_pkr * p_distance_km);

  SELECT lat, lng INTO v_home_lat, v_home_lng FROM cities WHERE is_home_city LIMIT 1;
  IF v_home_lat IS NOT NULL THEN
    v_village_km := haversine_km(v_home_lat, v_home_lng, p_pickup_lat, p_pickup_lng);
    v_village_detour := round(v_category.per_km_pkr * v_village_km * 2);
  ELSE
    v_village_detour := 0;
  END IF;

  RETURN jsonb_build_object(
    'online_count', v_online_count, 'base_fare_pkr', v_base_fare,
    'village_detour_pkr', v_village_detour, 'total_with_village_pkr', v_base_fare + v_village_detour
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_quote(uuid, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_quote(uuid, decimal, decimal, decimal) TO authenticated;

DROP FUNCTION IF EXISTS create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal);

CREATE OR REPLACE FUNCTION create_ride_dispatch_request(
  p_category_id uuid, p_pickup_label text, p_pickup_lat decimal, p_pickup_lng decimal,
  p_dropoff_label text, p_dropoff_lat decimal, p_dropoff_lng decimal, p_distance_km decimal,
  p_use_village_driver boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_quote jsonb; v_fare decimal; v_village_detour decimal; v_request_id uuid; v_category vehicle_categories%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_category FROM vehicle_categories WHERE id = p_category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM ride_dispatch_requests WHERE initiator_portal_user_id = v_portal_user_id AND status = 'open') THEN
    RAISE EXCEPTION 'You already have a ride request waiting for a driver.' USING ERRCODE = 'P0001';
  END IF;

  v_quote := ride_dispatch_quote(p_category_id, p_pickup_lat, p_pickup_lng, p_distance_km);
  v_village_detour := CASE WHEN p_use_village_driver THEN (v_quote->>'village_detour_pkr')::decimal ELSE 0 END;
  v_fare := (v_quote->>'base_fare_pkr')::decimal + v_village_detour;

  INSERT INTO ride_dispatch_requests (initiator_portal_user_id, category_id, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, distance_km, fare_pkr, village_detour_pkr, used_village_driver)
  VALUES (v_portal_user_id, p_category_id, p_pickup_label, p_pickup_lat, p_pickup_lng, p_dropoff_label, p_dropoff_lat, p_dropoff_lng, p_distance_km, v_fare, v_village_detour, p_use_village_driver)
  RETURNING id INTO v_request_id;

  -- Normal mode only rings drivers who are online right now. Village
  -- mode has, by definition, nobody online locally — ring every active
  -- vehicle of the category instead (they already know this costs a
  -- detour trip, same as a real phone-a-driver call would).
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'ride_dispatch_requested', v_category.emoji || ' ' || v_category.name || ' ride requested',
    p_pickup_label || ' → ' || p_dropoff_label || ' — Rs ' || v_fare::text, '/portal/marketplace/ride-dispatch/' || v_request_id
  FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND v.portal_user_id IS NOT NULL
    AND (p_use_village_driver OR v.is_online);

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, boolean) TO authenticated;

-- ride_dispatch_request_detail gains the village-detour breakdown so
-- the waiting screen can show exactly what the rider is paying for.
CREATE OR REPLACE FUNCTION ride_dispatch_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label,
    'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'dropoff_lat', r.dropoff_lat, 'dropoff_lng', r.dropoff_lng,
    'distance_km', r.distance_km, 'fare_pkr', r.fare_pkr, 'village_detour_pkr', r.village_detour_pkr, 'used_village_driver', r.used_village_driver,
    'created_at', r.created_at,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji,
    'is_mine_as_rider', r.initiator_portal_user_id = current_portal_user_id(),
    'trip_offer_id', r.trip_offer_id
  )
  FROM ride_dispatch_requests r JOIN vehicle_categories c ON c.id = r.category_id
  WHERE r.id = p_request_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_request_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_request_detail(uuid) TO authenticated;

-- Garbage-cleanup, same spirit as every other stale-sweep already in
-- this app: a ride request nobody ever accepted shouldn't sit 'open'
-- forever. 20 minutes is long enough for a real response, short enough
-- that it isn't still "pending" by the time anyone looks again.
CREATE OR REPLACE FUNCTION expire_stale_ride_dispatch_requests() RETURNS void AS $$
  UPDATE ride_dispatch_requests SET status = 'expired'
  WHERE status = 'open' AND created_at < now() - interval '20 minutes';
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION expire_stale_ride_dispatch_requests() FROM PUBLIC, anon;

SELECT cron.schedule('expire-stale-ride-dispatch-requests', '*/5 * * * *', $$SELECT expire_stale_ride_dispatch_requests()$$);
