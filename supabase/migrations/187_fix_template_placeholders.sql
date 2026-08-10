-- Migration 187: the reply templates used the wrong placeholder convention.
--
-- This app substitutes %%key%% (see renderTemplate in src/lib/messageTemplates.ts,
-- and every template from migration 076 onward). Migration 180 wrote {name} and
-- {project}, which renderTemplate never touches — so a donor received a reply
-- with the literal braces still in it, reading "You are now a volunteer on
-- {project}". Embarrassing, and entirely my mistake.
--
-- UPDATE rather than INSERT ... ON CONFLICT DO NOTHING, because the broken rows
-- already exist and DO NOTHING would leave them exactly as they are.
UPDATE message_templates SET body = $g$خوش آمدید %%name%%!

کمیٹی نے آپ کی درخواست منظور کر لی ہے۔ آپ کو ای میل پر ایک دعوتی لنک بھیجا جائے گا جس سے آپ اپنا پاس ورڈ خود مقرر کریں گے۔

پہلی بار داخل ہونے پر آپ کو مواد کے اصول دکھائے جائیں گے — براہ کرم انہیں غور سے پڑھیں، خاص طور پر خواتین کی پردہ داری اور لوگوں کی نجی زندگی سے متعلق۔

Welcome %%name%%! The committee has approved your request. You will receive an invitation link by email to set your own password. On your first sign-in you will be shown the content rules — please read them carefully, especially those about the privacy of women and of people's private lives.$g$ WHERE key = 'role_request_accepted';
UPDATE message_templates SET body = $g$%%name%%، آپ کی دلچسپی کا بہت شکریہ۔

اس وقت کمیٹی مزید پبلشر شامل نہیں کر رہی، لیکن ہم آپ کی پیشکش کو محفوظ رکھ رہے ہیں اور ضرورت پڑنے پر ضرور رابطہ کریں گے۔ اس دوران آپ رضاکار کے طور پر کسی منصوبے میں شامل ہو سکتے ہیں۔

Thank you sincerely for offering, %%name%%. The committee is not adding more publishers at the moment, but we are keeping your offer on record and will contact you when that changes. In the meantime you are very welcome to join a project as a volunteer.$g$ WHERE key = 'role_request_declined';
UPDATE message_templates SET body = $g$%%name%%، آپ کی پیشکش قبول کر لی گئی ہے۔

آپ اب %%project%% کے رضاکار ہیں۔ آپ کو کام "My Volunteering" میں نظر آئے گا اور ضروری بات واٹس ایپ پر بھی کی جائے گی۔ کمیٹی آپ کی مدد کی قدر کرتی ہے۔

%%name%%, your offer has been accepted. You are now a volunteer on %%project%%. Tasks will appear under My Volunteering, and anything urgent will also reach you on WhatsApp. The committee is grateful for your help.$g$ WHERE key = 'volunteer_accepted';
