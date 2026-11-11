-- Migration 846: driver route-creation redesign, piece 3 of 4. Wires
-- the 845 seat-number holds into every RPC that creates, moves, or
-- frees a seat on a van-kind route. Car/suv routes are untouched —
-- every p_seat_number(s) param is rejected unless the vehicle's
-- category_id resolves to vehicle_kind = 'van' (833).
--
-- Bodies below are the full current (832/831/436/825) definitions,
-- reproduced exactly plus the seat-number additions — CREATE OR
-- REPLACE, so this is safe to apply even if nothing changed underneath
-- since those migrations, but confirm against a fresh read if this
-- file is ever adapted rather than applied as-is.

-- ═════════════════════════════════════════════════════════════════════
-- place_ride_booking — gains p_seat_numbers int[].
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL
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

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  -- 845/846: seat numbers are a van-kind-only concept. Car/suv routes
  -- must never receive one — keeps today's plain seat-count model
  -- exactly as it was for them.
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

  IF (p_board_stop_id IS NOT NULL) != (p_alight_stop_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick both a board and an alight stop, or leave both blank for the full route.' USING ERRCODE = 'P0001';
  END IF;

  IF p_board_stop_id IS NOT NULL THEN
    IF v_route.fare_mode = 'flex' THEN RAISE EXCEPTION 'A specific board/alight stop isn''t supported on a flex-fare route yet — book the full route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(p_route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(p_route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  IF v_route.fare_mode = 'flex' THEN
    SELECT COALESCE(SUM(seats), 0) INTO v_seats_booked_so_far FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed');
    v_per_seat := v_route.total_fare_pkr / (v_seats_booked_so_far + p_seats);
    v_total := p_seats * v_per_seat;
  ELSE
    v_total := round(p_seats * v_route.fare_per_seat_pkr * v_segment_fraction);
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

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id)
  RETURNING id INTO v_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_booking_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
  END IF;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New seat booked — confirm once paid',
      p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || '. Confirm their seat once they''ve paid you directly, to add them to your ride group.', '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat booked — not confirmed yet',
    'Pay the driver directly to confirm this seat. Until the driver confirms your payment, another paying rider could take it, and you won''t yet see the live map/chat/group for this ride.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text, uuid, uuid, int[]) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- book_standalone_return_seat — gains p_seat_number int (singular;
-- this function only ever books exactly one seat).
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
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND OR NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

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
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > route_effective_seats(p_route_id) THEN
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
GRANT EXECUTE ON FUNCTION book_standalone_return_seat(uuid, date, uuid, varchar, text, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- apply_for_monthly_seat — gains p_seat_number int. A waitlisted
-- applicant never stores a seat_number (they have no real seat yet) —
-- promote_next_waitlisted (831) does not yet assign one on promotion;
-- flagged as a known gap, not solved here.
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS apply_for_monthly_seat(uuid, uuid, varchar, text);
CREATE OR REPLACE FUNCTION apply_for_monthly_seat(p_route_id uuid, p_board_stop_id uuid, p_method varchar DEFAULT 'cash', p_proof_url text DEFAULT NULL, p_seat_number int DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_vehicle_kind varchar;
  v_stop route_stops%ROWTYPE;
  v_seats int;
  v_active_count int;
  v_fraction numeric;
  v_fee numeric;
  v_status varchar;
  v_queue_position int;
  v_id uuid;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_est_deposit numeric := 0;
  v_use_seat_number int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active = true;
  IF NOT FOUND OR NOT v_route.is_monthly_fixed THEN RAISE EXCEPTION 'This route is not a monthly-fixed service.' USING ERRCODE = 'P0001'; END IF;

  IF EXISTS (SELECT 1 FROM route_subscriptions WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id AND status != 'cancelled') THEN
    RAISE EXCEPTION 'You already have a subscription on this route.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;

  v_fraction := route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
  v_fee := round(v_route.monthly_reference_fee_pkr * v_fraction);

  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  v_seats := route_effective_seats(p_route_id);
  SELECT count(*) INTO v_active_count FROM route_subscriptions WHERE route_id = p_route_id AND status IN ('active', 'pending');

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > v_seats THEN
      RAISE EXCEPTION 'Pick a real seat on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_number IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  IF v_active_count < v_seats THEN
    v_status := 'pending'; v_queue_position := NULL;
    v_use_seat_number := p_seat_number;
    v_est_deposit := round(v_fee / scheduled_days_in_month(p_route_id, extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int, extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int))
      * coalesce(array_length(scheduled_days_remaining_in_month(p_route_id), 1), 0);
  ELSE
    v_status := 'waitlisted';
    v_use_seat_number := NULL;
    SELECT coalesce(max(queue_position), 0) + 1 INTO v_queue_position FROM route_subscriptions WHERE route_id = p_route_id AND status = 'waitlisted';
  END IF;

  IF v_status = 'pending' AND v_est_deposit > 0 THEN
    IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
      IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip for the first month''s advance.' USING ERRCODE = 'P0001'; END IF;
    ELSE
      IF NOT v_vehicle.is_active THEN RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001'; END IF;
      v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
      v_expected_commission := round(v_est_deposit * v_commission_pct / 100, 2);
      IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
        RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO route_subscriptions (route_id, portal_user_id, board_stop_id, status, monthly_fee_pkr, queue_position, seat_number)
    VALUES (p_route_id, v_portal_user_id, p_board_stop_id, v_status, v_fee, v_queue_position, v_use_seat_number)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That seat was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
  END;

  IF v_status = 'pending' THEN
    IF v_est_deposit > 0 THEN
      INSERT INTO route_subscription_charges (subscription_id, month, year, amount_pkr, proof_url, payment_method, status)
      VALUES (v_id, extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int, extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int, v_est_deposit, p_proof_url, p_method, 'due')
      ON CONFLICT (subscription_id, month, year) DO NOTHING;
    END IF;

    IF v_vehicle.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      SELECT v_vehicle.portal_user_id, 'route_monthly_application', 'New monthly seat application — confirm to activate',
        coalesce(pu.full_name, 'A rider') || ' applied for a monthly seat — Rs ' || round(v_fee) || '/month. They will only join your ride group once you confirm.',
        '/portal/my-vehicle/routes'
      FROM portal_users pu WHERE pu.id = v_portal_user_id;
    END IF;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'route_monthly_application_sent',
    CASE WHEN v_status = 'pending' THEN 'Application sent — waiting for the driver' ELSE 'Added to the waitlist' END,
    CASE WHEN v_status = 'pending' THEN 'Your monthly seat application and payment details were sent. The driver must confirm before your seat is final and you join the ride group.'
      ELSE 'No seat is free right now — you''re on the waitlist and will be offered the next free seat.' END,
    '/portal/marketplace/route/' || p_route_id);

  RETURN jsonb_build_object('subscription_id', v_id, 'status', v_status, 'monthly_fee_pkr', v_fee, 'queue_position', v_queue_position, 'deposit_pkr', v_est_deposit);
END;
$$;
GRANT EXECUTE ON FUNCTION apply_for_monthly_seat(uuid, uuid, varchar, text, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- decline_ride_booking_seat / cancel_ride_booking — free the held seat
-- number(s) the moment a booking leaves 'announced'/'confirmed', so
-- the UNIQUE constraint doesn't block the same seat being re-booked.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION decline_ride_booking_seat(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL OR NOT is_route_owner(b.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001'; END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Your seat request could not be confirmed',
    'The driver could not confirm your seat for ' || v_route.origin || ' → ' || v_route.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || p_reason, '') || ' Your payment was not taken through the app — settle directly with the driver if anything was already paid.',
    '/portal/marketplace/trips');
END;
$$;
GRANT EXECUTE ON FUNCTION decline_ride_booking_seat(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_ride_booking(p_booking_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean;
  v_departure timestamptz;
  v_within_cutoff boolean;
  v_late boolean := false;
  v_reversal_id uuid; v_reversal_no varchar;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'cancelled' THEN RAISE EXCEPTION 'This booking is already cancelled.' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'rejected' THEN RAISE EXCEPTION 'This booking was already declined.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  v_is_rider := v_portal_user_id IS NOT NULL AND b.portal_user_id = v_portal_user_id;
  v_is_driver := v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id;
  v_is_admin := COALESCE(current_admin_permission('post_transactions'), false);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  IF v_is_rider AND NOT v_is_driver AND NOT v_is_admin AND b.status = 'confirmed' THEN
    v_departure := (b.travel_date + COALESCE(r.departure_time, '00:00'::time)) AT TIME ZONE 'Asia/Karachi';
    v_within_cutoff := r.departure_time IS NOT NULL AND v_departure - now() < interval '2 hours';
    v_late := v_within_cutoff;
  END IF;

  IF b.status = 'confirmed' AND NOT v_late THEN
    IF b.commission_voucher_id IS NOT NULL THEN
      SELECT id, voucher_no INTO v_reversal_id, v_reversal_no FROM vouchers WHERE id = b.commission_voucher_id;
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, reverses_voucher_id, reversal_reason)
      SELECT system, voucher_type, (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Reversal of ' || voucher_no || ' — ride booking cancelled: ' || COALESCE(trim(p_reason), 'no reason given'),
        amount_pkr, to_account_id, from_account_id, party_name, id, COALESCE(trim(p_reason), 'Ride booking cancelled')
      FROM vouchers WHERE id = b.commission_voucher_id
      RETURNING id INTO v_reversal_id;
      UPDATE vouchers SET reversed_by_voucher_id = v_reversal_id WHERE id = b.commission_voucher_id;
    END IF;
    IF b.gross_voucher_id IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, reverses_voucher_id, reversal_reason)
      SELECT system, voucher_type, (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Reversal of ' || voucher_no || ' — ride booking cancelled: ' || COALESCE(trim(p_reason), 'no reason given'),
        amount_pkr, to_account_id, from_account_id, party_name, id, COALESCE(trim(p_reason), 'Ride booking cancelled')
      FROM vouchers WHERE id = b.gross_voucher_id
      RETURNING id INTO v_reversal_id;
      UPDATE vouchers SET reversed_by_voucher_id = v_reversal_id WHERE id = b.gross_voucher_id;
    END IF;
  END IF;

  UPDATE ride_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by_portal_user_id = v_portal_user_id,
    cancellation_reason = trim(p_reason), is_late_cancellation = v_late
  WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;

  IF v_is_rider AND NOT v_is_driver THEN
    IF v.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v.portal_user_id, 'ride_booking_cancelled', 'A rider cancelled',
        'A seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' was cancelled' || (CASE WHEN v_late THEN ' (late — inside the 2-hour cutoff).' ELSE '.' END), '/my-vehicle');
    END IF;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'ride_booking_cancelled', 'Your booking was cancelled',
      'Your seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), ''), '/accounts');
  END IF;

  RETURN jsonb_build_object('status', 'cancelled', 'was_late', v_late, 'reversed', b.status = 'confirmed' AND NOT v_late);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_ride_booking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_ride_booking(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- reschedule_ride_booking — moves any held seat numbers to the new
-- date too, otherwise they'd stay attached to the old (now-irrelevant)
-- date while the booking itself points at the new one. This function
-- already only operates on fare_mode='fixed' routes (line "This
-- route's fare depends on the date it's booked for" blocks 'flex'
-- entirely) — fixed-mode is exactly today's van-kind routes post-847,
-- so every reschedulable route is exactly the kind that can have seat
-- numbers.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reschedule_ride_booking(
  p_booking_id uuid, p_new_travel_date date,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_clear_stops boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
  v_board_stop route_stops%ROWTYPE; v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1; v_new_total numeric;
  v_use_board_stop_id uuid; v_use_alight_stop_id uuid;
  v_changing_stops boolean := p_clear_stops OR p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND portal_user_id = current_portal_user_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF b.route_id IS NULL THEN RAISE EXCEPTION 'This booking cannot be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_changing_stops AND b.status != 'announced' THEN
    RAISE EXCEPTION 'Your seat is already confirmed by the driver — cancel and book again to change your boarding stop.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  IF r.fare_mode = 'flex' THEN RAISE EXCEPTION 'This route''s fare depends on the date it''s booked for — cancel and rebook instead.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(b.route_id, p_new_travel_date);
  IF b.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  IF p_clear_stops THEN
    v_use_board_stop_id := NULL; v_use_alight_stop_id := NULL; v_segment_fraction := 1;
  ELSIF p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL THEN
    IF (p_board_stop_id IS NULL) != (p_alight_stop_id IS NULL) THEN
      RAISE EXCEPTION 'Pick both a board and an alight stop, or neither.' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
    v_use_board_stop_id := p_board_stop_id; v_use_alight_stop_id := p_alight_stop_id;
  ELSE
    v_use_board_stop_id := b.board_stop_id; v_use_alight_stop_id := b.alight_stop_id;
    IF b.board_stop_id IS NOT NULL AND b.alight_stop_id IS NOT NULL THEN
      SELECT * INTO v_board_stop FROM route_stops WHERE id = b.board_stop_id;
      SELECT * INTO v_alight_stop FROM route_stops WHERE id = b.alight_stop_id;
      v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    END IF;
  END IF;

  v_new_total := round(b.seats * r.fare_per_seat_pkr * v_segment_fraction);

  UPDATE ride_bookings SET travel_date = p_new_travel_date, board_stop_id = v_use_board_stop_id, alight_stop_id = v_use_alight_stop_id, total_amount_pkr = v_new_total
  WHERE id = p_booking_id;
  BEGIN
    UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date WHERE ride_booking_id = p_booking_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Your seat is already taken by someone else on that date — pick a different date.' USING ERRCODE = 'P0001';
  END;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'route_booking_rescheduled', 'A rider rescheduled their seat',
    r.origin || ' → ' || r.destination || ' — moved to ' || to_char(p_new_travel_date, 'DD Mon') || '.', '/portal/my-vehicle/routes'
  FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION reschedule_ride_booking(uuid, date, uuid, uuid, boolean) TO authenticated;
