'use client'

// Rider bottom nav for the new design (Home / Machinery / Bookings /
// Chat / Account — the design's own `navR` array), scoped only to the
// mobility route group (marketplace/(mobility)/*), not portal-wide —
// same scoping precedent as the existing MarketplaceBottomNav it
// replaces on these specific pages.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Wrench, Receipt, MessageCircle, User } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function MobilityBottomNav() {
  const { t } = useLocale()
  const pathname = usePathname()

  const tabs = [
    { key: 'home', href: '/portal/marketplace/travel', icon: Home, label: t('mb.navHome'), active: pathname === '/portal/marketplace/travel' || pathname === '/portal/marketplace/results' },
    { key: 'mach', href: '/portal/marketplace/machinery', icon: Wrench, label: t('mb.navMachinery'), active: pathname.startsWith('/portal/marketplace/machinery') || pathname.startsWith('/portal/marketplace/tractor') || pathname.startsWith('/portal/marketplace/loader') },
    { key: 'trips', href: '/portal/marketplace/trips', icon: Receipt, label: t('mb.navBookings'), active: pathname.startsWith('/portal/marketplace/trips') },
    { key: 'chat', href: '/portal/marketplace/negotiations', icon: MessageCircle, label: t('mb.navChat'), active: pathname.startsWith('/portal/marketplace/negotiations') },
    { key: 'acct', href: '/portal/marketplace/account', icon: User, label: t('mb.navAccount'), active: pathname === '/portal/marketplace/account' },
  ]

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40">
      <div className="max-w-md mx-auto grid grid-cols-5 bg-white border-t border-[#e5e2d0]">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <Link key={tab.key} href={tab.href} className="flex flex-col items-center gap-1 py-2.5 cursor-pointer" style={{ color: tab.active ? '#005A36' : '#94a3b8' }}>
              <Icon size={18} />
              <span className="font-sans text-[9px] font-semibold">{tab.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
