'use client'

import { useState } from 'react'
import { PortalSidebar } from '@/components/portal/PortalSidebar'
import { PortalHeader } from '@/components/portal/PortalHeader'
import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { PoolAppealBanner } from '@/components/portal/PoolAppealBanner'
import { WelcomeTour } from '@/components/portal/WelcomeTour'

export default function PortalDashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="portal-shell flex min-h-screen bg-dp2-surface">
      <WelcomeTour />
      <PortalSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex-1 min-w-0 md:ml-[210px] print:ml-0">
        {/* Real ask, live on device: "the news belts and alert belts will
            always remain at the top where the website news was
            displaying" — PortalHeader had its own `sticky top-0`, but
            AnnouncementBar sat below it as a separate, non-sticky
            sibling, so the ticker scrolled away with the page while the
            bare header stayed put. One sticky wrapper around both, same
            fix Header2 already got on the public site. PortalHeader is
            now shown on every breakpoint (not mobile-only) so there's
            exactly one PortalNotificationBell in the tree -- two
            instances (one embedded here, one floating for desktop) each
            opened their own Realtime channel for the same
            portal_notifications row and crashed the page the moment
            both mounted. */}
        <div className="sticky top-0 z-40">
          <PortalHeader onMenuToggle={() => setMobileOpen(true)} />
          {/* Same red belt as the website, scoped to the appeals aimed at
              this user — targeted ones appear here even when not public. */}
          <AnnouncementBar source="portal" />
        </div>
        {/* Stays up on every page until enough people have joined. */}
        <PoolAppealBanner />
        <main className="p-6 md:p-10 max-w-[1400px] print:p-0 print:max-w-none">{children}</main>
      </div>
    </div>
  )
}
