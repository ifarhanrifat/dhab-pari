'use client'

import { useEffect, useState } from 'react'
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
  History,
  Boxes,
  ListFilter,
  CalendarDays,
  Repeat,
  AlertTriangle,
  Truck,
  Coins,
  ShieldCheck,
  MessageSquareWarning,
  UserPlus,
  ClipboardList,
  BellRing,
  HandCoins,
  HandHeart,
  LineChart,
  HardHat,
  CalendarClock,
  Droplet,
  UploadCloud,
  ArrowRightLeft,
  Briefcase,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

const menuItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/billing', label: 'Billing', icon: Receipt, system: 'water_supply' },
  { href: '/admin/connections', label: 'New Connections', icon: UserPlus, system: 'water_supply', badge: 'connections' },
  { href: '/admin/tasks', label: 'Task Todo', icon: ClipboardList, system: 'water_supply' },
  { href: '/admin/tasks/meetings', label: 'Meetings & Agenda', icon: CalendarClock },
  { href: '/admin/reminders', label: 'Reminders', icon: BellRing },
  { href: '/admin/advances', label: 'Advance Payments', icon: HandCoins, system: 'water_supply' },
  { href: '/admin/projects', label: 'Projects', icon: FolderKanban },
  { href: '/admin/members', label: 'Members', icon: Users },
  { href: '/admin/accounts', label: 'Accounts', icon: BookOpen },
  { href: '/admin/finance', label: 'Transactions', icon: BarChart3 },
  { href: '/admin/transactions', label: 'All Transactions', icon: ListFilter },
  { href: '/admin/register', label: 'Daily Register', icon: CalendarDays },
  { href: '/admin/recurring', label: 'Recurring', icon: Repeat },
  { href: '/admin/approvals', label: 'Approvals', icon: ShieldCheck, badge: 'approvals' },
  { href: '/admin/inventory', label: 'Inventory & Services', icon: Boxes, system: 'water_supply' },
  { href: '/admin/reports/non-payment', label: 'Non-Payment Report', icon: AlertTriangle, system: 'water_supply' },
  { href: '/admin/collect', label: 'Collect Payment', icon: Truck, collectorOnly: true },
  { href: '/admin/payment-claims', label: 'Payment Claims', icon: UploadCloud, system: 'water_supply', badge: 'payment_claims' },
  { href: '/admin/collectors', label: 'Collectors', icon: Coins, system: 'water_supply' },
  { href: '/admin/employees', label: 'Employees', icon: HardHat, system: 'water_supply' },
  { href: '/admin/news', label: 'News', icon: Newspaper },
  { href: '/admin/videos', label: 'Videos', icon: Video },
  { href: '/admin/donors', label: 'Donors', icon: Heart, system: 'donors_projects', badge: 'donors' },
  { href: '/admin/donors/collectors', label: 'Donor Collectors', icon: Coins, system: 'donors_projects' },
  { href: '/admin/gallery', label: 'Gallery', icon: Image },
  { href: '/admin/suggestions', label: 'Suggestions', icon: MessageSquare, badge: 'suggestions' },
  { href: '/admin/volunteers', label: 'Volunteers', icon: HandHeart, system: 'donors_projects', badge: 'volunteers' },
  { href: '/admin/comments', label: 'Project Comments', icon: MessageSquare, system: 'donors_projects' },
  { href: '/admin/project-transfers', label: 'Project Transfers', icon: ArrowRightLeft, system: 'donors_projects' },
  { href: '/admin/complaints', label: 'Complaints', icon: MessageSquareWarning, badge: 'complaints' },
  { href: '/admin/ticker', label: 'Ticker', icon: TicketSlash },
  { href: '/admin/notifications', label: 'Alerts', icon: Bell, badge: 'alerts' },
  { href: '/admin/blood-donors', label: 'Blood Donors', icon: Droplet },
  { href: '/admin/blood-requests', label: 'Blood Requests', icon: Droplet, badge: 'blood_requests' },
  { href: '/admin/jobs', label: 'Job Listings', icon: Briefcase },
  { href: '/admin/reports', label: 'Reports', icon: FileText },
  { href: '/admin/running-capital', label: 'Running Capital', icon: LineChart },
  { href: '/admin/users', label: 'Users', icon: UserCog, adminAndAbove: true },
  { href: '/admin/audit-log', label: 'Audit Log', icon: History, adminAndAbove: true },
  { href: '/admin/settings', label: 'Settings', icon: Settings, superAdminOnly: true },
]

const roleLabels: Record<string, string> = {
  super_admin: 'Super Admin',
  water_accountant: 'Water Accountant',
  donor_accountant: 'Donor Accountant',
  publisher: 'Publisher',
  viewer: 'Viewer',
}

interface AdminSidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export function AdminSidebar({ mobileOpen = false, onMobileClose }: AdminSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const [profile, setProfile] = useState<{ full_name: string; role: string; can_collect_payments: boolean } | null>(null)
  const [badges, setBadges] = useState<Record<string, number>>({})

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('admin_users').select('full_name, role, can_collect_payments').eq('auth_user_id', user.id).single()
      if (data) setProfile(data)
    })
  }, [supabase])

  // One RPC for every count. Re-run on navigation so a badge clears as soon as
  // the work behind it is done, and every two minutes so someone parked on one
  // screen still sees a request that came in while they sat there.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const { data } = await supabase.rpc('admin_sidebar_badges')
      if (!cancelled && data) setBadges(data as Record<string, number>)
    }
    refresh()
    const id = setInterval(refresh, 120000)
    return () => { cancelled = true; clearInterval(id) }
  }, [supabase, pathname])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/admin/login')
    router.refresh()
  }

  const visibleMenuItems = menuItems.filter((item) => {
    if (!profile) return !item.collectorOnly
    if (item.collectorOnly && !profile.can_collect_payments) return false
    if (item.superAdminOnly && profile.role !== 'super_admin') return false
    if (item.adminAndAbove && profile.role !== 'super_admin' && profile.role !== 'admin') return false
    if (item.system === 'water_supply' && profile.role === 'donor_accountant') return false
    if (item.system === 'donors_projects' && profile.role === 'water_accountant') return false
    return true
  })

  // Exactly one item highlights at a time — the most specific match.
  // `pathname.startsWith(href)` alone lit up a parent AND its child together
  // ("Task Todo" + "Meetings & Agenda", "Donors" + "Donor Collectors",
  // "Reports" + "Non-Payment Report"), and also mis-matched sibling routes
  // that merely share a prefix (/admin/donors would match /admin/donors-x).
  // Comparing against `href + '/'` fixes the prefix case; taking the longest
  // match fixes the parent/child case.
  const activeHref = (() => {
    const matches = visibleMenuItems
      .map((i) => i.href)
      .filter((href) => (href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(href + '/')))
    return matches.sort((a, b) => b.length - a.length)[0] ?? null
  })()

  const sidebarContent = (
    <>
      {/* Menu */}
      <nav className="flex-1 space-y-1 overflow-y-auto">
        {visibleMenuItems.map((item) => {
          const Icon = item.icon
          const isActive = item.href === activeHref
          const count = item.badge ? (badges[item.badge] ?? 0) : 0
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
              <span className="min-w-0 truncate">{item.label}</span>
              {count > 0 && (
                <span
                  className="ml-auto shrink-0 bg-dp-error text-white text-[11px] font-bold font-sans rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center"
                  aria-label={`${count} awaiting action`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Current User + Logout */}
      <div className="px-4 pt-4 mt-auto border-t border-white/10 shrink-0">
        <div className="bg-dp-primary-container p-3 rounded-lg mb-3">
          <div className="flex items-center">
            <div className="w-8 h-8 rounded-full bg-[#5bc8a3] text-dp-primary flex items-center justify-center font-bold text-[12px] font-sans mr-2 shrink-0">
              {(profile?.full_name ?? '?').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-white text-[13px] font-sans font-semibold truncate">
                {profile?.full_name ?? 'Loading...'}
              </p>
              <p className="text-white/60 text-[11px] font-sans">
                {profile ? (roleLabels[profile.role] ?? profile.role) : ''}
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
      <aside className="hidden md:flex flex-col h-screen fixed left-0 top-0 py-6 bg-dp-primary border-r border-dp-outline-variant w-[210px] z-50 print:hidden">
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
