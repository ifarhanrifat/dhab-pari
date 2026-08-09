-- Migration 172: settings for the Universal Slip — one document design that
-- renders both A4 and 58/80mm thermal, with bilingual labels, admin-tunable
-- type sizes, and branded contact icons.
--
-- Why these live in site_settings rather than on each transaction: a slip is
-- re-rendered from the record every time it's viewed, so header/footer/type
-- settings must be read at render time. Copying them onto records would freeze
-- old receipts to whatever the wording was the day they were created.

INSERT INTO site_settings (key, value, description) VALUES
  -- 'both' prints English and Urdu side by side (Donation Received / عطیہ وصولی),
  -- which is what stops the two languages fighting for the same slot. 'en'/'ur'
  -- print one language only. Applies to the Universal Slip; the ten legacy
  -- skins keep following display_language as before.
  ('slip_display_mode', 'both',
   'Universal Slip label language: both (English + Urdu side by side), en, or ur.'),

  -- Type scale. Three tiers, matching the three regions of the slip, so the
  -- committee can size the document for their own printer and eyesight without
  -- anyone touching code.
  ('slip_font_heading', '21', 'Universal Slip: heading/title font size in px (organisation name, document title).'),
  ('slip_font_body', '14',    'Universal Slip: data font size in px (names, amounts, line items).'),
  ('slip_font_footer', '12',  'Universal Slip: bottom section font size in px (notes, helpline, links).'),

  -- Default print target per audience. A runtime picker still overrides this on
  -- any individual slip — this only decides which button is pre-selected, so
  -- field collectors on a Bluetooth printer and the office on A4 each get their
  -- own sensible default.
  ('slip_format_water', 'a4',    'Default print/attachment format for water supply consumers: a4 or thermal.'),
  ('slip_format_donor', 'a4',    'Default print/attachment format for donors: a4 or thermal.'),

  -- The icon row at the bottom needs a website entry; Facebook/WhatsApp/
  -- projects/donate/email already have keys from earlier migrations.
  ('footer_website_link', 'https://dhabpari.com', 'Website link shown in the slip footer icon row.'),
  ('donor_footer_website_link', '', 'Donor override for the website link. Blank falls back to the shared one.')
ON CONFLICT (key) DO NOTHING;
