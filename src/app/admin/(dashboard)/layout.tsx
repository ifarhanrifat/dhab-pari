'use client'

import { useState } from 'react'
import { AdminSidebar } from '@/components/layout/AdminSidebar'
import { AdminHeader } from '@/components/layout/AdminHeader'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { PublisherGuidelinesGate } from '@/components/admin/PublisherGuidelinesGate'

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
      <div className="flex-1 min-w-0 md:ms-[210px] print:ms-0">
        <AdminHeader onMenuToggle={() => setMobileOpen(true)} />
        <main className="p-6 md:p-10 max-w-[1400px] print:p-0 print:max-w-none">{children}</main>
      </div>
    </div>
  )
}
