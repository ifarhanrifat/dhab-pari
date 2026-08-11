'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SITE } from '@/lib/constants'
import { Droplet, CheckCircle, Phone, MessageCircle, ShieldCheck, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

type Lang = 'en' | 'ur'

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

// Same bilingual pattern as /water/apply — a public visitor reads one
// language, not both at once, so this is a real toggle rather than
// double-labelled fields.
const t: Record<string, { en: string; ur: string }> = {
  title: { en: 'Blood Donor Registry', ur: 'خون کے عطیہ دہندگان' },
  subtitle: {
    en: 'Villagers who have volunteered to give blood. Names and numbers are never shown here — tell us what you need and the committee will find a match.',
    ur: 'گاؤں کے وہ افراد جنہوں نے خون دینے کی رضامندی ظاہر کی ہے۔ نام اور نمبر یہاں ظاہر نہیں کیے جاتے — آپ اپنی ضرورت بتائیں، کمیٹی خود عطیہ دہندہ تلاش کرے گی۔',
  },
  back: { en: 'Back to Home', ur: 'ہوم پیج پر واپس' },
  available: { en: 'ready now', ur: 'ابھی دستیاب' },
  registered: { en: 'registered', ur: 'رجسٹرڈ' },
  countsNote: {
    en: '"Ready now" counts donors who are outside the safe waiting period since their last donation.',
    ur: '"ابھی دستیاب" سے مراد وہ عطیہ دہندگان ہیں جن کے آخری عطیے کے بعد محفوظ وقفہ مکمل ہو چکا ہے۔',
  },

  formTitle: { en: 'Request Blood', ur: 'خون کی درخواست' },
  formIntro: {
    en: 'Fill this in and a committee member will phone you to confirm. Donors are contacted only after that call.',
    ur: 'یہ فارم بھریں، کمیٹی کا رکن تصدیق کے لیے آپ کو فون کرے گا۔ عطیہ دہندگان سے رابطہ صرف اس کال کے بعد کیا جاتا ہے۔',
  },
  patientName: { en: 'Patient Name', ur: 'مریض کا نام' },
  requesterName: { en: 'Your Name', ur: 'آپ کا نام' },
  requesterWhatsapp: { en: 'Your Mobile / WhatsApp', ur: 'آپ کا موبائل / واٹس ایپ' },
  relation: { en: 'Your Relation to the Patient (optional)', ur: 'مریض سے آپ کا رشتہ (اختیاری)' },
  bloodGroup: { en: 'Blood Group Needed', ur: 'مطلوبہ بلڈ گروپ' },
  units: { en: 'Units Needed', ur: 'مطلوبہ بوتلیں' },
  city: { en: 'City', ur: 'شہر' },
  hospital: { en: 'Hospital', ur: 'ہسپتال' },
  neededOn: { en: 'Date Needed', ur: 'کس تاریخ کو درکار ہے' },
  neededTime: { en: 'Time (optional)', ur: 'وقت (اختیاری)' },
  notes: { en: 'Anything else we should know (optional)', ur: 'کوئی اور بات جو ہمیں معلوم ہونی چاہیے (اختیاری)' },
  submit: { en: 'Submit Request', ur: 'درخواست جمع کرائیں' },
  submitting: { en: 'Submitting...', ur: 'جمع ہو رہا ہے...' },

  whyPhone: {
    en: 'Why we phone you first: a request goes out to dozens of villagers at once. One confirming call is what keeps that from being misused.',
    ur: 'ہم پہلے فون کیوں کرتے ہیں: ایک درخواست بیک وقت درجنوں افراد تک پہنچتی ہے۔ تصدیقی کال ہی اسے غلط استعمال سے بچاتی ہے۔',
  },

  doneTitle: { en: 'Request Received', ur: 'درخواست موصول ہو گئی' },
  doneBody: {
    en: 'A committee member will phone you shortly on the number you gave. Donors are contacted as soon as that call confirms the request.',
    ur: 'کمیٹی کا رکن جلد ہی آپ کے دیے گئے نمبر پر فون کرے گا۔ کال کے ذریعے تصدیق ہوتے ہی عطیہ دہندگان سے رابطہ کیا جائے گا۔',
  },
  urgentTitle: { en: 'Needed urgently? Call us now', ur: 'فوری ضرورت ہے؟ ابھی رابطہ کریں' },
  urgentBody: {
    en: 'Do not wait for the call back if this is an emergency — ring the committee directly and we will start straight away.',
    ur: 'ہنگامی صورتحال میں کال کا انتظار نہ کریں — براہِ راست کمیٹی کو فون کریں، ہم فوراً کارروائی شروع کریں گے۔',
  },
  callNow: { en: 'Call the Committee', ur: 'کمیٹی کو کال کریں' },
  whatsappNow: { en: 'WhatsApp the Committee', ur: 'واٹس ایپ کریں' },
  another: { en: 'Submit another request', ur: 'ایک اور درخواست بھیجیں' },

  errRequired: { en: 'Please fill in every required field.', ur: 'براہِ کرم تمام لازمی خانے پُر کریں۔' },
  errGroup: { en: 'Choose the blood group needed.', ur: 'مطلوبہ بلڈ گروپ منتخب کریں۔' },
}

interface GroupCount { blood_group: string; registered: number; available_now: number }

export default function PublicBloodPage() {
  const [lang, setLang] = useState<Lang>('en')
  const [counts, setCounts] = useState<GroupCount[]>([])
  const [form, setForm] = useState({
    patientName: '', requesterName: '', requesterWhatsapp: '', relation: '',
    bloodGroup: '', units: '1', city: '', hospital: '',
    neededOn: '', neededTime: '', notes: '',
  })
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  const supabase = createClient()
  const dt = (key: keyof typeof t) => t[key][lang]
  const isUrdu = lang === 'ur'
  const waNumber = SITE.whatsapp.replace(/[^0-9]/g, '').replace(/^0/, '92')

  useEffect(() => {
    supabase.from('site_settings').select('value').eq('key', 'display_language').maybeSingle().then(({ data }) => {
      if (data?.value === 'ur') setLang('ur')
    })
    supabase.rpc('blood_group_counts').then(({ data }) => {
      if (data) setCounts(data as GroupCount[])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.patientName.trim() || !form.requesterName.trim() || !form.requesterWhatsapp.trim()
        || !form.city.trim() || !form.hospital.trim() || !form.neededOn) {
      setError(dt('errRequired')); return
    }
    if (!form.bloodGroup) { setError(dt('errGroup')); return }

    setLoading(true)
    setError('')

    // Every rule that matters lives in the RPC, not here — a form field is a
    // suggestion, and this endpoint is open to the internet.
    const { error: rpcErr } = await supabase.rpc('submit_blood_request', {
      p_patient_name: form.patientName.trim(),
      p_requester_name: form.requesterName.trim(),
      p_requester_whatsapp: form.requesterWhatsapp.trim(),
      p_blood_group: form.bloodGroup,
      p_city: form.city.trim(),
      p_hospital: form.hospital.trim(),
      p_needed_on: form.neededOn,
      p_units_needed: Number(form.units) || 1,
      p_requester_relation: form.relation.trim() || null,
      p_needed_time: form.neededTime.trim() || null,
      p_notes: form.notes.trim() || null,
    })

    setLoading(false)
    if (rpcErr) { setError(rpcErr.message); return }
    setSubmitted(true)
  }

  const helplineBlock = (
    <div className="bg-dp-error/10 border-2 border-dp-error rounded-lg p-5">
      <h3 className="font-heading text-[19px] font-bold text-dp-error mb-1.5">{dt('urgentTitle')}</h3>
      <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-4">{dt('urgentBody')}</p>
      <div className="flex flex-col sm:flex-row gap-3">
        <a href={`tel:${waNumber}`}
          className="flex-1 flex items-center justify-center gap-2 bg-dp-error text-white py-3 rounded-lg font-sans font-semibold hover:opacity-90 transition-all">
          <Phone size={17} /> {dt('callNow')}
        </a>
        <a href={`https://wa.me/${waNumber}`} target="_blank" rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-2 bg-[#25D366] text-white py-3 rounded-lg font-sans font-semibold hover:opacity-90 transition-all">
          <MessageCircle size={17} /> {dt('whatsappNow')}
        </a>
      </div>
      <p dir="ltr" className="text-center font-mono text-[19px] font-bold text-dp-error mt-3">{SITE.whatsapp}</p>
    </div>
  )

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
      <div className="max-w-2xl mx-auto">
        <Link href="/" className={`inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline mb-8 ${isUrdu ? 'flex-row-reverse' : ''}`}>
          <ArrowLeft size={16} className={isUrdu ? 'rotate-180' : ''} />
          {dt('back')}
        </Link>

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center p-3 bg-dp-error/10 rounded-full text-dp-error mb-4">
            <Droplet size={28} />
          </div>
          <h1 className="font-heading text-[32px] font-bold text-dp-primary">{dt('title')}</h1>
          <p className="font-sans text-[14.5px] text-dp-on-surface-variant mt-2 leading-relaxed">{dt('subtitle')}</p>
        </div>

        {/* Counts, and nothing that identifies anyone. */}
        {counts.length > 0 && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-8">
            <div className="grid grid-cols-4 gap-3">
              {counts.map((g) => (
                <div key={g.blood_group} className="text-center border border-dp-outline-variant rounded-lg py-3">
                  <p className="font-heading text-[18px] font-bold text-dp-error leading-none">{g.blood_group}</p>
                  <p className="font-sans text-[22px] font-bold text-dp-on-surface leading-tight mt-1">{g.registered}</p>
                  <p className="font-sans text-[10px] text-dp-on-surface-variant leading-tight">{dt('registered')}</p>
                  <p className="font-sans text-[11px] text-dp-secondary font-semibold mt-1">{g.available_now} {dt('available')}</p>
                </div>
              ))}
            </div>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-3 text-center">{dt('countsNote')}</p>
          </div>
        )}

        {submitted ? (
          <div className="space-y-6">
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <CheckCircle size={44} className="text-dp-secondary mx-auto mb-4" />
              <h2 className="font-heading text-[24px] font-bold text-dp-primary mb-2">{dt('doneTitle')}</h2>
              <p className="font-sans text-[14px] text-dp-on-surface-variant leading-relaxed">{dt('doneBody')}</p>
            </div>

            {/* The number goes up the moment a request is in, so nobody is left
                waiting on a callback during an emergency. */}
            {helplineBlock}

            <button
              onClick={() => { setSubmitted(false); setForm({ patientName: '', requesterName: '', requesterWhatsapp: '', relation: '', bloodGroup: '', units: '1', city: '', hospital: '', neededOn: '', neededTime: '', notes: '' }) }}
              className="w-full border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all">
              {dt('another')}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white border border-dp-outline-variant rounded-lg p-6">
            <h2 className="font-heading text-[22px] font-bold text-dp-primary mb-1">{dt('formTitle')}</h2>
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-5 leading-relaxed">{dt('formIntro')}</p>

            <div className="mb-5 flex items-start gap-2 text-[12.5px] font-sans text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2.5">
              <ShieldCheck size={15} className="text-dp-secondary shrink-0 mt-0.5" />
              <span>{dt('whyPhone')}</span>
            </div>

            <div className="mb-4">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('bloodGroup')} *</label>
              <div className="grid grid-cols-4 gap-2">
                {GROUPS.map((g) => (
                  <button key={g} type="button" onClick={() => setForm((p) => ({ ...p, bloodGroup: g }))}
                    className={`py-2.5 rounded-lg font-sans text-[15px] font-bold cursor-pointer transition-all ${form.bloodGroup === g ? 'bg-dp-error text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-error'}`}>
                    {g}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('patientName')} *</label>
                <input name="patientName" value={form.patientName} onChange={handleChange} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('units')} *</label>
                <input name="units" type="number" min={1} max={10} value={form.units} onChange={handleChange} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('requesterName')} *</label>
                <input name="requesterName" value={form.requesterName} onChange={handleChange} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('requesterWhatsapp')} *</label>
                <input name="requesterWhatsapp" value={form.requesterWhatsapp} onChange={handleChange} dir="ltr" placeholder="03XX-XXXXXXX" className="input-field" />
              </div>
              <div className="sm:col-span-2">
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('relation')}</label>
                <input name="relation" value={form.relation} onChange={handleChange} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('hospital')} *</label>
                <input name="hospital" value={form.hospital} onChange={handleChange} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('city')} *</label>
                <input name="city" value={form.city} onChange={handleChange} placeholder="Chakwal" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('neededOn')} *</label>
                <input name="neededOn" type="date" value={form.neededOn} onChange={handleChange} dir="ltr" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('neededTime')}</label>
                <input name="neededTime" value={form.neededTime} onChange={handleChange} placeholder="e.g. 9:00 AM" className="input-field" />
              </div>
            </div>

            <div className="mb-5">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('notes')}</label>
              <textarea name="notes" value={form.notes} onChange={handleChange} rows={3} className="input-field" />
            </div>

            {error && <p className="font-sans text-[13.5px] text-dp-error mb-4">{error}</p>}

            <button type="submit" disabled={loading}
              className="w-full bg-dp-error text-white py-3.5 rounded-lg font-sans font-semibold cursor-pointer hover:opacity-90 transition-all disabled:opacity-50">
              {loading ? dt('submitting') : dt('submit')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
