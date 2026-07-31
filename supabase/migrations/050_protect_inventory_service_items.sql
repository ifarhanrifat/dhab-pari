-- Migration 050: Deleting an inventory item or service that's already been used in
-- a transaction (a bill line item, a connection template, or a stock movement)
-- silently orphaned those references — no different from deleting a bill with
-- payments still attached, which is already blocked. Guard both the same way:
-- raise a clear error naming what's still using it instead of allowing the delete.

CREATE OR REPLACE FUNCTION trg_protect_inventory_item_delete() RETURNS trigger AS $$
DECLARE
  v_txn_count int;
  v_line_count int;
  v_tmpl_count int;
BEGIN
  SELECT count(*) INTO v_txn_count FROM inventory_transactions WHERE item_id = OLD.id;
  SELECT count(*) INTO v_line_count FROM bill_line_items WHERE inventory_item_id = OLD.id;
  SELECT count(*) INTO v_tmpl_count FROM connection_template_items WHERE inventory_item_id = OLD.id;
  IF v_txn_count > 0 OR v_line_count > 0 OR v_tmpl_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete "%" — it has been used in % stock transaction(s), % bill(s), and % connection template(s). Deactivate it instead.',
      OLD.name, v_txn_count, v_line_count, v_tmpl_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_inventory_item_delete_trigger ON inventory_items;
CREATE TRIGGER protect_inventory_item_delete_trigger BEFORE DELETE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION trg_protect_inventory_item_delete();

CREATE OR REPLACE FUNCTION trg_protect_service_item_delete() RETURNS trigger AS $$
DECLARE
  v_line_count int;
  v_tmpl_count int;
BEGIN
  SELECT count(*) INTO v_line_count FROM bill_line_items WHERE service_item_id = OLD.id;
  SELECT count(*) INTO v_tmpl_count FROM connection_template_items WHERE service_item_id = OLD.id;
  IF v_line_count > 0 OR v_tmpl_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete "%" — it has been used in % bill(s) and % connection template(s). Deactivate it instead.',
      OLD.name, v_line_count, v_tmpl_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_service_item_delete_trigger ON service_items;
CREATE TRIGGER protect_service_item_delete_trigger BEFORE DELETE ON service_items
  FOR EACH ROW EXECUTE FUNCTION trg_protect_service_item_delete();
