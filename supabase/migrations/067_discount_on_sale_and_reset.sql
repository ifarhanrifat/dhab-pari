-- Migration 067: "Discount on Sale" account (water_supply), splitting a bill's
-- discount posting between "Discount on Bills" (existing WS-3008, the recurring
-- water/service-charge discount) and this new "Discount on Sale" (inventory
-- items sold as part of a bill), proportional to how much of the discountable
-- total came from each side — plus a super-admin-only Reset Accounting System
-- RPC that clears a system's financial transaction history while leaving
-- consumers/donors, inventory stock levels, and the chart of accounts intact.

INSERT INTO accounts (code, name, type, system, description, is_protected) VALUES
  ('WS-3009', 'Discount on Sale', 'expense', 'water_supply', 'Discounts given specifically on inventory items sold as part of a bill, tracked separately from discounts on the recurring water/service charge', true)
ON CONFLICT (code, system) DO NOTHING;

CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_income_account_id uuid;
  v_sales_account_id uuid;
  v_discount_bills_account_id uuid;
  v_discount_sale_account_id uuid;
  v_particular text;
  v_other_charges_total decimal;
  v_inv_service_total decimal;
  v_inventory_total decimal;
  v_income_credit decimal;
  v_discountable_total decimal;
  v_discount_sale decimal;
  v_discount_bills decimal;
  r RECORD;
BEGIN
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  v_particular := 'Water Bill #' || NEW.bill_number || ' - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY');

  DELETE FROM ledger_entries WHERE reference_type = 'bill' AND reference_id = NEW.id;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
  VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), v_particular, NEW.amount_pkr, 0, 'bill', NEW.id, NEW.bill_number);

  SELECT COALESCE(SUM(line_total), 0) INTO v_other_charges_total
  FROM bill_line_items WHERE bill_id = NEW.id AND item_type = 'other_charge';

  FOR r IN
    SELECT charge_account_id, SUM(line_total) AS amt FROM bill_line_items
    WHERE bill_id = NEW.id AND item_type = 'other_charge' AND charge_account_id IS NOT NULL
    GROUP BY charge_account_id
  LOOP
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (r.charge_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, r.amt, 'bill', NEW.id, NEW.bill_number);
  END LOOP;

  SELECT COALESCE(SUM(line_total), 0) INTO v_inv_service_total
  FROM bill_line_items WHERE bill_id = NEW.id AND item_type IN ('inventory', 'service');

  SELECT COALESCE(SUM(line_total), 0) INTO v_inventory_total
  FROM bill_line_items WHERE bill_id = NEW.id AND item_type = 'inventory';

  IF v_inv_service_total > 0 THEN
    SELECT id INTO v_sales_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-2003';
    IF v_sales_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_sales_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, v_inv_service_total, 'bill', NEW.id, NEW.bill_number);
    END IF;
  END IF;

  v_income_credit := NEW.amount_pkr - v_other_charges_total - v_inv_service_total;
  IF v_income_credit > 0 THEN
    SELECT id INTO v_income_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-2001';
    IF v_income_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_income_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, v_income_credit, 'bill', NEW.id, NEW.bill_number);
    END IF;
  END IF;

  -- Discount split: proportional to how much of the discountable total
  -- (everything except other_charge lines, which never carry a discount) came
  -- from inventory items vs. everything else (service/custom/base charge). No
  -- inventory lines on the bill -> 100% posts to "Discount on Bills", identical
  -- to pre-067 behavior, so every existing bill is unaffected.
  IF COALESCE(NEW.discount_amount, 0) > 0 THEN
    v_discountable_total := NEW.amount_pkr - v_other_charges_total;
    IF v_discountable_total > 0 AND v_inventory_total > 0 THEN
      v_discount_sale := ROUND(NEW.discount_amount * v_inventory_total / v_discountable_total, 2);
    ELSE
      v_discount_sale := 0;
    END IF;
    v_discount_bills := NEW.discount_amount - v_discount_sale;

    IF v_discount_sale > 0 THEN
      SELECT id INTO v_discount_sale_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-3009';
      IF v_discount_sale_account_id IS NOT NULL THEN
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
        VALUES (v_discount_sale_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Sale — Bill #' || NEW.bill_number, v_discount_sale, 0, 'bill', NEW.id, NEW.bill_number);
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
        VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Sale — Bill #' || NEW.bill_number, 0, v_discount_sale, 'bill', NEW.id, NEW.bill_number);
      END IF;
    END IF;

    IF v_discount_bills > 0 THEN
      SELECT id INTO v_discount_bills_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-3008';
      IF v_discount_bills_account_id IS NOT NULL THEN
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
        VALUES (v_discount_bills_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Bills — Bill #' || NEW.bill_number, v_discount_bills, 0, 'bill', NEW.id, NEW.bill_number);
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
        VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Bills — Bill #' || NEW.bill_number, 0, v_discount_bills, 'bill', NEW.id, NEW.bill_number);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Reset Accounting System: super-admin-only, clears one system's financial
-- transaction history (ledger entries, bills, vouchers, purchases, inventory
-- movements, recurring schedules, pending approvals) while leaving consumers,
-- inventory stock quantities, and the chart of accounts (headers + protected
-- sub-accounts) completely untouched. water_supply and donors_projects reset
-- independently. Note: donors_projects has no separate "donor person" master
-- record distinct from their donation — each `donors` row already is one
-- donation transaction — so a donors_projects reset does clear the donor list
-- itself, unlike consumers (a true separate person record) on the water_supply
-- side, which are always preserved.
--
-- Deleting bill_line_items normally fires a reversal inventory_transaction
-- (adding stock back) via trg_bill_line_item_change, which would corrupt
-- current stock levels — the opposite of what a reset should do. All relevant
-- triggers are disabled for the duration of the reset; DDL is transactional,
-- so any error here rolls the trigger state back too, same as the deletes.
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

  IF p_system = 'water_supply' THEN
    DELETE FROM bills;  -- cascades to bill_line_items and payments
  ELSE
    DELETE FROM donors;
  END IF;

  DELETE FROM approval_confirmations WHERE approval_request_id IN (SELECT id FROM approval_requests WHERE system = p_system);
  DELETE FROM approval_requests WHERE system = p_system;

  DELETE FROM purchases WHERE system = p_system;  -- cascades to purchase_line_items

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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reset_accounting_system(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_accounting_system(varchar) TO authenticated;
