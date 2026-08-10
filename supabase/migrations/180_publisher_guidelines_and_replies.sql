-- Migration 180: accepting or declining a Publisher role request, and the
-- content rules that come with the role.
--
-- The rules are the serious part. In a village, "no video of women" and
-- "consider people's privacy when photographing" are not style guidance — they
-- are the difference between the committee being trusted with a camera and
-- not. So they live in an editable document with a recorded acknowledgement,
-- not in someone's memory of a WhatsApp conversation.

-- ── The guidelines themselves ────────────────────────────────────────────
-- Versioned: bumping the version re-prompts every publisher to read and accept
-- again, which is the only way a rule change actually reaches the people bound
-- by it.
INSERT INTO site_settings (key, value, description) VALUES
  ('publisher_guidelines_version', '1',
   'Bump this after editing the guidelines — every publisher is asked to read and accept again.'),
  ('publisher_guidelines_en',
E'Before you publish anything on behalf of Dhab Pari Water & Welfare Committee:\n\n'
E'1. PRIVACY OF WOMEN — Do not photograph or record video of women of the village under any circumstances, and never publish such material even if someone else supplies it.\n\n'
E'2. CONSENT — Ask before photographing or filming any person. If they say no, or look uncomfortable, stop. Never publish a picture of a child without a parent present and agreeing.\n\n'
E'3. PRIVATE LIFE — Do not photograph inside anyone''s home, courtyard, or over a boundary wall. Do not publish anything showing a family''s private circumstances, illness, or financial hardship, even sympathetically.\n\n'
E'4. RESPECT — Nothing that mocks, shames, or takes sides in a family or village dispute. Nothing political or sectarian.\n\n'
E'5. ACCURACY — Do not state figures, dates or decisions of the committee unless you have them from the minutes or from an office bearer.\n\n'
E'6. APPROVAL — Your posts are reviewed by an administrator before they appear publicly. This protects you as much as the committee.\n\n'
E'If you are unsure about anything, ask before you publish, not after.',
   'Publisher content rules, English. Shown on a publisher''s first login.'),
  ('publisher_guidelines_ur',
E'دھاب پری واٹر اینڈ ویلفیئر کمیٹی کی طرف سے کچھ بھی شائع کرنے سے پہلے:\n\n'
E'۱۔ خواتین کی پردہ داری — گاؤں کی خواتین کی تصویر یا ویڈیو کسی بھی صورت میں نہ بنائیں، اور اگر کوئی اور فراہم کرے تب بھی ہرگز شائع نہ کریں۔\n\n'
E'۲۔ اجازت — کسی بھی شخص کی تصویر یا ویڈیو بنانے سے پہلے اجازت لیں۔ اگر وہ منع کریں یا ہچکچائیں تو رک جائیں۔ بچے کی تصویر والدین کی موجودگی اور اجازت کے بغیر ہرگز شائع نہ کریں۔\n\n'
E'۳۔ نجی زندگی — کسی کے گھر، صحن یا دیوار کے اندر کی تصویر نہ بنائیں۔ کسی خاندان کی بیماری، مالی تنگی یا نجی حالات دکھانے والی چیز شائع نہ کریں، خواہ ہمدردی میں ہی کیوں نہ ہو۔\n\n'
E'۴۔ احترام — کسی کا مذاق، بے عزتی، یا خاندانی و دیہاتی جھگڑے میں فریق بننے والی کوئی چیز نہیں۔ سیاسی یا فرقہ وارانہ مواد نہیں۔\n\n'
E'۵۔ درستگی — کمیٹی کے اعداد و شمار، تاریخیں یا فیصلے صرف اسی صورت بیان کریں جب وہ منٹس سے یا کسی عہدیدار سے ملے ہوں۔\n\n'
E'۶۔ منظوری — آپ کی پوسٹ عوام تک پہنچنے سے پہلے ایڈمنسٹریٹر دیکھے گا۔ یہ کمیٹی کے ساتھ ساتھ آپ کی بھی حفاظت ہے۔\n\n'
E'اگر کسی بات میں شک ہو تو شائع کرنے کے بعد نہیں، پہلے پوچھ لیں۔',
   'Publisher content rules, Urdu. Shown on a publisher''s first login.')
ON CONFLICT (key) DO NOTHING;

-- Recorded per person and per version, so there is an answer to "was he told?"
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS guidelines_acked_at timestamptz,
  ADD COLUMN IF NOT EXISTS guidelines_acked_version varchar;

-- A publisher can record their own acceptance; nothing else about their row.
CREATE OR REPLACE FUNCTION ack_publisher_guidelines(p_version varchar) RETURNS void AS $$
BEGIN
  IF current_admin_user_id() IS NULL THEN
    RAISE EXCEPTION 'Not signed in as a staff user';
  END IF;
  UPDATE admin_users
     SET guidelines_acked_at = now(), guidelines_acked_version = p_version
   WHERE id = current_admin_user_id();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION ack_publisher_guidelines(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ack_publisher_guidelines(varchar) TO authenticated;

-- ── Reply templates ──────────────────────────────────────────────────────
-- Editable, because a decline written once in anger or haste gets reused for
-- years. {name} is substituted the same way every other template in this app
-- works. No credentials here by design — an account arrives by invite link,
-- never as a password typed into a notification.
INSERT INTO message_templates (key, label, body) VALUES
  ('role_request_accepted', 'Publisher role — accepted',
E'خوش آمدید {name}!\n\n'
E'کمیٹی نے آپ کی درخواست منظور کر لی ہے۔ آپ کو ای میل پر ایک دعوتی لنک بھیجا جائے گا جس سے آپ اپنا پاس ورڈ خود مقرر کریں گے۔\n\n'
E'پہلی بار داخل ہونے پر آپ کو مواد کے اصول دکھائے جائیں گے — براہ کرم انہیں غور سے پڑھیں، خاص طور پر خواتین کی پردہ داری اور لوگوں کی نجی زندگی سے متعلق۔\n\n'
E'Welcome {name}! The committee has approved your request. You will receive an invitation link by email to set your own password. On your first sign-in you will be shown the content rules — please read them carefully, especially those about the privacy of women and of people''s private lives.'),
  ('role_request_declined', 'Publisher role — declined (kindly)',
E'{name}، آپ کی دلچسپی کا بہت شکریہ۔\n\n'
E'اس وقت کمیٹی مزید پبلشر شامل نہیں کر رہی، لیکن ہم آپ کی پیشکش کو محفوظ رکھ رہے ہیں اور ضرورت پڑنے پر ضرور رابطہ کریں گے۔ اس دوران آپ رضاکار کے طور پر کسی منصوبے میں شامل ہو سکتے ہیں۔\n\n'
E'Thank you sincerely for offering, {name}. The committee is not adding more publishers at the moment, but we are keeping your offer on record and will contact you when that changes. In the meantime you are very welcome to join a project as a volunteer.'),
  ('volunteer_accepted', 'Volunteer — accepted',
E'{name}، آپ کی پیشکش قبول کر لی گئی ہے۔\n\n'
E'آپ اب "{project}" کے رضاکار ہیں۔ آپ کو کام "My Volunteering" میں نظر آئے گا اور ضروری بات واٹس ایپ پر بھی کی جائے گی۔ کمیٹی آپ کی مدد کی قدر کرتی ہے۔\n\n'
E'{name}, your offer has been accepted. You are now a volunteer on "{project}". Tasks will appear under My Volunteering, and anything urgent will also reach you on WhatsApp. The committee is grateful for your help.')
ON CONFLICT (key) DO NOTHING;
