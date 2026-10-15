'use client'

// Results screen of the new design (v.rResults) — reached from the Home
// screen's "Find vehicles" with the picked destination city as a query
// param. Real data per card, not the design's own toy pricing formulas:
//
// - Adda: a real vehicle_routes row to this city, if one exists.
// - Shared ride: no ad-hoc "any ride to city X" query exists in this
//   app today — my_commuter_matches() only returns matches for a rider's
//   OWN already-set-up commuter schedule (424), so this card links to
//   set one up rather than fabricating live matches it can't produce.
// - Car rental: the real negotiated-price dispatch flow (order-city).

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Bus, Users, Car } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface Route {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_per_seat_pkr: number; vehicle_id: string
}

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function ResultsPage() {
  return (
    <Suspense fallback={<div className="text-center py-12"><LoadingDots /></div>}>
      <ResultsPageInner />
    </Suspense>
  )
}

function ResultsPageInner() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const searchParams = useSearchParams()
  const toId = searchParams.get('to')
  const fromLat = searchParams.get('from_lat')
  const fromLng = searchParams.get('from_lng')
  const fromName = searchParams.get('from_name')

  const [city, setCity] = useState<City | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!toId) { setLoading(false); return }
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('id', toId).maybeSingle().then(async ({ data: c }) => {
      setCity(c)
      if (c) {
        const { data } = await supabase.from('vehicle_routes')
          .select('id, origin, origin_ur, destination, destination_ur, fare_per_seat_pkr, vehicle_id')
          .eq('is_active', true).ilike('destination', `%${c.name}%`)
        setRoutes(data ?? [])
        if (data && data.length > 0) {
          const { data: vehicles } = await supabase.from('vehicles').select('id, owner_name').in('id', data.map((r) => r.vehicle_id))
          setOwnerNames(Object.fromEntries((vehicles ?? []).map((v) => [v.id, v.owner_name])))
        }
      }
      setLoading(false)
    })
  }, [toId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <Link href="/portal/marketplace/travel" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#005A36]">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mb.navHome')}
      </Link>

      {!city ? (
        <p className="text-center py-10 text-[#64748b] text-[14px]">{t('mb.noDestinationYet')}</p>
      ) : (
        <>
          <div>
            <p className="font-bold text-[18px] text-[#005A36]">{isUrdu && city.name_ur ? city.name_ur : city.name}</p>
            <p className="text-[12px] text-[#64748b]">{t('mb.resultsHeading')}</p>
          </div>

          {(() => {
            const pins: LeafletPin[] = []
            if (fromLat && fromLng) pins.push({ lat: Number(fromLat), lng: Number(fromLng), label: fromName ?? undefined, color: '#005A36' })
            if (city.lat != null && city.lng != null) pins.push({ lat: city.lat, lng: city.lng, label: isUrdu && city.name_ur ? city.name_ur : city.name, color: '#D4AF37' })
            return pins.length > 0 ? <LeafletMap pins={pins} height={190} className="rounded-2xl" /> : null
          })()}

          <div className="bg-[#005A36] rounded-2xl p-3 flex flex-col gap-1">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-white/75">{t('mb.pricesAreEstimates')}</p>
          </div>

          {routes.map((r) => (
            <Link key={r.id} href={`/portal/marketplace/route/${r.id}`} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3">
              <span className="shrink-0 w-9 h-9 rounded-xl bg-[#dcfce7] flex items-center justify-center text-[15px]"><Bus size={17} className="text-[#166534]" /></span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[13px] font-bold text-[#1e293b]">{isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#dcfce7] text-[#166534]">{t('mb.fixedFareLabel')}</span>
                </div>
                <p className="text-[11px] text-[#64748b] mt-0.5">{ownerNames[r.vehicle_id] ?? ''}</p>
              </div>
              <div className="shrink-0 text-end">
                <p className="font-extrabold text-[14px] text-[#005A36]">{fmt(r.fare_per_seat_pkr)}</p>
                <p className="text-[9px] text-[#64748b]">{t('mk.perSeat')}</p>
              </div>
            </Link>
          ))}

          <Link href="/portal/marketplace/commute" className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3">
            <span className="shrink-0 w-9 h-9 rounded-xl bg-[#e0f2fe] flex items-center justify-center"><Users size={17} className="text-[#0369a1]" /></span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-[#1e293b]">{t('vp.commutePageTitle')}</p>
              <p className="text-[11px] text-[#64748b] mt-0.5">{t('vp.commuteCardHint')}</p>
            </div>
          </Link>

          <Link href="/portal/marketplace/order-city" className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3">
            <span className="shrink-0 w-9 h-9 rounded-xl bg-[#f3e8ff] flex items-center justify-center"><Car size={17} className="text-[#6d28d9]" /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[13px] font-bold text-[#1e293b]">{t('vp.dispatchPageTitle')}</p>
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#f3e8ff] text-[#6d28d9]">{t('mb.negotiableTag')}</span>
              </div>
              <p className="text-[11px] text-[#64748b] mt-0.5">{t('vp.orderCityCardHint')}</p>
            </div>
          </Link>

          {routes.length === 0 && (
            <p className="text-center py-6 text-[#94a3b8] text-[13px]">{t('mp.noRoutesListed')}</p>
          )}
        </>
      )}
    </div>
  )
}
