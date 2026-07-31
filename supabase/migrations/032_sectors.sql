-- Migration 032: Sectors as a real, admin-managed reference table instead of
-- free-typed text on each consumer — keeps sector names consistent and lets new
-- consumers be assigned via a dropdown instead of retyping (and potentially
-- mistyping/duplicating) a sector name.

CREATE TABLE IF NOT EXISTS sectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL UNIQUE,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

INSERT INTO sectors (name, display_order)
SELECT DISTINCT sector, 0 FROM consumers WHERE sector IS NOT NULL AND trim(sector) != ''
ON CONFLICT (name) DO NOTHING;

ALTER TABLE sectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_sectors" ON sectors FOR SELECT USING (true);
CREATE POLICY "sectors_write" ON sectors FOR INSERT TO authenticated WITH CHECK (current_admin_permission('manage_accounts'));
CREATE POLICY "sectors_update" ON sectors FOR UPDATE TO authenticated USING (true) WITH CHECK (current_admin_permission('edit_accounts'));
CREATE POLICY "sectors_delete" ON sectors FOR DELETE TO authenticated USING (current_admin_permission('delete_accounts'));
