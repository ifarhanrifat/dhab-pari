-- Migration 867: real reference shared live (EasyBus "Schedule" page) —
-- per-row Edit/Delete/Relaunch actions plus a date picker to view any
-- day's schedule, not just today. Investigated first: Edit (update_
-- vehicle_route_schedule) and Delete (close_vehicle_route) already
-- exist and already work on the driver-side routes page, reachable
-- from Bus Management since last round — close_vehicle_route's own
-- auth check was never widened to can_manage_vehicle() though (same
-- gap class as cancel_ride_booking/vehicle_media, found twice already
-- this session). "Relaunch" has no real equivalent anywhere: once a
-- route is closed there is no way back except re-creating it from
-- scratch (and create_vehicle_route_self's one-active-route-per-
-- vehicle guard blocks that until the old one is closed) — genuinely
-- missing, built here as reopen_vehicle_route.

-- ═════════════════════════════════════════════════════════════════════
-- 1. close_vehicle_route — widen to can_manage_vehicle(). Same
--    signature, true replace.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.close_vehicle_route(p_route_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  b RECORD;
  v_cancelled_count int := 0;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  IF NOT ((v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id) OR can_manage_vehicle(r.vehicle_id) OR COALESCE(current_admin_permission('post_transactions'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET is_active = false WHERE id = p_route_id;

  FOR b IN
    SELECT id FROM ride_bookings
    WHERE route_id = p_route_id AND status IN ('announced', 'confirmed') AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    PERFORM cancel_ride_booking(b.id, COALESCE(trim(p_reason), 'Route closed by driver'));
    v_cancelled_count := v_cancelled_count + 1;
  END LOOP;

  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = 'Route was closed by the driver before review.', reviewed_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'pending_approval';

  UPDATE commercial_ilans SET is_paused = true, ends_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'approved' AND (ends_at IS NULL OR ends_at > now());

  RETURN jsonb_build_object('route_id', p_route_id, 'bookings_cancelled', v_cancelled_count);
END;
$function$;

-- ═════════════════════════════════════════════════════════════════════
-- 2. reopen_vehicle_route — "Relaunch." Same one-active-route-per-
--    vehicle guard create_vehicle_route_self already enforces.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reopen_vehicle_route(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF r.is_active THEN RAISE EXCEPTION 'This route is already active.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = r.vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'This vehicle already has an active route — close it before relaunching another.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_routes SET is_active = true WHERE id = p_route_id;
END;
$$;
REVOKE ALL ON FUNCTION reopen_vehicle_route(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reopen_vehicle_route(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. fleet_vehicle_schedule — gains p_date (view any day, not just
--    today) and surfaces a vehicle's most-recently-closed route (with
--    is_active:false, so Relaunch has something to act on) when it has
--    no currently-active one. New trailing default param changes the
--    signature, so the old 1-arg version is dropped first.
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.fleet_vehicle_schedule(uuid);

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
      'route_id', vr.id, 'origin', vr.origin, 'destination', vr.destination, 'service_code', vr.service_code,
      'is_active', vr.is_active, 'departure_time', vr.departure_time, 'return_departure_time', vr.return_departure_time,
      'return_wait_minutes', vr.return_wait_minutes, 'is_two_way', vr.is_two_way, 'days_of_week', vr.days_of_week,
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
      'last_run_started_at', last_run.started_at, 'last_run_outbound_arrived_at', last_run.outbound_arrived_at
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
    WHERE v.fleet_id = p_fleet_id AND v.is_active
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_vehicle_schedule(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_schedule(uuid, date) TO authenticated;
