-- Migration 026: Inventory items + stock ledger + COGS posting.
--
-- Buying stock (a pump, meters, pipe) is a balance-sheet event, not an expense —
-- it debits a new "Inventory Stock" asset account and credits cash/bank. Only when
-- that stock is actually issued against a consumer bill does its cost hit the P&L,
-- via a Cost of Goods Sold expense account credited out of Inventory Stock at the
-- unit cost — kept separate from the bill's own revenue-side posting (at selling
-- price) so gross margin is visible in reports rather than collapsed into one number.

CREATE SEQUENCE IF NOT EXISTS inventory_item_no_seq START 1;
CREATE OR REPLACE FUNCTION next_inventory_item_code() RETURNS varchar AS $$
  SELECT 'INV-' || lpad(nextval('inventory_item_no_seq')::text, 5, '0');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL DEFAULT 'water_supply' CHECK (system IN ('water_supply', 'donors_projects')),
  item_code varchar UNIQUE,
  name varchar NOT NULL,
  unit varchar NOT NULL DEFAULT 'piece',
  unit_cost decimal NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  unit_price decimal NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  quantity_on_hand decimal NOT NULL DEFAULT 0,
  reorder_level decimal NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION trg_inventory_item_assign_code() RETURNS trigger AS $$
BEGIN
  IF NEW.item_code IS NULL THEN
    NEW.item_code := next_inventory_item_code();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_item_assign_code_trigger ON inventory_items;
CREATE TRIGGER inventory_item_assign_code_trigger BEFORE INSERT ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION trg_inventory_item_assign_code();

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  txn_type varchar NOT NULL CHECK (txn_type IN ('purchase', 'usage', 'adjustment')),
  quantity decimal NOT NULL,
  unit_cost_at_time decimal,
  reference_type varchar CHECK (reference_type IN ('bill', 'voucher', 'manual')),
  reference_id uuid,
  txn_date date NOT NULL DEFAULT current_date,
  method varchar CHECK (method IN ('cash', 'bank')),
  note text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_transactions_item_idx ON inventory_transactions(item_id, txn_date);

-- New protected default accounts (one per system) for inventory + COGS — under the
-- existing asset/expense headers, no new header needed.
INSERT INTO accounts (code, name, type, system, description, is_protected)
VALUES
  ('WS-4002', 'Inventory Stock', 'asset', 'water_supply', 'Water meters, pipes, fittings and other stock on hand', true),
  ('WS-3007', 'Cost of Goods Sold', 'expense', 'water_supply', 'Cost of inventory issued against consumer bills', true),
  ('DP-4002', 'Inventory Stock', 'asset', 'donors_projects', 'Project materials and equipment stock on hand', true),
  ('DP-3004', 'Cost of Goods Sold', 'expense', 'donors_projects', 'Cost of inventory issued against project work', true)
ON CONFLICT (code, system) DO NOTHING;

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
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, 'voucher', NEW.id);

    SELECT id INTO v_cash_account_id FROM accounts
    WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN
      (CASE WHEN NEW.method = 'bank' THEN 'WS-1002' ELSE 'WS-1001' END)
    ELSE
      (CASE WHEN NEW.method = 'bank' THEN 'DP-1002' ELSE 'DP-1001' END)
    END);
    IF v_cash_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
      VALUES (v_cash_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 'voucher', NEW.id);
    END IF;

  ELSIF NEW.txn_type = 'usage' THEN
    v_particular := 'Inventory issued — ' || v_item.name || ' x' || (-NEW.quantity) || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, (-NEW.quantity) * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), 0, NEW.reference_type, NEW.reference_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, 0, (-NEW.quantity) * COALESCE(NEW.unit_cost_at_time, v_item.unit_cost), NEW.reference_type, NEW.reference_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS inventory_txn_apply_trigger ON inventory_transactions;
CREATE TRIGGER inventory_txn_apply_trigger AFTER INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_inventory_txn_apply();

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inventory_items_read" ON inventory_items FOR SELECT TO authenticated USING (can_access_system(system));
CREATE POLICY "inventory_items_write" ON inventory_items FOR INSERT TO authenticated WITH CHECK (can_access_system(system) AND current_admin_permission('manage_accounts'));
CREATE POLICY "inventory_items_update" ON inventory_items FOR UPDATE TO authenticated USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('edit_accounts'));
CREATE POLICY "inventory_items_delete" ON inventory_items FOR DELETE TO authenticated USING (can_access_system(system) AND current_admin_permission('delete_accounts'));

CREATE POLICY "inventory_transactions_read" ON inventory_transactions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM inventory_items i WHERE i.id = item_id AND can_access_system(i.system)));
CREATE POLICY "inventory_transactions_write" ON inventory_transactions FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM inventory_items i WHERE i.id = item_id AND can_access_system(i.system) AND current_admin_permission('post_transactions')));
