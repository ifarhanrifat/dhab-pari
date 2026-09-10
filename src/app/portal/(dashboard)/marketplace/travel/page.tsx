'use client'

// Travel pillar — the map the original design spec called for (its own
// build doc flagged it "still to build: Leaflet + OSM"), now actually
// wired in with the real map component and real pins already built and
// proven elsewhere in this codebase (LeafletMap + the adda/nearby live-
// location system) rather than a styled placeholder. Village origin pin
// is the real, committee-set Dhab Pari Chowk adda location; city pins are
// cities.lat/lng (431) — purely for orientation, not used in any fare
// math (that stays tier-based, see migration 430).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Bus, MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarketplaceBottomNav } from '@/components/portal/MarketplaceBottomNav'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_per_seat_pkr: number
}

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

// Per the v2 design audit: nine verticals used to sit here as identical
// tiles with no signal of which ones are negotiable. A rider now sees
// this before tapping anything — fixed (green), formula (slate), or a
// real back-and-forth (amber, same "pending/effort" amber already used
// throughout this app for anything mid-negotiation).
type PriceModel = 'fixed' | 'formula' | 'negotiated'
const PRICE_TAG: Record<PriceModel, { label: string; bg: string; fg: string; accent: string }> = {
  fixed: { label: 'مقررہ', bg: '#e9f7ef', fg: '#0f7a4d', accent: '#0f7a4d' },
  formula: { label: 'فارمولا', bg: '#eef1f5', fg: '#3f4c5c', accent: '#201e1d' },
  negotiated: { label: 'سودا', bg: '#fdf0e2', fg: '#9a5714', accent: '#ec3013' },
}
function PriceTag({ model }: { model: PriceModel }) {
  const p = PRICE_TAG[model]
  return <span className="shrink-0 font-sans text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: p.bg, color: p.fg }}>{p.label}</span>
}
// Left accent bar + no icon box — the design's own travel-hub card
// shape (a colored border reading the price model at a glance), not
// the rainbow icon-box list this page used to be.
function TravelTile({ href, model, title, subtitle }: { href: string; model: PriceModel; title: string; subtitle: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 bg-white border border-dp-outline-variant rounded-lg overflow-hidden hover:border-dp-secondary transition-colors" style={{ borderInlineStartWidth: 4, borderInlineStartColor: PRICE_TAG[model].accent }}>
      <div className="flex-1 min-w-0 py-3 ps-3.5 pe-2">
        <p className="font-sans text-[14px] font-bold text-dp-on-surface">{title}</p>
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{subtitle}</p>
      </div>
      <div className="pe-3.5 shrink-0"><PriceTag model={model} /></div>
    </Link>
  )
}

export default function MarketplaceTravelPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [cities, setCities] = useState<City[]>([])
  const [origin, setOrigin] = useState<{ lat: number; lng: number; name: string } | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [routeVehicleNames, setRouteVehicleNames] = useState<Record<string, string>>({})

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
    supabase.from('addas').select('name, name_ur, lat, lng').eq('id', '00000000-0000-0000-0000-00000000ad01').maybeSingle()
      .then(({ data }) => { if (data?.lat && data?.lng) setOrigin({ lat: data.lat, lng: data.lng, name: isUrdu && data.name_ur ? data.name_ur : data.name }) })
    supabase.from('vehicle_routes').select('id, vehicle_id, origin, origin_ur, destination, destination_ur, classification, fare_per_seat_pkr').eq('is_active', true).order('origin')
      .then(async ({ data }) => {
        setRoutes(data ?? [])
        if (data && data.length > 0) {
          const { data: vehicles } = await supabase.from('vehicles').select('id, owner_name').in('id', data.map((r) => r.vehicle_id))
          setRouteVehicleNames(Object.fromEntries((vehicles ?? []).map((v) => [v.id, v.owner_name])))
        }
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pins: LeafletPin[] = []
  if (origin) pins.push({ lat: origin.lat, lng: origin.lng, label: origin.name, color: '#00372c' })
  for (const c of cities) {
    if (c.lat != null && c.lng != null) pins.push({ lat: c.lat, lng: c.lng, label: isUrdu && c.name_ur ? c.name_ur : c.name, color: '#006c4e' })
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <div className="mb-5">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('vp.travelPageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vp.travelPageSubtitle')}</p>
      </div>

      {pins.length > 0
        ? <LeafletMap pins={pins} height={220} className="mb-5 rounded-lg" />
        : <div className="h-[220px] mb-5 rounded-lg bg-dp-surface-container flex items-center justify-center"><LoadingDots /></div>}

      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vp.everyWayHeading')}</p>
      <div className="space-y-2 mb-4">
        <TravelTile href="/portal/marketplace/adda" model="fixed" title={t('af.addaBoardPageTitle')} subtitle={t('af.addaBoardCardHint')} />
        <a href="#routes" className="flex items-center gap-3 bg-white border border-dp-outline-variant rounded-lg overflow-hidden hover:border-dp-secondary transition-colors" style={{ borderInlineStartWidth: 4, borderInlineStartColor: PRICE_TAG.fixed.accent }}>
          <div className="flex-1 min-w-0 py-3 ps-3.5 pe-2">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('mp.routesHeading')}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('vp.fixedRouteCardHint')}</p>
          </div>
          <div className="pe-3.5 shrink-0"><PriceTag model="fixed" /></div>
        </a>
        <TravelTile href="/portal/marketplace/order-city" model="negotiated" title={t('vp.dispatchPageTitle')} subtitle={t('vp.orderCityCardHint')} />
        <TravelTile href="/portal/marketplace/city-purchase" model="negotiated" title={t('vp.cityPurchasePageTitle')} subtitle={t('vp.cityPurchaseCardHint')} />
        <TravelTile href="/portal/marketplace/pro" model="formula" title={t('vp.proPageTitle')} subtitle={t('vp.proCardHint')} />
        <TravelTile href="/portal/marketplace/commute" model="negotiated" title={t('vp.commutePageTitle')} subtitle={t('vp.commuteCardHint')} />
        <TravelTile href="/portal/marketplace/trips" model="negotiated" title={t('cm.tripsPageTitle')} subtitle={t('cm.tripsCardHint')} />
        <TravelTile href="/portal/marketplace/hourly" model="formula" title={t('vp.hourlyPageTitle')} subtitle={t('vp.hourlyPageSubtitle')} />
        <TravelTile href="/portal/marketplace/shadi" model="fixed" title={t('vp.shadiPageTitle')} subtitle={t('vp.shadiPageSubtitle')} />
        <Link href="/portal/marketplace/nearby" className="flex items-center gap-3 bg-white border border-dp-outline-variant rounded-lg overflow-hidden hover:border-dp-secondary transition-colors" style={{ borderInlineStartWidth: 4, borderInlineStartColor: '#bfc9c4' }}>
          <div className="flex-1 min-w-0 py-3 ps-3.5 pe-2">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('af.nearbyPageTitle')}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('af.nearbyCardHint')}</p>
          </div>
        </Link>
      </div>

      <div className="bg-dp-surface-container/60 border border-dashed border-dp-outline-variant rounded-lg p-3 mb-8">
        <p className="font-sans text-[11px] text-dp-on-surface-variant leading-[1.7]">{t('vp.priceLegendNote')}</p>
      </div>

      <div id="routes">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Bus size={13} /> {t('mp.routesHeading')}</p>
        {routes.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('mp.noRoutesListed')}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {routes.map((r) => (
            <Link key={r.id} href={`/portal/marketplace/route/${r.id}`} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5 min-w-0"><MapPin size={13} className="text-dp-secondary shrink-0" /> {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
                <PriceTag model="fixed" />
              </div>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{routeVehicleNames[r.vehicle_id] ?? ''}</p>
              <p className="font-sans text-[14px] font-bold text-dp-secondary mt-1.5">{fmt(r.fare_per_seat_pkr)} <span className="font-normal text-dp-on-surface-variant text-[11.5px]">{t('mk.perSeat')}</span></p>
            </Link>
          ))}
        </div>
      </div>
      <MarketplaceBottomNav />
    </div>
  )
}
