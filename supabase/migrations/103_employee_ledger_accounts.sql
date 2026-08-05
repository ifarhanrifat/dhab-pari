-- Migration 103: Every employee gets a real Chart-of-Accounts ledger account,
-- exactly like consumers and field collectors already do (migration 056's
-- ensure_collector_account is the direct precedent this mirrors). Its running
-- balance is the single source of truth for "what do we currently owe this
-- person" — salary accrual, overtime/bonus/emergency/job earnings, advances,
-- and payments all net through it, the same way a consumer account already
-- nets bills/discounts/payments.
--
-- Debit/credit design:
--   Monthly salary (recurring, unchanged trigger): Dr WS-3001, Cr employee account.
--   Advance given: Dr employee account, Cr Cash/Bank (can go negative).
--   Payslip recognition (overtime/bonus/emergency/job earnings this cycle):
--     Dr the relevant WS-30xx expense account(s), Cr employee account for the total.
--   Payslip payment (whatever is actually paid out now): Dr employee account, Cr Cash/Bank.
-- This replaces the advance_settlement/settles_voucher_id matching used for
-- employees in the previous round — advances now net naturally against the
-- running balance instead of needing an explicit settlement match. WS-4004
-- 'Advance to Employees' is left in place but no longer used for new advances
-- (same "stop using, don't delete" convention as committee_members.can_approve).

INSERT INTO account_headers (system, code, label, code_prefix, display_order, is_system)
VALUES ('water_supply', 'employee', 'Employees Payable', 'WS-EMP', 8, true)
ON CONFLICT (system, code) DO NOTHING;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_employee_id_key ON accounts(employee_id) WHERE employee_id IS NOT NULL;

-- Mirrors ensure_collector_account() (migration 056) exactly.
CREATE OR REPLACE FUNCTION ensure_employee_account(p_employee_id uuid) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_name varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE employee_id = p_employee_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT name INTO v_name FROM employees WHERE id = p_employee_id;
  INSERT INTO accounts (code, name, type, system, employee_id, opening_balance)
  VALUES ('EMP-' || substr(replace(p_employee_id::text, '-', ''), 1, 8), v_name, 'employee', 'water_supply', p_employee_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION ensure_employee_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_employee_account(uuid) TO authenticated;

-- One row per employee per month — what makes "edit the payslip" possible
-- without creating a duplicate voucher each time it's re-opened.
CREATE TABLE IF NOT EXISTS employee_payslips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  year int NOT NULL,
  recognition_voucher_id uuid REFERENCES vouchers(id),
  overtime_amount decimal NOT NULL DEFAULT 0,
  bonus_amount decimal NOT NULL DEFAULT 0,
  emergency_amount decimal NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, month, year)
);
ALTER TABLE employee_payslips ENABLE ROW LEVEL SECURITY;
CREATE POLICY "employee_payslips_read" ON employee_payslips FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
-- All writes go through SECURITY DEFINER functions below (or a plain insert
-- from the client for the first run of a period) — gated the same way
-- vouchers/voucher_line_items already are.
CREATE POLICY "employee_payslips_insert" ON employee_payslips FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));
CREATE POLICY "employee_payslips_update" ON employee_payslips FOR UPDATE TO authenticated
  USING (can_access_system('water_supply')) WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));

-- Mirrors edit_advance() (migration 088): delete the recognition voucher's
-- existing ledger entries + line items, rebuild from the new amounts (plus
-- any job-earning lines already attached, untouched), update amount_pkr, and
-- repost via post_voucher_ledger_legs() — the exact same repost path every
-- other voucher edit already uses, no duplicated posting logic.
CREATE OR REPLACE FUNCTION edit_employee_payslip_recognition(
  p_payslip_id uuid, p_overtime decimal, p_bonus decimal, p_emergency decimal
) RETURNS void AS $$
DECLARE
  v_payslip employee_payslips%ROWTYPE;
  v_voucher vouchers%ROWTYPE;
  v_employee_account_id uuid;
  v_ws3011 uuid; v_ws3012 uuid; v_ws3013 uuid;
  v_new_total decimal;
BEGIN
  IF NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this payslip';
  END IF;

  SELECT * INTO v_payslip FROM employee_payslips WHERE id = p_payslip_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payslip not found'; END IF;
  IF v_payslip.recognition_voucher_id IS NULL THEN RAISE EXCEPTION 'No recognition voucher to edit — save the payslip first'; END IF;

  SELECT * INTO v_voucher FROM vouchers WHERE id = v_payslip.recognition_voucher_id;
  -- No settles_voucher_id/settled_at matching for employees under this
  -- model (advances net against the running account balance instead) — the
  -- real "already paid" guard is whether a payment voucher for this period
  -- already exists.
  IF EXISTS (SELECT 1 FROM vouchers WHERE employee_id = v_payslip.employee_id AND voucher_type = 'expense'
             AND particular LIKE 'Payslip Payment%' AND voucher_date >= make_date(v_payslip.year, v_payslip.month, 1)
             AND voucher_date < (make_date(v_payslip.year, v_payslip.month, 1) + interval '1 month')) THEN
    RAISE EXCEPTION 'This payslip has already been paid out and cannot be edited';
  END IF;

  v_employee_account_id := ensure_employee_account(v_payslip.employee_id);
  SELECT id INTO v_ws3011 FROM accounts WHERE system = 'water_supply' AND code = 'WS-3011';
  SELECT id INTO v_ws3012 FROM accounts WHERE system = 'water_supply' AND code = 'WS-3012';
  SELECT id INTO v_ws3013 FROM accounts WHERE system = 'water_supply' AND code = 'WS-3013';

  DELETE FROM ledger_entries WHERE reference_type = 'voucher' AND reference_id = v_payslip.recognition_voucher_id;
  -- Keep any job-earning (WS-3014) lines already attached — only the
  -- overtime/bonus/emergency lines are staff-editable on the payslip form.
  DELETE FROM voucher_line_items WHERE voucher_id = v_payslip.recognition_voucher_id
    AND account_id IN (v_ws3011, v_ws3012, v_ws3013);

  IF p_overtime > 0 THEN
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description)
    VALUES (v_payslip.recognition_voucher_id, v_ws3012, p_overtime, 'Overtime');
  END IF;
  IF p_bonus > 0 THEN
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description)
    VALUES (v_payslip.recognition_voucher_id, v_ws3011, p_bonus, 'Eid Bonus');
  END IF;
  IF p_emergency > 0 THEN
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description)
    VALUES (v_payslip.recognition_voucher_id, v_ws3013, p_emergency, 'Emergency Work Payment');
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_new_total FROM voucher_line_items WHERE voucher_id = v_payslip.recognition_voucher_id;

  UPDATE vouchers SET amount_pkr = v_new_total WHERE id = v_payslip.recognition_voucher_id RETURNING * INTO v_voucher;
  UPDATE employee_payslips SET overtime_amount = p_overtime, bonus_amount = p_bonus, emergency_amount = p_emergency, updated_at = now() WHERE id = p_payslip_id;

  IF v_voucher.status = 'posted' THEN
    PERFORM post_voucher_ledger_legs(v_voucher);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION edit_employee_payslip_recognition(uuid, decimal, decimal, decimal) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edit_employee_payslip_recognition(uuid, decimal, decimal, decimal) TO authenticated;
