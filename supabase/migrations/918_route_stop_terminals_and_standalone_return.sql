-- Migration 918: real terminal model for route stops + a real
-- standalone-return-leg booking path for manual/counter sales.
--
-- Two confirmed, related bugs from direct user testing of the booking
-- wizard:
--
-- 1. "Listed stop" boarding mode showed a map. The real reference
-- (SAFAR_Admin_Dashboard_Professional_Booking-4.html) uses a plain
-- dropdown of named stops for "Listed stop"; the map is reserved for
-- "Map pickup" (free GPS pin) only. Compounding this: route_stops had
-- no real terminal identity at all (just a free-text label + a map
-- pin) — for a genuine long-distance route, stops ARE real terminals
-- (fleet_counters already models exactly this: city + optional name,
-- "for when a city has more than one counter", per its own comment),
-- with a scheduled arrival/departure. Linking route_stops to
-- fleet_counters, with real arrival/departure times, is what the
-- plain dropdown now needs to show for real.
--
-- 2. The Return-leg booking (905) was built on a wrong model: it made
-- staff search for and pick a SECOND, independent route for the
-- return — but every real route here is `is_two_way = true` with NO
-- separate reverse-direction row; the vehicle runs the same route_id
-- back. dhab-pari already has a real, working mechanism for exactly
-- this on the rider-app side — book_standalone_return_seat (727/877):
-- same route_id, is_two_way required, validated against the route's
-- own return_days_of_week, fare computed from route_fraction_remaining,
-- capacity checked via return_seats_available. record_manual_booking's
-- Phase B route never reused any of this. Fixed by giving manual/
-- counter sales the same real mechanism: record_manual_return_booking.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Schema.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE route_stops
  ADD COLUMN IF NOT EXISTS counter_id uuid REFERENCES fleet_counters(id),
  ADD COLUMN IF NOT EXISTS arrival_time time,
  ADD COLUMN IF NOT EXISTS departure_time time;

-- manual_ride_bookings never had a direction column at all (unlike
-- ride_bookings, 727) — every manual sale was implicitly "outbound"
-- (the default makes every existing/future plain sale correct with
-- zero migration risk) and there was no way to record a standalone
-- return-only counter sale.
ALTER TABLE manual_ride_bookings
  ADD COLUMN IF NOT EXISTS direction varchar NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return'));

-- ═════════════════════════════════════════════════════════════════════
-- 2. create_route_stop (717) — true-replace, current body copied
-- verbatim with only the 3 new optional terminal params + their
-- INSERT targets added. When a terminal is picked, its own lat/lng
-- (if it has one) is used instead of requiring a fresh map pick —
-- the terminal's location is already known.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION create_route_stop(
  p_route_id uuid, p_label varchar, p_label_ur varchar, p_lat numeric, p_lng numeric, p_village_id uuid DEFAULT NULL, p_stop_order int DEFAULT NULL,
  p_counter_id uuid DEFAULT NULL, p_arrival_time time DEFAULT NULL, p_departure_time time DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_order int; v_counter fleet_counters%ROWTYPE; v_lat numeric; v_lng numeric;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage stops on your own route.' USING ERRCODE = 'P0001'; END IF;
  IF coalesce(trim(p_label), '') = '' THEN RAISE EXCEPTION 'Enter a stop name.' USING ERRCODE = 'P0001'; END IF;

  v_lat := p_lat; v_lng := p_lng;
  IF p_counter_id IS NOT NULL THEN
    SELECT * INTO v_counter FROM fleet_counters fc
      JOIN vehicle_routes vr ON vr.id = p_route_id JOIN vehicles v ON v.id = vr.vehicle_id
      WHERE fc.id = p_counter_id AND fc.fleet_id = v.fleet_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That terminal is not part of this route''s fleet.' USING ERRCODE = 'P0001'; END IF;
    v_lat := COALESCE(p_lat, v_counter.lat); v_lng := COALESCE(p_lng, v_counter.lng);
  END IF;
  IF v_lat IS NULL OR v_lng IS NULL THEN RAISE EXCEPTION 'Pick a point on the map.' USING ERRCODE = 'P0001'; END IF;

  v_order := coalesce(p_stop_order, (SELECT coalesce(max(stop_order), 0) + 1 FROM route_stops WHERE route_id = p_route_id));

  INSERT INTO route_stops (route_id, village_id, label, label_ur, lat, lng, stop_order, counter_id, arrival_time, departure_time)
  VALUES (p_route_id, p_village_id, trim(p_label), nullif(trim(coalesce(p_label_ur, '')), ''), v_lat, v_lng, v_order, p_counter_id, p_arrival_time, p_departure_time)
  RETURNING id INTO v_id;

  IF p_village_id IS NOT NULL THEN
    UPDATE villages SET lat = v_lat, lng = v_lng WHERE id = p_village_id AND lat IS NULL AND lng IS NULL;
  END IF;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION create_route_stop(uuid, varchar, varchar, numeric, numeric, uuid, int, uuid, time, time) TO authenticated;

-- A stop already on a route can now have its terminal link / arrival /
-- departure time set or changed — create_route_stop only ever handled
-- adding a brand-new one.
CREATE OR REPLACE FUNCTION update_route_stop_schedule(p_stop_id uuid, p_counter_id uuid DEFAULT NULL, p_arrival_time time DEFAULT NULL, p_departure_time time DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_fleet_id uuid;
BEGIN
  SELECT route_id INTO v_route_id FROM route_stops WHERE id = p_stop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stop not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_route_owner(v_route_id) THEN RAISE EXCEPTION 'You can only manage stops on your own route.' USING ERRCODE = 'P0001'; END IF;

  IF p_counter_id IS NOT NULL THEN
    SELECT v.fleet_id INTO v_fleet_id FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = v_route_id;
    IF NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_counter_id AND fleet_id = v_fleet_id) THEN
      RAISE EXCEPTION 'That terminal is not part of this route''s fleet.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE route_stops SET counter_id = p_counter_id, arrival_time = p_arrival_time, departure_time = p_departure_time WHERE id = p_stop_id;
END;
$$;
GRANT EXECUTE ON FUNCTION update_route_stop_schedule(uuid, uuid, time, time) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. return_seats_available (851) — true-replace, current body copied
-- verbatim, only adding the manual-sale subtraction route_seats_
-- available (855) already does for the outbound pool. No offboard
-- tracking exists for manual bookings, so every confirmed manual sale
-- on this route/date (either direction) is conservatively assumed
-- still occupying a seat for the return leg — safer to under-utilize
-- a seat than double-sell one, same reasoning 878 already used.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION return_seats_available(p_route_id uuid, p_travel_date date) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT route_effective_seats_for_date(p_route_id, p_travel_date)
    - COALESCE((
        SELECT SUM(rb.seats)::int FROM ride_bookings rb
        WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed')
          AND NOT EXISTS (SELECT 1 FROM route_run_offboards o WHERE o.ride_booking_id = rb.id)
      ), 0)
    - COALESCE((
        SELECT SUM(mb.seats)::int FROM manual_ride_bookings mb
        WHERE mb.route_id = p_route_id AND mb.travel_date = p_travel_date AND mb.status = 'confirmed'
      ), 0);
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 4. record_manual_return_booking — the real counter-sale equivalent
-- of book_standalone_return_seat (727/877), not a second independent
-- route search. Validation/fare logic mirrors 877's real body as
-- closely as the manual-sale shape allows (confirmed sale with a
-- ticket, like record_manual_booking, not an 'announced'-pending
-- rider self-booking); p_total_amount_pkr lets staff override the
-- computed suggestion, same editable-suggestion pattern
-- record_manual_booking's own frontend already uses for the outbound
-- leg. p_outbound_leg_of reuses 905's existing return_leg_of column
-- to link back when this is booked alongside an outbound leg in the
-- same visit (optional — a return-only sale with no outbound leg at
-- all, the standalone case 727 was built for, is equally valid).
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

  -- Same fraction-of-route fare math as book_standalone_return_seat
  -- (877) — how much of the return leg is actually travelled from
  -- this boarding stop onward. No stop = boarding at the destination,
  -- i.e. the full return leg.
  IF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_forward_fraction := 1 - route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
  ELSE
    v_forward_fraction := 1;
  END IF;

  v_total := COALESCE(p_total_amount_pkr, round(coalesce(v_route.fare_per_seat_pkr, 0) * p_seats * v_forward_fraction));
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

  -- Full-route lock for the return leg, same simplification 877's own
  -- flat seat-lock already uses (no segment-fractional tracking for
  -- the return direction yet) — reuses assert_seat_segment_free's
  -- advisory-lock mechanism instead of a bare INSERT so a concurrent
  -- sale on the same seat/date/direction still fails safely.
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
REVOKE ALL ON FUNCTION record_manual_return_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, int[], varchar, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_manual_return_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, int[], varchar, jsonb, uuid) TO authenticated;
