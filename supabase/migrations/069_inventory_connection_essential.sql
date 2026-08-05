-- Marks an inventory item as required equipment for a new water connection
-- installation. Simpler and more direct than routing through
-- connection_templates (which stays as-is for its own existing use on the
-- Generate Bill page) — the New Connections form just pulls every item
-- flagged here, straight from the Inventory page where stock is managed.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_connection_essential boolean NOT NULL DEFAULT false;
