-- Migration 975: real bug reported live — "driver did not started the
-- route yet but the another floating button says you are driving since
-- 21.8 hours". Root-caused against real data: route_runs row
-- 98e8726e-39ae-49af-9750-ff6d5bdac731 (Lahore → Multan, a 4-hour route
-- per its own route_duration_min) was started 2026-11-26 and never
-- ended — the driver never tapped "End Trip Now" (end_route_run) on
-- /portal/drive, most likely because it was left open during earlier
-- shuffle-feature testing on this QA account. With ended_at still NULL,
-- two things go wrong at once:
--
--   1. my_duty_shift_status (879) finds this ancient open run, computes
--      a nonsensical 21.8-hour "elapsed" figure, and DriverShuffleFloatingButton
--      displays "You're driving · 21.8h" even though nobody has started
--      today's route — confirmed via curl against real data.
--   2. Worse, and not yet reported but confirmed by reading the code:
--      start_route_run (967) raises "This route already has an active
--      run — end it before starting another" against ANY open run,
--      however old. The driver would be hard-blocked from starting
--      TODAY'S real route until the stale row is manually cleared.
--
-- Point #4 of 967's own comment deliberately keeps "no upper bound on
-- lateness" for how late a run can be STARTED — that's unrelated and
-- untouched here. This migration instead bounds how long a run can be
-- treated as still active without ever being explicitly ended, using
-- each route's own route_duration_min (already a real column) rather
-- than a single guessed constant — a 4-hour local route and a 24-hour
-- Karachi↔Peshawar overnight route need very different grace windows,
-- and a flat cutoff would either nag short routes or never catch long
-- ones. GREATEST(8, duration*2.5) reuses the existing min_shift_hours
-- default of 8 as the floor, and falls back to 1440min (24h, already
-- the real duration value seen on this project's own long-haul routes)
-- when a route has no route_duration_min set at all — so an unknown-
-- duration route still gets a full day of grace before being swept.

CREATE OR REPLACE FUNCTION route_run_stale_cutoff_hours(p_route_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(8, COALESCE(route_duration_min, 1440) / 60.0 * 2.5) FROM vehicle_routes WHERE id = p_route_id;
$$;
REVOKE ALL ON FUNCTION route_run_stale_cutoff_hours(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_run_stale_cutoff_hours(uuid) TO authenticated;

-- my_duty_shift_status (final body: 879) — true-replace. Only change:
-- once an open run's own elapsed time passes its route's stale cutoff,
-- report it as not active instead of returning an ever-growing,
-- meaningless elapsed-hours figure. Read-only — the actual close
-- happens in start_route_run below or the sweep, not here.
CREATE OR REPLACE FUNCTION my_duty_shift_status(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_run route_runs%ROWTYPE; v_shift route_run_driver_shifts%ROWTYPE;
  v_other_driver_id uuid; v_other_name varchar;
  v_active_driver_name varchar;
  v_elapsed_hours numeric;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_route.co_driver_portal_user_id IS NULL THEN RETURN jsonb_build_object('has_co_driver', false); END IF;
  IF v_portal_user_id NOT IN (v_vehicle.portal_user_id, v_route.co_driver_portal_user_id) THEN
    RETURN jsonb_build_object('has_co_driver', true, 'is_assigned_driver', false);
  END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_co_driver', true, 'is_assigned_driver', true, 'run_active', false);
  END IF;

  IF EXTRACT(EPOCH FROM (now() - v_run.started_at)) / 3600.0 > route_run_stale_cutoff_hours(p_route_id) THEN
    RETURN jsonb_build_object('has_co_driver', true, 'is_assigned_driver', true, 'run_active', false);
  END IF;

  SELECT * INTO v_shift FROM route_run_driver_shifts WHERE route_run_id = v_run.id AND ended_at IS NULL LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_co_driver', true, 'is_assigned_driver', true, 'run_active', true, 'can_shuffle', false);
  END IF;

  v_other_driver_id := CASE WHEN v_shift.driver_portal_user_id = v_vehicle.portal_user_id THEN v_route.co_driver_portal_user_id ELSE v_vehicle.portal_user_id END;
  SELECT full_name INTO v_other_name FROM portal_users WHERE id = v_other_driver_id;
  SELECT full_name INTO v_active_driver_name FROM portal_users WHERE id = v_shift.driver_portal_user_id;
  v_elapsed_hours := EXTRACT(EPOCH FROM (now() - v_shift.started_at)) / 3600.0;

  RETURN jsonb_build_object(
    'has_co_driver', true, 'is_assigned_driver', true, 'run_active', true,
    'route_run_id', v_run.id,
    'am_i_active_driver', v_shift.driver_portal_user_id = v_portal_user_id,
    'active_driver_name', v_active_driver_name, 'other_driver_name', v_other_name,
    'shift_started_at', v_shift.started_at, 'elapsed_hours', round(v_elapsed_hours, 1), 'min_shift_hours', v_route.min_shift_hours,
    'can_shuffle', v_shift.driver_portal_user_id = v_portal_user_id AND v_elapsed_hours >= v_route.min_shift_hours
  );
END;
$$;
REVOKE ALL ON FUNCTION my_duty_shift_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_duty_shift_status(uuid) TO authenticated;

-- start_route_run (final body: 967) — true-replace. Same signature,
-- same guards, same stake/notification logic. Only change: the
-- "already has an active run" check now first asks whether that run is
-- stale (route_run_stale_cutoff_hours) — if so, silently close it (and
-- its open shift) and proceed to start the new one, instead of
-- permanently blocking the driver because a previous day's run was
-- never explicitly ended.
CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_origin_counter_id uuid;
  v_minutes_to_departure numeric;
  v_stale_run route_runs%ROWTYPE;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_stale_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL LIMIT 1;
  IF FOUND THEN
    IF EXTRACT(EPOCH FROM (now() - v_stale_run.started_at)) / 3600.0 > route_run_stale_cutoff_hours(p_route_id) THEN
      UPDATE route_run_driver_shifts SET ended_at = now() WHERE route_run_id = v_stale_run.id AND ended_at IS NULL;
      UPDATE route_runs SET ended_at = now() WHERE id = v_stale_run.id;
    ELSE
      RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  -- Rule 2a: this route must actually be scheduled today.
  IF v_route.one_off_date IS NOT NULL THEN
    IF v_route.one_off_date != v_today THEN
      RAISE EXCEPTION 'This route only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
    END IF;
  ELSIF NOT (v_todow = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route is not scheduled to run today.' USING ERRCODE = 'P0001';
  END IF;

  -- Rule 2b: can't start an outbound run too far ahead of its own
  -- scheduled departure. Return has no fixed clock time to check
  -- against (it's triggered by arrival + wait window instead), and a
  -- route with no departure_time at all (pure on-demand) has nothing
  -- to bound against either.
  IF p_direction = 'outbound' AND v_route.departure_time IS NOT NULL THEN
    v_minutes_to_departure := extract(epoch FROM (((v_today + v_route.departure_time) AT TIME ZONE 'Asia/Karachi') - now())) / 60;
    IF v_minutes_to_departure > 120 THEN
      RAISE EXCEPTION 'Too early to start — % departs at %, up to 2 hours before is allowed.',
        v_route.origin, to_char(v_route.departure_time, 'HH12:MI AM') USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Rule 1 / 3: when this route's origin has a real terminal, only
  -- that terminal's own in-charge (or the fleet owner/admin) can start
  -- the run — a plain driver no longer can, on their own. A route with
  -- no terminal at its origin keeps today's behavior unchanged.
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

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_started', 'The van is on its way',
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ' — live arrival times are now showing.',
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION start_route_run(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_route_run(uuid, varchar) TO authenticated;

-- Background hygiene sweep for the case where the driver never tries to
-- start a new run at all (so the stale row would otherwise sit open
-- forever) — mirrors the "close run + shift" half of end_route_run
-- (880), skipping its rider-facing notifications/dropoff side effects
-- since those only make sense for a trip actually ending live, not one
-- being silently reclaimed hours or days later.
CREATE OR REPLACE FUNCTION run_stale_route_run_sweep() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r route_runs%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM route_runs WHERE ended_at IS NULL LOOP
    IF EXTRACT(EPOCH FROM (now() - r.started_at)) / 3600.0 > route_run_stale_cutoff_hours(r.route_id) THEN
      UPDATE route_run_driver_shifts SET ended_at = now() WHERE route_run_id = r.id AND ended_at IS NULL;
      UPDATE route_runs SET ended_at = now() WHERE id = r.id;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION run_stale_route_run_sweep() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('stale-route-run-sweep', '*/15 * * * *', $sql$SELECT run_stale_route_run_sweep()$sql$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — stale-route-run-sweep not scheduled: %', SQLERRM;
END $$;
