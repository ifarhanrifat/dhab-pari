-- Migration 014: Real multi-user auth, roles, and permission-enforcing RLS.
--
-- Until now `admin_users` was a decorative roster — no row was linked to a real
-- Supabase Auth account, and every authenticated user (there was only ever one:
-- admin@dhabpari.com) got full access to everything via blanket
-- `USING (auth.role() = 'authenticated')` policies. This migration makes
-- `admin_users` the real source of truth (linked via auth_user_id), adds granular
-- accounting permission flags, and replaces the blanket policies on every
-- accounting table with role- and system-scoped ones — enforced in the database,
-- not just hidden in the UI.

-- 1. Link admin_users to real Supabase Auth accounts + granular permissions
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_post_transactions boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_reports boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_approve_transactions boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_manage_parties boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_manage_accounts boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS invite_accepted_at timestamptz;

-- 2. Backfill the one real login that exists today as super_admin, in the SAME
--    migration as the restrictive policies below — otherwise this session (and
--    the live site) would be locked out the moment they take effect.
DO $$
DECLARE v_auth_id uuid;
BEGIN
  SELECT id INTO v_auth_id FROM auth.users WHERE email = 'admin@dhabpari.com';
  IF v_auth_id IS NOT NULL THEN
    INSERT INTO admin_users (email, full_name, role, is_active, auth_user_id,
      can_post_transactions, can_view_reports, can_approve_transactions, can_manage_parties, can_manage_accounts,
      invited_at, invite_accepted_at)
    VALUES ('admin@dhabpari.com', 'Administrator', 'super_admin', true, v_auth_id,
      true, true, true, true, true, now(), now())
    ON CONFLICT (email) DO UPDATE SET
      auth_user_id = EXCLUDED.auth_user_id,
      role = 'super_admin',
      is_active = true,
      can_post_transactions = true, can_view_reports = true, can_approve_transactions = true,
      can_manage_parties = true, can_manage_accounts = true,
      invite_accepted_at = COALESCE(admin_users.invite_accepted_at, now());
  END IF;
END $$;

-- (admin_users.email already has a UNIQUE constraint from its original migration 006
-- definition, so the ON CONFLICT (email) above already had a target — no new constraint needed.)

-- 3. Helper functions — SECURITY DEFINER so policies on other tables can call them
--    without those policies needing direct SELECT rights on admin_users, and STABLE
--    so Postgres can cache the result once per statement.
CREATE OR REPLACE FUNCTION current_admin_role() RETURNS varchar AS $$
  SELECT role FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION current_admin_permission(perm varchar) RETURNS boolean AS $$
  SELECT CASE perm
    WHEN 'post_transactions' THEN can_post_transactions
    WHEN 'view_reports' THEN can_view_reports
    WHEN 'approve_transactions' THEN can_approve_transactions
    WHEN 'manage_parties' THEN can_manage_parties
    WHEN 'manage_accounts' THEN can_manage_accounts
    ELSE false
  END
  FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- True if the current user may touch data belonging to the given system
-- ('water_supply' / 'donors_projects'). super_admin always can; the two
-- accountant roles are strictly confined to their own system only.
CREATE OR REPLACE FUNCTION can_access_system(p_system varchar) RETURNS boolean AS $$
  SELECT CASE current_admin_role()
    WHEN 'super_admin' THEN true
    WHEN 'water_accountant' THEN p_system = 'water_supply'
    WHEN 'donor_accountant' THEN p_system = 'donors_projects'
    ELSE false
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- admin_users itself: a user can always read/update their own row (needed for the
-- accept-invite flow to work before they have any other permission); only
-- super_admin can manage everyone's roles/permissions.
DROP POLICY IF EXISTS "Authenticated can manage admin_users" ON admin_users;
CREATE POLICY "self_read_admin_users" ON admin_users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR current_admin_role() = 'super_admin');
CREATE POLICY "self_update_admin_users" ON admin_users FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid() OR current_admin_role() = 'super_admin');
CREATE POLICY "super_admin_insert_admin_users" ON admin_users FOR INSERT TO authenticated
  WITH CHECK (current_admin_role() = 'super_admin');
CREATE POLICY "super_admin_delete_admin_users" ON admin_users FOR DELETE TO authenticated
  USING (current_admin_role() = 'super_admin');

-- 4. Chart of accounts + party data — scoped by system, gated by manage_accounts /
--    manage_parties permission for writes; any role with system access can read.
DROP POLICY IF EXISTS "Authenticated can manage accounts" ON accounts;
CREATE POLICY "accounts_read" ON accounts FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "accounts_write" ON accounts FOR INSERT TO authenticated
  WITH CHECK (can_access_system(system) AND current_admin_permission('manage_accounts'));
CREATE POLICY "accounts_update" ON accounts FOR UPDATE TO authenticated
  USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('manage_accounts'));
CREATE POLICY "accounts_delete" ON accounts FOR DELETE TO authenticated
  USING (can_access_system(system) AND current_admin_permission('manage_accounts'));

DROP POLICY IF EXISTS "admin_all_account_headers" ON account_headers;
CREATE POLICY "account_headers_read" ON account_headers FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "account_headers_write" ON account_headers FOR INSERT TO authenticated
  WITH CHECK (can_access_system(system) AND current_admin_permission('manage_accounts'));
CREATE POLICY "account_headers_update" ON account_headers FOR UPDATE TO authenticated
  USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('manage_accounts'));
CREATE POLICY "account_headers_delete" ON account_headers FOR DELETE TO authenticated
  USING (can_access_system(system) AND current_admin_permission('manage_accounts'));

-- Consumers/bills/payments belong to water_supply; donors belong to donors_projects.
DROP POLICY IF EXISTS "admin_all_consumers" ON consumers;
CREATE POLICY "consumers_read" ON consumers FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "consumers_write" ON consumers FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('manage_parties'));
CREATE POLICY "consumers_update" ON consumers FOR UPDATE TO authenticated
  USING (can_access_system('water_supply')) WITH CHECK (can_access_system('water_supply') AND current_admin_permission('manage_parties'));
CREATE POLICY "consumers_delete" ON consumers FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('manage_parties'));

DROP POLICY IF EXISTS "admin_all_bills" ON bills;
CREATE POLICY "bills_read" ON bills FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "bills_write" ON bills FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));
CREATE POLICY "bills_update" ON bills FOR UPDATE TO authenticated
  USING (can_access_system('water_supply')) WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));
CREATE POLICY "bills_delete" ON bills FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('post_transactions'));

DROP POLICY IF EXISTS "admin_all_payments" ON payments;
CREATE POLICY "payments_read" ON payments FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "payments_write" ON payments FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));
CREATE POLICY "payments_delete" ON payments FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('post_transactions'));

DROP POLICY IF EXISTS "admin_all_donors" ON donors;
CREATE POLICY "donors_read" ON donors FOR SELECT TO authenticated
  USING (can_access_system('donors_projects'));
CREATE POLICY "donors_write" ON donors FOR INSERT TO authenticated
  WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "donors_update" ON donors FOR UPDATE TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "donors_delete" ON donors FOR DELETE TO authenticated
  USING (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));

-- 5. Vouchers / ledger / approvals — scoped by system, gated by post/approve permission.
DROP POLICY IF EXISTS "admin_all_vouchers" ON vouchers;
CREATE POLICY "vouchers_read" ON vouchers FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "vouchers_write" ON vouchers FOR INSERT TO authenticated
  WITH CHECK (can_access_system(system) AND current_admin_permission('post_transactions'));
CREATE POLICY "vouchers_update" ON vouchers FOR UPDATE TO authenticated
  USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('approve_transactions'));
CREATE POLICY "vouchers_delete" ON vouchers FOR DELETE TO authenticated
  USING (can_access_system(system) AND current_admin_permission('post_transactions'));

DROP POLICY IF EXISTS "admin_all_voucher_approvals" ON voucher_approvals;
CREATE POLICY "voucher_approvals_read" ON voucher_approvals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vouchers v WHERE v.id = voucher_id AND can_access_system(v.system)));

DROP POLICY IF EXISTS "admin_all_ledger_entries" ON ledger_entries;
CREATE POLICY "ledger_entries_read" ON ledger_entries FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND can_access_system(a.system)));
CREATE POLICY "ledger_entries_write" ON ledger_entries FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND can_access_system(a.system) AND current_admin_permission('post_transactions')));
CREATE POLICY "ledger_entries_delete" ON ledger_entries FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND can_access_system(a.system) AND current_admin_permission('post_transactions')));

-- 6. Trigger/helper functions perform automatic bookkeeping side-effects (auto-creating
--    a consumer's or donor's shadow account, posting ledger entries) that are a
--    consequence of an already-authorized primary action (creating a bill/payment/
--    donation/voucher — each gated by its own policy above) but touch a DIFFERENT
--    table under a DIFFERENT permission (e.g. recording a donation only requires
--    manage_parties, but the ledger posting it triggers would otherwise need
--    post_transactions too). Mark them SECURITY DEFINER so these controlled,
--    fixed-logic side effects can complete regardless of which specific permission
--    the calling user holds — the primary action's own policy is what actually
--    authorizes the operation. SET search_path pinned to prevent search_path
--    hijacking (the classic SECURITY DEFINER vulnerability class).
ALTER FUNCTION ensure_consumer_account(varchar) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION ensure_donor_account(varchar, varchar) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_bill_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_payment_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_donor_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_voucher_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_voucher_after_approval() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_bill_delete_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_payment_delete_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_donor_delete_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_voucher_delete_ledger() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION trg_voucher_before_insert() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION next_account_code(uuid) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION next_voucher_no(varchar, varchar) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION next_receipt_no() SECURITY DEFINER SET search_path = public;
