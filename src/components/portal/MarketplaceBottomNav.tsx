'use client'

// Rider bottom tab bar — the v2 design handoff's own real navigation
// pattern for the marketplace/vehicle side (ہوم / سفر / نقشہ / گفتگو /
// آرڈر), confirmed against the prototype itself: the driver dashboard
// has no such bar (screen-rail only), so this is scoped to the rider-
// facing /portal/marketplace tree exactly, mirroring how ShopBottomNav
// is scoped to just /portal/my-shop. Same shipped pattern, reused
// verbatim (fixed bottom, black bg, red active state, pb-16 required
// on the caller's own root).
//
// "Orders" aggregates every booking kind into one feed (marketplace/
// orders) — the design's own home screen shows a live preview of the
// same feed, this is just its full list.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Navigation, MapPin, MessageCircle, Receipt } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const ACCENT = '#ec3013'

export function MarketplaceBottomNav() {
  const { t } = useLocale()
  const pathname = usePathname()

  const tabs = [
    { key: 'home', href: '/portal/marketplace', icon: Home, label: t('mp.navHome'), active: pathname === '/portal/marketplace' },
    { key: 'travel', href: '/portal/marketplace/travel', icon: Navigation, label: t('mp.navTravel'), active: pathname.startsWith('/portal/marketplace/travel') },
    { key: 'map', href: '/portal/marketplace/nearby', icon: MapPin, label: t('mp.navMap'), active: pathname === '/portal/marketplace/nearby' },
    { key: 'chat', href: '/portal/marketplace/negotiations', icon: MessageCircle, label: t('mp.navChat'), active: pathname.startsWith('/portal/marketplace/negotiations') },
    { key: 'orders', href: '/portal/marketplace/orders', icon: Receipt, label: t('mp.navOrders'), active: pathname === '/portal/marketplace/orders' },
  ]

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40">
      <div className="max-w-md mx-auto grid grid-cols-5 bg-[#201e1d] border-t-2" style={{ borderTopColor: ACCENT }}>
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <Link key={tab.key} href={tab.href} className="flex flex-col items-center gap-1 py-2.5 cursor-pointer" style={{ color: tab.active ? ACCENT : '#f3f2f2' }}>
              <Icon size={18} />
              <span className="font-sans text-[10px]">{tab.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
