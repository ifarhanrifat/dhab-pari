'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Droplets, CheckCircle, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type Lang = 'en' | 'ur'

// Public page, no login — respects the site-wide Accounts Display Language
// setting (Settings > Accounts Display Language) the same way admin
// documents already do, but here it's a real toggle (Urdu-only vs
// English-only) rather than the always-bilingual labels this page used to
// hardcode, since a public visitor picks one language, not both at once.
const t: Record<string, { en: string; ur: string }> = {
  title: { en: 'New Water Connection', ur: 'نیا واٹر کنکشن' },
  subtitle: { en: 'Apply for a new water connection for your household or shop.', ur: 'اپنے گھر یا دکان کے لیے نئے واٹر کنکشن کی درخواست دیں۔' },
  back: { en: 'Back to Water Bill', ur: 'واٹر بل پر واپس جائیں' },
  submittedTitle: { en: 'Application Submitted!', ur: 'درخواست جمع ہو گئی!' },
  submittedBody: { en: 'Your application has been received. The committee will review it and contact you within 3-5 working days.', ur: 'آپ کی درخواست موصول ہو گئی ہے۔ کمیٹی 3-5 کاروباری دنوں میں آپ سے رابطہ کرے گی۔' },
  name: { en: 'Name', ur: 'نام' },
  fatherName: { en: 'Father Name', ur: 'والد کا نام' },
  mobile: { en: 'Mobile', ur: 'موبائل نمبر' },
  cnic: { en: 'CNIC', ur: 'شناختی کارڈ نمبر' },
  address: { en: 'Address', ur: 'پتہ' },
  addressPlaceholder: { en: 'House #, Street, Area', ur: 'گھر نمبر، گلی، علاقہ' },
  sector: { en: 'Sector', ur: 'سیکٹر' },
  selectSector: { en: 'Select Sector', ur: 'سیکٹر منتخب کریں' },
  connectionType: { en: 'Connection Type', ur: 'کنکشن کی قسم' },
  residential: { en: 'Residential', ur: 'رہائشی' },
  commercial: { en: 'Commercial', ur: 'تجارتی' },
  submit: { en: 'Submit Application', ur: 'درخواست جمع کرائیں' },
  submitting: { en: 'Submitting...', ur: 'جمع ہو رہا ہے...' },
  errorRequired: { en: 'Name, mobile, and address are required.', ur: 'نام، موبائل نمبر، اور پتہ درکار ہیں۔' },
  errorFailed: { en: 'Failed to submit application. Please try again.', ur: 'درخواست جمع نہیں ہو سکی۔ دوبارہ کوشش کریں۔' },
}

export default function WaterApplyPage() {
  const { t: tr } = useLocale()
  const [lang, setLang] = useState<Lang>('en')
  const [form, setForm] = useState({
    name: '',
    fatherName: '',
    mobile: '',
    cnic: '',
    address: '',
    sector: '',
    connectionType: 'residential',
  })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.mobile.trim() || !form.address.trim()) {
      setError(dt('errorRequired'))
      return
    }

    setLoading(true)
    setError('')

    const message = [
      `NEW WATER CONNECTION APPLICATION`,
      `Name: ${form.name}`,
      `Father Name: ${form.fatherName}`,
      `Mobile: ${form.mobile}`,
      `CNIC: ${form.cnic}`,
      `Address: ${form.address}`,
      `Sector: ${form.sector}`,
      `Connection Type: ${form.connectionType}`,
    ].join('\n')

    const { error: insertErr } = await supabase.from('suggestions').insert({
      name: form.name.trim(),
      mobile: form.mobile.trim(),
      message,
      type: 'general',
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
        {/* Back */}
        <Link
          href="/water"
          className={`inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline mb-8 ${isUrdu ? 'flex-row-reverse' : ''}`}
        >
          <ArrowLeft size={16} className={isUrdu ? 'rotate-180' : ''} />
          {dt('back')}
        </Link>

        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-3 bg-dp-primary-container rounded-full text-dp-on-primary-container mb-4">
            <Droplets size={32} />
          </div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
            {dt('title')}
          </h1>
          <p className="text-dp-on-surface-variant font-sans text-[16px]" style={isUrdu ? { lineHeight: '2.2' } : undefined}>
            {dt('subtitle')}
          </p>
        </div>

        {/* Success */}
        {submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-12 text-center">
            <CheckCircle size={48} className="text-dp-secondary mx-auto mb-4" />
            <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-2">
              {dt('submittedTitle')}
            </h2>
            <p className="text-dp-on-surface-variant font-sans text-[16px] mb-6" style={isUrdu ? { lineHeight: '2.2' } : undefined}>
              {dt('submittedBody')}
            </p>
            <Link
              href="/water"
              className="inline-block bg-dp-secondary text-white px-8 py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all"
            >
              {dt('back')}
            </Link>
          </div>
        )}

        {/* Form */}
        {!submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {dt('name')} *
                  </label>
                  <input
                    type="text"
                    name="name"
                    value={form.name}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {dt('fatherName')}
                  </label>
                  <input
                    type="text"
                    name="fatherName"
                    value={form.fatherName}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {dt('mobile')} *
                  </label>
                  <input
                    type="tel"
                    name="mobile"
                    value={form.mobile}
                    onChange={handleChange}
                    required
                    placeholder="0300-1234567"
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                    style={{ direction: 'ltr', textAlign: isUrdu ? 'right' : 'left' }}
                  />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {dt('cnic')}
                  </label>
                  <input
                    type="text"
                    name="cnic"
                    value={form.cnic}
                    onChange={handleChange}
                    placeholder="xxxxx-xxxxxxx-x"
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                    style={{ direction: 'ltr', textAlign: isUrdu ? 'right' : 'left' }}
                  />
                </div>
              </div>

              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                  {dt('address')} *
                </label>
                <textarea
                  name="address"
                  value={form.address}
                  onChange={handleChange}
                  required
                  rows={3}
                  placeholder={dt('addressPlaceholder')}
                  className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px] resize-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {dt('sector')}
                  </label>
                  <select
                    name="sector"
                    value={form.sector}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  >
                    <option value="">{dt('selectSector')}</option>
                    <option value="Sector A">Sector A</option>
                    <option value="Sector B">Sector B</option>
                    <option value="Sector C">Sector C</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {dt('connectionType')}
                  </label>
                  <select
                    name="connectionType"
                    value={form.connectionType}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  >
                    <option value="residential">{dt('residential')}</option>
                    <option value="commercial">{dt('commercial')}</option>
                  </select>
                </div>
              </div>

              {error && (
                <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg font-sans text-[14px]">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-dp-secondary text-white py-4 rounded-lg font-sans text-[18px] font-semibold hover:bg-dp-primary transition-all active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50 cursor-pointer"
              >
                {loading ? dt('submitting') : dt('submit')}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
