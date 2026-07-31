-- Migration 053: File attachments for bills and purchase bills — an attachments
-- storage bucket, an attachment_url column on bills, and a lightweight
-- "purchases" header table (a purchase bill previously had no single row of its
-- own — each line item just created its own independent inventory_transactions
-- row) so a purchase can carry one attachment the same way a bill does.

INSERT INTO storage.buckets (id, name, public)
VALUES ('attachments', 'attachments', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read attachments"
ON storage.objects FOR SELECT
USING (bucket_id = 'attachments');

CREATE POLICY "Auth upload attachments"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'attachments' AND auth.role() = 'authenticated');

CREATE POLICY "Auth delete attachments"
ON storage.objects FOR DELETE
USING (bucket_id = 'attachments' AND auth.role() = 'authenticated');

ALTER TABLE bills ADD COLUMN IF NOT EXISTS attachment_url text;

CREATE TABLE IF NOT EXISTS purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  vendor varchar,
  purchase_date date NOT NULL DEFAULT current_date,
  method varchar NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank')),
  note text,
  attachment_url text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS purchase_id uuid REFERENCES purchases(id) ON DELETE SET NULL;

ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "purchases_read" ON purchases FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "purchases_write" ON purchases FOR INSERT TO authenticated
  WITH CHECK (can_access_system(system) AND current_admin_permission('post_transactions'));
CREATE POLICY "purchases_delete" ON purchases FOR DELETE TO authenticated
  USING (can_access_system(system) AND current_admin_permission('delete_transactions'));
