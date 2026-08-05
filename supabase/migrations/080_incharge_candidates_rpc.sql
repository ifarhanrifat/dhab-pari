-- Migration 080: The Assign Incharge dropdown queried admin_users directly,
-- but read_admin_users RLS (migration 066) only lets admin-tier users
-- (super_admin/admin) see rows other than their own — so a water_accountant
-- running Task Todo got an empty candidate list, and a task that already had
-- an incharge assigned appeared to reopen blank (the selected id had no
-- matching <option> to render). A narrow RPC exposing just id/full_name for
-- active viewer-role users, gated on water_supply access, fixes this without
-- loosening admin_users' general read policy (which would leak every
-- non-viewer's role/permissions to non-admin-tier users).
CREATE OR REPLACE FUNCTION list_incharge_candidates() RETURNS TABLE (id uuid, full_name varchar) AS $$
  SELECT a.id, a.full_name FROM admin_users a
  WHERE a.is_active = true AND (a.role = 'viewer' OR a.secondary_role = 'viewer')
    AND can_access_system('water_supply')
  ORDER BY a.full_name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION list_incharge_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_incharge_candidates() TO authenticated;
