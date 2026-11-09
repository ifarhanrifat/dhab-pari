-- Migration 831: real ask, 2026-11-09 — "monthly fix sharing and the
-- ordinary sharing booked will now have to be confirmed seats from the
-- driver side... only the confirmed riders will be part of groups...
-- for the one off non recurring trip it will be good if user send the
-- payment along with it and driver will confirm the payment and then
-- the seat will be confirmed."
--
-- Two different existing mechanisms were nearly mistaken for this
-- before reading their real bodies:
--   - confirm_ride_booking/reject_ride_booking (389/394/410) IS already
--     wired on my-vehicle/routes/page.tsx, but its own copy ("Mark
--     Fulfilled" / "the customer already paid you directly — mark this
--     once you've served them") is a POST-ride commission-accounting
--     settlement a driver can tap any time, including days later — not
--     a pre-ride accept/decline gate. Tying route_participants/group
--     access to it would leave riders locked out of the live map/chat
--     for the entire day of travel, since nothing requires a driver to
--     tap it before (or even on) the travel date.
--   - apply_for_monthly_seat already goes instantly to status='active'
--     the moment a seat is free, with route_participants inserted in
--     the same breath (823) — no driver confirmation step exists at
--     all today for a monthly seat.
--
-- So this is a genuinely new, independent, pre-ride gate: a new
-- ride_bookings.seat_accepted_at timestamp (ad-hoc/standalone-return
-- seats) and a new route_subscriptions status 'pending' (monthly),
-- both left untouched by the existing commission-settlement flow.
-- route_participants — the one thing that actually unlocks the live
-- group (map/chat/notifications via is_route_member) — now inserts
-- ONLY once a driver explicitly accepts, never at booking/apply time.
--
-- Existing live route_participants rows (added under the old instant-
-- join behavior) are deliberately left untouched here — this only
-- changes the gate for bookings/applications made from now on, not a
-- retroactive eviction of riders already trusted into an active group.

ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS seat_accepted_at timestamptz;

ALTER TABLE route_subscriptions DROP CONSTRAINT IF EXISTS route_subscriptions_status_check;
ALTER TABLE route_subscriptions ADD CONSTRAINT route_subscriptions_status_check
  CHECK (status IN ('pending', 'active', 'waitlisted', 'pending_cancellation', 'cancelled'));

-- ═════════════════════════════════════════════════════════════════════
-- place_ride_booking — payment method/proof now required for every
-- ad-hoc seat (not only monthly_lumpsum vehicles, per the real ask
-- "send the payment along with it"), status stays 'announced', and the
-- route_participants insert is removed entirely (moved to
-- accept_ride_booking_seat below). Everything else (fare math, board/
-- alight segment fare, wallet-balance check) is unchanged from 822.
-- ═════════════════════════════════════════════════════════════════════
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
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment screenshot/slip before booking.' USING ERRCODE = 'P0001'; END IF;

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

  IF NOT v_vehicle.is_active THEN
    RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
  END IF;
  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id)
  RETURNING id INTO v_booking_id;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New seat request — confirm to add them to your group',
      p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || ' paid via ' || p_method || '. They will only join your ride group once you confirm.', '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat request sent — waiting for the driver',
    'Your payment details were sent with the request. The driver must confirm before your seat is final and you join the ride group. Unconfirmed requests are automatically cancelled if the driver never responds before the travel date.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text, uuid, uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- book_standalone_return_seat — same two changes: proof always
-- required, no instant route_participants insert.
-- ═════════════════════════════════════════════════════════════════════
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
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment screenshot/slip before booking.' USING ERRCODE = 'P0001'; END IF;

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

  IF NOT v_vehicle.is_active THEN
    RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001';
  END IF;
  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, direction)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, 1, v_total, 'announced', v_total, p_method, p_proof_url, now(), 'return')
  RETURNING id INTO v_booking_id;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New one-way return seat request — confirm to add them to your group',
      '1 seat from ' || v_stop_label || ' on ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || ' paid via ' || p_method || '.', '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat request sent — waiting for the driver',
    'Your payment details were sent with the request. The driver must confirm before your seat is final and you join the ride group.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION book_standalone_return_seat(uuid, date, uuid, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- accept_ride_booking_seat / decline_ride_booking_seat — the new, pre-
-- ride, routes-app-native gate. Deliberately independent of
-- confirm_ride_booking/reject_ride_booking (the commission-settlement
-- pair) and of commission_mode — any route owner can accept/decline
-- their own route's pending seat requests regardless of how their
-- vehicle settles commission.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION accept_ride_booking_seat(p_booking_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL OR NOT is_route_owner(b.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001'; END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  IF b.seat_accepted_at IS NOT NULL THEN RETURN; END IF;

  UPDATE ride_bookings SET seat_accepted_at = now() WHERE id = p_booking_id;

  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (b.route_id, b.portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_seat_accepted', 'Your seat is confirmed',
    'The driver confirmed your seat for ' || v_route.origin || ' → ' || v_route.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || '. You''re now in the ride group — live map, chat and boarding are open.',
    '/portal/marketplace/trips');
END;
$$;
GRANT EXECUTE ON FUNCTION accept_ride_booking_seat(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION decline_ride_booking_seat(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL OR NOT is_route_owner(b.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001'; END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Your seat request could not be confirmed',
    'The driver could not confirm your seat for ' || v_route.origin || ' → ' || v_route.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || p_reason, '') || ' Your payment was not taken through the app — settle directly with the driver if anything was already paid.',
    '/portal/marketplace/trips');
END;
$$;
GRANT EXECUTE ON FUNCTION decline_ride_booking_seat(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- route_today_ad_hoc_bookings — adds seat_accepted_at so the roster can
-- show a clear "pending" vs "confirmed" tag.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_today_ad_hoc_bookings(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'name', pu.full_name, 'seats', rb.seats, 'boarded_at', rb.boarded_at, 'dropped_off_at', rb.dropped_off_at,
      'board_stop_id', rb.board_stop_id, 'seat_accepted_at', rb.seat_accepted_at
    ) ORDER BY rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND rb.status IN ('announced', 'confirmed') AND rb.direction = 'outbound'
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_today_ad_hoc_bookings(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- route_pending_seat_requests — every not-yet-accepted/declined ad-hoc
-- or standalone-return seat request on this route, any future travel
-- date (not just today), so a driver can confirm a booking made days
-- ahead without waiting for the travel date. Includes the rider's
-- submitted payment method/proof so the driver can check it before
-- confirming.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_pending_seat_requests(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'name', pu.full_name, 'seats', rb.seats, 'travel_date', rb.travel_date, 'direction', rb.direction,
      'total_amount_pkr', rb.total_amount_pkr, 'announced_method', rb.announced_method, 'announced_proof_url', rb.announced_proof_url
    ) ORDER BY rb.travel_date, rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.status = 'announced' AND rb.seat_accepted_at IS NULL
      AND rb.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_pending_seat_requests(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Monthly: apply_for_monthly_seat now always lands at 'pending' instead
-- of instantly 'active' — payment proof (when the vehicle requires it),
-- fee, and the rider's requested stop are unchanged and collected at
-- apply time exactly as before, but the deposit charge row, attendance
-- pre-seeding, and the route_participants join all move to
-- confirm_monthly_subscription below, so nothing is billed or joined
-- to the group until the driver actually confirms. A would-be-waitlisted
-- applicant is unaffected — that path never billed or joined anyone.
-- 'pending' now also counts toward the active-seat check so a second
-- applicant can't be granted the same seat while the first is still
-- awaiting confirmation.
-- ═════════════════════════════════════════════════════════════════════
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
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_est_deposit numeric := 0;
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

  IF v_active_count < v_seats THEN
    v_status := 'pending'; v_queue_position := NULL;
    v_est_deposit := round(v_fee / scheduled_days_in_month(p_route_id, extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int, extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int))
      * coalesce(array_length(scheduled_days_remaining_in_month(p_route_id), 1), 0);
  ELSE
    v_status := 'waitlisted';
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

  INSERT INTO route_subscriptions (route_id, portal_user_id, board_stop_id, status, monthly_fee_pkr, queue_position)
  VALUES (p_route_id, v_portal_user_id, p_board_stop_id, v_status, v_fee, v_queue_position)
  RETURNING id INTO v_id;

  IF v_status = 'pending' THEN
    -- Stashed on the row now (status='due', not yet counted anywhere)
    -- so confirm_monthly_subscription can post the exact same proof/
    -- method the rider submitted here, re-derived to the real amount
    -- at confirm time.
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
GRANT EXECUTE ON FUNCTION apply_for_monthly_seat(uuid, uuid, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- confirm_monthly_subscription / reject_monthly_subscription — the
-- driver's accept/decline for a 'pending' monthly application. Confirm
-- re-derives the deposit from scheduled_days_remaining_in_month at
-- CONFIRM time (not apply time, which may be days earlier), pre-seeds
-- attendance for those days exactly the way take_attendance's own
-- accrual already works, updates the already-inserted 'due' charge row
-- to the re-derived amount, and only now joins route_participants.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_monthly_subscription(p_subscription_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub route_subscriptions%ROWTYPE; v_route vehicle_routes%ROWTYPE;
  v_month int := extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_year int := extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_daily_share numeric; v_remaining_days date[]; v_deposit numeric; v_i int;
BEGIN
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = p_subscription_id FOR UPDATE;
  IF NOT FOUND OR NOT is_route_owner(v_sub.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s riders.' USING ERRCODE = 'P0001'; END IF;
  IF v_sub.status != 'pending' THEN RAISE EXCEPTION 'This application is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  v_remaining_days := scheduled_days_remaining_in_month(v_sub.route_id);
  v_daily_share := round(v_sub.monthly_fee_pkr / scheduled_days_in_month(v_sub.route_id, v_month, v_year));
  v_deposit := v_daily_share * coalesce(array_length(v_remaining_days, 1), 0);

  UPDATE route_subscriptions SET status = 'active' WHERE id = p_subscription_id;

  IF v_remaining_days IS NOT NULL AND array_length(v_remaining_days, 1) > 0 THEN
    FOR v_i IN 1..array_length(v_remaining_days, 1) LOOP
      INSERT INTO route_run_attendance (route_id, subscription_id, run_date, present, marked_by)
      VALUES (v_sub.route_id, p_subscription_id, v_remaining_days[v_i], true, current_portal_user_id())
      ON CONFLICT (subscription_id, run_date) DO NOTHING;
    END LOOP;
  END IF;
  UPDATE route_subscription_charges SET amount_pkr = v_deposit
    WHERE subscription_id = p_subscription_id AND month = v_month AND year = v_year AND status = 'due';

  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (v_sub.route_id, v_sub.portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_sub.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_sub.portal_user_id, 'route_monthly_confirmed', 'Your monthly seat is confirmed',
    'The driver confirmed your monthly seat on ' || v_route.origin || ' → ' || v_route.destination || '. You''re now in the ride group — live map, chat and boarding are open. This advance is non-refundable once paid.',
    '/portal/marketplace/route/' || v_sub.route_id);
END;
$$;
GRANT EXECUTE ON FUNCTION confirm_monthly_subscription(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reject_monthly_subscription(p_subscription_id uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub route_subscriptions%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = p_subscription_id FOR UPDATE;
  IF NOT FOUND OR NOT is_route_owner(v_sub.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s riders.' USING ERRCODE = 'P0001'; END IF;
  IF v_sub.status != 'pending' THEN RAISE EXCEPTION 'This application is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE route_subscriptions SET status = 'cancelled', cancellation_reason = p_reason WHERE id = p_subscription_id;
  DELETE FROM route_subscription_charges WHERE subscription_id = p_subscription_id AND status = 'due';

  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_sub.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_sub.portal_user_id, 'route_monthly_rejected', 'Your monthly seat application could not be confirmed',
    'The driver could not confirm your monthly seat on ' || v_route.origin || ' → ' || v_route.destination || '.' || COALESCE(' ' || p_reason, '') || ' Your payment was not taken through the app — settle directly with the driver if anything was already paid.',
    '/portal/marketplace/route/' || v_sub.route_id);
END;
$$;
GRANT EXECUTE ON FUNCTION reject_monthly_subscription(uuid, text) TO authenticated;

-- promote_next_waitlisted — a promoted waitlisted rider now also lands
-- at 'pending' (still needs the driver's explicit confirm), instead of
-- going straight to 'active' as before. No charge/attendance existed
-- for a waitlisted row, so nothing to create here beyond the estimate
-- the driver will see when they confirm.
CREATE OR REPLACE FUNCTION promote_next_waitlisted(p_route_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_next route_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_next FROM route_subscriptions WHERE route_id = p_route_id AND status = 'waitlisted' ORDER BY queue_position LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE route_subscriptions SET status = 'pending', queue_position = NULL WHERE id = v_next.id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_next.portal_user_id, 'route_seat_promoted', 'A seat opened up — awaiting driver confirmation',
    'A monthly seat is now free. The driver must confirm before you join the ride group.', '/portal/marketplace/route/' || p_route_id);
END;
$$;
GRANT EXECUTE ON FUNCTION promote_next_waitlisted(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- route_group_detail / route_monthly_detail — surface the two pending
-- lists to the owner so RouteGroupPanel/RouteDetailPanel can render
-- Accept/Decline actions.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_group_detail(p_route_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_owner boolean := is_route_owner(p_route_id);
  v_is_member boolean := is_route_member(p_route_id);
  v_sharing boolean := false;
  v_owner_portal_user_id uuid;
  v_route vehicle_routes%ROWTYPE;
  v_active_run route_runs%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_route.vehicle_id;
  SELECT * INTO v_active_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;

  IF v_is_member THEN
    SELECT sharing_location INTO v_sharing FROM route_participants WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  END IF;

  RETURN jsonb_build_object(
    'is_owner', v_is_owner,
    'is_member', v_is_member,
    'sharing_location', coalesce(v_sharing, false),
    'owner_portal_user_id', v_owner_portal_user_id,
    'route_path', v_route.route_path,
    'route_duration_min', v_route.route_duration_min,
    'is_two_way', v_route.is_two_way,
    'return_wait_minutes', v_route.return_wait_minutes,
    'return_seats_available_today', CASE WHEN v_route.is_two_way THEN return_seats_available(p_route_id, v_today) ELSE NULL END,
    'active_run', CASE WHEN v_active_run.id IS NOT NULL THEN jsonb_build_object('id', v_active_run.id, 'started_at', v_active_run.started_at, 'direction', v_active_run.direction, 'outbound_arrived_at', v_active_run.outbound_arrived_at) ELSE NULL END,
    'todays_runs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'direction', direction, 'started_at', started_at, 'ended_at', ended_at) ORDER BY started_at), '[]'::jsonb)
      FROM route_runs WHERE route_id = p_route_id
        AND ((started_at AT TIME ZONE 'Asia/Karachi')::date = v_today
          OR (ended_at IS NOT NULL AND (ended_at AT TIME ZONE 'Asia/Karachi')::date = v_today))),
    'stops', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'label_ur', s.label_ur, 'lat', s.lat, 'lng', s.lng) ORDER BY s.stop_order), '[]'::jsonb) FROM route_stops s WHERE s.route_id = p_route_id),
    'roster_today', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'subscription_id', rs.id, 'name', pu.full_name,
        'on_leave_today', EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = v_today),
        'present', COALESCE((SELECT present FROM route_run_attendance ra WHERE ra.subscription_id = rs.id AND ra.run_date = v_today),
          NOT EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = v_today))
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending_cancellation')
    ) ELSE '[]'::jsonb END,
    'pending_seat_requests', CASE WHEN v_is_owner THEN route_pending_seat_requests(p_route_id) ELSE '[]'::jsonb END,
    'pending_monthly_applications', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', rs.id, 'name', pu.full_name, 'monthly_fee_pkr', rs.monthly_fee_pkr, 'stop_label', rst.label, 'applied_at', rs.applied_at,
        'deposit_pkr', rsc.amount_pkr, 'proof_url', rsc.proof_url, 'payment_method', rsc.payment_method
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
        LEFT JOIN route_stops rst ON rst.id = rs.board_stop_id
        LEFT JOIN route_subscription_charges rsc ON rsc.subscription_id = rs.id AND rsc.status = 'due'
      WHERE rs.route_id = p_route_id AND rs.status = 'pending'
    ) ELSE '[]'::jsonb END,
    'todays_outbound_bookings', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'booking_id', rb.id, 'name', pu.full_name, 'seats', rb.seats,
        'offboarded', EXISTS (SELECT 1 FROM route_run_offboards o WHERE o.ride_booking_id = rb.id)
      ) ORDER BY rb.created_at), '[]'::jsonb)
      FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
      WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = 'outbound' AND rb.status IN ('announced', 'confirmed')
    ) ELSE '[]'::jsonb END,
    'participants', CASE WHEN v_is_member THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'portal_user_id', pu.id, 'name', pu.full_name, 'sharing_location', rp.sharing_location
      ) ORDER BY rp.joined_at), '[]'::jsonb)
      FROM route_participants rp JOIN portal_users pu ON pu.id = rp.portal_user_id
      WHERE rp.route_id = p_route_id AND rp.is_active = true
    ) ELSE '[]'::jsonb END,
    'messages', CASE WHEN v_is_member THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender_portal_user_id', m.sender_portal_user_id, 'sender_name', pu.full_name,
        'is_own', m.sender_portal_user_id = v_portal_user_id, 'body', m.body, 'created_at', m.created_at
      ) ORDER BY m.created_at), '[]'::jsonb)
      FROM route_chat_messages m JOIN portal_users pu ON pu.id = m.sender_portal_user_id
      WHERE m.route_id = p_route_id
    ) ELSE '[]'::jsonb END,
    'live_locations', CASE WHEN v_is_member THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'portal_user_id', pu.id, 'name', pu.full_name, 'is_own', rl.portal_user_id = v_portal_user_id,
        'is_owner', rl.portal_user_id = v_owner_portal_user_id,
        'lat', rl.lat, 'lng', rl.lng, 'updated_at', rl.updated_at
      )), '[]'::jsonb)
      FROM route_live_locations rl JOIN portal_users pu ON pu.id = rl.portal_user_id
      WHERE rl.route_id = p_route_id
    ) ELSE '[]'::jsonb END
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_group_detail(uuid) TO authenticated;

-- route_monthly_detail — the driver's monthly-subscribers management
-- panel (RouteMonthlySubscribersPanel) gains the same pending list so
-- it can Accept/Decline too, not only RouteGroupPanel.
CREATE OR REPLACE FUNCTION route_monthly_detail(p_route_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_owner boolean := is_route_owner(p_route_id);
  v_route vehicle_routes%ROWTYPE;
  v_seats int;
  v_active_count int;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  v_seats := route_effective_seats(p_route_id);
  SELECT count(*) INTO v_active_count FROM route_subscriptions WHERE route_id = p_route_id AND status = 'active';

  RETURN jsonb_build_object(
    'is_monthly_fixed', v_route.is_monthly_fixed,
    'monthly_reference_fee_pkr', v_route.monthly_reference_fee_pkr,
    'seats_total', v_seats,
    'active_count', v_active_count,
    'my_subscription', (
      SELECT jsonb_build_object('id', rs.id, 'status', rs.status, 'monthly_fee_pkr', rs.monthly_fee_pkr, 'queue_position', rs.queue_position, 'scheduled_cancellation_at', rs.scheduled_cancellation_at)
      FROM route_subscriptions rs WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id AND rs.status != 'cancelled'
    ),
    'my_leave_days', (
      SELECT COALESCE(jsonb_agg(ld.leave_date ORDER BY ld.leave_date), '[]'::jsonb)
      FROM route_subscription_leave_days ld JOIN route_subscriptions rs ON rs.id = ld.subscription_id
      WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id AND ld.leave_date >= current_date
    ),
    'subscribers', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', rs.id, 'name', pu.full_name, 'stop_label', rst.label, 'monthly_fee_pkr', rs.monthly_fee_pkr,
        'status', rs.status, 'scheduled_cancellation_at', rs.scheduled_cancellation_at
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id LEFT JOIN route_stops rst ON rst.id = rs.board_stop_id
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending_cancellation')
    ) ELSE '[]'::jsonb END,
    'pending_applications', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', rs.id, 'name', pu.full_name, 'stop_label', rst.label, 'monthly_fee_pkr', rs.monthly_fee_pkr, 'applied_at', rs.applied_at,
        'deposit_pkr', rsc.amount_pkr, 'proof_url', rsc.proof_url, 'payment_method', rsc.payment_method
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
        LEFT JOIN route_stops rst ON rst.id = rs.board_stop_id
        LEFT JOIN route_subscription_charges rsc ON rsc.subscription_id = rs.id AND rsc.status = 'due'
      WHERE rs.route_id = p_route_id AND rs.status = 'pending'
    ) ELSE '[]'::jsonb END,
    'waitlist', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rs.id, 'name', pu.full_name, 'queue_position', rs.queue_position, 'monthly_fee_pkr', rs.monthly_fee_pkr) ORDER BY rs.queue_position), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rs.status = 'waitlisted'
    ) ELSE '[]'::jsonb END,
    'due_charges', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rsc.id, 'rider_name', pu.full_name, 'month', rsc.month, 'year', rsc.year, 'amount_pkr', rsc.amount_pkr, 'proof_url', rsc.proof_url) ORDER BY rsc.year, rsc.month), '[]'::jsonb)
      FROM route_subscription_charges rsc JOIN route_subscriptions rs ON rs.id = rsc.subscription_id JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rsc.status = 'due' AND rs.status != 'pending'
    ) ELSE '[]'::jsonb END,
    'my_charges', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month', rsc.month, 'year', rsc.year, 'amount_pkr', rsc.amount_pkr, 'status', rsc.status) ORDER BY rsc.year, rsc.month), '[]'::jsonb)
      FROM route_subscription_charges rsc JOIN route_subscriptions rs ON rs.id = rsc.subscription_id
      WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id
    )
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_monthly_detail(uuid) TO authenticated;
