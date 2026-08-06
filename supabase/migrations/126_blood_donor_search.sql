-- Migration 126: Staff blood-donor search. blood_donors_staff_read (124)
-- lets any active staff member read blood_donors, but portal_users itself
-- is only readable by super_admin/admin (121) — a regular staff member
-- couldn't join through to get a name/phone to actually contact someone.
-- Rather than loosen portal_users' RLS broadly, expose just the columns
-- needed via a SECURITY DEFINER function, same reasoning as
-- get_field_collectors() (migration 057).

CREATE OR REPLACE FUNCTION search_blood_donors() RETURNS TABLE (
  id uuid, blood_group varchar, is_available boolean, sector varchar,
  full_name varchar, mobile varchar, whatsapp_number varchar, updated_at timestamptz
) AS $$
  SELECT b.id, b.blood_group, b.is_available, b.sector, p.full_name, p.mobile, p.whatsapp_number, b.updated_at
  FROM blood_donors b JOIN portal_users p ON p.id = b.portal_user_id
  WHERE EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
  ORDER BY b.is_available DESC, b.updated_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION search_blood_donors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_blood_donors() TO authenticated;
