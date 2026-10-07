'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Building2, Receipt, CreditCard, LogOut, ArrowLeftCircle, History } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingDots } from '@/components/shared/LoadingDots'

const menuItems = [
  { href: '/platform', label: 'Tenants', icon: Building2 },
  { href: '/platform/plans', label: 'Plans', icon: CreditCard },
  { href: '/platform/invoices', label: 'Invoices', icon: Receipt },
  { href: '/platform/audit-log', label: 'Audit Log', icon: History },
]

export default function PlatformDashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  // undefined = still checking, null = confirmed not a platform admin,
  // object = confirmed. Three states so the guard never flashes the
  // dashboard before the check resolves.
  const [admin, setAdmin] = useState<{ full_name: string; email: string } | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) {
        if (!cancelled) setAdmin(null)
        return
      }
      const { data } = await supabase
        .from('platform_admins')
        .select('full_name, email')
        .eq('auth_user_id', user.id)
        .eq('is_active', true)
        .maybeSingle()
      if (!cancelled) setAdmin(data ?? null)
    })
    return () => { cancelled = true }
  }, [supabase])

  useEffect(() => {
    if (admin === null) router.replace('/platform/login')
  }, [admin, router])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/platform/login')
    router.refresh()
  }

  if (admin === undefined || admin === null) {
    return (
      <div className="min-h-screen bg-[#1a1f2e] flex items-center justify-center">
        <LoadingDots />
      </div>
    )
  }

  const isActive = (href: string) => (href === '/platform' ? pathname === '/platform' : pathname.startsWith(href))

  return (
    <div className="flex min-h-screen bg-[#F5F8F6]">
      <aside style={{ position: 'fixed', top: 0, left: 0 }} className="hidden md:flex flex-col h-screen py-6 bg-[#1a1f2e] w-[220px] z-50">
        <div className="px-4 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Building2 size={18} className="text-white" />
            <span className="font-heading text-white font-bold text-[15px]">Platform</span>
          </div>
          <p className="text-white/40 text-[11px] font-sans truncate">{admin.email}</p>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {menuItems.map((item) => {
            const Icon = item.icon
            const active = isActive(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center px-4 py-3 rounded-lg transition-all text-[14px] font-sans ${
                  active ? 'bg-[#2a3142] text-white font-bold' : 'text-white/70 hover:bg-[#2a3142] hover:text-white'
                }`}
              >
                <Icon size={18} className="me-3 shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="px-2 pt-2 shrink-0">
          <a href="/admin" className="flex items-center px-4 py-2.5 rounded-lg text-white/60 hover:bg-[#2a3142] hover:text-white transition-all text-[13.5px] font-sans">
            <ArrowLeftCircle size={16} className="me-3 shrink-0" /> Back to admin
          </a>
        </div>
        <div className="px-4 pt-4 border-t border-white/10 shrink-0">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 py-2 bg-dp-error text-white rounded-lg text-[14px] font-sans font-semibold hover:opacity-90 transition-opacity cursor-pointer"
          >
            <LogOut size={16} /> Logout
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 md:ml-[220px]">
        <header className="md:hidden bg-[#1a1f2e] px-4 py-3 flex items-center justify-between">
          <span className="font-heading text-white font-bold text-[15px]">Platform</span>
          <button onClick={handleLogout} className="text-white/70 text-[13px] font-sans">Logout</button>
        </header>
        <main className="p-6 md:p-10 max-w-[1300px]">{children}</main>
      </div>
    </div>
  )
}
