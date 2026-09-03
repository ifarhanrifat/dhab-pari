'use client'

// Marketplace hub — two pillars (Shops & Market / Travel & Transport),
// matching the original design spec's own home-screen framing
// ("01 دکانیں اور بازار" / "02 سفر اور ٹرانسپورٹ") instead of the flat
// tile grid this page used to be. Search and "my orders/bookings" stay
// here since they cut across both pillars; shop browsing moved to
// /shops, every travel-related tile (adda/order-city/pro/commute/nearby/
// trips) plus the map moved to /travel. "My Conversations" also stays
// here — fetch/share/pro negotiation threads can originate from either
// pillar, so it doesn't belong nested under just one.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Search, Store, Clock, CheckCircle2, XCircle, MessageCircle } from 'lucide-react'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface SearchResult {
  product_id: string; product_name: string; product_name_ur: string | null; flavor: string | null; flavor_ur: string | null; unit_price_pkr: number
  shop_id: string; shop_name: string; shop_name_ur: string | null; shop_location: string | null; shop_location_ur: string | null; delivery_enabled: boolean
}
interface ShopOrder {
  id: string; status: string; total_amount_pkr: number; rejected_reason: string | null; created_at: string
  fulfillment_status: string
  shops: { name: string; name_ur: string | null } | null
}
interface RideBooking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null; created_at: string
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function PortalMarketplacePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [orders, setOrders] = useState<ShopOrder[]>([])
  const [bookings, setBookings] = useState<RideBooking[]>([])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[] | null>(null)

  useEffect(() => {
    if (!user) return
    supabase.from('shop_orders').select('id, status, total_amount_pkr, rejected_reason, created_at, fulfillment_status, shops(name, name_ur)')
      .eq('portal_user_id', user.id).order('created_at', { ascending: false }).limit(10)
      .then(({ data }) => setOrders((data ?? []) as unknown as ShopOrder[]))
    supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, created_at, vehicle_routes(origin, origin_ur, destination, destination_ur)')
      .eq('portal_user_id', user.id).order('created_at', { ascending: false }).limit(10)
      .then(({ data }) => setBookings((data ?? []) as unknown as RideBooking[]))
  }, [user])

  const runSearch = async (q: string) => {
    setQuery(q)
    if (!q.trim()) { setResults(null); return }
    setSearching(true)
    const { data } = await supabase.rpc('search_marketplace_products', { p_query: q.trim() })
    setResults((data ?? []) as SearchResult[])
    setSearching(false)
  }

  const StatusPill = ({ status, reason }: { status: string; reason: string | null }) => {
    if (status === 'confirmed') return <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>
    if (status === 'rejected') return <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold" title={reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>
    return <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Store size={22} className="text-dp-secondary" /> {t('mp.pageTitle')} <PortalHelp pageKey="marketplace" /></h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('mp.pageSubtitle')}</p>
      </div>

      <div className="relative mb-6">
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input value={query} onChange={(e) => runSearch(e.target.value)} placeholder={t('mp.searchPlaceholder')} className="input-field !ps-9" />
      </div>

      {results !== null && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.searchResultsHeading')}</p>
          {searching && <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>}
          {!searching && results.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('mp.noResults')}</p>}
          <div className="space-y-2">
            {results.map((r) => (
              <Link key={`${r.shop_id}-${r.product_id}`} href={`/portal/marketplace/shop/${r.shop_id}`} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3 hover:border-dp-secondary transition-colors">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">
                    {isUrdu && r.product_name_ur ? r.product_name_ur : r.product_name}
                    {(isUrdu ? (r.flavor_ur || r.flavor) : r.flavor) && <span className="font-normal text-dp-on-surface-variant"> ({isUrdu ? (r.flavor_ur || r.flavor) : r.flavor})</span>}
                  </p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 truncate">{isUrdu && r.shop_name_ur ? r.shop_name_ur : r.shop_name}{!r.delivery_enabled && ` · ${t('mp.visitStoreNote')}`}</p>
                </div>
                <p className="font-sans text-[14px] font-bold text-dp-secondary shrink-0">{fmt(r.unit_price_pkr)}</p>
              </Link>
            ))}
          </div>
        </div>
      )}

      {(orders.length > 0 || bookings.length > 0) && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.myOrdersHeading')}</p>
          <div className="space-y-2">
            {orders.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{isUrdu && o.shops?.name_ur ? o.shops.name_ur : o.shops?.name ?? '—'}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(o.created_at).toLocaleDateString('en-GB')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{fmt(o.total_amount_pkr)}</p>
                  <StatusPill status={o.status} reason={o.rejected_reason} />
                  {o.fulfillment_status !== 'pending' && o.fulfillment_status !== 'cancelled' && (
                    <p className="font-sans text-[10.5px] font-semibold text-dp-on-surface-variant mt-0.5">{t(`of.status.${o.fulfillment_status}`)}</p>
                  )}
                </div>
              </div>
            ))}
            {bookings.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">
                    {b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—'}
                  </p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(b.travel_date).toLocaleDateString('en-GB')} · {b.seats} {t('mk.seatsLabel')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{fmt(b.total_amount_pkr)}</p>
                  <StatusPill status={b.status} reason={b.rejected_reason} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 mb-6">
        <Link href="/portal/marketplace/shops" className="flex items-center gap-3.5 bg-dp-secondary-container/60 border border-dp-secondary/25 rounded-xl p-5 hover:border-dp-secondary transition-colors">
          <div className="w-12 h-12 rounded-xl bg-white/50 flex items-center justify-center shrink-0"><Store size={22} className="text-dp-on-secondary-container" /></div>
          <div>
            <p className="font-heading text-[18px] font-bold text-dp-on-secondary-container">{t('mp.shopsPillarTitle')}</p>
            <p className="font-sans text-[12.5px] text-dp-on-secondary-container/80 mt-0.5">{t('mp.shopsPillarHint')}</p>
          </div>
        </Link>
        <Link href="/portal/marketplace/travel" className="flex items-center gap-3.5 bg-dp-primary rounded-xl p-5 hover:opacity-90 transition-opacity">
          <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center shrink-0"><MapPinIcon /></div>
          <div>
            <p className="font-heading text-[18px] font-bold text-white">{t('mp.travelPillarTitle')}</p>
            <p className="font-sans text-[12.5px] text-white/75 mt-0.5">{t('mp.travelPillarHint')}</p>
          </div>
        </Link>
      </div>

      <Link href="/portal/marketplace/negotiations" className="flex items-center gap-2.5 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
        <MessageCircle size={18} className="text-dp-secondary shrink-0" />
        <div>
          <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('vp.myConversationsTitle')}</p>
          <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('vp.conversationsCardHint')}</p>
        </div>
      </Link>
    </div>
  )
}

function MapPinIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}
