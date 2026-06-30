'use client'

import { useState } from 'react'
import { AdminSidebar } from '@/components/layout/AdminSidebar'
import { AdminHeader } from '@/components/layout/AdminHeader'

export default function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex min-h-screen bg-[#F5F8F6]">
      <AdminSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex-1 md:ml-[210px]">
        <AdminHeader onMenuToggle={() => setMobileOpen(true)} />
        <main className="p-6 md:p-10 max-w-[1400px]">{children}</main>
      </div>
    </div>
  )
}
