'use client'

import { useState } from 'react'
import { AdminSidebar } from '@/components/layout/AdminSidebar'
import { AdminHeader } from '@/components/layout/AdminHeader'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { PublisherGuidelinesGate } from '@/components/admin/PublisherGuidelinesGate'
import { AnnouncementBar } from '@/components/layout/AnnouncementBar'

export default function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="admin-shell flex min-h-screen bg-[#F5F8F6]">
      <AdminSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <NotificationBell />
      {/* Renders nothing except for a publisher who has not accepted the
          current version of the content rules. */}
      <PublisherGuidelinesGate />
      <div className="flex-1 min-w-0 md:ml-[210px] print:ml-0">
        {/* Real ask: "the news and alert belt is running at the wrong
            place, it should display at the top like the website" — the
            public site renders AnnouncementBar BEFORE Header (ticker
            first, nav row below it); this had the order flipped, so the
            ticker sat under the header instead of above it. Order now
            matches the public site exactly, both still inside one sticky
            wrapper so neither scrolls away independently of the other.

            Real bug found live, Android app: in the installed edge-to-edge
            app the ticker -- a short 36px bar, now the first thing here --
            ended up almost entirely hidden behind the status bar, same
            issue Header2 had on the public site. safe-area-inset-top
            padding pushes the whole block below the status bar; bg-dp-
            primary on the strip matches AdminHeader's own color (and the
            status bar's theme-color tint) instead of leaving a mismatched
            gap. */}
        <div className="sticky top-0 z-40 bg-dp-primary" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          {/* Real ask, 2026-10-01: "make it appear on the portal account and
              admin account as well" — same two-tier belt the public site and
              portal already show. */}
          <AnnouncementBar source="admin" />
          <AdminHeader onMenuToggle={() => setMobileOpen(true)} />
        </div>
        <main className="p-6 md:p-10 max-w-[1400px] print:p-0 print:max-w-none">{children}</main>
      </div>
    </div>
  )
}
