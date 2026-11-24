-- Migration 954: real ask, live, 2026-11-24 — "why is this floating
-- button appearing Rawalpindi to Karachi route for driver? does it mean
-- the next duty is about to start?" vehicle_route_adda_live_status
-- (final body: 824) classifies a driver's own today-scheduled route as
-- 'route_idle' purely by "no active run right now" — the exact same
-- label shows 3 hours before an 08:00 departure, the moment 08:00 has
-- passed and the driver hasn't started the run yet, and for the rest of
-- the day after the run already ended. No time information at all.
--
-- True-replacing to add two fields the frontend can use to tell those
-- apart, without changing the 'kind' taxonomy every existing branch
-- already depends on: 'departure_at_today' (today's departure as a real
-- timestamptz, null for a route with no fixed time) and
-- 'today_run_finished' (a run for this route already started AND ended
-- earlier today). Everything else — the route_ongoing/route_action
-- classification, the adda branches, the access gate — is unchanged.

CREATE OR REPLACE FUNCTION vehicle_route_adda_live_status(p_vehicle_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(merged.row), '[]'::jsonb) FROM (
      SELECT jsonb_build_object(
        'kind', CASE WHEN run.id IS NOT NULL THEN 'route_ongoing' WHEN pending.cnt > 0 THEN 'route_action' ELSE 'route_idle' END,
        'route_id', r.id, 'origin', r.origin, 'destination', r.destination,
        'started_at', run.started_at, 'pending_count', coalesce(pending.cnt, 0),
        'departure_at_today', CASE WHEN r.departure_time IS NOT NULL THEN (v_today + r.departure_time) AT TIME ZONE 'Asia/Karachi' ELSE NULL END,
        'today_run_finished', EXISTS (
          SELECT 1 FROM route_runs rr WHERE rr.route_id = r.id AND rr.ended_at IS NOT NULL
            AND (rr.started_at AT TIME ZONE 'Asia/Karachi')::date = v_today
        )
      ) AS row
      FROM vehicle_routes r
      LEFT JOIN LATERAL (SELECT id, started_at FROM route_runs WHERE route_id = r.id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1) run ON true
      LEFT JOIN LATERAL (SELECT
        (SELECT count(*) FROM ride_bookings rb WHERE rb.route_id = r.id AND rb.travel_date = v_today AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
        + (SELECT count(*) FROM route_subscriptions rs WHERE rs.route_id = r.id AND rs.status IN ('active', 'pending_cancellation')) AS cnt
      ) pending ON true
      WHERE r.is_active
        AND (r.vehicle_id = p_vehicle_id OR EXISTS (SELECT 1 FROM route_run_substitutions s WHERE s.route_id = r.id AND s.substitute_vehicle_id = p_vehicle_id AND s.run_date = v_today AND s.status = 'active'))
        AND (v_todow = ANY(r.days_of_week) OR run.id IS NOT NULL)

      UNION ALL

      SELECT jsonb_build_object('kind', 'adda_ongoing', 'entry_id', e.id, 'adda_name', a.name, 'adda_name_ur', a.name_ur) AS row
      FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
      WHERE e.vehicle_id = p_vehicle_id AND e.queue_date = v_today AND e.status = 'departed'
        AND EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.boarded_at IS NOT NULL AND rb.dropped_off_at IS NULL)

      UNION ALL

      SELECT jsonb_build_object('kind', 'adda_action', 'entry_id', e.id, 'adda_name', a.name, 'adda_name_ur', a.name_ur,
        'pending_count', (SELECT count(*) FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)) AS row
      FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
      WHERE e.vehicle_id = p_vehicle_id AND e.queue_date = v_today AND e.status IN ('waiting', 'current')
        AND EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
    ) merged
  );
END;
$$;
GRANT EXECUTE ON FUNCTION vehicle_route_adda_live_status(uuid) TO authenticated;
