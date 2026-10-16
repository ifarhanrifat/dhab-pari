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
    // Real bug found live on a desktop browser: this shell had no width
    // cap at all, so on anything wider than a phone the map and every
    // card stretched full-bleed across the window instead of reading as
    // a phone-width app (the design's own wide/outerPad/frameR state,
    // window.innerWidth >= 520, does the same thing). MobilityBottomNav
    // is viewport-fixed and already centers its own max-w-md content, so
    // just capping this column's width keeps the nav visually aligned
    // under it without having to rebuild the nav as part of the frame.
    //
    // Real ask, 2026-10-17: centering this frame in whatever width the
    // sidebar leaves it looked like a disconnected phone widget floating
    // in a sea of empty page on a wide laptop screen. Dropping the
    // sm:mx-auto makes it hug the sidebar's own edge instead — still
    // phone-width (not full-bleed, the original bug this cap fixed), but
    // reading as part of the page layout rather than something stranded
    // in the middle of it.
    <div className="min-h-[calc(100vh-1px)] bg-[#e5e2d0] sm:py-5 -m-6 md:-m-10">
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="sm:max-w-[460px] bg-[#F9F9F6] min-h-[calc(100vh-1px)] sm:min-h-[calc(100vh-40px)] sm:shadow-[0_25px_50px_-12px_rgba(0,0,0,.35)]">
        <MobilityHeader />
        <div className="p-3.5 pb-24">{children}</div>
      </div>
      <MobilityBottomNav />
    </div>
  )
}
