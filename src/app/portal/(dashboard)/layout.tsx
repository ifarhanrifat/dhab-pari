'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { PortalSidebar } from '@/components/portal/PortalSidebar'
import { PortalHeader } from '@/components/portal/PortalHeader'
import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { PoolAppealBanner } from '@/components/portal/PoolAppealBanner'
import { WelcomeTour } from '@/components/portal/WelcomeTour'
import { PortalMobileNavProvider } from '@/components/portal/PortalMobileNavContext'

// The "Dhab Pari Mobility" screens (my-vehicle/* and the marketplace/
// (mobility)/* route group) render their own MobilityHeader — real bug
// found auditing against the design: both headers rendered stacked (two
// logos, two language toggles), since this layout used to render
// PortalHeader unconditionally on every /portal/(dashboard) route. The
// design's own header has no hamburger at all (bottom-nav covers every
// mobility screen), so skipping it here for these routes isn't a loss of
// function — MobilityHeader's own bell-link (added alongside this fix)
// replaces PortalHeader's embedded PortalNotificationBell for just these
// routes, without mounting a second Realtime subscription.
//
// PortalSidebar itself is NOT part of that fix and must stay — a real
// regression reported live: on a desktop browser this is still a
// *webpage*, not a standalone app taking over the window, and the portal's
// own site navigation has to stay reachable from every page including
// these.
//
// Two more real bugs in that same area, found 2026-10-17: (1) "hidden
// md:flex" being invisible on an actual phone was never actually paired
// with a way to OPEN it below that breakpoint — MobilityHeader had no
// hamburger at all, so mobile/narrow-browser users on these routes had
// no path to the sidebar, full stop. Fixed via PortalMobileNavProvider
// below, which hands MobilityHeader the same setMobileOpen this layout
// already owns. (2) The mobility content's own capped-width "phone
// frame" used to center itself in whatever space the sidebar left,
// which on a wide desktop screen read as a disconnected widget floating
// in empty page rather than part of the layout — it now hugs the
// sidebar's edge instead, main's own mx-auto removed to match.
// Real bug, live, 2026-10-17: this list exists purely because Next.js
// strips route-group names ((mobility)) from the URL, so there's no
// runtime way to ask "is this page actually inside that folder" --
// this has to be hand-kept in sync with every page actually under
// marketplace/(mobility)/, and "shared" was missed when that page was
// added, so PortalHeader rendered a second time stacked under
// MobilityHeader on it. If a page 404s into a double header again,
// check this list against `ls src/app/portal/(dashboard)/marketplace/(mobility)/` first.
//
// 2026-10-20: Phase 6's app-wide sidebar→bottom-tab shell swap was scoped
// too broadly (it touched every portal route, not just the vehicle
// system this phase was actually about) — reverted back to this
// original form. The vehicle-system screens (my-vehicle/*, marketplace/
// (mobility)/*) keep their own in-place redesign work (MobilityHeader/
// DriverMobilityNav/MobilityBottomNav's emoji + color convergence,
// StatusPill/EmptyState/dp2-input adoption) — none of that depended on
// this layout, so it's untouched by this revert. Everything else in the
// app (donations, water, academy, complaints, my-shop, etc.) is back to
// exactly its pre-Phase-6 sidebar+PortalHeader chrome.
const MOBILITY_MARKETPLACE_SLUGS = ['travel', 'results', 'hourly', 'rental', 'shadi', 'machinery', 'tractor', 'loader', 'trips', 'negotiations', 'account', 'city-purchase', 'notifications', 'shared', 'parcel', 'weekly-commute']
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
      <PortalSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex-1 min-w-0 md:ml-[210px] print:ml-0">
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
        <main className="p-6 md:p-10 max-w-[1400px] print:p-0 print:max-w-none">
          <PortalMobileNavProvider onOpen={() => setMobileOpen(true)}>{children}</PortalMobileNavProvider>
        </main>
      </div>
    </div>
  )
}
