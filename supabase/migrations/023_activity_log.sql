-- Migration 023: Expand the delete-only audit_log into a full activity log.
--
-- Previously audit_log only captured deletions. This adds insert/update logging
-- across bills, payments, donors, vouchers, accounts, and consumers too, so the
-- Audit Log page can show a complete "who did what and when" trail, filterable by
-- user — not just a list of things that were removed. Restore still only applies
-- to action='delete' rows (there's nothing to "restore" about an edit, only to see
-- what changed via old_data). Also opens audit log visibility to the new 'admin'
-- role (previously super_admin only), matching its "restore deleted entries" duty,
-- while the restore RPC itself additionally requires the can_restore_deleted grant
-- for admin (super_admin never needs a flag — it can always restore).

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_table_name_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_table_name_check
  CHECK (table_name IN ('bills', 'payments', 'donors', 'vouchers', 'accounts', 'consumers'));

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS action varchar NOT NULL DEFAULT 'delete' CHECK (action IN ('insert', 'update', 'delete'));
ALTER TABLE audit_log ALTER COLUMN action DROP DEFAULT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS old_data jsonb;

ALTER TABLE audit_log RENAME COLUMN deleted_by TO actor_id;
ALTER TABLE audit_log RENAME COLUMN deleted_by_name TO actor_name;
ALTER TABLE audit_log RENAME COLUMN deleted_at TO performed_at;

DROP INDEX IF EXISTS audit_log_deleted_at_idx;
CREATE INDEX IF NOT EXISTS audit_log_performed_at_idx ON audit_log(performed_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_id);

DROP POLICY IF EXISTS "super_admin_read_audit_log" ON audit_log;
CREATE POLICY "read_audit_log" ON audit_log FOR SELECT TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'));

-- Existing delete-capture functions: rename the columns they write to and tag
-- action='delete' explicitly (was implicit via the old column default).
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

  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name)
  VALUES (
    'bills', OLD.id, 'delete', to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'bill' AND le.reference_id = OLD.id)),
    'water_supply',
    'Bill #' || OLD.bill_number || ' — ' || COALESCE(v_consumer_name, OLD.consumer_id) || ' — Rs. ' || OLD.amount_pkr || ' (' || to_char(make_date(OLD.year, OLD.month, 1), 'FMMonth YYYY') || ')',
    current_admin_user_id(), current_admin_name()
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_audit_capture_payment() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name)
  VALUES (
    'payments', OLD.id, 'delete', to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'payment' AND le.reference_id = OLD.id)),
    'water_supply',
    'Payment — Rs. ' || OLD.amount_pkr || ' (' || OLD.method || ') — receipt ' || COALESCE(OLD.receipt_no, '—'),
    current_admin_user_id(), current_admin_name()
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_audit_capture_donor() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name)
  VALUES (
    'donors', OLD.id, 'delete', to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'donation' AND le.reference_id = OLD.id)),
    'donors_projects',
    'Donation — ' || OLD.name || ' — Rs. ' || OLD.amount_pkr || ' (' || to_char(OLD.date, 'DD Mon YYYY') || ')',
    current_admin_user_id(), current_admin_name()
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_audit_capture_voucher() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name)
  VALUES (
    'vouchers', OLD.id, 'delete', to_jsonb(OLD),
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

-- New: delete capture for accounts + consumers (no restore-blocking guard needed —
-- deleting an account/consumer with dependent rows is already blocked by their own
-- foreign keys, which don't cascade for accounts and do cascade for consumers,
-- letting each cascaded bill's own delete trigger log/guard itself independently).
CREATE OR REPLACE FUNCTION trg_audit_capture_account() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, system, summary, actor_id, actor_name)
  VALUES ('accounts', OLD.id, 'delete', to_jsonb(OLD), OLD.system, 'Account ' || OLD.code || ' — ' || OLD.name, current_admin_user_id(), current_admin_name());
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS audit_capture_account_trigger ON accounts;
CREATE TRIGGER audit_capture_account_trigger BEFORE DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION trg_audit_capture_account();

CREATE OR REPLACE FUNCTION trg_audit_capture_consumer() RETURNS trigger AS $$
BEGIN
  -- consumers' primary key is consumer_id (varchar, e.g. "DP-1005"), not a uuid,
  -- so record_id here is a generated id rather than a reference back to the row.
  INSERT INTO audit_log (table_name, record_id, action, record_data, system, summary, actor_id, actor_name)
  VALUES ('consumers', gen_random_uuid(), 'delete', to_jsonb(OLD), 'water_supply', 'Consumer ' || OLD.consumer_id || ' — ' || OLD.name, current_admin_user_id(), current_admin_name());
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS audit_capture_consumer_trigger ON consumers;
CREATE TRIGGER audit_capture_consumer_trigger BEFORE DELETE ON consumers
  FOR EACH ROW EXECUTE FUNCTION trg_audit_capture_consumer();

-- Insert + update logging (no restore semantics — informational trail only).
CREATE OR REPLACE FUNCTION trg_audit_log_change() RETURNS trigger AS $$
DECLARE
  v_action varchar := lower(TG_OP);
  v_system varchar;
  v_summary text;
  v_consumer_name varchar;
  v_record_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'bills' THEN
    v_record_id := NEW.id;
    v_system := 'water_supply';
    SELECT name INTO v_consumer_name FROM consumers WHERE consumer_id = NEW.consumer_id;
    v_summary := 'Bill #' || NEW.bill_number || ' — ' || COALESCE(v_consumer_name, NEW.consumer_id) || ' — Rs. ' || NEW.amount_pkr;
  ELSIF TG_TABLE_NAME = 'payments' THEN
    v_record_id := NEW.id;
    v_system := 'water_supply';
    v_summary := 'Payment — Rs. ' || NEW.amount_pkr || ' (' || NEW.method || ')';
  ELSIF TG_TABLE_NAME = 'donors' THEN
    v_record_id := NEW.id;
    v_system := 'donors_projects';
    v_summary := 'Donation — ' || NEW.name || ' — Rs. ' || NEW.amount_pkr;
  ELSIF TG_TABLE_NAME = 'vouchers' THEN
    v_record_id := NEW.id;
    v_system := NEW.system;
    v_summary := 'Voucher ' || COALESCE(NEW.voucher_no, '(unposted)') || ' — ' || NEW.particular || ' — Rs. ' || NEW.amount_pkr;
  ELSIF TG_TABLE_NAME = 'accounts' THEN
    v_record_id := NEW.id;
    v_system := NEW.system;
    v_summary := 'Account ' || NEW.code || ' — ' || NEW.name;
  ELSIF TG_TABLE_NAME = 'consumers' THEN
    -- consumers' primary key is consumer_id (varchar), not a uuid — use a
    -- generated id here too, same as the delete-capture function does.
    v_record_id := gen_random_uuid();
    v_system := 'water_supply';
    v_summary := 'Consumer ' || NEW.consumer_id || ' — ' || NEW.name;
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, record_data, old_data, system, summary, actor_id, actor_name)
  VALUES (
    TG_TABLE_NAME, v_record_id, v_action, to_jsonb(NEW),
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    v_system, v_summary, current_admin_user_id(), current_admin_name()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS audit_log_bill_change_trigger ON bills;
CREATE TRIGGER audit_log_bill_change_trigger AFTER INSERT OR UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION trg_audit_log_change();

DROP TRIGGER IF EXISTS audit_log_payment_change_trigger ON payments;
CREATE TRIGGER audit_log_payment_change_trigger AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_audit_log_change();

DROP TRIGGER IF EXISTS audit_log_donor_change_trigger ON donors;
CREATE TRIGGER audit_log_donor_change_trigger AFTER INSERT OR UPDATE ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_audit_log_change();

DROP TRIGGER IF EXISTS audit_log_voucher_change_trigger ON vouchers;
CREATE TRIGGER audit_log_voucher_change_trigger AFTER INSERT OR UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_audit_log_change();

DROP TRIGGER IF EXISTS audit_log_account_change_trigger ON accounts;
CREATE TRIGGER audit_log_account_change_trigger AFTER INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION trg_audit_log_change();

DROP TRIGGER IF EXISTS audit_log_consumer_change_trigger ON consumers;
CREATE TRIGGER audit_log_consumer_change_trigger AFTER INSERT OR UPDATE ON consumers
  FOR EACH ROW EXECUTE FUNCTION trg_audit_log_change();

-- Restore: only ever applies to action='delete' rows; admin role needs the
-- can_restore_deleted grant, super_admin always can.
CREATE OR REPLACE FUNCTION restore_deleted_record(p_audit_id uuid) RETURNS void AS $$
DECLARE
  v_row audit_log%ROWTYPE;
BEGIN
  IF NOT (current_admin_role() = 'super_admin' OR (current_admin_role() = 'admin' AND current_admin_permission('restore_deleted'))) THEN
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
