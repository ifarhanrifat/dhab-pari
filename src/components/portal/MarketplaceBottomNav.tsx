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
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Phase 6: converged off the old v2-handoff black/red scheme onto the
// mockup's own palette (white bg, dp2 green active) and emoji icons —
// same 5 tabs, same routes, same ~17 callers untouched (a pure visual
// convergence of this one shared component, not a navigation change).
export function MarketplaceBottomNav() {
  const { t } = useLocale()
  const pathname = usePathname()

  const tabs = [
    { key: 'home', href: '/portal/marketplace', emoji: '🏠', label: t('mp.navHome'), active: pathname === '/portal/marketplace' },
    { key: 'travel', href: '/portal/marketplace/travel', emoji: '🚐', label: t('mp.navTravel'), active: pathname.startsWith('/portal/marketplace/travel') },
    { key: 'map', href: '/portal/marketplace/nearby', emoji: '📍', label: t('mp.navMap'), active: pathname === '/portal/marketplace/nearby' },
    { key: 'chat', href: '/portal/marketplace/negotiations', emoji: '💬', label: t('mp.navChat'), active: pathname.startsWith('/portal/marketplace/negotiations') },
    { key: 'orders', href: '/portal/marketplace/orders', emoji: '🧾', label: t('mp.navOrders'), active: pathname === '/portal/marketplace/orders' },
  ]

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40">
      <div className="max-w-md mx-auto grid grid-cols-5 bg-white border-t border-dp2-card-border">
        {tabs.map((tab) => (
          <Link key={tab.key} href={tab.href} className="flex flex-col items-center gap-0.5 py-2.5 cursor-pointer" style={{ color: tab.active ? '#005A36' : '#94a3b8' }}>
            <span className="text-[17px] leading-none">{tab.emoji}</span>
            <span className="font-sans text-[9px]" style={{ fontWeight: tab.active ? 700 : 500 }}>{tab.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
