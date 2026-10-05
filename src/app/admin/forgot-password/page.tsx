'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Lock, Mail, KeyRound, Eye, EyeOff, CheckCircle, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'
import { PasswordChecklist } from '@/components/shared/PasswordChecklist'

// Rewritten 2026-10-05 (migration 565) off supabase.auth.resetPasswordForEmail()'s
// clickable magic link onto a typed-in code, mirroring /portal/forgot-password —
// see that page's comment for why: the link gets silently consumed by email
// security scanners before the real admin ever clicks it. Two steps on one
// page rather than a separate /admin/reset-password, same as the portal.
export default function AdminForgotPasswordPage() {
  const { t } = useLocale()
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
      const res = await fetch('/api/admin/forgot-password', {
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
      const res = await fetch('/api/admin/reset-password-with-code', {
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
    <div className="min-h-screen bg-[#E1F5EE] flex flex-col">
      <header className="bg-dp-primary w-full px-6 py-4">
        <div className="max-w-[1200px] mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center">
            <Lock size={18} className="text-white" />
          </div>
          <div>
            <h1 className="font-heading text-[24px] font-bold leading-[32px] text-white">{SITE.name}</h1>
            <p className="text-white/60 text-[12px] font-sans">{t('y.resetTitle')}</p>
          </div>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 shadow-sm">
          {step === 'done' ? (
            <div className="text-center py-4">
              <CheckCircle size={40} className="text-dp-secondary mx-auto mb-3" />
              <p className="font-sans font-semibold text-dp-on-surface mb-2">Your password was changed.</p>
              <button onClick={() => router.push('/admin/login')} className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">
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
                  <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('y.newPassword')}</label>
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
                <h2 className="font-heading text-[24px] font-bold text-dp-primary mb-1">{t('g.resetPassword')}</h2>
                <p className="text-dp-on-surface-variant text-[13px] font-sans">{t('g.enterEmailReset')}</p>
              </div>

              <form onSubmit={requestCode} className="space-y-5">
                <div>
                  <label htmlFor="email" className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('a.email')}</label>
                  <input
                    id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username"
                    disabled={loading}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface disabled:opacity-50"
                    placeholder="admin@dhabpari.com"
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

              <Link href="/admin/login" className="flex items-center justify-center gap-1.5 mt-6 font-sans text-[13px] font-semibold text-dp-secondary hover:underline">
                <ArrowLeft size={14} /> {t('g.backToSignIn')}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
