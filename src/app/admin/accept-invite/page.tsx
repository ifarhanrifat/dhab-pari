'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff, ShieldCheck, Lock, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export default function AcceptInvitePage() {
  const { t } = useLocale()
  const [checking, setChecking] = useState(true)
  const [validSession, setValidSession] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  // Captured on first render, before Supabase's client can consume/clear it.
  // This is what actually tells "this navigation just carried a fresh invite
  // token" apart from "this browser tab already had an unrelated session
  // sitting around" (e.g. an admin testing a dead link while still logged
  // into their own account) — a plain getSession() can't make that
  // distinction, since a failed/expired token exchange never touches a
  // session that was already there before the link was opened.
  const [initialHash] = useState(() => (typeof window !== 'undefined' ? window.location.hash : ''))

  useEffect(() => {
    if (initialHash.includes('error=') || !initialHash.includes('access_token=')) {
      setValidSession(false)
      setChecking(false)
      return
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setValidSession(!!session)
      setChecking(false)
    })
  }, [supabase, initialHash])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return }

    setSaving(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setSaving(false)
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      await supabase.from('admin_users').update({ invite_accepted_at: new Date().toISOString() }).eq('auth_user_id', user.id)
    }

    router.push('/admin')
    router.refresh()
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
          {checking ? (
            <p className="text-center font-sans text-dp-on-surface-variant py-8">{t('y.checkingInvite')}</p>
          ) : !validSession ? (
            <div className="text-center py-8">
              <AlertTriangle size={40} className="text-dp-error mx-auto mb-3" />
              <p className="font-sans font-semibold text-dp-on-surface mb-2">{t('y.inviteInvalid')}</p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('y.askAdminInvite')}</p>
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
                  <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('w.password')}</label>
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      autoComplete="new-password"
                      className="w-full px-4 py-3 pe-12 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface"
                      placeholder="At least 8 characters"
                    />
                    <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1" tabIndex={-1}>
                      {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('y.confirmPassword')}</label>
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
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
