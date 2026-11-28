-- Migration 982: real gap caught finishing 980 — a fleet owner self-
-- adding a tractor via the newly-widened create_fleet_vehicle_direct has
-- no way to actually set its per-service rates afterward.
-- tractor_services (646) has always been write-gated to
-- current_admin_permission('manage_parties') only — fine while every
-- machine was admin-added (the admin form could set services in the
-- same sitting), but now that an owner can add a tractor himself with
-- no committee step at all, a self-added tractor would sit with zero
-- services and could never actually be booked (create_equipment_booking
-- for kind='tractor' requires a matching tractor_services row to even
-- resolve a rate). Same fleet-parity pattern 852 already established
-- for every other equipment RPC — widened here to the RLS policies
-- directly, since tractor_services has always been written to straight
-- from the client (no RPC), not through a SECURITY DEFINER function.

DROP POLICY IF EXISTS "tractor_services_write" ON tractor_services;
CREATE POLICY "tractor_services_write" ON tractor_services FOR INSERT TO authenticated
  WITH CHECK ((can_access_system('donors_projects') AND current_admin_permission('manage_parties')) OR can_manage_vehicle(vehicle_id));

DROP POLICY IF EXISTS "tractor_services_update" ON tractor_services;
CREATE POLICY "tractor_services_update" ON tractor_services FOR UPDATE TO authenticated
  USING (can_access_system('donors_projects') OR can_manage_vehicle(vehicle_id))
  WITH CHECK ((can_access_system('donors_projects') AND current_admin_permission('manage_parties')) OR can_manage_vehicle(vehicle_id));

DROP POLICY IF EXISTS "tractor_services_delete" ON tractor_services;
CREATE POLICY "tractor_services_delete" ON tractor_services FOR DELETE TO authenticated
  USING ((can_access_system('donors_projects') AND current_admin_permission('manage_parties')) OR can_manage_vehicle(vehicle_id));
