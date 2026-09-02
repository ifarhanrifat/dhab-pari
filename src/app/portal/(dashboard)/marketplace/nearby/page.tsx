'use client'

// The public "nearby open trips" map — the actual feature behind "when a
// driver is heading home and shares his location, a rider looking for a
// ride should be able to see him live." Discovery only: tapping a pin's
// card proposes a fare via the same propose_trip_fare/respond_trip_fare_offer
// negotiation (migration 400) the rest of the return-trip flow already
// uses — nothing about that pipeline changes here.
//
// Kept as its own page rather than a tab on /portal/marketplace/trips —
// this screen asks for a location permission and runs a live poll loop
// the moment it opens; a rider who only wanted the trips list shouldn't
// be prompted for GPS access just for landing on the same page.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, LocateFixed, Phone, Loader2, Radio } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getCurrentPositionOnce, type LiveLocationPosition } from '@/hooks/useLiveLocation'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface NearbyTrip {
  trip_offer_id: string; vehicle_id: string; owner_name: string; owner_mobile: string | null
  vehicle_type: string; vehicle_number: string | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; seats_available: number; listed_fare_per_seat_pkr: number
  lat: number; lng: number; updated_at: string; distance_km: number | null
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function vehicleEmoji(vehicleType: string) {
  const t = vehicleType.toLowerCase()
  if (t.includes('rickshaw') || t.includes('riksha')) return '🛺'
  if (t.includes('bike') || t.includes('motor')) return '🏍️'
  return '🚐' // Suzuki-style van/wagon — the overwhelming majority of this marketplace's vehicles
}
function minutesAgo(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}

export default function NearbyOpenTripsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [destination, setDestination] = useState('')
  const [myPos, setMyPos] = useState<LiveLocationPosition | null>(null)
  const [locating, setLocating] = useState(false)
  const [trips, setTrips] = useState<NearbyTrip[]>([])
  const [loading, setLoading] = useState(true)
  const [seats, setSeats] = useState<Record<string, number>>({})
  const [fare, setFare] = useState<Record<string, number>>({})
  const [actionId, setActionId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    const { data, error } = await supabase.rpc('nearby_open_trips', {
      p_destination: destination.trim() || null, p_lat: myPos?.lat ?? null, p_lng: myPos?.lng ?? null, p_radius_km: 25,
    })
    if (!error) setTrips(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(load, 12000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, myPos])

  const useMyLocation = async () => {
    setLocating(true)
    try {
      const pos = await getCurrentPositionOnce()
      setMyPos(pos)
    } catch {
      toast.error(t('af.nearbyLocationFailed'))
    } finally {
      setLocating(false)
    }
  }

  const proposeFare = async (trip: NearbyTrip) => {
    const s = seats[trip.trip_offer_id] || 1
    const f = fare[trip.trip_offer_id]
    if (!f) { toast.error(t('af.enterFareFirst')); return }
    setActionId(trip.trip_offer_id)
    const { error } = await supabase.rpc('propose_trip_fare', { p_trip_offer_id: trip.trip_offer_id, p_seats_requested: s, p_proposed_fare_per_seat_pkr: f })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.fareProposedToast'))
  }

  const pins: MapPin[] = [
    ...(myPos ? [{ lat: myPos.lat, lng: myPos.lng, label: t('af.youPinLabel'), color: '#2563eb' }] : []),
    ...trips.map((tr) => ({
      lat: tr.lat, lng: tr.lng, color: '#16a34a', emoji: vehicleEmoji(tr.vehicle_type),
      label: `${tr.owner_name} — ${isUrdu && tr.destination_ur ? tr.destination_ur : tr.destination}`,
    })),
  ]

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/marketplace" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-1 flex items-center gap-2"><Radio size={20} /> {t('af.nearbyPageTitle')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('af.nearbyPageHint')}</p>

      <div className="flex items-center gap-2 mb-4">
        <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={t('mk.destinationPlaceholder')} className="input-field flex-1" />
        <button onClick={useMyLocation} disabled={locating} className="shrink-0 flex items-center gap-1.5 px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container disabled:opacity-50">
          {locating ? <Loader2 size={14} className="animate-spin" /> : <LocateFixed size={14} />} {t('af.useMyLocationBtn')}
        </button>
      </div>

      <LeafletMap pins={pins} height={260} className="mb-4" />

      {loading ? (
        <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('action.loading')}</p>
      ) : trips.length === 0 ? (
        <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('af.noNearbyTrips')}</p>
      ) : (
        <div className="space-y-2.5">
          {trips.map((tr) => (
            <div key={tr.trip_offer_id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-bold text-dp-on-surface truncate">{vehicleEmoji(tr.vehicle_type)} {tr.owner_name}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant truncate">{tr.vehicle_type}{tr.vehicle_number ? ` · ${tr.vehicle_number}` : ''} · {isUrdu && tr.origin_ur ? tr.origin_ur : tr.origin} → {isUrdu && tr.destination_ur ? tr.destination_ur : tr.destination}</p>
                </div>
                {tr.distance_km != null && <span className="shrink-0 font-sans text-[11.5px] font-bold text-dp-secondary ltr-num">{tr.distance_km} {t('af.kmAway')}</span>}
              </div>
              <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('af.updatedMinutesAgo').replace('{n}', String(minutesAgo(tr.updated_at)))} · {tr.seats_available} {t('mk.seatsLabel')} {t('af.stillFree')}</p>
              {tr.owner_mobile && <a href={`tel:${tr.owner_mobile}`} className="inline-flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary hover:underline mt-1 ltr-num" dir="ltr"><Phone size={11} /> {tr.owner_mobile}</a>}
              {tr.listed_fare_per_seat_pkr > 0 ? (
                // A fixed, system-set fare (an adda departure, most
                // likely already en route) is informational here — the
                // real seat booking happened at the adda board before it
                // left; this is "here's where he is / call to check",
                // not a live negotiation.
                <p className="font-sans text-[12.5px] font-semibold text-dp-secondary mt-2 pt-2 border-t border-dp-outline-variant/60">{t('af.fixedFareInfoLabel').replace('{amount}', fmt(tr.listed_fare_per_seat_pkr))}</p>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  <input type="number" min={1} max={tr.seats_available} value={seats[tr.trip_offer_id] ?? 1} onChange={(e) => setSeats((s) => ({ ...s, [tr.trip_offer_id]: +e.target.value }))} className="input-field !w-16 !py-1.5" />
                  <input type="number" value={fare[tr.trip_offer_id] ?? ''} onChange={(e) => setFare((s) => ({ ...s, [tr.trip_offer_id]: +e.target.value }))} placeholder={t('cm.counterPlaceholder')} className="input-field !w-24 !py-1.5" />
                  <button onClick={() => proposeFare(tr)} disabled={actionId === tr.trip_offer_id} className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('af.proposeFareBtn')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
