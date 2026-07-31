-- Migration 061: Three sensitive additions to the Phase 4 approval workflow
-- (migration 060), all scoped as tightly as the request that prompted them:
--
--   1. Per-system, per-transaction-type approval toggle — until now, gating was
--      all-or-nothing per system (any active approver = expense+withdrawal+
--      purchase all gated together). Now each of the three can be switched off
--      independently, e.g. "Water Supply purchases never need approval, but
--      Water Supply withdrawals always do."
--   2. Per-approver stats (pending / approved / rejected / overridden counts)
--      per system, for the roster management view.
--   3. A narrowly-scoped override: a super_admin (and ONLY a super_admin — this
--      was an explicit choice, not a default) can confirm on behalf of an
--      approver who hasn't acted, for one specific pending request. This is
--      recorded distinctly (approval_confirmations.overridden_by) so it is
--      never confused with that approver's own decision in any trail or stat.

-- 1. Per-type toggle. Defaults to requiring approval for everything (matches
-- the behavior migration 060 shipped with) — nothing changes for existing
-- systems until an admin explicitly unchecks something.
CREATE TABLE IF NOT EXISTS approval_type_settings (
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  transaction_type varchar NOT NULL CHECK (transaction_type IN ('expense', 'withdrawal', 'purchase')),
  requires_approval boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (system, transaction_type)
);

INSERT INTO approval_type_settings (system, transaction_type) VALUES
  ('water_supply', 'expense'), ('water_supply', 'withdrawal'), ('water_supply', 'purchase'),
  ('donors_projects', 'expense'), ('donors_projects', 'withdrawal'), ('donors_projects', 'purchase')
ON CONFLICT (system, transaction_type) DO NOTHING;

ALTER TABLE approval_type_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_type_settings_read" ON approval_type_settings FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "approval_type_settings_write" ON approval_type_settings FOR UPDATE TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

-- No row for a (system, type) pair means "not configured yet" — default to
-- requiring approval (the safe direction: a missing row should never silently
-- skip approval).
CREATE OR REPLACE FUNCTION approval_type_enabled(p_system varchar, p_type varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT requires_approval FROM approval_type_settings WHERE system = p_system AND transaction_type = p_type),
    true
  );
$$ LANGUAGE sql STABLE;

-- Re-gate vouchers with the type toggle added on top of the existing
-- has-any-active-approver check from migration 060.
CREATE OR REPLACE FUNCTION trg_voucher_before_insert() RETURNS trigger AS $$
DECLARE
  v_requires_approval boolean;
  v_has_approvers boolean;
BEGIN
  v_requires_approval := NEW.voucher_type IN ('withdrawal', 'expense') AND approval_type_enabled(NEW.system, NEW.voucher_type);
  IF v_requires_approval THEN
    SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = NEW.system AND is_active = true) INTO v_has_approvers;
    v_requires_approval := v_has_approvers;
  END IF;

  IF v_requires_approval THEN
    NEW.status := 'pending';
    NEW.voucher_no := NULL;
  ELSE
    NEW.status := 'posted';
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION submit_purchase_for_approval(p_purchase_id uuid) RETURNS void AS $$
DECLARE
  v_purchase purchases%ROWTYPE;
  v_total decimal;
  v_has_approvers boolean;
  v_particular text;
BEGIN
  SELECT * INTO v_purchase FROM purchases WHERE id = p_purchase_id;

  IF NOT approval_type_enabled(v_purchase.system, 'purchase') THEN
    PERFORM post_purchase(p_purchase_id);
    RETURN;
  END IF;

  SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = v_purchase.system AND is_active = true) INTO v_has_approvers;
  IF NOT v_has_approvers THEN
    PERFORM post_purchase(p_purchase_id);
    RETURN;
  END IF;

  SELECT COALESCE(SUM(quantity * unit_cost), 0) INTO v_total FROM purchase_line_items WHERE purchase_id = p_purchase_id;
  v_particular := 'Purchase' || CASE WHEN v_purchase.vendor IS NOT NULL THEN ' from ' || v_purchase.vendor ELSE '' END;
  PERFORM create_approval_request(v_purchase.system, 'purchase', p_purchase_id, v_particular, v_total, current_admin_user_id());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. Override — a super_admin confirming on behalf of a named approver who
-- hasn't acted. Reuses the exact same completion trigger every normal confirm
-- goes through (trg_approval_confirmation_decided, migration 060) — this
-- function's only job is to perform that same UPDATE under a privilege check
-- the normal RLS policy (approver_id = current_admin_user_id()) would refuse.
ALTER TABLE approval_confirmations ADD COLUMN IF NOT EXISTS overridden_by uuid REFERENCES admin_users(id);

CREATE OR REPLACE FUNCTION override_approve_confirmation(p_confirmation_id uuid) RETURNS void AS $$
DECLARE
  v_confirmation approval_confirmations%ROWTYPE;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
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

-- Surface who actually decided (including overrides) alongside the roster
-- status the pending-approvals UI already showed. Return columns changed from
-- migration 057's version, so CREATE OR REPLACE (which can't alter a
-- function's output signature) needs an explicit drop first.
DROP FUNCTION IF EXISTS get_approval_approvers(uuid);
CREATE OR REPLACE FUNCTION get_approval_approvers(p_request_id uuid) RETURNS TABLE (
  id uuid, full_name varchar, mobile varchar, confirmed boolean, overridden_by_name varchar
) AS $$
  SELECT au.id, au.full_name, au.mobile, ac.confirmed, ob.full_name AS overridden_by_name
  FROM approval_confirmations ac
  JOIN admin_users au ON au.id = ac.approver_id
  JOIN approval_requests r ON r.id = ac.approval_request_id
  LEFT JOIN admin_users ob ON ob.id = ac.overridden_by
  WHERE ac.approval_request_id = p_request_id AND can_access_system(r.system);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 3. Per-approver stats for the roster management view — pending (still
-- awaiting their decision on a still-open request), approved/rejected (their
-- own real decisions), and overridden (times someone else had to decide for
-- them), all scoped to one system since the same person can be an approver on
-- both books with very different track records.
CREATE OR REPLACE FUNCTION get_approver_stats(p_system varchar) RETURNS TABLE (
  admin_user_id uuid, full_name varchar, pending_count bigint, approved_count bigint, rejected_count bigint, overridden_count bigint
) AS $$
  SELECT
    au.id, au.full_name,
    COUNT(*) FILTER (WHERE sub.confirmed IS NULL AND sub.request_status = 'pending') AS pending_count,
    COUNT(*) FILTER (WHERE sub.confirmed = true AND sub.overridden_by IS NULL) AS approved_count,
    COUNT(*) FILTER (WHERE sub.confirmed = false) AS rejected_count,
    COUNT(*) FILTER (WHERE sub.overridden_by IS NOT NULL) AS overridden_count
  FROM admin_users au
  JOIN approval_approvers aa ON aa.admin_user_id = au.id AND aa.system = p_system AND aa.is_active = true
  LEFT JOIN (
    SELECT ac.approver_id, ac.confirmed, ac.overridden_by, r.status AS request_status
    FROM approval_confirmations ac
    JOIN approval_requests r ON r.id = ac.approval_request_id
    WHERE r.system = p_system
  ) sub ON sub.approver_id = au.id
  WHERE can_access_system(p_system)
  GROUP BY au.id, au.full_name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
