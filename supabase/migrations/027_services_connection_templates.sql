-- Migration 027: Service items (chargeable labour/service lines, no stock behind
-- them) and connection templates — the bundle of inventory items + services that
-- gets auto-applied when a new consumer's connection count is set, so the bill
-- amount doesn't have to be manually worked out every time.

CREATE SEQUENCE IF NOT EXISTS service_item_no_seq START 1;
CREATE OR REPLACE FUNCTION next_service_item_code() RETURNS varchar AS $$
  SELECT 'SVC-' || lpad(nextval('service_item_no_seq')::text, 5, '0');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS service_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL DEFAULT 'water_supply' CHECK (system IN ('water_supply', 'donors_projects')),
  service_code varchar UNIQUE,
  name varchar NOT NULL,
  charge_amount decimal NOT NULL DEFAULT 0 CHECK (charge_amount >= 0),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION trg_service_item_assign_code() RETURNS trigger AS $$
BEGIN
  IF NEW.service_code IS NULL THEN
    NEW.service_code := next_service_item_code();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS service_item_assign_code_trigger ON service_items;
CREATE TRIGGER service_item_assign_code_trigger BEFORE INSERT ON service_items
  FOR EACH ROW EXECUTE FUNCTION trg_service_item_assign_code();

CREATE TABLE IF NOT EXISTS connection_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL DEFAULT 'water_supply' CHECK (system IN ('water_supply', 'donors_projects')),
  name varchar NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);
-- Only one default bundle per system — the one auto-applied to new connections.
CREATE UNIQUE INDEX IF NOT EXISTS connection_templates_one_default_per_system
  ON connection_templates(system) WHERE is_default;

CREATE TABLE IF NOT EXISTS connection_template_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES connection_templates(id) ON DELETE CASCADE,
  item_type varchar NOT NULL CHECK (item_type IN ('inventory', 'service')),
  inventory_item_id uuid REFERENCES inventory_items(id),
  service_item_id uuid REFERENCES service_items(id),
  quantity decimal NOT NULL DEFAULT 1 CHECK (quantity > 0),
  CHECK (
    (item_type = 'inventory' AND inventory_item_id IS NOT NULL AND service_item_id IS NULL) OR
    (item_type = 'service' AND service_item_id IS NOT NULL AND inventory_item_id IS NULL)
  )
);

ALTER TABLE service_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_template_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_items_read" ON service_items FOR SELECT TO authenticated USING (can_access_system(system));
CREATE POLICY "service_items_write" ON service_items FOR INSERT TO authenticated WITH CHECK (can_access_system(system) AND current_admin_permission('manage_accounts'));
CREATE POLICY "service_items_update" ON service_items FOR UPDATE TO authenticated USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('edit_accounts'));
CREATE POLICY "service_items_delete" ON service_items FOR DELETE TO authenticated USING (can_access_system(system) AND current_admin_permission('delete_accounts'));

CREATE POLICY "connection_templates_read" ON connection_templates FOR SELECT TO authenticated USING (can_access_system(system));
CREATE POLICY "connection_templates_write" ON connection_templates FOR INSERT TO authenticated WITH CHECK (can_access_system(system) AND current_admin_permission('manage_accounts'));
CREATE POLICY "connection_templates_update" ON connection_templates FOR UPDATE TO authenticated USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('edit_accounts'));
CREATE POLICY "connection_templates_delete" ON connection_templates FOR DELETE TO authenticated USING (can_access_system(system) AND current_admin_permission('delete_accounts'));

CREATE POLICY "connection_template_items_read" ON connection_template_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM connection_templates t WHERE t.id = template_id AND can_access_system(t.system)));
CREATE POLICY "connection_template_items_write" ON connection_template_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM connection_templates t WHERE t.id = template_id AND can_access_system(t.system) AND current_admin_permission('manage_accounts')))
  WITH CHECK (EXISTS (SELECT 1 FROM connection_templates t WHERE t.id = template_id AND can_access_system(t.system) AND current_admin_permission('manage_accounts')));

-- Seed one starter template for water_supply so the "auto-extract charges from
-- connection count" behaviour has something to compute against out of the box.
INSERT INTO connection_templates (system, name, is_default)
SELECT 'water_supply', 'Standard Connection', true
WHERE NOT EXISTS (SELECT 1 FROM connection_templates WHERE system = 'water_supply' AND is_default);
