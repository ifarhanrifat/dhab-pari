-- Migration 974: real regression I introduced myself in 973 — reported
-- live as "upload the payment receipt first" blocking every attempt to
-- book Karachi→Peshawar (a monthly_lumpsum vehicle's return leg).
--
-- book_standalone_return_seat has TWO different "final body" ancestors
-- in this migration history: 948 (true-replaced it only to add
-- ticket_no — but its commission_mode check was still the OLD, buggy
-- shape: require an upfront proof_url for a monthly_lumpsum vehicle)
-- and 951, pushed the SAME day specifically to fix that exact bug
-- ("Fix: same shape place_ride_booking already uses... no proof
-- requirement for any vehicle" — its own header comment says so in as
-- many words). 951 is the real latest-and-correct body. When writing
-- 973's same-day-departure guard, I built it on top of 948's body
-- (read directly, mistakenly treated as current) instead of 951's —
-- silently reverting a real fix that had been live and working for
-- days, the moment I deployed 973.
--
-- True-replace, same signature: 951's commission_mode logic restored
-- verbatim (skip the wallet-balance check for monthly_lumpsum, no
-- proof_url requirement for any vehicle — payment proof is deferred to
-- the post-booking Pay Now screen, same as every other seat booking in
-- this app), with 973's same-day departure-time guard kept exactly as
-- it was — that part was never wrong.
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
  v_ticket_no varchar;
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

  -- 973, unchanged: today's return leg is only bookable when
  -- return_departure_time is known AND hasn't passed yet.
  IF p_travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    IF v_route.return_departure_time IS NULL THEN
      RAISE EXCEPTION 'This route has no fixed return time on file for today — contact the driver directly, or pick a different date.' USING ERRCODE = 'P0001';
    ELSIF now() > ((p_travel_date + v_route.return_departure_time) AT TIME ZONE 'Asia/Karachi') THEN
      RAISE EXCEPTION 'Today''s return departure at % has already passed — pick a different date, or contact the driver directly.',
        to_char(v_route.return_departure_time, 'HH12:MI AM') USING ERRCODE = 'P0001';
    END IF;
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

  -- 951's corrected shape, restored: no upfront proof_url requirement
  -- for any vehicle (payment proof defers to the post-booking Pay Now
  -- screen, same as place_ride_booking) — monthly_lumpsum just skips
  -- the per-booking wallet/commission balance check, since it's a flat
  -- fee, not a per-seat commission.
  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_ticket_no := generate_ticket_no();

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, direction, ticket_no)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, 1, v_total, 'announced', v_total, p_method, p_proof_url, now(), 'return', v_ticket_no)
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

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total, 'ticket_no', v_ticket_no);
END;
$$;
