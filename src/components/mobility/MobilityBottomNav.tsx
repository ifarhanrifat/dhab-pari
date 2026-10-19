'use client'

// Rider bottom nav for the new design (Home / Machinery / Bookings /
// Chat / Account — the design's own `navR` array), scoped only to the
// mobility route group (marketplace/(mobility)/*), not portal-wide —
// same scoping precedent as the existing MarketplaceBottomNav it
// replaces on these specific pages.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Phase 6: icons converged onto the mockup's emoji taxonomy (its own
// navR row is 🏠/🏗️/🧾/💬/👤) — this nav's routes/labels/badges were
// already correct, this is a pure glyph swap, no behavior change.
export function MobilityBottomNav() {
  const { t } = useLocale()
  const pathname = usePathname()

  const tabs = [
    { key: 'home', href: '/portal/marketplace/travel', emoji: '🏠', label: t('mb.navHome'), active: pathname === '/portal/marketplace/travel' || pathname === '/portal/marketplace/results' },
    { key: 'mach', href: '/portal/marketplace/machinery', emoji: '🏗️', label: t('mb.navMachinery'), active: pathname.startsWith('/portal/marketplace/machinery') || pathname.startsWith('/portal/marketplace/tractor') || pathname.startsWith('/portal/marketplace/loader') },
    { key: 'trips', href: '/portal/marketplace/trips', emoji: '🧾', label: t('mb.navBookings'), active: pathname.startsWith('/portal/marketplace/trips') },
    { key: 'chat', href: '/portal/marketplace/negotiations', emoji: '💬', label: t('mb.navChat'), active: pathname.startsWith('/portal/marketplace/negotiations') },
    { key: 'acct', href: '/portal/marketplace/account', emoji: '👤', label: t('mb.navAccount'), active: pathname === '/portal/marketplace/account' },
  ]

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40">
      <div className="max-w-md mx-auto grid grid-cols-5 bg-white border-t border-[#e5e2d0]">
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
