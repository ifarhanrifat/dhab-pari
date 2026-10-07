'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { HeartHandshake, AlertTriangle, KeyRound } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SectorSelect } from '@/components/portal/SectorSelect'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'
import { PasswordChecklist } from '@/components/shared/PasswordChecklist'

// Real ask, 2026-09-28: email verification is now mandatory before an
// account is created at all — see /api/portal/signup/request-code and
// confirm-code, and portalSignup.ts's own comment on why the form itself
// (password included) is never persisted server-side while waiting on
// the code: this component holds it in memory across the two steps and
// resends it in full once the code comes back, rather than the server
// ever storing a raw password outside the final create call.
interface VillageOption { id: string; name: string; name_ur: string | null }

function readCookieTenantId(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|; )x-tenant-id=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export default function PortalSignupPage() {
  const { t, isUrdu } = useLocale()
  const [form, setForm] = useState({
    full_name: '', name_ur: '', father_husband_name: '', mobile: '', whatsapp_number: '',
    donor_type: 'villager', country: '', sector: '', username: '', email: '', password: '',
  })
  const [sectors, setSectors] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<'form' | 'code'>('form')
  const [code, setCode] = useState('')
  const router = useRouter()

  // Which village this signup belongs to. On a village's own subdomain,
  // the cookie src/proxy.ts set from the Host header is authoritative —
  // shown read-only, nothing to pick wrong. Only on the primary domain
  // (no cookie at all) does signup show a real picker, since there's no
  // way to know which village someone means otherwise. Either way, once
  // the account is created this can never be changed again — see
  // confirm-code's own server-side resolution, which trusts the cookie
  // over anything this page sends.
  const cookieTenantId = useState(() => readCookieTenantId())[0]
  const [villageConfirmed, setVillageConfirmed] = useState<VillageOption | null>(null)
  const [villageOptions, setVillageOptions] = useState<VillageOption[]>([])
  const [selectedVillageId, setSelectedVillageId] = useState('')

  useEffect(() => {
    createClient().from('sectors').select('name').order('display_order').order('name').then(({ data }) => setSectors((data ?? []).map((s) => s.name)))
  }, [])

  useEffect(() => {
    const supabase = createClient()
    if (cookieTenantId) {
      supabase.from('tenants').select('id, name, name_ur').eq('id', cookieTenantId).maybeSingle()
        .then(({ data }) => setVillageConfirmed(data as VillageOption | null))
    } else {
      supabase.from('tenants').select('id, name, name_ur').eq('is_active', true).order('name')
        .then(({ data }) => setVillageOptions((data as VillageOption[]) ?? []))
    }
  }, [cookieTenantId])

  const validateForm = () => {
    if (!form.full_name.trim() || !form.father_husband_name.trim() || !form.mobile.trim() || !form.whatsapp_number.trim() || !form.username.trim() || !form.password || !form.email.trim()) {
      return t('p.signupRequiredFields')
    }
    if (!cookieTenantId && !selectedVillageId) {
      return 'Please choose your village.'
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      return t('p.invalidEmail')
    }
    if (!/^[a-zA-Z0-9_]{6,30}$/.test(form.username.trim())) {
      return t('p.usernameFormatPeriod')
    }
    if (form.donor_type === 'overseas' && !form.country.trim()) {
      return t('p.enterCountryPeriod')
    }
    if (!passwordMeetsPolicy(form.password)) {
      return t('p.passwordMinLengthPeriod')
    }
    return null
  }

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError('')
    const fieldError = validateForm()
    if (fieldError) { setError(fieldError); return }
    setLoading(true)
    try {
      const res = await fetch('/api/portal/signup/request-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, tenant_id: selectedVillageId || undefined }), credentials: 'same-origin',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('p.couldNotCreateAccount'))
        setLoading(false)
        return
      }
      setStep('code')
    } catch {
      setError(t('p.networkErrorRetry'))
    }
    setLoading(false)
  }

  const confirmCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!code.trim()) { setError(t('p.enterResetCode')); return }
    setLoading(true)
    try {
      const res = await fetch('/api/portal/signup/confirm-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, code: code.trim(), tenant_id: selectedVillageId || undefined }), credentials: 'same-origin',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('p.couldNotCreateAccount'))
        setLoading(false)
        return
      }
      router.push('/portal/welcome')
      router.refresh()
    } catch {
      setError(t('p.networkErrorRetry'))
      setLoading(false)
    }
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-h-screen bg-[#E1F5EE] flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-dp-primary flex items-center justify-center text-white mb-4">
          <HeartHandshake size={26} />
        </div>
        <h1 className="font-heading text-[24px] font-bold text-dp-primary">{t('p.createAccount')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.oneAccount')}</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 md:p-8 w-full max-w-md">
        {step === 'code' ? (
          <form onSubmit={confirmCode} className="space-y-5">
            <div className="text-center mb-2">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
                <KeyRound size={22} className="text-dp-on-primary-container" />
              </div>
              <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-1">{t('p.verifyYourEmail')}</h2>
              <p className="text-dp-on-surface-variant text-[13px] font-sans">{t('p.verifyEmailSentTo')} <strong dir="ltr" className="inline-block">{form.email}</strong></p>
            </div>
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('p.resetCode')}</label>
              <input
                value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))} required inputMode="numeric" maxLength={6}
                className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[20px] font-mono tracking-[0.3em] text-center text-dp-on-surface"
                placeholder="000000" dir="ltr" autoFocus
              />
            </div>

            {error && (
              <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50">
              {loading ? t('p.verifying') : t('p.createAccountBtn')}
            </button>
            <button type="button" onClick={() => requestCode()} disabled={loading} className="w-full text-center font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer">
              {t('p.resendCode')}
            </button>
            <button type="button" onClick={() => { setStep('form'); setError('') }} className="w-full text-center font-sans text-[12.5px] text-dp-on-surface-variant hover:underline cursor-pointer">
              {t('p.editDetails')}
            </button>
          </form>
        ) : (
        <form onSubmit={requestCode} className="space-y-4">
          {cookieTenantId ? (
            villageConfirmed && (
              <div className="bg-dp-primary-container px-4 py-3 rounded-lg flex items-center gap-2">
                <span className="font-sans text-[13px] text-dp-on-primary-container">
                  Village: <strong>{isUrdu && villageConfirmed.name_ur ? villageConfirmed.name_ur : villageConfirmed.name}</strong>
                </span>
                <span className="text-dp-on-primary-container text-[13px]">✓</span>
              </div>
            )
          ) : (
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Village *</label>
              <select value={selectedVillageId} onChange={(e) => setSelectedVillageId(e.target.value)} required className="input-field">
                <option value="">Choose your village</option>
                {villageOptions.map((v) => (
                  <option key={v.id} value={v.id}>{isUrdu && v.name_ur ? v.name_ur : v.name}</option>
                ))}
              </select>
              <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">This cannot be changed once your account is created.</p>
            </div>
          )}
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('g.fullNameReq')}</label>
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required className="input-field" />
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('p.fullNamePrivateHint')}</p>
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.nameUrdu')}</label>
            <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder="اردو میں نام" className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('g.fatherReq')}</label>
            <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} required className="input-field" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('g.mobileReq')}</label>
              <input type="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} required placeholder="0300-1234567" className="input-field" />
            </div>
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('g.whatsappReq')}</label>
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
              <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('p.overseasHint')}</p>
            </div>
            {form.donor_type === 'overseas' ? (
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.country')}</label>
                <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} required className="input-field" />
              </div>
            ) : (
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('w.sector')}</label>
                <SectorSelect sectors={sectors} value={form.sector} onChange={(v) => setForm({ ...form, sector: v })} />
              </div>
            )}
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('g.usernameReq')}</label>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required placeholder="6+ characters, no spaces" className="input-field" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('p.usernameHint')}</p>
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('g.emailReq')}</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className="input-field" />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('g.passwordReq')}</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete="new-password" className="input-field" />
            <PasswordChecklist password={form.password} />
          </div>

          {error && (
            <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={loading}
            className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50">
            {loading ? t('p.sendingCode') : t('p.sendCode')}
          </button>
        </form>
        )}

        <p className="text-center font-sans text-[14px] text-dp-on-surface-variant mt-6">
          {t('p.alreadyHaveAccount')} <Link href="/portal/login" className="text-dp-secondary font-semibold hover:underline">{t('p.logIn')}</Link>
        </p>
      </div>
    </div>
  )
}
