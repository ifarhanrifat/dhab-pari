'use client'

// Marketplace phase 4 — portal catalog: search across every shop's
// products, browse shops and vehicle routes, and see the status of your
// own orders/bookings. Checkout itself (cart, seat picker) lives on the
// shop/route detail pages this links into — this page is discovery + "what
// did I already order/book".

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Search, Store, Bus, MapPin, Clock, CheckCircle2, XCircle, Navigation, Signpost, Home } from 'lucide-react'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop { id: string; name: string; name_ur: string | null; location: string | null; location_ur: string | null; delivery_enabled: boolean }
interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_per_seat_pkr: number
}
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

  const [shops, setShops] = useState<Shop[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [routeVehicleNames, setRouteVehicleNames] = useState<Record<string, string>>({})
  const [orders, setOrders] = useState<ShopOrder[]>([])
  const [bookings, setBookings] = useState<RideBooking[]>([])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[] | null>(null)

  useEffect(() => {
    supabase.from('shops').select('id, name, name_ur, location, location_ur, delivery_enabled').eq('status', 'active').order('name')
      .then(({ data }) => setShops(data ?? []))
    supabase.from('vehicle_routes').select('id, vehicle_id, origin, origin_ur, destination, destination_ur, classification, fare_per_seat_pkr').eq('is_active', true).order('origin')
      .then(async ({ data }) => {
        setRoutes(data ?? [])
        if (data && data.length > 0) {
          const { data: vehicles } = await supabase.from('vehicles').select('id, owner_name').in('id', data.map((r) => r.vehicle_id))
          setRouteVehicleNames(Object.fromEntries((vehicles ?? []).map((v) => [v.id, v.owner_name])))
        }
      })
  }, [])

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

      <div className="mb-8">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.shopsHeading')}</p>
        {shops.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('mp.noShopsListed')}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {shops.map((s) => (
            <Link key={s.id} href={`/portal/marketplace/shop/${s.id}`} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
              <p className="font-sans text-[14px] font-semibold text-dp-on-surface truncate">{isUrdu && s.name_ur ? s.name_ur : s.name}</p>
              {s.location && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1"><MapPin size={11} /> {isUrdu ? (s.location_ur || s.location) : s.location}</p>}
              <span className={`inline-block mt-2 text-[10.5px] font-bold px-2 py-0.5 rounded-full ${s.delivery_enabled ? 'bg-sky-100 text-sky-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                {s.delivery_enabled ? t('mk.deliveryEnabled') : t('mk.pickupOnly')}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
        <Link href="/portal/marketplace/adda" className="flex items-center gap-2.5 bg-dp-secondary-container/40 border border-dp-secondary/20 rounded-lg p-4 hover:border-dp-secondary transition-colors">
          <Signpost size={18} className="text-dp-secondary shrink-0" />
          <div>
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('af.addaBoardPageTitle')}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('af.addaBoardCardHint')}</p>
          </div>
        </Link>
        <Link href="/portal/marketplace/nearby" className="flex items-center gap-2.5 bg-emerald-50 border border-emerald-200 rounded-lg p-4 hover:border-emerald-400 transition-colors">
          <Home size={18} className="text-emerald-700 shrink-0" />
          <div>
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('af.nearbyPageTitle')}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('af.nearbyCardHint')}</p>
          </div>
        </Link>
        <Link href="/portal/marketplace/trips" className="flex items-center gap-2.5 bg-dp-primary-container/40 border border-dp-primary/20 rounded-lg p-4 hover:border-dp-primary transition-colors">
          <Navigation size={18} className="text-dp-primary shrink-0" />
          <div>
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('cm.tripsPageTitle')}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('cm.tripsCardHint')}</p>
          </div>
        </Link>
      </div>

      <div>
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Bus size={13} /> {t('mp.routesHeading')}</p>
        {routes.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('mp.noRoutesListed')}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {routes.map((r) => (
            <Link key={r.id} href={`/portal/marketplace/route/${r.id}`} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
              <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5"><MapPin size={13} className="text-dp-secondary shrink-0" /> {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{routeVehicleNames[r.vehicle_id] ?? ''}</p>
              <p className="font-sans text-[14px] font-bold text-dp-secondary mt-1.5">{fmt(r.fare_per_seat_pkr)} <span className="font-normal text-dp-on-surface-variant text-[11.5px]">{t('mk.perSeat')}</span></p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
