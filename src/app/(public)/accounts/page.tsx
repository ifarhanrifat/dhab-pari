'use client'

// Marketplace phase 5 — this route used to be a leftover early scaffold
// (a disconnected legacy transactions table next to a hardcoded fake
// "Cash Position" sidebar — neither wired to anything real). Replaced
// entirely: public search + browse for the community marketplace (shops,
// vehicle routes). Checkout itself needs a portal account (the RPCs are
// portal-authenticated, same as every other payment in this app), so a
// card here links to sign-in rather than a cart — browsing/comparison
// works for everyone, ordering is for signed-in villagers.
//
// Same site-wide "Accounts Display Language" convention /projects already
// uses (site_settings.display_language), not the portal's own per-user
// toggle — this page has no signed-in user to read a preference from.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Search, Store, Bus, MapPin, LogIn } from 'lucide-react'

type Lang = 'en' | 'ur'

const t = {
  heading: { en: 'Marketplace', ur: 'مارکیٹ پلیس' },
  subheading: { en: 'Order from local shops, or book a seat on a local ride.', ur: 'گاؤں کی دکانوں سے چیزیں منگوائیں، یا کسی گاڑی میں نشست بک کروائیں۔' },
  searchPlaceholder: { en: 'Search for a product...', ur: 'کوئی چیز تلاش کریں...' },
  searchResultsHeading: { en: 'Search results', ur: 'تلاش کے نتائج' },
  noResults: { en: 'Nothing matched that search.', ur: 'اس تلاش سے کچھ نہیں ملا۔' },
  visitStoreNote: { en: 'visit this store to buy', ur: 'خریدنے کے لیے دکان پر جائیں' },
  shopsHeading: { en: 'Shops', ur: 'دکانیں' },
  noShopsListed: { en: 'No shops listed yet.', ur: 'ابھی تک کوئی دکان شامل نہیں کی گئی۔' },
  routesHeading: { en: 'Vehicle Routes', ur: 'گاڑیوں کے روٹس' },
  noRoutesListed: { en: 'No routes listed yet.', ur: 'ابھی تک کوئی روٹ شامل نہیں کیا گیا۔' },
  deliveryEnabled: { en: 'Delivery', ur: 'ڈیلیوری' },
  pickupOnly: { en: 'Pickup only', ur: 'صرف دکان سے خریداری' },
  perSeat: { en: '/ seat', ur: '/ نشست' },
  signInToOrder: { en: 'Sign in to order or book', ur: 'آرڈر یا بکنگ کے لیے سائن ان کریں' },
  signInCta: { en: 'Sign In', ur: 'سائن ان کریں' },
  signInHint: {
    en: 'Buying and booking happen through your portal account — the same one you already use to pay a water bill or make a donation.',
    ur: 'خریداری اور بکنگ آپ کے پورٹل اکاؤنٹ سے ہوتی ہے — بالکل اسی طرح جیسے آپ پانی کا بل ادا کرتے ہیں یا عطیہ دیتے ہیں۔',
  },
}

interface Shop { id: string; name: string; name_ur: string | null; location: string | null; location_ur: string | null; delivery_enabled: boolean }
interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_per_seat_pkr: number
}
interface SearchResult {
  product_id: string; product_name: string; product_name_ur: string | null; flavor: string | null; flavor_ur: string | null; unit_price_pkr: number
  shop_id: string; shop_name: string; shop_name_ur: string | null; delivery_enabled: boolean
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MarketplaceLandingPage() {
  const [lang, setLang] = useState<Lang>('en')
  const isUrdu = lang === 'ur'
  const dt = (key: keyof typeof t) => t[key][lang]

  const [shops, setShops] = useState<Shop[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [routeVehicleNames, setRouteVehicleNames] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[] | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.from('site_settings').select('value').eq('key', 'display_language').maybeSingle().then(({ data }) => {
      if (data?.value === 'ur') setLang('ur')
    })
    supabase.from('shops').select('id, name, name_ur, location, location_ur, delivery_enabled').eq('status', 'active').order('name')
      .then(({ data }) => setShops(data ?? []))
    supabase.from('vehicle_routes').select('id, vehicle_id, origin, origin_ur, destination, destination_ur, fare_per_seat_pkr').eq('is_active', true).order('origin')
      .then(async ({ data }) => {
        setRoutes(data ?? [])
        if (data && data.length > 0) {
          const { data: vehicles } = await supabase.from('vehicles').select('id, owner_name').in('id', data.map((r) => r.vehicle_id))
          setRouteVehicleNames(Object.fromEntries((vehicles ?? []).map((v) => [v.id, v.owner_name])))
        }
      })
  }, [])

  const runSearch = async (q: string) => {
    setQuery(q)
    if (!q.trim()) { setResults(null); return }
    setSearching(true)
    const supabase = createClient()
    const { data } = await supabase.rpc('search_marketplace_products', { p_query: q.trim() })
    setResults((data ?? []) as SearchResult[])
    setSearching(false)
  }

  return (
    <div className="max-w-[1000px] mx-auto px-4 md:px-6 py-8" dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[30px] md:text-[34px] font-bold text-dp-primary section-title flex items-center gap-2.5">
          <Store size={26} className="text-dp-secondary" /> {dt('heading')}
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[15px] mt-1.5">{dt('subheading')}</p>
      </div>

      <div className="relative mb-6">
        <Search size={17} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input
          value={query} onChange={(e) => runSearch(e.target.value)} placeholder={dt('searchPlaceholder')}
          className="w-full ps-11 pe-4 py-3 rounded-lg border border-dp-outline-variant font-sans text-[15px] focus:outline-none focus:border-dp-secondary"
        />
      </div>

      <div className="bg-dp-secondary-container/40 border border-dp-secondary/20 rounded-lg p-4 flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-full bg-dp-secondary text-white flex items-center justify-center shrink-0"><LogIn size={18} /></div>
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[14px] font-bold text-dp-on-surface">{dt('signInToOrder')}</p>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{dt('signInHint')}</p>
        </div>
        <Link href="/portal/login" className="shrink-0 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">{dt('signInCta')}</Link>
      </div>

      {results !== null && (
        <div className="mb-8">
          <p className="font-sans text-[12.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{dt('searchResultsHeading')}</p>
          {searching && <p className="font-sans text-[14px] text-dp-on-surface-variant">…</p>}
          {!searching && results.length === 0 && <p className="font-sans text-[14px] text-dp-on-surface-variant">{dt('noResults')}</p>}
          <div className="space-y-2">
            {results.map((r) => (
              <div key={`${r.shop_id}-${r.product_id}`} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <div className="min-w-0">
                  <p className="font-sans text-[14px] font-semibold text-dp-on-surface truncate">
                    {isUrdu && r.product_name_ur ? r.product_name_ur : r.product_name}
                    {(isUrdu ? (r.flavor_ur || r.flavor) : r.flavor) && <span className="font-normal text-dp-on-surface-variant"> ({isUrdu ? (r.flavor_ur || r.flavor) : r.flavor})</span>}
                  </p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5 truncate">{isUrdu && r.shop_name_ur ? r.shop_name_ur : r.shop_name}{!r.delivery_enabled && ` · ${dt('visitStoreNote')}`}</p>
                </div>
                <p className="font-sans text-[15px] font-bold text-dp-secondary shrink-0">{fmt(r.unit_price_pkr)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-8">
        <p className="font-sans text-[12.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{dt('shopsHeading')}</p>
        {shops.length === 0 && <p className="font-sans text-[14px] text-dp-on-surface-variant">{dt('noShopsListed')}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {shops.map((s) => (
            <div key={s.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <p className="font-sans text-[15px] font-semibold text-dp-on-surface truncate">{isUrdu && s.name_ur ? s.name_ur : s.name}</p>
              {s.location && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1"><MapPin size={12} /> {isUrdu ? (s.location_ur || s.location) : s.location}</p>}
              <span className={`inline-block mt-2 text-[11px] font-bold px-2 py-0.5 rounded-full ${s.delivery_enabled ? 'bg-sky-100 text-sky-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                {s.delivery_enabled ? dt('deliveryEnabled') : dt('pickupOnly')}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="font-sans text-[12.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Bus size={14} /> {dt('routesHeading')}</p>
        {routes.length === 0 && <p className="font-sans text-[14px] text-dp-on-surface-variant">{dt('noRoutesListed')}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {routes.map((r) => (
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <p className="font-sans text-[15px] font-semibold text-dp-on-surface flex items-center gap-1.5"><MapPin size={14} className="text-dp-secondary shrink-0" /> {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">{routeVehicleNames[r.vehicle_id] ?? ''}</p>
              <p className="font-sans text-[15px] font-bold text-dp-secondary mt-1.5">{fmt(r.fare_per_seat_pkr)} <span className="font-normal text-dp-on-surface-variant text-[12.5px]">{dt('perSeat')}</span></p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
