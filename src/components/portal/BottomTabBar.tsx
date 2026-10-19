'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface TabDef {
  href: string
  emoji: string
  labelKey: string
  /** Key into portal_sidebar_badges()'s output — the RPC buckets by the
      2nd path segment after /portal/ (e.g. every /portal/marketplace/*
      link buckets under "marketplace", not per sub-page), so only one
      tab per section can carry a badge, not one per tab. */
  badgeKey?: string
}

const RIDER_TABS: TabDef[] = [
  { href: '/portal', emoji: '🏠', labelKey: 'nav.tabHome' },
  { href: '/portal/marketplace', emoji: '🏗️', labelKey: 'nav.tabMarketplace', badgeKey: 'marketplace' },
  { href: '/portal/marketplace/orders', emoji: '🧾', labelKey: 'nav.tabBookings' },
  { href: '/portal/marketplace/negotiations', emoji: '💬', labelKey: 'nav.tabChat' },
  { href: '/portal/account', emoji: '👤', labelKey: 'nav.tabAccount' },
]

const DRIVER_TABS: TabDef[] = [
  { href: '/portal/my-vehicle/jobs', emoji: '📋', labelKey: 'nav.tabJobs', badgeKey: 'my-vehicle' },
  { href: '/portal/my-vehicle/chat', emoji: '💬', labelKey: 'nav.tabChat' },
  { href: '/portal/my-vehicle/earnings', emoji: '💰', labelKey: 'nav.tabEarnings' },
  { href: '/portal/my-vehicle/vehicle', emoji: '🚐', labelKey: 'nav.tabVehicle' },
  { href: '/portal/account', emoji: '👤', labelKey: 'nav.tabAccount' },
]

// The one persistent bottom tab bar for the new native-app shell —
// replaces MarketplaceBottomNav/ShopBottomNav/MobilityBottomNav's role
// as primary navigation (those three stay mounted, unchanged, inside
// their own still-legacy-chrome route families pending reconciliation;
// see portal/(dashboard)/layout.tsx's own comment). Takes no props: the
// rider/driver switch and badge data are both derived here, same as
// PortalSidebar did, so every mount behaves identically.
export function BottomTabBar() {
  const { t } = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const { user } = usePortalUser()
  const [hasVehicle, setHasVehicle] = useState(false)
  const [badges, setBadges] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id').eq('portal_user_id', user.id).limit(1)
      .then(({ data }) => setHasVehicle((data?.length ?? 0) > 0))
  }, [supabase, user])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    const refresh = async () => {
      const { data } = await supabase.rpc('portal_sidebar_badges')
      if (!cancelled && data) setBadges(data as Record<string, number>)
    }
    refresh()
    const id = setInterval(refresh, 120000)
    return () => { cancelled = true; clearInterval(id) }
  }, [supabase, user])

  const tabs = hasVehicle ? DRIVER_TABS : RIDER_TABS

  return (
    <nav className="fixed bottom-0 inset-x-0 bg-white border-t border-dp2-card-border flex justify-around items-center py-1.5 pb-[calc(6px+env(safe-area-inset-bottom,0px))] shadow-[0_-4px_10px_rgba(0,0,0,.05)] z-30 max-w-md mx-auto left-0 right-0">
      {tabs.map((tab) => {
        const active = tab.href === '/portal' ? pathname === '/portal' : pathname === tab.href || pathname.startsWith(tab.href + '/')
        const badge = tab.badgeKey ? badges[tab.badgeKey] : undefined
        return (
          <button key={tab.href} onClick={() => router.push(tab.href)} className="relative flex flex-col items-center gap-0.5 px-2 py-0.5 cursor-pointer">
            <span className="text-[17px] leading-none">{tab.emoji}</span>
            <span className="text-[9px]" style={{ color: active ? '#005A36' : '#94a3b8', fontWeight: active ? 700 : 500 }}>{t(tab.labelKey)}</span>
            {!!badge && badge > 0 && (
              <span className="absolute top-0 end-1.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-[#dc2626] text-white text-[9px] font-extrabold flex items-center justify-center">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
