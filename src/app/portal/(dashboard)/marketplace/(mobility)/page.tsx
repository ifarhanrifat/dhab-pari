'use client'

// Marketplace hub — two pillars (Shops & Market / Travel & Transport).
//
// 2026-11-24 — real ask, matching a reference design file: "why are we
// placing these garbage like chat and order there in this page when we
// are having special related things and options on the bottom
// navigation bar?" Both the "My orders and bookings" preview list and
// the "My Conversations" card were pure duplication — the bottom nav's
// own Bookings tab (marketplace/(mobility)/trips) already merges
// ride_bookings AND shop_orders (plus 7 other booking types this
// preview never showed at all), and its Chat tab already opens this
// same negotiations page. Both removed; this screen's real job is
// picking a pillar (and the cross-pillar product search), nothing else.
//
// Moved into the (mobility) route group (same URL, no change for
// anyone linking here) so it inherits MobilityHeader + the phone-frame
// shell + MobilityBottomNav from that layout instead of hand-wiring its
// own bottom nav under the old PortalHeader/AnnouncementBar chrome —
// same redesign pass already applied to travel/buses.

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Search, Store, ChevronRight } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface SearchResult {
  product_id: string; product_name: string; product_name_ur: string | null; flavor: string | null; flavor_ur: string | null; unit_price_pkr: number
  shop_id: string; shop_name: string; shop_name_ur: string | null; shop_location: string | null; shop_location_ur: string | null; delivery_enabled: boolean
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function PortalMarketplacePage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[] | null>(null)

  const runSearch = async (q: string) => {
    setQuery(q)
    if (!q.trim()) { setResults(null); return }
    setSearching(true)
    const { data } = await supabase.rpc('search_marketplace_products', { p_query: q.trim() })
    setResults((data ?? []) as SearchResult[])
    setSearching(false)
  }

  return (
    <div className="flex flex-col gap-4 pb-6">
      <div className="relative overflow-hidden rounded-[24px] text-white" style={{ backgroundImage: 'linear-gradient(140deg,#0f3d2e,#166534 55%,#15803d)' }}>
        <div className="relative z-10 px-4 pt-4 pb-4 max-w-[68%]">
          <p className="font-sans text-[19px] font-black leading-snug" style={{ textWrap: 'balance' }}>{t('mp.heroHeadline')}</p>
          <p className="font-sans text-[12px] text-white/80 mt-1.5 leading-snug">{t('mp.pageSubtitle')}</p>
        </div>
        <span className="absolute -bottom-2 end-1 text-[72px] leading-none opacity-90 select-none pointer-events-none" aria-hidden="true">🛍️🚐</span>
      </div>

      <div className="flex items-center gap-2 bg-white border border-[#e5e7eb] rounded-2xl px-3 h-11">
        <Search size={16} className="text-[#64748b] shrink-0" />
        <input value={query} onChange={(e) => runSearch(e.target.value)} placeholder={t('mp.searchPlaceholder')}
          className="flex-1 min-w-0 bg-transparent outline-none font-sans text-[14px] text-[#0f172a]" />
      </div>

      {results !== null && (
        <div className="flex flex-col gap-2.5">
          <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('mp.searchResultsHeading')}</p>
          {searching && <p className="text-center py-4"><LoadingDots /></p>}
          {!searching && results.length === 0 && <p className="font-sans text-[13px] text-[#64748b] text-center py-4">{t('mp.noResults')}</p>}
          {results.map((r) => (
            <Link key={`${r.shop_id}-${r.product_id}`} href={`/portal/marketplace/shop/${r.shop_id}`} className="flex items-center justify-between gap-3 bg-white border border-[#e5e7eb] rounded-2xl p-3 active:scale-[0.99] transition-transform">
              <div className="min-w-0">
                <p className="font-sans text-[13.5px] font-bold text-[#0f172a] truncate">
                  {isUrdu && r.product_name_ur ? r.product_name_ur : r.product_name}
                  {(isUrdu ? (r.flavor_ur || r.flavor) : r.flavor) && <span className="font-normal text-[#64748b]"> ({isUrdu ? (r.flavor_ur || r.flavor) : r.flavor})</span>}
                </p>
                <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5 truncate">{isUrdu && r.shop_name_ur ? r.shop_name_ur : r.shop_name}{!r.delivery_enabled && ` · ${t('mp.visitStoreNote')}`}</p>
              </div>
              <p className="font-sans text-[14px] font-black text-[#14532d] shrink-0 ltr-num">₨{fmt(r.unit_price_pkr)}</p>
            </Link>
          ))}
        </div>
      )}

      <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('mp.twoPillarsHeading')}</p>
      <div className="flex flex-col gap-2.5">
        <Link href="/portal/marketplace/shops" className="flex items-center gap-3.5 bg-white border border-[#e5e7eb] rounded-2xl p-4 shadow-[0_6px_18px_-12px_rgba(15,23,42,0.35)] active:scale-[0.99] transition-transform">
          <span className="shrink-0 w-14 h-14 rounded-2xl bg-[#f1f5f9] flex items-center justify-center"><Store size={26} className="text-[#166534]" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[15.5px] font-bold text-[#0f172a]">{t('mp.shopsPillarTitle')}</p>
            <p className="font-sans text-[12px] text-[#64748b] mt-0.5">{t('mp.shopsPillarHint')}</p>
          </div>
          <ChevronRight size={18} className="shrink-0 text-[#94a3b8] rtl:rotate-180" />
        </Link>
        <Link href="/portal/marketplace/travel" className="flex items-center gap-3.5 rounded-2xl p-4 text-white shadow-[0_6px_18px_-12px_rgba(15,23,42,0.35)] active:scale-[0.99] transition-transform" style={{ backgroundImage: 'linear-gradient(135deg,#166534,#15803d)' }}>
          <span className="shrink-0 w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center text-[26px]">🚐</span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[15.5px] font-bold">{t('mp.travelPillarTitle')}</p>
            <p className="font-sans text-[12px] text-white/80 mt-0.5">{t('mp.travelPillarHint')}</p>
          </div>
          <ChevronRight size={18} className="shrink-0 text-white/70 rtl:rotate-180" />
        </Link>
      </div>
    </div>
  )
}
