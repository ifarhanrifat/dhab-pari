-- ═════════════════════════════════════════════════════════════════════════
-- Real gap found 2026-10-21: every other booking vertical (hourly, rental,
-- equipment, shadi, dispatch, city-purchase, parcel) inserts a
-- portal_notifications row for the vehicle owner the moment a request is
-- created — place_ride_booking (Route) and book_adda_seat (Adda fixed-fare)
-- never did. A driver got zero push/badge/bell signal that a seat was
-- booked on their own route/queue entry; they'd only find out by manually
-- opening the routes/adda page. Same DROP+CREATE discipline as every other
-- change to these two functions this session (both already carry prior
-- param-list edits), same notify-the-owner pattern create_hourly_booking/
-- create_rental_booking already use (659_booking_notes_and_payment_method.sql).
-- ═════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS place_ride_booking(uuid, date, int, varchar, text);
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_available int;
  v_total decimal;
  v_per_seat decimal;
  v_seats_booked_so_far int;
  v_booking_id uuid;
  v_weekday int;
  v_commission_pct decimal;
  v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  IF v_route.fare_mode = 'flex' THEN
    SELECT COALESCE(SUM(seats), 0) INTO v_seats_booked_so_far FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed');
    v_per_seat := v_route.total_fare_pkr / (v_seats_booked_so_far + p_seats);
    v_total := p_seats * v_per_seat;
  ELSE
    v_total := p_seats * v_route.fare_per_seat_pkr;
  END IF;

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New seat booked on your route',
      p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total), '/portal/my-vehicle/routes');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_ride_booking(uuid, date, int, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text) TO authenticated;

DROP FUNCTION IF EXISTS book_adda_seat(uuid, int, varchar, text);
CREATE OR REPLACE FUNCTION book_adda_seat(p_entry_id uuid, p_seats int, p_method varchar, p_proof_url text) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_available int; v_total decimal; v_booking_id uuid;
  v_commission_pct decimal; v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id;
  IF NOT FOUND OR e.status NOT IN ('waiting', 'current') THEN RAISE EXCEPTION 'This vehicle is no longer taking bookings.' USING ERRCODE = 'P0001'; END IF;
  IF e.fare_mode <> 'fixed' THEN RAISE EXCEPTION 'This vehicle takes ride requests, not fixed-fare bookings — propose a fare instead.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;

  v_total := p_seats * e.fixed_fare_per_seat_pkr;

  IF v.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001'; END IF;
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, (SELECT classification FROM addas WHERE id = e.adda_id));
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_available := adda_entry_seats_available(p_entry_id);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on this vehicle.', v_available USING ERRCODE = 'P0001'; END IF;

  INSERT INTO ride_bookings (adda_queue_entry_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_entry_id, v_portal_user_id, (now() AT TIME ZONE 'Asia/Karachi')::date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'adda_seat_booked', 'New seat booked',
      p_seats || ' seat(s) — Rs ' || round(v_total), '/portal/my-vehicle/adda');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION book_adda_seat(uuid, int, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION book_adda_seat(uuid, int, varchar, text) TO authenticated;
