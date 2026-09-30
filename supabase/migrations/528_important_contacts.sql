-- Migration 528: Important Phone Numbers -- Phase 1 of the "Village OS"
-- feature set requested 2026-09-30. One tap to call police/rescue/fire/
-- ambulance/utility complaint lines/union council/village reps, managed
-- by admin staff (no deploy needed to add or change a number), same
-- shape as committee_members (001_schema.sql).
CREATE TABLE important_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label varchar NOT NULL,
  label_ur varchar,
  phone varchar NOT NULL,
  whatsapp_number varchar,
  category varchar NOT NULL DEFAULT 'other'
    CHECK (category IN
      ('police', 'rescue', 'fire', 'ambulance', 'hospital',
       'electricity', 'gas', 'water', 'union_council', 'village_rep', 'other')),
  display_order int DEFAULT 0,
  is_active bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE important_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_active_contacts"
  ON important_contacts FOR SELECT USING (is_active = true);
CREATE POLICY "admin_all_important_contacts" ON important_contacts
  FOR ALL USING (auth.role() = 'authenticated');

-- Seeded with the generic Pakistan-wide numbers so the page isn't empty
-- before the committee fills in their own local ones (union council,
-- village reps, local hospital) -- exactly the same "seed with something
-- real, not a placeholder" convention as every other settings-driven
-- feature this session.
INSERT INTO important_contacts (label, label_ur, phone, category, display_order) VALUES
  ('Police', 'پولیس', '15', 'police', 1),
  ('Rescue 1122', 'ریسکیو 1122', '1122', 'rescue', 2),
  ('Fire Brigade', 'فائر بریگیڈ', '16', 'fire', 3),
  ('Edhi Ambulance', 'ایدھی ایمبولینس', '115', 'ambulance', 4);
