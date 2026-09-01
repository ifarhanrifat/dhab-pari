-- Migration 410: booking against an adda queue entry — the two fare
-- modes 409 already stores on adda_queue_entries ('fixed' / 'request')
-- map onto the two booking mechanisms this app already has, not a third
-- one: fixed fare extends ride_bookings exactly the way migration 390
-- already extended collector_settlements (drop NOT NULL, add an
-- optional target column, add a num_nonnulls(...) = 1 CHECK); ride
-- request reuses vehicle_trip_fare_offers (400) completely untouched —
-- adda_check_in just also creates the vehicle_trip_offers row a
-- request-mode entry needs to receive fare proposals against.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. ride_bookings can now target an adda queue entry instead of a
--    scheduled route — same move 390 made for collector_settlements.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE ride_bookings ALTER COLUMN route_id DROP NOT NULL;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS adda_queue_entry_id uuid REFERENCES adda_queue_entries(id);
ALTER TABLE ride_bookings DROP CONSTRAINT IF EXISTS ride_bookings_one_target_check;
ALTER TABLE ride_bookings ADD CONSTRAINT ride_bookings_one_target_check
  CHECK (num_nonnulls(route_id, adda_queue_entry_id) = 1);
CREATE INDEX IF NOT EXISTS ride_bookings_adda_queue_entry_id_idx ON ride_bookings(adda_queue_entry_id);

-- The FK 409 left dangling (vehicle_trip_offers didn't need to be in
-- scope there) — now added properly.
ALTER TABLE adda_queue_entries DROP CONSTRAINT IF EXISTS adda_queue_entries_trip_offer_id_fkey;
ALTER TABLE adda_queue_entries ADD CONSTRAINT adda_queue_entries_trip_offer_id_fkey
  FOREIGN KEY (trip_offer_id) REFERENCES vehicle_trip_offers(id);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. One place both booking targets can be read back from — confirm/
--    reject_ride_booking need origin/destination/classification/vehicle_id
--    regardless of which target the booking has, without duplicating
--    that branch in every function that touches a booking.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ride_booking_context(p_booking_id uuid)
RETURNS TABLE(origin varchar, destination varchar, classification varchar, vehicle_id uuid) AS $$
  SELECT
    COALESCE(vr.origin, a.name), COALESCE(vr.destination, ap.name),
    COALESCE(vr.classification, a.classification), COALESCE(vr.vehicle_id, aqe.vehicle_id)
  FROM ride_bookings b
  LEFT JOIN vehicle_routes vr ON vr.id = b.route_id
  LEFT JOIN adda_queue_entries aqe ON aqe.id = b.adda_queue_entry_id
  LEFT JOIN addas a ON a.id = aqe.adda_id
  LEFT JOIN addas ap ON ap.id = a.pair_adda_id
  WHERE b.id = p_booking_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. confirm_ride_booking / reject_ride_booking — same two functions,
--    now reading through ride_booking_context() instead of assuming
--    vehicle_routes. Everything else (the per_order commission voucher,
--    the monthly_lumpsum branch, notifications) is unchanged from 394.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_ride_booking(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; ctx RECORD; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO ctx FROM ride_booking_context(p_booking_id);
  SELECT * INTO v FROM vehicles WHERE id = ctx.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, ctx.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || ctx.origin || ' → ' || ctx.destination || ' ride (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE ride_bookings SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
      commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;

    PERFORM check_seller_balance_notify('vehicle', v.id);

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'ride_booking_confirmed', 'Booking confirmed',
      'Your seat booking for ' || ctx.origin || ' → ' || ctx.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' has been confirmed.', '/accounts');

    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  -- monthly_lumpsum: unchanged from 389/393.
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN b.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    ctx.origin || ' → ' || ctx.destination || ' — ' || b.seats || ' seat(s), ' || to_char(b.travel_date, 'DD Mon YYYY') || ' · paid via portal, confirmed',
    b.announced_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE ride_bookings SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_confirmed', 'Booking confirmed',
    'Your seat booking for ' || ctx.origin || ' → ' || ctx.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' has been confirmed.', '/accounts');

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION reject_ride_booking(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b ride_bookings%ROWTYPE; ctx RECORD; v vehicles%ROWTYPE; v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO ctx FROM ride_booking_context(p_booking_id);
  SELECT * INTO v FROM vehicles WHERE id = ctx.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Booking could not be confirmed',
    'Your seat booking for ' || ctx.origin || ' → ' || ctx.destination || ' could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/accounts');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Seats available + booking RPC for a fixed-fare queue entry — mirrors
--    route_seats_available()/place_ride_booking() (389/394/406), scoped
--    to one queue entry's own seats_total instead of a route+date sum.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION adda_entry_seats_available(p_entry_id uuid) RETURNS int AS $$
  SELECT e.seats_total - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.adda_queue_entry_id = p_entry_id AND rb.status IN ('announced', 'confirmed')
  ), 0)
  FROM adda_queue_entries e WHERE e.id = p_entry_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION adda_entry_seats_available(uuid) TO authenticated, anon;

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

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION book_adda_seat(uuid, int, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION book_adda_seat(uuid, int, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. adda_check_in — replaced to also spawn the vehicle_trip_offers row a
--    'request'-mode entry needs to receive fare proposals against
--    (propose_trip_fare/respond_trip_fare_offer/accept_trip_fare_counter
--    are all reused completely untouched from 400 once this exists).
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION adda_check_in(
  p_adda_id uuid, p_vehicle_id uuid, p_fare_mode varchar DEFAULT 'fixed',
  p_fixed_fare_per_seat_pkr decimal DEFAULT NULL, p_share_location_on_depart boolean DEFAULT false
) RETURNS jsonb AS $$
DECLARE
  a addas%ROWTYPE; ap addas%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_next_position int; v_entry_id uuid; v_trip_offer_id uuid; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO a FROM addas WHERE id = p_adda_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This adda is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT vehicle_bookable(p_vehicle_id) THEN
    RAISE EXCEPTION 'This vehicle''s wallet balance is too low to join the queue — top up first.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE vehicle_id = p_vehicle_id AND queue_date = v_queue_date AND status IN ('waiting', 'current')) THEN
    RAISE EXCEPTION 'This vehicle is already in a queue today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_fare_mode NOT IN ('fixed', 'request') THEN RAISE EXCEPTION 'Invalid fare mode.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_mode = 'fixed' AND (p_fixed_fare_per_seat_pkr IS NULL OR p_fixed_fare_per_seat_pkr <= 0) THEN
    RAISE EXCEPTION 'Enter the fixed fare per seat.' USING ERRCODE = 'P0001';
  END IF;
  IF p_fare_mode = 'request' AND p_fixed_fare_per_seat_pkr IS NOT NULL THEN
    RAISE EXCEPTION 'A ride-request vehicle should not set a fixed fare.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = v_queue_date AND status IN ('waiting', 'current');

  IF p_fare_mode = 'request' THEN
    SELECT * INTO ap FROM addas WHERE id = a.pair_adda_id;
    INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, seats_available, listed_fare_per_seat_pkr)
    VALUES (p_vehicle_id, a.name, a.name_ur, COALESCE(ap.name, 'destination'), ap.name_ur, a.classification, v_queue_date, v.total_seats, 0)
    RETURNING id INTO v_trip_offer_id;
  END IF;

  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, trip_offer_id, seats_total, share_location_on_depart, checked_in_by_admin)
  VALUES (p_adda_id, p_vehicle_id, v_queue_date, v_next_position, 'waiting', p_fare_mode, p_fixed_fare_per_seat_pkr, v_trip_offer_id, v.total_seats, p_share_location_on_depart,
    CASE WHEN v_is_admin AND v.portal_user_id IS DISTINCT FROM v_portal_user_id THEN current_admin_user_id() ELSE NULL END)
  RETURNING id INTO v_entry_id;

  PERFORM adda_promote_next(p_adda_id, v_queue_date);

  RETURN jsonb_build_object('entry_id', v_entry_id, 'trip_offer_id', v_trip_offer_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_check_in(uuid, uuid, varchar, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_check_in(uuid, uuid, varchar, decimal, boolean) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. adda_board — replaced to report real seats_available now that
--    bookings can actually exist against a queue entry.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION adda_board(p_adda_id uuid) RETURNS jsonb AS $$
DECLARE v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'adda', jsonb_build_object('id', a.id, 'name', a.name, 'name_ur', a.name_ur, 'lat', a.lat, 'lng', a.lng, 'turn_minutes', a.turn_minutes),
      'pair_adda', (SELECT jsonb_build_object('id', p.id, 'name', p.name, 'name_ur', p.name_ur, 'lat', p.lat, 'lng', p.lng) FROM addas p WHERE p.id = a.pair_adda_id),
      'entries', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'entry_id', e.id, 'status', e.status, 'position', e.position, 'lap', e.lap,
          'turn_started_at', e.turn_started_at, 'turn_expires_at', e.turn_expires_at,
          'seats_total', e.seats_total, 'seats_available', adda_entry_seats_available(e.id),
          'fare_mode', e.fare_mode, 'fixed_fare_per_seat_pkr', e.fixed_fare_per_seat_pkr, 'trip_offer_id', e.trip_offer_id,
          'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
        ) ORDER BY (e.status = 'current') DESC, e.position)
        FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id
        WHERE e.adda_id = a.id AND e.queue_date = v_queue_date AND e.status IN ('waiting', 'current')
      ), '[]'::jsonb)
    )
    FROM addas a WHERE a.id = p_adda_id
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION adda_board(uuid) TO authenticated, anon;
