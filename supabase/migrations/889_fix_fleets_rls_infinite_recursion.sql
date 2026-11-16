-- Migration 889: HOTFIX — a genuine, previously-undiscovered production
-- bug, confirmed live via curl with a real owner's own JWT (not the
-- service-role key, which bypasses RLS and had been masking this the
-- whole session): any direct client-side SELECT against `fleets`
-- returns "infinite recursion detected in policy for relation fleets"
-- (Postgres 42P17).
--
-- Root cause: fleets_owner_read (854) checks fleet_staff membership via
-- a raw correlated subquery against fleet_staff — but fleet_staff's own
-- policies (also 854) check fleet ownership via a raw subquery against
-- fleets. Each policy's evaluation triggers the other's RLS, forever.
-- SECURITY DEFINER RPCs never hit this because such functions run as
-- their owning role, which Postgres exempts from RLS by default — that
-- exemption is exactly why my_managed_fleet() "worked" in every curl
-- test this session while the browser's own direct table query, used by
-- PortalSidebar's hasFleet check, silently failed and left the entire
-- fleet navigation group invisible. The two places in the whole
-- codebase that query `fleets` directly from a client component
-- (PortalSidebar.tsx, admin/vehicles/page.tsx) were both affected.
--
-- Fix: route the fleet_staff-membership check through a SECURITY
-- DEFINER helper instead of a raw subquery, breaking the cycle at one
-- edge (fleet_staff's own policies keep querying `fleets` directly,
-- which no longer queries `fleet_staff` back, so nothing loops).

CREATE OR REPLACE FUNCTION is_fleet_staff_of(p_fleet_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id());
$$;

DROP POLICY IF EXISTS "fleets_owner_read" ON fleets;
CREATE POLICY "fleets_owner_read" ON fleets FOR SELECT TO authenticated
  USING (
    owning_portal_user_id = current_portal_user_id()
    OR current_admin_permission('manage_parties')
    OR is_fleet_staff_of(id)
  );
