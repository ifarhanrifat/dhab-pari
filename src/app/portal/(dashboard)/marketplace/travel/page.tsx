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
import { Signpost, Home, Navigation, Truck, CalendarClock, Bus, MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_per_seat_pkr: number
}

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

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
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-5">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('vp.travelPageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vp.travelPageSubtitle')}</p>
      </div>

      {pins.length > 0
        ? <LeafletMap pins={pins} height={220} className="mb-5 rounded-lg" />
        : <div className="h-[220px] mb-5 rounded-lg bg-dp-surface-container flex items-center justify-center"><LoadingDots /></div>}

      <div className="space-y-2.5 mb-8">
        <Link href="/portal/marketplace/adda" className="flex items-center gap-2.5 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
          <div className="w-10 h-10 rounded-lg bg-dp-primary flex items-center justify-center shrink-0"><Signpost size={18} className="text-white" /></div>
          <div><p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('af.addaBoardPageTitle')}</p><p className="font-sans text-[12px] text-dp-on-surface-variant">{t('af.addaBoardCardHint')}</p></div>
        </Link>
        <Link href="/portal/marketplace/order-city" className="flex items-center gap-2.5 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
          <div className="w-10 h-10 rounded-lg bg-rose-600 flex items-center justify-center shrink-0"><Truck size={18} className="text-white" /></div>
          <div><p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('vp.dispatchPageTitle')}</p><p className="font-sans text-[12px] text-dp-on-surface-variant">{t('vp.orderCityCardHint')}</p></div>
        </Link>
        <Link href="/portal/marketplace/pro" className="flex items-center gap-2.5 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
          <div className="w-10 h-10 rounded-lg bg-sky-600 flex items-center justify-center shrink-0"><Truck size={18} className="text-white" /></div>
          <div><p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('vp.proPageTitle')}</p><p className="font-sans text-[12px] text-dp-on-surface-variant">{t('vp.proCardHint')}</p></div>
        </Link>
        <Link href="/portal/marketplace/commute" className="flex items-center gap-2.5 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
          <div className="w-10 h-10 rounded-lg bg-violet-600 flex items-center justify-center shrink-0"><CalendarClock size={18} className="text-white" /></div>
          <div><p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('vp.commutePageTitle')}</p><p className="font-sans text-[12px] text-dp-on-surface-variant">{t('vp.commuteCardHint')}</p></div>
        </Link>
        <Link href="/portal/marketplace/nearby" className="flex items-center gap-2.5 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
          <div className="w-10 h-10 rounded-lg bg-emerald-600 flex items-center justify-center shrink-0"><Home size={18} className="text-white" /></div>
          <div><p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('af.nearbyPageTitle')}</p><p className="font-sans text-[12px] text-dp-on-surface-variant">{t('af.nearbyCardHint')}</p></div>
        </Link>
        <Link href="/portal/marketplace/trips" className="flex items-center gap-2.5 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
          <div className="w-10 h-10 rounded-lg bg-dp-primary-container flex items-center justify-center shrink-0"><Navigation size={18} className="text-dp-primary" /></div>
          <div><p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('cm.tripsPageTitle')}</p><p className="font-sans text-[12px] text-dp-on-surface-variant">{t('cm.tripsCardHint')}</p></div>
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
