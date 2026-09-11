'use client'

// Post Trip + My Trip Offers + Trip Bookings — its own screen, matching
// the design zip (previously embedded on the driver dashboard).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { MapPin, PlusCircle, X, Navigation, CheckCircle2, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { TripLiveShareToggle } from '@/components/portal/TripLiveShareToggle'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { TrustPill, type Trust } from '@/components/shared/TrustBadge'
import { FareBandPicker, type FareBand } from '@/components/shared/FareBandPicker'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface TripOffer {
  id: string; trip_type: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; seats_available: number; listed_fare_per_seat_pkr: number; status: string
  share_live_location: boolean; distance_km: number | null
}
interface FareOffer {
  id: string; trip_offer_id: string; seats_requested: number; proposed_fare_per_seat_pkr: number
  counter_fare_per_seat_pkr: number | null; status: string; portal_user_id: string; portal_users: { full_name: string; mobile: string } | null
}
interface TripBooking {
  id: string; seats: number; agreed_fare_per_seat_pkr: number; total_amount_pkr: number; status: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; travel_date: string } | null
}
const emptyTripOffer = {
  trip_type: 'oneway' as string, origin: '', origin_ur: '', destination: '', destination_ur: '', classification: 'intercity',
  travel_date: '', departure_time_estimate: '', seats_available: 1, listed_fare_per_seat_pkr: 0, distance_km: '' as string,
  dest_lat: null as number | null, dest_lng: null as number | null,
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleTripsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<{ id: string; is_online: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [rideEligible, setRideEligible] = useState(true)

  const [tripOffers, setTripOffers] = useState<TripOffer[]>([])
  const [fareOffersByTrip, setFareOffersByTrip] = useState<Record<string, FareOffer[]>>({})
  const [tripBookings, setTripBookings] = useState<TripBooking[]>([])
  const [showPostTrip, setShowPostTrip] = useState(false)
  const [tripForm, setTripForm] = useState(emptyTripOffer)
  const [posting, setPosting] = useState(false)
  const [counterAmount, setCounterAmount] = useState<Record<string, number>>({})
  const [bandByTrip, setBandByTrip] = useState<Record<string, FareBand>>({})
  const [trustByFareOffer, setTrustByFareOffer] = useState<Record<string, Trust>>({})
  const [actionId, setActionId] = useState<string | null>(null)

  const reload = async (vehicleId: string) => {
    const [{ data: trips }, { data: tripB }] = await Promise.all([
      supabase.from('vehicle_trip_offers').select('*').eq('vehicle_id', vehicleId).order('created_at', { ascending: false }),
      supabase.from('vehicle_trip_bookings').select('id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, status, vehicle_trip_offers(origin, origin_ur, destination, destination_ur, travel_date)')
        .eq('vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(20),
    ])
    setTripOffers(trips ?? [])
    setTripBookings((tripB ?? []) as unknown as TripBooking[])

    if (trips && trips.length > 0) {
      const { data: fareOffers } = await supabase.from('vehicle_trip_fare_offers')
        .select('id, trip_offer_id, seats_requested, proposed_fare_per_seat_pkr, counter_fare_per_seat_pkr, status, portal_user_id, portal_users(full_name, mobile)')
        .in('trip_offer_id', trips.map((tr) => tr.id)).in('status', ['pending', 'countered']).order('created_at', { ascending: false })
      const grouped: Record<string, FareOffer[]> = {}
      for (const fo of (fareOffers ?? []) as unknown as FareOffer[]) {
        grouped[fo.trip_offer_id] = [...(grouped[fo.trip_offer_id] ?? []), fo]
      }
      setFareOffersByTrip(grouped)
    } else setFareOffersByTrip({})
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, is_online').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) {
        await reload(data.id)
        const [{ data: sc }, { data: offers }] = await Promise.all([
          supabase.from('service_classes').select('id, ride_eligible').eq('is_active', true),
          supabase.from('vehicle_service_offers').select('service_class_id').eq('vehicle_id', data.id).eq('is_active', true),
        ])
        const mine = new Set((offers ?? []).map((o) => o.service_class_id))
        const myClasses = (sc ?? []).filter((c) => mine.has(c.id))
        setRideEligible(myClasses.length === 0 || myClasses.some((c) => c.ride_eligible))
      }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const withDistance = tripOffers.filter((o) => o.distance_km != null && !(o.id in bandByTrip))
    if (withDistance.length === 0) return
    Promise.all(withDistance.map((o) => supabase.rpc('fare_band_for', { p_flow: 'trip_share', p_km: o.distance_km }).then(({ data }) => [o.id, data] as const)))
      .then((pairs) => setBandByTrip((prev) => ({ ...prev, ...Object.fromEntries(pairs) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripOffers])

  useEffect(() => {
    const allOffers = Object.values(fareOffersByTrip).flat()
    const uncached = [...new Set(allOffers.map((fo) => fo.portal_user_id))].filter((id) => id && !(id in trustByFareOffer))
    if (uncached.length === 0) return
    Promise.all(uncached.map((id) => supabase.rpc('portal_user_trust', { p_portal_user_id: id }).then(({ data }) => [id, data] as const)))
      .then((pairs) => setTrustByFareOffer((prev) => ({ ...prev, ...Object.fromEntries(pairs) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fareOffersByTrip])

  const cancelTripOffer = async (tripOfferId: string) => {
    if (!window.confirm(t('cm.confirmCancelTrip'))) return
    setActionId(tripOfferId)
    const { error } = await supabase.rpc('close_trip_offer', { p_trip_offer_id: tripOfferId })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setTripOffers((rows) => rows.map((r) => r.id === tripOfferId ? { ...r, status: 'closed' } : r))
  }

  const postTripOffer = async () => {
    if (!vehicle || !tripForm.origin.trim() || !tripForm.destination.trim() || !tripForm.travel_date) { toast.error(t('mk.nameRequired')); return }
    setPosting(true)
    const { error } = await supabase.rpc('place_trip_offer', {
      p_vehicle_id: vehicle.id, p_trip_type: tripForm.trip_type, p_origin: tripForm.origin, p_origin_ur: tripForm.origin_ur || null,
      p_destination: tripForm.destination, p_destination_ur: tripForm.destination_ur || null,
      p_classification: tripForm.classification, p_travel_date: tripForm.travel_date,
      p_departure_time_estimate: tripForm.departure_time_estimate || null,
      p_seats_available: tripForm.seats_available, p_listed_fare_per_seat_pkr: tripForm.listed_fare_per_seat_pkr,
      p_distance_km: tripForm.distance_km ? Number(tripForm.distance_km) : null,
      p_dest_lat: tripForm.dest_lat, p_dest_lng: tripForm.dest_lng,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cm.tripPostedToast'))
    setShowPostTrip(false)
    setTripForm(emptyTripOffer)
    reload(vehicle.id)
  }

  const respondFare = async (fareOfferId: string, action: 'accept' | 'reject' | 'counter') => {
    if (!vehicle) return
    setActionId(fareOfferId)
    const { error } = await supabase.rpc('respond_trip_fare_offer', {
      p_fare_offer_id: fareOfferId, p_action: action, p_counter_fare_per_seat_pkr: action === 'counter' ? counterAmount[fareOfferId] ?? null : null,
    })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(action === 'accept' ? t('cm.fareAcceptedToast') : action === 'counter' ? t('cm.fareCounteredToast') : t('cm.fareRejectedToast'))
    reload(vehicle.id)
  }

  const completeTripBooking = async (id: string) => {
    if (!vehicle) return
    setActionId(id)
    const { error } = await supabase.rpc('complete_trip_booking', { p_trip_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cm.tripCompletedToast'))
    reload(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicle) return null

  return (
    <div>
      <button
        onClick={() => {
          if (!rideEligible) { toast.error(t('vp.rideNotAllowedMessage')); return }
          if (!vehicle.is_online) { toast.error(t('vp.goOnlineToPostTripHint')); return }
          setShowPostTrip(true)
        }}
        className="flex items-center gap-1.5 px-3.5 py-2.5 mb-6 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
        <PlusCircle size={14} /> {t('cm.postTripBtn')}
      </button>

      {tripOffers.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.myTripOffersHeading')}</p>
          <div className="space-y-3">
            {tripOffers.map((tr) => (
              <div key={tr.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate flex items-center gap-1"><MapPin size={12} className="shrink-0 text-dp-secondary" /> {isUrdu && tr.origin_ur ? tr.origin_ur : tr.origin} → {isUrdu && tr.destination_ur ? tr.destination_ur : tr.destination}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(tr.travel_date).toLocaleDateString('en-GB')} · {tr.seats_available} {t('mk.seatsLabel')} · {fmt(tr.listed_fare_per_seat_pkr)} {t('mk.perSeat')}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tr.trip_type === 'return' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>{tr.trip_type === 'return' ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}</span>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tr.status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>{tr.status === 'open' ? t('mk.active') : t('mk.inactive')}</span>
                  </div>
                </div>
                {(fareOffersByTrip[tr.id] ?? []).map((fo) => (
                  <div key={fo.id} className="mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                    <p className="font-sans text-[12.5px] text-dp-on-surface flex items-center gap-1.5 flex-wrap">
                      {fo.portal_users?.full_name ?? '—'} {trustByFareOffer[fo.portal_user_id] && <TrustPill trust={trustByFareOffer[fo.portal_user_id]} />} — <span className="font-bold text-dp-secondary">{fmt(fo.proposed_fare_per_seat_pkr)}</span>/{t('mk.seatsLabel')} × <span className="ltr-num">{fo.seats_requested}</span>
                      {fo.status === 'countered' && <span className="text-amber-700 font-semibold"> ({t('cm.youCountered')} {fmt(fo.counter_fare_per_seat_pkr ?? 0)})</span>}
                    </p>
                    {fo.status === 'pending' && bandByTrip[tr.id] && (
                      <FareBandPicker band={bandByTrip[tr.id]} value={counterAmount[fo.id] ?? ''} onChange={(v) => setCounterAmount({ ...counterAmount, [fo.id]: v })} ownerLabel={t('cm.yourCounterLabel')} />
                    )}
                    {fo.status === 'pending' && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <button onClick={() => respondFare(fo.id, 'reject')} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                        <input type="number" value={counterAmount[fo.id] ?? ''} onChange={(e) => setCounterAmount({ ...counterAmount, [fo.id]: +e.target.value })} placeholder={t('cm.counterPlaceholder')} className="input-field w-24 !py-1.5 !text-[12px]" />
                        <button onClick={() => respondFare(fo.id, 'counter')} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container disabled:opacity-50">{t('cm.counterBtn')}</button>
                        <button onClick={() => respondFare(fo.id, 'accept')} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.acceptBtn')}</button>
                      </div>
                    )}
                  </div>
                ))}
                {tr.status === 'open' && (
                  <>
                    <TripLiveShareToggle
                      tripOfferId={tr.id}
                      sharing={tr.share_live_location}
                      onSharingChange={(on) => setTripOffers((rows) => rows.map((r) => r.id === tr.id ? { ...r, share_live_location: on } : r))}
                    />
                    <button onClick={() => cancelTripOffer(tr.id)} disabled={actionId === tr.id} className="flex items-center gap-1 font-sans text-[11.5px] font-semibold mt-2 pt-2 border-t border-dp-outline-variant cursor-pointer disabled:opacity-50" style={{ color: '#b3261e' }}>
                      <Ban size={12} /> {t('cm.cancelTripBtn')}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tripBookings.length > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.tripBookingsHeading')}</p>
          <div className="space-y-2">
            {tripBookings.map((tb) => (
              <div key={tb.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{tb.vehicle_trip_offers ? `${isUrdu && tb.vehicle_trip_offers.origin_ur ? tb.vehicle_trip_offers.origin_ur : tb.vehicle_trip_offers.origin} → ${isUrdu && tb.vehicle_trip_offers.destination_ur ? tb.vehicle_trip_offers.destination_ur : tb.vehicle_trip_offers.destination}` : '—'}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{tb.vehicle_trip_offers && new Date(tb.vehicle_trip_offers.travel_date).toLocaleDateString('en-GB')} · {tb.seats} {t('mk.seatsLabel')}</p>
                  </div>
                  <p className="font-sans text-[14px] font-bold text-dp-secondary shrink-0">{fmt(tb.total_amount_pkr)}</p>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  {tb.status === 'completed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('cm.tripCompletedStatus')}</span>}
                  {tb.status === 'confirmed' && (
                    <>
                      <Link href={`/portal/marketplace/trip/${tb.id}`} className="inline-flex items-center gap-1 text-dp-secondary text-[12px] font-semibold hover:underline"><Navigation size={12} /> {t('cm.trackLocationBtn')}</Link>
                      <button onClick={() => completeTripBooking(tb.id)} disabled={actionId === tb.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.markTripCompleteBtn')}</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPostTrip && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowPostTrip(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('cm.postTripBtn')}</h2>
              <button onClick={() => setShowPostTrip(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('cm.postTripHint')}</p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setTripForm({ ...tripForm, trip_type: 'oneway' })}
                  className={`py-2.5 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${tripForm.trip_type === 'oneway' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                  {t('cm.tripTypeOneway')}
                </button>
                <button type="button" onClick={() => setTripForm({ ...tripForm, trip_type: 'return' })}
                  className={`py-2.5 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${tripForm.trip_type === 'return' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                  {t('cm.tripTypeReturn')}
                </button>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{tripForm.trip_type === 'return' ? t('cm.tripTypeReturnHint') : t('cm.tripTypeOnewayHint')}</p>
              <div className="grid grid-cols-2 gap-3">
                <input value={tripForm.origin} onChange={(e) => setTripForm({ ...tripForm, origin: e.target.value })} placeholder={t('mk.originPlaceholder')} className="input-field" />
                <input value={tripForm.destination} onChange={(e) => setTripForm({ ...tripForm, destination: e.target.value })} placeholder={t('mk.destinationPlaceholder')} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={tripForm.origin_ur} onChange={(e) => setTripForm({ ...tripForm, origin_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
                <input value={tripForm.destination_ur} onChange={(e) => setTripForm({ ...tripForm, destination_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              </div>
              <select value={tripForm.classification} onChange={(e) => setTripForm({ ...tripForm, classification: e.target.value })} className="input-field">
                <option value="intercity">{t('mk.intercity')}</option>
                <option value="out_of_city">{t('mk.outOfCity')}</option>
              </select>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mp.travelDateLabel')}</label><input type="date" value={tripForm.travel_date} onChange={(e) => setTripForm({ ...tripForm, travel_date: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.departureTimeLabel')}</label><input type="time" value={tripForm.departure_time_estimate} onChange={(e) => setTripForm({ ...tripForm, departure_time_estimate: e.target.value })} className="input-field" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={tripForm.seats_available || ''} onChange={(e) => setTripForm({ ...tripForm, seats_available: +e.target.value })} className="input-field" placeholder="1" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.listedFareLabel')}</label><input type="number" value={tripForm.listed_fare_per_seat_pkr || ''} onChange={(e) => setTripForm({ ...tripForm, listed_fare_per_seat_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.distanceKmOptionalLabel')}</label>
                <input type="number" value={tripForm.distance_km} onChange={(e) => setTripForm({ ...tripForm, distance_km: e.target.value })} className="input-field" placeholder={t('cm.distanceKmPlaceholder')} />
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('cm.distanceKmHint')}</p>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.destPinLabel')}</label>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mb-1.5">{t('cm.destPinHint')}</p>
                <LeafletMap
                  pins={tripForm.dest_lat != null && tripForm.dest_lng != null ? [{ lat: tripForm.dest_lat, lng: tripForm.dest_lng, color: '#dc2626' }] : []}
                  height={180} zoom={12} className="rounded-lg border border-dp-outline-variant"
                  onMapClick={(lat, lng) => setTripForm({ ...tripForm, dest_lat: lat, dest_lng: lng })}
                />
                {tripForm.dest_lat != null && (
                  <button onClick={() => setTripForm({ ...tripForm, dest_lat: null, dest_lng: null })} type="button" className="mt-1.5 flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
                    <X size={12} /> {t('vp.clearPickupPinBtn')}
                  </button>
                )}
              </div>
              <button onClick={postTripOffer} disabled={posting} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{posting ? t('action.saving') : t('cm.postTripBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
