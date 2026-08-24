-- Migration 317: reset_accounting_system() left two categories of
-- "identity" data behind that migration 067's own design comment actually
-- intended to clear for donors_projects (it just didn't know the accounts
-- table held them): the persistent per-donor accounts.type='donor' rows
-- (created by ensure_donor_account() the first time each name+phone was
-- seen) and, on the water_supply side, consumer records once their
-- payment/bill history is gone (trg_protect_consumer_delete, migration 176,
-- already refuses to delete a consumer with real history — this only ever
-- succeeds once that history is actually cleared, which is now true by the
-- time this runs).
--
-- Both categories preserve the thing that actually matters — a real
-- person's portal login — by nulling portal_users.donor_account_id /
-- consumer_id rather than ever touching portal_users itself.
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
  ALTER TABLE consumers DISABLE TRIGGER USER;

  IF p_system = 'water_supply' THEN
    DELETE FROM connection_requests WHERE true;
    DELETE FROM bill_payment_claims WHERE true;
    DELETE FROM payments WHERE true;
    DELETE FROM bills WHERE true;
  ELSE
    DELETE FROM donors WHERE true;
  END IF;

  DELETE FROM approval_confirmations WHERE approval_request_id IN (SELECT id FROM approval_requests WHERE system = p_system);
  DELETE FROM approval_requests WHERE system = p_system;

  DELETE FROM purchases WHERE system = p_system;

  UPDATE employee_payslips SET recognition_voucher_id = NULL
  WHERE recognition_voucher_id IN (SELECT id FROM vouchers WHERE system = p_system);

  DELETE FROM vouchers WHERE system = p_system;

  DELETE FROM inventory_transactions WHERE item_id IN (SELECT id FROM inventory_items WHERE system = p_system);

  DELETE FROM recurring_schedules WHERE system = p_system;

  DELETE FROM ledger_entries WHERE account_id IN (SELECT id FROM accounts WHERE system = p_system);

  UPDATE accounts SET opening_balance = 0 WHERE system = p_system;

  IF p_system = 'donors_projects' THEN
    -- The persistent per-donor identity accounts — a real person's portal
    -- login is preserved, just unlinked; ensure_donor_account() creates a
    -- fresh one automatically the next time they give for real.
    UPDATE portal_users SET donor_account_id = NULL
    WHERE donor_account_id IN (SELECT id FROM accounts WHERE system = 'donors_projects' AND type = 'donor');
    UPDATE collector_settlements SET to_account_id = NULL
    WHERE to_account_id IN (SELECT id FROM accounts WHERE system = 'donors_projects' AND type = 'donor');
    DELETE FROM accounts WHERE system = 'donors_projects' AND type = 'donor';
  ELSE
    -- Consumer records — trg_protect_consumer_delete (176) already refuses
    -- any consumer with real bill/payment/voucher history; by this point
    -- in the function that history is gone, so this only ever removes
    -- consumers that are now genuinely history-free. A real complaint stays
    -- on record with its consumer link cleared rather than being deleted.
    UPDATE portal_users SET consumer_id = NULL WHERE consumer_id IN (SELECT consumer_id FROM consumers);
    UPDATE complaints SET consumer_id = NULL WHERE consumer_id IN (SELECT consumer_id FROM consumers);
    DELETE FROM reminder_queue WHERE consumer_id IN (SELECT consumer_id FROM consumers);
    DELETE FROM consumers WHERE true;
  END IF;

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
  ALTER TABLE consumers ENABLE TRIGGER USER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
