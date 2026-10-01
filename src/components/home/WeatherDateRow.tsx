'use client'

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DateCard } from '@/components/home/DateCard'
import { WeatherWidget } from '@/components/home/WeatherWidget'

// Real ask, 2026-10-01: "flip the weather and date tab in Urdu mode" —
// the parent page (src/app/(public)/page.tsx) is a server component with
// no access to the client-side locale, so this wrapper exists purely to
// read isUrdu and pick the render order; the grid/dir/mr-auto container
// styling itself is unchanged from before (see that file's own comments
// for why dir="ltr" + mr-auto, not a dir swap, is what pins this row to
// the true left edge regardless of page language).
export function WeatherDateRow() {
  const { isUrdu } = useLocale()
  return (
    <div className="grid grid-cols-2 gap-3 mb-4 lg:mb-6" dir="ltr">
      {isUrdu ? (
        <>
          <WeatherWidget />
          <DateCard />
        </>
      ) : (
        <>
          <DateCard />
          <WeatherWidget />
        </>
      )}
    </div>
  )
}
