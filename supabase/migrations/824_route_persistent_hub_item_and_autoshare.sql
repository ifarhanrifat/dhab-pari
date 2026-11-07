-- Migration 824: real bug report, 2026-11-07 (second round of live
-- testing) — "the permanent daily rides for the driver... will disappear
-- on the driver end" once a run ends and nothing's pending.
--
-- Root cause: vehicle_route_adda_live_status (817/819) only ever
-- returned a route row for TWO conditions — a live run ('route_ongoing')
-- or unboarded bookings/active subscribers waiting ('route_action'). The
-- instant a run ends and everyone's already boarded, a route that is
-- still a real, permanent, daily service the driver needs quick access
-- to (chat, roster, tomorrow's prep) simply stops appearing in the
-- floating button at all — unlike the rider's own seat item, which
-- already persists off a plain ride_bookings row regardless of run
-- state. Replaces the two separate UNION branches (which could in
-- theory double-count the same route) with one row per route scheduled
-- today, carrying its own real state — 'route_ongoing' > 'route_action'
-- > 'route_idle' (still a scheduled, legitimate access point) — adda's
-- own two branches are untouched.

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
        'started_at', run.started_at, 'pending_count', coalesce(pending.cnt, 0)
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
