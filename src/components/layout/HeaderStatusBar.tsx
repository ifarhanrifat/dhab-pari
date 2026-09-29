'use client'

import { useEffect, useState } from 'react'
import { CalendarDays, Moon, Leaf } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { formatHijri, formatPunjabi } from '@/lib/desiCalendar'
import { OnlineUsersBadge } from './OnlineUsersBadge'

// Real ask, 2026-09-29: the header had a wide strip of empty green space
// next to the logo on every screen the nav/buttons don't fill (mobile
// especially — screenshot showed it) — Gregorian/Hijri/Punjabi date + who's
// online now, in a slim second row so it never competes with the logo or
// nav for space in the cramped main row above it.
export function HeaderStatusBar() {
  const { t, isUrdu } = useLocale()
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    // A tab left open overnight shouldn't keep showing yesterday's date —
    // 5 minutes is plenty for a widget that only ever changes once a day.
    const interval = setInterval(() => setNow(new Date()), 5 * 60_000)
    return () => clearInterval(interval)
  }, [])

  // Client-only content (today's date, live count) — rendering nothing
  // until mount avoids a server/client hydration mismatch on "today".
  if (!now) return null

  const gregorian = new Intl.DateTimeFormat(isUrdu ? 'ur-PK-u-nu-latn' : 'en-PK', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now)
  const hijri = formatHijri(now, isUrdu)
  const punjabi = formatPunjabi(now, isUrdu)

  return (
    <div className="bg-black/10 border-t border-white/10">
      <div className="max-w-[1200px] mx-auto px-6 py-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-white/85 font-sans text-[11.5px] tracking-[0.01em]">
        <span className="inline-flex items-center gap-1 shrink-0">
          <CalendarDays size={12} className="shrink-0 opacity-80" /> {gregorian}
        </span>
        {hijri && (
          <span className="inline-flex items-center gap-1 shrink-0">
            <Moon size={12} className="shrink-0 opacity-80" /> {hijri}
          </span>
        )}
        {punjabi && (
          <span className="inline-flex items-center gap-1 shrink-0">
            <Leaf size={12} className="shrink-0 opacity-80" /> {punjabi}
          </span>
        )}
        <span className="ms-auto shrink-0">
          <OnlineUsersBadge />
        </span>
      </div>
    </div>
  )
}
