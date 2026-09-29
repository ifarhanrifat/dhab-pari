'use client'

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SITE } from '@/lib/constants'
import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'

// Real report, 2026-09-29: the footer's own Privacy Policy link (/privacy)
// 404'd -- the page never existed. Written to describe what this specific
// system actually collects and does (portal accounts, water billing,
// donations, marketplace, welfare programs), not generic boilerplate.
const sections: { en: { h: string; p: string[] }; ur: { h: string; p: string[] } }[] = [
  {
    en: {
      h: 'What information we collect',
      p: [
        'When you create a Portal account we collect your name, father/husband’s name, WhatsApp number, mobile number, and email address. If you register a water connection, a vehicle, a shop, or apply for welfare support (Zakat, Wazifa, Kafalat, or the Needs Register), we also collect the details specific to that form -- address, consumer ID, CNIC where asked, household or income information, vehicle registration details, or payment proof images you upload.',
        'When you donate or pay a water bill, we record the amount, the account or project it was directed to, the payment method, and the receipt/slip image you upload so the committee can verify it. If you send money by bank, JazzCash, Easypaisa, or in person, we do not see your banking credentials -- only what you tell us about the transfer.',
        'Marketplace features (rides, deliveries, shop orders, ceremony/charter bookings) collect what is needed to connect the two sides of a booking: your name, phone/WhatsApp number, and, where the feature depends on it, your live location for the duration of a trip.',
        'Content you choose to submit for public pages -- Talent Showcase, the blog, gallery photos, suggestions -- is collected as you provide it.',
      ],
    },
    ur: {
      h: 'ہم کون سی معلومات جمع کرتے ہیں',
      p: [
        'جب آپ پورٹل اکاؤنٹ بناتے ہیں تو ہم آپ کا نام، والد/شوہر کا نام، واٹس ایپ نمبر، موبائل نمبر اور ای میل ایڈریس جمع کرتے ہیں۔ اگر آپ واٹر کنکشن، گاڑی، دکان رجسٹر کرواتے ہیں، یا فلاحی امداد (زکوٰۃ، وظیفہ، کفالت، یا نیڈز رجسٹر) کے لیے درخواست دیتے ہیں، تو اس فارم سے متعلق تفصیلات بھی جمع کی جاتی ہیں -- پتہ، کنزیومر آئی ڈی، جہاں مانگا جائے شناختی کارڈ نمبر، گھریلو یا آمدنی کی معلومات، گاڑی کی رجسٹریشن کی تفصیلات، یا آپ کی اپ لوڈ کردہ ادائیگی کی رسید کی تصاویر۔',
        'جب آپ عطیہ دیتے ہیں یا واٹر بل ادا کرتے ہیں، ہم رقم، وہ اکاؤنٹ یا منصوبہ جس کے لیے بھیجی گئی، ادائیگی کا طریقہ، اور آپ کی اپ لوڈ کردہ رسید/سلپ کی تصویر محفوظ کرتے ہیں تاکہ کمیٹی اس کی تصدیق کر سکے۔ اگر آپ بینک، جاز کیش، ایزی پیسہ، یا خود دفتر آ کر رقم بھیجتے ہیں، تو ہم آپ کی بینکنگ تفصیلات نہیں دیکھتے -- صرف وہی جو آپ ہمیں منتقلی کے بارے میں بتاتے ہیں۔',
        'مارکیٹ پلیس کی سہولیات (رائیڈز، ڈیلیوری، دکان کے آرڈرز، تقریب/چارٹر بکنگ) بکنگ کے دونوں فریقین کو ملانے کے لیے ضروری معلومات جمع کرتی ہیں: آپ کا نام، فون/واٹس ایپ نمبر، اور جہاں سہولت کا انحصار اس پر ہو، سفر کے دورانیے کے لیے آپ کا لائیو مقام۔',
        'عوامی صفحات کے لیے آپ کی جمع کردہ کوئی بھی چیز -- ٹیلنٹ شو کیس، بلاگ، گیلری کی تصاویر، تجاویز -- جیسی آپ فراہم کریں ویسی ہی جمع کی جاتی ہے۔',
      ],
    },
  },
  {
    en: {
      h: 'How we use it',
      p: [
        'To operate your Portal account, generate and track your water bills, record your donations and pledges, and issue receipts and confirmations by WhatsApp or email.',
        'To let committee staff verify payments, assess welfare eligibility, and keep an accurate ledger of the committee’s accounts -- this is a real welfare organization handling real community funds, and that record-keeping is why most of this information is collected in the first place.',
        'To connect marketplace users to each other for the specific booking they made, and to notify you about the status of your own bills, claims, orders, and applications.',
        'To publish, only with your consent or where you chose the public option, things like the Donor Honor Wall (unless you selected "keep anonymous" when donating), Talent Showcase entries, gallery photos, and blog posts.',
      ],
    },
    ur: {
      h: 'ہم اسے کیسے استعمال کرتے ہیں',
      p: [
        'آپ کے پورٹل اکاؤنٹ کو چلانے، آپ کے واٹر بل بنانے اور ٹریک کرنے، آپ کے عطیات اور وعدوں کو ریکارڈ کرنے، اور واٹس ایپ یا ای میل کے ذریعے رسیدیں اور تصدیقات جاری کرنے کے لیے۔',
        'کمیٹی کے عملے کو ادائیگیوں کی تصدیق کرنے، فلاحی اہلیت کا جائزہ لینے، اور کمیٹی کے کھاتوں کا درست ریکارڈ رکھنے کی اجازت دینے کے لیے -- یہ ایک حقیقی فلاحی ادارہ ہے جو کمیونٹی کے حقیقی فنڈز سنبھالتا ہے، اور یہی وجہ ہے کہ زیادہ تر معلومات شروع میں جمع کی جاتی ہیں۔',
        'مارکیٹ پلیس استعمال کرنے والوں کو ان کی مخصوص بکنگ کے لیے ایک دوسرے سے جوڑنے، اور آپ کو آپ کے اپنے بلوں، دعووں، آرڈرز، اور درخواستوں کی صورتحال کے بارے میں مطلع کرنے کے لیے۔',
        'صرف آپ کی رضامندی سے، یا جہاں آپ نے عوامی آپشن منتخب کیا ہو، جیسے ڈونر آنر وال (جب تک آپ نے عطیہ دیتے وقت "گمنام رکھیں" منتخب نہ کیا ہو)، ٹیلنٹ شو کیس اندراجات، گیلری کی تصاویر، اور بلاگ پوسٹس شائع کرنے کے لیے۔',
      ],
    },
  },
  {
    en: {
      h: 'Who can see your information',
      p: [
        'Committee staff with Portal admin access can see the information needed to do their job -- an accountant sees financial records, a water-billing clerk sees consumer accounts, and so on. Access inside the admin system is role-based, not open to every staff member by default.',
        'Other Portal users only ever see what a marketplace booking requires them to see (e.g. a driver sees a rider’s pickup point and phone number for an active trip), never your full profile or account history.',
        'The general public sees only what you have chosen to make public, and nothing from your billing, donation, or welfare-application records unless you have explicitly opted into a public listing (like the Honor Wall).',
        'We do not sell, rent, or trade your information to anyone.',
      ],
    },
    ur: {
      h: 'آپ کی معلومات کون دیکھ سکتا ہے',
      p: [
        'پورٹل ایڈمن رسائی رکھنے والا کمیٹی عملہ صرف اتنی معلومات دیکھ سکتا ہے جتنی ان کے کام کے لیے ضروری ہے -- اکاؤنٹنٹ مالی ریکارڈ دیکھتا ہے، واٹر بلنگ کلرک کنزیومر اکاؤنٹس دیکھتا ہے، وغیرہ۔ ایڈمن سسٹم کے اندر رسائی کردار کی بنیاد پر ہے، ہر عملے کے رکن کے لیے کھلی نہیں۔',
        'دوسرے پورٹل صارفین صرف وہی دیکھتے ہیں جو مارکیٹ پلیس بکنگ کے لیے ضروری ہو (مثلاً ڈرائیور فعال سفر کے لیے مسافر کا پک اپ پوائنٹ اور فون نمبر دیکھتا ہے)، کبھی بھی آپ کی مکمل پروفائل یا اکاؤنٹ کی تاریخ نہیں۔',
        'عام لوگ صرف وہی دیکھتے ہیں جسے آپ نے عوامی بنانے کا انتخاب کیا ہو، اور آپ کے بلنگ، عطیہ، یا فلاحی درخواست کے ریکارڈ میں سے کچھ نہیں جب تک آپ نے واضح طور پر عوامی فہرست (جیسے آنر وال) کا انتخاب نہ کیا ہو۔',
        'ہم آپ کی معلومات کسی کو فروخت، کرایہ پر، یا تجارت کے لیے نہیں دیتے۔',
      ],
    },
  },
  {
    en: {
      h: 'Where your information is stored',
      p: [
        'Your data is stored in our database (Supabase) and hosted infrastructure (Vercel). Payment proof images and other uploads are stored in the same secured storage. Transactional emails (like sign-up verification or a change-of-email confirmation) are sent through Resend. WhatsApp messages are opened as a link to your own WhatsApp app -- we do not run an automated WhatsApp messaging service that sends on your behalf.',
      ],
    },
    ur: {
      h: 'آپ کی معلومات کہاں محفوظ کی جاتی ہیں',
      p: [
        'آپ کا ڈیٹا ہمارے ڈیٹا بیس (Supabase) اور ہوسٹنگ انفراسٹرکچر (Vercel) میں محفوظ کیا جاتا ہے۔ ادائیگی کی رسید کی تصاویر اور دیگر اپ لوڈز اسی محفوظ اسٹوریج میں رکھی جاتی ہیں۔ ٹرانزیکشنل ای میلز (جیسے سائن اپ کی تصدیق یا ای میل تبدیلی کی تصدیق) Resend کے ذریعے بھیجی جاتی ہیں۔ واٹس ایپ پیغامات آپ کی اپنی واٹس ایپ ایپ کے لنک کے طور پر کھولے جاتے ہیں -- ہم کوئی خودکار واٹس ایپ میسجنگ سروس نہیں چلاتے جو آپ کی جانب سے پیغام بھیجے۔',
      ],
    },
  },
  {
    en: {
      h: 'Your choices and rights',
      p: [
        'You can update your email address and WhatsApp number yourself from your Portal profile at any time (both changes require confirming the new one before it takes effect, and we check it is not already registered to someone else).',
        'You can ask the committee to correct, update, or delete personal information we hold about you by contacting the office directly -- see below. We will keep what is legally or financially necessary to retain (such as records of a completed donation or paid bill) even after such a request, since these are real financial and welfare records.',
        'You can choose "keep anonymous" on any donation so your name never appears on a public listing.',
      ],
    },
    ur: {
      h: 'آپ کے اختیارات اور حقوق',
      p: [
        'آپ کسی بھی وقت اپنے پورٹل پروفائل سے اپنا ای میل ایڈریس اور واٹس ایپ نمبر خود تبدیل کر سکتے ہیں (دونوں تبدیلیوں کے نافذ ہونے سے پہلے نئے نمبر/ای میل کی تصدیق درکار ہوتی ہے، اور ہم چیک کرتے ہیں کہ یہ پہلے سے کسی اور کے نام رجسٹرڈ تو نہیں)۔',
        'آپ براہ راست دفتر سے رابطہ کر کے کمیٹی سے اپنی ذاتی معلومات کی تصحیح، تازہ کاری، یا حذف کرنے کی درخواست کر سکتے ہیں -- نیچے دیکھیں۔ ہم ایسی درخواست کے بعد بھی وہ ریکارڈ رکھیں گے جو قانونی یا مالی طور پر ضروری ہوں (جیسے مکمل عطیہ یا ادا شدہ بل کا ریکارڈ)، کیونکہ یہ حقیقی مالی اور فلاحی ریکارڈ ہیں۔',
        'آپ کسی بھی عطیے پر "گمنام رکھیں" کا انتخاب کر سکتے ہیں تاکہ آپ کا نام کبھی بھی عوامی فہرست میں ظاہر نہ ہو۔',
      ],
    },
  },
]

export default function PrivacyPage() {
  const { t, isUrdu } = useLocale()
  return (
    <div className="max-w-[820px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <ShieldCheck size={24} className="text-dp-secondary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('y.privacyPolicy')}</h1>
      </div>
      <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-8">
        {isUrdu ? 'آخری تازہ کاری: ستمبر 2026' : 'Last updated: September 2026'}
      </p>

      <div className="space-y-8">
        {sections.map((s, i) => (
          <div key={i}>
            <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-2.5">{isUrdu ? s.ur.h : s.en.h}</h2>
            <div className="space-y-2.5">
              {(isUrdu ? s.ur.p : s.en.p).map((para, j) => (
                <p key={j} className="font-sans text-[14.5px] leading-relaxed text-dp-on-surface-variant">{para}</p>
              ))}
            </div>
          </div>
        ))}

        <div className="bg-dp-surface-container-low rounded-lg p-5 border border-dp-outline-variant">
          <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-2">
            {isUrdu ? 'سوالات؟' : 'Questions?'}
          </h2>
          <p className="font-sans text-[14.5px] leading-relaxed text-dp-on-surface-variant">
            {isUrdu
              ? `اگر آپ کے اس پالیسی یا آپ کی معلومات کے بارے میں کوئی سوال ہو تو ہمیں ${SITE.whatsapp} پر واٹس ایپ کریں یا ${SITE.email} پر ای میل کریں، یا `
              : `If you have questions about this policy or your own information, WhatsApp us at ${SITE.whatsapp} or email ${SITE.email}, or `}
            <Link href="/complaints" className="text-dp-secondary font-semibold hover:underline">
              {isUrdu ? 'شکایت درج کروائیں' : 'file a complaint'}
            </Link>
            {isUrdu ? '۔' : '.'}
          </p>
        </div>
      </div>
    </div>
  )
}
