-- Migration 056: Field collector sub-ledger.
--
-- Viewers can now be granted `can_collect_payments` + a list of `assigned_sectors`,
-- letting them create a cash receipt on the spot for a consumer in their sector
-- without becoming full accountants. The money they collect isn't yet in the
-- committee's cash box, so it doesn't post to Cash-in-Hand — it posts to a
-- per-collector "Collector Clearing" sub-account (mirrors how each consumer gets
-- their own receivable account via ensure_consumer_account). When the accountant
-- physically receives that cash, a settlement zeroes the collector's balance back
-- against real Cash/Bank.
--
-- Also adds a small, reusable notification system (in-app popup log + a
-- per-event-type WhatsApp/popup preference row) so this and later phases (expense
-- approvals, complaints) can alert the right people through either channel.

-- 1. Collector fields on admin_users. viewer is (deliberately) hard-blocked from
--    every other write permission in current_admin_permission() — this is a
--    separate, narrowly-scoped capability, not a weakening of that guarantee.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mobile varchar;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS assigned_sectors text[];
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_collect_payments boolean NOT NULL DEFAULT false;

-- 1a. Close a real gap before it can be exploited: the self-update guard trigger
-- (migration 022) only blocks self-changes to the columns it explicitly lists.
-- Left alone, a viewer could grant themselves can_collect_payments / sectors via
-- a crafted update, bypassing the UI entirely — the exact class of bug that
-- trigger exists to prevent. Extend it to cover the two new columns too.
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
    OR NEW.can_collect_payments IS DISTINCT FROM OLD.can_collect_payments
    OR NEW.assigned_sectors IS DISTINCT FROM OLD.assigned_sectors
  ) THEN
    RAISE EXCEPTION 'You cannot change your own role or permissions.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. Collector Clearing accounts — a new account_headers group (accounts.type is
-- validated via FK to account_headers, not a fixed CHECK — see migration 008),
-- plus the column linking an account row to the collector it belongs to.
INSERT INTO account_headers (system, code, label, code_prefix, display_order, is_system) VALUES
  ('water_supply', 'collector', 'Field Collectors', 'WS-COL', 7, true)
ON CONFLICT (system, code) DO NOTHING;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS collector_id uuid REFERENCES admin_users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_collector_id_key ON accounts(collector_id) WHERE collector_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_collector_account(p_admin_user_id uuid) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_name varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE collector_id = p_admin_user_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT full_name INTO v_name FROM admin_users WHERE id = p_admin_user_id;
  INSERT INTO accounts (code, name, type, system, collector_id, opening_balance)
  VALUES ('COL-' || substr(replace(p_admin_user_id::text, '-', ''), 1, 8), v_name, 'collector', 'water_supply', p_admin_user_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql;

-- 3. payments.collected_by — NULL means collected directly by an accountant as
-- before (unchanged behavior); set means a field collector took it on the spot.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS collected_by uuid REFERENCES admin_users(id);

-- 4. Route the debit leg of a collector-collected payment to their Collector
-- Clearing account instead of Cash/Bank (that cash isn't in the committee's box
-- yet). Everything else matches trg_payment_ledger() from migration 043 exactly.
CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_net_payable decimal;
  v_status_note text;
  v_particular text;
  v_collector_name varchar;
BEGIN
  IF NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  v_account_id := ensure_consumer_account(NEW.consumer_id);

  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
  SELECT COALESCE(SUM(amount_pkr), 0) + NEW.amount_pkr INTO v_total_paid
    FROM payments WHERE bill_id = NEW.bill_id;
  v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);

  v_status_note := CASE
    WHEN v_total_paid >= v_net_payable THEN 'Bill Paid in Full'
    ELSE 'Partial Payment — Rs. ' || to_char(v_net_payable - v_total_paid, 'FM999999990.00') || ' remaining'
  END;

  IF NEW.collected_by IS NOT NULL THEN
    SELECT full_name INTO v_collector_name FROM admin_users WHERE id = NEW.collected_by;
  END IF;

  v_particular := 'Payment received (' || NEW.method || ')'
    || CASE WHEN v_collector_name IS NOT NULL THEN ' via collector ' || v_collector_name ELSE '' END
    || ' — Bill #' || v_bill.bill_number || ' — ' || v_status_note
    || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no)
  VALUES (v_account_id, NEW.paid_date, v_particular, 0, NEW.amount_pkr, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no);

  IF NEW.collected_by IS NOT NULL THEN
    v_cash_account_id := ensure_collector_account(NEW.collected_by);
  ELSE
    SELECT id INTO v_cash_account_id FROM accounts
    WHERE system = 'water_supply' AND code = (CASE WHEN NEW.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END);
  END IF;
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no)
    VALUES (v_cash_account_id, NEW.paid_date, v_particular, NEW.amount_pkr, 0, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no);
  END IF;

  UPDATE bills SET
    paid_amount = v_total_paid,
    status = CASE WHEN v_total_paid >= v_net_payable THEN 'paid'
                  WHEN v_total_paid > 0 THEN 'partial'
                  ELSE v_bill.status END,
    paid_date = NEW.paid_date,
    payment_method = NEW.method
  WHERE id = NEW.bill_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5. RLS: a collector may INSERT a payment for a consumer in one of their
-- assigned sectors, tagged as their own collection — a narrow bypass of the
-- normal post_transactions requirement, not a relaxation of it (viewers with
-- no assigned_sectors, or collecting for a consumer outside their sectors,
-- still fail this check; ANY over a NULL array is NULL, which WITH CHECK
-- treats as a failure, so an unassigned collector is denied by default).
CREATE OR REPLACE FUNCTION current_admin_can_collect_for_consumer(p_consumer_id varchar) RETURNS boolean AS $$
  SELECT au.can_collect_payments AND c.sector = ANY(au.assigned_sectors)
  FROM admin_users au
  JOIN consumers c ON c.consumer_id = p_consumer_id
  WHERE au.auth_user_id = auth.uid() AND au.is_active = true
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS "payments_write" ON payments;
CREATE POLICY "payments_write" ON payments FOR INSERT TO authenticated
  WITH CHECK (
    can_access_system('water_supply') AND (
      current_admin_permission('post_transactions')
      OR (collected_by = current_admin_user_id() AND current_admin_can_collect_for_consumer(consumer_id))
    )
  );

-- 6. Collector settlements — the accountant confirming they've physically
-- received a collector's held cash. Debits real Cash/Bank, credits the
-- collector's clearing account back down, zeroing both sides together.
CREATE TABLE IF NOT EXISTS collector_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id uuid NOT NULL REFERENCES admin_users(id),
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  to_account_id uuid NOT NULL REFERENCES accounts(id),
  method varchar NOT NULL DEFAULT 'cash',
  settled_date date NOT NULL DEFAULT current_date,
  note text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE collector_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "collector_settlements_read" ON collector_settlements FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "collector_settlements_write" ON collector_settlements FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));

CREATE OR REPLACE FUNCTION trg_collector_settlement_ledger() RETURNS trigger AS $$
DECLARE
  v_collector_account_id uuid;
  v_collector_name varchar;
  v_particular text;
BEGIN
  v_collector_account_id := ensure_collector_account(NEW.collector_id);
  SELECT full_name INTO v_collector_name FROM admin_users WHERE id = NEW.collector_id;
  v_particular := 'Cash received from collector ' || COALESCE(v_collector_name, 'Unknown')
    || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (NEW.to_account_id, NEW.settled_date, v_particular, NEW.amount_pkr, 0, 'collector_settlement', NEW.id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_collector_account_id, NEW.settled_date, v_particular, 0, NEW.amount_pkr, 'collector_settlement', NEW.id);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS collector_settlement_ledger_trigger ON collector_settlements;
CREATE TRIGGER collector_settlement_ledger_trigger BEFORE INSERT ON collector_settlements
  FOR EACH ROW EXECUTE FUNCTION trg_collector_settlement_ledger();

-- 7. Reusable notification system: one row per (event_type) controls whether
-- that event fires a WhatsApp deep-link, an in-app popup, or both — editable
-- from Settings. `notifications` is the in-app popup log itself, insertable
-- only by SECURITY DEFINER trigger functions (never directly by a client), so
-- nobody can spoof a notification into someone else's inbox.
CREATE TABLE IF NOT EXISTS notification_preferences (
  event_type varchar PRIMARY KEY,
  label varchar NOT NULL,
  whatsapp_enabled boolean NOT NULL DEFAULT true,
  popup_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_preferences_read" ON notification_preferences FOR SELECT TO authenticated USING (true);
CREATE POLICY "notification_preferences_write" ON notification_preferences FOR UPDATE TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('collector_payment_collected', 'A field collector records a payment', true, true)
ON CONFLICT (event_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  event_type varchar NOT NULL,
  title varchar NOT NULL,
  body text,
  link varchar,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id, is_read);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications_read_own" ON notifications FOR SELECT TO authenticated
  USING (recipient_id = current_admin_user_id());
CREATE POLICY "notifications_update_own" ON notifications FOR UPDATE TO authenticated
  USING (recipient_id = current_admin_user_id()) WITH CHECK (recipient_id = current_admin_user_id());

-- 8. When a collector's payment lands, pop a notification to the water-supply
-- accountants (everyone except the collector themself) if the popup channel is
-- enabled for this event type. The WhatsApp channel is realized client-side (as
-- a wa.me deep-link the collector can tap right after collecting) since there's
-- no WhatsApp Business API configured — same pattern already used elsewhere in
-- this app for consumer notifications.
CREATE OR REPLACE FUNCTION trg_payment_collector_notify() RETURNS trigger AS $$
DECLARE
  v_popup_enabled boolean;
  v_collector_name varchar;
  v_consumer_name varchar;
  r record;
BEGIN
  IF NEW.collected_by IS NULL THEN RETURN NEW; END IF;
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'collector_payment_collected';
  IF v_popup_enabled IS DISTINCT FROM true THEN RETURN NEW; END IF;

  SELECT full_name INTO v_collector_name FROM admin_users WHERE id = NEW.collected_by;
  SELECT name INTO v_consumer_name FROM consumers WHERE consumer_id = NEW.consumer_id;

  FOR r IN
    SELECT id FROM admin_users
    WHERE is_active = true AND id != NEW.collected_by AND (
      role IN ('super_admin', 'admin', 'water_accountant')
      OR (role = 'accountant' AND access_water_supply)
    )
  LOOP
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (
      r.id, 'collector_payment_collected',
      'Payment collected by ' || COALESCE(v_collector_name, 'a collector'),
      'Rs. ' || to_char(NEW.amount_pkr, 'FM999999990.00') || ' collected from ' || COALESCE(v_consumer_name, NEW.consumer_id),
      '/admin/collectors'
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS payment_collector_notify_trigger ON payments;
CREATE TRIGGER payment_collector_notify_trigger AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_payment_collector_notify();
