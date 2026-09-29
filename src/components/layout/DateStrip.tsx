'use client'

import { useEffect, useState } from 'react'
import { Moon, Leaf } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { formatHijri, formatPunjabi } from '@/lib/desiCalendar'

// Real ask, 2026-09-29, refined same day: first version was a separate
// green strip below the main header row -- the ask was to NOT add a new
// row at all, keep everything in the same row as the logo, and only ever
// one line (scroll instead of wrap if it doesn't fit — same escape hatch
// the desktop nav next to this already uses). Also dropped the Gregorian
// date entirely per a follow-up ("remove the date qable maseh... just put
// ھجری") -- weekday now rides along inside the Hijri string instead, since
// that was the only place "day" was still wanted. Online count moved out
// of here entirely, now sits under the logo (see Header.tsx).
export function DateStrip({ className = '' }: { className?: string }) {
  const { isUrdu } = useLocale()
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const interval = setInterval(() => setNow(new Date()), 5 * 60_000)
    return () => clearInterval(interval)
  }, [])

  if (!now) return null

  const hijri = formatHijri(now, isUrdu, true)
  const punjabi = formatPunjabi(now, isUrdu)

  if (!hijri && !punjabi) return null

  return (
    <div className={`flex items-center gap-3 min-w-0 overflow-x-auto hide-scrollbar text-white/80 font-sans text-[11px] ${className}`}>
      {hijri && (
        <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
          <Moon size={12} className="shrink-0 opacity-80" /> {hijri}
        </span>
      )}
      {punjabi && (
        <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
          <Leaf size={12} className="shrink-0 opacity-80" /> {punjabi}
        </span>
      )}
    </div>
  )
}
