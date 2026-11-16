-- Migration 877: HOTFIX — migration 876 recreated book_standalone_return_
-- seat using an old 5-param signature (copied from 727) without checking
-- for a newer overload first. 849 had already dropped that exact 5-param
-- signature and 846/851 replaced it with a 6-param version adding
-- p_seat_number (van seat selection) — 876 accidentally created a second,
-- ambiguous overload instead of replacing the real current function,
-- breaking every call to book_standalone_return_seat in production
-- (confirmed live: PGRST203 "Could not choose the best candidate
-- function"). Dropping the bad overload and restoring the real 6-param
-- one, now with the return-day-of-week check folded in correctly.

DROP FUNCTION IF EXISTS book_standalone_return_seat(uuid, date, uuid, varchar, text);

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
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND OR NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_route.one_off_date IS NOT NULL AND p_travel_date != v_route.one_off_date THEN
    RAISE EXCEPTION 'This ride only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;

  -- 876: the return leg genuinely runs on different calendar days than
  -- the outbound for a long route (e.g. a 24h haul comes back the next
  -- day) — real gap, book_standalone_return_seat never validated the
  -- return leg's travel_date against any day-of-week list before this.
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

  v_total := round(coalesce(v_route.fare_per_seat_pkr, 0) * v_forward_fraction);

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
    BEGIN
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number)
      VALUES (v_booking_id, p_route_id, p_travel_date, 'return', p_seat_number);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'That seat was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
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
