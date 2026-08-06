'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import {
  LayoutDashboard, HeartHandshake, Droplets, Repeat, MessageSquare,
  MessageSquareWarning, Droplet, LogOut, X, UserCog, ArrowLeftCircle, HandHeart, Vote,
} from 'lucide-react'

// Mirrors AdminSidebar.tsx's exact pattern (fixed desktop sidebar + mobile
// slide-in drawer + persistent profile block at the bottom) — the portal
// nav was a top bar before; a registered user's identity should stay
// visible the whole time they're in the portal, same as staff in /admin.
const menuItems = [
  { href: '/portal', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/portal/donate', label: 'Donate', icon: HeartHandshake },
  { href: '/portal/statement', label: 'My Giving', icon: HeartHandshake },
  { href: '/portal/water', label: 'Water Bills', icon: Droplets, requiresConsumer: true },
  { href: '/portal/recurring', label: 'Recurring Donations', icon: Repeat },
  { href: '/portal/propose-project', label: 'Propose a Project', icon: Vote },
  { href: '/portal/suggestions', label: 'Suggestions', icon: MessageSquare },
  { href: '/portal/complaints', label: 'Complaints', icon: MessageSquareWarning },
  { href: '/portal/blood-donor', label: 'Blood Donor', icon: Droplet },
  { href: '/portal/get-involved', label: 'Get Involved', icon: HandHeart },
  { href: '/portal/profile', label: 'My Profile', icon: UserCog },
]

interface PortalSidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export function PortalSidebar({ mobileOpen = false, onMobileClose }: PortalSidebarProps) {
  const { user } = usePortalUser()
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/portal/login')
    router.refresh()
  }

  const visibleMenuItems = menuItems.filter((item) => !item.requiresConsumer || user?.consumer_id)

  const sidebarContent = (
    <>
      <nav className="flex-1 space-y-1 overflow-y-auto">
        {visibleMenuItems.map((item) => {
          const Icon = item.icon
          const isActive = item.href === '/portal' ? pathname === '/portal' : pathname.startsWith(item.href)
          return (
            <Link key={item.href} href={item.href} onClick={onMobileClose}
              className={`flex items-center px-4 py-3 mx-2 rounded-lg transition-all text-[14px] font-sans ${
                isActive ? 'bg-[#1D9E75] text-white font-bold' : 'text-white/80 hover:bg-dp-primary-container hover:text-white'
              }`}>
              <Icon size={18} className="mr-3 shrink-0" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="px-2 pt-2 shrink-0">
        <a href="/" className="flex items-center px-2 py-2.5 rounded-lg text-white/70 hover:bg-dp-primary-container hover:text-white transition-all text-[13.5px] font-sans">
          <ArrowLeftCircle size={17} className="mr-3 shrink-0" /> Back to Website
        </a>
      </div>

      {/* Persistent profile — a registered user's identity stays visible
          throughout the portal, same as staff in /admin. */}
      <div className="px-4 pt-4 mt-auto border-t border-white/10 shrink-0">
        <Link href="/portal/profile" onClick={onMobileClose} className="bg-dp-primary-container p-3 rounded-lg mb-3 flex items-center hover:opacity-90 transition-opacity">
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover mr-2 shrink-0" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-[#5bc8a3] text-dp-primary flex items-center justify-center font-bold text-[12px] font-sans mr-2 shrink-0">
              {(user?.full_name ?? '?').charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-white text-[13px] font-sans font-semibold truncate">{user?.full_name ?? 'Loading...'}</p>
            <p className="text-white/60 text-[11px] font-sans">{user?.mobile ?? ''}</p>
          </div>
        </Link>
        <button onClick={handleLogout} className="w-full flex items-center justify-center gap-2 py-2 bg-dp-error text-white rounded-lg text-[14px] font-sans font-semibold hover:opacity-90 transition-opacity cursor-pointer">
          <LogOut size={16} /> Log Out
        </button>
      </div>
    </>
  )

  return (
    <>
      <aside className="hidden md:flex flex-col h-screen fixed left-0 top-0 py-6 bg-dp-primary border-r border-dp-outline-variant w-[210px] z-50 print:hidden">
        <div className="px-4 mb-8">
          <h2 className="font-heading text-[20px] font-bold leading-[28px] text-[#86f8c9]">Donor Portal</h2>
          <p className="text-[12px] font-sans text-white/60 mt-1">Dhab Pari Committee</p>
        </div>
        {sidebarContent}
      </aside>

      {mobileOpen && <div className="fixed inset-0 bg-black/50 z-[90] md:hidden" onClick={onMobileClose} />}

      <aside className={`fixed left-0 top-0 h-screen w-[260px] bg-dp-primary z-[100] md:hidden flex flex-col py-6 transform transition-transform duration-300 ease-in-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="px-4 mb-8 flex items-center justify-between">
          <div>
            <h2 className="font-heading text-[20px] font-bold leading-[28px] text-[#86f8c9]">Donor Portal</h2>
            <p className="text-[12px] font-sans text-white/60 mt-1">Dhab Pari Committee</p>
          </div>
          <button onClick={onMobileClose} className="text-white/80 hover:text-white p-1 cursor-pointer" aria-label="Close menu"><X size={22} /></button>
        </div>
        {sidebarContent}
      </aside>
    </>
  )
}
