'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Send, CheckCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const systems = [
  { key: 'water_supply', label: 'Water Supply', labelUr: 'واٹر سپلائی' },
  { key: 'donors_projects', label: 'Donors & Projects', labelUr: 'ڈونرز اینڈ پراجیکٹس' },
]

export default function ComplaintsPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const [system, setSystem] = useState<'water_supply' | 'donors_projects'>('water_supply')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [sector, setSector] = useState('')
  const [sectors, setSectors] = useState<{ id: string; name: string }[]>([])
  const [complaintText, setComplaintText] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [complaintNumber, setComplaintNumber] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.from('sectors').select('id, name').order('display_order').order('name').then(({ data }) => setSectors(data ?? []))
  }, [supabase])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!complaintText.trim()) { setError('Please describe your complaint.'); return }
    setLoading(true)
    setError('')

    const { data, error: insertErr } = await supabase.from('complaints').insert({
      system, complainant_name: name.trim() || null, phone: phone.trim() || null,
      sector: sector || null, complaint_text: complaintText.trim(), source: 'website',
    }).select('complaint_number').single()

    if (insertErr) {
      setError('Failed to submit. Please try again.')
      setLoading(false)
      return
    }

    setComplaintNumber(data.complaint_number)
    setSubmitted(true)
    setLoading(false)
  }

  const reset = () => {
    setSubmitted(false)
    setName(''); setPhone(''); setSector(''); setComplaintText(''); setError('')
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-10">
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp2-primary mb-2">
            {t('x.fileComplaint')}
          </h1>
          <p className="text-slate-500 font-sans text-[18px] leading-[28px]">
            Tell us what went wrong — a committee member will be assigned to look into it.
          </p>
          <p className="text-slate-500 text-[18px] mt-2" style={{ fontFamily: 'var(--font-urdu-ui)', lineHeight: '1.6' }}>
            اپنی شکایت درج کروائیں — کمیٹی کا ایک رکن اس پر کام کرے گا
          </p>
          <p className="font-sans text-[13px] text-slate-500 mt-3">
            {t('x.generalSuggestion')} <Link href="/suggestions" className="text-dp2-primary-dark hover:underline">{t('x.goCommunityInput')}</Link>
          </p>
        </div>

        {submitted ? (
          <div className="bg-white border border-dp2-card-border rounded-lg p-12 text-center">
            <CheckCircle size={48} className="text-dp2-primary-dark mx-auto mb-4" />
            <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp2-primary mb-2">{t('x.complaintRegistered')}</h2>
            <p className="text-slate-500 font-sans text-[16px] mb-1">
              {t('x.yourComplaintNumber')} <span className="font-bold text-dp2-primary">{complaintNumber}</span> — keep it for reference.
            </p>
            <p className="text-slate-500 font-sans text-[15px] mb-6">
              We&apos;ll follow up on the number you provided once it&apos;s resolved.
            </p>
            <button onClick={reset} className="bg-dp2-primary-dark text-white px-8 py-3 rounded-lg font-sans font-semibold hover:bg-dp2-primary transition-all cursor-pointer">
              {t('x.fileAnother')}
            </button>
          </div>
        ) : (
          <div className="bg-white border border-dp2-card-border rounded-lg p-6 md:p-8">
            <div className="flex flex-wrap gap-3 mb-6 justify-center">
              {systems.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSystem(s.key as 'water_supply' | 'donors_projects')}
                  className={`px-5 py-2 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em] transition-all cursor-pointer ${system === s.key ? 'bg-dp2-primary text-white' : 'bg-white border border-dp2-card-border text-slate-500 hover:border-dp2-primary hover:text-dp2-primary'}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-slate-500 mb-2">NAME (Optional) / نام</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="w-full px-4 py-3 bg-white border-2 border-dp2-card-border rounded-lg focus:border-dp2-primary-dark focus:ring-0 transition-all font-sans text-[16px] text-slate-800" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-slate-500 mb-2">MOBILE (Optional) / موبائل نمبر</label>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0300-1234567" className="w-full px-4 py-3 bg-white border-2 border-dp2-card-border rounded-lg focus:border-dp2-primary-dark focus:ring-0 transition-all font-sans text-[16px] text-slate-800" />
                <p className="font-sans text-[12px] text-slate-500 mt-1.5">We&apos;ll message you here on WhatsApp once it&apos;s resolved.</p>
              </div>
              {system === 'water_supply' && (
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-slate-500 mb-2">SECTOR (Optional) / سیکٹر</label>
                  <select value={sector} onChange={(e) => setSector(e.target.value)} className="w-full px-4 py-3 bg-white border-2 border-dp2-card-border rounded-lg focus:border-dp2-primary-dark focus:ring-0 transition-all font-sans text-[16px] text-slate-800">
                    <option value="">{t('w.selectSector')}</option>
                    {sectors.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-slate-500 mb-2">COMPLAINT * / شکایت</label>
                <textarea
                  value={complaintText} onChange={(e) => setComplaintText(e.target.value)} required rows={5}
                  placeholder="Describe the issue in detail..."
                  className="w-full px-4 py-3 bg-white border-2 border-dp2-card-border rounded-lg focus:border-dp2-primary-dark focus:ring-0 transition-all font-sans text-[16px] text-slate-800 resize-none"
                />
              </div>
              {error && (
                <div className="bg-red-100 text-red-800 px-4 py-3 rounded-lg font-sans text-[14px]">{error}</div>
              )}
              <button
                type="submit" disabled={loading}
                className="w-full bg-dp2-primary-dark text-white py-4 rounded-lg font-sans text-[18px] font-semibold hover:bg-dp2-primary transition-all active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50 cursor-pointer"
              >
                <Send size={18} />
                {loading ? 'Submitting...' : 'Submit Complaint / جمع کرائیں'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
