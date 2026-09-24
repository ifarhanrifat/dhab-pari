-- Migration 508: real Urdu translations for the public About page's
-- about_text/vision/mission settings.
--
-- Real report with a screenshot, 2026-09-25: the About page's history
-- paragraphs got real Urdu translations in an earlier pass, but these three
-- site_settings values never had an _ur counterpart at all -- so a site set
-- to Urdu still fell back to plain English for the About/Vision/Mission
-- paragraphs, with the trailing English punctuation visibly bidi-reordered
-- inside the page's RTL paragraph context (a stray "." rendering before the
-- sentence instead of after it -- fixed separately in the page itself by
-- wrapping any remaining English fallback in its own dir="ltr").
--
-- ON CONFLICT DO NOTHING, same as every other seed insert in this file --
-- an admin who already customized about_text/vision/mission keeps their own
-- wording; this only ever adds the new Urdu row alongside it.
INSERT INTO site_settings (key, value, description) VALUES
  ('about_text_ur', 'ڈھاب پڑی گاؤں کی خوشحالی اور بہبود کے لیے وقف، شفاف انتظام، جدید واٹر سسٹمز اور باہمی تعاون کے ذریعے۔', 'About section description (Urdu) — public About page'),
  ('vision_ur', 'صاف پانی، معیاری تعلیم اور جدید بنیادی ڈھانچے کے ساتھ ہر گھرانے کے لیے ایک خودکفیل گاؤں۔', 'Vision statement (Urdu) — public About page'),
  ('mission_ur', 'شفاف نظم و نسق، پانی کے مؤثر انتظام اور اجتماعی کوششوں کے ذریعے کمیونٹی پر مبنی ترقی فراہم کرنا۔', 'Mission statement (Urdu) — public About page')
ON CONFLICT (key) DO NOTHING;
