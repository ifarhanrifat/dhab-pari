-- Migration 300: a bill's own Description field (Generate Bill form) never
-- made it into the ledger. trg_bill_ledger built its particular purely from
-- the bill number and billing period — the accountant could type a real
-- description ("Repair charge included", "Reconnection after settlement",
-- whatever explains this specific bill) and it would save to bills.description
-- and show on Recent/All Transactions (which read it separately, in JS) but
-- never appear on the actual ledger — Chart of Accounts, Daily Register,
-- Reports, the printed receipt — which all read ledger_entries.particular.
--
-- Appended the same way trg_payment_ledger (migration 089) already appends a
-- payment's note: " — {description}" only when one was actually given, so
-- every existing bill's particular is completely unchanged.
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
  v_particular := 'Water Bill #' || NEW.bill_number || ' - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY')
    || CASE WHEN NEW.description IS NOT NULL AND trim(NEW.description) != '' THEN ' — ' || NEW.description ELSE '' END;

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
