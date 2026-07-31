-- Migration 066: A user can now hold two roles at once (e.g. water_accountant
-- + a "management" secondary role), per explicit request. This is deliberately
-- scoped to exactly TWO roles (a `secondary_role` column), not an open-ended
-- N-role system — a full many-to-many redesign would mean rewriting every RLS
-- policy in the app from scratch, for a request that only ever asked for two.
--
-- The two functions almost everything in this app already funnels through —
-- can_access_system() and current_admin_permission() — are rewritten here to
-- consider both role and secondary_role. Because virtually every table's RLS
-- policy (bills, payments, vouchers, accounts, consumers, donors, complaints,
-- approvals, inventory...) calls one of these two rather than checking
-- current_admin_role() directly, this single change makes secondary_role work
-- correctly across the entire app's data access with no further edits needed
-- there. The remaining ~10 places that specifically gate "who can configure
-- system settings" (current_admin_role() = 'super_admin' / IN ('super_admin',
-- 'admin')) are enumerated and updated individually below — found via
-- `grep -rn "current_admin_role()"` across every migration to make sure none
-- were missed.
--
-- New helper functions bake COALESCE(..., false) into their own definition
-- (per the lesson recorded after finding the same fail-open bug four times
-- this session) so every caller is automatically safe, not just the ones that
-- remember to wrap it.

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS secondary_role varchar
  CHECK (secondary_role IS NULL OR secondary_role IN ('super_admin', 'admin', 'accountant', 'water_accountant', 'donor_accountant', 'publisher', 'viewer'));

CREATE OR REPLACE FUNCTION current_admin_has_role(p_role varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT role = p_role OR secondary_role = p_role FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION current_admin_is_super_admin() RETURNS boolean AS $$
  SELECT current_admin_has_role('super_admin');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION current_admin_is_admin_tier() RETURNS boolean AS $$
  SELECT current_admin_is_super_admin() OR current_admin_has_role('admin');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 1. The two universal gates — rewritten to OR the primary and secondary
-- role's access together. A user with role='water_accountant' and
-- secondary_role='donor_accountant' can now access both books; nothing about
-- an existing single-role user's behavior changes (their secondary_role is
-- NULL, so the second CASE always falls through to ELSE false).
CREATE OR REPLACE FUNCTION can_access_system(p_system varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT
      (CASE role
        WHEN 'super_admin' THEN true
        WHEN 'admin' THEN true
        WHEN 'viewer' THEN true
        WHEN 'water_accountant' THEN p_system = 'water_supply'
        WHEN 'donor_accountant' THEN p_system = 'donors_projects'
        WHEN 'accountant' THEN (p_system = 'water_supply' AND access_water_supply) OR (p_system = 'donors_projects' AND access_donors_projects)
        ELSE false
      END)
      OR
      (CASE secondary_role
        WHEN 'super_admin' THEN true
        WHEN 'admin' THEN true
        WHEN 'viewer' THEN true
        WHEN 'water_accountant' THEN p_system = 'water_supply'
        WHEN 'donor_accountant' THEN p_system = 'donors_projects'
        WHEN 'accountant' THEN (p_system = 'water_supply' AND access_water_supply) OR (p_system = 'donors_projects' AND access_donors_projects)
        ELSE false
      END)
     FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- current_admin_permission: viewer's hard read-only guarantee now only holds
-- when BOTH slots are viewer-or-empty — a viewer with a real secondary role
-- (e.g. 'admin') falls through to the normal per-user boolean flags instead of
-- being unconditionally blocked. Note this does NOT auto-grant those flags —
-- the administrator still has to check them individually (same as today for
-- 'admin'/'accountant' roles); it only removes the hard block that would
-- otherwise override them.
CREATE OR REPLACE FUNCTION current_admin_permission(perm varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT CASE
      WHEN role = 'super_admin' OR secondary_role = 'super_admin' THEN true
      WHEN role = 'viewer' AND (secondary_role IS NULL OR secondary_role = 'viewer') THEN false
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
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Per-row version (used to decide notification recipients, not the caller's
-- own access) gets the same secondary_role OR-treatment.
CREATE OR REPLACE FUNCTION admin_user_can_access_system(p_admin_user_id uuid, p_system varchar) RETURNS boolean AS $$
  SELECT
    (CASE role
      WHEN 'super_admin' THEN true WHEN 'admin' THEN true WHEN 'viewer' THEN true
      WHEN 'water_accountant' THEN p_system = 'water_supply'
      WHEN 'donor_accountant' THEN p_system = 'donors_projects'
      WHEN 'accountant' THEN (p_system = 'water_supply' AND access_water_supply) OR (p_system = 'donors_projects' AND access_donors_projects)
      ELSE false END)
    OR
    (CASE secondary_role
      WHEN 'super_admin' THEN true WHEN 'admin' THEN true WHEN 'viewer' THEN true
      WHEN 'water_accountant' THEN p_system = 'water_supply'
      WHEN 'donor_accountant' THEN p_system = 'donors_projects'
      WHEN 'accountant' THEN (p_system = 'water_supply' AND access_water_supply) OR (p_system = 'donors_projects' AND access_donors_projects)
      ELSE false END)
  FROM admin_users WHERE id = p_admin_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 2. Self-tamper guard: cover secondary_role in both the super_admin-grant
-- check and the "can't touch your own role/permissions" column list.
CREATE OR REPLACE FUNCTION trg_admin_users_guard() RETURNS trigger AS $$
DECLARE
  v_had_super_admin boolean := (OLD.role = 'super_admin' OR OLD.secondary_role = 'super_admin');
  v_has_super_admin boolean := (NEW.role = 'super_admin' OR NEW.secondary_role = 'super_admin');
BEGIN
  IF v_has_super_admin AND NOT v_had_super_admin AND NOT current_admin_is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can grant the super_admin role.';
  END IF;

  IF NEW.auth_user_id = auth.uid() AND (
    NEW.role IS DISTINCT FROM OLD.role
    OR NEW.secondary_role IS DISTINCT FROM OLD.secondary_role
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
    OR NEW.can_collect_payments IS DISTINCT FROM OLD.can_collect_payments
    OR NEW.assigned_sectors IS DISTINCT FROM OLD.assigned_sectors
    OR NEW.can_verify_complaints IS DISTINCT FROM OLD.can_verify_complaints
  ) THEN
    RAISE EXCEPTION 'You cannot change your own role or permissions.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. admin_users' own RLS — re-created with the multi-role-aware helpers, and
-- the super_admin-grant WITH CHECK extended to cover secondary_role too (a
-- non-super-admin with invite_users still can't sneak someone super_admin
-- access through the second slot).
DROP POLICY IF EXISTS "read_admin_users" ON admin_users;
CREATE POLICY "read_admin_users" ON admin_users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR current_admin_is_admin_tier());

DROP POLICY IF EXISTS "update_admin_users" ON admin_users;
CREATE POLICY "update_admin_users" ON admin_users FOR UPDATE TO authenticated
  USING (
    auth_user_id = auth.uid()
    OR current_admin_is_super_admin()
    OR (current_admin_has_role('admin') AND current_admin_permission('invite_users'))
  )
  WITH CHECK (
    (role != 'super_admin' AND secondary_role IS DISTINCT FROM 'super_admin') OR current_admin_is_super_admin()
  );

DROP POLICY IF EXISTS "insert_admin_users" ON admin_users;
CREATE POLICY "insert_admin_users" ON admin_users FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_is_super_admin()
    OR (current_admin_has_role('admin') AND current_admin_permission('invite_users') AND role != 'super_admin' AND secondary_role IS DISTINCT FROM 'super_admin')
  );

DROP POLICY IF EXISTS "delete_admin_users" ON admin_users;
CREATE POLICY "delete_admin_users" ON admin_users FOR DELETE TO authenticated
  USING (
    auth_user_id != auth.uid()
    AND (
      current_admin_is_super_admin()
      OR (current_admin_has_role('admin') AND current_admin_permission('invite_users') AND role != 'super_admin' AND secondary_role IS DISTINCT FROM 'super_admin')
    )
  );

-- 4. Every other place that gated on "super_admin or admin" directly.
DROP POLICY IF EXISTS "read_audit_log" ON audit_log;
CREATE POLICY "read_audit_log" ON audit_log FOR SELECT TO authenticated
  USING (current_admin_is_admin_tier());

DROP POLICY IF EXISTS "notification_preferences_write" ON notification_preferences;
CREATE POLICY "notification_preferences_write" ON notification_preferences FOR UPDATE TO authenticated
  USING (current_admin_is_admin_tier())
  WITH CHECK (current_admin_is_admin_tier());

DROP POLICY IF EXISTS "approval_approvers_write" ON approval_approvers;
CREATE POLICY "approval_approvers_write" ON approval_approvers FOR ALL TO authenticated
  USING (current_admin_is_admin_tier())
  WITH CHECK (current_admin_is_admin_tier());

DROP POLICY IF EXISTS "approval_type_settings_write" ON approval_type_settings;
CREATE POLICY "approval_type_settings_write" ON approval_type_settings FOR UPDATE TO authenticated
  USING (current_admin_is_admin_tier())
  WITH CHECK (current_admin_is_admin_tier());

DROP POLICY IF EXISTS "complaint_handlers_write" ON complaint_handlers;
CREATE POLICY "complaint_handlers_write" ON complaint_handlers FOR ALL TO authenticated
  USING (current_admin_is_admin_tier())
  WITH CHECK (current_admin_is_admin_tier());

CREATE OR REPLACE FUNCTION restore_deleted_record(p_audit_id uuid) RETURNS void AS $$
DECLARE
  v_row audit_log%ROWTYPE;
BEGIN
  IF NOT (current_admin_is_super_admin() OR (current_admin_has_role('admin') AND current_admin_permission('restore_deleted'))) THEN
    RAISE EXCEPTION 'You do not have permission to restore deleted records';
  END IF;

  SELECT * INTO v_row FROM audit_log WHERE id = p_audit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit log entry not found';
  END IF;
  IF v_row.action != 'delete' THEN
    RAISE EXCEPTION 'Only deleted records can be restored';
  END IF;
  IF v_row.restored_at IS NOT NULL THEN
    RAISE EXCEPTION 'This record has already been restored';
  END IF;

  IF v_row.table_name = 'bills' THEN
    INSERT INTO bills SELECT * FROM jsonb_populate_record(null::bills, v_row.record_data);
  ELSIF v_row.table_name = 'payments' THEN
    INSERT INTO payments SELECT * FROM jsonb_populate_record(null::payments, v_row.record_data);
  ELSIF v_row.table_name = 'donors' THEN
    INSERT INTO donors SELECT * FROM jsonb_populate_record(null::donors, v_row.record_data);
  ELSIF v_row.table_name = 'vouchers' THEN
    INSERT INTO vouchers SELECT * FROM jsonb_populate_record(null::vouchers, v_row.record_data);
    INSERT INTO voucher_approvals SELECT * FROM jsonb_populate_recordset(null::voucher_approvals, COALESCE(v_row.related_data->'voucher_approvals', '[]'::jsonb));
  ELSIF v_row.table_name = 'accounts' THEN
    INSERT INTO accounts SELECT * FROM jsonb_populate_record(null::accounts, v_row.record_data);
  ELSIF v_row.table_name = 'consumers' THEN
    INSERT INTO consumers SELECT * FROM jsonb_populate_record(null::consumers, v_row.record_data);
  END IF;

  UPDATE audit_log SET restored_at = now(), restored_by = current_admin_user_id() WHERE id = p_audit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION override_approve_confirmation(p_confirmation_id uuid) RETURNS void AS $$
DECLARE
  v_confirmation approval_confirmations%ROWTYPE;
BEGIN
  IF NOT current_admin_is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can approve on behalf of another approver.';
  END IF;
  SELECT * INTO v_confirmation FROM approval_confirmations WHERE id = p_confirmation_id;
  IF v_confirmation.id IS NULL THEN
    RAISE EXCEPTION 'Confirmation not found.';
  END IF;
  IF v_confirmation.confirmed IS NOT NULL THEN
    RAISE EXCEPTION 'This approver has already decided — nothing to override.';
  END IF;
  UPDATE approval_confirmations
  SET confirmed = true, decided_at = now(), overridden_by = current_admin_user_id()
  WHERE id = p_confirmation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION verify_complaint(p_complaint_id uuid, p_note text) RETURNS void AS $$
DECLARE v_complaint complaints%ROWTYPE;
BEGIN
  IF NOT (current_admin_is_super_admin() OR COALESCE((SELECT can_verify_complaints FROM admin_users WHERE id = current_admin_user_id()), false)) THEN
    RAISE EXCEPTION 'You are not authorized to verify complaints.';
  END IF;
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id;
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;
  IF v_complaint.status IS DISTINCT FROM 'awaiting_verification' THEN
    RAISE EXCEPTION 'This complaint is not awaiting verification.';
  END IF;

  UPDATE complaints SET status = 'verified', verified_at = now(), verified_by = current_admin_user_id() WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'comment', COALESCE(NULLIF(trim(p_note), ''), 'Verified and closed.'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION reopen_complaint(p_complaint_id uuid, p_note text) RETURNS void AS $$
DECLARE v_complaint complaints%ROWTYPE;
BEGIN
  IF NOT (current_admin_is_super_admin() OR COALESCE((SELECT can_verify_complaints FROM admin_users WHERE id = current_admin_user_id()), false)) THEN
    RAISE EXCEPTION 'You are not authorized to verify complaints.';
  END IF;
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id;
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;

  UPDATE complaints SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'reopened', COALESCE(NULLIF(trim(p_note), ''), 'Sent back — not resolved.'));

  IF v_complaint.assigned_to IS NOT NULL THEN
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (v_complaint.assigned_to, 'complaint_submitted', 'Sent back — ' || v_complaint.complaint_number, COALESCE(NULLIF(trim(p_note), ''), 'Not verified, please recheck.'), '/admin/complaints/' || p_complaint_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
