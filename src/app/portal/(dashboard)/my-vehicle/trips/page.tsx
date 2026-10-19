'use client'

// Post Trip + My Trip Offers + Trip Bookings — its own screen, matching
// the design zip (previously embedded on the driver dashboard).
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, the
// fixed-position post-trip modal now uses the shared MobilityBottomSheet.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { MapPin, PlusCircle, X, Navigation, CheckCircle2, Ban, Check, XCircle, Megaphone, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { TripLiveShareToggle } from '@/components/portal/TripLiveShareToggle'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { TrustPill, type Trust } from '@/components/shared/TrustBadge'
import { FareBandPicker, type FareBand } from '@/components/shared/FareBandPicker'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { FairPriceHint } from '@/components/mobility/FairPriceHint'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface TripOffer {
  id: string; trip_type: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; seats_available: number; listed_fare_per_seat_pkr: number; status: string
  share_live_location: boolean; distance_km: number | null
}
interface FareOffer {
  id: string; trip_offer_id: string; seats_requested: number; proposed_fare_per_seat_pkr: number
  counter_fare_per_seat_pkr: number | null; status: string; portal_user_id: string
  rider_full_name: string | null; rider_mobile: string | null
}
interface TripBooking {
  id: string; seats: number; leg: string; agreed_fare_per_seat_pkr: number; total_amount_pkr: number; status: string; cancellation_reason: string | null
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; travel_date: string } | null
}
interface TripIlan { id: string; trip_offer_id: string; status: string; is_paused: boolean; ends_at: string; created_at: string }
interface IlanQuote { price_pkr: number; wallet_balance_pkr: number; covered_by_wallet: boolean }
const emptyTripOffer = {
  trip_type: 'oneway' as string, origin: '', origin_ur: '', destination: '', destination_ur: '', classification: 'intercity',
  travel_date: '', departure_time_estimate: '', seats_available: 1, listed_fare_per_seat_pkr: 0, distance_km: '' as string,
  dest_lat: null as number | null, dest_lng: null as number | null,
}

const inputCls = 'w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px] bg-white'

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
  const [bookingsFilter, setBookingsFilter] = useState<'upcoming' | 'completed' | 'cancelled'>('upcoming')
  const [ilansByTrip, setIlansByTrip] = useState<Record<string, TripIlan>>({})
  const [adSheetTrip, setAdSheetTrip] = useState<string | null>(null)
  const [adQuote, setAdQuote] = useState<IlanQuote | null>(null)
  const [adQuoting, setAdQuoting] = useState(false)
  const [adRequesting, setAdRequesting] = useState(false)

  const reload = async (vehicleId: string) => {
    const [{ data: trips }, { data: tripB }] = await Promise.all([
      supabase.from('vehicle_trip_offers').select('*').eq('vehicle_id', vehicleId).order('created_at', { ascending: false }),
      supabase.from('vehicle_trip_bookings').select('id, seats, leg, agreed_fare_per_seat_pkr, total_amount_pkr, status, cancellation_reason, vehicle_trip_offers(origin, origin_ur, destination, destination_ur, travel_date)')
        .eq('vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(20),
    ])
    setTripOffers(trips ?? [])
    setTripBookings((tripB ?? []) as unknown as TripBooking[])

    if (trips && trips.length > 0) {
      const { data: fareOffers } = await supabase.rpc('my_vehicle_trip_fare_offers', { p_vehicle_id: vehicleId })
      const grouped: Record<string, FareOffer[]> = {}
      for (const fo of (fareOffers ?? []) as unknown as FareOffer[]) {
        grouped[fo.trip_offer_id] = [...(grouped[fo.trip_offer_id] ?? []), fo]
      }
      setFareOffersByTrip(grouped)

      const { data: ilans } = await supabase.from('commercial_ilans')
        .select('id, vehicle_trip_offer_id, status, is_paused, ends_at, created_at')
        .in('vehicle_trip_offer_id', trips.map((tr) => tr.id)).order('created_at', { ascending: false })
      const latestIlan: Record<string, TripIlan> = {}
      for (const i of (ilans ?? []) as unknown as (TripIlan & { vehicle_trip_offer_id: string })[]) {
        if (!latestIlan[i.vehicle_trip_offer_id]) latestIlan[i.vehicle_trip_offer_id] = i
      }
      setIlansByTrip(latestIlan)
    } else { setFareOffersByTrip({}); setIlansByTrip({}) }
  }

  const openAdSheet = async (tripOfferId: string) => {
    setAdSheetTrip(tripOfferId)
    setAdQuote(null)
    setAdQuoting(true)
    const { data, error } = await supabase.rpc('quote_trip_ilan', { p_trip_offer_id: tripOfferId })
    setAdQuoting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); setAdSheetTrip(null); return }
    setAdQuote(data as IlanQuote)
  }

  const confirmAd = async () => {
    if (!adSheetTrip || !vehicle) return
    setAdRequesting(true)
    const { data, error } = await supabase.rpc('request_trip_ilan', { p_trip_offer_id: adSheetTrip })
    setAdRequesting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const approved = (data as { approved_instantly: boolean } | null)?.approved_instantly
    toast.success(approved ? t('cm.adApprovedInstantlyToast') : t('cm.adPendingApprovalToast'))
    setAdSheetTrip(null); setAdQuote(null)
    reload(vehicle.id)
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

  const cancelTripBooking = async (id: string) => {
    if (!vehicle) return
    if (!window.confirm(t('mp.confirmCancelConfirmedHint'))) return
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('cancel_trip_booking', { p_trip_booking_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingCancelledToast'))
    reload(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return null

  const todayStr = new Date().toISOString().slice(0, 10)
  const hasOpenTrip = tripOffers.some((o) => o.status === 'open' && o.travel_date >= todayStr)

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => {
          if (!rideEligible) { toast.error(t('vp.rideNotAllowedMessage')); return }
          if (!vehicle.is_online) { toast.error(t('vp.goOnlineToPostTripHint')); return }
          // Real ask, 2026-10-17: a vehicle can only have one open trip
          // at a time — a new one waits until the current one is closed
          // or its own date has passed. Same client-side pre-check style
          // as the two above it (the server enforces this regardless;
          // this just avoids a round-trip just to show the same error).
          if (hasOpenTrip) { toast.error(t('cm.alreadyHasOpenTripError')); return }
          setShowPostTrip(true)
        }}
        className="flex items-center gap-1.5 px-3.5 py-2.5 bg-[#166534] text-white rounded-xl font-sans text-[13px] font-semibold cursor-pointer w-fit">
        <PlusCircle size={14} /> {t('cm.postTripBtn')}
      </button>

      {tripOffers.length > 0 && (
        <div>
          <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('cm.myTripOffersHeading')}</p>
          <div className="flex flex-col gap-3">
            {tripOffers.map((tr) => (
              <div key={tr.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate flex items-center gap-1"><MapPin size={12} className="shrink-0 text-[#166534]" /> {isUrdu && tr.origin_ur ? tr.origin_ur : tr.origin} → {isUrdu && tr.destination_ur ? tr.destination_ur : tr.destination}</p>
                    <p className="font-sans text-[12px] text-[#64748b] mt-0.5">{new Date(tr.travel_date).toLocaleDateString('en-GB')} · {tr.seats_available} {t('mk.seatsLabel')} · {fmt(tr.listed_fare_per_seat_pkr)} {t('mk.perSeat')}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tr.trip_type === 'return' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>{tr.trip_type === 'return' ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}</span>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tr.status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-[#F9F9F6] text-[#64748b]'}`}>{tr.status === 'open' ? t('mk.active') : t('mk.inactive')}</span>
                  </div>
                </div>
                {(fareOffersByTrip[tr.id] ?? []).map((fo) => (
                  <div key={fo.id} className="mt-2.5 bg-amber-50/60 border border-amber-100 rounded-xl p-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#1e293b]">
                        {fo.rider_full_name ?? '—'} {trustByFareOffer[fo.portal_user_id] && <TrustPill trust={trustByFareOffer[fo.portal_user_id]} />}
                      </span>
                      <span className="font-sans text-[13px] font-extrabold text-[#166534] ltr-num">{fmt(fo.proposed_fare_per_seat_pkr)}<span className="text-[10px] font-semibold text-[#64748b]">/{t('mk.seatsLabel')} × {fo.seats_requested}</span></span>
                    </div>
                    {fo.status === 'countered' && (
                      <p className="text-[11.5px] text-amber-700 font-semibold mt-1">{t('cm.youCountered')} <span className="ltr-num">{fmt(fo.counter_fare_per_seat_pkr ?? 0)}</span></p>
                    )}
                    {fo.status === 'pending' && bandByTrip[tr.id] && (
                      <FareBandPicker band={bandByTrip[tr.id]} value={counterAmount[fo.id] ?? ''} onChange={(v) => setCounterAmount({ ...counterAmount, [fo.id]: v })} ownerLabel={t('cm.yourCounterLabel')} />
                    )}
                    {fo.status === 'pending' && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        <button onClick={() => respondFare(fo.id, 'accept')} disabled={actionId === fo.id} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50"><Check size={13} /> {t('cm.acceptBtn')}</button>
                        <button onClick={() => respondFare(fo.id, 'reject')} disabled={actionId === fo.id} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] bg-white text-[#64748b] disabled:opacity-50"><XCircle size={13} /> {t('mp.rejectBtn')}</button>
                        <div className="flex items-center gap-1.5 ml-auto">
                          <input type="number" value={counterAmount[fo.id] ?? ''} onChange={(e) => setCounterAmount({ ...counterAmount, [fo.id]: +e.target.value })} placeholder={t('cm.counterPlaceholder')} className="w-20 border border-[#e5e2d0] rounded-lg p-1.5 text-[12px] bg-white" />
                          <button onClick={() => respondFare(fo.id, 'counter')} disabled={actionId === fo.id} className="px-2.5 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#166534] text-[#166534] bg-white disabled:opacity-50">{t('cm.counterBtn')}</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {tr.status === 'open' && (() => {
                  const ilan = ilansByTrip[tr.id]
                  const ilanLive = ilan && ilan.status === 'approved' && !ilan.is_paused && new Date(ilan.ends_at).getTime() > Date.now()
                  const ilanPending = ilan && ilan.status === 'pending_approval'
                  return (
                    <>
                      <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-[#f1f5f9]">
                        {ilanLive ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><Megaphone size={12} /> {t('il.adIsRunningLabel')}</span>
                        ) : ilanPending ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock size={12} /> {t('il.statusPending')}</span>
                        ) : (
                          <span className="text-[11px] text-[#94a3b8]">{t('il.noAdRunningLabel')}</span>
                        )}
                        {!ilanLive && !ilanPending && (
                          <button onClick={() => openAdSheet(tr.id)} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-sans font-semibold cursor-pointer border border-[#166534] text-[#166534]">
                            <Megaphone size={12} /> {t('cm.advertiseThisRideBtn')}
                          </button>
                        )}
                      </div>
                      <TripLiveShareToggle
                        tripOfferId={tr.id}
                        sharing={tr.share_live_location}
                        onSharingChange={(on) => setTripOffers((rows) => rows.map((r) => r.id === tr.id ? { ...r, share_live_location: on } : r))}
                      />
                      <button onClick={() => cancelTripOffer(tr.id)} disabled={actionId === tr.id} className="flex items-center gap-1 font-sans text-[11.5px] font-semibold mt-2 pt-2 border-t border-[#f1f5f9] cursor-pointer disabled:opacity-50 text-[#b91c1c]">
                        <Ban size={12} /> {t('cm.cancelTripBtn')}
                      </button>
                    </>
                  )
                })()}
              </div>
            ))}
          </div>
        </div>
      )}

      {tripBookings.length > 0 && (
        <div>
          <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('cm.tripBookingsHeading')}</p>
          <div className="flex items-center gap-1.5 mb-2">
            {(['upcoming', 'completed', 'cancelled'] as const).map((f) => (
              <button key={f} onClick={() => setBookingsFilter(f)}
                className="px-3 py-1 rounded-full text-[11px] font-bold cursor-pointer border"
                style={{ background: bookingsFilter === f ? '#166534' : '#fff', color: bookingsFilter === f ? '#fff' : '#64748b', borderColor: bookingsFilter === f ? '#166534' : '#e5e2d0' }}>
                {t(`vp.bookingsFilter.${f}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {tripBookings.filter((tb) =>
              bookingsFilter === 'upcoming' ? tb.status === 'confirmed' : bookingsFilter === 'completed' ? tb.status === 'completed' : tb.status === 'cancelled'
            ).map((tb) => (
              <div key={tb.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate">{tb.vehicle_trip_offers ? `${isUrdu && tb.vehicle_trip_offers.origin_ur ? tb.vehicle_trip_offers.origin_ur : tb.vehicle_trip_offers.origin} → ${isUrdu && tb.vehicle_trip_offers.destination_ur ? tb.vehicle_trip_offers.destination_ur : tb.vehicle_trip_offers.destination}` : '—'}</p>
                      <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${tb.leg === 'return' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>
                        {tb.leg === 'return' ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}
                      </span>
                    </div>
                    <p className="font-sans text-[12px] text-[#64748b] mt-0.5">{tb.vehicle_trip_offers && new Date(tb.vehicle_trip_offers.travel_date).toLocaleDateString('en-GB')} · {tb.seats} {t('mk.seatsLabel')}</p>
                  </div>
                  <p className="font-sans text-[14px] font-bold text-[#166534] shrink-0">{fmt(tb.total_amount_pkr)}</p>
                </div>
                {tb.status === 'cancelled' && tb.cancellation_reason && (
                  <p className="font-sans text-[11px] text-rose-600 mt-1">{tb.cancellation_reason}</p>
                )}
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-[#f1f5f9]">
                  {tb.status === 'completed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('cm.tripCompletedStatus')}</span>}
                  {tb.status === 'cancelled' && <span className="inline-flex items-center gap-1 text-[#64748b] text-[11px] font-bold"><Ban size={11} /> {t('mp.cancelledStatus')}</span>}
                  {tb.status === 'confirmed' && (
                    <>
                      <Link href={`/portal/marketplace/trip/${tb.id}`} className="inline-flex items-center gap-1 text-[#166534] text-[12px] font-semibold"><Navigation size={12} /> {t('cm.trackLocationBtn')}</Link>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => cancelTripBooking(tb.id)} disabled={actionId === tb.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">{t('mp.cancelBookingBtn')}</button>
                        <button onClick={() => completeTripBooking(tb.id)} disabled={actionId === tb.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{t('cm.markTripCompleteBtn')}</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPostTrip && (
        <MobilityBottomSheet title={t('cm.postTripBtn')} onClose={() => setShowPostTrip(false)}>
          <p className="font-sans text-[12.5px] text-[#64748b] mb-3">{t('cm.postTripHint')}</p>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setTripForm({ ...tripForm, trip_type: 'oneway' })}
                className="py-2.5 rounded-xl text-[13px] font-sans font-semibold cursor-pointer"
                style={{ background: tripForm.trip_type === 'oneway' ? '#166534' : '#F9F9F6', color: tripForm.trip_type === 'oneway' ? '#fff' : '#64748b' }}>
                {t('cm.tripTypeOneway')}
              </button>
              <button type="button" onClick={() => setTripForm({ ...tripForm, trip_type: 'return' })}
                className="py-2.5 rounded-xl text-[13px] font-sans font-semibold cursor-pointer"
                style={{ background: tripForm.trip_type === 'return' ? '#166534' : '#F9F9F6', color: tripForm.trip_type === 'return' ? '#fff' : '#64748b' }}>
                {t('cm.tripTypeReturn')}
              </button>
            </div>
            <p className="font-sans text-[11.5px] text-[#64748b]">{tripForm.trip_type === 'return' ? t('cm.tripTypeReturnHint') : t('cm.tripTypeOnewayHint')}</p>
            <div className="grid grid-cols-2 gap-3">
              <input value={tripForm.origin} onChange={(e) => setTripForm({ ...tripForm, origin: e.target.value })} placeholder={t('mk.originPlaceholder')} className={inputCls} />
              <input value={tripForm.destination} onChange={(e) => setTripForm({ ...tripForm, destination: e.target.value })} placeholder={t('cm.tripDestinationCityPlaceholder')} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input value={tripForm.origin_ur} onChange={(e) => setTripForm({ ...tripForm, origin_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className={inputCls} style={{ fontFamily: 'var(--font-urdu-ui)' }} dir="rtl" />
              <input value={tripForm.destination_ur} onChange={(e) => setTripForm({ ...tripForm, destination_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className={inputCls} style={{ fontFamily: 'var(--font-urdu-ui)' }} dir="rtl" />
            </div>
            <select value={tripForm.classification} onChange={(e) => setTripForm({ ...tripForm, classification: e.target.value })} className={inputCls}>
              <option value="intercity">{t('mk.intercity')}</option>
              <option value="out_of_city">{t('mk.outOfCity')}</option>
            </select>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mp.travelDateLabel')}</label><input type="date" value={tripForm.travel_date} onChange={(e) => setTripForm({ ...tripForm, travel_date: e.target.value })} className={inputCls} /></div>
              <div><label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mk.departureTimeLabel')}</label><input type="time" value={tripForm.departure_time_estimate} onChange={(e) => setTripForm({ ...tripForm, departure_time_estimate: e.target.value })} className={inputCls} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={tripForm.seats_available || ''} onChange={(e) => setTripForm({ ...tripForm, seats_available: +e.target.value })} className={inputCls} placeholder="1" /></div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{tripForm.trip_type === 'return' ? t('cm.listedFareLabelReturn') : t('cm.listedFareLabel')}</label>
                <input type="number" value={tripForm.listed_fare_per_seat_pkr || ''} onChange={(e) => setTripForm({ ...tripForm, listed_fare_per_seat_pkr: +e.target.value })} className={inputCls} placeholder="0" />
                {tripForm.trip_type === 'return' && tripForm.listed_fare_per_seat_pkr > 0 && (
                  <p className="font-sans text-[11px] text-[#64748b] mt-1">{t('cm.oneWayAutoHalfHint').replace('{price}', String(Math.round(tripForm.listed_fare_per_seat_pkr / 2)))}</p>
                )}
              </div>
            </div>
            <div>
              <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('cm.distanceKmOptionalLabel')}</label>
              <input type="number" value={tripForm.distance_km} onChange={(e) => setTripForm({ ...tripForm, distance_km: e.target.value })} className={inputCls} placeholder={t('cm.distanceKmPlaceholder')} />
              <p className="font-sans text-[11px] text-[#64748b] mt-1">{t('cm.distanceKmHint')}</p>
              <FairPriceHint flow="trip_share" distanceKm={tripForm.distance_km ? Number(tripForm.distance_km) : null} />
            </div>
            <div>
              <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('cm.destPinLabel')}</label>
              <p className="font-sans text-[11px] text-[#64748b] mb-1.5">{t('cm.destPinHint')}</p>
              <LeafletMap
                pins={tripForm.dest_lat != null && tripForm.dest_lng != null ? [{ lat: tripForm.dest_lat, lng: tripForm.dest_lng, color: '#dc2626' }] : []}
                height={180} zoom={12} className="rounded-xl border border-[#e5e2d0]"
                onMapClick={(lat, lng) => setTripForm({ ...tripForm, dest_lat: lat, dest_lng: lng })}
              />
              {tripForm.dest_lat != null && (
                <button onClick={() => setTripForm({ ...tripForm, dest_lat: null, dest_lng: null })} type="button" className="mt-1.5 flex items-center gap-1 font-sans text-[12px] font-semibold text-[#64748b] cursor-pointer">
                  <X size={12} /> {t('vp.clearPickupPinBtn')}
                </button>
              )}
            </div>
            <button onClick={postTripOffer} disabled={posting} className="w-full bg-[#166534] text-white py-3 rounded-xl font-sans font-semibold cursor-pointer disabled:opacity-50">{posting ? t('action.saving') : t('cm.postTripBtn')}</button>
          </div>
        </MobilityBottomSheet>
      )}

      {adSheetTrip && (
        <MobilityBottomSheet title={t('cm.advertiseThisRideBtn')} onClose={() => { setAdSheetTrip(null); setAdQuote(null) }}>
          <div className="space-y-3">
            <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-xl p-3 space-y-2">
              <p className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('cm.adWhatItDoesHeading')}</p>
              <ul className="space-y-1.5">
                <li className="flex items-start gap-2 text-[12px] text-[#64748b]"><Megaphone size={13} className="shrink-0 mt-0.5 text-[#166534]" /> {t('cm.adExplainBelt')}</li>
                <li className="flex items-start gap-2 text-[12px] text-[#64748b]"><MapPin size={13} className="shrink-0 mt-0.5 text-[#166534]" /> {t('cm.adExplainOneClick')}</li>
              </ul>
            </div>

            {adQuoting ? (
              <div className="flex justify-center py-6"><LoadingDots /></div>
            ) : adQuote ? (
              <div className="bg-white border border-[#e5e2d0] rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-semibold text-[#64748b]">{t('cm.adPriceLabel')}</span>
                  <span className="font-sans text-[15px] font-extrabold text-[#166534] ltr-num">₨{fmt(adQuote.price_pkr)}</span>
                </div>
                {adQuote.covered_by_wallet ? (
                  <p className="text-[12px] text-emerald-700 font-semibold">{t('cm.adWalletCoversToast').replace('{balance}', fmt(adQuote.wallet_balance_pkr))}</p>
                ) : (
                  <p className="text-[12px] text-amber-700 font-semibold">{t('cm.adNeedsCommitteeHint')}</p>
                )}
              </div>
            ) : null}

            <button onClick={confirmAd} disabled={adRequesting || adQuoting || !adQuote}
              className="w-full bg-[#166534] text-white py-3 rounded-xl font-sans font-semibold cursor-pointer disabled:opacity-50">
              {adRequesting ? t('action.saving') : adQuote?.covered_by_wallet ? t('cm.adPayFromWalletBtn') : t('cm.adSendToCommitteeBtn')}
            </button>
          </div>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
