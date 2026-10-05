'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, ShieldCheck, Lock, KeyRound, CheckCircle, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'
import { PasswordChecklist } from '@/components/shared/PasswordChecklist'

// Rewritten 2026-10-05 (migration 565) off the old clickable-magic-link/
// hash-session flow onto a typed-in code — see
// /api/admin/accept-invite-with-code's comment for why: the old link got
// silently consumed by email security scanners before the real invitee
// ever clicked it. No Supabase session is created by this page at all;
// the account is created directly, server-side, once the code checks out,
// so there's nothing to redirect into afterward — the invitee signs in
// normally with the password they just chose.
export default function AcceptInvitePage() {
  const { t } = useLocale()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!email.trim()) { setError('Enter the email address the invite was sent to.'); return }
    if (!code.trim()) { setError(t('p.enterResetCode')); return }
    if (!passwordMeetsPolicy(password)) { setError(t('p.passwordPolicyNotMet')); return }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/admin/accept-invite-with-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? t('p.networkErrorRetry')); setSaving(false); return }
      setDone(true)
    } catch {
      setError(t('p.networkErrorRetry'))
    }
    setSaving(false)
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
            <p className="text-white/60 text-[12px] font-sans">{t('y.acceptInvite')}</p>
          </div>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 shadow-sm">
          {done ? (
            <div className="text-center py-4">
              <CheckCircle size={40} className="text-dp-secondary mx-auto mb-3" />
              <p className="font-sans font-semibold text-dp-on-surface mb-2">{t('y.accountActivated')}</p>
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-6">{t('y.signInNow')}</p>
              <button onClick={() => router.push('/admin/login')} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                {t('g.backToSignIn')}
              </button>
            </div>
          ) : (
            <>
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
                  <ShieldCheck size={22} className="text-dp-on-primary-container" />
                </div>
                <h2 className="font-heading text-[24px] font-bold text-dp-primary mb-1">{t('y.setYourPassword')}</h2>
                <p className="text-dp-on-surface-variant text-[13px] font-sans">{t('y.choosePassword')}</p>
              </div>

              <form onSubmit={submit} className="space-y-5">
                <div>
                  <label htmlFor="email" className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('a.email')}</label>
                  <input
                    id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email"
                    disabled={saving}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface disabled:opacity-50"
                    placeholder="you@example.com" dir="ltr"
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('y.inviteCode')}</label>
                  <div className="relative">
                    <KeyRound size={16} className="absolute start-4 top-1/2 -translate-y-1/2 text-dp-on-surface-variant" />
                    <input
                      value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))} required inputMode="numeric" maxLength={6}
                      className="w-full ps-11 pe-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[20px] font-mono tracking-[0.3em] text-center text-dp-on-surface"
                      placeholder="000000" dir="ltr"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('w.password')}</label>
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      className="w-full px-4 py-3 pe-12 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface"
                      placeholder="Choose a strong password"
                    />
                    <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute end-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1" tabIndex={-1}>
                      {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  <PasswordChecklist password={password} />
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('y.confirmPassword')}</label>
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface"
                    placeholder="Re-enter your password"
                  />
                </div>

                {error && (
                  <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
                    <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'Activating...' : 'Activate Account'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
