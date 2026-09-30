-- Migration 536: a "Committee" category for Important Contacts -- real
-- ask, 2026-09-30 ("if we add the committee help number there will be a
-- committee emergency label heading there"). Closest existing category
-- was village_rep, which is really a different thing (a named person
-- representing the village) from a general committee contact line.
ALTER TABLE important_contacts DROP CONSTRAINT important_contacts_category_check;
ALTER TABLE important_contacts ADD CONSTRAINT important_contacts_category_check
  CHECK (category IN
    ('police', 'rescue', 'fire', 'ambulance', 'hospital',
     'electricity', 'gas', 'water', 'union_council', 'village_rep', 'committee', 'other'));
