'use client'

import { AlertTriangle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useLocale()
  return (
    <div className="max-w-[1200px] mx-auto px-6 py-20 text-center">
      <AlertTriangle size={48} className="text-dp-error mx-auto mb-4" />
      <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-2">
        {t('x.somethingWrong')}
      </h2>
      <p className="text-dp-on-surface-variant font-sans text-[16px] mb-6 max-w-md mx-auto">
        We encountered an error loading this page. Please try again or contact
        the committee office if the problem persists.
      </p>
      <button
        onClick={reset}
        className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-5 py-2.5 bg-dp-secondary text-white hover:bg-dp-primary"
      >
        {t('x.tryAgain')}
      </button>
    </div>
  )
}
