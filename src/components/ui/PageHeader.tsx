'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Confirmed absent everywhere before Phase 6 — every portal sub-screen
// hand-rolled its own back/title row, inconsistently. This is the
// mockup's own back-button recipe (34x34, rounded-square, mirrors for
// RTL) + a title, with an optional right-side action slot.
interface PageHeaderProps {
  title: string
  subtitle?: string
  backHref?: string
  onBack?: () => void
  action?: ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, backHref, onBack, action, className = '' }: PageHeaderProps) {
  const router = useRouter()
  const { isUrdu } = useLocale()

  const goBack = () => {
    if (onBack) { onBack(); return }
    if (backHref) { router.push(backHref); return }
    router.back()
  }

  return (
    <div className={`flex items-center gap-2.5 mb-4 ${className}`}>
      <button onClick={goBack} aria-label="Back"
        className="shrink-0 w-[34px] h-[34px] rounded-[11px] border border-dp2-card-border bg-white flex items-center justify-center cursor-pointer">
        <ArrowLeft size={15} className={`text-dp2-primary ${isUrdu ? 'rotate-180' : ''}`} />
      </button>
      <div className="min-w-0 flex-1">
        <h1 className="font-sans text-[16px] font-bold text-dp2-primary leading-tight truncate">{title}</h1>
        {subtitle && <p className="font-sans text-[11.5px] text-dp2-text-muted truncate">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
