-- Migration 060: Multi-approver expense/purchase confirmation workflow.
--
-- Replaces the old single-link WhatsApp approval system (migration 011) — a
-- committee_members-based, unauthenticated, one-decision-and-done flow that only
-- gated cash withdrawals and cash-paid expenses — with:
--   * A per-system roster of approvers, drawn from real admin_users logins
--     (not committee_members) since real-time popup delivery needs an actual
--     account, not a self-attested name on a public link.
--   * EVERY approver assigned to a system must individually confirm (or any one
--     can reject, which cancels it) before the transaction posts.
--   * Coverage widened to ALL expense vouchers (cash or bank — the old system
--     only gated cash), ALL withdrawals, and now purchases too (previously
--     completely ungated, in both of the two places that create them — the
--     bulk purchase-bill flow and the inventory page's quick single-item
--     purchase). "Salary" isn't its own type; it's an expense voucher, so it's
--     covered automatically.
--   * Auto-posts after 24 hours regardless of outstanding confirmations, so a
--     genuinely necessary payment (e.g. paying a vendor) is never blocked
--     indefinitely by an unresponsive approver.
--   * Feeds the notification system built in migration 056/059 (popup +
--     optional WhatsApp deep-link, real-time via Realtime) instead of a
--     public token link shared manually over WhatsApp.
--
-- Design note: rather than bolt two different gating mechanisms onto vouchers
-- and purchases separately, both go through one generic approval_requests /
-- approval_confirmations layer (kind='voucher'|'purchase', reference_id points
-- at the real row). Confirming/rejecting is a plain client-side UPDATE of the
-- caller's own approval_confirmations row (RLS-restricted to their own row) —
-- the completion/rejection logic lives in a trigger on that update, not a
-- bespoke RPC, so it can't be raced or spoofed by updating someone else's
-- decision.
--
-- The old voucher_approvals audit table and committee_members.can_approve are
-- left in place (historical data, no longer written to) rather than dropped.

-- 1. Per-system approver roster.
CREATE TABLE IF NOT EXISTS approval_approvers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE (system, admin_user_id)
);

ALTER TABLE approval_approvers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_approvers_read" ON approval_approvers FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "approval_approvers_write" ON approval_approvers FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

-- 2. The generic gate: one row per gated transaction.
CREATE TABLE IF NOT EXISTS approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  kind varchar NOT NULL CHECK (kind IN ('voucher', 'purchase')),
  reference_id uuid NOT NULL,
  particular text NOT NULL,
  amount_pkr decimal NOT NULL,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'rejected')),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  posted_at timestamptz,
  auto_posted boolean NOT NULL DEFAULT false,
  rejected_by uuid REFERENCES admin_users(id),
  rejected_note text,
  UNIQUE (kind, reference_id)
);
CREATE INDEX IF NOT EXISTS approval_requests_pending_idx ON approval_requests(status, deadline_at) WHERE status = 'pending';

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_requests_read" ON approval_requests FOR SELECT TO authenticated
  USING (can_access_system(system));
-- No client INSERT/UPDATE policy — rows are only written by SECURITY DEFINER
-- functions/triggers below (create_approval_request, the confirmation trigger,
-- the auto-post sweep), never directly by client code.

-- 3. One row per (request, approver) — the actual confirm/reject surface.
CREATE TABLE IF NOT EXISTS approval_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL REFERENCES admin_users(id),
  confirmed boolean,
  decided_at timestamptz,
  UNIQUE (approval_request_id, approver_id)
);

ALTER TABLE approval_confirmations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_confirmations_read" ON approval_confirmations FOR SELECT TO authenticated
  USING (
    approver_id = current_admin_user_id()
    OR EXISTS (SELECT 1 FROM approval_requests r WHERE r.id = approval_request_id AND can_access_system(r.system))
  );
CREATE POLICY "approval_confirmations_update_own" ON approval_confirmations FOR UPDATE TO authenticated
  USING (approver_id = current_admin_user_id() AND confirmed IS NULL)
  WITH CHECK (approver_id = current_admin_user_id());

-- 4. ledger_entries.reference_type doesn't need a new value here — vouchers and
-- purchases already post through their existing 'voucher'/'inventory' reference
-- types once approved; approval_requests is a gate in front of them, not a new
-- ledger reference itself.

-- 5. Shared creation helper: makes the request, snapshots the current approver
-- roster into confirmations, and fires a popup notification to each of them
-- (subject to the popup_enabled toggle in Settings — see migration 056/059).
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('approval_requested', 'An expense, withdrawal, or purchase needs approval', true, true)
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION create_approval_request(
  p_system varchar, p_kind varchar, p_reference_id uuid,
  p_particular text, p_amount decimal, p_created_by uuid
) RETURNS uuid AS $$
DECLARE
  v_request_id uuid;
  v_popup_enabled boolean;
  r record;
BEGIN
  INSERT INTO approval_requests (system, kind, reference_id, particular, amount_pkr, created_by)
  VALUES (p_system, p_kind, p_reference_id, p_particular, p_amount, p_created_by)
  RETURNING id INTO v_request_id;

  INSERT INTO approval_confirmations (approval_request_id, approver_id)
  SELECT v_request_id, admin_user_id FROM approval_approvers WHERE system = p_system AND is_active = true;

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'approval_requested';
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN SELECT admin_user_id FROM approval_approvers WHERE system = p_system AND is_active = true LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.admin_user_id, 'approval_requested', 'Approval needed — Rs. ' || to_char(p_amount, 'FM999999990.00'), p_particular, '/admin/approvals');
    END LOOP;
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6. Vouchers: widen the gate to ALL expense (any payment method) + withdrawal,
-- and only actually gate if the system has at least one active approver
-- configured — until an administrator sets one up, transactions post as they
-- always did (a safe bootstrap default, not a silent bypass once configured).
CREATE OR REPLACE FUNCTION trg_voucher_before_insert() RETURNS trigger AS $$
DECLARE
  v_requires_approval boolean;
  v_has_approvers boolean;
BEGIN
  v_requires_approval := NEW.voucher_type IN ('withdrawal', 'expense');
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

CREATE OR REPLACE FUNCTION trg_voucher_after_insert_approval() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM create_approval_request(NEW.system, 'voucher', NEW.id, NEW.particular, NEW.amount_pkr, current_admin_user_id());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS voucher_after_insert_approval_trigger ON vouchers;
CREATE TRIGGER voucher_after_insert_approval_trigger AFTER INSERT ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_voucher_after_insert_approval();

-- The ledger-posting trigger from migration 011/046 fired on the OLD single-
-- decision route's status flip to 'approved'. The new terminal "fully
-- confirmed" state is 'posted' (matching every other non-gated voucher), so
-- retarget it — the ledger-posting body itself (voucher_no assignment +
-- the two ledger_entries inserts) is unchanged from 046.
CREATE OR REPLACE FUNCTION trg_voucher_after_approval() RETURNS trigger AS $$
DECLARE
  v_bill_number varchar;
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'posted' THEN
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
    IF NEW.bill_id IS NOT NULL THEN
      SELECT bill_number INTO v_bill_number FROM bills WHERE id = NEW.bill_id;
    END IF;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id, NEW.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id, NEW.receipt_no, v_bill_number);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 7. Purchases: previously posted to inventory + ledger immediately and
-- unconditionally (no status concept at all). Line items now stage in a new
-- table until the request is confirmed/auto-posted, at which point they're
-- materialized into real inventory_transactions rows (which still drive stock
-- + ledger via the existing trg_inventory_txn_apply, untouched).
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'rejected'));

CREATE TABLE IF NOT EXISTS purchase_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  description varchar NOT NULL,
  quantity decimal NOT NULL,
  unit_cost decimal NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE purchase_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "purchase_line_items_read" ON purchase_line_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id AND can_access_system(p.system)));
CREATE POLICY "purchase_line_items_write" ON purchase_line_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id AND can_access_system(p.system) AND current_admin_permission('post_transactions')));

CREATE OR REPLACE FUNCTION post_purchase(p_purchase_id uuid) RETURNS void AS $$
DECLARE
  v_purchase purchases%ROWTYPE;
  v_note text;
  r record;
BEGIN
  SELECT * INTO v_purchase FROM purchases WHERE id = p_purchase_id;
  IF v_purchase.status = 'posted' THEN RETURN; END IF; -- idempotent
  v_note := 'Purchase' || CASE WHEN v_purchase.vendor IS NOT NULL THEN ' from ' || v_purchase.vendor ELSE '' END
    || CASE WHEN v_purchase.note IS NOT NULL AND trim(v_purchase.note) != '' THEN ' — ' || v_purchase.note ELSE '' END;

  FOR r IN SELECT * FROM purchase_line_items WHERE purchase_id = p_purchase_id LOOP
    INSERT INTO inventory_transactions (item_id, txn_type, quantity, unit_cost_at_time, txn_date, method, note, purchase_id)
    VALUES (r.inventory_item_id, 'purchase', r.quantity, r.unit_cost, v_purchase.purchase_date, v_purchase.method, v_note, p_purchase_id);
  END LOOP;

  UPDATE purchases SET status = 'posted' WHERE id = p_purchase_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION submit_purchase_for_approval(p_purchase_id uuid) RETURNS void AS $$
DECLARE
  v_purchase purchases%ROWTYPE;
  v_total decimal;
  v_has_approvers boolean;
  v_particular text;
BEGIN
  SELECT * INTO v_purchase FROM purchases WHERE id = p_purchase_id;
  SELECT COALESCE(SUM(quantity * unit_cost), 0) INTO v_total FROM purchase_line_items WHERE purchase_id = p_purchase_id;
  v_particular := 'Purchase' || CASE WHEN v_purchase.vendor IS NOT NULL THEN ' from ' || v_purchase.vendor ELSE '' END;

  SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = v_purchase.system AND is_active = true) INTO v_has_approvers;
  IF NOT v_has_approvers THEN
    PERFORM post_purchase(p_purchase_id);
    RETURN;
  END IF;

  PERFORM create_approval_request(v_purchase.system, 'purchase', p_purchase_id, v_particular, v_total, current_admin_user_id());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 8. The actual confirm/reject resolution — fires when a client updates their
-- own approval_confirmations row (RLS above restricts that to their own row,
-- once, while still null). Any single rejection cancels the whole request;
-- full confirmation posts it.
CREATE OR REPLACE FUNCTION trg_approval_confirmation_decided() RETURNS trigger AS $$
DECLARE
  v_req approval_requests%ROWTYPE;
  v_total int;
  v_confirmed int;
BEGIN
  IF NEW.confirmed IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_req FROM approval_requests WHERE id = NEW.approval_request_id;
  IF v_req.status != 'pending' THEN RETURN NEW; END IF; -- already resolved (auto-post race, or double click)

  IF NEW.confirmed = false THEN
    UPDATE approval_requests SET status = 'rejected', rejected_by = NEW.approver_id WHERE id = v_req.id;
    IF v_req.kind = 'voucher' THEN
      UPDATE vouchers SET status = 'rejected' WHERE id = v_req.reference_id;
    ELSE
      UPDATE purchases SET status = 'rejected' WHERE id = v_req.reference_id;
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE confirmed = true) INTO v_total, v_confirmed
  FROM approval_confirmations WHERE approval_request_id = v_req.id;

  IF v_confirmed = v_total THEN
    UPDATE approval_requests SET status = 'posted', posted_at = now(), auto_posted = false WHERE id = v_req.id;
    IF v_req.kind = 'voucher' THEN
      UPDATE vouchers SET status = 'posted' WHERE id = v_req.reference_id;
    ELSE
      PERFORM post_purchase(v_req.reference_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS approval_confirmation_decided_trigger ON approval_confirmations;
CREATE TRIGGER approval_confirmation_decided_trigger AFTER UPDATE OF confirmed ON approval_confirmations
  FOR EACH ROW EXECUTE FUNCTION trg_approval_confirmation_decided();

-- 9. 24-hour auto-post sweep, via pg_cron (same extension already used for
-- recurring schedules — migration 055). Runs every 10 minutes; a request only
-- ever fires once (status flips away from 'pending' the first time it's due).
CREATE OR REPLACE FUNCTION run_approval_auto_post() RETURNS void AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM approval_requests WHERE status = 'pending' AND deadline_at <= now() LOOP
    UPDATE approval_requests SET status = 'posted', posted_at = now(), auto_posted = true WHERE id = r.id;
    IF r.kind = 'voucher' THEN
      UPDATE vouchers SET status = 'posted' WHERE id = r.reference_id;
    ELSE
      PERFORM post_purchase(r.reference_id);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

SELECT cron.schedule('run-approval-auto-post', '*/10 * * * *', $$SELECT run_approval_auto_post()$$);

-- 10. Resend reminder — only re-notifies approvers who haven't decided yet.
CREATE OR REPLACE FUNCTION resend_approval_notifications(p_request_id uuid) RETURNS void AS $$
DECLARE
  v_req approval_requests%ROWTYPE;
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT * INTO v_req FROM approval_requests WHERE id = p_request_id;
  IF v_req.id IS NULL OR v_req.status != 'pending' OR NOT can_access_system(v_req.system) THEN RETURN; END IF;

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'approval_requested';
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN SELECT approver_id FROM approval_confirmations WHERE approval_request_id = p_request_id AND confirmed IS NULL LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.approver_id, 'approval_requested', 'Reminder — approval needed: Rs. ' || to_char(v_req.amount_pkr, 'FM999999990.00'), v_req.particular, '/admin/approvals');
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 11. Narrow lookups needed by the UI — same pattern as get_field_collectors()
-- / get_water_supply_notify_targets() (migration 057): admin_users' own RLS
-- only lets super_admin/admin read every row, so expose just the columns the
-- approvals UI actually needs.
CREATE OR REPLACE FUNCTION get_approval_approvers(p_request_id uuid) RETURNS TABLE (
  id uuid, full_name varchar, mobile varchar, confirmed boolean
) AS $$
  SELECT au.id, au.full_name, au.mobile, ac.confirmed
  FROM approval_confirmations ac
  JOIN admin_users au ON au.id = ac.approver_id
  JOIN approval_requests r ON r.id = ac.approval_request_id
  WHERE ac.approval_request_id = p_request_id AND can_access_system(r.system);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- can_access_system() checks the CALLING session's own role — using it to
-- filter a list of OTHER admin_users' rows would return either everyone or
-- no one (constant across rows), not "which of these users has access."
-- This mirrors that same CASE logic per-row instead, parameterized on an
-- arbitrary admin_users row rather than the caller's.
CREATE OR REPLACE FUNCTION admin_user_can_access_system(p_admin_user_id uuid, p_system varchar) RETURNS boolean AS $$
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
  FROM admin_users WHERE id = p_admin_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION get_approvers_roster(p_system varchar) RETURNS TABLE (
  id uuid, full_name varchar
) AS $$
  SELECT id, full_name FROM admin_users au
  WHERE is_active = true AND can_access_system(p_system) AND admin_user_can_access_system(au.id, p_system);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
