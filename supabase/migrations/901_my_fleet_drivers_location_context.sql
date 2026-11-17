-- Migration 901: real complaint — "how to know which driver is where
-- from this window during selecting driver?" The co-driver dropdown
-- (my_fleet_drivers, 890) only ever showed a bare routes_assigned_
-- count (how many routes list them as CO-driver) — no indication of
-- which vehicle a driver actually primarily drives or what route
-- that vehicle is currently running. Widened with their primary
-- vehicle's registration number and current route, so the picker can
-- show e.g. "Ahmed · QA-BUS-02 · Peshawar → Karachi" instead of just
-- a name and a count. RETURNS TABLE shape change, explicit DROP
-- first per this session's established rule.
DROP FUNCTION IF EXISTS my_fleet_drivers(uuid);
CREATE OR REPLACE FUNCTION my_fleet_drivers(p_fleet_id uuid)
RETURNS TABLE(
  id uuid, portal_user_id uuid, full_name varchar, mobile varchar, license_number varchar, license_expiry date,
  routes_assigned_count bigint, primary_vehicle_number varchar, primary_route_label varchar
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT fs.id, fs.portal_user_id, pu.full_name, pu.mobile, fs.license_number, fs.license_expiry,
    (SELECT COUNT(*) FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE v.fleet_id = p_fleet_id AND vr.co_driver_portal_user_id = fs.portal_user_id),
    pv.vehicle_number,
    pr.origin || ' → ' || pr.destination
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN vehicles pv ON pv.portal_user_id = fs.portal_user_id AND pv.fleet_id = p_fleet_id
  LEFT JOIN LATERAL (
    SELECT origin, destination FROM vehicle_routes WHERE vehicle_id = pv.id AND is_active ORDER BY created_at DESC NULLS LAST LIMIT 1
  ) pr ON true
  WHERE fs.fleet_id = p_fleet_id AND fs.role = 'driver'
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND (f.owning_portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM fleet_staff fs2 WHERE fs2.fleet_id = p_fleet_id AND fs2.portal_user_id = current_portal_user_id())))
  ORDER BY pu.full_name;
$$;
REVOKE ALL ON FUNCTION my_fleet_drivers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_drivers(uuid) TO authenticated;
