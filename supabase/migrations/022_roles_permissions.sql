-- Migration 022: New roles (admin, accountant), granular permissions, and RBAC
-- security hardening.
--
-- Adds two new roles: 'admin' (an administrative tier below super_admin — can
-- approve transactions, restore deleted records, and invite users, but can never
-- grant the super_admin role to anyone, including itself) and 'accountant' (a
-- general bookkeeper whose system access is controlled by two new flags rather
-- than being hardcoded to one system like water_accountant/donor_accountant).
--
-- Also splits the old single "manage_accounts"/"post_transactions" permissions
-- into explicit edit vs delete grants, so a super_admin can allow someone to post
-- and edit transactions without also being able to delete them.
--
-- While wiring the self-role-change guard, found a real gap: the existing
-- "self_update_admin_users" RLS policy had a USING clause but no WITH CHECK at
-- all — meaning any authenticated user updating their own admin_users row could
-- have set role='super_admin' (or flipped any permission flag) on themselves via
-- a crafted request, bypassing the UI entirely. Closed with both a WITH CHECK and
-- a BEFORE UPDATE trigger (belt-and-braces, since RLS WITH CHECK alone can't
-- compare against the OLD row to block "just don't touch your own role/perms").

-- 1. New roles
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('super_admin', 'admin', 'accountant', 'water_accountant', 'donor_accountant', 'publisher', 'viewer'));

-- 2. New granular permissions
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_edit_transactions boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_delete_transactions boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_edit_accounts boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_delete_accounts boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_restore_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_invite_users boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS access_water_supply boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS access_donors_projects boolean NOT NULL DEFAULT false;

-- 3. Helper functions rewritten for the new roles/flags. viewer is hard-blocked
--    from every write permission here regardless of any flag value that might
--    accidentally get set on their row — "read only" is a guarantee, not just a
--    default. super_admin is hard-allowed for the same reason in the other direction.
CREATE OR REPLACE FUNCTION current_admin_permission(perm varchar) RETURNS boolean AS $$
  SELECT CASE
    WHEN role = 'viewer' THEN false
    WHEN role = 'super_admin' THEN true
    ELSE (CASE perm
      WHEN 'post_transactions' THEN can_post_transactions
      WHEN 'edit_transactions' THEN can_edit_transactions
      WHEN 'delete_transactions' THEN can_delete_transactions
      WHEN 'view_reports' THEN can_view_reports
      WHEN 'approve_transactions' THEN can_approve_transactions
      WHEN 'manage_parties' THEN can_manage_parties
      WHEN 'manage_accounts' THEN can_manage_accounts
      WHEN 'edit_accounts' THEN can_edit_accounts
      WHEN 'delete_accounts' THEN can_delete_accounts
      WHEN 'restore_deleted' THEN can_restore_deleted
      WHEN 'invite_users' THEN can_invite_users
      ELSE false
    END)
  END
  FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION can_access_system(p_system varchar) RETURNS boolean AS $$
  SELECT CASE role
    WHEN 'super_admin' THEN true
    WHEN 'admin' THEN true
    WHEN 'viewer' THEN true
    WHEN 'water_accountant' THEN p_system = 'water_supply'
    WHEN 'donor_accountant' THEN p_system = 'donors_projects'
    WHEN 'accountant' THEN
      (p_system = 'water_supply' AND access_water_supply) OR
      (p_system = 'donors_projects' AND access_donors_projects)
    ELSE false
  END
  FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 4. Self-role/self-permission tamper guard + super_admin-grant restriction.
CREATE OR REPLACE FUNCTION trg_admin_users_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'super_admin' AND OLD.role IS DISTINCT FROM 'super_admin' AND current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can grant the super_admin role.';
  END IF;

  IF NEW.auth_user_id = auth.uid() AND (
    NEW.role IS DISTINCT FROM OLD.role
    OR NEW.can_post_transactions IS DISTINCT FROM OLD.can_post_transactions
    OR NEW.can_edit_transactions IS DISTINCT FROM OLD.can_edit_transactions
    OR NEW.can_delete_transactions IS DISTINCT FROM OLD.can_delete_transactions
    OR NEW.can_view_reports IS DISTINCT FROM OLD.can_view_reports
    OR NEW.can_approve_transactions IS DISTINCT FROM OLD.can_approve_transactions
    OR NEW.can_manage_parties IS DISTINCT FROM OLD.can_manage_parties
    OR NEW.can_manage_accounts IS DISTINCT FROM OLD.can_manage_accounts
    OR NEW.can_edit_accounts IS DISTINCT FROM OLD.can_edit_accounts
    OR NEW.can_delete_accounts IS DISTINCT FROM OLD.can_delete_accounts
    OR NEW.can_restore_deleted IS DISTINCT FROM OLD.can_restore_deleted
    OR NEW.can_invite_users IS DISTINCT FROM OLD.can_invite_users
    OR NEW.access_water_supply IS DISTINCT FROM OLD.access_water_supply
    OR NEW.access_donors_projects IS DISTINCT FROM OLD.access_donors_projects
  ) THEN
    RAISE EXCEPTION 'You cannot change your own role or permissions.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS admin_users_guard_trigger ON admin_users;
CREATE TRIGGER admin_users_guard_trigger BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION trg_admin_users_guard();

-- 5. admin_users RLS: allow role='admin' with can_invite_users to invite/manage
--    non-super-admin users; nobody can delete their own row (defense in depth,
--    the API route already blocks this too); the missing WITH CHECK is fixed here.
DROP POLICY IF EXISTS "self_read_admin_users" ON admin_users;
DROP POLICY IF EXISTS "self_update_admin_users" ON admin_users;
DROP POLICY IF EXISTS "super_admin_insert_admin_users" ON admin_users;
DROP POLICY IF EXISTS "super_admin_delete_admin_users" ON admin_users;

CREATE POLICY "read_admin_users" ON admin_users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR current_admin_role() IN ('super_admin', 'admin'));

CREATE POLICY "update_admin_users" ON admin_users FOR UPDATE TO authenticated
  USING (
    auth_user_id = auth.uid()
    OR current_admin_role() = 'super_admin'
    OR (current_admin_role() = 'admin' AND current_admin_permission('invite_users'))
  )
  WITH CHECK (
    role != 'super_admin' OR current_admin_role() = 'super_admin'
  );

CREATE POLICY "insert_admin_users" ON admin_users FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_role() = 'super_admin'
    OR (current_admin_role() = 'admin' AND current_admin_permission('invite_users') AND role != 'super_admin')
  );

CREATE POLICY "delete_admin_users" ON admin_users FOR DELETE TO authenticated
  USING (
    auth_user_id != auth.uid()
    AND (
      current_admin_role() = 'super_admin'
      OR (current_admin_role() = 'admin' AND current_admin_permission('invite_users') AND role != 'super_admin')
    )
  );

-- 6. Split accounts (chart of accounts) edit vs delete permission.
DROP POLICY IF EXISTS "accounts_update" ON accounts;
CREATE POLICY "accounts_update" ON accounts FOR UPDATE TO authenticated
  USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('edit_accounts'));

DROP POLICY IF EXISTS "accounts_delete" ON accounts;
CREATE POLICY "accounts_delete" ON accounts FOR DELETE TO authenticated
  USING (can_access_system(system) AND current_admin_permission('delete_accounts'));

-- 7. Split bills/payments/donors/vouchers edit vs delete permission (previously
--    all reused post_transactions for both update and delete).
DROP POLICY IF EXISTS "bills_update" ON bills;
CREATE POLICY "bills_update" ON bills FOR UPDATE TO authenticated
  USING (can_access_system('water_supply')) WITH CHECK (can_access_system('water_supply') AND current_admin_permission('edit_transactions'));

DROP POLICY IF EXISTS "bills_delete" ON bills;
CREATE POLICY "bills_delete" ON bills FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('delete_transactions'));

DROP POLICY IF EXISTS "payments_delete" ON payments;
CREATE POLICY "payments_delete" ON payments FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('delete_transactions'));

-- donors_update deliberately left on manage_parties (unchanged) — the Donors page
-- edit flow is party-management UX, not the transaction-posting flow bills/vouchers
-- go through, so it doesn't get folded into edit_transactions here.
DROP POLICY IF EXISTS "donors_delete" ON donors;
CREATE POLICY "donors_delete" ON donors FOR DELETE TO authenticated
  USING (can_access_system('donors_projects') AND current_admin_permission('delete_transactions'));

DROP POLICY IF EXISTS "vouchers_delete" ON vouchers;
CREATE POLICY "vouchers_delete" ON vouchers FOR DELETE TO authenticated
  USING (can_access_system(system) AND current_admin_permission('delete_transactions'));
