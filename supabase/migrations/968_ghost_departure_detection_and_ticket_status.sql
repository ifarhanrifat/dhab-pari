-- Migration 968: real incident reported live — a rider's ticket still
-- read "Confirmed — you're in the ride group" at the end of the day for
-- a bus whose scheduled 09:00 departure came and went with nothing ever
-- starting, and nothing — not the ticket, not a notification, not the
-- terminal — ever reflected that. (The specific booking behind the
-- report turned out to be this session's own leftover test data, not a
-- real passenger — but the gap it exposed is real and reproducible on
-- any genuine booking, so it's fixed here regardless.)
--
-- Two separate, confirmed-by-audit root causes:
--
-- 1. auto_check_route_delay (956) ONLY runs from inside
--    ping_route_location, which only ever fires once a route_run
--    already exists (`IF v_run.id IS NULL THEN RETURN`). A route whose
--    driver never taps Start never gets a run row at all, so this
--    checker — the only lateness detector in the whole system — never
--    even looks at it. route_day_delays (900) was deliberately designed
--    to be independent of route_runs for exactly this "still at the
--    terminal" case (see that migration's own header comment) — nothing
--    ever actually wrote to it before a run started.
--
-- 2. Even where a delay WAS recorded, nothing surfaced it on the one
--    screen a pre-departure rider actually has open — RideTicketSheet.
--    Its RideTicketInfo type already carried delayMinutes/delayNote/
--    delayAutoDetected (built for a different flow) but
--    FloatingBookingsHub's own ticketInfo construction never populated
--    them, and boarded_at/dropped_off_at were never passed to the
--    ticket at all — a booking that boarded and completed hours ago
--    renders identically to one still waiting for the driver to confirm
--    payment.

-- pre_departure distinguishes "the route never started today" (this
-- migration's new detector) from "a run is active but behind pace"
-- (956's existing detector) — both share the same row/notification
-- shape, but only the former should ever let a rider cancel without the
-- normal late-cancellation penalty (cancel_ride_booking below): a bus
-- that's merely running behind schedule is still coming, a bus that
-- never left by a long margin past departure is a different risk the
-- rider shouldn't have to eat.
ALTER TABLE route_day_delays ADD COLUMN IF NOT EXISTS pre_departure boolean NOT NULL DEFAULT false;
-- One-time flag so the stronger "likely not running" notification (at
-- the escalation threshold) fires once, not every 5-minute sweep.
ALTER TABLE route_day_delays ADD COLUMN IF NOT EXISTS escalated_notified_at timestamptz;

INSERT INTO site_settings (key, value, description) VALUES
  ('ghost_departure_grace_minutes', '15', 'Minutes past a route''s scheduled departure, with no run started, before the system reports it as delayed'),
  ('ghost_departure_escalation_minutes', '45', 'Minutes past scheduled departure, still with no run, before riders are offered a no-penalty cancel and a stronger alert goes to the terminal')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- The detector. Same cron-sweep idiom as run_route_proximity_alerts
-- (857) and run_stale_booking_sweep (711) — a direct scan, no session
-- context, safe because nothing financial posts here. Scoped to
-- outbound only, same reasoning start_route_run (967) already
-- documented: return has no fixed clock time to measure against (it's
-- triggered by arrival + wait window, not a schedule).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION run_ghost_departure_sweep() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_grace_min numeric; v_escalation_min numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  r record;
  v_owner_portal_user_id uuid;
  v_minutes_overdue numeric;
  v_existing route_day_delays%ROWTYPE;
BEGIN
  SELECT COALESCE(value::numeric, 15) INTO v_grace_min FROM site_settings WHERE key = 'ghost_departure_grace_minutes' LIMIT 1;
  SELECT COALESCE(value::numeric, 45) INTO v_escalation_min FROM site_settings WHERE key = 'ghost_departure_escalation_minutes' LIMIT 1;

  FOR r IN
    SELECT vr.id AS route_id, vr.vehicle_id, vr.origin, vr.destination, vr.departure_time, vr.tenant_id
    FROM vehicle_routes vr
    WHERE vr.is_active AND vr.departure_time IS NOT NULL
      AND (
        (vr.one_off_date IS NOT NULL AND vr.one_off_date = v_today)
        OR (vr.one_off_date IS NULL AND v_todow = ANY(vr.days_of_week))
      )
      -- Never started today at all — a run that already started (even
      -- if it later ended) is covered by auto_check_route_delay's own
      -- live logic, not this one; this detector only ever owns the
      -- "nothing has happened yet" window.
      AND NOT EXISTS (SELECT 1 FROM route_runs run WHERE run.route_id = vr.id AND run.started_at::date = v_today)
  LOOP
    v_minutes_overdue := extract(epoch FROM (now() - ((v_today + r.departure_time) AT TIME ZONE 'Asia/Karachi'))) / 60;
    IF v_minutes_overdue < v_grace_min THEN CONTINUE; END IF;

    SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = r.vehicle_id;
    IF v_owner_portal_user_id IS NULL THEN CONTINUE; END IF;

    SELECT * INTO v_existing FROM route_day_delays WHERE route_id = r.route_id AND travel_date = v_today AND direction = 'outbound';
    -- A human already weighed in today — never override their own report,
    -- same rule 956 already established.
    IF v_existing.id IS NOT NULL AND NOT v_existing.auto_detected THEN CONTINUE; END IF;

    IF v_existing.id IS NULL THEN
      INSERT INTO route_day_delays (route_id, travel_date, direction, delay_minutes, note, marked_by, auto_detected, pre_departure)
      VALUES (r.route_id, v_today, 'outbound', round(v_minutes_overdue)::int, 'The route has not started yet.', v_owner_portal_user_id, true, true);

      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link, tenant_id)
      SELECT DISTINCT rb.portal_user_id, 'route_delayed', 'Running late', 'تاخیر سے چل رہی ہے',
        r.origin || ' → ' || r.destination || ' has not started yet — about ' || round(v_minutes_overdue)::int || ' minutes past its scheduled departure.',
        r.origin || ' سے ' || r.destination || ' کا سفر ابھی شروع نہیں ہوا — مقررہ وقت سے تقریباً ' || round(v_minutes_overdue)::int || ' منٹ تاخیر ہو چکی ہے۔',
        '/portal/marketplace/route/' || r.route_id, r.tenant_id
      FROM ride_bookings rb WHERE rb.route_id = r.route_id AND rb.travel_date = v_today AND rb.direction = 'outbound'
        AND rb.status IN ('announced', 'confirmed');

      -- New: the owner and the route's own terminal-in-charge get told
      -- too, not just the riders — this is exactly the moment the
      -- existing "Bus won't make it — reassign" button on the Dispatch
      -- board (fleet/dispatch/page.tsx) needs a human to notice and act,
      -- and today nothing ever prompted anyone to look.
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      SELECT DISTINCT pu_id, 'route_ghost_departure', 'Route has not started',
        r.origin || ' → ' || r.destination || ' was due to depart at ' || to_char(r.departure_time, 'HH12:MI AM')
          || ' and still has no driver activity (' || round(v_minutes_overdue)::int || ' min overdue). Reassign the bus from the Dispatch board if it cannot make it.',
        '/portal/fleet/dispatch', r.tenant_id
      FROM (
        SELECT v_owner_portal_user_id AS pu_id
        UNION
        SELECT fs.portal_user_id FROM fleet_staff fs
        WHERE fs.fleet_id = (SELECT fleet_id FROM vehicles WHERE id = r.vehicle_id)
          AND fs.role NOT IN ('driver', 'accountant')
          AND (fs.counter_id IS NULL OR fs.counter_id = route_origin_counter_id(r.route_id))
      ) recipients;
    ELSIF round(v_minutes_overdue)::int != v_existing.delay_minutes THEN
      UPDATE route_day_delays SET delay_minutes = round(v_minutes_overdue)::int WHERE id = v_existing.id;

      IF v_minutes_overdue >= v_escalation_min AND v_existing.escalated_notified_at IS NULL THEN
        UPDATE route_day_delays SET escalated_notified_at = now() WHERE id = v_existing.id;

        INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link, tenant_id)
        SELECT DISTINCT rb.portal_user_id, 'route_ghost_departure_escalated', 'Your bus may not be running', 'آپ کی بس شاید نہیں چل رہی',
          r.origin || ' → ' || r.destination || ' still has not started, ' || round(v_minutes_overdue)::int || ' minutes past departure. You can cancel this booking without any late-cancellation penalty from your ticket.',
          r.origin || ' سے ' || r.destination || ' کا سفر اب تک شروع نہیں ہوا، مقررہ وقت سے ' || round(v_minutes_overdue)::int || ' منٹ تاخیر ہو چکی ہے۔ آپ اپنے ٹکٹ سے بغیر کسی تاخیری جرمانے کے یہ بکنگ منسوخ کر سکتے ہیں۔',
          '/portal/marketplace/route/' || r.route_id, r.tenant_id
        FROM ride_bookings rb WHERE rb.route_id = r.route_id AND rb.travel_date = v_today AND rb.direction = 'outbound'
          AND rb.status IN ('announced', 'confirmed');
      END IF;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION run_ghost_departure_sweep() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ghost-departure-sweep', '*/5 * * * *', $$SELECT run_ghost_departure_sweep()$$);

-- start_route_run (967) — true-replace, same body, one addition: the
-- moment a run actually starts, any pre_departure ghost row this
-- detector wrote for today is stale (the route is no longer a ghost —
-- the live GPS-based checker, auto_check_route_delay, takes over from
-- here if it's genuinely behind pace) — cleared immediately rather than
-- left to linger until the next sweep's own cleanup logic (which only
-- knows how to clear a "no run yet" condition, not a "run just
-- started" one).
CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_origin_counter_id uuid;
  v_minutes_to_departure numeric;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_route.one_off_date IS NOT NULL THEN
    IF v_route.one_off_date != v_today THEN
      RAISE EXCEPTION 'This route only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
    END IF;
  ELSIF NOT (v_todow = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route is not scheduled to run today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_direction = 'outbound' AND v_route.departure_time IS NOT NULL THEN
    v_minutes_to_departure := extract(epoch FROM (((v_today + v_route.departure_time) AT TIME ZONE 'Asia/Karachi') - now())) / 60;
    IF v_minutes_to_departure > 120 THEN
      RAISE EXCEPTION 'Too early to start — % departs at %, up to 2 hours before is allowed.',
        v_route.origin, to_char(v_route.departure_time, 'HH12:MI AM') USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_origin_counter_id := route_origin_counter_id(p_route_id);
  IF v_origin_counter_id IS NOT NULL AND NOT is_terminal_incharge_or_admin(v_origin_counter_id) THEN
    RAISE EXCEPTION 'Only this route''s origin terminal can start it — ask the terminal in charge to start the run.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM hourly_bookings WHERE vehicle_id = v_vehicle.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is currently out on an hourly rental — finish that trip before starting a scheduled run.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_bookings WHERE vehicle_id = v_vehicle.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is currently out on a rental trip — finish that trip before starting a scheduled run.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM charge_vehicle_ride_stake(v_route.vehicle_id, 'Route run started (' ||
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ')');

  INSERT INTO route_runs (route_id, direction) VALUES (p_route_id, p_direction) RETURNING id INTO v_id;

  INSERT INTO route_run_driver_shifts (route_run_id, driver_portal_user_id) VALUES (v_id, v_portal_user_id);

  INSERT INTO route_participants (route_id, portal_user_id, is_active, sharing_location)
  VALUES (p_route_id, v_portal_user_id, true, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET sharing_location = true, is_active = true;

  IF p_direction = 'outbound' THEN
    DELETE FROM route_day_delays WHERE route_id = p_route_id AND travel_date = v_today AND direction = 'outbound' AND pre_departure;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_started', 'The van is on its way',
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ' — live arrival times are now showing.',
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION start_route_run(uuid, varchar) TO authenticated;

-- cancel_ride_booking (864) — true-replace. Same body, one addition: a
-- rider cancelling a confirmed seat on a route whose outbound leg has a
-- live, auto-detected, pre-departure ghost delay past the escalation
-- threshold is never treated as a "late" cancellation (which today
-- skips the voucher reversal and stamps is_late_cancellation) — the
-- bus not showing up is the operator's failure, not the rider's, and
-- they shouldn't be billed as if they'd backed out at the last minute
-- on a trip that was actually running.
CREATE OR REPLACE FUNCTION cancel_ride_booking(p_booking_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean; v_is_fleet_manager boolean;
  v_departure timestamptz;
  v_within_cutoff boolean;
  v_late boolean := false;
  v_is_ghost boolean := false;
  v_escalation_min numeric;
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
  v_is_fleet_manager := can_manage_vehicle(r.vehicle_id);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin OR v_is_fleet_manager) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  IF b.route_id IS NOT NULL AND b.direction = 'outbound' THEN
    SELECT COALESCE(value::numeric, 45) INTO v_escalation_min FROM site_settings WHERE key = 'ghost_departure_escalation_minutes' LIMIT 1;
    SELECT true INTO v_is_ghost FROM route_day_delays
      WHERE route_id = b.route_id AND travel_date = b.travel_date AND direction = 'outbound'
        AND auto_detected AND pre_departure AND delay_minutes >= v_escalation_min
      LIMIT 1;
  END IF;

  IF v_is_rider AND NOT v_is_driver AND NOT v_is_admin AND NOT v_is_fleet_manager AND b.status = 'confirmed' AND NOT COALESCE(v_is_ghost, false) THEN
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
    cancellation_reason = COALESCE(trim(p_reason), CASE WHEN v_is_ghost THEN 'Bus never departed' ELSE NULL END), is_late_cancellation = v_late
  WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;
  DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = p_booking_id;

  IF v_is_rider AND NOT v_is_driver THEN
    IF v.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v.portal_user_id, 'ride_booking_cancelled', 'A rider cancelled',
        'A seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' was cancelled'
          || (CASE WHEN v_is_ghost THEN ' (the route never departed).' WHEN v_late THEN ' (late — inside the 2-hour cutoff).' ELSE '.' END), '/my-vehicle');
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
