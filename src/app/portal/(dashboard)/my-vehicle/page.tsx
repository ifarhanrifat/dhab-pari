'use client'

// Driver self-service: bookings + wallet + earnings for whichever vehicle
// is linked to this portal account (vehicles.portal_user_id, staff-set —
// see migration 394). Route/schedule creation stays staff-managed
// (unlike a shop's own catalog, that wasn't part of this ask) — this page
// is what a per_order driver actually needs day to day: their wallet
// balance, a top-up button, and marking a booking fulfilled themselves
// (no payment to verify — the rider already paid them directly).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Bus, Wallet, TrendingUp, Clock, CheckCircle2, XCircle, MapPin, PlusCircle, X, Navigation } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { WalletTopupModal } from '@/components/portal/WalletTopupModal'

interface Vehicle { id: string; owner_name: string; vehicle_type: string; commission_mode: string }
interface TripOffer {
  id: string; trip_type: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; seats_available: number; listed_fare_per_seat_pkr: number; status: string
}
interface FareOffer {
  id: string; trip_offer_id: string; seats_requested: number; proposed_fare_per_seat_pkr: number
  counter_fare_per_seat_pkr: number | null; status: string; portal_users: { full_name: string; mobile: string } | null
}
interface TripBooking {
  id: string; seats: number; agreed_fare_per_seat_pkr: number; total_amount_pkr: number; status: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; travel_date: string } | null
}
const emptyTripOffer = {
  trip_type: 'oneway' as string, origin: '', origin_ur: '', destination: '', destination_ur: '', classification: 'intercity',
  travel_date: '', departure_time_estimate: '', seats_available: 1, listed_fare_per_seat_pkr: 0,
}
interface Summary {
  balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null
  today_earnings_pkr: number; month_earnings_pkr: number; pending_bookings_count: number
  last_settlement_date: string | null; last_settlement_amount: number | null
}
interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehiclePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [actionId, setActionId] = useState<string | null>(null)
  const [showTopup, setShowTopup] = useState(false)

  const [tripOffers, setTripOffers] = useState<TripOffer[]>([])
  const [fareOffersByTrip, setFareOffersByTrip] = useState<Record<string, FareOffer[]>>({})
  const [tripBookings, setTripBookings] = useState<TripBooking[]>([])
  const [showPostTrip, setShowPostTrip] = useState(false)
  const [tripForm, setTripForm] = useState(emptyTripOffer)
  const [posting, setPosting] = useState(false)
  const [counterAmount, setCounterAmount] = useState<Record<string, number>>({})

  const reload = async (vehicleId: string) => {
    const [{ data: s }, { data: b }, { data: trips }, { data: tripB }] = await Promise.all([
      supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: vehicleId }),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
        .eq('vehicle_routes.vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(20),
      supabase.from('vehicle_trip_offers').select('*').eq('vehicle_id', vehicleId).order('created_at', { ascending: false }),
      supabase.from('vehicle_trip_bookings').select('id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, status, vehicle_trip_offers(origin, origin_ur, destination, destination_ur, travel_date)')
        .eq('vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(20),
    ])
    setSummary(s as unknown as Summary)
    setBookings((b ?? []) as unknown as Booking[])
    setTripOffers(trips ?? [])
    setTripBookings((tripB ?? []) as unknown as TripBooking[])

    if (trips && trips.length > 0) {
      const { data: fareOffers } = await supabase.from('vehicle_trip_fare_offers')
        .select('id, trip_offer_id, seats_requested, proposed_fare_per_seat_pkr, counter_fare_per_seat_pkr, status, portal_users(full_name, mobile)')
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
    supabase.from('vehicles').select('id, owner_name, vehicle_type, commission_mode').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) await reload(data.id)
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const postTripOffer = async () => {
    if (!vehicle || !tripForm.origin.trim() || !tripForm.destination.trim() || !tripForm.travel_date) { toast.error(t('mk.nameRequired')); return }
    setPosting(true)
    const { error } = await supabase.rpc('place_trip_offer', {
      p_vehicle_id: vehicle.id, p_trip_type: tripForm.trip_type, p_origin: tripForm.origin, p_origin_ur: tripForm.origin_ur || null,
      p_destination: tripForm.destination, p_destination_ur: tripForm.destination_ur || null,
      p_classification: tripForm.classification, p_travel_date: tripForm.travel_date,
      p_departure_time_estimate: tripForm.departure_time_estimate || null,
      p_seats_available: tripForm.seats_available, p_listed_fare_per_seat_pkr: tripForm.listed_fare_per_seat_pkr,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error)); return }
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
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(action === 'accept' ? t('cm.fareAcceptedToast') : action === 'counter' ? t('cm.fareCounteredToast') : t('cm.fareRejectedToast'))
    reload(vehicle.id)
  }

  const completeTripBooking = async (id: string) => {
    if (!vehicle) return
    setActionId(id)
    const { error } = await supabase.rpc('complete_trip_booking', { p_trip_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.tripCompletedToast'))
    reload(vehicle.id)
  }

  const fulfillBooking = async (id: string) => {
    setActionId(id)
    const { error } = await supabase.rpc('confirm_ride_booking', { p_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.bookingConfirmedToast'))
    if (vehicle) reload(vehicle.id)
  }
  const cancelBooking = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('reject_ride_booking', { p_booking_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.bookingRejectedToast'))
    if (vehicle) reload(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!vehicle) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('cm.noVehicleLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h1 className="font-heading text-[26px] font-bold leading-[34px] text-dp-primary flex items-center gap-2"><Bus size={22} /> {vehicle.owner_name}</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPostTrip(true)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container">
            <PlusCircle size={14} /> {t('cm.postTripBtn')}
          </button>
          {vehicle.commission_mode === 'per_order' && (
            <button onClick={() => setShowTopup(true)} className="flex items-center gap-1.5 px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
              <Wallet size={14} /> {t('cm.topupWalletBtn')}
            </button>
          )}
        </div>
      </div>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{vehicle.vehicle_type}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><Wallet size={12} /> {t('cm.balanceLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-primary mt-1">{fmt(summary?.balance_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><TrendingUp size={12} /> {t('cm.todayEarningsLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-secondary mt-1">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant">{t('cm.monthEarningsLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-secondary mt-1">{fmt(summary?.month_earnings_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><Clock size={12} /> {t('cm.pendingOrdersTag')}</p>
          <p className="font-heading text-[19px] font-bold text-amber-700 mt-1">{summary?.pending_bookings_count ?? 0}</p>
        </div>
      </div>

      {summary?.commission_mode === 'monthly_lumpsum' && (
        <div className="bg-violet-50 border border-violet-200 rounded-lg p-3.5 mb-6">
          <p className="font-sans text-[13px] text-violet-900">{t('cm.onLumpsumNote')} <span className="font-bold ltr-num">{fmt(summary.lumpsum_fee_pkr ?? 0)}</span></p>
        </div>
      )}

      {summary?.last_settlement_date && (
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-6">{t('cm.lastSettlementLabel')} <span className="font-semibold text-dp-on-surface">{fmt(summary.last_settlement_amount ?? 0)}</span> — {new Date(summary.last_settlement_date).toLocaleDateString('en-GB')}</p>
      )}

      <div>
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.bookingsHeading')}</p>
        {bookings.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('cm.noBookingsYet')}</p>}
        <div className="space-y-2">
          {bookings.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate flex items-center gap-1">
                    <MapPin size={12} className="shrink-0 text-dp-secondary" />
                    {b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—'}
                  </p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(b.travel_date).toLocaleDateString('en-GB')} · {b.seats} {t('mk.seatsLabel')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(b.total_amount_pkr)}</p>
                  {b.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>}
                  {b.status === 'rejected' && <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold" title={b.rejected_reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>}
                  {b.status === 'announced' && summary?.commission_mode !== 'per_order' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>}
                </div>
              </div>
              {b.status === 'announced' && summary?.commission_mode === 'per_order' && (
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  <span className="font-sans text-[11px] text-dp-on-surface-variant">{t('cm.markFulfilledHint')}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => cancelBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                    <button onClick={() => fulfillBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.markFulfilledBtn')}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {tripOffers.length > 0 && (
        <div className="mt-8">
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
                    <p className="font-sans text-[12.5px] text-dp-on-surface">
                      {fo.portal_users?.full_name ?? '—'} — <span className="font-bold text-dp-secondary">{fmt(fo.proposed_fare_per_seat_pkr)}</span>/{t('mk.seatsLabel')} × <span className="ltr-num">{fo.seats_requested}</span>
                      {fo.status === 'countered' && <span className="text-amber-700 font-semibold"> ({t('cm.youCountered')} {fmt(fo.counter_fare_per_seat_pkr ?? 0)})</span>}
                    </p>
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
              </div>
            ))}
          </div>
        </div>
      )}

      {tripBookings.length > 0 && (
        <div className="mt-8">
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
              <button onClick={postTripOffer} disabled={posting} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{posting ? t('action.saving') : t('cm.postTripBtn')}</button>
            </div>
          </div>
        </div>
      )}

      {showTopup && (
        <WalletTopupModal kind="vehicle" sellerId={vehicle.id} onClose={() => setShowTopup(false)} onSubmitted={() => { setShowTopup(false); reload(vehicle.id) }} />
      )}
    </div>
  )
}
