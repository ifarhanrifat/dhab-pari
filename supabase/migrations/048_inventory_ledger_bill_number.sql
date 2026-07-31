-- Migration 048: Inventory usage tied to a bill (a meter issued against a specific
-- consumer invoice) never carried that bill's number onto its own ledger entries —
-- migration 029 made the ledger reference self-referencing (reference_type='inventory')
-- to fix a delete-collision bug, but that meant the bill linkage, still recorded on
-- inventory_transactions.reference_id itself, was never looked up and echoed onto
-- bill_number the way every other bill-related ledger row already shows it.

CREATE OR REPLACE FUNCTION trg_inventory_txn_apply() RETURNS trigger AS $$
DECLARE
  v_item inventory_items%ROWTYPE;
  v_stock_account_id uuid;
  v_cogs_account_id uuid;
  v_cash_account_id uuid;
  v_system varchar;
  v_particular text;
  v_bill_number varchar;
BEGIN
  SELECT * INTO v_item FROM inventory_items WHERE id = NEW.item_id FOR UPDATE;
  IF NEW.txn_type = 'usage' AND v_item.quantity_on_hand + NEW.quantity < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for %: % on hand, % requested', v_item.name, v_item.quantity_on_hand, -NEW.quantity;
  END IF;

  UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + NEW.quantity WHERE id = NEW.item_id;

  v_system := v_item.system;
  SELECT id INTO v_stock_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-4002' ELSE 'DP-4002' END);

  IF NEW.reference_type = 'bill' AND NEW.reference_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = NEW.reference_id;
  END IF;

  IF NEW.txn_type = 'purchase' THEN
    v_particular := 'Inventory purchase — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, 'inventory', NEW.id, v_bill_number);

    SELECT id INTO v_cash_account_id FROM accounts
    WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN
      (CASE WHEN NEW.method = 'bank' THEN 'WS-1002' ELSE 'WS-1001' END)
    ELSE
      (CASE WHEN NEW.method = 'bank' THEN 'DP-1002' ELSE 'DP-1001' END)
    END);
    IF v_cash_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_cash_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 'inventory', NEW.id, v_bill_number);
    END IF;

  ELSIF NEW.txn_type IN ('usage', 'adjustment') AND NEW.quantity < 0 THEN
    v_particular := 'Inventory issued — ' || v_item.name || ' x' || (-NEW.quantity) || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, (-NEW.quantity) * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, 'inventory', NEW.id, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, 0, (-NEW.quantity) * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 'inventory', NEW.id, v_bill_number);

  ELSIF NEW.txn_type = 'adjustment' AND NEW.quantity > 0 THEN
    -- A positive adjustment (e.g. reversing a removed bill line item) restores
    -- stock and reverses the COGS that was booked when it was issued.
    v_particular := 'Inventory restored — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, 'inventory', NEW.id, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 'inventory', NEW.id, v_bill_number);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill: any existing inventory-driven ledger row whose inventory_transactions
-- record already points at a bill gets that bill's number retroactively.
UPDATE ledger_entries le SET bill_number = b.bill_number
FROM inventory_transactions it JOIN bills b ON b.id = it.reference_id AND it.reference_type = 'bill'
WHERE le.reference_type = 'inventory' AND le.reference_id = it.id AND le.bill_number IS NULL;
