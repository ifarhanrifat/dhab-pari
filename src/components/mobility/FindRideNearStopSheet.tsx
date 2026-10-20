'use client'

// "Any passenger searching toward a stop — whether the driver set an
// explicit stop there or not — should see every vehicle whose route
// actually passes near it, with timing, and a fully-booked vehicle
// should never even appear in the list." Matches on proximity to each
// route's own real road path (find_routes_near_point, migration 720),
// not on driver-confirmed stops, so a rider can discover a route that
// passes their village even before anyone's ever named that exact spot.

import { useState } from 'react'
import Link from 'next/link'
import { MapPin, Users2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { estimateArrivalTime } from '@/lib/roadRoute'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface RouteMatch {
  route_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  owner_name: string; vehicle_type: string; fare_mode: string; fare_per_seat_pkr: number; total_fare_pkr: number | null
  departure_time: string | null; route_path: { lat: number; lng: number }[]; route_duration_min: number | null
  next_date: string; seats_available: number; distance_to_point_km: number
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function FindRideNearStopSheet({ onClose }: { onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [point, setPoint] = useState<PickedLocation | null>(null)
  const [results, setResults] = useState<RouteMatch[] | null>(null)
  const [loading, setLoading] = useState(false)

  const search = async (loc: PickedLocation) => {
    setPoint(loc)
    setLoading(true)
    const { data } = await supabase.rpc('find_routes_near_point', { p_lat: loc.lat, p_lng: loc.lng, p_max_km: 2 })
    setResults((data as RouteMatch[] | null) ?? [])
    setLoading(false)
  }

  return (
    <MobilityBottomSheet title={t('mv.findRideNearMeBtn')} onClose={onClose}>
      {!point ? (
        <LocationPickerSheet title={t('mv.findRideNearMeBtn')} inline onClose={onClose} onConfirm={search} />
      ) : loading ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <button onClick={() => { setPoint(null); setResults(null) }} className="flex items-center gap-1.5 font-sans text-[12px] font-semibold text-[#166534] cursor-pointer w-fit">
            <MapPin size={13} /> {point.label}
          </button>
          {results && results.length === 0 && (
            <p className="text-center font-sans text-[13px] text-[#64748b] py-6">{t('mv.noRoutesNearPoint')}</p>
          )}
          {results?.map((r) => {
            const eta = estimateArrivalTime(r.route_path, r.route_duration_min, r.departure_time, point)
            return (
              <Link key={r.route_id} href={`/portal/marketplace/route/${r.route_id}`} className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex flex-col gap-1">
                <p className="font-sans text-[13px] font-semibold text-[#1e293b]">{isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
                <p className="font-sans text-[11.5px] text-[#64748b] flex items-center gap-1"><Users2 size={11} /> {r.owner_name} · {r.vehicle_type}</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="font-sans text-[11px] text-[#64748b] ltr-num">{eta ? `${t('mp.approxTimePrefix')} ${eta}` : ''} {r.next_date === new Date().toISOString().slice(0, 10) ? '' : `· ${r.next_date}`}</span>
                  <span className="font-sans text-[12px] font-bold text-[#166534] ltr-num">{fmt(r.fare_mode === 'flex' ? (r.total_fare_pkr ?? 0) : r.fare_per_seat_pkr)}</span>
                </div>
                <p className="font-sans text-[10.5px] font-semibold text-emerald-700 ltr-num">{r.seats_available} {t('mv.seatsLeftSuffix')}</p>
              </Link>
            )
          })}
        </div>
      )}
    </MobilityBottomSheet>
  )
}
