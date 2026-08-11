-- Migration 201: a secondary role of 'viewer' must not hand someone the other
-- set of books.
--
-- ── The bug ──────────────────────────────────────────────────────────────
-- can_access_system evaluates the primary role and the secondary role and ORs
-- them. Both branches map 'viewer' to true for every system, because a primary
-- viewer is the read-only-sees-everything role. As a *secondary* role that is
-- backwards: it silently upgrades a restricted user to seeing both ledgers.
--
-- Live example: Rizwan iqbal, role = water_accountant, secondary_role = viewer.
--   can_access_system('donors_projects')
--     = (water_accountant → 'donors_projects' = 'water_supply' → false)
--       OR (viewer → true)
--     = TRUE
--
-- So every screen correctly hid nothing: the water accountant could open the
-- donor chart of accounts, donor transactions and the donor workspace, and the
-- UI was faithfully reporting what the database said he was allowed.
--
-- A secondary role exists to ADD a capability the primary one lacks. 'viewer'
-- is the weakest role in the system; the only thing it was adding here was
-- access to books the primary role deliberately excludes. It now adds nothing.
--
-- Primary 'viewer' is unchanged — read-only across both systems is what that
-- role is for.

-- ── Pulled out as a pure function so it can be tested ────────────────────
-- The old logic could only be exercised by logging in as the user, which is
-- why this went unnoticed. Taking the row's fields as arguments makes every
-- role combination checkable with a plain SELECT.
CREATE OR REPLACE FUNCTION role_grants_system(
  p_role varchar,
  p_secondary_role varchar,
  p_access_water boolean,
  p_access_donors boolean,
  p_system varchar
) RETURNS boolean AS $$
  SELECT
    -- Primary role
    (CASE p_role
      WHEN 'super_admin' THEN true
      WHEN 'admin' THEN true
      WHEN 'viewer' THEN true
      WHEN 'water_accountant' THEN p_system = 'water_supply'
      WHEN 'donor_accountant' THEN p_system = 'donors_projects'
      WHEN 'accountant' THEN (p_system = 'water_supply' AND COALESCE(p_access_water, false))
                          OR (p_system = 'donors_projects' AND COALESCE(p_access_donors, false))
      ELSE false
    END)
    OR
    -- Secondary role. Note the missing 'viewer' branch — that omission is the
    -- entire point of this migration, so it falls to ELSE false.
    (CASE p_secondary_role
      WHEN 'super_admin' THEN true
      WHEN 'admin' THEN true
      WHEN 'water_accountant' THEN p_system = 'water_supply'
      WHEN 'donor_accountant' THEN p_system = 'donors_projects'
      WHEN 'accountant' THEN (p_system = 'water_supply' AND COALESCE(p_access_water, false))
                          OR (p_system = 'donors_projects' AND COALESCE(p_access_donors, false))
      ELSE false
    END);
$$ LANGUAGE sql IMMUTABLE;

GRANT EXECUTE ON FUNCTION role_grants_system(varchar, varchar, boolean, boolean, varchar) TO authenticated;

-- can_access_system keeps its signature, its COALESCE and its SECURITY DEFINER
-- behaviour; only the decision moves into the testable function above.
CREATE OR REPLACE FUNCTION can_access_system(p_system varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT role_grants_system(role, secondary_role, access_water_supply, access_donors_projects, p_system)
       FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true
      LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ── Lets an administrator see what a given user can reach ────────────────
-- Without this, answering "why can Rizwan see the donor ledger?" means logging
-- in as Rizwan. Returns two booleans about access and nothing else.
CREATE OR REPLACE FUNCTION system_access_for(p_admin_user_id uuid)
RETURNS TABLE (full_name text, role text, secondary_role text,
               can_water boolean, can_donors boolean) AS $$
  SELECT u.full_name::text, u.role::text, u.secondary_role::text,
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, 'water_supply'),
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, 'donors_projects')
    FROM admin_users u
   WHERE u.id = p_admin_user_id
     AND EXISTS (SELECT 1 FROM admin_users a
                  WHERE a.auth_user_id = auth.uid() AND a.is_active = true
                    AND a.role IN ('super_admin', 'admin'));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION system_access_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION system_access_for(uuid) TO authenticated;
