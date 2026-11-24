'use client'

// Shared shell for the pages rebuilt in the new "Dhab Pari Mobility"
// design (Home + Results so far) — a route group (adds no URL segment)
// so these pages get the new header/bottom-nav while every other
// marketplace page keeps its current chrome untouched until its own
// redesign pass.

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityHeader } from '@/components/mobility/MobilityHeader'
import { MobilityBottomNav } from '@/components/mobility/MobilityBottomNav'

export default function MobilityLayout({ children }: { children: React.ReactNode }) {
  const { isUrdu } = useLocale()
  return (
    // Real bug found live on a desktop browser (original version of this
    // comment): this shell had no width cap at all, so on anything wider
    // than a phone the map and every card stretched full-bleed across
    // the window. Capping it to phone-width fixed that, but swung too
    // far the other way — real ask, 2026-10-17, after seeing it live:
    // "this page should display like a real webpage like all other
    // pages." Every other portal page just uses whatever width `main`
    // itself provides (up to max-w-[1400px]), no inner frame at all; this
    // now does the same from md (768px) up — still phone-width below
    // that (sm:max-w-[460px] for an actual narrow browser/tablet), but a
    // real desktop gets a real desktop layout, same as everywhere else.
    <div className="min-h-[calc(100vh-1px)] bg-[#e5e2d0] sm:py-5 -m-4 sm:-m-6 md:-m-10">
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="sm:max-w-[460px] md:max-w-none bg-[#F9F9F6] min-h-[calc(100vh-1px)] sm:min-h-[calc(100vh-40px)] sm:shadow-[0_25px_50px_-12px_rgba(0,0,0,.35)] flex flex-col">
        <MobilityHeader />
        {/* Real bug found live, 2026-11-24, on the marketplace hub
            specifically: that page's own content (banner + search + two
            pillar cards) is much shorter than this shell's full-viewport
            minimum, and with no vertical alignment of its own, the
            leftover space just trailed below it as dead, unstyled
            background — read as an unfinished/broken page. flex-1 +
            justify-center here centers whatever a page returns within
            the space actually left after the header, splitting any
            leftover room evenly instead of dumping it all at the
            bottom. A no-op for every page whose content already fills
            or exceeds that space (buses, travel, etc. — confirmed
            live): justify-content only redistributes slack that
            exists, so there's nothing to redistribute once content
            already overflows. */}
        <div className="p-3.5 pb-24 flex-1 flex flex-col justify-center">{children}</div>
      </div>
      <MobilityBottomNav />
    </div>
  )
}
