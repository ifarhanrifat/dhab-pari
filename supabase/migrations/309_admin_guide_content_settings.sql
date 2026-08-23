-- Migration 309: softcode the admin-side "How this works" operational
-- guides — same move as migrations 307 (homepage welfare cards) and 308
-- (portal instructions), applied to the last hardcoded guidance: the
-- collapsible panels on the Kafalat, Wazifa and Esal-e-Sawab admin pages
-- that explain each module's own workflow to the accountant/committee
-- member running it.
--
-- Unlike the portal's sponsorship-pool guide, these three are NOT shared
-- with each other — each module has its own distinct sections — so each
-- gets its own key prefix (kf_guide_*, wz_guide_*, es_guide_*). Zakat's
-- admin page has no such panel, so there is nothing to seed for it here.
--
-- Seeded with the current wording from messages.ts (kf.guide.*, wz.guide.*,
-- es.guide.*) so nothing changes on the admin side until someone actually
-- edits a field in Settings.
INSERT INTO site_settings (key, value, description) VALUES
  -- ── Kafalat admin guide ──────────────────────────────────────────────
  ('kf_guide_toggle_en', 'How this works', 'Kafalat admin guide — toggle button label (English).'),
  ('kf_guide_toggle_ur', $g$یہ نظام کیسے کام کرتا ہے$g$, 'Kafalat admin guide — toggle button label (Urdu).'),
  ('kf_guide_sponsor_or_share_title_en', 'How a child gets sponsored', 'Kafalat admin guide, section 1 — title (English).'),
  ('kf_guide_sponsor_or_share_title_ur', $g$بچے کی کفالت کیسے ہوتی ہے$g$, 'Kafalat admin guide, section 1 — title (Urdu).'),
  ('kf_guide_sponsor_or_share_body_en', 'A donor either names one child from the portal (Sponsor a Child) or joins the shared pool with no name attached — both are the same action underneath, and both count toward the same child. There is nothing to set up here for that to work; it runs from the donor portal on its own.', 'Kafalat admin guide, section 1 — body (English).'),
  ('kf_guide_sponsor_or_share_body_ur', $g$دہندہ یا تو پورٹل سے کسی ایک بچے کا نام لے کر (کسی بچے کی کفالت) یا بغیر نام کے مشترکہ فنڈ میں شامل ہو کر دیتا ہے — دونوں دراصل ایک ہی عمل ہیں اور دونوں اسی بچے کے کھاتے میں شمار ہوتے ہیں۔ یہ خود بخود پورٹل سے چلتا ہے، یہاں کچھ ترتیب دینے کی ضرورت نہیں۔$g$, 'Kafalat admin guide, section 1 — body (Urdu).'),
  ('kf_guide_measuring_title_en', 'The measuring account', 'Kafalat admin guide, section 2 — title (English).'),
  ('kf_guide_measuring_title_ur', $g$پیمائشی کھاتہ$g$, 'Kafalat admin guide, section 2 — title (Urdu).'),
  ('kf_guide_measuring_body_en', 'Not a bank account — a running tally of what this year''s active children need (Required) against what has actually been confirmed (Confirmed). Approving a child adds their year''s package to Required automatically; a confirmed donation, named or shared, reduces it. Outstanding is the gap donors still need to close, and Monthly Target is that gap spread over the months left in the school year.', 'Kafalat admin guide, section 2 — body (English).'),
  ('kf_guide_measuring_body_ur', $g$یہ بینک اکاؤنٹ نہیں — رواں سال کے فعال بچوں کی ضرورت (درکار) اور اب تک تصدیق شدہ رقم (تصدیق شدہ) کا مسلسل حساب ہے۔ بچے کی منظوری خود بخود سال کا پیکج "درکار" میں شامل کرتی ہے؛ تصدیق شدہ عطیہ — نامزد ہو یا مشترکہ — اسے کم کرتا ہے۔ باقی وہ فرق ہے جو دہندگان کو پورا کرنا ہے، اور ماہانہ ہدف وہی فرق سکول سال کے باقی مہینوں پر تقسیم کیا گیا ہے۔$g$, 'Kafalat admin guide, section 2 — body (Urdu).'),
  ('kf_guide_collections_title_en', 'Collections tab', 'Kafalat admin guide, section 3 — title (English).'),
  ('kf_guide_collections_title_ur', $g$وصولیاں ٹیب$g$, 'Kafalat admin guide, section 3 — title (Urdu).'),
  ('kf_guide_collections_body_en', 'Everything about donors, not children. Pledges a donor has announced from the portal wait here for you to confirm against the slip they attach (or cash actually received) — tap Confirm and it becomes a real donation with its own voucher, or Decline if it never arrives. Below that: donors who stopped paying and their phone number (call them — it is almost always someone who forgot, not someone who quit), and any month the pool fell short, which only the committee can decide to cover from unrestricted funds.', 'Kafalat admin guide, section 3 — body (English).'),
  ('kf_guide_collections_body_ur', $g$یہ سب کچھ دہندگان سے متعلق ہے، بچوں سے نہیں۔ جو رقم دہندہ نے پورٹل سے بھیجنے کا اعلان کیا ہو وہ یہاں آپ کی تصدیق کا انتظار کرتی ہے — منسلک رسید (یا واقعی موصول نقدی) دیکھ کر تصدیق کریں تو یہ اصل عطیہ بن جاتا ہے، اپنے ووچر کے ساتھ؛ اگر رقم نہ آئے تو مسترد کریں۔ نیچے: وہ دہندگان جنہوں نے ادائیگی روک دی اور ان کا فون نمبر (فون کریں — عام طور پر یہ بھول جانا ہوتا ہے، چھوڑنا نہیں)، اور کوئی بھی مہینہ جس میں فنڈ کم پڑا، جسے صرف کمیٹی اپنے غیر مخصوص فنڈ سے پورا کرنے کا فیصلہ کر سکتی ہے۔$g$, 'Kafalat admin guide, section 3 — body (Urdu).'),
  ('kf_guide_operations_title_en', 'Operations tab', 'Kafalat admin guide, section 4 — title (English).'),
  ('kf_guide_operations_title_ur', $g$عملیات ٹیب$g$, 'Kafalat admin guide, section 4 — title (Urdu).'),
  ('kf_guide_operations_body_en', 'The two categories that run on their own schedule: a uniform twice a year, transport and pocket money every month, both generated automatically once a child is approved. Pay marks it settled and posts the voucher; Skip records that it was deliberately not paid this cycle (a child on leave, say) without breaking next month''s schedule.', 'Kafalat admin guide, section 4 — body (English).'),
  ('kf_guide_operations_body_ur', $g$وہ دو اقسام جو اپنے شیڈول پر چلتی ہیں: سال میں دو بار یونیفارم، ہر ماہ آمد و رفت اور جیب خرچ — دونوں بچے کی منظوری کے ساتھ خود بخود بنتے ہیں۔ ادائیگی سے یہ طے شدہ ہو جاتا ہے اور ووچر پوسٹ ہوتا ہے؛ نظرانداز سے یہ ریکارڈ ہوتا ہے کہ اس بار جان بوجھ کر ادائیگی نہیں کی گئی (مثلاً بچہ چھٹی پر ہے) بغیر اگلے مہینے کے شیڈول کو متاثر کیے۔$g$, 'Kafalat admin guide, section 4 — body (Urdu).'),
  ('kf_guide_fees_title_en', 'Fees section', 'Kafalat admin guide, section 5 — title (English).'),
  ('kf_guide_fees_title_ur', $g$فیس کا حصہ$g$, 'Kafalat admin guide, section 5 — title (Urdu).'),
  ('kf_guide_fees_body_en', 'School fee, books, medical, exam fee and tuition — budgeted per child but paid as the school actually bills, often per term, so a line can be paid more than once across the year. Each payment wants who it was paid to, who signed for it, and the slip photo — that photo is the actual paper trail behind the number, and the point of keeping it here rather than in a drawer.', 'Kafalat admin guide, section 5 — body (English).'),
  ('kf_guide_fees_body_ur', $g$سکول فیس، کتابیں، طبی، امتحانی فیس اور ٹیوشن — ہر بچے کے لیے بجٹ میں شامل مگر سکول کے بل کے مطابق ادا ہوتے ہیں، اکثر ٹرم وار، اس لیے ایک لائن سال میں کئی بار ادا ہو سکتی ہے۔ ہر ادائیگی میں یہ درکار ہے: کسے دیا گیا، کس نے وصولی پر دستخط کیے، اور رسید کی تصویر — یہی تصویر اصل کاغذی ریکارڈ ہے، اور اسے دراز کی بجائے یہاں رکھنے کا مقصد یہی ہے۔$g$, 'Kafalat admin guide, section 5 — body (Urdu).'),
  ('kf_guide_reverify_title_en', 'Annual re-verification', 'Kafalat admin guide, section 6 — title (English).'),
  ('kf_guide_reverify_title_ur', $g$سالانہ دوبارہ تصدیق$g$, 'Kafalat admin guide, section 6 — title (Urdu).'),
  ('kf_guide_reverify_body_en', 'Once a year, someone visits the family again and answers the same questions as the first visit — has anyone''s income changed, is the child still enrolled. Two names on the form, not one; a decision this size should never rest on a single person''s word.', 'Kafalat admin guide, section 6 — body (English).'),
  ('kf_guide_reverify_body_ur', $g$سال میں ایک بار کوئی خاندان سے دوبارہ ملتا ہے اور وہی سوالات پوچھتا ہے جو پہلی ملاقات میں پوچھے گئے تھے — کیا کسی کی آمدنی بدلی، کیا بچہ ابھی بھی سکول میں ہے۔ فارم پر دو نام ہونے چاہئیں، ایک نہیں — اتنے بڑے فیصلے کو کبھی ایک شخص کی بات پر نہیں چھوڑنا چاہیے۔$g$, 'Kafalat admin guide, section 6 — body (Urdu).'),
  ('kf_guide_record_title_en', 'The printable record', 'Kafalat admin guide, section 7 — title (English).'),
  ('kf_guide_record_title_ur', $g$قابلِ پرنٹ ریکارڈ$g$, 'Kafalat admin guide, section 7 — title (Urdu).'),
  ('kf_guide_record_body_en', 'Every child has one button — the receipt icon on their card — that produces a single printable page: every rupee spent on them this year, what it bought, who signed for it, and a total, with space at the bottom for the committee''s own signature. That is the hard copy for the file, independent of anything on this screen.', 'Kafalat admin guide, section 7 — body (English).'),
  ('kf_guide_record_body_ur', $g$ہر بچے کے کارڈ پر ایک بٹن ہے — رسید کا آئیکن — جو ایک قابلِ پرنٹ صفحہ بناتا ہے: اس سال اس پر خرچ ہونے والا ہر روپیہ، وہ کس کام آیا، کس نے دستخط کیے، اور کل رقم، نیچے کمیٹی کے اپنے دستخط کی جگہ کے ساتھ۔ یہ فائل کے لیے کاغذی ریکارڈ ہے، اس سکرین سے آزاد۔$g$, 'Kafalat admin guide, section 7 — body (Urdu).'),

  -- ── Wazifa admin guide ───────────────────────────────────────────────
  ('wz_guide_toggle_en', 'How this works', 'Wazifa admin guide — toggle button label (English).'),
  ('wz_guide_toggle_ur', $g$یہ نظام کیسے کام کرتا ہے$g$, 'Wazifa admin guide — toggle button label (Urdu).'),
  ('wz_guide_applications_title_en', 'Applications tab', 'Wazifa admin guide, section 1 — title (English).'),
  ('wz_guide_applications_title_ur', $g$درخواستیں ٹیب$g$, 'Wazifa admin guide, section 1 — title (Urdu).'),
  ('wz_guide_applications_body_en', 'A student applies, the committee scores merit and need against the written formula in Settings, then decides — a grant that never needs repaying, or a qarz-e-hasana loan the student repays once employed, at whatever monthly amount the committee sets once that happens.', 'Wazifa admin guide, section 1 — body (English).'),
  ('wz_guide_applications_body_ur', $g$طالب علم درخواست دیتا ہے، کمیٹی سیٹنگز میں لکھے فارمولے کے مطابق میرٹ اور ضرورت کے نمبر لگاتی ہے، پھر فیصلہ کرتی ہے — ایسا وظیفہ جو کبھی واپس نہیں کرنا، یا قرضِ حسنہ جو طالب علم ملازمت ملنے پر واپس کرتا ہے، جتنی ماہانہ رقم کمیٹی اس وقت طے کرے۔$g$, 'Wazifa admin guide, section 1 — body (Urdu).'),
  ('wz_guide_awards_title_en', 'Awards tab', 'Wazifa admin guide, section 2 — title (English).'),
  ('wz_guide_awards_title_ur', $g$منظور شدہ وظائف ٹیب$g$, 'Wazifa admin guide, section 2 — title (Urdu).'),
  ('wz_guide_awards_body_en', 'Every approved student, their instalments due against the school directly, and — where the family agreed to pay something themselves — their own contribution recorded here too.', 'Wazifa admin guide, section 2 — body (English).'),
  ('wz_guide_awards_body_ur', $g$ہر منظور شدہ طالب علم، ان کی سکول کو براہ راست ادا ہونے والی اقساط، اور — جہاں خاندان نے خود کچھ دینے پر رضامندی دی — ان کا اپنا حصہ بھی یہاں درج ہوتا ہے۔$g$, 'Wazifa admin guide, section 2 — body (Urdu).'),
  ('wz_guide_loans_title_en', 'Loans, repayment, and write-off', 'Wazifa admin guide, section 3 — title (English).'),
  ('wz_guide_loans_title_ur', $g$قرض، واپسی، اور معافی$g$, 'Wazifa admin guide, section 3 — title (Urdu).'),
  ('wz_guide_loans_body_en', 'A loan sits untouched until the student tells the committee they are employed — repayment is never advertised or shown on the application, and never starts on its own. Once marked employed, one instalment a month is raised automatically at whatever amount the committee fixed, continuing until the balance reaches zero. The committee can waive the remainder outright at any time, entirely at its own discretion — that decision is never shown to the student in advance or promised on any form.', 'Wazifa admin guide, section 3 — body (English).'),
  ('wz_guide_loans_body_ur', $g$قرض اس وقت تک چھوا نہیں جاتا جب تک طالب علم خود کمیٹی کو نہ بتائے کہ اسے ملازمت مل گئی ہے — واپسی کبھی درخواست پر ظاہر نہیں کی جاتی اور نہ اشتہار دی جاتی ہے، اور خود بخود شروع نہیں ہوتی۔ ملازمت کی اطلاع کے بعد ہر ماہ ایک قسط خودکار طور پر اٹھتی ہے، جتنی رقم کمیٹی نے طے کی، جب تک باقی رقم صفر نہ ہو جائے۔ کمیٹی کسی بھی وقت اپنی صوابدید پر باقی رقم مکمل معاف کر سکتی ہے — یہ فیصلہ کبھی پہلے سے طالب علم کو نہیں بتایا جاتا اور نہ کسی فارم پر وعدہ کیا جاتا ہے۔$g$, 'Wazifa admin guide, section 3 — body (Urdu).'),
  ('wz_guide_collections_title_en', 'Collections tab', 'Wazifa admin guide, section 4 — title (English).'),
  ('wz_guide_collections_title_ur', $g$وصولیاں ٹیب$g$, 'Wazifa admin guide, section 4 — title (Urdu).'),
  ('wz_guide_collections_body_en', 'Pledges toward the shared Wazifa pool wait here for confirmation against the slip or cash received, plus lapsed donors and any month the committee had to cover from its own funds — the same pattern as Kafalat and Sadqa''s own Collections tabs.', 'Wazifa admin guide, section 4 — body (English).'),
  ('wz_guide_collections_body_ur', $g$مشترکہ وظیفہ فنڈ کے وعدے یہاں رسید یا موصول نقدی دیکھ کر تصدیق کا انتظار کرتے ہیں، ساتھ ہی رکے ہوئے دہندگان اور وہ مہینے جو کمیٹی نے اپنے فنڈ سے پورے کیے — بالکل کفالت اور صدقہ کے اپنے وصولیاں ٹیب کی طرح۔$g$, 'Wazifa admin guide, section 4 — body (Urdu).'),

  -- ── Esal-e-Sawab admin guide ─────────────────────────────────────────
  ('es_guide_toggle_en', 'How this works', 'Esal-e-Sawab admin guide — toggle button label (English).'),
  ('es_guide_toggle_ur', $g$یہ نظام کیسے کام کرتا ہے$g$, 'Esal-e-Sawab admin guide — toggle button label (Urdu).'),
  ('es_guide_proposals_title_en', 'Proposals tab', 'Esal-e-Sawab admin guide, section 1 — title (English).'),
  ('es_guide_proposals_title_ur', $g$پیشکش ٹیب$g$, 'Esal-e-Sawab admin guide, section 1 — title (Urdu).'),
  ('es_guide_proposals_body_en', 'A donor offers to give a lasting object — a water cooler, a hand pump — dedicated to someone. Nothing is charged until you approve it, confirm the real location and cost, and record what actually arrives.', 'Esal-e-Sawab admin guide, section 1 — body (English).'),
  ('es_guide_proposals_body_ur', $g$دہندہ کوئی مستقل چیز دینے کی پیشکش کرتا ہے — واٹر کولر، ہینڈ پمپ — کسی کے نام معنون۔ جب تک آپ منظور نہ کریں، اصل مقام اور لاگت طے نہ کریں، اور جو کچھ واقعی آئے وہ درج نہ کریں، کوئی رقم وصول نہیں کی جاتی۔$g$, 'Esal-e-Sawab admin guide, section 1 — body (Urdu).'),
  ('es_guide_upkeep_title_en', 'Upkeep, two different ways', 'Esal-e-Sawab admin guide, section 2 — title (English).'),
  ('es_guide_upkeep_title_ur', $g$دیکھ بھال کے دو طریقے$g$, 'Esal-e-Sawab admin guide, section 2 — title (Urdu).'),
  ('es_guide_upkeep_body_en', 'An object the original donor said they would maintain gets billed to them monthly, automatically. An object the committee took on instead goes into the shared upkeep pool — anyone can help with it, named or not, the same as Kafalat and Wazifa.', 'Esal-e-Sawab admin guide, section 2 — body (English).'),
  ('es_guide_upkeep_body_ur', $g$جو چیز اصل دہندہ نے خود دیکھ بھال کرنے کا کہا وہ ہر ماہ خودکار طور پر ان سے وصول ہوتی ہے۔ جو چیز کمیٹی نے خود سنبھالی وہ مشترکہ دیکھ بھال فنڈ میں جاتی ہے — کوئی بھی اس میں مدد کر سکتا ہے، نام کے ساتھ یا بغیر، کفالت اور وظیفہ کی طرح۔$g$, 'Esal-e-Sawab admin guide, section 2 — body (Urdu).'),
  ('es_guide_collections_title_en', 'Collections tab', 'Esal-e-Sawab admin guide, section 3 — title (English).'),
  ('es_guide_collections_title_ur', $g$وصولیاں ٹیب$g$, 'Esal-e-Sawab admin guide, section 3 — title (Urdu).'),
  ('es_guide_collections_body_en', 'Pledges toward the shared upkeep pool wait here for confirmation against the slip or cash received, plus lapsed donors and any month the committee had to cover from its own funds — the same pattern as Kafalat and Wazifa''s own Collections tabs.', 'Esal-e-Sawab admin guide, section 3 — body (English).'),
  ('es_guide_collections_body_ur', $g$مشترکہ دیکھ بھال فنڈ کے وعدے یہاں رسید یا موصول نقدی دیکھ کر تصدیق کا انتظار کرتے ہیں، ساتھ ہی رکے ہوئے دہندگان اور وہ مہینے جو کمیٹی نے اپنے فنڈ سے پورے کیے — بالکل کفالت اور وظیفہ کے اپنے وصولیاں ٹیب کی طرح۔$g$, 'Esal-e-Sawab admin guide, section 3 — body (Urdu).'),
  ('es_guide_catalogue_title_en', 'Catalogue tab', 'Esal-e-Sawab admin guide, section 4 — title (English).'),
  ('es_guide_catalogue_title_ur', $g$فہرست ٹیب$g$, 'Esal-e-Sawab admin guide, section 4 — title (Urdu).'),
  ('es_guide_catalogue_body_en', 'The list a donor picks from when offering something. Add, edit or retire items here — nothing is hardcoded. Changing a price only affects new offers; anything already offered keeps its original price.', 'Esal-e-Sawab admin guide, section 4 — body (English).'),
  ('es_guide_catalogue_body_ur', $g$وہ فہرست جس سے دہندہ پیشکش کے لیے چنتا ہے۔ یہاں چیزیں شامل، ترمیم یا ہٹائی جا سکتی ہیں — کچھ بھی مستقل کوڈ میں نہیں۔ قیمت بدلنے سے صرف نئی پیشکشیں متاثر ہوتی ہیں؛ پہلے سے پیش کی گئی چیز اپنی اصل قیمت پر رہتی ہے۔$g$, 'Esal-e-Sawab admin guide, section 4 — body (Urdu).')
ON CONFLICT (key) DO NOTHING;
