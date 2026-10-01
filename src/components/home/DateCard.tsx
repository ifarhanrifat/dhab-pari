'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Moon } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { formatHijri } from '@/lib/desiCalendar'

// Real ask, 2026-09-30: moved out of the header (where it lived as
// DateStrip, squeezed into the same row as the logo) onto the homepage,
// as its own card the same size as WeatherWidget next to it -- "both
// tabs will display in parallel same size". The moon icon here still
// opens the moon-finder camera, same as it did in the header.
export function DateCard() {
  const { isUrdu } = useLocale()
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const interval = setInterval(() => setNow(new Date()), 5 * 60_000)
    return () => clearInterval(interval)
  }, [])

  if (!now) return null

  const hijri = formatHijri(now, isUrdu, true)
  if (!hijri) return null

  return (
    <Link href="/moon-finder" className="bg-white border border-dp-outline-variant rounded-lg p-3 sm:p-4 flex items-center gap-2.5 sm:gap-3 hover:border-dp-secondary transition-all">
      <span className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-dp-secondary-container text-dp-on-secondary-container flex items-center justify-center shrink-0">
        <Moon size={16} className="sm:hidden" />
        <Moon size={20} className="hidden sm:block" />
      </span>
      {/* Real report, 2026-09-30: `truncate` was clipping the date on a
          narrow phone where this card only gets half the screen width —
          wraps onto a second line instead now, nothing hidden.
          Real ask, 2026-10-01: the Bikrami/Punjabi calendar line dropped
          entirely — Hijri is the one date wanted here. */}
      <div className="min-w-0">
        <p className="font-sans text-[12px] sm:text-[13.5px] font-bold text-dp-on-surface leading-snug">{hijri}</p>
      </div>
    </Link>
  )
}
