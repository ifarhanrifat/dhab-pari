-- Migration 941: real gap raised by the user while reviewing the admin
-- Fleet dashboard — "who adds drivers for the terminal where the bus
-- starts today" is already answered (Fleet Staff page: add staff,
-- role=driver, assign Home Terminal — 929/932), but the second half had
-- no answer at all: "how can admin view real-time details of all
-- vehicles' schedule today — is every driver available, will they all
-- reach before the bus leaves?"
--
-- Audited what exists: fleet_vehicle_schedule (903, surfaced on the
-- Fleet dashboard's "Today's Schedule" card) already shows a per-route
-- lifecycle state (not_started/outbound_in_progress/.../completed_today)
-- — but that state is purely "has a route_run row been created," which
-- only ever changes once a trip has ALREADY begun. There is no signal
-- at all for the window that actually matters to this question — the
-- time BEFORE departure — so an admin currently has zero visibility
-- into whether today's driver is at the terminal, running late, or
-- hasn't shown up, until the scheduled time has already passed.
--
-- The driver-attendance system (929/932: driver_check_in, a GPS-
-- geofenced check-in against the driver's own home_terminal_id) already
-- exists and is exactly the right signal — it was just never surfaced
-- anywhere the ADMIN can see it; my_driver_attendance_status is scoped
-- to "my own" status only. True real-time GPS-ETA pre-departure (e.g.
-- "driver is 4km out, will arrive in 9 minutes") is a bigger, separate
-- feature — nothing streams a driver's location before their run
-- starts today (useLiveLocation/ping_route_location only activate once
-- run_started_at is set) — deliberately NOT built here; that is a real
-- next step, not silently skipped, see the migration's own comment
-- trail for the session's scoping discussion.
--
-- fleet_vehicle_schedule (903) — true-replace, current body copied
-- verbatim, only new readiness fields added (additive jsonb keys, no
-- existing key touched, no WHERE-clause change).
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
      'current_driver_name', COALESCE(sub_v.owner_name, v.owner_name),
      'covered_by_substitute', sub.id IS NOT NULL,
      'last_run_started_at', last_run.started_at, 'last_run_outbound_arrived_at', last_run.outbound_arrived_at,
      'delay_minutes', delay.delay_minutes, 'delay_note', delay.note,
      -- 941: today's driver-readiness signal — whether the driver
      -- actually running today (the substitute if one is active, else
      -- the vehicle's own driver) has checked in at their home terminal.
      'driver_home_terminal_city', ht.city, 'driver_home_terminal_name', ht.name,
      'driver_checked_in', att.check_in_at IS NOT NULL,
      'driver_check_in_at', att.check_in_at
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
    LEFT JOIN route_run_substitutions sub ON sub.route_id = vr.id AND sub.run_date = v_today AND sub.status = 'active'
    LEFT JOIN vehicles sub_v ON sub_v.id = sub.substitute_vehicle_id
    LEFT JOIN route_day_delays delay ON delay.route_id = vr.id AND delay.travel_date = v_today
      AND delay.direction = CASE WHEN last_run.direction = 'return' THEN 'return' ELSE 'outbound' END
    LEFT JOIN LATERAL (
      SELECT fs.home_terminal_id FROM fleet_staff fs
      WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = COALESCE(sub_v.portal_user_id, v.portal_user_id)
      LIMIT 1
    ) drv_fs ON true
    LEFT JOIN fleet_counters ht ON ht.id = drv_fs.home_terminal_id
    LEFT JOIN LATERAL (
      SELECT dal.check_in_at FROM driver_attendance_log dal
      JOIN fleet_staff fs2 ON fs2.id = dal.fleet_staff_id
      WHERE fs2.fleet_id = p_fleet_id AND fs2.portal_user_id = COALESCE(sub_v.portal_user_id, v.portal_user_id)
        AND dal.check_in_at::date = v_today AND dal.check_out_at IS NULL
      ORDER BY dal.check_in_at DESC LIMIT 1
    ) att ON true
    WHERE v.fleet_id = p_fleet_id AND v.is_active
  ) rows;
  RETURN v_result;
END;
$$;
