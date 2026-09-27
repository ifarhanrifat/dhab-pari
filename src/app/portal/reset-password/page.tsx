'use client'

import Link from 'next/link'
import { AlertTriangle, Lock } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// No longer the active reset flow — see /portal/forgot-password's own
// comment for why password reset moved to a typed-in code instead of this
// page's old clickable-link/hash-session flow. Kept as a plain redirect
// notice rather than deleted outright, since an email sent before this
// change could still have someone clicking through to this exact URL.
export default function PortalResetPasswordPage() {
  const { t, isUrdu } = useLocale()
  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-h-screen bg-[#E1F5EE] flex flex-col">
      <header className="bg-dp-primary w-full px-6 py-4">
        <div className="max-w-[1200px] mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center">
            <Lock size={18} className="text-white" />
          </div>
          <div>
            <h1 className="font-heading text-[24px] font-bold leading-[32px] text-white">{SITE.name}</h1>
            <p className="text-white/60 text-[12px] font-sans">{t('p.resetTitle')}</p>
          </div>
        </div>
      </header>
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 shadow-sm text-center">
          <AlertTriangle size={40} className="text-dp-error mx-auto mb-3" />
          <p className="font-sans font-semibold text-dp-on-surface mb-2">{t('g.resetLinkInvalid')}</p>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mb-6">{t('y.requestNewOne')}</p>
          <Link href="/portal/forgot-password" className="inline-block w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all">
            {t('g.resetPassword')}
          </Link>
        </div>
      </div>
    </div>
  )
}
