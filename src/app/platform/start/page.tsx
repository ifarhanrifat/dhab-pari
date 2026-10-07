'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, KeyRound, Building2, CheckCircle2 } from 'lucide-react'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'
import { PasswordChecklist } from '@/components/shared/PasswordChecklist'

interface PlanOption { id: string; key: string; name: string; monthly_price_pkr: number; commission_pct: number; max_admin_users: number | null }

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 63)
}

// Public self-serve signup for a brand new committee/village -- mirrors
// /portal/signup's two-step request-code/confirm-code shape exactly (see
// that page's own comment for why the form is never persisted server-side
// while waiting on the code). This one creates a whole TENANT though, not
// just a user row within one, so it also carries a plan picker and a
// slug (subdomain) field the portal signup never needed.
export default function PlatformStartPage() {
  const [form, setForm] = useState({
    committee_name: '', name_ur: '', slug: '', admin_full_name: '', admin_email: '', password: '', plan_id: '',
  })
  const [slugEdited, setSlugEdited] = useState(false)
  const [plans, setPlans] = useState<PlanOption[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<'form' | 'code'>('form')
  const [code, setCode] = useState('')
  const router = useRouter()

  useEffect(() => {
    createClient().from('subscription_plans').select('id, key, name, monthly_price_pkr, commission_pct, max_admin_users')
      .eq('is_active', true).order('monthly_price_pkr').then(({ data }) => {
        const list = (data as PlanOption[]) ?? []
        setPlans(list)
        if (list.length && !form.plan_id) setForm((f) => ({ ...f, plan_id: list[0].id }))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onNameChange = (value: string) => {
    setForm((f) => ({ ...f, committee_name: value, slug: slugEdited ? f.slug : slugify(value) }))
  }

  const validateForm = () => {
    if (!form.committee_name.trim() || !form.slug.trim() || !form.admin_full_name.trim() || !form.admin_email.trim() || !form.password || !form.plan_id) {
      return 'All fields are required.'
    }
    if (!/^[a-z0-9-]{2,63}$/.test(form.slug.trim())) {
      return 'Subdomain must be lowercase letters, numbers, and hyphens only.'
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.admin_email.trim())) {
      return 'Enter a valid email address.'
    }
    if (!passwordMeetsPolicy(form.password)) {
      return 'Password does not meet the requirements.'
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
      const res = await fetch('/api/platform/start/request-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form), credentials: 'same-origin',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not send the verification code.')
        setLoading(false)
        return
      }
      setStep('code')
    } catch {
      setError('Network error. Please try again.')
    }
    setLoading(false)
  }

  const confirmCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!code.trim()) { setError('Enter the code sent to your email.'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/platform/start/confirm-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, code: code.trim() }), credentials: 'same-origin',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not create your account.')
        setLoading(false)
        return
      }
      router.push('/admin')
      router.refresh()
    } catch {
      setError('Network error. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#E1F5EE] flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-dp-primary flex items-center justify-center text-white mb-4">
          <Building2 size={26} />
        </div>
        <h1 className="font-heading text-[24px] font-bold text-dp-primary">Set up your committee</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Start a free trial -- no payment required today.</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 md:p-8 w-full max-w-md">
        {step === 'code' ? (
          <form onSubmit={confirmCode} className="space-y-5">
            <div className="text-center mb-2">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
                <KeyRound size={22} className="text-dp-on-primary-container" />
              </div>
              <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-1">Verify your email</h2>
              <p className="text-dp-on-surface-variant text-[13px] font-sans">We sent a code to <strong dir="ltr" className="inline-block">{form.admin_email}</strong></p>
            </div>
            <div>
              <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">Verification code</label>
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
              {loading ? 'Verifying...' : 'Create committee account'}
            </button>
            <button type="button" onClick={() => requestCode()} disabled={loading} className="w-full text-center font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer">
              Resend code
            </button>
            <button type="button" onClick={() => { setStep('form'); setError('') }} className="w-full text-center font-sans text-[12.5px] text-dp-on-surface-variant hover:underline cursor-pointer">
              Edit details
            </button>
          </form>
        ) : (
        <form onSubmit={requestCode} className="space-y-4">
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Committee name *</label>
            <input value={form.committee_name} onChange={(e) => onNameChange(e.target.value)} required className="input-field" placeholder="e.g. Dhab Khushal Welfare Committee" />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Committee name (Urdu)</label>
            <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder="اردو میں نام" className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Subdomain *</label>
            <div className="flex items-center gap-1">
              <input value={form.slug} onChange={(e) => { setSlugEdited(true); setForm({ ...form, slug: slugify(e.target.value) }) }} required dir="ltr" className="input-field flex-1" placeholder="your-committee" />
            </div>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">Your portal will be reachable at <strong dir="ltr">{form.slug || 'your-committee'}.dhabpari.com</strong></p>
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Your full name *</label>
            <input value={form.admin_full_name} onChange={(e) => setForm({ ...form, admin_full_name: e.target.value })} required className="input-field" />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Your email *</label>
            <input type="email" value={form.admin_email} onChange={(e) => setForm({ ...form, admin_email: e.target.value })} required className="input-field" />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">Password *</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete="new-password" className="input-field" />
            <PasswordChecklist password={form.password} />
          </div>
          <div>
            <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">Choose a plan *</label>
            <div className="space-y-2">
              {plans.map((p) => (
                <label key={p.id} className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-all ${form.plan_id === p.id ? 'border-dp-secondary bg-dp-primary-container' : 'border-dp-outline-variant'}`}>
                  <div className="flex items-center gap-2">
                    <input type="radio" name="plan" checked={form.plan_id === p.id} onChange={() => setForm({ ...form, plan_id: p.id })} className="accent-dp-secondary" />
                    <div>
                      <p className="font-sans font-semibold text-[14px] text-dp-on-surface">{p.name}</p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        PKR {p.monthly_price_pkr}/mo{p.max_admin_users ? ` · up to ${p.max_admin_users} admins` : ''}
                      </p>
                    </div>
                  </div>
                  {form.plan_id === p.id && <CheckCircle2 size={18} className="text-dp-secondary shrink-0" />}
                </label>
              ))}
            </div>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-2">14-day free trial on any plan -- no payment needed to get started.</p>
          </div>

          {error && (
            <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={loading}
            className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50">
            {loading ? 'Sending code...' : 'Send verification code'}
          </button>
        </form>
        )}

        <p className="text-center font-sans text-[14px] text-dp-on-surface-variant mt-6">
          Already have a committee account? <Link href="/admin/login" className="text-dp-secondary font-semibold hover:underline">Log in</Link>
        </p>
      </div>
    </div>
  )
}
