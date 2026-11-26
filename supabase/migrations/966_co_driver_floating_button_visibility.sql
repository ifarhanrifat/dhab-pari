-- Migration 966: real gap found live during a full click-through test
-- of the floating button, both roles — a co-driver (vehicle_routes.
-- co_driver_portal_user_id, set via set_route_co_driver/893) or an
-- active shift-driver (route_run_driver_shifts, the mid-route handover
-- mechanism/879) sees a COMPLETELY EMPTY floating button at every
-- stage: no "ongoing" indicator while actively driving a live run, no
-- pending-request badge, nothing. Confirmed live: QA Driver Lahore One
-- is the real co-driver on the Lahore→Multan route, started and was
-- mid-run on it, and had zero floating-button items the whole time.
--
-- Root cause: FloatingBookingsHub.tsx resolves "my vehicle" with a
-- single `vehicles.portal_user_id = me` query, and the one RPC that
-- feeds its route_ongoing/route_action/route_idle items
-- (vehicle_route_adda_live_status, 954) gates on that exact same
-- ownership check. /portal/drive already solved this correctly for
-- its own "which routes do I drive" query (co_driver_portal_user_id
-- OR owned vehicle) — this never got ported to the floating button.
--
-- Fix: a new, additive RPC mirroring vehicle_route_adda_live_status's
-- own route_ongoing/route_action/route_idle shape, scoped to routes
-- the caller drives WITHOUT owning the vehicle (co-driver or an
-- active shift) — strictly additive, so an owner never sees a
-- duplicate item from both sources. vehicle_route_adda_live_status
-- itself is untouched.
CREATE OR REPLACE FUNCTION my_driven_routes_live_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int; v_uid uuid := current_portal_user_id();
BEGIN
  IF v_uid IS NULL THEN RETURN '[]'::jsonb; END IF;
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
        AND NOT EXISTS (SELECT 1 FROM vehicles ov WHERE ov.id = r.vehicle_id AND ov.portal_user_id = v_uid)
        AND (
          r.co_driver_portal_user_id = v_uid
          OR (run.id IS NOT NULL AND EXISTS (SELECT 1 FROM route_run_driver_shifts sh WHERE sh.route_run_id = run.id AND sh.ended_at IS NULL AND sh.driver_portal_user_id = v_uid))
        )
        AND (v_todow = ANY(r.days_of_week) OR run.id IS NOT NULL)
    ) merged
  );
END;
$$;
GRANT EXECUTE ON FUNCTION my_driven_routes_live_status() TO authenticated;
