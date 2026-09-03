-- Migration 429: some vehicle classes (bikes, rickshaws) shouldn't be doing
-- out-of-station work at all — too far, too slow, not really viable — while
-- they're completely fine for the home city (Chakwal, the short 28km run
-- everything else was measured against). This is a real capability gate,
-- admin-set per vehicle (not guessed from the free-text vehicle_type
-- string, which has too many historical variants to pattern-match safely),
-- enforced everywhere a vehicle could otherwise get invited to or set up
-- out-of-station work: posting an out_of_city trip offer, weekend share
-- offers to a non-home city, pro-service requests to a non-home city,
-- checking into presence in a non-home city (which in turn keeps such a
-- vehicle out of dispatch tier1 and city-fetch's "present in the city"
-- list for free, since both read off vehicle_city_presence), and dispatch
-- tier2's village-wide invite.
--
-- vehicle_routes (388) is admin-entered only (no portal self-service path
-- — "Admin/staff enters listings" was the deliberate design there), so it
-- isn't touched here; the admin already exercises judgment per route.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS allows_out_of_city boolean NOT NULL DEFAULT true;

-- One-time best-effort seed so this actually does something on day one for
-- whatever's already in the system — an admin can still correct any
-- individual vehicle afterward via the vehicle edit screen.
UPDATE vehicles SET allows_out_of_city = false
WHERE allows_out_of_city AND (vehicle_type ILIKE '%bike%' OR vehicle_type ILIKE '%rickshaw%');

-- "Home city" — today, exactly Chakwal (the short, 28km run every vehicle
-- can reasonably do). One-live-true-row, same pattern as every other
-- "exactly one active X" index this session already used.
ALTER TABLE cities ADD COLUMN IF NOT EXISTS is_home_city boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS cities_one_home_city ON cities(is_home_city) WHERE is_home_city;
UPDATE cities SET is_home_city = true WHERE name = 'Chakwal' AND NOT EXISTS (SELECT 1 FROM cities WHERE is_home_city);

-- place_trip_offer (400) — a driver posting their own out_of_city trip.
CREATE OR REPLACE FUNCTION place_trip_offer(
  p_vehicle_id uuid, p_origin varchar, p_origin_ur varchar, p_destination varchar, p_destination_ur varchar,
  p_classification varchar, p_travel_date date, p_departure_time_estimate time, p_seats_available int, p_listed_fare_per_seat_pkr decimal
) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT allows_out_of_city INTO v_allows_out_of_city FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_classification = 'out_of_city' AND NOT v_allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for trips within the home city — ask the committee if you need out-of-station enabled.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal) TO authenticated;

-- vehicle_check_in_city (421) — checking into presence in a non-home city.
-- Gating this one gate is what makes dispatch tier1 and city-fetch's
-- "present in the city" list correct for free — both read off this table.
CREATE OR REPLACE FUNCTION vehicle_check_in_city(p_vehicle_id uuid, p_city_id uuid, p_expected_return_at timestamptz DEFAULT NULL)
RETURNS uuid AS $$
DECLARE
  v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_city cities%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_city FROM cities WHERE id = p_city_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_is_admin AND NOT v_city.is_home_city AND NOT v.allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for the home city — it can''t check in this far out.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_city_presence SET is_active = false, checked_out_at = now()
    WHERE vehicle_id = p_vehicle_id AND is_active;

  INSERT INTO vehicle_city_presence (vehicle_id, city_id, expected_return_at)
  VALUES (p_vehicle_id, p_city_id, p_expected_return_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_check_in_city(uuid, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_check_in_city(uuid, uuid, timestamptz) TO authenticated;

-- weekend_share_offers (424) direct-RLS insert/update — a driver picking a
-- non-home city for a recurring weekend run.
DROP POLICY IF EXISTS "weekend_share_offers_insert" ON weekend_share_offers;
CREATE POLICY "weekend_share_offers_insert" ON weekend_share_offers FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR (
      EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
      AND (
        EXISTS (SELECT 1 FROM cities c WHERE c.id = city_id AND c.is_home_city)
        OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.allows_out_of_city)
      )
    )
  );
DROP POLICY IF EXISTS "weekend_share_offers_update" ON weekend_share_offers;
CREATE POLICY "weekend_share_offers_update" ON weekend_share_offers FOR UPDATE TO authenticated
  USING (true) WITH CHECK (
    current_admin_permission('manage_parties')
    OR (
      EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
      AND (
        EXISTS (SELECT 1 FROM cities c WHERE c.id = city_id AND c.is_home_city)
        OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.allows_out_of_city)
      )
    )
  );

-- request_pro_service (426) — booking a charter to a non-home city.
CREATE OR REPLACE FUNCTION request_pro_service(p_vehicle_id uuid, p_service_class_id uuid, p_city_id uuid, p_is_return boolean)
RETURNS uuid AS $$
DECLARE
  sc service_classes%ROWTYPE;
  city cities%ROWTYPE;
  v_allows_out_of_city boolean;
  v_fare decimal;
  v_thread_id uuid;
BEGIN
  SELECT * INTO sc FROM service_classes WHERE id = p_service_class_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That service is not available.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO city FROM cities WHERE id = p_city_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_service_offers o WHERE o.vehicle_id = p_vehicle_id AND o.service_class_id = p_service_class_id AND o.is_active) THEN
    RAISE EXCEPTION 'This vehicle does not offer that service.' USING ERRCODE = 'P0001';
  END IF;
  SELECT allows_out_of_city INTO v_allows_out_of_city FROM vehicles WHERE id = p_vehicle_id;
  IF NOT city.is_home_city AND NOT COALESCE(v_allows_out_of_city, false) THEN
    RAISE EXCEPTION 'This vehicle is only set up for the home city — pick a vehicle that does out-of-station trips.' USING ERRCODE = 'P0001';
  END IF;

  v_fare := pro_service_fare(city.distance_km, sc.base_fare_pkr, sc.per_km_pkr, p_is_return);
  v_thread_id := start_negotiation(
    p_kind := 'pro', p_vehicle_id := p_vehicle_id,
    p_item := sc.name || ' · ' || city.name || (CASE WHEN p_is_return THEN ' (return)' ELSE ' (one-way)' END),
    p_qty := NULL, p_budget_pkr := v_fare, p_city_id := p_city_id
  );
  RETURN v_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION request_pro_service(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_pro_service(uuid, uuid, uuid, boolean) TO authenticated;

-- vehicles_offering_service (426) — surface the flag so the browse screen
-- can grey out / hide ineligible vehicles for the currently-picked city
-- instead of letting a villager pick one and only find out on request.
DROP FUNCTION IF EXISTS vehicles_offering_service(uuid);
CREATE FUNCTION vehicles_offering_service(p_service_class_id uuid)
RETURNS TABLE(vehicle_id uuid, owner_name varchar, owner_mobile varchar, vehicle_type varchar, vehicle_number varchar, allows_out_of_city boolean) AS $$
  SELECT v.id, v.owner_name, v.owner_mobile, v.vehicle_type, v.vehicle_number, v.allows_out_of_city
  FROM vehicle_service_offers o JOIN vehicles v ON v.id = o.vehicle_id
  WHERE o.service_class_id = p_service_class_id AND o.is_active AND v.is_active
  ORDER BY v.owner_name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicles_offering_service(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicles_offering_service(uuid) TO authenticated;

-- invite_dispatch_tier (423) — dispatch broadcast, both tiers, to a shop
-- whose city isn't the home city.
CREATE OR REPLACE FUNCTION invite_dispatch_tier(p_call_id uuid, p_tier int) RETURNS int AS $$
DECLARE v_city_id uuid; v_city_is_home boolean; v_count int;
BEGIN
  SELECT s.city_id, ci.is_home_city INTO v_city_id, v_city_is_home
  FROM dispatch_calls c JOIN city_shops s ON s.id = c.city_shop_id JOIN cities ci ON ci.id = s.city_id
  WHERE c.id = p_call_id;

  INSERT INTO dispatch_invitations (call_id, vehicle_id, tier)
  SELECT p_call_id, v.id, p_tier
  FROM vehicles v
  WHERE v.is_active AND v.delivers
    AND (v_city_is_home OR v.allows_out_of_city)
    AND NOT EXISTS (SELECT 1 FROM dispatch_invitations i WHERE i.call_id = p_call_id AND i.vehicle_id = v.id)
    AND (
      (p_tier = 1 AND EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
      OR
      (p_tier = 2 AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
