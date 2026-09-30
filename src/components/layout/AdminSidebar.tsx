'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Receipt,
  Award,
  FolderKanban,
  Users,
  BarChart3,
  FileText,
  Settings,
  LogOut,
  ArrowLeftCircle,
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
  ShieldAlert,
  MessageSquareWarning,
  UserPlus,
  ClipboardList,
  BellRing,
  HandCoins,
  HandHeart,
  LineChart,
  HardHat,
  CalendarClock,
  Phone,
  ShoppingBag,
  Search,
  Droplet,
  UploadCloud,
  Store,
  Bus,
  Users2,
  MapPin,
  ArrowRightLeft,
  Briefcase,
  Scale,
  Radar,
  GraduationCap,
  Gift,
  School,
  Feather,
  NotebookPen,
  Megaphone,
  KeyRound,
  MessageCircle,
  Sparkles,
  Trophy,
  DatabaseZap,
  ChevronDown,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import { MODULES } from '@/lib/constants'

interface LeafItem {
  href: string; label: string; icon: LucideIcon
  system?: 'water_supply' | 'donors_projects'
  module?: 'business'
  publish?: 'news' | 'videos' | 'gallery' | 'ticker' | 'jobs' | 'poetry' | 'blog'
  tKey?: string
  badge?: string
  collectorOnly?: boolean; adminAndAbove?: boolean; superAdminOnly?: boolean
}
interface GroupItem {
  groupKey: string; label: string; tKey: string; icon: LucideIcon; children: LeafItem[]
}
type MenuEntry = LeafItem | GroupItem
const isGroup = (e: MenuEntry): e is GroupItem => 'children' in e

// Real ask, 2026-09-29: 63 flat items was a sidebar nobody could scan — a
// donor accountant scrolled past two dozen water-only rows just to find
// Zakat. Grouped the natural clusters (billing/water ops, the marketplace's
// ten-odd vehicle/shop/dispute screens, welfare programs, content
// publishing, etc.) behind a single parent that expands in place, same
// visual style, same spot — nothing about who can see which leaf changed,
// system/publish/role gates still apply per item exactly as before, a
// group just shows if at least one child would have. Genuinely standalone
// items (Dashboard, Accounts, Reports...) stay exactly where they were.
const menuItems: MenuEntry[] = [
  { href: '/admin', label: 'Dashboard', tKey: 'nav.dashboard', icon: LayoutDashboard },
  {
    groupKey: 'tasks', label: 'Tasks & Reminders', tKey: 'nav.groupTasks', icon: ClipboardList,
    children: [
      { href: '/admin/tasks', label: 'Task Todo', tKey: 'nav.tasks', icon: ClipboardList, system: 'water_supply' },
      { href: '/admin/tasks/meetings', label: 'Meetings & Agenda', tKey: 'nav.meetings', icon: CalendarClock },
      { href: '/admin/reminders', label: 'Reminders', tKey: 'nav.reminders', icon: BellRing },
    ],
  },
  {
    groupKey: 'billing', label: 'Billing & Water Ops', tKey: 'nav.groupBilling', icon: Receipt,
    children: [
      { href: '/admin/billing', label: 'Billing', tKey: 'nav.billing', icon: Receipt, system: 'water_supply' },
      { href: '/admin/connections', label: 'New Connections', tKey: 'nav.connections', icon: UserPlus, system: 'water_supply', badge: 'connections' },
      { href: '/admin/advances', label: 'Advance Payments', tKey: 'nav.advances', icon: HandCoins, system: 'water_supply' },
      { href: '/admin/payment-claims', label: 'Payment Claims', tKey: 'nav.paymentClaims', icon: UploadCloud, system: 'water_supply', badge: 'payment_claims' },
      { href: '/admin/collectors', label: 'Collectors', tKey: 'nav.collectors', icon: Coins, system: 'water_supply' },
      { href: '/admin/collect', label: 'Collect Payment', tKey: 'nav.collect', icon: Truck, collectorOnly: true },
      { href: '/admin/reports/non-payment', label: 'Non-Payment Report', tKey: 'nav.nonPayment', icon: AlertTriangle, system: 'water_supply' },
      { href: '/admin/inventory', label: 'Inventory & Services', tKey: 'nav.inventory', icon: Boxes, system: 'water_supply' },
      { href: '/admin/employees', label: 'Employees', tKey: 'nav.employees', icon: HardHat, system: 'water_supply' },
    ],
  },
  { href: '/admin/members', label: 'Members', tKey: 'nav.members', icon: Users },
  { href: '/admin/accounts', label: 'Accounts', tKey: 'nav.accounts', icon: BookOpen },
  {
    groupKey: 'transactions', label: 'Transactions & Records', tKey: 'nav.groupTransactions', icon: BarChart3,
    children: [
      { href: '/admin/finance', label: 'Transactions', tKey: 'nav.finance', icon: BarChart3 },
      { href: '/admin/transactions', label: 'All Transactions', tKey: 'nav.transactions', icon: ListFilter },
      { href: '/admin/register', label: 'Daily Register', tKey: 'nav.register', icon: CalendarDays },
      { href: '/admin/recurring', label: 'Recurring', tKey: 'nav.recurring', icon: Repeat },
    ],
  },
  { href: '/admin/approvals', label: 'Approvals', tKey: 'nav.approvals', icon: ShieldCheck, badge: 'approvals' },
  {
    groupKey: 'donors', label: 'Donors & Projects', tKey: 'nav.groupDonors', icon: Heart,
    children: [
      { href: '/admin/projects', label: 'Projects', tKey: 'nav.projects', icon: FolderKanban, system: 'donors_projects' },
      { href: '/admin/donors', label: 'Donors', tKey: 'nav.donors', icon: Heart, system: 'donors_projects', badge: 'donors' },
      { href: '/admin/donors/collectors', label: 'Donor Collectors', tKey: 'nav.donorCollectors', icon: Coins, system: 'donors_projects' },
      { href: '/admin/donor-badges', label: 'Donor Badges', tKey: 'nav.donorBadges', icon: Award, system: 'donors_projects' },
      { href: '/admin/volunteers', label: 'Volunteers', tKey: 'nav.volunteers', icon: HandHeart, system: 'donors_projects', badge: 'volunteers' },
      { href: '/admin/comments', label: 'Project Comments', tKey: 'nav.comments', icon: MessageSquare, system: 'donors_projects' },
      { href: '/admin/project-transfers', label: 'Project Transfers', tKey: 'nav.projectTransfers', icon: ArrowRightLeft, system: 'donors_projects' },
    ],
  },
  {
    // The welfare modules. All eight sit in the donors system and all read
    // from the one verified needs register.
    groupKey: 'welfare', label: 'Welfare Programs', tKey: 'nav.groupWelfare', icon: HandHeart,
    children: [
      { href: '/admin/needs-register', label: 'Needs Register', tKey: 'nav.needsRegister', icon: ShieldCheck, system: 'donors_projects' },
      { href: '/admin/zakat', label: 'Zakat & Ushr', tKey: 'nav.zakat', icon: Scale, system: 'donors_projects' },
      { href: '/admin/kafalat', label: 'Kafalat', tKey: 'nav.kafalat', icon: GraduationCap, system: 'donors_projects' },
      { href: '/admin/schools', label: 'Schools & Fees', tKey: 'nav.schools', icon: School, system: 'donors_projects' },
      { href: '/admin/wazifa', label: 'Taleemi Wazifa', tKey: 'nav.wazifa', icon: BookOpen, system: 'donors_projects' },
      { href: '/admin/esal-e-sawab', label: 'Esal-e-Sawab', tKey: 'nav.esalESawab', icon: Gift, system: 'donors_projects' },
      // Not adminAndAbove — a scoped trainer (role='viewer', can_collect_payments,
      // assigned_training_program_ids) needs this link too; RLS narrows what
      // they actually see once they're on the page to just their own academy.
      { href: '/admin/academy-fees', label: 'Academy Fees', tKey: 'nav.academyFees', icon: HandCoins, system: 'donors_projects' },
      { href: '/admin/reports/academy-non-payment', label: 'Academy Non-Payment', tKey: 'nav.academyNonPayment', icon: AlertTriangle, system: 'donors_projects' },
    ],
  },
  { href: '/admin/complaints', label: 'Complaints', tKey: 'nav.complaints', icon: MessageSquareWarning, badge: 'complaints' },
  { href: '/admin/civic-reports', label: 'Village Problems', tKey: 'nav.civicReports', icon: AlertTriangle },
  { href: '/admin/help-requests', label: 'Help Requests', tKey: 'nav.helpRequests', icon: HandHeart },
  {
    groupKey: 'content', label: 'Content Publishing', tKey: 'nav.groupContent', icon: Newspaper,
    children: [
      { href: '/admin/news', label: 'News', tKey: 'nav.news', icon: Newspaper, publish: 'news' },
      { href: '/admin/poetry', label: 'Poetry Corner', tKey: 'nav.poetry', icon: Feather, publish: 'poetry' },
      { href: '/admin/blog', label: 'Blog', tKey: 'nav.blog', icon: NotebookPen, publish: 'blog' },
      { href: '/admin/videos', label: 'Videos', tKey: 'nav.videos', icon: Video, publish: 'videos' },
      { href: '/admin/gallery', label: 'Gallery', tKey: 'nav.gallery', icon: Image, publish: 'gallery' },
      { href: '/admin/ticker', label: 'Ticker', tKey: 'nav.ticker', icon: TicketSlash, publish: 'ticker' },
      { href: '/admin/jobs', label: 'Job Listings', tKey: 'nav.jobs', icon: Briefcase, publish: 'jobs' },
      { href: '/admin/classifieds', label: 'Buy & Sell', tKey: 'nav.classifieds', icon: ShoppingBag },
      { href: '/admin/lost-found', label: 'Lost & Found', tKey: 'nav.lostFoundAdmin', icon: Search },
      { href: '/admin/important-contacts', label: 'Important Contacts', tKey: 'nav.importantContacts', icon: Phone },
    ],
  },
  { href: '/admin/suggestions', label: 'Suggestions', tKey: 'nav.suggestions', icon: MessageSquare, badge: 'suggestions' },
  { href: '/admin/notifications', label: 'Alerts & Appeals', tKey: 'nav.alerts', icon: Bell, badge: 'alerts' },
  {
    groupKey: 'blood', label: 'Blood Bank', tKey: 'nav.groupBlood', icon: Droplet,
    children: [
      { href: '/admin/blood-donors', label: 'Blood Donors', tKey: 'nav.bloodDonors', icon: Droplet },
      { href: '/admin/blood-requests', label: 'Blood Requests', tKey: 'nav.bloodRequests', icon: Droplet, badge: 'blood_requests' },
    ],
  },
  { href: '/admin/reports', label: 'Reports', tKey: 'nav.reports', icon: FileText },
  { href: '/admin/running-capital', label: 'Running Capital', tKey: 'nav.runningCapital', icon: LineChart },
  { href: '/admin/committee-notes', label: 'Committee Notes', tKey: 'nav.committeeNotes', icon: Megaphone, adminAndAbove: true },
  {
    groupKey: 'usersAccess', label: 'Users & Access', tKey: 'nav.groupUsers', icon: UserCog,
    children: [
      { href: '/admin/users', label: 'Users', tKey: 'nav.users', icon: UserCog, adminAndAbove: true },
      { href: '/admin/portal-accounts', label: 'Portal Accounts', tKey: 'nav.portalAccounts', icon: KeyRound, adminAndAbove: true },
    ],
  },
  { href: '/admin/mentor-chats', label: 'Mentor Chats', tKey: 'nav.mentorChats', icon: MessageCircle, adminAndAbove: true },
  { href: '/admin/institutes', label: 'Institutes', tKey: 'nav.institutes', icon: School, adminAndAbove: true },
  {
    // The vehicle/shop marketplace cluster — real ask, 2026-09-29: "for
    // vehicle there are 5 or 6 tabs, make these all sub tabs" (there turned
    // out to be ten, once shops/disputes/verification/the fleet map are
    // counted in with the vehicle screens themselves).
    groupKey: 'marketplace', label: 'Marketplace & Vehicles', tKey: 'nav.groupMarketplace', icon: Bus,
    children: [
      { href: '/admin/shops', label: 'Shops', tKey: 'nav.shops', icon: Store, system: 'donors_projects' },
      { href: '/admin/vehicles', label: 'Vehicles', tKey: 'nav.vehicles', icon: Bus, system: 'donors_projects' },
      { href: '/admin/vehicle-registrations', label: 'Vehicle Registrations', tKey: 'nav.vehicleRegistrations', icon: UserPlus, system: 'donors_projects' },
      { href: '/admin/shadi-bookings', label: 'Shadi Bookings', tKey: 'nav.shadiBookings', icon: Users2, system: 'donors_projects' },
      { href: '/admin/marketplace-overview', label: 'Overview & Fleet Map', tKey: 'nav.marketplaceOverview', icon: LayoutDashboard, system: 'donors_projects' },
      { href: '/admin/marketplace-reference', label: 'Marketplace Reference', tKey: 'nav.marketplaceReference', icon: MapPin, system: 'donors_projects' },
      { href: '/admin/party-complaints', label: 'Marketplace Complaints', tKey: 'nav.partyComplaints', icon: ShieldAlert, system: 'donors_projects', badge: 'party_complaints' },
      { href: '/admin/user-verification', label: 'User Verification', tKey: 'nav.userVerification', icon: ShieldCheck, system: 'donors_projects' },
      { href: '/admin/disputes', label: 'Disputes', tKey: 'nav.disputes', icon: Scale, system: 'donors_projects' },
      { href: '/admin/fleet-map', label: 'Fleet Map', tKey: 'nav.fleetMap', icon: Radar, system: 'donors_projects' },
    ],
  },
  { href: '/admin/talent-showcase', label: 'Talent Showcase', tKey: 'nav.talentShowcase', icon: Sparkles, adminAndAbove: true },
  { href: '/admin/achievements', label: 'Achievements', tKey: 'nav.achievements', icon: Trophy, adminAndAbove: true },
  { href: '/admin/audit-log', label: 'Audit Log', tKey: 'nav.auditLog', icon: History, adminAndAbove: true },
  { href: '/admin/import-legacy', label: 'Import Legacy Data', tKey: 'nav.importLegacy', icon: DatabaseZap, superAdminOnly: true },
  { href: '/admin/settings', label: 'Settings', tKey: 'nav.settings', icon: Settings, superAdminOnly: true },
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
  const [profile, setProfile] = useState<{
    full_name: string; role: string; can_collect_payments: boolean
    can_publish_news: boolean; can_publish_videos: boolean; can_publish_gallery: boolean
    can_publish_ticker: boolean; can_publish_jobs: boolean
    can_publish_poetry: boolean; can_publish_blog: boolean
  } | null>(null)
  // Same can_access_system() the RLS policies are built on, rather than a
  // hand-maintained list of role names — the old check only knew about
  // water_accountant and donor_accountant, so an 'accountant' granted just one
  // system still saw the other one's whole menu, and a secondary role was
  // ignored entirely.
  const access = useSystemAccess()
  const { t, isUrdu } = useLocale()
  const [badges, setBadges] = useState<Record<string, number>>({})

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('admin_users')
        .select('full_name, role, can_collect_payments, can_publish_news, can_publish_videos, can_publish_gallery, can_publish_ticker, can_publish_jobs, can_publish_poetry, can_publish_blog')
        .eq('auth_user_id', user.id).single()
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

  const isLeafVisible = (item: LeafItem) => {
    // Modules this village did not buy are hidden for everyone. A product
    // switch only — RLS still decides what any request may actually read.
    if (item.system === 'water_supply' && !MODULES.waterSupply) return false
    if (item.system === 'donors_projects' && !MODULES.donors) return false
    if (item.module === 'business' && !MODULES.business) return false

    if (!profile) return !item.collectorOnly
    if (item.collectorOnly && !profile.can_collect_payments) return false
    if (item.superAdminOnly && profile.role !== 'super_admin') return false
    if (item.adminAndAbove && profile.role !== 'super_admin' && profile.role !== 'admin') return false

    // A publisher writes content and nothing else. The role was never filtered
    // here, so a publisher previously saw billing, accounts, transactions and
    // every committee section — they simply had no permission to act once they
    // arrived. Now the menu says so: their own areas, and the dashboard.
    const publisherAreas: Record<string, boolean> = {
      news: !!profile.can_publish_news,
      videos: !!profile.can_publish_videos,
      gallery: !!profile.can_publish_gallery,
      ticker: !!profile.can_publish_ticker,
      jobs: !!profile.can_publish_jobs,
      poetry: !!profile.can_publish_poetry,
      blog: !!profile.can_publish_blog,
    }
    if (profile.role === 'publisher') {
      if (item.href === '/admin') return true
      return !!item.publish && publisherAreas[item.publish]
    }
    // Anyone else keeps a publishable section only if they hold that area.
    // Administrators are given every area by the migration, so nothing changes
    // for them.
    if (item.publish && !publisherAreas[item.publish]) return false

    // While access is still loading, show nothing system-specific rather than
    // flashing the other account's menu and then removing it.
    if (item.system === 'water_supply') return !access.loading && access.canWaterSupply
    if (item.system === 'donors_projects') return !access.loading && access.canDonorsProjects
    return true
  }

  // A group's own visibility is derived, never configured directly — it
  // shows the moment at least one child would have on its own, and carries
  // only the children that actually passed. Nothing about who sees which
  // leaf changes from the old flat list; only the wrapping does.
  const visibleMenuItems: MenuEntry[] = menuItems
    .map((entry) => (isGroup(entry) ? { ...entry, children: entry.children.filter(isLeafVisible) } : entry))
    .filter((entry) => (isGroup(entry) ? entry.children.length > 0 : isLeafVisible(entry)))

  const flatVisibleItems = visibleMenuItems.flatMap((entry) => (isGroup(entry) ? entry.children : [entry]))

  // Exactly one item highlights at a time — the most specific match.
  // `pathname.startsWith(href)` alone lit up a parent AND its child together
  // ("Task Todo" + "Meetings & Agenda", "Donors" + "Donor Collectors",
  // "Reports" + "Non-Payment Report"), and also mis-matched sibling routes
  // that merely share a prefix (/admin/donors would match /admin/donors-x).
  // Comparing against `href + '/'` fixes the prefix case; taking the longest
  // match fixes the parent/child case.
  const activeHref = (() => {
    const matches = flatVisibleItems
      .map((i) => i.href)
      .filter((href) => (href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(href + '/')))
    return matches.sort((a, b) => b.length - a.length)[0] ?? null
  })()

  // Whichever group holds the current page, expanded automatically — a
  // direct link into e.g. Vehicles shouldn't land on an all-collapsed menu
  // with no visible way to tell where you are. Re-derived every render from
  // the route itself (not stored) except when a manual toggle below
  // overrides it, so browsing to a different section's page always
  // re-syncs the expansion on the next navigation.
  const activeGroupKey = visibleMenuItems.find((e) => isGroup(e) && e.children.some((c) => c.href === activeHref)) as GroupItem | undefined
  const [openGroupOverride, setOpenGroupOverride] = useState<string | null | undefined>(undefined)
  // A manual toggle only holds until the next real navigation — clicking a
  // group header (a button, not a Link) doesn't change pathname, so the
  // override sticks while browsing; an actual page change clears it, which
  // is what lets the newly-active group take over again on its own.
  useEffect(() => { setOpenGroupOverride(undefined) }, [pathname])
  const openGroup = openGroupOverride !== undefined ? openGroupOverride : (activeGroupKey?.groupKey ?? null)
  const toggleGroup = (key: string) => setOpenGroupOverride(openGroup === key ? null : key)

  // The sidebar stays pinned to the left edge in Urdu too (RTL_READY is
  // deliberately off — see LocaleProvider); only each row's own icon/text
  // order and margins flip, via a plain `dir` on the row — every one of
  // these already uses logical spacing (me-*, ms-auto), so that alone
  // puts the icon on the reading "start" side without moving the menu.
  const rowDir = isUrdu ? 'rtl' : 'ltr'
  // Profile + language used to sit at the very bottom, under a plain "Admin
  // Portal" title at the top that said nothing about who was actually
  // logged in. Moved to the top instead — same row, same dir={rowDir} +
  // logical (me-*) spacing the rest of the sidebar already uses, so the
  // avatar sits on the reading "start" side (left in English, right in
  // Urdu) without any extra flip logic of its own.
  const profileBlock = (
    <div className="shrink-0" dir={rowDir}>
      <Link href="/admin/profile" onClick={onMobileClose} className="block bg-dp-primary-container p-3 rounded-lg hover:bg-dp-primary-container/80 transition-colors">
        <div className="flex items-center">
          <div className="w-8 h-8 rounded-full bg-[#5bc8a3] text-dp-primary flex items-center justify-center font-bold text-[12px] font-sans me-2 shrink-0">
            {(profile?.full_name ?? '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-white text-[13px] font-sans font-semibold truncate">
              {profile?.full_name ?? t('action.loading')}
            </p>
            <p className="text-white/60 text-[11px] font-sans">
              {profile ? (roleLabels[profile.role] ?? profile.role) : ''}
            </p>
          </div>
        </div>
      </Link>
      <div className="pt-3">
        <LanguageToggle compact />
      </div>
    </div>
  )
  const sidebarContent = (
    <>
      {/* Menu */}
      <nav className="flex-1 space-y-1 overflow-y-auto" dir={rowDir}>
        {visibleMenuItems.map((entry) => {
          if (isGroup(entry)) {
            const GroupIcon = entry.icon
            const expanded = openGroup === entry.groupKey
            // A group counts as "active" (same highlight as a selected leaf)
            // whenever it's collapsed and one of its own children is the
            // current page — expanded, the child itself carries that
            // highlight instead, so the group chrome doesn't double up on it.
            const groupIsActiveCollapsed = !expanded && entry.children.some((c) => c.href === activeHref)
            const groupBadgeTotal = entry.children.reduce((sum, c) => sum + (c.badge ? (badges[c.badge] ?? 0) : 0), 0)
            return (
              <div key={entry.groupKey}>
                <button
                  type="button"
                  onClick={() => toggleGroup(entry.groupKey)}
                  className={`w-full flex items-center px-4 py-3 mx-2 rounded-lg transition-all text-[14px] font-sans cursor-pointer ${
                    groupIsActiveCollapsed
                      ? 'bg-[#1D9E75] text-white font-bold'
                      : 'text-white/80 hover:bg-dp-primary-container hover:text-white'
                  }`}
                  style={{ width: 'calc(100% - 1rem)' }}
                  aria-expanded={expanded}
                >
                  <GroupIcon size={18} className="me-3 shrink-0" />
                  <span className="min-w-0 truncate">{t(entry.tKey, entry.label)}</span>
                  {groupBadgeTotal > 0 && (
                    <span className="ms-auto me-1.5 shrink-0 bg-dp-error text-white text-[11px] font-bold font-sans rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center" aria-label={`${groupBadgeTotal} awaiting action`}>
                      {groupBadgeTotal > 99 ? '99+' : groupBadgeTotal}
                    </span>
                  )}
                  <ChevronDown size={15} className={`shrink-0 transition-transform ${groupBadgeTotal > 0 ? '' : 'ms-auto'} ${expanded ? 'rotate-180' : ''}`} />
                </button>
                {expanded && (
                  <div className="mt-1 space-y-1">
                    {entry.children.map((item) => {
                      const Icon = item.icon
                      const isActive = item.href === activeHref
                      const count = item.badge ? (badges[item.badge] ?? 0) : 0
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={onMobileClose}
                          className={`flex items-center ps-8 pe-4 py-2.5 mx-2 rounded-lg transition-all text-[13.5px] font-sans ${
                            isActive ? 'bg-[#1D9E75] text-white font-bold' : 'text-white/70 hover:bg-dp-primary-container hover:text-white'
                          }`}
                        >
                          <Icon size={16} className="me-3 shrink-0" />
                          <span className="min-w-0 truncate">{item.tKey ? t(item.tKey, item.label) : item.label}</span>
                          {count > 0 && (
                            <span className="ms-auto shrink-0 bg-dp-error text-white text-[11px] font-bold font-sans rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center" aria-label={`${count} awaiting action`}>
                              {count > 99 ? '99+' : count}
                            </span>
                          )}
                        </Link>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          }

          const item = entry
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
              <Icon size={18} className="me-3 shrink-0" />
              <span className="min-w-0 truncate">{item.tKey ? t(item.tKey, item.label) : item.label}</span>
              {count > 0 && (
                <span
                  className="ms-auto shrink-0 bg-dp-error text-white text-[11px] font-bold font-sans rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center"
                  aria-label={`${count} awaiting action`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Real report, 2026-09-25: no way to reach the public website from an
          admin account at all -- the portal sidebar already has exactly
          this link (same href="/", same session underneath, staying logged
          in the whole time), just never existed on the admin side. */}
      <div className="px-2 pt-2 shrink-0" dir={rowDir}>
        <a href="/" className="flex items-center px-2 py-2.5 rounded-lg text-white/70 hover:bg-dp-primary-container hover:text-white transition-all text-[13.5px] font-sans">
          <ArrowLeftCircle size={17} className="me-3 shrink-0" /> {t('nav.backToWebsite')}
        </a>
      </div>

      {/* Logout */}
      <div className="px-4 pt-4 mt-auto border-t border-white/10 shrink-0">
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-2 bg-dp-error text-white rounded-lg text-[14px] font-sans font-semibold hover:opacity-90 transition-opacity cursor-pointer"
        >
          <LogOut size={16} />
          {t('nav.logout')}
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside style={{ position: "fixed", top: 0, left: 0, right: "auto" }} className="hidden md:flex flex-col h-screen py-6 bg-dp-primary border-e border-dp-outline-variant w-[210px] z-50 print:hidden">
        <div className="px-4 mb-6">{profileBlock}</div>
        {sidebarContent}
      </aside>

      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="bg-black/50 z-[90] md:hidden"
          style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0 }}
          onClick={onMobileClose}
        />
      )}

      {/* Mobile drawer */}
      <aside
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 'auto',
          // Inline, not a class: the drawer was staying on screen taking half
          // the display because the translate utility was not resolving, which
          // left it with no way to hide itself.
          transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
        }}
        className="h-screen w-[260px] bg-dp-primary z-[100] md:hidden flex flex-col py-6 transition-transform duration-300 ease-in-out"
      >
        <div className="px-4 mb-6 flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">{profileBlock}</div>
          <button
            onClick={onMobileClose}
            className="text-white/80 hover:text-white p-1 cursor-pointer shrink-0"
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
