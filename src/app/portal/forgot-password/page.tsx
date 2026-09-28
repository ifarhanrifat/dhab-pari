'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Lock, Mail, KeyRound, Eye, EyeOff, CheckCircle, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'
import { PasswordChecklist } from '@/components/shared/PasswordChecklist'

// Two steps on one page rather than a separate /portal/reset-password —
// see forgot-password route's own comment for why this moved off a
// clickable magic link onto a typed-in code: no link to pre-fetch, no
// "which of several emails is current" ambiguity, and the whole exchange
// is a plain server API call with no Supabase session/hash detection
// involved at all.
export default function PortalForgotPasswordPage() {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/portal/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!res.ok) { setError(t('p.networkErrorRetry')); setLoading(false); return }
      setStep('code')
    } catch {
      setError(t('p.networkErrorRetry'))
    }
    setLoading(false)
  }

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!code.trim()) { setError(t('p.enterResetCode')); return }
    if (!passwordMeetsPolicy(newPassword)) { setError(t('p.passwordMinLength')); return }
    if (newPassword !== confirmNewPassword) { setError(t('p.passwordsDontMatch')); return }
    setLoading(true)
    try {
      const res = await fetch('/api/portal/reset-password-with-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim(), newPassword }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? t('p.networkErrorRetry')); setLoading(false); return }
      setStep('done')
    } catch {
      setError(t('p.networkErrorRetry'))
    }
    setLoading(false)
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-h-screen bg-[#E1F5EE] flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-dp-primary flex items-center justify-center text-white mb-4">
          <Lock size={22} />
        </div>
        <h1 className="font-heading text-[22px] font-bold text-dp-primary">{t('p.resetTitle')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{SITE.shortCommittee}</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 md:p-8 w-full max-w-sm">
        {step === 'done' ? (
          <div className="text-center py-4">
            <CheckCircle size={40} className="text-dp-secondary mx-auto mb-3" />
            <p className="font-sans font-semibold text-dp-on-surface mb-2">{t('p.passwordResetSuccess')}</p>
            <button onClick={() => router.push('/portal/login')} className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">
              {t('g.backToSignIn')}
            </button>
          </div>
        ) : step === 'code' ? (
          <>
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
                <KeyRound size={22} className="text-dp-on-primary-container" />
              </div>
              <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-1">{t('p.enterCodeAndNewPassword')}</h2>
              <p className="text-dp-on-surface-variant text-[13px] font-sans">{t('p.resetCodeSentTo')} <strong>{email}</strong></p>
            </div>
            <form onSubmit={submitReset} className="space-y-5">
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('p.resetCode')}</label>
                <input
                  value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))} required inputMode="numeric" maxLength={6}
                  className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[20px] font-mono tracking-[0.3em] text-center text-dp-on-surface"
                  placeholder="000000" dir="ltr"
                />
              </div>
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('p.newPassword')}</label>
                <div className="relative">
                  <input type={showPw ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoComplete="new-password"
                    className="w-full px-4 py-3 pe-12 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface" placeholder="Choose a strong password" />
                  <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute end-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1" tabIndex={-1}>
                    {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <PasswordChecklist password={newPassword} />
              </div>
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('g.confirmNewPassword')}</label>
                <input type={showPw ? 'text' : 'password'} value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} required autoComplete="new-password"
                  className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface" placeholder="Re-enter your new password" />
              </div>

              {error && (
                <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button type="submit" disabled={loading} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? t('ap.sending') : t('y.chooseNewPassword')}
              </button>
              <button type="button" onClick={() => requestCode()} disabled={loading} className="w-full text-center font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer">
                {t('p.resendCode')}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
                <Mail size={22} className="text-dp-on-primary-container" />
              </div>
              <h2 className="font-heading text-[22px] font-bold text-dp-primary mb-1">{t('g.resetPassword')}</h2>
              <p className="text-dp-on-surface-variant text-[13px] font-sans">{t('g.enterEmailReset')}</p>
            </div>

            <form onSubmit={requestCode} className="space-y-5">
              <div>
                <label htmlFor="email" className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('a.email')}</label>
                <input
                  id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email"
                  disabled={loading}
                  className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface disabled:opacity-50"
                  placeholder="you@example.com" dir="ltr"
                />
              </div>

              {error && (
                <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit" disabled={loading}
                className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? t('ap.sending') : t('g.resetPassword')}
              </button>
            </form>

            <Link href="/portal/login" className="flex items-center justify-center gap-1.5 mt-6 font-sans text-[13px] font-semibold text-dp-secondary hover:underline">
              <ArrowLeft size={14} /> {t('g.backToSignIn')}
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
