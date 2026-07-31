-- Migration 054: Proper Sales/COGS separation and weighted-average inventory
-- costing, closing the gap where a bill's inventory/service line items posted
-- their revenue into the generic "Water Bill Income" bucket (COGS was already
-- split out correctly since migration 026 — only the revenue side was missing),
-- and where unit_cost was a single manually-typed scalar with no cost-averaging
-- across purchases at different prices.

INSERT INTO accounts (code, name, type, system, description, is_protected) VALUES
  ('WS-2003', 'Inventory & Service Sales', 'income', 'water_supply', 'Revenue from inventory items and services billed to consumers — separate from the recurring base water charge', true),
  ('DP-2004', 'Inventory & Service Sales', 'income', 'donors_projects', 'Revenue from inventory items and services billed', true)
ON CONFLICT (code, system) DO NOTHING;

-- Inventory/service line items now credit "Inventory & Service Sales" instead of
-- the generic Water Bill Income account — the base/custom charges are the only
-- thing left crediting Water Bill Income. "Other charge" routing (migration 052)
-- is unchanged.
CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_income_account_id uuid;
  v_sales_account_id uuid;
  v_discount_account_id uuid;
  v_particular text;
  v_other_charges_total decimal;
  v_inv_service_total decimal;
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

  SELECT COALESCE(SUM(line_total), 0) INTO v_inv_service_total
  FROM bill_line_items WHERE bill_id = NEW.id AND item_type IN ('inventory', 'service');

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

-- Weighted-average costing: a purchase blends its cost into the item's running
-- average (old_qty*old_cost + new_qty*new_cost) / total_qty, so unit_cost always
-- reflects the real blended cost of stock on hand — COGS on a later usage then
-- uses that up-to-date average instead of a manually-typed number that goes stale
-- the moment purchase prices change. The ledger posting for THIS purchase still
-- uses the actual price paid (unit_cost_at_time), only the item's running
-- unit_cost (used for future usage/COGS) becomes the average. Usage/adjustment
-- never change unit_cost — only a purchase does.
CREATE OR REPLACE FUNCTION trg_inventory_txn_apply() RETURNS trigger AS $$
DECLARE
  v_item inventory_items%ROWTYPE;
  v_stock_account_id uuid;
  v_cogs_account_id uuid;
  v_cash_account_id uuid;
  v_system varchar;
  v_particular text;
  v_bill_number varchar;
  v_txn_cost decimal;
  v_new_avg_cost decimal;
BEGIN
  SELECT * INTO v_item FROM inventory_items WHERE id = NEW.item_id FOR UPDATE;
  IF NEW.txn_type = 'usage' AND v_item.quantity_on_hand + NEW.quantity < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for %: % on hand, % requested', v_item.name, v_item.quantity_on_hand, -NEW.quantity;
  END IF;

  IF NEW.txn_type = 'purchase' THEN
    v_txn_cost := COALESCE(NEW.unit_cost_at_time, v_item.unit_cost);
    IF (v_item.quantity_on_hand + NEW.quantity) > 0 THEN
      v_new_avg_cost := (v_item.quantity_on_hand * v_item.unit_cost + NEW.quantity * v_txn_cost) / (v_item.quantity_on_hand + NEW.quantity);
    ELSE
      v_new_avg_cost := v_txn_cost;
    END IF;
    UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + NEW.quantity, unit_cost = v_new_avg_cost WHERE id = NEW.item_id;
  ELSE
    v_txn_cost := COALESCE(NEW.unit_cost_at_time, v_item.unit_cost);
    UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + NEW.quantity WHERE id = NEW.item_id;
  END IF;

  v_system := v_item.system;
  SELECT id INTO v_stock_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-4002' ELSE 'DP-4002' END);

  IF NEW.reference_type = 'bill' AND NEW.reference_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = NEW.reference_id;
  END IF;

  IF NEW.txn_type = 'purchase' THEN
    v_particular := 'Inventory purchase — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * v_txn_cost, 0, 'inventory', NEW.id, v_bill_number);

    SELECT id INTO v_cash_account_id FROM accounts
    WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN
      (CASE WHEN NEW.method = 'bank' THEN 'WS-1002' ELSE 'WS-1001' END)
    ELSE
      (CASE WHEN NEW.method = 'bank' THEN 'DP-1002' ELSE 'DP-1001' END)
    END);
    IF v_cash_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_cash_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * v_txn_cost, 'inventory', NEW.id, v_bill_number);
    END IF;

  ELSIF NEW.txn_type IN ('usage', 'adjustment') AND NEW.quantity < 0 THEN
    v_particular := 'Inventory issued — ' || v_item.name || ' x' || (-NEW.quantity) || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, (-NEW.quantity) * v_txn_cost, 0, 'inventory', NEW.id, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, 0, (-NEW.quantity) * v_txn_cost, 'inventory', NEW.id, v_bill_number);

  ELSIF NEW.txn_type = 'adjustment' AND NEW.quantity > 0 THEN
    v_particular := 'Inventory restored — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * v_txn_cost, 0, 'inventory', NEW.id, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * v_txn_cost, 'inventory', NEW.id, v_bill_number);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
