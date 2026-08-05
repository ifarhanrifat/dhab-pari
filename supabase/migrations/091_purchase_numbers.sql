-- Migration 091: purchases (whether created from Inventory's quick "shopping"
-- restock or the Transactions page's Purchase Bill flow — same table, same
-- purchase_line_items/inventory_transactions posting) have never had a
-- document number at all, unlike bills (bill_number) and vouchers
-- (voucher_no). Same auto-assign-on-insert pattern as migration 018's
-- bill_number.
CREATE SEQUENCE IF NOT EXISTS purchase_no_seq START 1;
CREATE OR REPLACE FUNCTION next_purchase_no() RETURNS varchar AS $$
  SELECT 'PUR-' || lpad(nextval('purchase_no_seq')::text, 5, '0');
$$ LANGUAGE sql;

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_number varchar UNIQUE;

CREATE OR REPLACE FUNCTION trg_purchase_assign_number() RETURNS trigger AS $$
BEGIN
  IF NEW.purchase_number IS NULL THEN
    NEW.purchase_number := next_purchase_no();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS purchase_assign_number_trigger ON purchases;
CREATE TRIGGER purchase_assign_number_trigger BEFORE INSERT ON purchases
  FOR EACH ROW EXECUTE FUNCTION trg_purchase_assign_number();

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM purchases WHERE purchase_number IS NULL ORDER BY created_at, id LOOP
    UPDATE purchases SET purchase_number = next_purchase_no() WHERE id = r.id;
  END LOOP;
END $$;
