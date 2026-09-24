'use client'

import { Menu } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface PortalHeaderProps {
  onMenuToggle?: () => void
}

export function PortalHeader({ onMenuToggle }: PortalHeaderProps) {
  const { t, isUrdu } = useLocale()
  return (
    // Menu button on the LEFT, same as the public and admin headers — the
    // sidebar slides in from the left, so the trigger belongs there. Only
    // the title's own text direction flips under Urdu (.rtl-text-style, not
    // a row reversal) -- the icon stays put, matching every other header.
    <header className="md:hidden bg-dp-primary px-4 py-4 flex items-center gap-2.5 sticky top-0 z-50">
      <button onClick={onMenuToggle} className="text-white p-1.5 -ms-1.5 shrink-0" aria-label="Toggle menu"><Menu size={26} /></button>
      <h1 className="text-white font-heading text-[20px] font-bold leading-[28px] truncate" dir={isUrdu ? 'rtl' : 'ltr'}>{t('y.donorPortal')}</h1>
    </header>
  )
}
