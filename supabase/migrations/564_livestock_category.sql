-- Migration 564: Livestock category for the Agriculture Hub -- 2026-10-02.
--
-- Real ask: a Livestock section "like ChatGPT suggested" (animal health,
-- vaccination, vet contacts, feed, breeding) -- scoped down the same way
-- the rest of the hub was: no marketplace, no livestock buyer-matching,
-- no forms. Buying/selling animals already has a real home (Classifieds'
-- 'animals' category, with animal_type/age/weight fields) -- the public
-- page just points there, same as the existing crop buy/sell pointer.
--
-- One new table for health/vaccination/feed/breeding awareness (same
-- shape as ag_disease_guides, generalized from "disease" to "topic" so
-- one table covers all of those instead of three near-identical ones).
-- Veterinary contacts reuse ag_help_centers rather than a new table --
-- same shape (name/what they offer/phone/address), just tagged by
-- category so the same admin screen and table serve both Agriculture and
-- Livestock contacts.
CREATE TABLE ag_livestock_guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal varchar NOT NULL, animal_ur varchar NOT NULL,
  topic_name varchar NOT NULL, topic_name_ur varchar NOT NULL,
  details text, details_ur text,
  timing text, timing_ur text,
  care_tips text, care_tips_ur text,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ag_livestock_guides_animal_idx ON ag_livestock_guides(animal);

ALTER TABLE ag_livestock_guides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ag_livestock_guides_public_read" ON ag_livestock_guides FOR SELECT USING (is_active = true);
CREATE POLICY "ag_livestock_guides_staff_all" ON ag_livestock_guides FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

ALTER TABLE ag_help_centers ADD COLUMN category varchar NOT NULL DEFAULT 'agriculture' CHECK (category IN ('agriculture', 'livestock'));
