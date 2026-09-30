'use client'

import { ShieldAlert } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Real ask, 2026-09-30: the committee is only hosting these listings, not
// a party to the sale -- this has to be visible before anyone calls a
// seller or hands over money, not buried in a terms page nobody reads.
// Shown on both the public browse page and the portal posting page.
export function ClassifiedsDisclaimer() {
  const { t, isUrdu } = useLocale()
  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-6 flex gap-3">
      <ShieldAlert size={20} className="text-amber-700 shrink-0 mt-0.5" />
      <p className={`font-sans text-[13px] text-amber-900 ${isUrdu ? 'leading-[22px]' : 'leading-[20px]'}`}>
        {t('cl.disclaimer')}
      </p>
    </div>
  )
}
