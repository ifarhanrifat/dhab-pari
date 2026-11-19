-- Migration 923: real gap found live, 2026-11-19 — the co-driver dropdown
-- on the Edit Schedule sheet (my_fleet_drivers) only ever showed a STATIC
-- assignment signal (which vehicle/route a driver is normally on), never
-- whether they're actually free right now. A real duty-shift system
-- already exists (driver_duty_shifts, 912 — "On duty since HH:MM" on the
-- Staff page) and license_expiry was already fetched by this same
-- function but never shown anywhere. Widening the return shape requires
-- a DROP first (true-replace discipline — this isn't just adding a
-- trailing param, it changes RETURNS TABLE itself).

DROP FUNCTION IF EXISTS my_fleet_drivers(uuid);

CREATE FUNCTION my_fleet_drivers(p_fleet_id uuid)
RETURNS TABLE(
  id uuid, portal_user_id uuid, full_name varchar, mobile varchar, license_number varchar, license_expiry date,
  routes_assigned_count bigint, primary_vehicle_number varchar, primary_route_label varchar,
  is_on_duty boolean, on_duty_vehicle_number varchar, on_duty_route_label varchar,
  license_expired boolean, license_expires_soon boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT fs.id, fs.portal_user_id, pu.full_name, pu.mobile, fs.license_number, fs.license_expiry,
    (SELECT COUNT(*) FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE v.fleet_id = p_fleet_id AND vr.co_driver_portal_user_id = fs.portal_user_id),
    pv.vehicle_number,
    pr.origin || ' → ' || pr.destination,
    ds.id IS NOT NULL,
    dv.vehicle_number,
    dr.origin || ' → ' || dr.destination,
    fs.license_expiry IS NOT NULL AND fs.license_expiry < current_date,
    fs.license_expiry IS NOT NULL AND fs.license_expiry >= current_date AND fs.license_expiry < current_date + 30
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN vehicles pv ON pv.portal_user_id = fs.portal_user_id AND pv.fleet_id = p_fleet_id
  LEFT JOIN LATERAL (
    SELECT origin, destination FROM vehicle_routes WHERE vehicle_id = pv.id AND is_active ORDER BY created_at DESC NULLS LAST LIMIT 1
  ) pr ON true
  -- The real "are they free right now" signal: an open duty shift
  -- (shift_end IS NULL) recorded anywhere in the fleet, not just on
  -- their own primary vehicle — a driver covering a substitute run is
  -- just as unavailable as one on their usual route.
  LEFT JOIN LATERAL (
    SELECT dds.vehicle_id, dds.route_id FROM driver_duty_shifts dds
    WHERE dds.fleet_staff_id = fs.id AND dds.shift_end IS NULL
    ORDER BY dds.shift_start DESC LIMIT 1
  ) ds ON true
  LEFT JOIN vehicles dv ON dv.id = ds.vehicle_id
  LEFT JOIN vehicle_routes dr ON dr.id = ds.route_id
  WHERE fs.fleet_id = p_fleet_id AND fs.role = 'driver'
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND (f.owning_portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM fleet_staff fs2 WHERE fs2.fleet_id = p_fleet_id AND fs2.portal_user_id = current_portal_user_id())))
  ORDER BY pu.full_name;
$$;
REVOKE ALL ON FUNCTION my_fleet_drivers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_drivers(uuid) TO authenticated;
