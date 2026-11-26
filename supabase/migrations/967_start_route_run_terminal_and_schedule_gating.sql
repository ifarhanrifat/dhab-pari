-- Migration 967: real gap pointed out directly — "driver can start the
-- route any time which is wrong." Confirmed by reading start_route_run
-- (final body: 955) line by line: it checked ONLY that the caller
-- manages the vehicle and that no other run is already active —
-- nothing bound it to the route's own schedule, nothing bound it to a
-- sane time window around departure, and nothing gave the route's
-- origin terminal any say at all, even though the terminal-scoping
-- model (924/926/928) already exists and is used everywhere else a
-- counter-based action happens (boarding, no-show, closing a stop).
--
-- Four real rules, as given:
--   1. Bound to the terminal in charge — when the route's origin stop
--      has a real counter (route_origin_counter_id), only that
--      counter's own staff (or the fleet owner/admin) can start the
--      run — not the driver alone. A plain 'driver'-role fleet_staff
--      member no longer qualifies on their own merit here, same
--      exclusion pattern 940 already applied to my_managed_fleet().
--   2. Bound to date and time — a route can't be started on a day
--      it isn't scheduled (days_of_week / one_off_date), and an
--      outbound run can't be started more than 2 hours before its
--      scheduled departure_time (reusing the exact ±120min convention
--      /portal/drive's own preTripActive window already established
--      for pre-trip GPS sharing). No upper bound on LATENESS — a bus
--      that's running late still needs to be startable; blocking a
--      late start would fight the delay-detection feature this same
--      session already built.
--   3. "Rare cases where terminal doesn't exist, driver can start the
--      route" — when route_origin_counter_id is NULL (an informal/
--      village route with no real terminal), today's exact behavior
--      is kept: any fleet_staff/driver who manages the vehicle can
--      start it. Only the schedule/time gate from #2 still applies.
--   4. "Same bus must finish its outbound leg before the wapisi
--      (return) leg can start" — audited directly: ALREADY correctly
--      enforced. The existing guard `EXISTS (route_runs WHERE
--      route_id = p_route_id AND ended_at IS NULL)` blocks starting
--      ANY second run (return included) on this route_id while one is
--      still active, regardless of direction. No change needed here;
--      documented so this isn't mistaken for an open gap later.
--
-- (The 5th point — "if the bus is out of order, the terminal can shift
-- the route to another bus" — is a separate, existing mechanism
-- (route_run_substitutions / driver_request_substitute, 819/851) that
-- already permits any fleet_staff, terminal-scoped or not, to do this;
-- its real gap was a missing UI surface for terminal staff, not a
-- backend gate — addressed separately on the fleet dispatch board,
-- not in this migration.)

-- ─────────────────────────────────────────────────────────────────────
-- is_terminal_incharge_or_admin — same shape as is_my_counter_or_admin
-- (924), with the one addition this rule needs: a plain 'driver'-role
-- fleet_staff member does not count as "the terminal in charge" on
-- their own, even if their own counter_id happens to match or is
-- unscoped. Reserved for gates where the terminal itself — not just
-- any staff member — must be the one acting.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION is_terminal_incharge_or_admin(p_counter_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_counter_id IS NULL
    OR EXISTS (SELECT 1 FROM fleet_counters fc JOIN fleets f ON f.id = fc.fleet_id WHERE fc.id = p_counter_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (
      SELECT 1 FROM fleet_counters fc JOIN fleet_staff fs ON fs.fleet_id = fc.fleet_id
      WHERE fc.id = p_counter_id AND fs.portal_user_id = current_portal_user_id()
        AND fs.role NOT IN ('driver', 'accountant')
        AND (fs.counter_id IS NULL OR fs.counter_id = p_counter_id)
    );
$$;
REVOKE ALL ON FUNCTION is_terminal_incharge_or_admin(uuid) FROM PUBLIC, anon;

-- ─────────────────────────────────────────────────────────────────────
-- start_route_run (final body: 955) — true-replace. Same signature,
-- same stake/active-run/hourly-rental-conflict checks copied verbatim;
-- only the three new guards added, right after the active-run check.
-- ─────────────────────────────────────────────────────────────────────
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
GRANT EXECUTE ON FUNCTION start_route_run(uuid, varchar) TO authenticated;
