'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import {
  LayoutDashboard, HeartHandshake, Droplets, Repeat, MessageSquare,
  MessageSquareWarning, Droplet, LogOut, X, UserCog, ArrowLeftCircle, HandHeart, Vote, Briefcase,
  GraduationCap,
  Gift,
  BookOpen,
  NotebookPen,
  Scale,
  Users,
} from 'lucide-react'

// Mirrors AdminSidebar.tsx's exact pattern (fixed desktop sidebar + mobile
// slide-in drawer + persistent profile block at the bottom) — the portal
// nav was a top bar before; a registered user's identity should stay
// visible the whole time they're in the portal, same as staff in /admin.
const menuItems = [
  { href: '/portal', label: 'Dashboard', tKey: 'portal.dashboard', icon: LayoutDashboard },
  { href: '/portal/donate', label: 'Donate', tKey: 'portal.donate', icon: HeartHandshake },
  { href: '/portal/statement', label: 'My Giving', tKey: 'portal.statement', icon: HeartHandshake },
  { href: '/portal/water', label: 'Water Bills', tKey: 'portal.water', icon: Droplets, requiresConsumer: true },
  { href: '/portal/recurring', label: 'Recurring Donations', tKey: 'portal.recurring', icon: Repeat },
  { href: '/portal/zakat', label: 'Zakat & Ushr', tKey: 'portal.zakat', icon: Scale },
  { href: '/portal/kafalat', label: 'Kafalat — Sponsor or Join', tKey: 'portal.kafalat', icon: GraduationCap },
  { href: '/portal/esal-e-sawab', label: 'Sadqa-e-Jariya', tKey: 'portal.esalESawab', icon: Gift },
  { href: '/portal/wazifa', label: 'Taleemi Wazifa', tKey: 'portal.wazifa', icon: BookOpen },
  { href: '/portal/propose-project', label: 'Propose a Project', tKey: 'portal.proposeProject', icon: Vote },
  { href: '/portal/submit-blog', label: 'Submit a Blog Post', tKey: 'portal.submitBlog', icon: NotebookPen },
  { href: '/portal/mentors', label: 'Mentors & Career Help', tKey: 'portal.mentors', icon: Users },
  { href: '/portal/suggestions', label: 'Suggestions', tKey: 'portal.suggestions', icon: MessageSquare },
  { href: '/portal/complaints', label: 'Complaints', tKey: 'portal.complaints', icon: MessageSquareWarning },
  { href: '/portal/blood-donor', label: 'Blood Donor', tKey: 'portal.bloodDonor', icon: Droplet },
  { href: '/portal/post-job', label: 'My Job Listings', tKey: 'portal.postJob', icon: Briefcase },
  { href: '/portal/my-volunteering', label: 'My Volunteering', tKey: 'portal.myVolunteering', icon: HeartHandshake },
  { href: '/portal/get-involved', label: 'Get Involved', tKey: 'portal.getInvolved', icon: HandHeart },
  { href: '/portal/profile', label: 'My Profile', tKey: 'portal.profile', icon: UserCog },
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
  const { t, isUrdu } = useLocale()
  const [badges, setBadges] = useState<Record<string, number>>({})

  // Keyed by the last segment of each href, because the server buckets unread
  // notifications by the page their link points at — so a tab gets a badge by
  // having its notifications link to it, with nothing to wire up here.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const refresh = async () => {
      const { data } = await supabase.rpc('portal_sidebar_badges')
      if (!cancelled && data) setBadges(data as Record<string, number>)
    }
    refresh()
    const id = setInterval(refresh, 120000)
    return () => { cancelled = true; clearInterval(id) }
  }, [supabase, user, pathname])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/portal/login')
    router.refresh()
  }

  const visibleMenuItems = menuItems.filter((item) => !item.requiresConsumer || user?.consumer_id)

  // Longest-match so exactly one item highlights — same fix as AdminSidebar,
  // where plain startsWith() lit a parent and its child simultaneously. No
  // portal route collides today; this keeps it that way when one is added.
  const activeHref = (() => {
    const matches = visibleMenuItems
      .map((i) => i.href)
      .filter((href) => (href === '/portal' ? pathname === '/portal' : pathname === href || pathname.startsWith(href + '/')))
    return matches.sort((a, b) => b.length - a.length)[0] ?? null
  })()

  // The sidebar itself stays pinned to the left edge of the screen in Urdu
  // too — RTL_READY is deliberately off, so nobody has to relearn where the
  // menu lives just for switching language (see LocaleProvider). What does
  // change: each row's own icon/text order and margins, via a plain `dir`
  // on the row — every one of these already uses logical spacing (me-*,
  // ms-auto), so that alone is enough to put the icon on the reading
  // "start" side (the right, in Urdu) without moving the menu itself.
  const rowDir = isUrdu ? 'rtl' : 'ltr'
  // Profile + language used to sit at the very bottom, under a plain
  // "Donor Portal" title at the top — same restructuring as AdminSidebar:
  // moved to the top, in the same row/logical-spacing pattern used
  // everywhere else here, so the avatar mirrors to the reading-start side
  // (left in English, right in Urdu) with no extra flip logic of its own.
  const profileBlock = (
    <div className="shrink-0" dir={rowDir}>
      <Link href="/portal/profile" onClick={onMobileClose} className="bg-dp-primary-container p-3 rounded-lg flex items-center hover:opacity-90 transition-opacity">
        {user?.avatar_url ? (
          <Image src={user.avatar_url} alt="" width={32} height={32} className="w-8 h-8 rounded-full object-cover me-2 shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-[#5bc8a3] text-dp-primary flex items-center justify-center font-bold text-[12px] font-sans me-2 shrink-0">
            {(user?.full_name ?? '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-white text-[13px] font-sans font-semibold truncate">{user?.full_name ?? t('action.loading')}</p>
          <p className="text-white/60 text-[11px] font-sans">{user?.mobile ?? ''}</p>
        </div>
      </Link>
      <div className="pt-3">
        <LanguageToggle compact />
      </div>
    </div>
  )
  const sidebarContent = (
    <>
      <nav className="flex-1 space-y-1 overflow-y-auto" dir={rowDir}>
        {visibleMenuItems.map((item) => {
          const Icon = item.icon
          const isActive = item.href === activeHref
          const count = badges[item.href.split('/')[2] ?? ''] ?? 0
          return (
            <Link key={item.href} href={item.href} onClick={onMobileClose}
              className={`flex items-center px-4 py-3 mx-2 rounded-lg transition-all text-[14px] font-sans ${
                isActive ? 'bg-[#1D9E75] text-white font-bold' : 'text-white/80 hover:bg-dp-primary-container hover:text-white'
              }`}>
              <Icon size={18} className="me-3 shrink-0" />
              <span className="min-w-0 truncate">{item.tKey ? t(item.tKey, item.label) : item.label}</span>
              {count > 0 && (
                <span
                  className="ms-auto shrink-0 bg-dp-error text-white text-[11px] font-bold font-sans rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center"
                  aria-label={`${count} new`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="px-2 pt-2 shrink-0" dir={rowDir}>
        <a href="/" className="flex items-center px-2 py-2.5 rounded-lg text-white/70 hover:bg-dp-primary-container hover:text-white transition-all text-[13.5px] font-sans">
          <ArrowLeftCircle size={17} className="me-3 shrink-0" /> {t('nav.backToWebsite')}
        </a>
      </div>

      {/* Logout */}
      <div className="px-4 pt-4 mt-auto border-t border-white/10 shrink-0">
        <button onClick={handleLogout} className="w-full flex items-center justify-center gap-2 py-2 bg-dp-error text-white rounded-lg text-[14px] font-sans font-semibold hover:opacity-90 transition-opacity cursor-pointer">
          <LogOut size={16} /> {t('nav.logout')}
        </button>
      </div>
    </>
  )

  return (
    <>
      <aside className="hidden md:flex flex-col h-screen py-6 bg-dp-primary border-e border-dp-outline-variant w-[210px] z-50 print:hidden"
        style={{ position: "fixed", top: 0, left: 0, right: "auto" }}>
        <div className="px-4 mb-6">{profileBlock}</div>
        {sidebarContent}
      </aside>

      {mobileOpen && <div className="bg-black/50 z-[90] md:hidden" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0 }} onClick={onMobileClose} />}

      <aside
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'auto',
          transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
        }}
        className="h-screen w-[260px] bg-dp-primary z-[100] md:hidden flex flex-col py-6 transition-transform duration-300 ease-in-out"
      >
        <div className="px-4 mb-6 flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">{profileBlock}</div>
          <button onClick={onMobileClose} className="text-white/80 hover:text-white p-1 cursor-pointer shrink-0" aria-label="Close menu"><X size={22} /></button>
        </div>
        {sidebarContent}
      </aside>
    </>
  )
}
