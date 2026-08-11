'use client'

import Link from 'next/link'
import { Home } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export default function NotFound() {
  const { t } = useLocale()
  return (
    <div className="max-w-[1200px] mx-auto px-6 py-20 text-center">
      <h1 className="font-heading text-[80px] font-bold text-dp-primary/20 mb-2">404</h1>
      <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-2">
        {t('x.pageNotFound')}
      </h2>
      <p className="text-dp-on-surface-variant font-sans text-[16px] mb-8 max-w-md mx-auto">
        {t('x.pageMissing')}
      </p>
      <Link
        href="/"
        className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-5 py-2.5 bg-dp-secondary text-white hover:bg-dp-primary"
      >
        <Home size={16} />
        {t('x.backToHome')}
      </Link>
    </div>
  )
}
