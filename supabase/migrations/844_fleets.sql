-- Migration 844: real ask, 2026-11-11 — driver route-creation redesign,
-- piece 1 of 4. Minimal fleet-booker support: one account can own
-- several vehicles and manage routes for any of them, without a full
-- fleet dashboard (explicitly deferred, future dedicated task). The
-- owner must already be a normally-registered vehicle owner themselves
-- — no new account type, no non-driving-owner onboarding flow.
--
-- can_manage_vehicle() is the one new source of truth for "can this
-- portal_user act on this vehicle" (own vehicle, OR a fleet they own).
-- is_route_owner() (819) is redefined to delegate through it — this is
-- the single change that threads fleet authorization through every
-- existing route-management RPC (accept/decline seat, close route,
-- manage stops, substitute handoff, board_ride_bookings) with zero
-- per-RPC edits, since they already all gate through is_route_owner.

CREATE TABLE IF NOT EXISTS fleets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owning_portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  name varchar NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleets_owner_idx ON fleets(owning_portal_user_id);
ALTER TABLE fleets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleets_owner_read" ON fleets FOR SELECT TO authenticated
  USING (owning_portal_user_id = current_portal_user_id() OR current_admin_permission('manage_parties'));
-- Fleet creation/renaming is admin-only (assigning a vehicle to a
-- fleet, and who owns that fleet, is a committee decision, not
-- something a driver self-serves) — same gate every other
-- admin-managed table in this app already uses.
CREATE POLICY "fleets_admin_write" ON fleets FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "fleets_admin_update" ON fleets FOR UPDATE TO authenticated
  USING (current_admin_permission('manage_parties')) WITH CHECK (current_admin_permission('manage_parties'));

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fleet_id uuid REFERENCES fleets(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION can_manage_vehicle(p_vehicle_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
    WHERE v.id = p_vehicle_id AND f.owning_portal_user_id = current_portal_user_id()
  );
$$;
REVOKE ALL ON FUNCTION can_manage_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION can_manage_vehicle(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION is_route_owner(p_route_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicle_routes vr WHERE vr.id = p_route_id AND can_manage_vehicle(vr.vehicle_id)
  ) OR EXISTS (
    SELECT 1 FROM route_run_substitutions s JOIN vehicles v ON v.id = s.substitute_vehicle_id
    WHERE s.route_id = p_route_id AND s.run_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND s.status = 'active' AND v.portal_user_id = current_portal_user_id()
  );
$$;
REVOKE ALL ON FUNCTION is_route_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_route_owner(uuid) TO authenticated;

-- Lists the caller's own fleet vehicles (not their personal vehicle —
-- the route-creation vehicle-picker shows "my own vehicle" plus
-- whatever this returns). Empty for every driver who isn't a fleet
-- owner, which is everyone until an admin assigns a fleet_id.
CREATE OR REPLACE FUNCTION my_fleet_vehicles() RETURNS TABLE(id uuid, owner_name varchar, vehicle_type varchar, vehicle_number varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.owner_name, v.vehicle_type, v.vehicle_number
  FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
  WHERE f.owning_portal_user_id = current_portal_user_id() AND v.is_active;
$$;
REVOKE ALL ON FUNCTION my_fleet_vehicles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_vehicles() TO authenticated;
