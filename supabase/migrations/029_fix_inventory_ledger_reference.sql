-- Migration 029: Fix a real bug caught in live testing — inventory usage (COGS)
-- ledger entries were tagged reference_type='bill', reference_id=<the bill id>,
-- the exact same tuple trg_bill_ledger() uses for its delete-then-reinsert-on-edit
-- pattern (DELETE FROM ledger_entries WHERE reference_type='bill' AND
-- reference_id=NEW.id, then reinsert its own 2 rows). The moment a bill's amount
-- got recomputed from its line items (an UPDATE on bills, which is exactly what
-- adding a line item triggers), that cleanup silently wiped out the just-inserted
-- COGS entries as collateral damage, since they matched the same lookup tuple but
-- weren't reinserted by that function (it only knows about its own 2 rows).
--
-- Fix: inventory-driven ledger entries now always use reference_type='inventory'
-- with reference_id pointing at the inventory_transactions row itself — never at
-- whatever bill/voucher triggered them — so they can never collide with another
-- table's own reference-based cleanup logic.

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_reference_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_reference_type_check
  CHECK (reference_type IN ('bill', 'payment', 'donation', 'manual', 'voucher', 'inventory'));

CREATE OR REPLACE FUNCTION trg_inventory_txn_apply() RETURNS trigger AS $$
DECLARE
  v_item inventory_items%ROWTYPE;
  v_stock_account_id uuid;
  v_cogs_account_id uuid;
  v_cash_account_id uuid;
  v_system varchar;
  v_particular text;
BEGIN
  SELECT * INTO v_item FROM inventory_items WHERE id = NEW.item_id FOR UPDATE;
  IF NEW.txn_type = 'usage' AND v_item.quantity_on_hand + NEW.quantity < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for %: % on hand, % requested', v_item.name, v_item.quantity_on_hand, -NEW.quantity;
  END IF;

  UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + NEW.quantity WHERE id = NEW.item_id;

  v_system := v_item.system;
  SELECT id INTO v_stock_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-4002' ELSE 'DP-4002' END);

  IF NEW.txn_type = 'purchase' THEN
    v_particular := 'Inventory purchase — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, 'inventory', NEW.id);

    SELECT id INTO v_cash_account_id FROM accounts
    WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN
      (CASE WHEN NEW.method = 'bank' THEN 'WS-1002' ELSE 'WS-1001' END)
    ELSE
      (CASE WHEN NEW.method = 'bank' THEN 'DP-1002' ELSE 'DP-1001' END)
    END);
    IF v_cash_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
      VALUES (v_cash_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 'inventory', NEW.id);
    END IF;

  ELSIF NEW.txn_type IN ('usage', 'adjustment') AND NEW.quantity < 0 THEN
    v_particular := 'Inventory issued — ' || v_item.name || ' x' || (-NEW.quantity) || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, (-NEW.quantity) * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, 'inventory', NEW.id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, 0, (-NEW.quantity) * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 'inventory', NEW.id);

  ELSIF NEW.txn_type = 'adjustment' AND NEW.quantity > 0 THEN
    -- A positive adjustment (e.g. reversing a removed bill line item) restores
    -- stock and reverses the COGS posting — credit COGS, debit Inventory Stock.
    v_particular := 'Inventory restored — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, 'inventory', NEW.id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 'inventory', NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The bill_line_item trigger no longer needs to pass a reference_type/reference_id
-- through to inventory_transactions for ledger purposes (trg_inventory_txn_apply
-- now always self-references), but reference_type/reference_id on the
-- inventory_transactions row itself is still useful provenance (which bill caused
-- this stock movement) — kept as-is, just no longer echoed into ledger_entries.
