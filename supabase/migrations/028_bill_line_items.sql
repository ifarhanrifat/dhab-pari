-- Migration 028: Itemized bills — inventory and service line items, so a bill can
-- be built from real charges (a meter issued, an installation service, a repair
-- visit) instead of only ever being one flat monthly rate. Adding an inventory line
-- deducts stock and posts its COGS automatically (via the existing inventory
-- transaction trigger from migration 026); the bill's amount_pkr becomes the sum of
-- its line items minus any discount, once it has any — a bill with no line items
-- keeps working exactly as before (a plain manually-entered amount).
--
-- Also adds the consumer profile fields needed for the redesigned "new consumer"
-- form: father/husband name, a WhatsApp number that can default to the same as the
-- mobile number, and a per-bill discount/waiver.

ALTER TABLE consumers ADD COLUMN IF NOT EXISTS father_husband_name varchar;
ALTER TABLE consumers ADD COLUMN IF NOT EXISTS whatsapp_number varchar;
ALTER TABLE consumers ADD COLUMN IF NOT EXISTS whatsapp_same_as_mobile boolean NOT NULL DEFAULT true;

ALTER TABLE bills ADD COLUMN IF NOT EXISTS discount_amount decimal NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);

CREATE TABLE IF NOT EXISTS bill_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  item_type varchar NOT NULL CHECK (item_type IN ('inventory', 'service', 'custom')),
  inventory_item_id uuid REFERENCES inventory_items(id),
  service_item_id uuid REFERENCES service_items(id),
  description varchar NOT NULL,
  quantity decimal NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price decimal NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total decimal GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at timestamptz DEFAULT now(),
  CHECK (
    (item_type = 'inventory' AND inventory_item_id IS NOT NULL) OR
    (item_type = 'service' AND service_item_id IS NOT NULL) OR
    (item_type = 'custom' AND inventory_item_id IS NULL AND service_item_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS bill_line_items_bill_idx ON bill_line_items(bill_id);

CREATE OR REPLACE FUNCTION trg_bill_line_item_change() RETURNS trigger AS $$
DECLARE
  v_bill_id uuid := COALESCE(NEW.bill_id, OLD.bill_id);
  v_sum decimal;
  v_discount decimal;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.item_type = 'inventory' THEN
    INSERT INTO inventory_transactions (item_id, txn_type, quantity, unit_cost_at_time, reference_type, reference_id, note)
    SELECT NEW.inventory_item_id, 'usage', -NEW.quantity, unit_cost, 'bill', NEW.bill_id, 'Issued via bill line item'
    FROM inventory_items WHERE id = NEW.inventory_item_id;
  ELSIF TG_OP = 'DELETE' AND OLD.item_type = 'inventory' THEN
    INSERT INTO inventory_transactions (item_id, txn_type, quantity, unit_cost_at_time, reference_type, reference_id, note)
    SELECT OLD.inventory_item_id, 'adjustment', OLD.quantity, unit_cost, 'bill', OLD.bill_id, 'Reversed — bill line item removed'
    FROM inventory_items WHERE id = OLD.inventory_item_id;
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_sum FROM bill_line_items WHERE bill_id = v_bill_id;
  SELECT discount_amount INTO v_discount FROM bills WHERE id = v_bill_id;
  IF v_sum > 0 THEN
    UPDATE bills SET amount_pkr = GREATEST(v_sum - COALESCE(v_discount, 0), 0) WHERE id = v_bill_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS bill_line_item_change_trigger ON bill_line_items;
CREATE TRIGGER bill_line_item_change_trigger AFTER INSERT OR DELETE ON bill_line_items
  FOR EACH ROW EXECUTE FUNCTION trg_bill_line_item_change();

ALTER TABLE bill_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bill_line_items_read" ON bill_line_items FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "bill_line_items_write" ON bill_line_items FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));
CREATE POLICY "bill_line_items_delete" ON bill_line_items FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('delete_transactions'));
