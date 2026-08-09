-- Migration 174: the green contact box's wording was hardcoded in
-- docTranslations.ts, so changing "Call or WhatsApp this number for any water
-- supply issue" meant a code change and a deploy. Move it into site_settings,
-- separately for each system, seeded with exactly the wording already in use so
-- nothing on a printed slip changes the day this lands.
--
-- Each label is stored as an English/Urdu pair rather than one string: the slip
-- prints them on their own rows (different fonts, different text direction), so
-- they can never be one field.
--
-- Blank is meaningful. An empty value falls back to the built-in wording rather
-- than printing an empty row — and a blank donor value does NOT inherit the
-- water supply's, for the same reason the instructions note doesn't: prose
-- written about water has no business on a donation receipt.

INSERT INTO site_settings (key, value, description) VALUES
  -- Water supply / shared
  ('helpline_label_en', 'Call or WhatsApp this number for any water supply issue',
   'Green contact box: English line above the helpline number. Blank uses the built-in wording.'),
  ('helpline_label_ur', 'کسی بھی واٹر سپلائی مسئلے کے لیے اس نمبر پر کال یا واٹس ایپ کریں',
   'Green contact box: Urdu line above the helpline number.'),
  ('complaint_label_en', 'Complaint', 'Green contact box: English label before the complaint number.'),
  ('complaint_label_ur', 'شکایت', 'Green contact box: Urdu label before the complaint number.'),

  -- Donors & Projects
  ('donor_helpline_label_en', 'Call or WhatsApp this number for any donation issue',
   'Donor receipts: English line above the helpline number. Blank uses the built-in donation wording.'),
  ('donor_helpline_label_ur', 'کسی بھی عطیہ سے متعلق مسئلے کے لیے اس نمبر پر کال یا واٹس ایپ کریں',
   'Donor receipts: Urdu line above the helpline number.'),
  ('donor_complaint_label_en', 'Complaint', 'Donor receipts: English label before the complaint number.'),
  ('donor_complaint_label_ur', 'شکایت', 'Donor receipts: Urdu label before the complaint number.')
ON CONFLICT (key) DO NOTHING;
