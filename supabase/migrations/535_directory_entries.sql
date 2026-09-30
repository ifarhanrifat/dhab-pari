-- Migration 535: generic Directory system -- Phase 3 of the "Village OS"
-- feature set, 2026-09-30. One table/page powers Business, Health,
-- Mosques, and Schools instead of four bespoke ones -- they're all really
-- the same shape (a searchable entity with name/location/contact/hours).
--
-- Admin-curated, not portal-user-submitted (unlike Lost & Found/Buy &
-- Sell/etc) -- these are meant to be verified, official entries (a real
-- clinic, a real mosque), same trust model as committee_members
-- (001_schema.sql), so no approval queue: staff add/edit directly.
CREATE TABLE directory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category varchar NOT NULL CHECK (category IN ('business', 'health', 'mosque', 'school')),
  subcategory varchar,
  name varchar NOT NULL,
  name_ur varchar,
  description text,
  description_ur text,
  location_text varchar,
  phone varchar,
  whatsapp_number varchar,
  hours_text varchar,
  photo_url text,
  display_order int DEFAULT 0,
  is_active bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX directory_entries_browse_idx ON directory_entries(category) WHERE is_active = true;

ALTER TABLE directory_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_active_directory_entries"
  ON directory_entries FOR SELECT USING (is_active = true);
CREATE POLICY "admin_all_directory_entries" ON directory_entries
  FOR ALL USING (auth.role() = 'authenticated');
