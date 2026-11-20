-- ═════════════════════════════════════════════════════════════════════
-- Bug found live testing 936: driver_blocked_from_staffed_counter used
-- `NOT is_route_owner(p_route_id)` to exempt the fleet owner from the
-- new restriction — but is_route_owner is misleadingly named. Its real
-- body (844) is `can_manage_vehicle(vehicle_id) OR active substitute`,
-- and can_manage_vehicle is true for the vehicle's OWN DRIVER too, not
-- just the literal fleet owner. So "NOT is_route_owner" was false for
-- every driver as well, and the whole restriction never actually fired
-- — confirmed live: a driver closed a stop that had dedicated staff
-- assigned, which the new check was supposed to block.
--
-- Fixed to check the literal fleet owner the same way
-- is_my_counter_or_admin's own "admin" branch already does: via
-- fleet_counters -> fleets.owning_portal_user_id, not is_route_owner.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION driver_blocked_from_staffed_counter(p_route_id uuid, p_counter_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_counter_id IS NOT NULL
    AND is_route_operator(p_route_id)
    AND NOT EXISTS (SELECT 1 FROM fleet_counters fc JOIN fleets f ON f.id = fc.fleet_id WHERE fc.id = p_counter_id AND f.owning_portal_user_id = current_portal_user_id())
    AND NOT EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.portal_user_id = current_portal_user_id() AND fs.counter_id = p_counter_id)
    AND EXISTS (SELECT 1 FROM fleet_staff fs2 WHERE fs2.counter_id = p_counter_id);
$$;
