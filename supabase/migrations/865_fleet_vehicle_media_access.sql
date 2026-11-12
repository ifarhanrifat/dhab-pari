-- Migration 865: found while building the "Bus Management" page (fleet
-- owner/staff editing a vehicle's catalog settings for any vehicle in
-- the fleet, not just one they personally drive) — vehicle_media's own
-- write/update/delete RLS (474) checks v.portal_user_id directly, same
-- gap class as 864's cancel_ride_booking/reschedule_ride_booking. A
-- fleet owner/staff reaching catalog/page.tsx for a vehicle they don't
-- personally drive could open the page but every photo action would
-- silently fail. One added can_manage_vehicle() branch on each policy.
DROP POLICY IF EXISTS "vehicle_media_write" ON vehicle_media;
CREATE POLICY "vehicle_media_write" ON vehicle_media FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()) OR can_manage_vehicle(vehicle_id));
DROP POLICY IF EXISTS "vehicle_media_update" ON vehicle_media;
CREATE POLICY "vehicle_media_update" ON vehicle_media FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()) OR can_manage_vehicle(vehicle_id));
DROP POLICY IF EXISTS "vehicle_media_delete" ON vehicle_media;
CREATE POLICY "vehicle_media_delete" ON vehicle_media FOR DELETE TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()) OR can_manage_vehicle(vehicle_id));

-- ═════════════════════════════════════════════════════════════════════
-- Dashboard restyle: fleet_vehicle_schedule (860) gains service_code so
-- each schedule card can show it as a badge, same signature, true
-- replace (no new param, just one more field in the jsonb payload).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_vehicle_schedule(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_dow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
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
      'departure_time', vr.departure_time, 'return_departure_time', vr.return_departure_time,
      'return_wait_minutes', vr.return_wait_minutes, 'is_two_way', vr.is_two_way,
      'runs_today', v_dow = ANY(vr.days_of_week),
      'state', CASE
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
    JOIN vehicle_routes vr ON vr.vehicle_id = v.id AND vr.is_active
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
REVOKE ALL ON FUNCTION fleet_vehicle_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_schedule(uuid) TO authenticated;
