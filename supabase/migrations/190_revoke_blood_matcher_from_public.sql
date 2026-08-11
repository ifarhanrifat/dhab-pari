-- Migration 190: close the one gap left in the blood functions' grants.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Every action
-- function in migration 189 was explicitly revoked first and then granted to
-- authenticated; eligible_blood_donors in 188 was only granted, so anon kept
-- the default.
--
-- It fails closed today — it is SECURITY DEFINER but guards itself with
-- EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid()), and
-- auth.uid() is NULL for anon, so the join yields nothing. Verified: calling
-- it with the anon key returns 0 rows. But this is the one function in the
-- feature that returns donors' names and phone numbers, and leaving it
-- callable by the public role means a single future edit to that guard is the
-- whole register. Revoke it, so the grant matches the sensitivity.
REVOKE ALL ON FUNCTION eligible_blood_donors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eligible_blood_donors(uuid) TO authenticated;

-- blood_group_counts stays open to anon on purpose: it returns eight rows of
-- integers and is what the public home page draws.
