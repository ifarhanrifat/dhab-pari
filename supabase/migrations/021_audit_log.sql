-- Migration 021: Audit log + delete-and-restore for bills, payments, donations, vouchers.
--
-- Every delete on these four tables was previously silent and permanent. This adds
-- a BEFORE DELETE capture (full row snapshot + its ledger entries, as jsonb) into a
-- new audit_log table, restricted to super_admin, plus a restore_deleted_record RPC
-- that reinserts the exact original row (same id, same bill/voucher number — numbers
-- are never reissued to a different record either way, since they come from
-- sequences that never roll back) and lets the existing insert triggers naturally
-- recreate the correct ledger postings and re-derive bill status.
--
-- A bill can only be deleted while it has zero recorded payments (delete the
-- payments first) — this keeps bill deletion a simple single-row+ledger operation
-- instead of needing to cascade-capture/restore its payments too.

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name varchar NOT NULL CHECK (table_name IN ('bills', 'payments', 'donors', 'vouchers')),
  record_id uuid NOT NULL,
  record_data jsonb NOT NULL,
  related_data jsonb,
  system varchar,
  summary text NOT NULL,
  deleted_by uuid REFERENCES admin_users(id),
  deleted_by_name varchar,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  restored_by uuid REFERENCES admin_users(id)
);
CREATE INDEX IF NOT EXISTS audit_log_deleted_at_idx ON audit_log(deleted_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "super_admin_read_audit_log" ON audit_log FOR SELECT TO authenticated
  USING (current_admin_role() = 'super_admin');
-- No INSERT/UPDATE/DELETE policy for the authenticated role at all — writes only
-- happen through SECURITY DEFINER functions below, which run with the function
-- owner's privileges and so are not subject to this table's RLS policies.

CREATE OR REPLACE FUNCTION current_admin_user_id() RETURNS uuid AS $$
  SELECT id FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION current_admin_name() RETURNS varchar AS $$
  SELECT full_name FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Bills: block delete while payments exist, capture snapshot + ledger entries.
CREATE OR REPLACE FUNCTION trg_audit_capture_bill() RETURNS trigger AS $$
DECLARE
  v_payment_count int;
  v_consumer_name varchar;
BEGIN
  SELECT count(*) INTO v_payment_count FROM payments WHERE bill_id = OLD.id;
  IF v_payment_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete Bill #% — % payment(s) are recorded against it. Delete the payment(s) first.', OLD.bill_number, v_payment_count;
  END IF;

  SELECT name INTO v_consumer_name FROM consumers WHERE consumer_id = OLD.consumer_id;

  INSERT INTO audit_log (table_name, record_id, record_data, related_data, system, summary, deleted_by, deleted_by_name)
  VALUES (
    'bills', OLD.id, to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'bill' AND le.reference_id = OLD.id)),
    'water_supply',
    'Bill #' || OLD.bill_number || ' — ' || COALESCE(v_consumer_name, OLD.consumer_id) || ' — Rs. ' || OLD.amount_pkr || ' (' || to_char(make_date(OLD.year, OLD.month, 1), 'FMMonth YYYY') || ')',
    current_admin_user_id(), current_admin_name()
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS audit_capture_bill_trigger ON bills;
CREATE TRIGGER audit_capture_bill_trigger BEFORE DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION trg_audit_capture_bill();

-- Payments
CREATE OR REPLACE FUNCTION trg_audit_capture_payment() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, record_data, related_data, system, summary, deleted_by, deleted_by_name)
  VALUES (
    'payments', OLD.id, to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'payment' AND le.reference_id = OLD.id)),
    'water_supply',
    'Payment — Rs. ' || OLD.amount_pkr || ' (' || OLD.method || ') — receipt ' || COALESCE(OLD.receipt_no, '—'),
    current_admin_user_id(), current_admin_name()
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS audit_capture_payment_trigger ON payments;
CREATE TRIGGER audit_capture_payment_trigger BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_audit_capture_payment();

-- Donors / donations
CREATE OR REPLACE FUNCTION trg_audit_capture_donor() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, record_data, related_data, system, summary, deleted_by, deleted_by_name)
  VALUES (
    'donors', OLD.id, to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'donation' AND le.reference_id = OLD.id)),
    'donors_projects',
    'Donation — ' || OLD.name || ' — Rs. ' || OLD.amount_pkr || ' (' || to_char(OLD.date, 'DD Mon YYYY') || ')',
    current_admin_user_id(), current_admin_name()
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS audit_capture_donor_trigger ON donors;
CREATE TRIGGER audit_capture_donor_trigger BEFORE DELETE ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_audit_capture_donor();

-- Vouchers — also capture voucher_approvals, since those cascade-delete with it.
CREATE OR REPLACE FUNCTION trg_audit_capture_voucher() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, record_data, related_data, system, summary, deleted_by, deleted_by_name)
  VALUES (
    'vouchers', OLD.id, to_jsonb(OLD),
    jsonb_build_object(
      'ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'voucher' AND le.reference_id = OLD.id),
      'voucher_approvals', (SELECT jsonb_agg(to_jsonb(va)) FROM voucher_approvals va WHERE va.voucher_id = OLD.id)
    ),
    OLD.system,
    'Voucher ' || COALESCE(OLD.voucher_no, '(unposted)') || ' — ' || OLD.particular || ' — Rs. ' || OLD.amount_pkr,
    current_admin_user_id(), current_admin_name()
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS audit_capture_voucher_trigger ON vouchers;
CREATE TRIGGER audit_capture_voucher_trigger BEFORE DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_audit_capture_voucher();

-- Restore: reinsert the exact original row; the table's own insert triggers
-- naturally recreate the correct ledger postings and re-derive bill status.
CREATE OR REPLACE FUNCTION restore_deleted_record(p_audit_id uuid) RETURNS void AS $$
DECLARE
  v_row audit_log%ROWTYPE;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can restore deleted records';
  END IF;

  SELECT * INTO v_row FROM audit_log WHERE id = p_audit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit log entry not found';
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
  END IF;

  UPDATE audit_log SET restored_at = now(), restored_by = current_admin_user_id() WHERE id = p_audit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
