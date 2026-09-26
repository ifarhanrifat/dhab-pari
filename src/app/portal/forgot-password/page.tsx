'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Lock, Mail, CheckCircle, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export default function PortalForgotPasswordPage() {
  const { t, isUrdu } = useLocale()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/portal/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      // Always the same success outcome regardless of what the server
      // actually found (account exists or not) — see the route's own
      // comment for why. Only a genuine request failure shows an error.
      if (!res.ok) { setError(t('p.networkErrorRetry')); setLoading(false); return }
      setSent(true)
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
        {sent ? (
          <div className="text-center py-4">
            <CheckCircle size={40} className="text-dp-secondary mx-auto mb-3" />
            <p className="font-sans font-semibold text-dp-on-surface mb-2">{t('g.checkEmail')}</p>
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant">
              {isUrdu
                ? <>اگر <strong dir="ltr" className="inline-block">{email}</strong> ایک رجسٹرڈ پورٹل اکاؤنٹ سے منسلک ہے، تو اسے پاس ورڈ دوبارہ مقرر کرنے کا لنک بھیج دیا گیا ہے۔</>
                : <>If <strong>{email}</strong> is on file for a registered portal account, a password reset link has been sent to it.</>}
            </p>
            <Link href="/portal/login" className="inline-flex items-center gap-1.5 mt-6 font-sans text-[13px] font-semibold text-dp-secondary hover:underline">
              <ArrowLeft size={14} /> {t('g.backToSignIn')}
            </Link>
          </div>
        ) : (
          <>
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
                <Mail size={22} className="text-dp-on-primary-container" />
              </div>
              <h2 className="font-heading text-[22px] font-bold text-dp-primary mb-1">{t('g.resetPassword')}</h2>
              <p className="text-dp-on-surface-variant text-[13px] font-sans">{t('g.enterEmailReset')}</p>
            </div>

            <form onSubmit={submit} className="space-y-5">
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
