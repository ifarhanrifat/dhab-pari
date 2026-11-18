-- Migration 920: real terminal-to-terminal fare-zone system for the
-- bus system specifically, plus the missing remove-stop capability.
--
-- Real spec given directly: a route built terminal-to-terminal has its
-- intermediate cities' fares auto-computed from the base fare by real
-- distance, rounded to a clean ₨100, with admin override per city
-- pair; multiple terminals inside the same big city (e.g. Karachi)
-- never change the fare — the city itself is the fare zone, not the
-- exact terminal; a passenger boarding somewhere that isn't a listed
-- terminal (a map-pickup/GPS catch) always pays the full route fare,
-- same rule for an online app booking as for a counter sale.
--
-- Scope boundary, explicitly confirmed: a route is only governed by
-- this system when its OWN fare_mode is set to the new 'terminal_zone'
-- value — every existing route (fixed/flex, village rides, solo
-- vehicles) keeps its exact current behaviour, completely untouched,
-- unless a staff member explicitly opts a route into this mode. The
-- two "online vehicle" RPCs (place_ride_booking, book_standalone_
-- return_seat) are widened with one new conditional branch each for
-- this one fare_mode value; every other branch/validation/seat-lock
-- in both functions is copied verbatim from their current live
-- bodies (878) — confirmed by direct byte comparison before writing.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Schema.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_routes DROP CONSTRAINT IF EXISTS vehicle_routes_fare_mode_check;
ALTER TABLE vehicle_routes ADD CONSTRAINT vehicle_routes_fare_mode_check CHECK (fare_mode IN ('fixed', 'flex', 'terminal_zone'));

CREATE TABLE IF NOT EXISTS route_fare_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  from_city varchar NOT NULL,
  to_city varchar NOT NULL,
  fare_pkr decimal NOT NULL CHECK (fare_pkr >= 0),
  is_auto_calculated boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (route_id, from_city, to_city)
);
CREATE INDEX IF NOT EXISTS route_fare_zones_route_idx ON route_fare_zones(route_id);
ALTER TABLE route_fare_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_fare_zones_owner_read" ON route_fare_zones FOR SELECT TO authenticated
  USING (is_route_owner(route_id));
-- No INSERT/UPDATE/DELETE policy — owner-only SECURITY DEFINER RPCs.

-- ═════════════════════════════════════════════════════════════════════
-- 2. route_zone_fare_by_city — the one shared lookup every caller
-- (counter sale, online booking, standalone return) uses. A city that
-- doesn't resolve on either end (a free-GPS catch, or a stop that
-- isn't linked to a real terminal) always means the full route fare —
-- the real rule: boarding outside a listed terminal city is never
-- discounted, online or at the counter. Two terminals in the same
-- city are a real zero-fare segment, not a missing-data case.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_zone_fare_by_city(p_route_id uuid, p_board_city varchar, p_alight_city varchar) RETURNS decimal
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_board_city IS NULL OR p_alight_city IS NULL THEN (SELECT fare_per_seat_pkr FROM vehicle_routes WHERE id = p_route_id)
    WHEN p_board_city = p_alight_city THEN 0
    ELSE COALESCE(
      (SELECT fare_pkr FROM route_fare_zones WHERE route_id = p_route_id AND from_city = p_board_city AND to_city = p_alight_city),
      (SELECT fare_per_seat_pkr FROM vehicle_routes WHERE id = p_route_id)
    )
  END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 3. recompute_route_fare_zones — walks this route's real terminal-
-- linked stops in order, collapses them to distinct cities (a city's
-- position is its first terminal's cumulative distance along the
-- route — multiple terminals 30km apart inside Karachi never create a
-- second zone), then prices every ordered city pair as a straight
-- share of the route's own base fare by real distance, rounded to a
-- clean ₨100. Never overwrites a pair an admin has manually priced
-- (is_auto_calculated = false) — re-running this after adding a stop
-- only fills in what's still on auto.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION recompute_route_fare_zones(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE;
  v_stop record;
  v_prev_lat double precision; v_prev_lng double precision;
  v_cum numeric := 0;
  v_cities jsonb := '[]'::jsonb;
  v_total_km numeric;
  v_a jsonb; v_b jsonb;
  v_fare decimal;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;

  FOR v_stop IN
    SELECT rs.lat, rs.lng, fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id
    WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC
  LOOP
    IF v_prev_lat IS NOT NULL THEN
      v_cum := v_cum + haversine_km(v_prev_lat, v_prev_lng, v_stop.lat, v_stop.lng);
    END IF;
    v_prev_lat := v_stop.lat; v_prev_lng := v_stop.lng;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_cities) e WHERE e->>'city' = v_stop.city) THEN
      v_cities := v_cities || jsonb_build_object('city', v_stop.city, 'km', v_cum);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_cities) < 2 THEN RETURN; END IF;
  v_total_km := (SELECT max((e->>'km')::numeric) FROM jsonb_array_elements(v_cities) e);
  IF v_total_km <= 0 THEN RETURN; END IF;

  FOR v_a IN SELECT * FROM jsonb_array_elements(v_cities) LOOP
    FOR v_b IN SELECT * FROM jsonb_array_elements(v_cities) LOOP
      IF (v_a->>'city') = (v_b->>'city') THEN CONTINUE; END IF;
      v_fare := round(v_route.fare_per_seat_pkr * abs((v_b->>'km')::numeric - (v_a->>'km')::numeric) / v_total_km / 100) * 100;
      INSERT INTO route_fare_zones (route_id, from_city, to_city, fare_pkr, is_auto_calculated)
      VALUES (p_route_id, v_a->>'city', v_b->>'city', v_fare, true)
      ON CONFLICT (route_id, from_city, to_city) DO UPDATE SET fare_pkr = EXCLUDED.fare_pkr, updated_at = now()
        WHERE route_fare_zones.is_auto_calculated = true;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION recompute_route_fare_zones(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recompute_route_fare_zones(uuid) TO authenticated;

-- Admin manual override — real ask: "admin can set the fare manually
-- too". Prices both directions the same, since a ticket between two
-- cities costs the same either way in practice.
CREATE OR REPLACE FUNCTION set_route_fare_zone_fare(p_route_id uuid, p_from_city varchar, p_to_city varchar, p_fare_pkr decimal) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_pkr IS NULL OR p_fare_pkr < 0 THEN RAISE EXCEPTION 'Enter a real fare.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_fare_zones (route_id, from_city, to_city, fare_pkr, is_auto_calculated)
  VALUES (p_route_id, p_from_city, p_to_city, round(p_fare_pkr), false)
  ON CONFLICT (route_id, from_city, to_city) DO UPDATE SET fare_pkr = round(p_fare_pkr), is_auto_calculated = false, updated_at = now();

  INSERT INTO route_fare_zones (route_id, from_city, to_city, fare_pkr, is_auto_calculated)
  VALUES (p_route_id, p_to_city, p_from_city, round(p_fare_pkr), false)
  ON CONFLICT (route_id, from_city, to_city) DO UPDATE SET fare_pkr = round(p_fare_pkr), is_auto_calculated = false, updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION set_route_fare_zone_fare(uuid, varchar, varchar, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_fare_zone_fare(uuid, varchar, varchar, decimal) TO authenticated;

-- Revert a pair back to auto-calculated, both directions, then refill
-- it from the real distance math immediately.
CREATE OR REPLACE FUNCTION clear_route_fare_zone_override(p_route_id uuid, p_from_city varchar, p_to_city varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;
  DELETE FROM route_fare_zones WHERE route_id = p_route_id AND ((from_city = p_from_city AND to_city = p_to_city) OR (from_city = p_to_city AND to_city = p_from_city));
  PERFORM recompute_route_fare_zones(p_route_id);
END;
$$;
REVOKE ALL ON FUNCTION clear_route_fare_zone_override(uuid, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_route_fare_zone_override(uuid, varchar, varchar) TO authenticated;

-- Frontend read: the zone matrix plus the real total distance (the
-- mockup's own "Distance" column, computed for real from the same
-- terminal-to-terminal chain, not invented).
CREATE OR REPLACE FUNCTION fleet_route_fare_zones(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_zones jsonb; v_cities jsonb; v_total_km numeric; v_stop record; v_prev_lat double precision; v_prev_lng double precision; v_cum numeric := 0;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('from_city', from_city, 'to_city', to_city, 'fare_pkr', fare_pkr, 'is_auto_calculated', is_auto_calculated) ORDER BY from_city, to_city), '[]'::jsonb)
    INTO v_zones FROM route_fare_zones WHERE route_id = p_route_id;

  v_cities := '[]'::jsonb;
  FOR v_stop IN
    SELECT rs.lat, rs.lng, fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id
    WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC
  LOOP
    IF v_prev_lat IS NOT NULL THEN v_cum := v_cum + haversine_km(v_prev_lat, v_prev_lng, v_stop.lat, v_stop.lng); END IF;
    v_prev_lat := v_stop.lat; v_prev_lng := v_stop.lng;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_cities) e WHERE e->>'city' = v_stop.city) THEN
      v_cities := v_cities || jsonb_build_object('city', v_stop.city);
    END IF;
  END LOOP;
  v_total_km := v_cum;

  RETURN jsonb_build_object('zones', v_zones, 'cities', v_cities, 'total_distance_km', round(v_total_km));
END;
$$;
REVOKE ALL ON FUNCTION fleet_route_fare_zones(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_route_fare_zones(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. delete_route_stop — the missing remove-stop capability. The
-- existing FK (board_stop_id/alight_stop_id -> route_stops, no ON
-- DELETE clause, so it's RESTRICT by default) already protects every
-- past booking from a dangling reference; this just turns that into a
-- real error message instead of a raw constraint violation.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION delete_route_stop(p_stop_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid;
BEGIN
  SELECT route_id INTO v_route_id FROM route_stops WHERE id = p_stop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stop not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_route_owner(v_route_id) THEN RAISE EXCEPTION 'You can only manage stops on your own route.' USING ERRCODE = 'P0001'; END IF;

  IF EXISTS (SELECT 1 FROM ride_bookings WHERE board_stop_id = p_stop_id OR alight_stop_id = p_stop_id)
     OR EXISTS (SELECT 1 FROM manual_ride_bookings WHERE board_stop_id = p_stop_id OR alight_stop_id = p_stop_id)
  THEN
    RAISE EXCEPTION 'This stop has real bookings referencing it and can''t be removed.' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM route_stops WHERE id = p_stop_id;
END;
$$;
REVOKE ALL ON FUNCTION delete_route_stop(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_route_stop(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. record_manual_return_booking (918) — true-replace, current body
-- copied verbatim with only the fare computation's terminal_zone
-- branch added.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION record_manual_return_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal DEFAULT NULL,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_emergency_contact_phone varchar DEFAULT NULL, p_passengers jsonb DEFAULT NULL, p_outbound_leg_of uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_stop route_stops%ROWTYPE; v_forward_fraction numeric; v_weekday int; v_available int;
  v_total decimal; v_id uuid; v_ticket_no varchar;
  v_passenger jsonb; v_paid_idx int := 0;
  v_sn int;
  v_board_city varchar; v_origin_city varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(COALESCE(v_route.return_days_of_week, v_route.days_of_week))) THEN
    RAISE EXCEPTION 'The return leg does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  IF p_counter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_counter_id AND fleet_id = v_vehicle.fleet_id) THEN
    RAISE EXCEPTION 'That counter is not part of this vehicle''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Enter at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_passenger_name, '')) = '' THEN RAISE EXCEPTION 'Enter the passenger''s name.' USING ERRCODE = 'P0001'; END IF;

  IF p_outbound_leg_of IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id
      WHERE mb.id = p_outbound_leg_of AND mb.direction = 'outbound' AND mb.return_leg_of IS NULL AND can_manage_vehicle(vr.vehicle_id)
    ) THEN
      RAISE EXCEPTION 'The outbound booking for this return leg was not found.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_forward_fraction := 1 - route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
  ELSE
    v_forward_fraction := 1;
  END IF;

  IF v_route.fare_mode = 'terminal_zone' THEN
    -- A return leg always completes the full journey back to the
    -- route's true origin — the alight end is always that origin
    -- city, never a separate pick. Boarding with no stop given means
    -- boarding right at the destination end (the route's last
    -- terminal), same "full return" case 877's own fraction math
    -- already treated as v_forward_fraction = 1.
    IF p_board_stop_id IS NOT NULL THEN
      SELECT fc.city INTO v_board_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.id = p_board_stop_id;
    ELSE
      SELECT fc.city INTO v_board_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order DESC LIMIT 1;
    END IF;
    SELECT fc.city INTO v_origin_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC LIMIT 1;
    v_total := COALESCE(p_total_amount_pkr, route_zone_fare_by_city(p_route_id, v_board_city, v_origin_city) * p_seats);
  ELSE
    v_total := COALESCE(p_total_amount_pkr, round(coalesce(v_route.fare_per_seat_pkr, 0) * p_seats * v_forward_fraction));
  END IF;
  IF v_total IS NULL OR v_total < 0 THEN RAISE EXCEPTION 'Enter the fare collected.' USING ERRCODE = 'P0001'; END IF;

  v_available := return_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on the return leg for that date.', v_available USING ERRCODE = 'P0001'; END IF;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_numbers IS NULL OR array_length(p_seat_numbers, 1) IS DISTINCT FROM p_seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', p_seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(p_route_id, p_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  v_ticket_no := generate_ticket_no();

  INSERT INTO manual_ride_bookings (
    route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id,
    total_amount_pkr, payment_method, ticket_no, emergency_contact_phone, direction, return_leg_of
  )
  VALUES (
    p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id,
    v_total, p_payment_method, v_ticket_no, nullif(trim(coalesce(p_emergency_contact_phone, '')), ''), 'return', p_outbound_leg_of
  )
  RETURNING id INTO v_id;

  IF p_seat_numbers IS NOT NULL THEN
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'return', v_sn, -1, 2000000000);
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (v_id, p_route_id, p_travel_date, 'return', v_sn, -1, 2000000000);
    END LOOP;
  END IF;

  IF p_passengers IS NOT NULL THEN
    FOR v_passenger IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
      IF COALESCE((v_passenger->>'is_free_child')::boolean, false) THEN
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, true, NULL);
      ELSE
        v_paid_idx := v_paid_idx + 1;
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, false,
          CASE WHEN p_seat_numbers IS NOT NULL AND array_length(p_seat_numbers, 1) >= v_paid_idx THEN p_seat_numbers[v_paid_idx] ELSE NULL END);
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no, 'total_amount_pkr', v_total);
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 6. place_ride_booking (878) — true-replace, current body copied
-- verbatim with only the fare-computation IF/ELSE widened by one new
-- ELSIF branch. Every other line (validation, catch feasibility,
-- flex-mode math, seat locking, notifications) is unchanged.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_board_lat numeric DEFAULT NULL, p_board_lng numeric DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_vehicle_kind varchar;
  v_available int;
  v_total decimal;
  v_per_seat decimal;
  v_seats_booked_so_far int;
  v_booking_id uuid;
  v_weekday int;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_board_stop route_stops%ROWTYPE;
  v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1;
  v_is_catch boolean := false;
  v_feas jsonb;
  v_lo int; v_hi int; v_sn int;
  v_board_city varchar; v_alight_city varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_vehicle.tenant_id != my_tenant_id() AND NOT has_share_agreement(v_vehicle.tenant_id, my_tenant_id(), 'route') THEN
    RAISE EXCEPTION 'This route is not shared with your village yet.' USING ERRCODE = 'P0001';
  END IF;

  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_route.one_off_date IS NOT NULL AND p_travel_date != v_route.one_off_date THEN
    RAISE EXCEPTION 'This ride only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_is_catch := p_board_lat IS NOT NULL AND p_board_lng IS NOT NULL;

  IF p_board_stop_id IS NULL AND NOT v_is_catch
     AND p_travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
     AND EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND direction = 'outbound' AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = p_travel_date)
  THEN
    RAISE EXCEPTION 'This bus has already left % today — book from a stop further along the route, or choose another date.', v_route.origin USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_numbers IS NULL OR array_length(p_seat_numbers, 1) IS DISTINCT FROM p_seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', p_seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats(p_route_id)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  IF p_board_stop_id IS NOT NULL AND (p_board_lat IS NOT NULL OR p_board_lng IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick either a board stop or a live catch point, not both.' USING ERRCODE = 'P0001';
  END IF;

  IF v_is_catch THEN
    IF p_alight_stop_id IS NULL THEN
      RAISE EXCEPTION 'Pick where you''re getting off.' USING ERRCODE = 'P0001';
    END IF;
    v_feas := check_catch_feasibility(p_route_id, p_board_lat, p_board_lng);
    IF NOT (v_feas->>'eligible')::boolean THEN
      RAISE EXCEPTION '%', coalesce(v_feas->>'reason', 'You can''t catch this ride right now.') USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(p_route_id, p_board_lat, p_board_lng) - route_fraction_remaining(p_route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than where you''re catching it.' USING ERRCODE = 'P0001'; END IF;
  ELSIF (p_board_stop_id IS NOT NULL) != (p_alight_stop_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick both a board and an alight stop, or leave both blank for the full route.' USING ERRCODE = 'P0001';
  ELSIF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(p_route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(p_route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  IF v_route.fare_mode = 'terminal_zone' THEN
    -- Real rule: a free-GPS catch is never a listed terminal, so it
    -- always costs the full route fare, same as a counter sale from
    -- outside a listed city — route_zone_fare_by_city already returns
    -- the full fare whenever either city is NULL.
    IF NOT v_is_catch THEN
      v_board_city := CASE WHEN p_board_stop_id IS NOT NULL THEN (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.id = p_board_stop_id)
        ELSE (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC LIMIT 1) END;
      v_alight_city := CASE WHEN p_alight_stop_id IS NOT NULL THEN (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.id = p_alight_stop_id)
        ELSE (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order DESC LIMIT 1) END;
    END IF;
    v_total := p_seats * route_zone_fare_by_city(p_route_id, v_board_city, v_alight_city);
  ELSIF v_route.fare_mode = 'flex' THEN
    SELECT COALESCE(SUM(seats), 0) INTO v_seats_booked_so_far FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed');
    v_per_seat := v_route.total_fare_pkr / (v_seats_booked_so_far + p_seats);
    v_total := p_seats * v_per_seat;
  ELSE
    v_total := round(p_seats * v_route.fare_per_seat_pkr * v_segment_fraction);
  END IF;

  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id, is_mid_route_catch)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id, v_is_catch)
  RETURNING id INTO v_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    v_lo := seat_stop_order(p_board_stop_id, -1);
    v_hi := seat_stop_order(p_alight_stop_id, 2000000000);
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (v_booking_id, p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
  END IF;

  IF v_is_catch THEN
    INSERT INTO ride_booking_catch_locations (ride_booking_id, lat, lng) VALUES (v_booking_id, p_board_lat, p_board_lng);
  END IF;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id,
      CASE WHEN v_is_catch THEN 'route_catch_request' ELSE 'route_seat_booked' END,
      CASE WHEN v_is_catch THEN 'Someone is trying to catch your ride' ELSE 'New seat booked — confirm once paid' END,
      CASE WHEN v_is_catch THEN p_seats || ' seat(s) requested near your current position — view their live location before accepting.'
        ELSE p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || '. Confirm their seat once they''ve paid you directly, to add them to your ride group.' END,
      '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat booked — not confirmed yet',
    'Pay the driver directly to confirm this seat. Until the driver confirms your payment, another paying rider could take it, and you won''t yet see the live map/chat/group for this ride.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total, 'is_mid_route_catch', v_is_catch);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 7. book_standalone_return_seat (878) — true-replace, current body
-- copied verbatim with the same single widened fare branch.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION book_standalone_return_seat(p_route_id uuid, p_travel_date date, p_board_stop_id uuid DEFAULT NULL, p_method varchar DEFAULT 'cash', p_proof_url text DEFAULT NULL, p_seat_number int DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_vehicle_kind varchar;
  v_stop route_stops%ROWTYPE;
  v_available int;
  v_forward_fraction numeric;
  v_total decimal;
  v_booking_id uuid;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_stop_label text;
  v_weekday int;
  v_lo int; v_hi int;
  v_board_city varchar; v_origin_city varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND OR NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_route.one_off_date IS NOT NULL AND p_travel_date != v_route.one_off_date THEN
    RAISE EXCEPTION 'This ride only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(COALESCE(v_route.return_days_of_week, v_route.days_of_week))) THEN
    RAISE EXCEPTION 'The return leg does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  IF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_forward_fraction := 1 - route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
    v_stop_label := v_stop.label;
  ELSE
    v_forward_fraction := 1;
    v_stop_label := v_route.destination;
  END IF;

  v_available := return_seats_available(p_route_id, p_travel_date);
  IF v_available <= 0 THEN RAISE EXCEPTION 'No seats are free on the return leg for that date.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > route_effective_seats_for_date(p_route_id, p_travel_date) THEN
      RAISE EXCEPTION 'Pick a real seat on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_number IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  IF v_route.fare_mode = 'terminal_zone' THEN
    IF p_board_stop_id IS NOT NULL THEN
      SELECT fc.city INTO v_board_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.id = p_board_stop_id;
    ELSE
      SELECT fc.city INTO v_board_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order DESC LIMIT 1;
    END IF;
    SELECT fc.city INTO v_origin_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC LIMIT 1;
    v_total := route_zone_fare_by_city(p_route_id, v_board_city, v_origin_city);
  ELSE
    v_total := round(coalesce(v_route.fare_per_seat_pkr, 0) * v_forward_fraction);
  END IF;

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, direction)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, 1, v_total, 'announced', v_total, p_method, p_proof_url, now(), 'return')
  RETURNING id INTO v_booking_id;

  IF p_seat_number IS NOT NULL THEN
    v_lo := -1;
    v_hi := seat_stop_order(p_board_stop_id, 2000000000);
    PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'return', p_seat_number, v_lo, v_hi);
    INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
    VALUES (v_booking_id, p_route_id, p_travel_date, 'return', p_seat_number, v_lo, v_hi);
  END IF;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New one-way return seat booked — confirm once paid',
      '1 seat from ' || v_stop_label || ' on ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || '.', '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat booked — not confirmed yet',
    'Pay the driver directly to confirm this seat. Until the driver confirms your payment, another paying rider could take it.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$;
