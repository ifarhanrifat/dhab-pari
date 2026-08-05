-- Migration 102: Employee advances, monthly payslip settlement for linked
-- plumber/digging job earnings, and configurable HR roles.
--
-- Advances reuse the existing Advance/Advance Settlement machinery (migration
-- 083/090/097) verbatim — single-leg 'advance' voucher to give one, a draft
-- 'advance_settlement' voucher + voucher_line_items + finalize_voucher() to
-- settle one. Advances post to a new asset account (not the Salary expense
-- account — posting an advance as an expense would double-count it once the
-- real salary posts too) and a linked plumber/digging job's earning posts to
-- its own labor-cost expense account (distinct from the WS-2004/2005 income
-- accounts the consumer was billed to).

INSERT INTO accounts (code, name, type, system, description, is_protected) VALUES
  ('WS-4004', 'Advance to Employees', 'asset', 'water_supply', 'Cash advanced to an employee before it is netted against a payslip', true),
  ('WS-3014', 'Plumber/Digging Labor Cost', 'expense', 'water_supply', 'Paid to the employee who did a new-connection plumbing/digging job (distinct from the WS-2004/2005 income the consumer was billed)', true)
ON CONFLICT (code, system) DO NOTHING;

-- Marks a job's plumber/digging charge as paid out to the employee once a
-- payslip settles it, so it's never paid twice.
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS employee_charge_settled_at timestamptz;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS employee_charge_voucher_id uuid REFERENCES vouchers(id);

-- Configurable HR roles — was a hardcoded CHECK on employees.primary_role/
-- secondary_role (migration 101); adding a new role needed a migration every
-- time. Seeded with the same 4 roles/labels migration 101 already used.
CREATE TABLE IF NOT EXISTS employee_roles (
  key varchar PRIMARY KEY,
  label_en varchar NOT NULL,
  label_ur varchar NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE employee_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "employee_roles_read" ON employee_roles FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "employee_roles_write" ON employee_roles FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('manage_parties'));
CREATE POLICY "employee_roles_update" ON employee_roles FOR UPDATE TO authenticated
  USING (can_access_system('water_supply')) WITH CHECK (can_access_system('water_supply') AND current_admin_permission('manage_parties'));

INSERT INTO employee_roles (key, label_en, label_ur) VALUES
  ('plumber', 'Plumber', 'پلمبر'),
  ('water_well_operator', 'Water Well Operator', 'واٹر ویل آپریٹر'),
  ('night_security_guard', 'Night Security Guard', 'نائٹ سیکیورٹی گارڈ'),
  ('valve_operator', 'Valve Operator', 'والو آپریٹر')
ON CONFLICT (key) DO NOTHING;

-- The primary_role CHECK is named employees_primary_role_check (single-column
-- inline constraint, auto-named); the secondary_role one is a two-column
-- CHECK (secondary_role differs from primary_role too) so Postgres named it
-- generically employees_check, not employees_secondary_role_check — confirmed
-- against the live schema rather than guessed.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_primary_role_check;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_check;
ALTER TABLE employees ADD CONSTRAINT employees_primary_role_fkey FOREIGN KEY (primary_role) REFERENCES employee_roles(key);
ALTER TABLE employees ADD CONSTRAINT employees_secondary_role_fkey FOREIGN KEY (secondary_role) REFERENCES employee_roles(key);
ALTER TABLE employees ADD CONSTRAINT employees_secondary_role_distinct_check CHECK (secondary_role IS NULL OR secondary_role IS DISTINCT FROM primary_role);

-- post_voucher_ledger_legs — unchanged from migration 097 except the
-- advance_settlement branch's v_advance_account_id lookup, which was
-- hardcoded to WS-4003 (`WHERE code = 'WS-4003'`) — silently wrong for any
-- advance posted against a different account, like the new WS-4004. Reading
-- it straight off the original advance voucher's own to_account_id is
-- correct for both, and every other advance account added in the future.
CREATE OR REPLACE FUNCTION post_voucher_ledger_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_bill_number varchar;
  v_line_total decimal;
  v_advance_amount decimal;
  v_diff decimal;
  v_advance_account_id uuid;
  r RECORD;
BEGIN
  IF p_voucher.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = p_voucher.bill_id;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher.id;

  IF p_voucher.voucher_type = 'advance_settlement' THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;

    SELECT amount_pkr, to_account_id INTO v_advance_amount, v_advance_account_id FROM vouchers WHERE id = p_voucher.settles_voucher_id;
    v_diff := v_advance_amount - v_line_total; -- > 0: refund received; < 0: extra paid

    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_advance_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_advance_amount, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);

    IF v_diff > 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, v_diff, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    ELSIF v_diff < 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, -v_diff, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END IF;

    UPDATE vouchers SET settled_at = now() WHERE id = p_voucher.settles_voucher_id;

  ELSIF v_line_total > 0 THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_line_total, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);

  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, p_voucher.particular, p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
  END IF;

  IF p_voucher.voucher_type = 'complaint_waiver' AND p_voucher.bill_id IS NOT NULL THEN
    UPDATE bills b SET
      paid_amount = COALESCE(b.paid_amount, 0) + p_voucher.amount_pkr,
      status = CASE
        WHEN COALESCE(b.paid_amount, 0) + p_voucher.amount_pkr >= (b.amount_pkr - COALESCE(b.discount_amount, 0)) THEN 'paid'
        WHEN COALESCE(b.paid_amount, 0) + p_voucher.amount_pkr > 0 THEN 'partial'
        ELSE b.status
      END
    WHERE b.id = p_voucher.bill_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
