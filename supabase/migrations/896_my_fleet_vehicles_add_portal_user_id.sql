-- Migration 896: my_fleet_vehicles needs portal_user_id so the new
-- "reassign driver" picker on the Vehicles page can show each
-- vehicle's current driver and pre-select it. RETURNS TABLE shape
-- change needs an explicit DROP first (CREATE OR REPLACE can't change
-- it), per this session's own established lesson.
DROP FUNCTION IF EXISTS my_fleet_vehicles();
CREATE OR REPLACE FUNCTION my_fleet_vehicles() RETURNS TABLE(id uuid, owner_name varchar, vehicle_type varchar, vehicle_number varchar, portal_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.owner_name, v.vehicle_type, v.vehicle_number, v.portal_user_id
  FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
  WHERE v.is_active AND (
    f.owning_portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id())
  );
$$;
REVOKE ALL ON FUNCTION my_fleet_vehicles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_vehicles() TO authenticated;
