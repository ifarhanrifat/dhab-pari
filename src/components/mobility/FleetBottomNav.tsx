'use client'

// 860: the fleet owner/staff shell's own bottom nav — a direct sibling of
// DriverMobilityNav, not a variant of it, because a fleet owner is not a
// driver (that conflation was the actual bug being fixed: an owner with no
// personal vehicle was being shown DriverMobilityNav's Home/Jobs/Chat/
// Earnings/Vehicle tabs, scoped to one arbitrary fleet vehicle). Exactly
// the 5 tabs asked for: Dashboard, Bookings, Expenses, Cash Settlements,
// Reports. Fleet Staff/Counters/Invite-driver/Fare-requests are one tap
// away from Dashboard instead of extra tabs — same reasoning ShopBottomNav
// already uses to keep staff/purchase off its own tab bar.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function FleetBottomNav() {
  const { t } = useLocale()
  const pathname = usePathname()

  const tabs = [
    { key: 'dashboard', href: '/portal/fleet', emoji: '🏠', label: t('mb.navFleetDashboard'), active: pathname === '/portal/fleet' },
    { key: 'bookings', href: '/portal/fleet/bookings', emoji: '🎟️', label: t('mb.navFleetBookings'), active: pathname.startsWith('/portal/fleet/bookings') },
    { key: 'expenses', href: '/portal/fleet/expenses', emoji: '⛽', label: t('mb.navFleetExpenses'), active: pathname.startsWith('/portal/fleet/expenses') },
    { key: 'cash', href: '/portal/fleet/cash', emoji: '💵', label: t('mb.navFleetCash'), active: pathname.startsWith('/portal/fleet/cash') },
    { key: 'reports', href: '/portal/fleet/reports', emoji: '📊', label: t('mb.navFleetReports'), active: pathname.startsWith('/portal/fleet/reports') },
  ]

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40">
      <div className="max-w-md mx-auto grid grid-cols-5 bg-white border-t border-[#e5e2d0]">
        {tabs.map((tab) => (
          <Link key={tab.key} href={tab.href} className="relative flex flex-col items-center gap-0.5 py-2.5 cursor-pointer" style={{ color: tab.active ? '#005A36' : '#94a3b8' }}>
            <span className="relative text-[17px] leading-none">{tab.emoji}</span>
            <span className="font-sans text-[9px]" style={{ fontWeight: tab.active ? 700 : 500 }}>{tab.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
