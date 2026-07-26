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
  MessageSquare,
  Newspaper,
  Video,
  Heart,
  Image,
  TicketSlash,
  Bell,
  X,
  BookOpen,
  UserCog,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

const menuItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/billing', label: 'Billing', icon: Receipt },
  { href: '/admin/projects', label: 'Projects', icon: FolderKanban },
  { href: '/admin/members', label: 'Members', icon: Users },
  { href: '/admin/accounts', label: 'Accounts', icon: BookOpen },
  { href: '/admin/finance', label: 'Transactions', icon: BarChart3 },
  { href: '/admin/news', label: 'News', icon: Newspaper },
  { href: '/admin/videos', label: 'Videos', icon: Video },
  { href: '/admin/donors', label: 'Donors', icon: Heart },
  { href: '/admin/gallery', label: 'Gallery', icon: Image },
  { href: '/admin/suggestions', label: 'Suggestions', icon: MessageSquare },
  { href: '/admin/ticker', label: 'Ticker', icon: TicketSlash },
  { href: '/admin/notifications', label: 'Alerts', icon: Bell },
  { href: '/admin/reports', label: 'Reports', icon: FileText },
  { href: '/admin/users', label: 'Users', icon: UserCog },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
]

interface AdminSidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export function AdminSidebar({ mobileOpen = false, onMobileClose }: AdminSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/admin/login')
    router.refresh()
  }

  const sidebarContent = (
    <>
      {/* Menu */}
      <nav className="flex-1 space-y-1 overflow-y-auto">
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
              onClick={onMobileClose}
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
      <div className="px-4 pt-4 mt-auto border-t border-white/10 shrink-0">
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
          className="w-full flex items-center justify-center gap-2 py-2 bg-dp-error text-white rounded-lg text-[14px] font-sans font-semibold hover:opacity-90 transition-opacity cursor-pointer"
        >
          <LogOut size={16} />
          Log Out
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col h-screen fixed left-0 top-0 py-6 bg-dp-primary border-r border-dp-outline-variant w-[210px] z-50">
        <div className="px-4 mb-8">
          <h2 className="font-heading text-[20px] font-bold leading-[28px] text-[#86f8c9]">
            Admin Portal
          </h2>
          <p className="text-[12px] font-sans text-white/60 mt-1">
            Dhab Pari Committee
          </p>
        </div>
        {sidebarContent}
      </aside>

      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-[90] md:hidden"
          onClick={onMobileClose}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`fixed left-0 top-0 h-screen w-[260px] bg-dp-primary z-[100] md:hidden flex flex-col py-6 transform transition-transform duration-300 ease-in-out ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-4 mb-8 flex items-center justify-between">
          <div>
            <h2 className="font-heading text-[20px] font-bold leading-[28px] text-[#86f8c9]">
              Admin Portal
            </h2>
            <p className="text-[12px] font-sans text-white/60 mt-1">
              Dhab Pari Committee
            </p>
          </div>
          <button
            onClick={onMobileClose}
            className="text-white/80 hover:text-white p-1 cursor-pointer"
            aria-label="Close menu"
          >
            <X size={22} />
          </button>
        </div>
        {sidebarContent}
      </aside>
    </>
  )
}
