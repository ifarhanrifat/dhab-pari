-- Migration 315: reset_accounting_system('water_supply') hit a real FK
-- block live — "This can't be removed because other records still refer to
-- it" — from two tables 067 never accounted for:
--   connection_requests.bill_id/payment_id/recurring_schedule_id -> NO
--     ACTION. A new-connection application referencing a bill blocks
--     deleting that bill. Cleared first (cascades connection_request_items).
--   employee_payslips.recognition_voucher_id -> vouchers, NO ACTION. A
--     payroll recognition bonus referencing a voucher blocks deleting that
--     voucher. The payslip itself is real payroll history and must not be
--     deleted — only the voucher link is nulled, in both system branches
--     since which system a recognition voucher posts under isn't fixed.
CREATE OR REPLACE FUNCTION reset_accounting_system(p_system varchar) RETURNS void AS $$
BEGIN
  IF NOT current_admin_is_super_admin() THEN
    RAISE EXCEPTION 'Only a Super Admin can reset the accounting system';
  END IF;
  IF p_system NOT IN ('water_supply', 'donors_projects') THEN
    RAISE EXCEPTION 'Invalid system: %', p_system;
  END IF;

  ALTER TABLE bill_line_items DISABLE TRIGGER USER;
  ALTER TABLE bills DISABLE TRIGGER USER;
  ALTER TABLE payments DISABLE TRIGGER USER;
  ALTER TABLE vouchers DISABLE TRIGGER USER;
  ALTER TABLE purchases DISABLE TRIGGER USER;
  ALTER TABLE purchase_line_items DISABLE TRIGGER USER;
  ALTER TABLE inventory_transactions DISABLE TRIGGER USER;
  ALTER TABLE donors DISABLE TRIGGER USER;
  ALTER TABLE connection_requests DISABLE TRIGGER USER;
  ALTER TABLE connection_request_items DISABLE TRIGGER USER;

  IF p_system = 'water_supply' THEN
    DELETE FROM connection_requests WHERE true;  -- cascades connection_request_items; unblocks bills
    DELETE FROM bills WHERE true;  -- cascades to bill_line_items and payments
  ELSE
    DELETE FROM donors WHERE true;
  END IF;

  DELETE FROM approval_confirmations WHERE approval_request_id IN (SELECT id FROM approval_requests WHERE system = p_system);
  DELETE FROM approval_requests WHERE system = p_system;

  DELETE FROM purchases WHERE system = p_system;  -- cascades to purchase_line_items

  -- A payroll recognition bonus's voucher link — real payslip stays, only
  -- the reference to a voucher we're about to delete is cleared.
  UPDATE employee_payslips SET recognition_voucher_id = NULL
  WHERE recognition_voucher_id IN (SELECT id FROM vouchers WHERE system = p_system);

  DELETE FROM vouchers WHERE system = p_system;

  DELETE FROM inventory_transactions WHERE item_id IN (SELECT id FROM inventory_items WHERE system = p_system);

  DELETE FROM recurring_schedules WHERE system = p_system;

  DELETE FROM ledger_entries WHERE account_id IN (SELECT id FROM accounts WHERE system = p_system);

  UPDATE accounts SET opening_balance = 0 WHERE system = p_system;

  ALTER TABLE bill_line_items ENABLE TRIGGER USER;
  ALTER TABLE bills ENABLE TRIGGER USER;
  ALTER TABLE payments ENABLE TRIGGER USER;
  ALTER TABLE vouchers ENABLE TRIGGER USER;
  ALTER TABLE purchases ENABLE TRIGGER USER;
  ALTER TABLE purchase_line_items ENABLE TRIGGER USER;
  ALTER TABLE inventory_transactions ENABLE TRIGGER USER;
  ALTER TABLE donors ENABLE TRIGGER USER;
  ALTER TABLE connection_requests ENABLE TRIGGER USER;
  ALTER TABLE connection_request_items ENABLE TRIGGER USER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
