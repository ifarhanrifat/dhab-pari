-- Migration 308: softcode the portal's "how to use" guidance — same move as
-- migration 307 did for the homepage welfare cards, applied to the portal
-- side of the same four features.
--
-- Two blocks:
--
-- 1. The sponsorship-pool guide ("How this works — please read before you
--    join"), shown identically on the Kafalat, Wazifa and Esal-e-Sawab
--    portal pages — it's one shared mechanic, not three separate ones, so
--    editing it here changes it on all three at once.
-- 2. The Zakat portal page's own "why you don't pick a recipient / who it
--    reaches" explanation, which has no pool mechanic and isn't shared.
--
-- Seeded with the current wording from messages.ts (pool.how.*, pool.promise*,
-- pzk.*) so nothing on the portal changes until an admin actually edits a
-- field in Settings.
INSERT INTO site_settings (key, value, description) VALUES
  ('pool_how_title_en', 'How this works — please read before you join', 'Sponsorship pool guide (Kafalat/Wazifa/Esal-e-Sawab portal pages) — panel title (English).'),
  ('pool_how_title_ur', $g$یہ نظام کیسے کام کرتا ہے — شامل ہونے سے پہلے ضرور پڑھیں$g$, 'Sponsorship pool guide — panel title (Urdu).'),

  ('pool_how_what_q_en', 'What am I agreeing to?', 'Pool guide, question 1 (English).'),
  ('pool_how_what_q_ur', $g$میں کس بات کا وعدہ کر رہا ہوں؟$g$, 'Pool guide, question 1 (Urdu).'),
  ('pool_how_what_urdu_line', $g$آپ ہر ماہ ایک مقررہ رقم دینے کا ارادہ ظاہر کرتے ہیں۔ یہ کوئی قانونی معاہدہ نہیں۔$g$, 'Pool guide, question 1 — short Urdu answer line, always shown in Urdu regardless of the visitor''s language.'),
  ('pool_how_what_answer_en', 'You are stating an intention to give a fixed amount each month. It is not a legal contract and nothing is ever taken from your account automatically — you send it yourself, the way you send any donation.', 'Pool guide, question 1 — full answer (English).'),
  ('pool_how_what_answer_ur', $g$یہ صرف ایک ارادہ ہے، قانونی معاہدہ نہیں۔ آپ کے اکاؤنٹ سے خودکار طور پر کچھ نہیں کٹے گا — رقم آپ خود بھیجتے ہیں۔$g$, 'Pool guide, question 1 — full answer (Urdu).'),

  ('pool_how_amount_q_en', 'Can my amount be increased later?', 'Pool guide, question 2 (English).'),
  ('pool_how_amount_q_ur', $g$کیا بعد میں میری رقم بڑھائی جا سکتی ہے؟$g$, 'Pool guide, question 2 (Urdu).'),
  ('pool_how_amount_urdu_line', $g$کبھی نہیں۔ آپ کی رقم صرف آپ خود بدل سکتے ہیں۔$g$, 'Pool guide, question 2 — short Urdu answer line, always shown in Urdu.'),
  ('pool_how_amount_answer_en', 'Never without you. If somebody else stops giving, we ask new people to join — we do not quietly raise what you already agreed to. Only you can change your amount, on this page.', 'Pool guide, question 2 — full answer (English).'),
  ('pool_how_amount_answer_ur', $g$اگر کوئی اور دینا چھوڑ دے تو ہم نئے ساتھیوں کو دعوت دیتے ہیں — آپ کی طے شدہ رقم خاموشی سے نہیں بڑھاتے۔$g$, 'Pool guide, question 2 — full answer (Urdu).'),

  ('pool_how_when_q_en', 'When do I pay?', 'Pool guide, question 3 (English).'),
  ('pool_how_when_q_ur', $g$میں کب ادائیگی کروں؟$g$, 'Pool guide, question 3 (Urdu).'),
  ('pool_how_when_urdu_line', $g$ہر مہینے، جس تاریخ کو آپ کے لیے آسان ہو۔$g$, 'Pool guide, question 3 — short Urdu answer line, always shown in Urdu.'),
  ('pool_how_when_answer_en', 'Any time within the month, by cash, bank transfer, JazzCash or EasyPaisa. The accountant records it against your name and it appears in your giving statement.', 'Pool guide, question 3 — full answer (English).'),
  ('pool_how_when_answer_ur', $g$نقد، بینک ٹرانسفر، جاز کیش یا ایزی پیسہ کے ذریعے۔ اکاؤنٹنٹ اسے آپ کے نام درج کرتا ہے اور یہ آپ کے گوشوارے میں نظر آتا ہے۔$g$, 'Pool guide, question 3 — full answer (Urdu).'),

  ('pool_how_stop_q_en', 'What if I need to stop?', 'Pool guide, question 4 (English).'),
  ('pool_how_stop_q_ur', $g$اگر مجھے بند کرنا پڑے تو؟$g$, 'Pool guide, question 4 (Urdu).'),
  ('pool_how_stop_urdu_line', $g$ایک کلک سے، بغیر کسی وضاحت کے۔$g$, 'Pool guide, question 4 — short Urdu answer line, always shown in Urdu.'),
  ('pool_how_stop_answer_en', 'Stop any time from this page, with no explanation asked for. If a month goes by without a payment we simply mark your share as paused — nobody will chase you, and you can start again whenever you want.', 'Pool guide, question 4 — full answer (English).'),
  ('pool_how_stop_answer_ur', $g$کسی بھی وقت بند کر سکتے ہیں۔ اگر ایک مہینہ ادائیگی نہ ہو تو آپ کا حصہ عارضی طور پر روک دیا جاتا ہے — کوئی تقاضا نہیں کرے گا۔$g$, 'Pool guide, question 4 — full answer (Urdu).'),

  ('pool_how_short_q_en', 'What if not enough people join?', 'Pool guide, question 5 (English).'),
  ('pool_how_short_q_ur', $g$اگر کافی لوگ شامل نہ ہوں تو؟$g$, 'Pool guide, question 5 (Urdu).'),
  ('pool_how_short_urdu_line', $g$کمیٹی اپنے فنڈ سے وہ مہینہ پورا کرتی ہے تاکہ کسی بچے کی تعلیم نہ رکے۔$g$, 'Pool guide, question 5 — short Urdu answer line, always shown in Urdu.'),
  ('pool_how_short_answer_en', 'The committee covers that month from its own general funds so that no child is stopped mid-year. That is a one-off for the month it happens and cannot be repeated indefinitely, which is why the appeal keeps running until enough people have joined.', 'Pool guide, question 5 — full answer (English).'),
  ('pool_how_short_answer_ur', $g$یہ صرف اُسی ایک مہینے کے لیے ہوتا ہے اور بار بار ممکن نہیں — اسی لیے اپیل اُس وقت تک جاری رہتی ہے جب تک ضروری ساتھی شامل نہ ہو جائیں۔$g$, 'Pool guide, question 5 — full answer (Urdu).'),

  ('pool_how_privacy_q_en', 'Will people know what I give?', 'Pool guide, question 6 (English).'),
  ('pool_how_privacy_q_ur', $g$کیا لوگوں کو میری رقم کا علم ہوگا؟$g$, 'Pool guide, question 6 (Urdu).'),
  ('pool_how_privacy_urdu_line', $g$نہیں۔ صرف آپ اور اکاؤنٹنٹ کو معلوم ہوگا۔$g$, 'Pool guide, question 6 — short Urdu answer line, always shown in Urdu.'),
  ('pool_how_privacy_answer_en', 'No. Only you and the donor accountant can see your amount. Nobody else in the village sees who gives what, and you can give anonymously if you prefer.', 'Pool guide, question 6 — full answer (English).'),
  ('pool_how_privacy_answer_ur', $g$گاؤں میں کسی اور کو معلوم نہیں ہوتا کہ کون کتنا دیتا ہے، اور آپ چاہیں تو نام ظاہر کیے بغیر بھی دے سکتے ہیں۔$g$, 'Pool guide, question 6 — full answer (Urdu).'),

  ('pool_promise_urdu_line', $g$آپ کی طے شدہ رقم آپ کی اجازت کے بغیر کبھی نہیں بڑھائی جائے گی۔$g$, 'Pool guide — closing promise, always shown in Urdu regardless of the visitor''s language.'),
  ('pool_promise_en', 'Your agreed amount is never changed without you. What changes is the share we suggest to the next person who joins.', 'Pool guide — closing promise (English).'),
  ('pool_promise_ur', $g$جو تبدیل ہوتا ہے وہ صرف نئے شامل ہونے والوں کے لیے تجویز کردہ حصہ ہے۔$g$, 'Pool guide — closing promise (Urdu).'),

  ('pzk_blurb_en', 'Give into the pool, and a verified register decides the split by a rule fixed before collection began.', 'Zakat portal page — intro blurb under the page title (English).'),
  ('pzk_blurb_ur', $g$فنڈ میں دیں، اور تصدیق شدہ رجسٹر ایک ایسے اصول پر تقسیم کرے جو وصولی سے پہلے طے ہو چکا تھا۔$g$, 'Zakat portal page — intro blurb under the page title (Urdu).'),
  ('pzk_why_urdu_line', $g$اکثر زکوٰۃ ایک ہی نظر آنے والے حاجت مند تک بار بار پہنچتی ہے اور باقی محروم رہ جاتے ہیں۔ اسی لیے یہاں دینے والا وصول کرنے والا نہیں چنتا۔ کمیٹی گھر گھر جا کر تصدیق کرتی ہے اور رقم طے شدہ اصول پر برابر تقسیم ہوتی ہے۔$g$, 'Zakat portal page — "why you don''t pick a recipient" note. Always shown in Urdu, paired with the English line below, regardless of which language is selected.'),
  ('pzk_why_english_line', 'You do not choose a recipient, and that is the feature rather than a limitation — it is what stops one visible family receiving everything while others receive nothing.', 'Zakat portal page — the English half of the same "why" note. Always shown in English, paired with the Urdu line above.'),
  ('pzk_who_it_reaches_en', 'Who it reaches', 'Zakat portal page — "who it reaches" section heading (English).'),
  ('pzk_who_it_reaches_ur', $g$یہ کن تک پہنچتی ہے$g$, 'Zakat portal page — "who it reaches" section heading (Urdu).'),
  ('pzk_who_it_reaches_help_en', 'Counts only. No household on the register is ever named to a donor.', 'Zakat portal page — note under the "who it reaches" heading (English).'),
  ('pzk_who_it_reaches_help_ur', $g$صرف تعداد۔ رجسٹر کے کسی گھرانے کا نام کسی عطیہ دہندہ کو نہیں بتایا جاتا۔$g$, 'Zakat portal page — note under the "who it reaches" heading (Urdu).')
ON CONFLICT (key) DO NOTHING;
