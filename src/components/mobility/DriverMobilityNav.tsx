'use client'

// Driver bottom nav for the new design — the design file's own driver
// tab set exactly: Home / Jobs / Earnings / Vehicle (`nav_home`,
// `nav_jobs`, `nav_earn`, `nav_vehicle` in dhab-pari-mobility.html's own
// `nav()` function for `S.role==='driver'`). No separate Chat tab on the
// driver side — the file doesn't have one; messaging for a given job
// lives on that job's own detail page, same as the file's shared
// order-detail "page" overlay.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, ClipboardList, Wallet, Truck } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function DriverMobilityNav({ jobsBadge = 0 }: { jobsBadge?: number }) {
  const { t } = useLocale()
  const pathname = usePathname()

  const tabs = [
    { key: 'home', href: '/portal/my-vehicle', icon: Home, label: t('mb.navHome'), active: pathname === '/portal/my-vehicle', badge: 0 },
    { key: 'jobs', href: '/portal/my-vehicle/jobs', icon: ClipboardList, label: t('mb.navJobs'), active: pathname.startsWith('/portal/my-vehicle/jobs'), badge: jobsBadge },
    { key: 'earn', href: '/portal/my-vehicle/earnings', icon: Wallet, label: t('mb.navEarnings'), active: pathname.startsWith('/portal/my-vehicle/earnings'), badge: 0 },
    { key: 'vehicle', href: '/portal/my-vehicle/vehicle', icon: Truck, label: t('mb.navVehicle'), active: pathname.startsWith('/portal/my-vehicle/vehicle'), badge: 0 },
  ]

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40">
      <div className="max-w-md mx-auto grid grid-cols-4 bg-white border-t border-[#e5e2d0]">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <Link key={tab.key} href={tab.href} className="relative flex flex-col items-center gap-1 py-2.5 cursor-pointer" style={{ color: tab.active ? '#005A36' : '#94a3b8' }}>
              <span className="relative">
                <Icon size={18} />
                {tab.badge > 0 && (
                  <span className="absolute -top-1.5 -end-2 min-w-[15px] h-[15px] px-1 rounded-full bg-[#b91c1c] text-white text-[9px] font-bold flex items-center justify-center leading-none">{tab.badge}</span>
                )}
              </span>
              <span className="font-sans text-[9px] font-semibold">{tab.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
