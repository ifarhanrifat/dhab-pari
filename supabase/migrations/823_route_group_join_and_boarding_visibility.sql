-- Migration 823: real bug report, 2026-11-07, from a live test booking
-- (Chakwal → Mangwal, rider Riffat Iqbal, driver Rizwan Iqbal):
--
--   1. "it should sit in the floating button" — traced to
--      FloatingBookingsHub's own seat query filtering to
--      status = 'announced' only, so the moment the driver confirms a
--      booking it silently drops out of the hub (fixed in the frontend
--      commit alongside this migration, not here).
--   2. "the small window... not having any map" — the rider's own
--      booking row on the Bookings list opened the old, plain
--      BookingQuickViewSheet instead of the real, rich RouteBookingSheet
--      (map + stops) this session already built — also a frontend fix.
--   3. "during the driver on the way it not created any alert" —
--      root-caused to a real regression: migration 717 added an
--      auto-join-the-route-group insert to place_ride_booking so every
--      rider would show up in route_participants (which is what
--      start_route_run's own notification, and the whole live map/chat/
--      location feature, is gated on) — but migration 725 silently
--      dropped that insert when it next redefined place_ride_booking for
--      an unrelated reason, and it was never there at all in
--      book_standalone_return_seat (727) or apply_for_monthly_seat (723).
--      Confirmed via grep across every historical redefinition. Restored
--      here in all three.
--   4. "driver onboard that rider right from the start... before
--      starting the ride the driver was not aware who has booked his
--      ride" — route_today_ad_hoc_bookings never returned which stop a
--      rider actually chose to board at, so the driver's pre-start
--      checklist defaulted every rider to boarded-at-origin with no way
--      to tell a mid-route rider apart (frontend fix defaults those to
--      unchecked instead); this just adds the missing column.

-- (3) Restore/add the route-group auto-join to all three booking paths.
-- Bodies are each this session's own most recent live definition
-- (place_ride_booking / apply_for_monthly_seat from 822,
-- book_standalone_return_seat from 729) with only the one upsert added
-- right before each RETURN.

DROP FUNCTION IF EXISTS place_ride_booking(uuid, date, int, varchar, text, uuid, uuid);
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL
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

  -- Real regression fixed here: this upsert existed once (717) and was
  -- silently lost when 725 next redefined this function — every ad-hoc
  -- rider since then was invisible to the route's live map/chat/location
  -- group and to start_route_run's own "the van is on its way" alert,
  -- both of which key off route_participants.
  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (p_route_id, v_portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New seat booked on your route',
      p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total), '/portal/my-vehicle/routes');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text, uuid, uuid) TO authenticated;

-- book_standalone_return_seat (729's live body) never had the join at
-- all — a standalone return-leg rider is just as much a real rider on
-- this route for the day and deserves the same live map/chat access.
CREATE OR REPLACE FUNCTION book_standalone_return_seat(p_route_id uuid, p_travel_date date, p_board_stop_id uuid DEFAULT NULL, p_method varchar DEFAULT 'cash', p_proof_url text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
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

  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (p_route_id, v_portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_return_seat_booked', 'Return-only seat booked',
      'A rider joined just the return leg from ' || v_stop_label || ' — Rs ' || round(v_total), '/portal/my-vehicle/routes');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION book_standalone_return_seat(uuid, date, uuid, varchar, text) TO authenticated;

-- apply_for_monthly_seat (822's live body) never had the join either —
-- a standing monthly rider, of everyone, should never be excluded from
-- the route's live group.
DROP FUNCTION IF EXISTS apply_for_monthly_seat(uuid, uuid, varchar, text);
CREATE OR REPLACE FUNCTION apply_for_monthly_seat(p_route_id uuid, p_board_stop_id uuid, p_method varchar DEFAULT 'cash', p_proof_url text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_stop route_stops%ROWTYPE;
  v_seats int;
  v_active_count int;
  v_fraction numeric;
  v_fee numeric;
  v_status varchar;
  v_queue_position int;
  v_id uuid;
  v_month int := extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_year int := extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_daily_share numeric;
  v_remaining_days date[];
  v_deposit numeric := 0;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_i int;
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
  SELECT count(*) INTO v_active_count FROM route_subscriptions WHERE route_id = p_route_id AND status = 'active';

  IF v_active_count < v_seats THEN
    v_status := 'active'; v_queue_position := NULL;
  ELSE
    v_status := 'waitlisted';
    SELECT coalesce(max(queue_position), 0) + 1 INTO v_queue_position FROM route_subscriptions WHERE route_id = p_route_id AND status = 'waitlisted';
  END IF;

  IF v_status = 'active' THEN
    v_daily_share := round(v_fee / scheduled_days_in_month(p_route_id, v_month, v_year));
    v_remaining_days := scheduled_days_remaining_in_month(p_route_id);
    v_deposit := v_daily_share * coalesce(array_length(v_remaining_days, 1), 0);
  END IF;

  IF v_deposit > 0 THEN
    IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
      IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip for the first month''s advance.' USING ERRCODE = 'P0001'; END IF;
    ELSE
      IF NOT v_vehicle.is_active THEN RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001'; END IF;
      v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
      v_expected_commission := round(v_deposit * v_commission_pct / 100, 2);
      IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
        RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  INSERT INTO route_subscriptions (route_id, portal_user_id, board_stop_id, status, monthly_fee_pkr, queue_position)
  VALUES (p_route_id, v_portal_user_id, p_board_stop_id, v_status, v_fee, v_queue_position)
  RETURNING id INTO v_id;

  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (p_route_id, v_portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

  IF v_status = 'active' AND v_remaining_days IS NOT NULL AND array_length(v_remaining_days, 1) > 0 THEN
    FOR v_i IN 1..array_length(v_remaining_days, 1) LOOP
      INSERT INTO route_run_attendance (route_id, subscription_id, run_date, present, marked_by)
      VALUES (p_route_id, v_id, v_remaining_days[v_i], true, v_portal_user_id)
      ON CONFLICT (subscription_id, run_date) DO NOTHING;
    END LOOP;
    IF v_deposit > 0 THEN
      INSERT INTO route_subscription_charges (subscription_id, month, year, amount_pkr, proof_url, payment_method)
      VALUES (v_id, v_month, v_year, v_deposit, p_proof_url, p_method)
      ON CONFLICT (subscription_id, month, year) DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object('subscription_id', v_id, 'status', v_status, 'monthly_fee_pkr', v_fee, 'queue_position', v_queue_position, 'deposit_pkr', v_deposit);
END;
$$;
GRANT EXECUTE ON FUNCTION apply_for_monthly_seat(uuid, uuid, varchar, text) TO authenticated;

-- One-time backfill: every live ride_bookings/route_subscriptions row
-- that should already be a route_participant (per the logic above) but
-- never got the chance to be, because of the regression this migration
-- fixes going forward. Safe/idempotent — matches the exact same
-- ON CONFLICT upsert shape used above.
INSERT INTO route_participants (route_id, portal_user_id, is_active)
SELECT DISTINCT route_id, portal_user_id, true FROM ride_bookings
WHERE route_id IS NOT NULL AND status IN ('announced', 'confirmed')
ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

INSERT INTO route_participants (route_id, portal_user_id, is_active)
SELECT DISTINCT route_id, portal_user_id, true FROM route_subscriptions
WHERE status IN ('active', 'pending_cancellation', 'waitlisted')
ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

-- (4) route_today_ad_hoc_bookings gains which stop each rider actually
-- booked from, so the driver's pre-start checklist can tell an
-- origin-boarding rider apart from a mid-route one instead of treating
-- every rider the same.
CREATE OR REPLACE FUNCTION route_today_ad_hoc_bookings(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'name', pu.full_name, 'seats', rb.seats, 'boarded_at', rb.boarded_at, 'dropped_off_at', rb.dropped_off_at,
      'board_stop_id', rb.board_stop_id
    ) ORDER BY rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND rb.status IN ('announced', 'confirmed') AND rb.direction = 'outbound'
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_today_ad_hoc_bookings(uuid) TO authenticated;
