-- Migration 942: real ask — "who adjusts drivers for a route, and if a
-- driver goes on leave, reassign against the already-booked schedule so
-- every driver has a clear day-wise job calendar telling them when and
-- where their next job is, so they always reach on time." Audited what
-- exists first: vehicles.portal_user_id is one permanent driver per
-- vehicle forever; vehicle_routes.co_driver_portal_user_id is one
-- permanent co-driver for same-run mid-route hand-off (879);
-- route_run_substitutions (819) swaps the whole VEHICLE for TODAY only,
-- same-day, reactive ("driver is sick right now"); driver_duty_shifts
-- (912) is a PAST-tense log of who actually drove, admin-recorded after
-- the fact. None of these let an owner plan AHEAD — there was no way to
-- say "driver X is on leave Nov 25-28, driver Y covers their routes
-- those days" before it happens, and no driver-facing forward calendar
-- at all.
--
-- This explicitly reverses fleet/drivers/page.tsx's own standing
-- comment ("no allotment/dispatch write action here... not to add a
-- second one") the same way migration 879 explicitly reversed an
-- earlier "don't touch driver shuffle" instruction — a direct, specific
-- user ask after reviewing exactly this boundary. This is NOT a second
-- version of the same thing: route_run_substitutions stays for
-- same-day emergencies; this is the planned, forward-looking layer,
-- and effective_route_driver() below makes same-day substitutions win
-- over a stale plan, so the two compose instead of fighting.
--
-- Design: route_day_assignments holds only CHANGES from the default
-- (one row per route per day it's been explicitly reassigned, or
-- explicitly marked "needs cover" with a NULL driver) — an owner never
-- has to pre-fill a whole month for routes that aren't changing.
-- driver_leave is one row per calendar day per driver (not a date
-- range row), so "is X on leave on date D" and "which of my routes
-- have a leave conflict" are both plain EXISTS/JOIN checks, no overlap
-- math. effective_route_driver() is the single place "who's actually
-- driving route R on date D" gets resolved, reused by
-- fleet_vehicle_schedule (so the dashboard/dispatch board/readiness
-- pills from 941 all inherit it automatically) and by a new RPC so a
-- driver who's been assigned someone else's route for a day can
-- actually see it in their own /portal/drive app that day.

CREATE TABLE IF NOT EXISTS driver_leave (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  leave_date date NOT NULL,
  reason text,
  created_by uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (fleet_staff_id, leave_date)
);
CREATE INDEX IF NOT EXISTS driver_leave_date_idx ON driver_leave(leave_date);
ALTER TABLE driver_leave ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_leave_read" ON driver_leave FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.id = fleet_staff_id AND fs.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.id = fleet_staff_id AND EXISTS (SELECT 1 FROM fleet_staff me WHERE me.fleet_id = fs.fleet_id AND me.portal_user_id = current_portal_user_id()))
  );
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE TABLE IF NOT EXISTS route_day_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  assignment_date date NOT NULL,
  fleet_staff_id uuid REFERENCES fleet_staff(id) ON DELETE SET NULL, -- NULL = explicitly "needs cover"
  note text,
  created_by uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (route_id, assignment_date)
);
CREATE INDEX IF NOT EXISTS route_day_assignments_date_idx ON route_day_assignments(assignment_date);
ALTER TABLE route_day_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_day_assignments_read" ON route_day_assignments FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = route_id AND can_manage_vehicle(vr.vehicle_id))
    OR (fleet_staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.id = fleet_staff_id AND fs.portal_user_id = current_portal_user_id()))
  );
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

-- ═════════════════════════════════════════════════════════════════════
-- The single source of truth for "who is actually driving route R on
-- date D" — same-day emergency substitute (819) wins if one exists
-- for today, else the planned roster override, else the vehicle's own
-- permanent driver.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION effective_route_driver(p_route_id uuid, p_date date)
RETURNS TABLE(fleet_staff_id uuid, portal_user_id uuid, driver_name varchar, via varchar)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vehicle_id uuid; v_fleet_id uuid; v_default_portal_user_id uuid;
  v_sub_vehicle_id uuid; v_override route_day_assignments%ROWTYPE; v_has_override boolean;
BEGIN
  SELECT vr.vehicle_id INTO v_vehicle_id FROM vehicle_routes vr WHERE vr.id = p_route_id;
  SELECT v.fleet_id, v.portal_user_id INTO v_fleet_id, v_default_portal_user_id FROM vehicles v WHERE v.id = v_vehicle_id;

  IF p_date = (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    SELECT s.substitute_vehicle_id INTO v_sub_vehicle_id
    FROM route_run_substitutions s WHERE s.route_id = p_route_id AND s.run_date = p_date AND s.status = 'active';
    IF v_sub_vehicle_id IS NOT NULL THEN
      RETURN QUERY
        SELECT fs.id, sv.portal_user_id, pu.full_name, 'same_day_substitute'::varchar
        FROM vehicles sv
        LEFT JOIN fleet_staff fs ON fs.portal_user_id = sv.portal_user_id AND fs.fleet_id = v_fleet_id
        LEFT JOIN portal_users pu ON pu.id = sv.portal_user_id
        WHERE sv.id = v_sub_vehicle_id;
      RETURN;
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM route_day_assignments a WHERE a.route_id = p_route_id AND a.assignment_date = p_date) INTO v_has_override;
  IF v_has_override THEN
    SELECT * INTO v_override FROM route_day_assignments a WHERE a.route_id = p_route_id AND a.assignment_date = p_date;
    IF v_override.fleet_staff_id IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::varchar, 'needs_cover'::varchar;
    ELSE
      RETURN QUERY
        SELECT fs.id, fs.portal_user_id, pu.full_name, 'roster_override'::varchar
        FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id WHERE fs.id = v_override.fleet_staff_id;
    END IF;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT fs.id, fs.portal_user_id, pu.full_name, 'default'::varchar
    FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
    WHERE fs.portal_user_id = v_default_portal_user_id AND fs.fleet_id = v_fleet_id
    LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, v_default_portal_user_id, pu.full_name, 'default_unregistered'::varchar
      FROM portal_users pu WHERE pu.id = v_default_portal_user_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION effective_route_driver(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION effective_route_driver(uuid, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Leave — owner-only (same gate as set_staff_home_terminal/
-- set_fleet_staff_role — staff HR actions are owner-gated throughout
-- this codebase). One row per day via generate_series; capped at 60
-- days so this can't be used to silently insert years of rows.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_driver_leave(p_fleet_id uuid, p_fleet_staff_id uuid, p_date_from date, p_date_to date, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_staff WHERE id = p_fleet_staff_id AND fleet_id = p_fleet_id AND role = 'driver') THEN
    RAISE EXCEPTION 'That staff member is not a driver on this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_date_to < p_date_from THEN RAISE EXCEPTION 'The leave end date must be on or after the start date.' USING ERRCODE = 'P0001'; END IF;
  IF p_date_to - p_date_from > 60 THEN RAISE EXCEPTION 'Leave can be set at most 60 days at a time.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO driver_leave (fleet_staff_id, leave_date, reason, created_by)
  SELECT p_fleet_staff_id, d::date, nullif(trim(coalesce(p_reason, '')), ''), current_portal_user_id()
  FROM generate_series(p_date_from, p_date_to, interval '1 day') d
  ON CONFLICT (fleet_staff_id, leave_date) DO UPDATE SET reason = excluded.reason;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT fs.portal_user_id, 'driver_leave_set', 'Leave recorded',
    'You are marked on leave ' || to_char(p_date_from, 'DD Mon') || CASE WHEN p_date_to > p_date_from THEN ' – ' || to_char(p_date_to, 'DD Mon') ELSE '' END || '.',
    '/portal/drive'
  FROM fleet_staff fs WHERE fs.id = p_fleet_staff_id;
END;
$$;
REVOKE ALL ON FUNCTION set_driver_leave(uuid, uuid, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_driver_leave(uuid, uuid, date, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION clear_driver_leave(p_fleet_staff_id uuid, p_date_from date, p_date_to date DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid;
BEGIN
  SELECT fleet_id INTO v_fleet_id FROM fleet_staff WHERE id = p_fleet_staff_id;
  IF v_fleet_id IS NULL OR NOT EXISTS (SELECT 1 FROM fleets WHERE id = v_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM driver_leave WHERE fleet_staff_id = p_fleet_staff_id AND leave_date BETWEEN p_date_from AND COALESCE(p_date_to, p_date_from);
END;
$$;
REVOKE ALL ON FUNCTION clear_driver_leave(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_driver_leave(uuid, date, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Per-route, per-day reassignment — gated like record_duty_shift
-- (can_administer_vehicle: owner or non-driver staff, never a driver
-- assigning themselves/others).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_route_day_driver(p_route_id uuid, p_date date, p_fleet_staff_id uuid, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_vehicle_id uuid; v_fleet_id uuid; v_driver_portal_user_id uuid;
BEGIN
  SELECT vehicle_id INTO v_vehicle_id FROM vehicle_routes WHERE id = p_route_id;
  IF v_vehicle_id IS NULL THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  SELECT fleet_id INTO v_fleet_id FROM vehicles WHERE id = v_vehicle_id;

  IF p_fleet_staff_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM fleet_staff WHERE id = p_fleet_staff_id AND fleet_id = v_fleet_id AND role = 'driver') THEN
      RAISE EXCEPTION 'That staff member is not a driver on this fleet.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO route_day_assignments (route_id, assignment_date, fleet_staff_id, note, created_by)
  VALUES (p_route_id, p_date, p_fleet_staff_id, nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id())
  ON CONFLICT (route_id, assignment_date) DO UPDATE SET fleet_staff_id = excluded.fleet_staff_id, note = excluded.note, created_by = excluded.created_by, created_at = now();

  IF p_fleet_staff_id IS NOT NULL THEN
    SELECT portal_user_id INTO v_driver_portal_user_id FROM fleet_staff WHERE id = p_fleet_staff_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v_driver_portal_user_id, 'route_day_assigned', 'New job on your calendar',
      vr.origin || ' → ' || vr.destination || ' on ' || to_char(p_date, 'DD Mon') || '.', '/portal/drive'
    FROM vehicle_routes vr WHERE vr.id = p_route_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION set_route_day_driver(uuid, date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_day_driver(uuid, date, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION clear_route_day_override(p_route_id uuid, p_date date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_vehicle_id uuid;
BEGIN
  SELECT vehicle_id INTO v_vehicle_id FROM vehicle_routes WHERE id = p_route_id;
  IF v_vehicle_id IS NULL OR NOT can_administer_vehicle(v_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  DELETE FROM route_day_assignments WHERE route_id = p_route_id AND assignment_date = p_date;
END;
$$;
REVOKE ALL ON FUNCTION clear_route_day_override(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_route_day_override(uuid, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Admin roster view — every active route scheduled to run on each day
-- in range, with its effective driver and a leave-conflict flag so the
-- owner can see exactly where a reassignment is actually needed.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_route_roster(p_fleet_id uuid, p_date_from date, p_date_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_date_to - p_date_from > 60 THEN RAISE EXCEPTION 'Pick a range of at most 60 days.' USING ERRCODE = 'P0001'; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'route_id', vr.id, 'origin', vr.origin, 'destination', vr.destination, 'departure_time', vr.departure_time,
      'vehicle_number', v.vehicle_number, 'vehicle_type', v.vehicle_type,
      'the_date', d::date,
      'driver_fleet_staff_id', eff.fleet_staff_id, 'driver_name', eff.driver_name, 'via', eff.via,
      'is_override', EXISTS (SELECT 1 FROM route_day_assignments a WHERE a.route_id = vr.id AND a.assignment_date = d::date),
      'override_note', (SELECT note FROM route_day_assignments a WHERE a.route_id = vr.id AND a.assignment_date = d::date),
      'driver_on_leave', eff.fleet_staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM driver_leave dl WHERE dl.fleet_staff_id = eff.fleet_staff_id AND dl.leave_date = d::date)
    ) ORDER BY d, vr.departure_time)
    FROM vehicle_routes vr
    JOIN vehicles v ON v.id = vr.vehicle_id
    CROSS JOIN generate_series(p_date_from, p_date_to, interval '1 day') d
    LEFT JOIN LATERAL effective_route_driver(vr.id, d::date) eff ON true
    WHERE v.fleet_id = p_fleet_id AND vr.is_active AND v.is_active
      AND extract(dow FROM d)::int = ANY(vr.days_of_week)
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION fleet_route_roster(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_route_roster(uuid, date, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Driver-facing job calendar — "when and where is my next job," across
-- every fleet this driver belongs to, merging their own default routes,
-- same-day substitute cover, and roster-planned cover of someone
-- else's route — plus their own leave days, clearly marked as off.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION my_driver_job_calendar(p_date_from date, p_date_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF p_date_to - p_date_from > 60 THEN RAISE EXCEPTION 'Pick a range of at most 60 days.' USING ERRCODE = 'P0001'; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'route_id', vr.id, 'origin', vr.origin, 'destination', vr.destination, 'departure_time', vr.departure_time,
      'vehicle_number', v.vehicle_number, 'vehicle_type', v.vehicle_type, 'the_date', d::date, 'via', eff.via
    ) ORDER BY d, vr.departure_time)
    FROM vehicle_routes vr
    JOIN vehicles v ON v.id = vr.vehicle_id
    CROSS JOIN generate_series(p_date_from, p_date_to, interval '1 day') d
    CROSS JOIN LATERAL effective_route_driver(vr.id, d::date) eff
    WHERE vr.is_active AND v.is_active AND extract(dow FROM d)::int = ANY(vr.days_of_week)
      AND eff.portal_user_id = v_portal_user_id
  ), '[]'::jsonb) || jsonb_build_object('leave_dates', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('the_date', dl.leave_date, 'reason', dl.reason) ORDER BY dl.leave_date), '[]'::jsonb)
    FROM driver_leave dl JOIN fleet_staff fs ON fs.id = dl.fleet_staff_id
    WHERE fs.portal_user_id = v_portal_user_id AND dl.leave_date BETWEEN p_date_from AND p_date_to
  ));
END;
$$;
REVOKE ALL ON FUNCTION my_driver_job_calendar(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_driver_job_calendar(date, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- fleet_vehicle_schedule (903/941) — true-replace. "Every system that
-- allots a driver to a route talks to the job calendar": swaps the old
-- inline route_run_substitutions-only join and the 941 attendance
-- lookup (keyed directly to sub_v.portal_user_id/v.portal_user_id) for
-- effective_route_driver(), so a roster-planned reassignment (not just
-- a same-day vehicle swap) is reflected in current_driver_name,
-- covered_by_substitute, and the check-in readiness pill alike.
-- ═════════════════════════════════════════════════════════════════════
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
      'delay_minutes', delay.delay_minutes, 'delay_note', delay.note,
      'driver_home_terminal_city', ht.city, 'driver_home_terminal_name', ht.name,
      'driver_checked_in', att.check_in_at IS NOT NULL,
      'driver_check_in_at', att.check_in_at,
      'driver_on_leave', eff.fleet_staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM driver_leave dl WHERE dl.fleet_staff_id = eff.fleet_staff_id AND dl.leave_date = v_today)
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
    WHERE v.fleet_id = p_fleet_id AND v.is_active
  ) rows;
  RETURN v_result;
END;
$$;
