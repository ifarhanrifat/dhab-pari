-- Migration 316: found via a rollback-safe transaction test (not another
-- live guess) — payments.bill_id -> bills is RESTRICT, not the CASCADE
-- migration 067's own comment assumed, so deleting bills before payments
-- always failed once real payments existed. bill_payment_claims.
-- created_payment_id -> payments is also NO ACTION, blocking payments in
-- turn. Full corrected sequence verified in a BEGIN/ROLLBACK transaction
-- before this migration was written — connection_requests, then
-- bill_payment_claims, then payments, then bills.
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
  ALTER TABLE bill_payment_claims DISABLE TRIGGER USER;

  IF p_system = 'water_supply' THEN
    DELETE FROM connection_requests WHERE true;  -- cascades connection_request_items; unblocks bills/payments/vouchers/recurring_schedules
    DELETE FROM bill_payment_claims WHERE true;  -- unblocks payments (created_payment_id NO ACTION)
    DELETE FROM payments WHERE true;  -- unblocks bills (payments.bill_id is RESTRICT, not CASCADE)
    DELETE FROM bills WHERE true;  -- cascades to bill_line_items (bill_payment_claims already cleared above)
  ELSE
    DELETE FROM donors WHERE true;
  END IF;

  DELETE FROM approval_confirmations WHERE approval_request_id IN (SELECT id FROM approval_requests WHERE system = p_system);
  DELETE FROM approval_requests WHERE system = p_system;

  DELETE FROM purchases WHERE system = p_system;  -- cascades to purchase_line_items

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
  ALTER TABLE bill_payment_claims ENABLE TRIGGER USER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
