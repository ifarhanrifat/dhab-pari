-- Migration 944: real follow-up to 941/942 — "will everyone reach
-- before the bus leaves" was only ever answered with a binary checked-
-- in/not-yet flag. Audited the gap directly: route_live_locations
-- (717) and ping_route_location are NOT actually tied to an active
-- run at all — they're keyed on (route_id, portal_user_id) and gated
-- only by route_participants.sharing_location. The only thing that
-- ever stopped a driver's phone from sharing location before their run
-- started was /portal/drive's own frontend trigger
-- (`if (!chalan?.run_started_at) return`) — no backend change needed
-- to start sharing earlier, only to widen that one condition and to
-- surface the resulting position as a real distance/ETA instead of
-- nothing.
--
-- fleet_vehicle_schedule (903/941/942) — true-replace, only additive:
-- the driver's live position (if they're sharing — now possible before
-- a run starts too) plus distance to the route's own origin point
-- (vehicle_routes.origin_lat/lng, 399 — falls back to the driver's
-- home terminal's coordinates when a route has none set). ETA itself
-- is computed client-side from a flat assumed speed, same as this
-- session's other speed-less estimates (etaMinutesFor) — there's no
-- real speed signal before a run starts, so a labelled estimate is the
-- honest answer, not a fabricated precise one.
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
