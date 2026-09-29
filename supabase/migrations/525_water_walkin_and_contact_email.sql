-- Migration 525: two more hardcoded things on the public /water page made
-- admin-editable.
--
-- Real report, 2026-09-29: the walk-in "visit the office" line was pure
-- hardcoded English prose with no Urdu translation at all (an Urdu-mode
-- visitor still saw it in English), and the contact email came from
-- SITE.email -- an env var, changeable only by a developer redeploying,
-- not by the committee. The bank/JazzCash/Easypaisa numbers on that same
-- page already have a real fix (site_settings via getPaymentAccount(),
-- migration 253) that this page simply wasn't using yet -- no new setting
-- needed there, just wiring the page up to read it, same as the portal's
-- own /portal/water page already does.
--
-- Seeded with the current live wording/address so nothing visibly changes
-- until the committee actually edits it in Settings > Office.
INSERT INTO site_settings (key, value, description) VALUES
  ('water_walkin_info_en', 'Visit the Welfare Office near the Central Mosque, 9 AM to 2 PM.',
   'Printed on the public water bill page under "Walk in" -- where and when a consumer can pay in person.'),
  ('water_walkin_info_ur', 'مرکزی مسجد کے قریب ویلفیئر آفس آئیں، صبح 9 بجے سے دوپہر 2 بجے تک۔',
   'Urdu version of water_walkin_info_en, shown when the site is in Urdu mode.'),
  ('contact_email', 'info@dhabpari.org',
   'Shown on the public water bill page''s "Need Help" contact block. Falls back to the site''s default email if left blank.')
ON CONFLICT (key) DO NOTHING;
