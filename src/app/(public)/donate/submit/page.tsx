'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { HeartHandshake, CheckCircle, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { PaymentAccountDetails } from '@/components/public/PaymentAccountDetails'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SearchableField } from '@/components/admin/SearchablePicker'

type Lang = 'en' | 'ur'

// Public, unauthenticated donation submission — same shape/spirit as
// /water/apply (no login, staff reviews afterward). Submissions land
// unverified ("announced") until the donor accountant confirms them against
// the actual bank/EasyPaisa/JazzCash record — see confirm_donation() and
// /admin/donors.
const t: Record<string, { en: string; ur: string }> = {
  title: { en: 'Submit a Donation', ur: 'عطیہ جمع کروائیں' },
  subtitle: { en: 'After paying via JazzCash, Easypaisa, or bank transfer, tell us here so we can verify and record it.', ur: 'جیز کیش، ایزی پیسہ یا بینک ٹرانسفر سے ادائیگی کے بعد، ہمیں یہاں مطلع کریں تاکہ ہم تصدیق کر کے ریکارڈ کر سکیں۔' },
  back: { en: 'Back to Donate', ur: 'ڈونیٹ پیج پر واپس' },
  submittedTitle: { en: 'Thank You!', ur: 'شکریہ!' },
  submittedBody: { en: 'Your donation has been received and will appear as "Announced" until our accountant verifies it against the payment record. You will be notified via WhatsApp once verified.', ur: 'آپ کا عطیہ موصول ہو گیا ہے اور اکاؤنٹنٹ کی تصدیق تک "اعلان شدہ" کے طور پر ظاہر ہوگا۔ تصدیق کے بعد آپ کو واٹس ایپ پر مطلع کیا جائے گا۔' },
  name: { en: 'Name', ur: 'نام' },
  fatherName: { en: "Father's / Husband's Name", ur: 'والد / شوہر کا نام' },
  whatsapp: { en: 'WhatsApp Number', ur: 'واٹس ایپ نمبر' },
  phone: { en: 'Phone (optional, if different)', ur: 'فون نمبر (اگر مختلف ہو)' },
  amount: { en: 'Amount (PKR)', ur: 'رقم (روپے)' },
  date: { en: 'Payment Date', ur: 'ادائیگی کی تاریخ' },
  paymentMethod: { en: 'Payment Method', ur: 'ادائیگی کا طریقہ' },
  project: { en: 'Project (optional)', ur: 'منصوبہ (اختیاری)' },
  noProject: { en: 'General Fund', ur: 'عمومی فنڈ' },
  anonymous: { en: 'Keep my donation anonymous on the website', ur: 'ویب سائٹ پر میرا عطیہ گمنام رکھیں' },
  submit: { en: 'Submit Donation', ur: 'عطیہ جمع کروائیں' },
  submitting: { en: 'Submitting...', ur: 'جمع ہو رہا ہے...' },
  international: { en: "I'm sending this from outside Pakistan (bank transfer only)", ur: 'میں یہ پاکستان سے باہر سے بھیج رہا/رہی ہوں (صرف بینک ٹرانسفر)' },
  errorRequired: { en: 'Name, WhatsApp number, amount, and payment receipt are required.', ur: 'نام، واٹس ایپ نمبر، رقم، اور رسید درکار ہیں۔' },
  errorFailed: { en: 'Failed to submit. Please try again.', ur: 'جمع نہیں ہو سکا۔ دوبارہ کوشش کریں۔' },
}

interface Project { id: string; title: string }

export default function DonateSubmitPage() {
  const { t: tr } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{tr('action.loading')}</div>}>
      <DonateSubmitPageInner />
    </Suspense>
  )
}

function DonateSubmitPageInner() {
  const { t: tr } = useLocale()
  const searchParams = useSearchParams()
  const [lang, setLang] = useState<Lang>('en')
  const [projects, setProjects] = useState<Project[]>([])
  const [form, setForm] = useState({
    name: '', father_husband_name: '', whatsapp_number: '', phone: '',
    amount_pkr: 0, date: new Date().toISOString().split('T')[0],
    payment_method: 'jazzcash', project_id: searchParams.get('project') ?? '', is_anonymous: false,
  })
  const [receiptPath, setReceiptPath] = useState('')
  const [international, setInternational] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  const supabase = createClient()
  const dt = (key: keyof typeof t) => t[key][lang]
  const isUrdu = lang === 'ur'

  useEffect(() => {
    supabase.from('site_settings').select('value').eq('key', 'display_language').maybeSingle().then(({ data }) => {
      if (data?.value === 'ur') setLang('ur')
    })
    // Not yet launched (upcoming) or already wrapped up (completed) — a
    // donor picking who to give to shouldn't be offered either.
    supabase.from('projects').select('id, title').not('status', 'in', '(upcoming,completed)').order('title').then(({ data }) => {
      setProjects(data ?? [])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.whatsapp_number.trim() || !form.amount_pkr || !receiptPath) {
      setError(dt('errorRequired'))
      return
    }

    setLoading(true)
    setError('')

    const { data: dupMessage } = await supabase.rpc('check_donor_duplicate', {
      p_name: form.name.trim(),
      p_father_husband_name: form.father_husband_name.trim() || null,
      p_whatsapp_number: form.whatsapp_number.trim() || null,
      p_phone: form.phone.trim() || null,
    })
    if (dupMessage) {
      setError(dupMessage)
      setLoading(false)
      return
    }

    const { error: insertErr } = await supabase.from('donors').insert({
      name: form.name.trim(),
      father_husband_name: form.father_husband_name.trim() || null,
      whatsapp_number: form.whatsapp_number.trim() || null,
      phone: form.phone.trim() || form.whatsapp_number.trim() || null,
      amount_pkr: form.amount_pkr,
      date: form.date,
      payment_method: form.payment_method,
      project_id: form.project_id || null,
      is_anonymous: form.is_anonymous,
      payment_proof_url: receiptPath,
      is_verified: false,
      submitted_via: 'public',
      donor_type: international ? 'overseas' : 'villager',
    })

    if (insertErr) {
      setError(dt('errorFailed'))
      setLoading(false)
      return
    }

    setSubmitted(true)
    setLoading(false)
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
      <div className="max-w-2xl mx-auto">
        <Link
          href="/donate"
          className={`inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline mb-8 ${isUrdu ? 'flex-row-reverse' : ''}`}
        >
          <ArrowLeft size={16} className={isUrdu ? 'rotate-180' : ''} />
          {dt('back')}
        </Link>

        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-3 bg-dp-secondary-container rounded-full text-dp-on-secondary-container mb-4">
            <HeartHandshake size={32} />
          </div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">{dt('title')}</h1>
          <p className="text-dp-on-surface-variant font-sans text-[16px]" style={isUrdu ? { lineHeight: '2.2' } : undefined}>
            {dt('subtitle')}
          </p>
        </div>

        {submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-12 text-center">
            <CheckCircle size={48} className="text-dp-secondary mx-auto mb-4" />
            <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-2">{dt('submittedTitle')}</h2>
            <p className="text-dp-on-surface-variant font-sans text-[16px] mb-6" style={isUrdu ? { lineHeight: '2.2' } : undefined}>
              {dt('submittedBody')}
            </p>
            <Link href="/donate" className="inline-block bg-dp-secondary text-white px-8 py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all">
              {dt('back')}
            </Link>
          </div>
        )}

        {!submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('name')} *</label>
                  <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]" />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('fatherName')}</label>
                  <input type="text" value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('whatsapp')} *</label>
                  <input type="tel" value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} required
                    placeholder="0300-1234567" style={{ direction: 'ltr', textAlign: isUrdu ? 'right' : 'left' }}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]" />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('phone')}</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="0300-1234567" style={{ direction: 'ltr', textAlign: isUrdu ? 'right' : 'left' }}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('amount')} *</label>
                  <input type="number" min={1} value={form.amount_pkr || ''} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} required
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]" />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('date')}</label>
                  <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]" />
                </div>
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer font-sans text-[13.5px] text-dp-on-surface">
                <input type="checkbox" checked={international}
                  onChange={(e) => { setInternational(e.target.checked); if (e.target.checked) setForm({ ...form, payment_method: 'bank' }) }}
                  className="accent-dp-secondary mt-0.5" />
                {dt('international')}
              </label>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('paymentMethod')}</label>
                  <select value={form.payment_method} disabled={international} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px] disabled:opacity-60">
                    {!international && <option value="jazzcash">{tr('w.jazzcash')}</option>}
                    {!international && <option value="easypaisa">{tr('w.easypaisa')}</option>}
                    <option value="bank">{tr('w.bankTransfer')}</option>
                    {!international && <option value="cash">{tr('w.cash')}</option>}
                  </select>
                  <PaymentAccountDetails system="donors_projects" method={form.payment_method} international={international} />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{dt('project')}</label>
                  <SearchableField
                    value={form.project_id}
                    onChange={(id) => setForm({ ...form, project_id: id })}
                    placeholder={dt('noProject')}
                    pickerTitle={dt('project')}
                    items={projects.map((p) => ({ id: p.id, label: p.title }))}
                  />
                </div>
              </div>

              <DonationReceiptUpload onUpload={setReceiptPath} />

              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.is_anonymous} onChange={(e) => setForm({ ...form, is_anonymous: e.target.checked })} className="accent-dp-secondary" />
                <span className="font-sans text-[14px]">{dt('anonymous')}</span>
              </label>

              {error && (
                <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg font-sans text-[14px]">{error}</div>
              )}

              <button type="submit" disabled={loading}
                className="w-full bg-dp-secondary text-white py-4 rounded-lg font-sans text-[18px] font-semibold hover:bg-dp-primary transition-all active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50 cursor-pointer">
                {loading ? dt('submitting') : dt('submit')}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
