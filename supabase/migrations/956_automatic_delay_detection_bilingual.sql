-- Migration 956: real ask, live, 2026-11-25 — "how do they inform
-- passengers if the vehicle is late? should this be automatic from the
-- bus's location?" Audited directly: route_day_delays (900) is entirely
-- human-reported (set_route_day_delay) — the app already has everything
-- needed to know a bus is running behind (live GPS, the scheduled
-- departure time, the route's own distance) but nothing ever compares
-- them. This wires that comparison into the one place a driver's phone
-- already calls every ~12 seconds while sharing location
-- (ping_route_location) — no new cron job, no polling, just piggybacked
-- onto a tick that already happens live.
--
-- A second real gap found building this: ping_route_location's own
-- v_is_driver check (873) is the same vehicles.portal_user_id-is-the-
-- driver assumption 955 already fixed for check_catch_feasibility — a
-- fleet driver's own ping never recorded a route_run_path_point at all
-- (vehicles.portal_user_id is the fleet owner, not them). Fixed here too
-- since it's the exact same function this migration already has to
-- touch, using the same route_run_driver_shifts record 955 fixed the
-- seeding of.
--
-- Also: portal_notifications never had Urdu columns at all (every other
-- bilingual-content table in this schema already does — title/title_ur
-- is the established pattern, portal_notifications is the one table
-- that was missing it). Purely additive; no existing row or notification
-- type changes.

ALTER TABLE portal_notifications ADD COLUMN IF NOT EXISTS title_ur varchar;
ALTER TABLE portal_notifications ADD COLUMN IF NOT EXISTS body_ur text;

-- auto_detected distinguishes a system estimate from a human's own
-- confirmed report — the auto-checker below must never overwrite or
-- silently clear a delay staff/the driver actually typed in themselves.
ALTER TABLE route_day_delays ADD COLUMN IF NOT EXISTS auto_detected boolean NOT NULL DEFAULT false;

-- set_route_day_delay (900) — true-replace: always marks a human-entered
-- delay as auto_detected = false (so the auto-checker always backs off
-- for the rest of the day once a person has weighed in), and adds the
-- Urdu text every notification this function sends was always missing.
CREATE OR REPLACE FUNCTION set_route_day_delay(
  p_route_id uuid, p_travel_date date, p_direction varchar DEFAULT 'outbound',
  p_delay_minutes int DEFAULT NULL, p_note varchar DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vehicle_id uuid; v_route vehicle_routes%ROWTYPE; v_was_delayed boolean;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;

  v_was_delayed := EXISTS (SELECT 1 FROM route_day_delays WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction);

  IF p_delay_minutes IS NULL OR p_delay_minutes <= 0 THEN
    DELETE FROM route_day_delays WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction;
    IF v_was_delayed THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delay_cleared', 'Back on time', 'وقت پر واپس آ گئی',
        v_route.origin || ' → ' || v_route.destination || ' is running on time again.',
        v_route.origin || ' سے ' || v_route.destination || ' کا سفر دوبارہ وقت پر چل رہا ہے۔',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.direction = p_direction
        AND rb.status IN ('announced', 'confirmed');
    END IF;
  ELSE
    INSERT INTO route_day_delays (route_id, travel_date, direction, delay_minutes, note, marked_by, auto_detected)
    VALUES (p_route_id, p_travel_date, p_direction, p_delay_minutes, nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id(), false)
    ON CONFLICT (route_id, travel_date, direction) DO UPDATE SET
      delay_minutes = p_delay_minutes, note = nullif(trim(coalesce(p_note, '')), ''), marked_by = current_portal_user_id(), marked_at = now(), auto_detected = false;

    INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
    SELECT DISTINCT rb.portal_user_id, 'route_delayed', 'Running late', 'تاخیر سے چل رہی ہے',
      v_route.origin || ' → ' || v_route.destination || ' is running about ' || p_delay_minutes || ' minutes late.'
        || CASE WHEN p_note IS NOT NULL AND trim(p_note) != '' THEN ' ' || p_note ELSE '' END,
      v_route.origin || ' سے ' || v_route.destination || ' کا سفر تقریباً ' || p_delay_minutes || ' منٹ تاخیر سے چل رہا ہے۔'
        || CASE WHEN p_note IS NOT NULL AND trim(p_note) != '' THEN ' ' || p_note ELSE '' END,
      '/portal/marketplace/route/' || p_route_id
    FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.direction = p_direction
      AND rb.status IN ('announced', 'confirmed');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION set_route_day_delay(uuid, date, varchar, int, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_day_delay(uuid, date, varchar, int, varchar) TO authenticated;

-- The automatic checker. Internal (not granted to authenticated directly
-- — only ever called from inside ping_route_location below, already
-- running as the driver's own authenticated call). Compares elapsed
-- time since the run started against the route's own scheduled
-- duration, and actual progress along route_path (route_catch_
-- feasibility — the same distance-along-route math the catch feature
-- already relies on) against the progress expected by now. Direction
-- matters: fraction_remaining is always measured origin-toward-
-- destination, so an outbound run's expected fraction falls toward 0
-- while a return run's rises toward 1 — flipped here accordingly.
CREATE OR REPLACE FUNCTION auto_check_route_delay(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE;
  v_run route_runs%ROWTYPE;
  v_existing route_day_delays%ROWTYPE;
  v_driver_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric;
  v_elapsed_min numeric; v_actual_fraction numeric; v_expected_fraction numeric; v_behind_min numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  -- No scheduled duration on file means no honest way to know the
  -- expected pace — skip rather than guess.
  IF v_route.route_duration_min IS NULL OR v_route.route_duration_min <= 0 THEN RETURN; END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;
  IF v_run.id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_existing FROM route_day_delays WHERE route_id = p_route_id AND travel_date = v_today AND direction = v_run.direction;
  -- A human already weighed in for this leg today — never override or
  -- silently clear their own report.
  IF v_existing.id IS NOT NULL AND NOT v_existing.auto_detected THEN RETURN; END IF;

  SELECT sh.driver_portal_user_id INTO v_driver_portal_user_id
    FROM route_run_driver_shifts sh WHERE sh.route_run_id = v_run.id AND sh.ended_at IS NULL LIMIT 1;
  IF v_driver_portal_user_id IS NULL THEN RETURN; END IF;

  SELECT rl.lat, rl.lng INTO v_driver_lat, v_driver_lng
    FROM route_live_locations rl WHERE rl.route_id = p_route_id AND rl.portal_user_id = v_driver_portal_user_id;
  IF v_driver_lat IS NULL THEN RETURN; END IF;

  SELECT fraction_remaining INTO v_actual_fraction FROM route_catch_feasibility(p_route_id, v_driver_lat, v_driver_lng);
  IF v_actual_fraction IS NULL THEN RETURN; END IF;

  v_elapsed_min := extract(epoch FROM (now() - v_run.started_at)) / 60;
  IF v_run.direction = 'return' THEN
    v_expected_fraction := least(1, greatest(0, v_elapsed_min / v_route.route_duration_min));
    v_behind_min := (v_expected_fraction - v_actual_fraction) * v_route.route_duration_min;
  ELSE
    v_expected_fraction := least(1, greatest(0, 1 - v_elapsed_min / v_route.route_duration_min));
    v_behind_min := (v_actual_fraction - v_expected_fraction) * v_route.route_duration_min;
  END IF;

  IF v_existing.id IS NULL THEN
    -- A floor, not a hair-trigger — a stoplight or a slow start isn't
    -- "running late," and this re-evaluates every ~12 seconds the whole
    -- trip, so noise would be constant without one.
    IF v_behind_min >= 10 THEN
      INSERT INTO route_day_delays (route_id, travel_date, direction, delay_minutes, note, marked_by, auto_detected)
      VALUES (p_route_id, v_today, v_run.direction, round(v_behind_min)::int, 'Estimated automatically from the vehicle''s live location.', v_driver_portal_user_id, true);

      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delayed', 'Running late', 'تاخیر سے چل رہی ہے',
        v_route.origin || ' → ' || v_route.destination || ' is running about ' || round(v_behind_min)::int || ' minutes late (estimated from its live location).',
        v_route.origin || ' سے ' || v_route.destination || ' کا سفر تقریباً ' || round(v_behind_min)::int || ' منٹ تاخیر سے چل رہا ہے (گاڑی کی لائیو لوکیشن سے تخمینہ)۔',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = v_run.direction
        AND rb.status IN ('announced', 'confirmed');
    END IF;
  ELSE
    -- Hysteresis gap (clear below 5, only raised above 10) so this
    -- doesn't flap back and forth, and re-notify, right at one threshold.
    IF v_behind_min <= 5 THEN
      DELETE FROM route_day_delays WHERE id = v_existing.id;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delay_cleared', 'Back on time', 'وقت پر واپس آ گئی',
        v_route.origin || ' → ' || v_route.destination || ' is running on time again.',
        v_route.origin || ' سے ' || v_route.destination || ' کا سفر دوبارہ وقت پر چل رہا ہے۔',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = v_run.direction
        AND rb.status IN ('announced', 'confirmed');
    ELSIF round(v_behind_min)::int != v_existing.delay_minutes THEN
      -- Still delayed, estimate just moved — update the number silently,
      -- no fresh notification for every few-minute wobble.
      UPDATE route_day_delays SET delay_minutes = round(v_behind_min)::int WHERE id = v_existing.id;
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION auto_check_route_delay(uuid) FROM PUBLIC, anon, authenticated;

-- ping_route_location (873) — true-replace. Two fixes: (1) v_is_driver
-- used the same vehicles.portal_user_id assumption 955 already fixed
-- elsewhere — a fleet driver's own ping never recorded a path point.
-- Widened to also match the active run's real driver shift. (2) calls
-- auto_check_route_delay right after recording the point, so the delay
-- estimate rides the same live tick instead of needing its own.
CREATE OR REPLACE FUNCTION ping_route_location(p_route_id uuid, p_lat numeric, p_lng numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_sharing boolean; v_vehicle_id uuid; v_is_driver boolean; v_run_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT sharing_location INTO v_sharing FROM route_participants WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  IF v_sharing IS NOT TRUE THEN RETURN; END IF;

  INSERT INTO route_live_locations (route_id, portal_user_id, lat, lng, updated_at)
  VALUES (p_route_id, v_portal_user_id, p_lat, p_lng, now())
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET lat = p_lat, lng = p_lng, updated_at = now();

  SELECT vr.vehicle_id INTO v_vehicle_id FROM vehicle_routes vr WHERE vr.id = p_route_id;
  SELECT id INTO v_run_id FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;

  IF v_run_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM vehicles v WHERE v.id = v_vehicle_id AND v.portal_user_id = v_portal_user_id
    ) OR EXISTS (
      SELECT 1 FROM route_run_driver_shifts sh WHERE sh.route_run_id = v_run_id AND sh.ended_at IS NULL AND sh.driver_portal_user_id = v_portal_user_id
    ) INTO v_is_driver;

    IF v_is_driver THEN
      INSERT INTO route_run_path_points (route_run_id, lat, lng) VALUES (v_run_id, p_lat, p_lng);
      PERFORM auto_check_route_delay(p_route_id);
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION ping_route_location(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ping_route_location(uuid, numeric, numeric) TO authenticated;

-- fleet_vehicle_schedule (944) — true-replace, additive only: surfaces
-- auto_detected alongside the existing delay_minutes/delay_note so the
-- admin dashboard can label an estimate differently from a confirmed
-- human report.
CREATE OR REPLACE FUNCTION fleet_vehicle_schedule(p_fleet_id uuid, p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_dow int := extract(dow FROM v_today)::int;
  v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'origin'), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'vehicle_id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'total_seats', v.total_seats,
      'route_id', vr.id, 'origin', vr.origin, 'destination', vr.destination, 'service_code', vr.service_code,
      'is_active', vr.is_active, 'departure_time', vr.departure_time, 'return_departure_time', vr.return_departure_time,
      'return_wait_minutes', vr.return_wait_minutes, 'is_two_way', vr.is_two_way, 'days_of_week', vr.days_of_week,
      'return_days_of_week', vr.return_days_of_week,
      'runs_today', v_dow = ANY(vr.days_of_week),
      'state', CASE
        WHEN NOT vr.is_active THEN 'closed'
        WHEN NOT (v_dow = ANY(vr.days_of_week)) THEN 'not_scheduled_today'
        WHEN last_run.id IS NULL THEN 'not_started'
        WHEN last_run.direction = 'outbound' AND last_run.ended_at IS NULL THEN 'outbound_in_progress'
        WHEN last_run.direction = 'outbound' AND last_run.ended_at IS NOT NULL THEN 'waiting_at_destination'
        WHEN last_run.direction = 'return' AND last_run.ended_at IS NULL THEN 'return_in_progress'
        ELSE 'completed_today'
      END,
      'current_driver_name', COALESCE(eff.driver_name, v.owner_name),
      'covered_by_substitute', COALESCE(eff.via IN ('same_day_substitute', 'roster_override'), false),
      'last_run_started_at', last_run.started_at, 'last_run_outbound_arrived_at', last_run.outbound_arrived_at,
      'delay_minutes', delay.delay_minutes, 'delay_note', delay.note, 'delay_auto_detected', COALESCE(delay.auto_detected, false),
      'driver_home_terminal_city', ht.city, 'driver_home_terminal_name', ht.name,
      'driver_checked_in', att.check_in_at IS NOT NULL,
      'driver_check_in_at', att.check_in_at,
      'driver_on_leave', eff.fleet_staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM driver_leave dl WHERE dl.fleet_staff_id = eff.fleet_staff_id AND dl.leave_date = v_today),
      'driver_live_distance_km', CASE WHEN rll.lat IS NOT NULL AND COALESCE(vr.origin_lat, ht.lat) IS NOT NULL
        THEN round(haversine_km(rll.lat::numeric, rll.lng::numeric, COALESCE(vr.origin_lat, ht.lat::numeric), COALESCE(vr.origin_lng, ht.lng::numeric)), 1)
        ELSE NULL END,
      'driver_live_updated_at', rll.updated_at
    ) AS row
    FROM vehicles v
    JOIN LATERAL (
      SELECT * FROM vehicle_routes vr2 WHERE vr2.vehicle_id = v.id
      ORDER BY vr2.is_active DESC, vr2.created_at DESC NULLS LAST LIMIT 1
    ) vr ON true
    LEFT JOIN LATERAL (
      SELECT id, direction, started_at, ended_at, outbound_arrived_at
      FROM route_runs WHERE route_id = vr.id AND started_at::date = v_today
      ORDER BY started_at DESC LIMIT 1
    ) last_run ON true
    LEFT JOIN route_day_delays delay ON delay.route_id = vr.id AND delay.travel_date = v_today
      AND delay.direction = CASE WHEN last_run.direction = 'return' THEN 'return' ELSE 'outbound' END
    LEFT JOIN LATERAL effective_route_driver(vr.id, v_today) eff ON true
    LEFT JOIN fleet_counters ht ON ht.id = (SELECT home_terminal_id FROM fleet_staff WHERE id = eff.fleet_staff_id)
    LEFT JOIN LATERAL (
      SELECT dal.check_in_at FROM driver_attendance_log dal
      WHERE dal.fleet_staff_id = eff.fleet_staff_id AND dal.check_in_at::date = v_today AND dal.check_out_at IS NULL
      ORDER BY dal.check_in_at DESC LIMIT 1
    ) att ON true
    LEFT JOIN route_live_locations rll ON rll.route_id = vr.id AND rll.portal_user_id = eff.portal_user_id
    WHERE v.fleet_id = p_fleet_id AND v.is_active
  ) rows;
  RETURN v_result;
END;
$$;

-- New: the rider's own active bookings' delay status, for a persistent
-- badge on their bookings list (today it only ever showed up as a
-- one-time notification — easy to miss, nothing lasting on the ticket
-- itself afterward).
CREATE OR REPLACE FUNCTION my_route_booking_delays() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'route_id', rb.route_id, 'travel_date', rb.travel_date, 'direction', rb.direction,
    'delay_minutes', d.delay_minutes, 'delay_note', d.note, 'auto_detected', d.auto_detected
  )), '[]'::jsonb)
  FROM ride_bookings rb JOIN route_day_delays d
    ON d.route_id = rb.route_id AND d.travel_date = rb.travel_date AND d.direction = rb.direction
  WHERE rb.portal_user_id = current_portal_user_id() AND rb.status IN ('announced', 'confirmed');
$$;
REVOKE ALL ON FUNCTION my_route_booking_delays() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_route_booking_delays() TO authenticated;
