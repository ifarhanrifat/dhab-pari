'use client'

// Shopkeeper bottom tab bar (Shop Portal v3's own app-shell chrome: ڈیش
// بورڈ / کاؤنٹر / سٹاک / کیٹلاگ / رپورٹس) — the one piece of the design
// handoff that's genuinely a different navigation pattern than the rest
// of this app (which is sidebar/hamburger everywhere else), scoped
// deliberately to just these five shopkeeper screens rather than
// replacing the app's own nav globally. Stock and Catalog are both
// ShopCatalogSection tabs living on the same /portal/my-shop route (see
// that page's own `view` query-param handling) rather than separate
// pages — Counter and Reports are real separate routes.
//
// Rendered fixed at the viewport bottom; callers need bottom padding
// (pb-16) on their own root wrapper so this never overlaps the last bit
// of real content.

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { LayoutGrid, ShoppingCart, Package, Tags, BarChart3 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const ACCENT = '#ec3013'

export function ShopBottomNav() {
  const { t } = useLocale()
  const pathname = usePathname()
  const params = useSearchParams()
  const view = params.get('view')
  const isMyShopBase = pathname === '/portal/my-shop'

  const tabs = [
    { key: 'dashboard', href: '/portal/my-shop', icon: LayoutGrid, label: t('sk.navDashboard'), active: isMyShopBase && !view },
    { key: 'counter', href: '/portal/my-shop/sell', icon: ShoppingCart, label: t('sk.navCounter'), active: pathname === '/portal/my-shop/sell' },
    { key: 'stock', href: '/portal/my-shop?view=stock', icon: Package, label: t('sk.navStock'), active: isMyShopBase && view === 'stock' },
    { key: 'catalog', href: '/portal/my-shop?view=catalog', icon: Tags, label: t('sk.navCatalog'), active: isMyShopBase && view === 'catalog' },
    { key: 'reports', href: '/portal/my-shop/reports', icon: BarChart3, label: t('sk.navReports'), active: pathname === '/portal/my-shop/reports' },
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
