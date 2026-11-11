-- Migration 851: four real asks together.
--
-- 1. promote_next_waitlisted (831) never assigned a seat_number — a
--    promoted van-kind rider landed 'pending' with no seat at all.
--    Fixed by picking the lowest free seat number server-side (no
--    existing "pick lowest free seat" SQL precedent in this codebase —
--    every other path is caller-supplied + unique-violation catch,
--    since a human picks from a SeatPicker; promotion has no human in
--    the loop at that instant, so it has to pick one itself). Fails
--    closed (leaves the rider waitlisted) rather than ever assigning a
--    seat number beyond the vehicle's real count — "no extra seat".
--
-- 2. Substitute-vehicle seat mismatch (previously flagged, not solved):
--    route_effective_seats (822) only ever resolved seats from the
--    route's PERMANENT vehicle, with no date parameter and no
--    awareness of route_run_substitutions at all — confirmed via a
--    full audit of every call site, migrations and frontend alike.
--    route_effective_seats_for_date is the new date-aware resolver
--    (substitute's real total_seats on a day it's covering, falling
--    back to today's unchanged behavior otherwise), threaded into
--    every per-date seat-count call site: route_seats_available,
--    return_seats_available, place_ride_booking's seat-number bound,
--    book_standalone_return_seat's seat-number bound. assign_route_
--    substitute (819) also now warns the driver the moment a seat
--    mismatch exists for that day, rather than staying silent —
--    "surface it, don't auto-resolve" per the original gap note, since
--    the app can't move a real person to a different physical seat.
--    apply_for_monthly_seat deliberately untouched — a monthly seat's
--    capacity is evaluated against the route's permanent vehicle, not
--    whichever substitute happens to run on application day.
--
-- 3. book_standalone_return_seat (846) never had the one-off-date guard
--    place_ride_booking (848) already has — added, identical text and
--    placement.
--
-- 4. "Catch a departed ride" (850) excluded monthly-fixed routes
--    entirely. Real ask: apply it to all routes alike. Two real
--    correctness gaps had to close first, not just a UI toggle:
--      a) monthly-fixed routes set fare_per_seat_pkr/total_fare_pkr to
--         0 at creation (by design — billing is monthly_reference_fee_
--         pkr instead) — a catch booking on one needs its own fare
--         path, a fair single-day share of the monthly reference fee
--         (monthly_reference_fee_pkr / scheduled_days_in_month,
--         fractioned by segment exactly like every other fare), not a
--         free ride.
--      b) route_seats_available never subtracted today's actual
--         monthly riders at all (monthly capacity and ad-hoc capacity
--         were two entirely separate, never-reconciled counts) — on a
--         monthly-fixed route it would have shown every seat as "free"
--         for a catch booking even on a fully-subscribed route. Fixed
--         to also subtract today's active, not-on-leave monthly riders
--         when the route is monthly-fixed.

-- ═════════════════════════════════════════════════════════════════════
-- route_effective_seats_for_date — new. Falls back to today's
-- unchanged route_effective_seats (822) when no active substitute
-- covers this route on this date.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_effective_seats_for_date(p_route_id uuid, p_travel_date date) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT v2.total_seats FROM route_run_substitutions s JOIN vehicles v2 ON v2.id = s.substitute_vehicle_id
       WHERE s.route_id = p_route_id AND s.run_date = p_travel_date AND s.status = 'active'),
    route_effective_seats(p_route_id)
  );
$$;
REVOKE ALL ON FUNCTION route_effective_seats_for_date(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_effective_seats_for_date(uuid, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- route_seats_available — now substitute-aware (via the function
-- above) AND monthly-aware (subtracts today's actual riding monthly
-- subscribers on a monthly-fixed route, so a catch/ad-hoc booking
-- can't oversell a fully-subscribed route). Language changes sql →
-- plpgsql for the branch; same signature/return type, so every
-- existing caller is unaffected.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_seats_available(p_route_id uuid, p_travel_date date) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_seats int; v_booked int; v_monthly_riding int; v_is_monthly boolean;
BEGIN
  SELECT is_monthly_fixed INTO v_is_monthly FROM vehicle_routes WHERE id = p_route_id;
  v_seats := route_effective_seats_for_date(p_route_id, p_travel_date);

  SELECT COALESCE(SUM(rb.seats)::int, 0) INTO v_booked FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed');

  IF v_is_monthly THEN
    SELECT count(*) INTO v_monthly_riding FROM route_subscriptions rs
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending')
        AND NOT EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = p_travel_date);
  ELSE
    v_monthly_riding := 0;
  END IF;

  RETURN v_seats - v_booked - v_monthly_riding;
END;
$$;
GRANT EXECUTE ON FUNCTION route_seats_available(uuid, date) TO authenticated, anon;

CREATE OR REPLACE FUNCTION return_seats_available(p_route_id uuid, p_travel_date date) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT route_effective_seats_for_date(p_route_id, p_travel_date) - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed')
      AND NOT EXISTS (SELECT 1 FROM route_run_offboards o WHERE o.ride_booking_id = rb.id)
  ), 0);
$$;

-- ═════════════════════════════════════════════════════════════════════
-- promote_next_waitlisted — now assigns a real, free seat number on a
-- van-kind route (fails closed, leaving the rider waitlisted, if a
-- concurrent application just took the one free seat).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION promote_next_waitlisted(p_route_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_next route_subscriptions%ROWTYPE;
  v_vehicle_id uuid; v_vehicle_kind varchar; v_seats int; v_seat int;
BEGIN
  SELECT * INTO v_next FROM route_subscriptions WHERE route_id = p_route_id AND status = 'waitlisted' ORDER BY queue_position LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT vr.vehicle_id INTO v_vehicle_id FROM vehicle_routes vr WHERE vr.id = p_route_id;
  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicles v JOIN vehicle_categories vc ON vc.id = v.category_id WHERE v.id = v_vehicle_id;

  IF v_vehicle_kind = 'van' THEN
    v_seats := route_effective_seats(p_route_id);
    SELECT MIN(gs.n) INTO v_seat FROM generate_series(1, v_seats) gs(n)
      WHERE NOT EXISTS (SELECT 1 FROM route_subscriptions rs WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending') AND rs.seat_number = gs.n);
    IF v_seat IS NULL THEN RETURN; END IF; -- no seat actually free — never promote into a non-existent seat
  ELSE
    v_seat := NULL;
  END IF;

  BEGIN
    UPDATE route_subscriptions SET status = 'pending', queue_position = NULL, seat_number = v_seat WHERE id = v_next.id;
  EXCEPTION WHEN unique_violation THEN
    RETURN; -- someone else took that seat number in the same instant — leave this rider waitlisted
  END;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_next.portal_user_id, 'route_seat_promoted', 'A seat opened up — awaiting driver confirmation',
    'A monthly seat is now free. The driver must confirm before you join the ride group.', '/portal/marketplace/route/' || p_route_id);
END;
$$;
GRANT EXECUTE ON FUNCTION promote_next_waitlisted(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- assign_route_substitute — warns the driver the moment a seat
-- mismatch exists for today, instead of staying silent about it.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION assign_route_substitute(p_route_id uuid, p_substitute_vehicle_id uuid, p_reason varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE; v_original_owner_name varchar; v_substitute_portal_user_id uuid; v_original_portal_user_id uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_substitute_seats int; v_mismatched_count int;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT total_seats INTO v_substitute_seats FROM vehicles WHERE id = p_substitute_vehicle_id AND is_active;
  IF v_substitute_seats IS NULL THEN
    RAISE EXCEPTION 'Pick an active vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_substitute_vehicle_id = v_route.vehicle_id THEN RAISE EXCEPTION 'That is already this route''s own vehicle.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_run_substitutions (route_id, run_date, original_vehicle_id, substitute_vehicle_id, reason, created_by)
  VALUES (p_route_id, v_today, v_route.vehicle_id, p_substitute_vehicle_id, p_reason, current_portal_user_id())
  ON CONFLICT (route_id, run_date) DO UPDATE SET substitute_vehicle_id = excluded.substitute_vehicle_id, reason = excluded.reason, status = 'active', created_by = excluded.created_by, created_at = now();

  SELECT owner_name, portal_user_id INTO v_original_owner_name, v_original_portal_user_id FROM vehicles WHERE id = v_route.vehicle_id;
  SELECT portal_user_id INTO v_substitute_portal_user_id FROM vehicles WHERE id = p_substitute_vehicle_id;

  SELECT count(*) INTO v_mismatched_count FROM (
    SELECT seat_number FROM ride_booking_seat_numbers WHERE route_id = p_route_id AND travel_date = v_today AND seat_number > v_substitute_seats
    UNION
    SELECT seat_number FROM route_subscriptions WHERE route_id = p_route_id AND status IN ('active', 'pending') AND seat_number > v_substitute_seats
  ) x;
  IF v_mismatched_count > 0 AND v_original_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_original_portal_user_id, 'route_substitute_seat_mismatch', 'Seat mismatch with today''s substitute vehicle',
      v_mismatched_count || ' already-booked seat(s) don''t exist on today''s substitute (' || v_substitute_seats || ' seats) — contact the affected rider(s) to arrange their seat.',
      '/portal/my-vehicle/routes');
  END IF;

  IF v_substitute_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_substitute_portal_user_id, 'route_substitute_assigned', 'You''re covering a route today',
      v_route.origin || ' → ' || v_route.destination || ' for today — settle today''s fare with ' || COALESCE(v_original_owner_name, 'the regular driver') || ' directly, the app does not move this money.',
      '/portal/my-vehicle/routes');
  END IF;
  IF v_original_portal_user_id IS NOT NULL AND v_original_portal_user_id IS DISTINCT FROM v_substitute_portal_user_id THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_original_portal_user_id, 'route_substitute_assigned', 'A substitute is covering your route today',
      v_route.origin || ' → ' || v_route.destination || ' is being covered today.', '/portal/my-vehicle/routes');
  END IF;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_substitute_assigned', 'A substitute driver is covering today',
    v_route.origin || ' → ' || v_route.destination || ' will be run by a substitute vehicle today.', '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- book_standalone_return_seat — gains the one-off-date guard (identical
-- text/placement to place_ride_booking's) and the substitute-aware
-- seat-number bound.
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
  IF v_route.one_off_date IS NOT NULL AND p_travel_date != v_route.one_off_date THEN
    RAISE EXCEPTION 'This ride only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
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
GRANT EXECUTE ON FUNCTION book_standalone_return_seat(uuid, date, uuid, varchar, text, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- place_ride_booking — seat-number bound now substitute-aware; catch
-- bookings now allowed on monthly-fixed routes too, with their own
-- fair single-day fare path (see this migration's header, point 4a).
-- Signature unchanged from 850, so no DROP FUNCTION needed.
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

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

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

  IF p_board_stop_id IS NOT NULL AND (p_board_lat IS NOT NULL OR p_board_lng IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick either a board stop or a live catch point, not both.' USING ERRCODE = 'P0001';
  END IF;
  v_is_catch := p_board_lat IS NOT NULL AND p_board_lng IS NOT NULL;

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

  -- 851: a catch booking on a monthly-fixed route pays a fair single-
  -- day share of the monthly reference fee — those routes set fare_
  -- per_seat_pkr/total_fare_pkr to 0 at creation, billing is monthly_
  -- reference_fee_pkr instead, so neither existing branch below would
  -- charge anything correct for a one-off ad-hoc seat on one.
  IF v_is_catch AND v_route.is_monthly_fixed THEN
    v_total := round(p_seats * (coalesce(v_route.monthly_reference_fee_pkr, 0) /
      greatest(1, scheduled_days_in_month(p_route_id, extract(month FROM p_travel_date)::int, extract(year FROM p_travel_date)::int))) * v_segment_fraction);
  ELSIF v_route.fare_mode = 'flex' THEN
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

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id, is_mid_route_catch)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id, v_is_catch)
  RETURNING id INTO v_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_booking_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
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
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text, uuid, uuid, int[], numeric, numeric) TO authenticated;
