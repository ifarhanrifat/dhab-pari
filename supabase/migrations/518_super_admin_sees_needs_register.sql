-- Migration 518: Super Admin can always verify/see the Needs Register.
--
-- Migration 208 deliberately made can_verify_needs its own permission, not
-- implied by admin or super_admin, on privacy grounds -- running the system
-- shouldn't automatically mean being able to read the poverty list. Real
-- ask, 2026-09-28: the committee wants it the other way -- a Super Admin
-- can see everything in the system by definition, and it's the Super
-- Admin's own call who else (if anyone) gets nominated as a verifier below
-- that. Every other role still needs can_verify_needs explicitly granted
-- (via the checkbox added on /admin/users) -- only this one function
-- changes, so every RLS policy and check built on top of it
-- (current_admin_is_needs_verifier()) picks up the new rule automatically.
CREATE OR REPLACE FUNCTION current_admin_is_needs_verifier() RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT can_verify_needs OR role = 'super_admin' OR secondary_role = 'super_admin'
       FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
