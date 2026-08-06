'use client'

import { useState } from 'react'
import { PortalSidebar } from '@/components/portal/PortalSidebar'
import { PortalHeader } from '@/components/portal/PortalHeader'
import { PortalNotificationBell } from '@/components/portal/PortalNotificationBell'

export default function PortalDashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="portal-shell flex min-h-screen bg-[#F5F8F6]">
      <PortalSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <PortalNotificationBell />
      <div className="flex-1 min-w-0 md:ml-[210px] print:ml-0">
        <PortalHeader onMenuToggle={() => setMobileOpen(true)} />
        <main className="p-6 md:p-10 max-w-[1400px] print:p-0 print:max-w-none">{children}</main>
      </div>
    </div>
  )
}
