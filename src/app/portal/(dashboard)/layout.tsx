'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { PortalSidebar } from '@/components/portal/PortalSidebar'
import { PortalHeader } from '@/components/portal/PortalHeader'
import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { PoolAppealBanner } from '@/components/portal/PoolAppealBanner'
import { WelcomeTour } from '@/components/portal/WelcomeTour'

// The "Dhab Pari Mobility" screens (my-vehicle/* and the marketplace/
// (mobility)/* route group) render their own MobilityHeader — real bug
// found auditing against the design: both headers rendered stacked
// (two logos, two language toggles), since this layout used to render
// PortalHeader unconditionally on every /portal/(dashboard) route. The
// design's own header has no hamburger/sidebar at all (bottom-nav covers
// every mobility screen), so skipping both here for these routes isn't
// a loss of function — MobilityHeader's own bell-link (added alongside
// this fix) replaces PortalHeader's embedded PortalNotificationBell for
// just these routes, without mounting a second Realtime subscription.
const MOBILITY_MARKETPLACE_SLUGS = ['travel', 'results', 'hourly', 'rental', 'shadi', 'machinery', 'tractor', 'loader', 'trips', 'negotiations', 'account', 'city-purchase', 'notifications']
function isMobilityRoute(pathname: string) {
  if (pathname.startsWith('/portal/my-vehicle')) return true
  return MOBILITY_MARKETPLACE_SLUGS.some((slug) => pathname === `/portal/marketplace/${slug}` || pathname.startsWith(`/portal/marketplace/${slug}/`))
}

export default function PortalDashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()
  const isMobility = isMobilityRoute(pathname)

  return (
    <div className="portal-shell flex min-h-screen bg-dp2-surface">
      <WelcomeTour />
      {!isMobility && <PortalSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />}
      <div className={`flex-1 min-w-0 print:ml-0 ${isMobility ? '' : 'md:ml-[210px]'}`}>
        {/* Real ask, live on device: "the news belt still runs under the
            language toggle and profile, it should display at the top of
            everything" — the public site renders AnnouncementBar BEFORE
            Header (ticker first, logo/toggle/bell row below it); this
            layout had the order flipped, so the ticker sat under the
            profile row instead of above it. Order now matches the public
            site exactly, both still inside one sticky wrapper so neither
            scrolls away independently of the other. PortalHeader is shown
            on every breakpoint (not mobile-only) so there's exactly one
            PortalNotificationBell in the tree -- two instances (one
            embedded here, one floating for desktop) each opened their own
            Realtime channel for the same portal_notifications row and
            crashed the page the moment both mounted.

            Real bug found live, Android app: in the installed edge-to-edge
            app the ticker -- a short 36px bar, now the first thing here --
            ended up almost entirely hidden behind the status bar, same
            issue Header2 had on the public site. safe-area-inset-top
            padding pushes the whole block below the status bar; bg-dp2-
            primary on the strip matches the status bar's own theme-color
            tint instead of leaving a mismatched gap. */}
        <div className="sticky top-0 z-40 bg-dp2-primary" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          {/* Same red belt as the website, scoped to the appeals aimed at
              this user — targeted ones appear here even when not public. */}
          <AnnouncementBar source="portal" />
          {!isMobility && <PortalHeader onMenuToggle={() => setMobileOpen(true)} />}
        </div>
        {/* Stays up on every page until enough people have joined. */}
        <PoolAppealBanner />
        <main className={`p-6 md:p-10 max-w-[1400px] print:p-0 print:max-w-none ${isMobility ? 'mx-auto' : ''}`}>{children}</main>
      </div>
    </div>
  )
}
