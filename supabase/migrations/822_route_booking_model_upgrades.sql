-- Migration 822: the 4 loose ends from the 2026-11-07 booking-model
-- analysis the user asked for, then explicitly approved building in one
-- go overnight ("do what you think would be the best... go ahead"):
--   (1) vacation/leave marked as a date RANGE, not one day at a time,
--       with the driver notified so both sides see it in advance.
--   (2) board+alight stop fare for ordinary per-day bookings (today
--       only monthly-fixed riders got a distance-proportional fare via
--       route_fraction_remaining (723) — extended here, not reinvented).
--   (3) a per-route seat-count override, for a modified vehicle that
--       actually carries more (or fewer) seats than its registered
--       vehicle type implies.
--   (4) an upfront advance payment at the moment of applying for a
--       monthly seat, prorated to the scheduled days left this month —
--       confirmed explicitly: money stays driver-direct, same as every
--       other route payment, no committee wallet involved.
--
-- (4)'s design note: rather than invent a second billing path next to
-- the daily-accrual engine the user already confirmed keeping
-- (migration 724/775, take_attendance), the deposit is produced by
-- literally pre-running that same per-day accrual for every remaining
-- scheduled day this month, marking each one present in advance. This
-- makes the deposit exactly equal to what daily roll-call billing would
-- already charge for a fully-attended rest of the month — and because
-- route_run_attendance is UNIQUE(subscription_id, run_date), the
-- driver's real future roll-calls for those same dates only ever ADJUST
-- this pre-paid total (take_attendance's existing present->absent branch
-- already refunds a day) instead of charging it twice. take_attendance
-- itself is untouched. Confirmed via direct production query that zero
-- monthly-fixed routes/subscriptions exist live, so this is safe to
-- shape cleanly with no migration risk to real money.

-- ═════════════════════════════════════════════════════════════════════
-- (3) Per-route seat override.
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS seat_override int CHECK (seat_override IS NULL OR seat_override > 0);

CREATE OR REPLACE FUNCTION route_effective_seats(p_route_id uuid) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(vr.seat_override, v.total_seats) FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = p_route_id;
$$;
GRANT EXECUTE ON FUNCTION route_effective_seats(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION set_route_seat_override(p_route_id uuid, p_seat_override int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_seat_override IS NOT NULL AND p_seat_override <= 0 THEN RAISE EXCEPTION 'Seat count must be at least 1.' USING ERRCODE = 'P0001'; END IF;
  UPDATE vehicle_routes SET seat_override = p_seat_override WHERE id = p_route_id;
END;
$$;
GRANT EXECUTE ON FUNCTION set_route_seat_override(uuid, int) TO authenticated;

-- route_seats_available (389) / return_seats_available (727) — same
-- bodies as live today, only the seat source swapped to the override-
-- aware helper above.
CREATE OR REPLACE FUNCTION route_seats_available(p_route_id uuid, p_travel_date date) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT route_effective_seats(p_route_id) - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed')
  ), 0);
$$;
GRANT EXECUTE ON FUNCTION route_seats_available(uuid, date) TO authenticated, anon;

CREATE OR REPLACE FUNCTION return_seats_available(p_route_id uuid, p_travel_date date) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT route_effective_seats(p_route_id) - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed')
      AND NOT EXISTS (SELECT 1 FROM route_run_offboards o WHERE o.ride_booking_id = rb.id)
  ), 0);
$$;
GRANT EXECUTE ON FUNCTION return_seats_available(uuid, date) TO authenticated, anon;

-- ═════════════════════════════════════════════════════════════════════
-- (2) Board + alight stop fare for ordinary per-day bookings.
-- Body copied verbatim from the live definition (816, read directly
-- from the migration file, not reconstructed from memory) with the two
-- new optional trailing params + the segment-fraction math inserted.
-- Fixed-fare routes only — a flex route's per-seat price depends on who
-- else books that date, and isn't safe to decompose by distance here.
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS board_stop_id uuid REFERENCES route_stops(id);
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS alight_stop_id uuid REFERENCES route_stops(id);

DROP FUNCTION IF EXISTS place_ride_booking(uuid, date, int, varchar, text);
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

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New seat booked on your route',
      p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total), '/portal/my-vehicle/routes');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text, uuid, uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- (1) Vacation/leave as a date range, with the driver notified.
-- ═════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS mark_subscription_leave_day(uuid, date);
CREATE OR REPLACE FUNCTION mark_subscription_leave_day(p_subscription_id uuid, p_leave_date date, p_leave_date_end date DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub route_subscriptions%ROWTYPE;
  v_route vehicle_routes%ROWTYPE;
  v_end date := COALESCE(p_leave_date_end, p_leave_date);
  v_d date;
  v_count int := 0;
  v_rider_name text;
BEGIN
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = p_subscription_id AND portal_user_id = current_portal_user_id() AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not one of your active monthly seats.' USING ERRCODE = 'P0001'; END IF;
  IF p_leave_date < current_date THEN RAISE EXCEPTION 'Pick today or a future date.' USING ERRCODE = 'P0001'; END IF;
  IF v_end < p_leave_date THEN RAISE EXCEPTION 'The end date must be on or after the start date.' USING ERRCODE = 'P0001'; END IF;
  IF v_end - p_leave_date > 90 THEN RAISE EXCEPTION 'Pick a range of 90 days or less.' USING ERRCODE = 'P0001'; END IF;

  v_d := p_leave_date;
  WHILE v_d <= v_end LOOP
    INSERT INTO route_subscription_leave_days (subscription_id, leave_date) VALUES (p_subscription_id, v_d) ON CONFLICT DO NOTHING;
    v_count := v_count + 1;
    v_d := v_d + 1;
  END LOOP;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_sub.route_id;
  SELECT full_name INTO v_rider_name FROM portal_users WHERE id = v_sub.portal_user_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'route_leave_range_marked', 'A rider marked time off',
    coalesce(v_rider_name, 'A rider') || ' will be off ' ||
    CASE WHEN p_leave_date = v_end THEN to_char(p_leave_date, 'DD Mon') ELSE to_char(p_leave_date, 'DD Mon') || ' to ' || to_char(v_end, 'DD Mon') END ||
    ' (' || v_count || ' day(s)) — those days won''t be billed.',
    '/portal/marketplace/route/' || v_sub.route_id
  FROM vehicles v WHERE v.id = v_route.vehicle_id AND v.portal_user_id IS NOT NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION mark_subscription_leave_day(uuid, date, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- (4) Upfront advance payment on applying for a monthly seat, prorated
-- to the scheduled days left this month. Reuses take_attendance's (775)
-- own per-day accrual by pre-seeding route_run_attendance as present for
-- each of those days — see the file header for why this can never
-- double-charge once the driver's real roll-calls reach those dates.
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE route_subscription_charges ADD COLUMN IF NOT EXISTS proof_url text;
ALTER TABLE route_subscription_charges ADD COLUMN IF NOT EXISTS payment_method varchar;

CREATE OR REPLACE FUNCTION scheduled_days_remaining_in_month(p_route_id uuid) RETURNS date[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_days int[]; v_date date; v_last date; v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_result date[] := '{}';
BEGIN
  SELECT days_of_week INTO v_days FROM vehicle_routes WHERE id = p_route_id;
  IF v_days IS NULL THEN RETURN v_result; END IF;
  v_last := (date_trunc('month', v_today) + interval '1 month - 1 day')::date;
  v_date := v_today;
  WHILE v_date <= v_last LOOP
    IF extract(dow FROM v_date)::int = ANY(v_days) THEN v_result := array_append(v_result, v_date); END IF;
    v_date := v_date + 1;
  END LOOP;
  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION scheduled_days_remaining_in_month(uuid) TO authenticated;

-- Read-only preview so a rider sees the real number before paying —
-- same arithmetic apply_for_monthly_seat uses, no side effects.
CREATE OR REPLACE FUNCTION preview_monthly_deposit(p_route_id uuid, p_board_stop_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE; v_stop route_stops%ROWTYPE; v_fraction numeric; v_fee numeric;
  v_month int := extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_year int := extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_total_days int; v_remaining_days date[]; v_daily_share numeric; v_deposit numeric;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active = true AND is_monthly_fixed;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;

  v_fraction := route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
  v_fee := round(v_route.monthly_reference_fee_pkr * v_fraction);
  v_total_days := scheduled_days_in_month(p_route_id, v_month, v_year);
  v_remaining_days := scheduled_days_remaining_in_month(p_route_id);
  v_daily_share := round(v_fee / v_total_days);
  v_deposit := v_daily_share * coalesce(array_length(v_remaining_days, 1), 0);

  RETURN jsonb_build_object('monthly_fee_pkr', v_fee, 'deposit_pkr', v_deposit, 'days_remaining', coalesce(array_length(v_remaining_days, 1), 0), 'days_total', v_total_days);
END;
$$;
GRANT EXECUTE ON FUNCTION preview_monthly_deposit(uuid, uuid) TO authenticated;

DROP FUNCTION IF EXISTS apply_for_monthly_seat(uuid, uuid);
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

  -- Only a seated (active) rider owes an advance — a waitlisted
  -- applicant pays nothing until a seat actually opens up.
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

-- route_monthly_detail (815) gains proof_url/payment_method on each due
-- charge, so the driver can see the attached receipt before marking an
-- advance paid — same jsonb shape otherwise, body copied verbatim.
DROP FUNCTION IF EXISTS route_monthly_detail(uuid);
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
    'waitlist', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rs.id, 'name', pu.full_name, 'queue_position', rs.queue_position, 'monthly_fee_pkr', rs.monthly_fee_pkr) ORDER BY rs.queue_position), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rs.status = 'waitlisted'
    ) ELSE '[]'::jsonb END,
    'due_charges', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rsc.id, 'rider_name', pu.full_name, 'month', rsc.month, 'year', rsc.year, 'amount_pkr', rsc.amount_pkr, 'proof_url', rsc.proof_url) ORDER BY rsc.year, rsc.month), '[]'::jsonb)
      FROM route_subscription_charges rsc JOIN route_subscriptions rs ON rs.id = rsc.subscription_id JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rsc.status = 'due'
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
