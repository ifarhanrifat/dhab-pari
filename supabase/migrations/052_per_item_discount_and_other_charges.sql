-- Migration 052: Per-item discount fields (display/audit — the bill-level
-- discount_amount already posts correctly and is unchanged) and "other charges"
-- (e.g. cartage, a new-connection fee) that route to their own chosen income
-- account instead of blending into the generic Water Bill Income account —
-- matches the reference invoicing flow's "Add Other Charge" categorized picker.

ALTER TABLE bill_line_items ADD COLUMN IF NOT EXISTS discount_pct decimal NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100);
ALTER TABLE bill_line_items ADD COLUMN IF NOT EXISTS discount_value decimal NOT NULL DEFAULT 0 CHECK (discount_value >= 0);
ALTER TABLE bill_line_items ADD COLUMN IF NOT EXISTS charge_account_id uuid REFERENCES accounts(id);

ALTER TABLE bill_line_items DROP CONSTRAINT IF EXISTS bill_line_items_item_type_check;
ALTER TABLE bill_line_items ADD CONSTRAINT bill_line_items_item_type_check
  CHECK (item_type IN ('inventory', 'service', 'custom', 'other_charge'));

ALTER TABLE bill_line_items DROP CONSTRAINT IF EXISTS bill_line_items_check;
ALTER TABLE bill_line_items ADD CONSTRAINT bill_line_items_check
  CHECK (
    (item_type = 'inventory' AND inventory_item_id IS NOT NULL AND charge_account_id IS NULL) OR
    (item_type = 'service' AND service_item_id IS NOT NULL AND charge_account_id IS NULL) OR
    (item_type = 'custom' AND inventory_item_id IS NULL AND service_item_id IS NULL AND charge_account_id IS NULL) OR
    (item_type = 'other_charge' AND charge_account_id IS NOT NULL AND inventory_item_id IS NULL AND service_item_id IS NULL)
  );

-- Other-charge lines credit their own chosen account instead of the generic
-- Water Bill Income account. The consumer's own debit is untouched (still one
-- gross line for the full amount_pkr) — only the income side is split by
-- category, so e.g. a "Cartage Charged" or "New Connection Fee" line shows up
-- in its own account in reports rather than being blended into one bucket.
CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_income_account_id uuid;
  v_discount_account_id uuid;
  v_particular text;
  v_other_charges_total decimal;
  v_income_credit decimal;
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

  v_income_credit := NEW.amount_pkr - v_other_charges_total;
  IF v_income_credit > 0 THEN
    SELECT id INTO v_income_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-2001';
    IF v_income_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_income_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, v_income_credit, 'bill', NEW.id, NEW.bill_number);
    END IF;
  END IF;

  IF COALESCE(NEW.discount_amount, 0) > 0 THEN
    SELECT id INTO v_discount_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-3008';
    IF v_discount_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_discount_account_id, make_date(NEW.year, NEW.month, 1), 'Discount — Bill #' || NEW.bill_number, NEW.discount_amount, 0, 'bill', NEW.id, NEW.bill_number);
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), 'Discount — Bill #' || NEW.bill_number, 0, NEW.discount_amount, 'bill', NEW.id, NEW.bill_number);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
