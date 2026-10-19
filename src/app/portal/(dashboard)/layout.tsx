'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { PortalSidebar } from '@/components/portal/PortalSidebar'
import { PortalHeader } from '@/components/portal/PortalHeader'
import { AppHeader } from '@/components/portal/AppHeader'
import { BottomTabBar } from '@/components/portal/BottomTabBar'
import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { PoolAppealBanner } from '@/components/portal/PoolAppealBanner'
import { WelcomeTour } from '@/components/portal/WelcomeTour'
import { PortalMobileNavProvider } from '@/components/portal/PortalMobileNavContext'

// Phase 6, 2026-10-20: the native-app shell replaces the sidebar with a
// persistent bottom tab bar (AppHeader + BottomTabBar, no sidebar) for
// most of the portal. Three route families — /portal/marketplace,
// /portal/my-shop, /portal/my-vehicle — still mount their OWN page-local
// bottom nav (MarketplaceBottomNav/ShopBottomNav/MobilityBottomNav,
// ~35 files total) and, for my-vehicle/the marketplace (mobility) group,
// their own MobilityHeader. Reconciling all of those is its own
// follow-up pass (each page's own pb-16-for-fixed-nav wrapper has to be
// checked against the new shell's own main padding, one section at a
// time, per the approved plan's own sequencing) — until then these three
// families keep EXACTLY today's chrome (sidebar + PortalHeader/
// MobilityHeader + their own bottom nav) completely unchanged, so
// nothing there regresses or double-stacks chrome. Every other portal
// route — the majority of the app's surface, including the dashboard
// home and every Giving & Welfare / Community & Education / Get Involved
// destination (now reachable via the Account tab, see account/page.tsx)
// — gets the real shell today.
const MOBILITY_MARKETPLACE_SLUGS = ['travel', 'results', 'hourly', 'rental', 'shadi', 'machinery', 'tractor', 'loader', 'trips', 'negotiations', 'account', 'city-purchase', 'notifications', 'shared']
function isMobilityRoute(pathname: string) {
  if (pathname.startsWith('/portal/my-vehicle')) return true
  return MOBILITY_MARKETPLACE_SLUGS.some((slug) => pathname === `/portal/marketplace/${slug}` || pathname.startsWith(`/portal/marketplace/${slug}/`))
}
const LEGACY_CHROME_PREFIXES = ['/portal/marketplace', '/portal/my-shop', '/portal/my-vehicle']
function usesLegacyChrome(pathname: string) {
  return LEGACY_CHROME_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export default function PortalDashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()

  if (usesLegacyChrome(pathname)) {
    const isMobility = isMobilityRoute(pathname)
    return (
      <div className="portal-shell flex min-h-screen bg-dp2-surface">
        <WelcomeTour />
        <PortalSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
        <div className="flex-1 min-w-0 md:ml-[210px] print:ml-0">
          <div className="sticky top-0 z-40 bg-dp2-primary" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
            <AnnouncementBar source="portal" />
            {!isMobility && <PortalHeader onMenuToggle={() => setMobileOpen(true)} />}
          </div>
          <PoolAppealBanner />
          <main className="p-6 md:p-10 max-w-[1400px] print:p-0 print:max-w-none">
            <PortalMobileNavProvider onOpen={() => setMobileOpen(true)}>{children}</PortalMobileNavProvider>
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="portal-shell flex flex-col min-h-screen bg-dp2-surface">
      <WelcomeTour />
      <div className="sticky top-0 z-40 bg-dp2-primary" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <AnnouncementBar source="portal" />
        <AppHeader />
      </div>
      <PoolAppealBanner />
      <main className="flex-1 w-full max-w-md mx-auto p-3.5 pb-24 print:p-0 print:max-w-none">
        {children}
      </main>
      <BottomTabBar />
    </div>
  )
}
