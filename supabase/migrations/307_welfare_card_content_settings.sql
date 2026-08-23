-- Migration 307: move the four homepage welfare cards' copy (Zakat,
-- Kafalat, Taleemi Wazifa, Esal-e-Sawab) out of messages.ts and into
-- site_settings, editable from Settings without a code deploy.
--
-- Everything else on the card — the two figures in the corners — is real
-- data (needs_register_summary/public_kafalat_summary/public_wazifa_summary/
-- public_sadqa_board), never text, so it stays exactly as it is. Only the
-- words are moved here.
--
-- Seeded with the current wording from messages.ts (hw.zakat.*, hw.kafalat.*,
-- hw.wazifa.*, hw.esal.* — both language tables) so nothing on the homepage
-- changes the moment this ships; the admin only sees a difference once they
-- actually edit a field in Settings.
--
-- Field shape, per card (matches WelfareCards.tsx's own fields):
--   {card}_tab_en / _ur      — the short name on the card's header band
--   {card}_headline_ur       — the big poetic Urdu line, shown regardless
--                              of which language the visitor has selected
--                              (this is deliberate — see WelfareCards.tsx)
--   {card}_motto_en / _ur    — the shorter heading line under it
--   {card}_body_en / _ur     — the explanation paragraph
--   {card}_how_en / _ur      — the "how it works" note in the grey box
--   {card}_cta_en / _ur      — the link text at the bottom
--   {card}_stat1_en / _ur    — label under the left-hand figure
--   {card}_stat2_en / _ur    — label under the right-hand figure
INSERT INTO site_settings (key, value, description) VALUES
  ('zakat_tab_en', 'Zakat & Ushr', 'Zakat card — short name shown in the card header (English).'),
  ('zakat_tab_ur', $g$زکوٰۃ و عشر$g$, 'Zakat card — short name shown in the card header (Urdu).'),
  ('zakat_headline_ur', $g$آپ کی زکوٰۃ ایک دروازے پر نہیں، ہر مستحق گھر تک$g$, 'Zakat card — the big Urdu line at the top of the card body. Always shown in Urdu, even when the site is set to English.'),
  ('zakat_motto_en', 'Your zakat reaches every deserving door — not the same one twice.', 'Zakat card — the heading line under the Urdu headline (English).'),
  ('zakat_motto_ur', $g$آپ کی زکوٰۃ ہر مستحق گھر تک$g$, 'Zakat card — the heading line under the Urdu headline (Urdu).'),
  ('zakat_body_en', 'Zakat usually reaches the one family everybody can see, again and again, while others are never reached at all. Here nobody chooses a recipient: the committee visits and verifies, and a rule fixed before collection divides it.', 'Zakat card — explanation paragraph (English).'),
  ('zakat_body_ur', $g$زکوٰۃ اکثر اسی ایک نظر آنے والے خاندان تک بار بار پہنچتی ہے اور باقی محروم رہ جاتے ہیں۔ یہاں وصول کنندہ کوئی نہیں چنتا: کمیٹی جا کر تصدیق کرتی ہے، اور وصولی سے پہلے طے شدہ اصول پر تقسیم ہوتی ہے۔$g$, 'Zakat card — explanation paragraph (Urdu).'),
  ('zakat_how_en', 'Register for help yourself, or let a neighbour tell the committee. Two members visit privately, and your name never appears on this website.', 'Zakat card — "how it works" note (English).'),
  ('zakat_how_ur', $g$خود اندراج کریں یا کسی ہمسائے کے ذریعے کمیٹی کو بتوائیں۔ دو ارکان خاموشی سے آتے ہیں، اور آپ کا نام اس ویب سائٹ پر کبھی نہیں آتا۔$g$, 'Zakat card — "how it works" note (Urdu).'),
  ('zakat_cta_en', 'Work out your zakat, or give', 'Zakat card — link text at the bottom (English).'),
  ('zakat_cta_ur', $g$اپنی زکوٰۃ کا حساب لگائیں یا ادا کریں$g$, 'Zakat card — link text at the bottom (Urdu).'),
  ('zakat_stat1_en', 'households verified door to door', 'Zakat card — label under the left-hand figure (English).'),
  ('zakat_stat1_ur', $g$گھر گھر جا کر تصدیق شدہ گھرانے$g$, 'Zakat card — label under the left-hand figure (Urdu).'),
  ('zakat_stat2_en', 'of them headed by a widow', 'Zakat card — label under the right-hand figure (English).'),
  ('zakat_stat2_ur', $g$ان میں بیوہ سربراہ گھرانے$g$, 'Zakat card — label under the right-hand figure (Urdu).'),

  ('kafalat_tab_en', 'Kafalat — School', 'Kafalat card — short name shown in the card header (English).'),
  ('kafalat_tab_ur', $g$کفالت — سکول$g$, 'Kafalat card — short name shown in the card header (Urdu).'),
  ('kafalat_headline_ur', $g$ایک بچے کا بستہ اٹھائیے — ایک سال کی فیس، ایک عمر کا فرق$g$, 'Kafalat card — the big Urdu line at the top of the card body. Always shown in Urdu, even when the site is set to English.'),
  ('kafalat_motto_en', 'Carry one child''s schoolbag. One year of fees; a lifetime of difference.', 'Kafalat card — the heading line under the Urdu headline (English).'),
  ('kafalat_motto_ur', $g$ایک بچے کا بستہ اٹھائیے$g$, 'Kafalat card — the heading line under the Urdu headline (Urdu).'),
  ('kafalat_body_en', 'Fees, uniform, books and the fare to Chakwal — set out line by line, so you see exactly what your share buys. Take a whole year or a part of one; the pool covers a child if any sponsor falls away.', 'Kafalat card — explanation paragraph (English).'),
  ('kafalat_body_ur', $g$فیس، یونیفارم، کتابیں اور چکوال کا کرایہ — سطر بہ سطر، تاکہ آپ دیکھ سکیں کہ آپ کا حصہ کہاں لگے گا۔ پورا سال لیں یا کچھ حصہ؛ کوئی کفیل رک جائے تو فنڈ بچے کو سنبھال لیتا ہے۔$g$, 'Kafalat card — explanation paragraph (Urdu).'),
  ('kafalat_how_en', 'Anyone may nominate a child from their own street. The committee visits quietly, and no child is ever named or photographed publicly.', 'Kafalat card — "how it works" note (English).'),
  ('kafalat_how_ur', $g$کوئی بھی اپنی گلی کے بچے کو نامزد کر سکتا ہے۔ کمیٹی خاموشی سے جاتی ہے، اور کسی بچے کا نام یا تصویر کبھی عام نہیں کی جاتی۔$g$, 'Kafalat card — "how it works" note (Urdu).'),
  ('kafalat_cta_en', 'Sponsor a child', 'Kafalat card — link text at the bottom (English).'),
  ('kafalat_cta_ur', $g$کسی بچے کی کفالت کریں$g$, 'Kafalat card — link text at the bottom (Urdu).'),
  ('kafalat_stat1_en', 'children in school', 'Kafalat card — label under the left-hand figure (English).'),
  ('kafalat_stat1_ur', $g$زیرِ تعلیم بچے$g$, 'Kafalat card — label under the left-hand figure (Urdu).'),
  ('kafalat_stat2_en', 'still waiting for a sponsor', 'Kafalat card — label under the right-hand figure (English).'),
  ('kafalat_stat2_ur', $g$اب بھی کفیل کے منتظر$g$, 'Kafalat card — label under the right-hand figure (Urdu).'),

  ('wazifa_tab_en', 'Taleemi Wazifa', 'Wazifa card — short name shown in the card header (English).'),
  ('wazifa_tab_ur', $g$تعلیمی وظیفہ$g$, 'Wazifa card — short name shown in the card header (Urdu).'),
  ('wazifa_headline_ur', $g$آئیے، اس ہونہار بچے کو افسر، ڈاکٹر، انجینئر بنائیں — اس کا خواب مل کر پورا کریں$g$, 'Wazifa card — the big Urdu line at the top of the card body. Always shown in Urdu, even when the site is set to English.'),
  ('wazifa_motto_en', 'Let us make this bright child an officer, a doctor, an engineer. Let us finish their dream together.', 'Wazifa card — the heading line under the Urdu headline (English).'),
  ('wazifa_motto_ur', $g$آئیے اس ہونہار بچے کا خواب مل کر پورا کریں$g$, 'Wazifa card — the heading line under the Urdu headline (Urdu).'),
  ('wazifa_body_en', 'Somewhere in this village a boy or girl passed matric with good marks and then stopped — not for want of ability, but because nobody had the admission fee. Normally given as qarz-e-hasana, so the same rupees carry the next student too.', 'Wazifa card — explanation paragraph (English).'),
  ('wazifa_body_ur', $g$اسی گاؤں میں کوئی بچہ یا بچی اچھے نمبروں سے میٹرک کر کے رک گیا — قابلیت کی کمی سے نہیں، داخلہ فیس نہ ہونے سے۔ عام طور پر قرضِ حسنہ، تاکہ وہی رقم اگلے طالبِ علم تک بھی پہنچے۔$g$, 'Wazifa card — explanation paragraph (Urdu).'),
  ('wazifa_how_en', 'Apply for yourself, your own child, or a neighbour''s child. Print the form — a committee member visits the home and goes through it with the family.', 'Wazifa card — "how it works" note (English).'),
  ('wazifa_how_ur', $g$اپنے لیے، اپنے بچے کے لیے یا ہمسائے کے بچے کے لیے درخواست دیں۔ فارم پرنٹ کریں — کمیٹی کا رکن گھر آ کر خاندان کے ساتھ اس پر بات کرے گا۔$g$, 'Wazifa card — "how it works" note (Urdu).'),
  ('wazifa_cta_en', 'Apply or sponsor a student', 'Wazifa card — link text at the bottom (English).'),
  ('wazifa_cta_ur', $g$درخواست دیں یا کسی طالبِ علم کی کفالت کریں$g$, 'Wazifa card — link text at the bottom (Urdu).'),
  ('wazifa_stat1_en', 'students carried this far', 'Wazifa card — label under the left-hand figure (English).'),
  ('wazifa_stat1_ur', $g$اب تک زیرِ کفالت طلبہ$g$, 'Wazifa card — label under the left-hand figure (Urdu).'),
  ('wazifa_stat2_en', 'have finished their degree', 'Wazifa card — label under the right-hand figure (English).'),
  ('wazifa_stat2_ur', $g$ڈگری مکمل کر چکے$g$, 'Wazifa card — label under the right-hand figure (Urdu).'),

  ('esal_tab_en', 'Esal-e-Sawab', 'Esal-e-Sawab card — short name shown in the card header (English).'),
  ('esal_tab_ur', $g$ایصالِ ثواب$g$, 'Esal-e-Sawab card — short name shown in the card header (Urdu).'),
  ('esal_headline_ur', $g$جب تک پانی بہتا رہے، ثواب پہنچتا رہے — اپنے پیارے کے نام پر$g$, 'Esal-e-Sawab card — the big Urdu line at the top of the card body. Always shown in Urdu, even when the site is set to English.'),
  ('esal_motto_en', 'While the water still runs, the reward still reaches them.', 'Esal-e-Sawab card — the heading line under the Urdu headline (English).'),
  ('esal_motto_ur', $g$جب تک پانی بہتا رہے، ثواب پہنچتا رہے$g$, 'Esal-e-Sawab card — the heading line under the Urdu headline (Urdu).'),
  ('esal_body_en', 'A water cooler at the mosque. A solar street light on a dark lane. A hand pump the whole street uses — carrying the name of a father, a mother, a brother, for as long as it keeps working.', 'Esal-e-Sawab card — explanation paragraph (English).'),
  ('esal_body_ur', $g$مسجد میں واٹر کولر۔ اندھیری گلی میں سولر لائٹ۔ ہینڈ پمپ جو پوری گلی استعمال کرے — والد، والدہ یا بھائی کے نام پر، جب تک وہ کام دیتا رہے۔$g$, 'Esal-e-Sawab card — explanation paragraph (Urdu).'),
  ('esal_how_en', 'Choose the object and the name for the plaque. Nothing is charged until the committee has seen the spot and agreed the real cost with you.', 'Esal-e-Sawab card — "how it works" note (English).'),
  ('esal_how_ur', $g$شے اور تختی کا نام منتخب کریں۔ جب تک کمیٹی جگہ دیکھ کر آپ سے اصل لاگت طے نہ کر لے، کوئی رقم نہیں لی جاتی۔$g$, 'Esal-e-Sawab card — "how it works" note (Urdu).'),
  ('esal_cta_en', 'See the board, or give one', 'Esal-e-Sawab card — link text at the bottom (English).'),
  ('esal_cta_ur', $g$بورڈ دیکھیں یا ایک عطیہ کریں$g$, 'Esal-e-Sawab card — link text at the bottom (Urdu).'),
  ('esal_stat1_en', 'still working today', 'Esal-e-Sawab card — label under the left-hand figure (English).'),
  ('esal_stat1_ur', $g$آج بھی کارآمد$g$, 'Esal-e-Sawab card — label under the left-hand figure (Urdu).'),
  ('esal_stat2_en', 'given in all', 'Esal-e-Sawab card — label under the right-hand figure (English).'),
  ('esal_stat2_ur', $g$کل عطیات$g$, 'Esal-e-Sawab card — label under the right-hand figure (Urdu).')
ON CONFLICT (key) DO NOTHING;
