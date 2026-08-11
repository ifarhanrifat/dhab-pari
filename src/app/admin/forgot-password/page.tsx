'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Lock, Mail, CheckCircle, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export default function ForgotPasswordPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    // Supabase intentionally returns success here regardless of whether the
    // email matches an account — revealing that would let an attacker
    // enumerate valid staff emails. The UI always shows the same message.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/admin/reset-password`,
    })
    setLoading(false)
    if (resetError) {
      setError('Something went wrong. Please try again in a moment.')
      return
    }
    setSent(true)
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
          {sent ? (
            <div className="text-center py-4">
              <CheckCircle size={40} className="text-dp-secondary mx-auto mb-3" />
              <p className="font-sans font-semibold text-dp-on-surface mb-2">{t('g.checkEmail')}</p>
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant">
                If <strong>{email}</strong> is a registered admin account, a password reset link has been sent to it.
              </p>
              <Link href="/admin/login" className="inline-flex items-center gap-1.5 mt-6 font-sans text-[13px] font-semibold text-dp-secondary hover:underline">
                <ArrowLeft size={14} /> {t('g.backToSignIn')}
              </Link>
            </div>
          ) : (
            <>
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
                  <Mail size={22} className="text-dp-on-primary-container" />
                </div>
                <h2 className="font-heading text-[24px] font-bold text-dp-primary mb-1">{t('g.resetPassword')}</h2>
                <p className="text-dp-on-surface-variant text-[13px] font-sans">{t('g.enterEmailReset')}</p>
              </div>

              <form onSubmit={submit} className="space-y-5">
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
                  {loading ? 'Sending...' : 'Send Reset Link'}
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
