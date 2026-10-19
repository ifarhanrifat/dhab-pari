'use client'

// Driver bottom nav for the new design. The richer, current design file
// (the real one — a plain-prototype earlier version was mistakenly used
// as the reference for a while) has navD = Jobs/Chat/Earnings/Vehicle;
// this app keeps its own real addition of a separate Home tab on top of
// that, so 5 tabs: Home/Jobs/Chat/Earnings/Vehicle. Chat was missing
// entirely until migration 658 gave hourly/equipment/rental/shadi
// bookings a real messaging thread each.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Phase 6: icons converged onto the mockup's emoji taxonomy (its own
// navD row is 📋/💬/💰/[vehicle emoji]; this app's own real addition of
// a Home tab stays — see this file's own earlier header comment) — a
// pure glyph swap, routes/labels/the real per-job jobsBadge count all
// unchanged.
export function DriverMobilityNav({ jobsBadge = 0 }: { jobsBadge?: number }) {
  const { t } = useLocale()
  const pathname = usePathname()

  const tabs = [
    { key: 'home', href: '/portal/my-vehicle', emoji: '🏠', label: t('mb.navHome'), active: pathname === '/portal/my-vehicle', badge: 0 },
    { key: 'jobs', href: '/portal/my-vehicle/jobs', emoji: '📋', label: t('mb.navJobs'), active: pathname.startsWith('/portal/my-vehicle/jobs'), badge: jobsBadge },
    { key: 'chat', href: '/portal/my-vehicle/chat', emoji: '💬', label: t('mb.navChat'), active: pathname.startsWith('/portal/my-vehicle/chat'), badge: 0 },
    { key: 'earn', href: '/portal/my-vehicle/earnings', emoji: '💰', label: t('mb.navEarnings'), active: pathname.startsWith('/portal/my-vehicle/earnings'), badge: 0 },
    { key: 'vehicle', href: '/portal/my-vehicle/vehicle', emoji: '🚐', label: t('mb.navVehicle'), active: pathname.startsWith('/portal/my-vehicle/vehicle'), badge: 0 },
  ]

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40">
      <div className="max-w-md mx-auto grid grid-cols-5 bg-white border-t border-[#e5e2d0]">
        {tabs.map((tab) => (
          <Link key={tab.key} href={tab.href} className="relative flex flex-col items-center gap-0.5 py-2.5 cursor-pointer" style={{ color: tab.active ? '#005A36' : '#94a3b8' }}>
            <span className="relative text-[17px] leading-none">
              {tab.emoji}
              {tab.badge > 0 && (
                <span className="absolute -top-1.5 -end-2 min-w-[15px] h-[15px] px-1 rounded-full bg-[#b91c1c] text-white text-[9px] font-bold flex items-center justify-center leading-none">{tab.badge}</span>
              )}
            </span>
            <span className="font-sans text-[9px]" style={{ fontWeight: tab.active ? 700 : 500 }}>{tab.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
