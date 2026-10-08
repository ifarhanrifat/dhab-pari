'use client'

import { useEffect, useState } from 'react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import type { PublicSite } from '@/lib/publicSite'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { FileText } from 'lucide-react'

// Real report, 2026-09-29: the footer's own Terms of Service link (/terms)
// 404'd -- the page never existed. Written to cover what this system
// actually does (portal accounts, water billing, donations, welfare
// programs, community marketplace), not generic boilerplate.
//
// A function, not a module-level constant, since the very first section
// names the real tenant (site.fullName/name) -- useSite() is a hook and
// can only be called inside the component body.
const getSections = (site: PublicSite): { en: { h: string; p: string[] }; ur: { h: string; p: string[] } }[] => [
  {
    en: {
      h: 'Who this is for',
      p: [
        `These terms cover the ${site.fullName} website and Portal, run by the committee for the people of ${site.name} -- residents, donors (including those living abroad), and anyone using the marketplace, welfare, or billing features. By creating a Portal account or using this site, you agree to these terms.`,
      ],
    },
    ur: {
      h: 'یہ کس کے لیے ہے',
      p: [
        `یہ شرائط ${site.fullNameUrdu} کی ویب سائٹ اور پورٹل پر لاگو ہوتی ہیں، جو کمیٹی ${site.nameUrdu} کے لوگوں کے لیے چلاتی ہے -- رہائشی، عطیہ دہندگان (بشمول بیرون ملک مقیم افراد)، اور مارکیٹ پلیس، فلاحی، یا بلنگ کی سہولیات استعمال کرنے والا کوئی بھی شخص۔ پورٹل اکاؤنٹ بنا کر یا یہ سائٹ استعمال کر کے، آپ ان شرائط سے اتفاق کرتے ہیں۔`,
      ],
    },
  },
  {
    en: {
      h: 'Your Portal account',
      p: [
        'You must provide accurate information when registering -- your real name, father/husband’s name, and a WhatsApp/mobile number you actually control, since that is how the committee reaches you about bills, donations, and welfare applications. One account per person.',
        'You are responsible for keeping your account credentials secure. If you believe your account has been accessed without your permission, contact the office immediately.',
        'The committee may suspend or close an account that provides false information, is used to abuse other users (marketplace harassment, fraudulent payment claims, fake welfare applications), or is used to interfere with the operation of the site.',
      ],
    },
    ur: {
      h: 'آپ کا پورٹل اکاؤنٹ',
      p: [
        'رجسٹریشن کے وقت آپ کو درست معلومات فراہم کرنی ہوں گی -- آپ کا اصل نام، والد/شوہر کا نام، اور ایک واٹس ایپ/موبائل نمبر جو واقعی آپ کے پاس ہو، کیونکہ اسی کے ذریعے کمیٹی آپ سے بلوں، عطیات، اور فلاحی درخواستوں کے بارے میں رابطہ کرتی ہے۔ ہر شخص کے لیے صرف ایک اکاؤنٹ۔',
        'اپنے اکاؤنٹ کی تفصیلات محفوظ رکھنا آپ کی ذمہ داری ہے۔ اگر آپ کو لگے کہ آپ کے اکاؤنٹ تک آپ کی اجازت کے بغیر رسائی حاصل کی گئی ہے، تو فوری طور پر دفتر سے رابطہ کریں۔',
        'کمیٹی ایسے اکاؤنٹ کو معطل یا بند کر سکتی ہے جو غلط معلومات فراہم کرے، دوسرے صارفین کو ہراساں کرنے (مارکیٹ پلیس میں ہراسانی، جعلی ادائیگی کے دعوے، جعلی فلاحی درخواستیں) کے لیے استعمال ہو، یا سائٹ کے کام میں مداخلت کے لیے استعمال ہو۔',
      ],
    },
  },
  {
    en: {
      h: 'Donations and payments',
      p: [
        'Donations are voluntary and, once verified by the committee, non-refundable, since they are typically already committed to a project or the general welfare fund. If you made a genuine mistake (wrong amount, wrong project), contact the office right away, before it is verified -- the committee will try to help, but cannot guarantee reversal after funds are disbursed.',
        'You are responsible for the accuracy of the payment method, amount, and receipt/slip you submit. A payment claim can be rejected if the proof does not match, and the committee may follow up with you to confirm details.',
        'Payment channels shown on any given page (bank transfer, JazzCash, Easypaisa, or cash/walk-in) reflect what the committee currently accepts for that purpose -- water bills and donor/project giving are handled through separate accounts and may not offer the same channels.',
        'Choosing "keep anonymous" hides your name from the public Donor Honor Wall; it does not hide it from the committee’s own records, which it needs for verification and accounting.',
      ],
    },
    ur: {
      h: 'عطیات اور ادائیگیاں',
      p: [
        'عطیات رضاکارانہ ہیں اور کمیٹی کی تصدیق کے بعد ناقابل واپسی ہیں، کیونکہ عام طور پر یہ پہلے ہی کسی منصوبے یا عمومی فلاحی فنڈ کے لیے مختص ہو چکے ہوتے ہیں۔ اگر آپ سے حقیقی غلطی ہوئی ہو (غلط رقم، غلط منصوبہ)، تو تصدیق سے پہلے فوراً دفتر سے رابطہ کریں -- کمیٹی مدد کرنے کی کوشش کرے گی، لیکن فنڈز خرچ ہونے کے بعد واپسی کی ضمانت نہیں دے سکتی۔',
        'آپ کی جانب سے فراہم کردہ ادائیگی کے طریقے، رقم، اور رسید/سلپ کی درستگی کی ذمہ داری آپ پر ہے۔ اگر ثبوت مطابقت نہ رکھتا ہو تو ادائیگی کا دعویٰ مسترد کیا جا سکتا ہے، اور کمیٹی تفصیلات کی تصدیق کے لیے آپ سے رابطہ کر سکتی ہے۔',
        'کسی بھی صفحے پر دکھائے گئے ادائیگی کے طریقے (بینک ٹرانسفر، جاز کیش، ایزی پیسہ، یا نقد/دفتر آ کر) اس مقصد کے لیے کمیٹی کی موجودہ منظور شدہ سہولیات کی عکاسی کرتے ہیں -- واٹر بل اور ڈونر/پراجیکٹ عطیات الگ اکاؤنٹس کے ذریعے سنبھالے جاتے ہیں اور شاید ایک جیسی سہولیات پیش نہ کریں۔',
        '"گمنام رکھیں" منتخب کرنے سے آپ کا نام عوامی ڈونر آنر وال سے چھپ جاتا ہے؛ یہ کمیٹی کے اپنے ریکارڈ سے نہیں چھپتا، جو تصدیق اور حساب کتاب کے لیے ضروری ہے۔',
      ],
    },
  },
  {
    en: {
      h: 'Water connections and billing',
      p: [
        'A water connection is approved at the committee’s discretion, based on eligibility and availability. Bills are generated per billing cycle against your registered consumer account; you are responsible for paying what is billed by the stated due date.',
        'Discounts or waivers on a bill are granted only by the committee, case by case, and are not a right you can claim automatically.',
        'Submitting a payment claim through the Portal does not mark a bill paid until the committee verifies the proof you uploaded.',
      ],
    },
    ur: {
      h: 'واٹر کنکشن اور بلنگ',
      p: [
        'واٹر کنکشن اہلیت اور دستیابی کی بنیاد پر کمیٹی کی صوابدید پر منظور کیا جاتا ہے۔ بل ہر بلنگ سائیکل میں آپ کے رجسٹرڈ کنزیومر اکاؤنٹ کے خلاف بنائے جاتے ہیں؛ مقررہ تاریخ تک بل کی ادائیگی آپ کی ذمہ داری ہے۔',
        'بل پر رعایت یا معافی صرف کمیٹی کی طرف سے، ہر کیس کی بنیاد پر دی جاتی ہے، اور یہ کوئی ایسا حق نہیں جسے آپ خود بخود مانگ سکیں۔',
        'پورٹل کے ذریعے ادائیگی کا دعویٰ جمع کروانا اس وقت تک بل کو ادا شدہ نہیں بناتا جب تک کمیٹی آپ کی اپ لوڈ کردہ رسید کی تصدیق نہ کر لے۔',
      ],
    },
  },
  {
    en: {
      h: 'Welfare programs (Zakat, Wazifa, Kafalat, Needs Register)',
      p: [
        'Support through these programs is based on genuine need, assessed by the committee, and is not guaranteed by applying. Providing false information on any welfare application can result in rejection and loss of access to future support.',
        'Details shared for a welfare assessment are used only to evaluate and process that request, and are shown publicly only in the limited, anonymized form the committee already uses for public appeals (e.g. "a villager (woman)" rather than a name).',
      ],
    },
    ur: {
      h: 'فلاحی پروگرام (زکوٰۃ، وظیفہ، کفالت، نیڈز رجسٹر)',
      p: [
        'ان پروگراموں کے ذریعے امداد حقیقی ضرورت پر مبنی ہے، جس کا جائزہ کمیٹی لیتی ہے، اور درخواست دینے سے اس کی ضمانت نہیں ملتی۔ کسی بھی فلاحی درخواست میں غلط معلومات دینے سے مستقبل میں امداد تک رسائی مسترد یا ختم ہو سکتی ہے۔',
        'فلاحی جائزے کے لیے شیئر کی گئی تفصیلات صرف اس درخواست کا جائزہ لینے اور اسے پراسیس کرنے کے لیے استعمال کی جاتی ہیں، اور صرف اسی محدود، شناخت چھپا کر عوامی شکل میں دکھائی جاتی ہیں جو کمیٹی پہلے سے عوامی اپیلوں کے لیے استعمال کرتی ہے (مثلاً نام کے بجائے "ایک دیہاتی (خاتون)")۔',
      ],
    },
  },
  {
    en: {
      h: 'Marketplace (rides, deliveries, shops, ceremonies)',
      p: [
        'The marketplace connects community members directly -- drivers, riders, shop owners, buyers, and event organizers. The committee provides the platform for coordination but is not a party to the transaction between two users, and does not guarantee the condition of goods, the safety of a ride, or the outcome of any booking.',
        'Use common sense and report any serious issue (safety, fraud, harassment) through the Complaints page so the committee can investigate and, where appropriate, restrict the account involved.',
        'Vehicle owners and drivers are responsible for their own vehicle’s roadworthiness, documentation, and compliance with the law; listing on this platform is not a certification by the committee.',
      ],
    },
    ur: {
      h: 'مارکیٹ پلیس (رائیڈز، ڈیلیوری، دکانیں، تقریبات)',
      p: [
        'مارکیٹ پلیس کمیونٹی کے افراد کو براہ راست جوڑتی ہے -- ڈرائیورز، مسافر، دکاندار، خریدار، اور تقریب کے منتظمین۔ کمیٹی رابطے کے لیے پلیٹ فارم فراہم کرتی ہے لیکن دو صارفین کے درمیان لین دین کا فریق نہیں، اور سامان کی حالت، سفر کی حفاظت، یا کسی بھی بکنگ کے نتیجے کی ضمانت نہیں دیتی۔',
        'سمجھداری سے کام لیں اور کوئی بھی سنگین مسئلہ (حفاظت، دھوکہ دہی، ہراسانی) شکایات کے صفحے کے ذریعے رپورٹ کریں تاکہ کمیٹی تحقیقات کر سکے اور، جہاں مناسب ہو، متعلقہ اکاؤنٹ کو محدود کر سکے۔',
        'گاڑی کے مالکان اور ڈرائیورز اپنی گاڑی کی سڑک کے لیے موزونیت، دستاویزات، اور قانون کی پابندی کے خود ذمہ دار ہیں؛ اس پلیٹ فارم پر فہرست ہونا کمیٹی کی جانب سے کوئی سند نہیں۔',
      ],
    },
  },
  {
    en: {
      h: 'Content you submit',
      p: [
        'Talent Showcase entries, blog submissions, gallery photos, and suggestions must be your own, accurate, and appropriate for a public community site. The committee may edit, decline, or remove any submission, and may feature it on the public site or social media unless you ask otherwise.',
      ],
    },
    ur: {
      h: 'آپ کا جمع کردہ مواد',
      p: [
        'ٹیلنٹ شو کیس اندراجات، بلاگ جمع کرانا، گیلری کی تصاویر، اور تجاویز آپ کی اپنی، درست، اور عوامی کمیونٹی سائٹ کے لیے مناسب ہونی چاہئیں۔ کمیٹی کسی بھی جمع کردہ چیز میں ترمیم، انکار، یا اسے ہٹا سکتی ہے، اور جب تک آپ منع نہ کریں اسے عوامی سائٹ یا سوشل میڈیا پر پیش کر سکتی ہے۔',
      ],
    },
  },
  {
    en: {
      h: 'Changes to these terms',
      p: [
        'The committee may update these terms as the site’s features change. Continuing to use the site or Portal after an update means you accept the revised terms.',
      ],
    },
    ur: {
      h: 'ان شرائط میں تبدیلیاں',
      p: [
        'سائٹ کی سہولیات میں تبدیلی کے ساتھ کمیٹی ان شرائط کو اپ ڈیٹ کر سکتی ہے۔ اپ ڈیٹ کے بعد سائٹ یا پورٹل کا استعمال جاری رکھنے کا مطلب ہے کہ آپ نظر ثانی شدہ شرائط سے متفق ہیں۔',
      ],
    },
  },
]

export default function TermsPage() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const sections = getSections(site)
  // Real report, 2026-09-29: this hardcoded SITE.email (an env-var fallback,
  // 'info@dhabpari.org') instead of the admin-editable contact_email setting
  // (migration 525) the committee actually manages.
  const [contactEmail, setContactEmail] = useState(site.email)
  useEffect(() => {
    createClient().from('site_settings').select('value').eq('key', 'contact_email').maybeSingle()
      .then(({ data }) => { if (data?.value) setContactEmail(data.value) })
  }, [])
  return (
    <div className="max-w-[820px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <FileText size={24} className="text-dp-secondary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('y.termsService')}</h1>
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
              ? `اگر آپ کے ان شرائط کے بارے میں کوئی سوال ہو تو ہمیں ${site.whatsapp} پر واٹس ایپ کریں یا ${contactEmail} پر ای میل کریں، یا `
              : `If you have questions about these terms, WhatsApp us at ${site.whatsapp} or email ${contactEmail}, or `}
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
