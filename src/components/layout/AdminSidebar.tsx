'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Receipt,
  FolderKanban,
  Users,
  BarChart3,
  FileText,
  Settings,
  LogOut,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

const menuItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/billing', label: 'Billing', icon: Receipt },
  { href: '/admin/projects', label: 'Projects', icon: FolderKanban },
  { href: '/admin/members', label: 'Members', icon: Users },
  { href: '/admin/finance', label: 'Accounts', icon: BarChart3 },
  { href: '/admin/reports', label: 'Reports', icon: FileText },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
]

export function AdminSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/admin/login')
    router.refresh()
  }

  return (
    <aside className="hidden md:flex flex-col h-screen fixed left-0 top-0 py-6 bg-dp-primary border-r border-dp-outline-variant w-[192px] z-50">
      {/* Brand */}
      <div className="px-4 mb-8">
        <h2 className="font-heading text-[20px] font-bold leading-[28px] text-[#86f8c9]">
          Admin Portal
        </h2>
        <p className="text-[12px] font-sans text-white/60 mt-1">
          Dhab Pari Committee
        </p>
      </div>

      {/* Menu */}
      <nav className="flex-1 space-y-1">
        {menuItems.map((item) => {
          const Icon = item.icon
          const isActive =
            item.href === '/admin'
              ? pathname === '/admin'
              : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center px-4 py-3 mx-2 rounded-lg transition-all text-[14px] font-sans ${
                isActive
                  ? 'bg-[#1D9E75] text-white font-bold'
                  : 'text-white/80 hover:bg-dp-primary-container hover:text-white'
              }`}
            >
              <Icon size={18} className="mr-3 shrink-0" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Current User + Logout */}
      <div className="px-4 pt-4 mt-auto border-t border-white/10">
        <div className="bg-dp-primary-container p-3 rounded-lg mb-3">
          <div className="flex items-center">
            <div className="w-8 h-8 rounded-full bg-[#5bc8a3] text-dp-primary flex items-center justify-center font-bold text-[12px] font-sans mr-2 shrink-0">
              A
            </div>
            <div className="min-w-0">
              <p className="text-white text-[13px] font-sans font-semibold truncate">
                Admin User
              </p>
              <p className="text-white/60 text-[11px] font-sans">
                Super Admin
              </p>
            </div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-2 bg-dp-error text-white rounded-lg text-[14px] font-sans font-semibold hover:opacity-90 transition-opacity"
        >
          <LogOut size={16} />
          Log Out
        </button>
      </div>
    </aside>
  )
}
