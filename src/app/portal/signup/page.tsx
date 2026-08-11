'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { HeartHandshake, AlertTriangle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export default function PortalSignupPage() {
  const { t } = useLocale()
  const [form, setForm] = useState({
    full_name: '', name_ur: '', father_husband_name: '', mobile: '', whatsapp_number: '',
    donor_type: 'villager', country: '', sector: '', username: '', email: '', password: '',
  })
  const [sectors, setSectors] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  useEffect(() => {
    createClient().from('sectors').select('name').order('display_order').order('name').then(({ data }) => setSectors((data ?? []).map((s) => s.name)))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.full_name.trim() || !form.father_husband_name.trim() || !form.mobile.trim() || !form.whatsapp_number.trim() || !form.username.trim() || !form.password) {
      setError("Name, father's/husband's name, mobile, WhatsApp number, username, and password are required.")
      return
    }
    if (!/^[a-zA-Z0-9_]{6,30}$/.test(form.username.trim())) {
      setError('Username must be 6-30 characters: letters, numbers, and underscores only.')
      return
    }
    if (form.donor_type === 'overseas' && !form.country.trim()) {
      setError('Please enter your country.')
      return
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/portal/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form), credentials: 'same-origin',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not create account.')
        setLoading(false)
        return
      }
      router.push('/portal')
      router.refresh()
    } catch {
      setError('Network error. Please check your connection and try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#E1F5EE] flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-dp-primary flex items-center justify-center text-white mb-4">
          <HeartHandshake size={26} />
        </div>
        <h1 className="font-heading text-[24px] font-bold text-dp-primary">{t('p.createAccount')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.oneAccount')}</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 md:p-8 w-full max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Full Name *</label>
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required className="input-field" />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.nameUrdu')}</label>
            <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder="اردو میں نام" className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Father&apos;s / Husband&apos;s Name *</label>
            <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} required className="input-field" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Mobile *</label>
              <input type="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} required placeholder="0300-1234567" className="input-field" />
            </div>
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">WhatsApp *</label>
              <input type="tel" value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} required placeholder="0300-1234567" className="input-field" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.youAre')}</label>
              <select value={form.donor_type} onChange={(e) => setForm({ ...form, donor_type: e.target.value, country: '' })} className="input-field">
                <option value="villager">{t('w.villageResident')}</option>
                <option value="overseas">{t('w.overseas')}</option>
              </select>
            </div>
            {form.donor_type === 'overseas' ? (
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.country')}</label>
                <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} required className="input-field" />
              </div>
            ) : (
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.sector')}</label>
                <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} list="sector-options" placeholder="Select or type your sector" className="input-field" />
                <datalist id="sector-options">
                  {sectors.map((s) => <option key={s} value={s} />)}
                </datalist>
              </div>
            )}
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Username *</label>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required placeholder="6+ characters, no spaces" className="input-field" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">Used to log in — never your phone number. This will also be your public name for community features.</p>
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.emailOptional')}</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input-field" />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Password *</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete="new-password" className="input-field" />
          </div>

          {error && (
            <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={loading}
            className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50">
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <p className="text-center font-sans text-[14px] text-dp-on-surface-variant mt-6">
          {t('p.alreadyHaveAccount')} <Link href="/portal/login" className="text-dp-secondary font-semibold hover:underline">{t('p.logIn')}</Link>
        </p>
      </div>
    </div>
  )
}
