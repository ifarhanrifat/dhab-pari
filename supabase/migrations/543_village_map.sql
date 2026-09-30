-- Migration 543: Village Map -- Phase 3 of the "Village OS" feature set,
-- 2026-10-01. Same lesson just learned from the Directory/Marketplace
-- overlap: don't stand up a whole parallel "places" content table that
-- duplicates what Directory already curates (name/description/contact for
-- every business/health/mosque/school). Instead, directory_entries just
-- gets optional coordinates -- any existing entry can be pinned on the
-- map without re-entering its details a second time.
--
-- village_landmarks is only for things Directory has no category for at
-- all (graveyard, park, government/committee office, water supply point,
-- Eid Gah, village entrance) -- genuinely new content, not an overlap.
ALTER TABLE directory_entries ADD COLUMN lat numeric(9,6);
ALTER TABLE directory_entries ADD COLUMN lng numeric(9,6);

CREATE TABLE village_landmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category varchar NOT NULL CHECK (category IN
    ('graveyard', 'park', 'government_office', 'committee_office', 'water_supply', 'eid_gah', 'entrance', 'other')),
  name varchar NOT NULL,
  name_ur varchar,
  description text,
  description_ur text,
  lat numeric(9,6) NOT NULL,
  lng numeric(9,6) NOT NULL,
  photo_url text,
  display_order int DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE village_landmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "village_landmarks_public_read" ON village_landmarks FOR SELECT USING (is_active = true);
CREATE POLICY "village_landmarks_staff_all" ON village_landmarks FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
