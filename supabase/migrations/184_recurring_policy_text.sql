-- Migration 184: tell a donor what "announcing" actually commits them to.
--
-- A recurring donation is the one place in this app where a resident takes on
-- an obligation, and until now the form asked for an amount and a frequency
-- with no explanation at all. Someone could set up a monthly announcement
-- believing the money would be taken automatically, then find their name listed
-- publicly as having announced and not paid.
--
-- Editable from Settings rather than hardcoded, and stored as an English/Urdu
-- pair because the portal already lets a resident pick their language — the
-- guidance has to follow that choice, not the committee's.
INSERT INTO site_settings (key, value, description) VALUES
  ('recurring_policy_en', $g$Before you announce a recurring donation, please understand:

1. An announcement is a promise, not a payment. No money is taken from your account automatically — this system cannot debit you.

2. On each due date an announcement is recorded in your name and listed on the project page as announced but not yet paid.

3. You pay each instalment yourself from "My Giving" and upload the payment proof there. It only counts towards the fund once the committee confirms it.

4. You may stop future instalments at any time by cancelling the schedule. Announcements already made remain, because the committee has already counted on them.

5. Only the committee can remove an announcement. If you announced something by mistake, call the helpline.

6. Your name appears on the project page unless you chose to give anonymously.$g$,
   'Shown to a donor on the portal before they set up a recurring donation (English).'),
  ('recurring_policy_ur', $g$باقاعدہ عطیہ کا اعلان کرنے سے پہلے براہ کرم یہ باتیں سمجھ لیں:

۱۔ اعلان ایک وعدہ ہے، ادائیگی نہیں۔ آپ کے اکاؤنٹ سے خود بخود کوئی رقم نہیں کٹے گی — یہ سسٹم ایسا کر ہی نہیں سکتا۔

۲۔ ہر مقررہ تاریخ پر آپ کے نام سے ایک اعلان درج ہوگا اور منصوبے کے صفحے پر "اعلان شدہ، ابھی ادا نہیں" کے طور پر دکھایا جائے گا۔

۳۔ ہر قسط آپ کو خود "میرا عطیہ" میں جا کر ادا کرنی ہوگی اور ادائیگی کا ثبوت وہیں اپلوڈ کرنا ہوگا۔ کمیٹی کی تصدیق کے بعد ہی یہ فنڈ میں شمار ہوگی۔

۴۔ آپ جب چاہیں آئندہ اقساط بند کر سکتے ہیں۔ لیکن جو اعلانات پہلے ہو چکے ہیں وہ برقرار رہیں گے، کیونکہ کمیٹی ان پر بھروسہ کر چکی ہوتی ہے۔

۵۔ صرف کمیٹی ہی کوئی اعلان ختم کر سکتی ہے۔ اگر غلطی سے اعلان ہو گیا ہو تو ہیلپ لائن پر رابطہ کریں۔

۶۔ اگر آپ نے گمنام عطیہ کا انتخاب نہیں کیا تو آپ کا نام منصوبے کے صفحے پر ظاہر ہوگا۔$g$,
   'Shown to a donor on the portal before they set up a recurring donation (Urdu).')
ON CONFLICT (key) DO NOTHING;
