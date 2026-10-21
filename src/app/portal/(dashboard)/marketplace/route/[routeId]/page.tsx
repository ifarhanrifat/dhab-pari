'use client'

// Marketplace phase 4 — route detail + seat booking. Availability is
// always fetched live from route_seats_available() for whatever date is
// picked (same "computed, not stored" approach as training_batches'
// spots_left) — the seat stepper's max just follows whatever that RPC
// says, so this never shows a stale number.

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Minus, Plus, MapPin, Bus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomNav } from '@/components/mobility/MobilityBottomNav'
import { RouteGroupPanel } from '@/components/mobility/RouteGroupPanel'
import { estimateArrivalTime, estimateReturnArrivalTime } from '@/lib/roadRoute'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_mode: string; total_fare_pkr: number | null; fare_per_seat_pkr: number; departure_time: string | null; return_departure_time: string | null; days_of_week: number[]
  origin_lat: number | null; origin_lng: number | null; destination_lat: number | null; destination_lng: number | null
  route_path: { lat: number; lng: number }[] | null; route_duration_min: number | null
  is_monthly_fixed: boolean; monthly_reference_fee_pkr: number | null
  is_two_way: boolean; return_wait_minutes: number | null
}
interface Vehicle { id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; total_seats: number; commission_mode: string }
interface Stop { id: string; label: string; label_ur: string | null; lat: number; lng: number; stop_order: number }
interface MonthlySubscription { id: string; status: string; monthly_fee_pkr: number; queue_position: number | null; scheduled_cancellation_at: string | null }
interface MonthlyDetail { is_monthly_fixed: boolean; monthly_reference_fee_pkr: number | null; seats_total: number; active_count: number; my_subscription: MonthlySubscription | null }

// Approximate only — interpolated proportionally along the driver's
// own chosen road path using its real OSRM duration, not a live ETA.
// Always labeled "approx." in the UI for exactly that reason.
function computeStopEtas(path: { lat: number; lng: number }[], durationMin: number | null, departureTime: string | null, stops: Stop[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const s of stops) {
    const t = estimateArrivalTime(path, durationMin, departureTime, { lat: s.lat, lng: s.lng })
    if (t) result[s.id] = t
  }
  return result
}
function computeReturnStopEtas(path: { lat: number; lng: number }[], durationMin: number | null, returnDepartureTime: string | null, stops: Stop[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const s of stops) {
    const t = estimateReturnArrivalTime(path, durationMin, returnDepartureTime, { lat: s.lat, lng: s.lng })
    if (t) result[s.id] = t
  }
  return result
}

const DAY_KEYS = ['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat']

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export default function RouteDetailPage() {
  const { t, isUrdu } = useLocale()
  const params = useParams<{ routeId: string }>()
  const router = useRouter()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [route, setRoute] = useState<Route | null>(null)
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [travelDate, setTravelDate] = useState('')
  const [available, setAvailable] = useState<number | null>(null)
  const [checkingAvailability, setCheckingAvailability] = useState(false)
  const [seats, setSeats] = useState(1)
  const [method, setMethod] = useState('cash')
  const [proofPath, setProofPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [bookable, setBookable] = useState(true)
  const [stops, setStops] = useState<Stop[]>([])
  const [showGroup, setShowGroup] = useState(false)
  const [monthlyDetail, setMonthlyDetail] = useState<MonthlyDetail | null>(null)
  const [selectedBoardStopId, setSelectedBoardStopId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [leavingSeat, setLeavingSeat] = useState(false)
  const [returnSeatsAvailable, setReturnSeatsAvailable] = useState<number | null>(null)
  const [returnBoardStopId, setReturnBoardStopId] = useState<string | null>(null)
  const [returnProofPath, setReturnProofPath] = useState('')
  const [bookingReturn, setBookingReturn] = useState(false)

  useEffect(() => {
    supabase.from('vehicle_routes').select('*').eq('id', params.routeId).single().then(async ({ data: r }) => {
      setRoute(r)
      if (r) {
        const [{ data: v }, { data: bk }, { data: st }] = await Promise.all([
          supabase.from('vehicles').select('id, owner_name, owner_mobile, vehicle_type, total_seats, commission_mode').eq('id', r.vehicle_id).single(),
          supabase.rpc('vehicle_bookable', { p_vehicle_id: r.vehicle_id }),
          supabase.from('route_stops').select('id, label, label_ur, lat, lng, stop_order').eq('route_id', r.id).order('stop_order'),
        ])
        setVehicle(v)
        setBookable(bk !== false)
        setStops(st ?? [])
        if (r.is_monthly_fixed) {
          const { data: md } = await supabase.rpc('route_monthly_detail', { p_route_id: r.id })
          setMonthlyDetail(md as MonthlyDetail | null)
        }
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.routeId])

  const wrongDay = route && travelDate ? !route.days_of_week.includes(new Date(travelDate + 'T00:00:00').getDay()) : false

  useEffect(() => {
    if (!travelDate || !route || wrongDay) { setAvailable(null); return }
    setCheckingAvailability(true)
    supabase.rpc('route_seats_available', { p_route_id: route.id, p_travel_date: travelDate }).then(({ data }) => {
      setAvailable(data as number)
      setSeats((s) => Math.min(s, Math.max(1, data as number)))
      setCheckingAvailability(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [travelDate, route?.id, wrongDay])

  // Real ask, 2026-10-21: "an alert will be sent to the riders... with 1
  // seat or 2 seat available and now they can join the ride with one way
  // fare" — a seat an outbound rider was offboarded from (see
  // RouteGroupPanel's own offboard flow) shows up here for ANYONE,
  // bookable as a standalone, distance-proportional one-way return.
  useEffect(() => {
    if (!travelDate || !route?.is_two_way || wrongDay) { setReturnSeatsAvailable(null); return }
    supabase.rpc('return_seats_available', { p_route_id: route.id, p_travel_date: travelDate }).then(({ data }) => {
      setReturnSeatsAvailable(data as number)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [travelDate, route?.id, route?.is_two_way, wrongDay])

  const bookReturnSeat = async () => {
    if (!route) return
    if (!travelDate) { toast.error(t('mp.pickDateFirst')); return }
    if (!returnBoardStopId) { toast.error(t('mv.pickBoardStopLabel')); return }
    if (!isPerOrder && !returnProofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setBookingReturn(true)
    const { data, error } = await supabase.rpc('book_standalone_return_seat', {
      p_route_id: route.id, p_travel_date: travelDate, p_board_stop_id: returnBoardStopId,
      p_method: isPerOrder ? 'direct' : method, p_proof_url: isPerOrder ? null : returnProofPath,
    })
    setBookingReturn(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.returnSeatBookedToast').replace('{amount}', fmt((data as { total: number }).total)))
    router.push('/portal/marketplace')
  }

  const isFlex = route?.fare_mode === 'flex'
  // Live estimate only — the actual charge locks in server-side
  // (place_ride_booking, migration 437) at whatever the split is the
  // moment this booking is placed. seatsBookedSoFar comes from
  // route_seats_available (already fetched, already public) rather
  // than a second query.
  const seatsBookedSoFar = isFlex && vehicle && available !== null ? vehicle.total_seats - available : 0
  const estimatedPerSeatNow = isFlex && route?.total_fare_pkr ? route.total_fare_pkr / Math.max(1, seatsBookedSoFar + seats) : 0
  const minPerSeatIfFull = isFlex && route?.total_fare_pkr && vehicle ? route.total_fare_pkr / vehicle.total_seats : 0
  const total = !route ? 0 : isFlex ? Math.round(seats * estimatedPerSeatNow) : seats * route.fare_per_seat_pkr
  const isPerOrder = vehicle?.commission_mode === 'per_order'

  const submit = async () => {
    if (!route) return
    if (!travelDate) { toast.error(t('mp.pickDateFirst')); return }
    if (!isPerOrder && !proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('place_ride_booking', {
      p_route_id: route.id, p_travel_date: travelDate, p_seats: seats, p_method: isPerOrder ? 'direct' : method, p_proof_url: isPerOrder ? null : proofPath,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(isPerOrder ? t('cm.orderPlacedDirectToast') : t('mp.bookingPlacedToast'))
    router.push('/portal/marketplace')
  }

  const reloadMonthlyDetail = async () => {
    if (!route) return
    const { data: md } = await supabase.rpc('route_monthly_detail', { p_route_id: route.id })
    setMonthlyDetail(md as MonthlyDetail | null)
  }

  const applyForSeat = async () => {
    if (!route || !selectedBoardStopId) { toast.error(t('mv.pickBoardStopLabel')); return }
    setApplying(true)
    const { error } = await supabase.rpc('apply_for_monthly_seat', { p_route_id: route.id, p_board_stop_id: selectedBoardStopId })
    setApplying(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.monthlyAppliedToast'))
    reloadMonthlyDetail()
  }

  const leaveSeat = async () => {
    if (!monthlyDetail?.my_subscription) return
    setLeavingSeat(true)
    const { error } = await supabase.rpc('leave_monthly_seat', { p_subscription_id: monthlyDetail.my_subscription.id })
    setLeavingSeat(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.leftMonthlySeatToast'))
    reloadMonthlyDetail()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>
  if (!route) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('mp.routeNotFound')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <button onClick={() => router.push('/portal/marketplace')} className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13.5px] font-semibold hover:underline cursor-pointer mb-4">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}
      </button>

      <h1 className="font-heading text-[22px] font-bold text-dp-primary flex items-center gap-2">
        <MapPin size={19} className="text-dp-secondary shrink-0" /> {isUrdu && route.origin_ur ? route.origin_ur : route.origin} → {isUrdu && route.destination_ur ? route.destination_ur : route.destination}
      </h1>
      {vehicle && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><Bus size={13} /> {vehicle.owner_name} · {vehicle.vehicle_type}</p>}
      <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1 ltr-num">
        🕒 {route.departure_time ? route.departure_time.slice(0, 5) : t('mk.noFixedTime')}
        {route.return_departure_time && ` · ↩️ ${route.return_departure_time.slice(0, 5)}`}
        {' · '}
        {route.days_of_week.length === 7 ? t('mk.everyDay') : route.days_of_week.map((d) => t(DAY_KEYS[d])).join('، ')}
      </p>
      {route.is_monthly_fixed ? (
        <p className="font-heading text-[18px] font-bold text-amber-700 mt-2 flex items-center gap-1.5">
          ✅ {t('mv.monthlyFixedBadge')} · {fmt(route.monthly_reference_fee_pkr ?? 0)} <span className="font-sans font-normal text-dp-on-surface-variant text-[13px]">{t('mv.monthlyReferenceFeeLabel')}</span>
        </p>
      ) : isFlex ? (
        <div className="mt-2">
          <p className="font-heading text-[20px] font-bold text-dp-secondary">{fmt(minPerSeatIfFull)}–{fmt(route.total_fare_pkr ?? 0)} <span className="font-sans font-normal text-dp-on-surface-variant text-[13px]">{t('mp.flexPerSeatRangeSuffix')}</span></p>
          <p className="font-sans text-[12px] text-dp-on-surface-variant bg-dp-secondary-container/30 rounded-lg px-3 py-2 mt-1.5">{t('mp.flexModeExplain')}</p>
        </div>
      ) : (
        <p className="font-heading text-[22px] font-bold text-dp-secondary mt-2">{fmt(route.fare_per_seat_pkr)} <span className="font-sans font-normal text-dp-on-surface-variant text-[13px]">{t('mk.perSeat')}</span></p>
      )}

      {route.origin_lat != null && route.origin_lng != null && route.destination_lat != null && route.destination_lng != null && (
        <div className="mt-4">
          <LeafletMap
            className="rounded-lg"
            pins={[
              { lat: route.origin_lat, lng: route.origin_lng, label: isUrdu && route.origin_ur ? route.origin_ur : route.origin, color: '#16a34a' },
              { lat: route.destination_lat, lng: route.destination_lng, label: isUrdu && route.destination_ur ? route.destination_ur : route.destination, color: '#dc2626' },
            ]}
            route={route.route_path ?? undefined}
          />
        </div>
      )}

      {stops.length > 0 && (() => {
        const etas = computeStopEtas(route.route_path ?? [], route.route_duration_min, route.departure_time, stops)
        const returnEtas = computeReturnStopEtas(route.route_path ?? [], route.route_duration_min, route.return_departure_time, stops)
        return (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mt-4">
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{t('mp.routeStopsHeading')}</p>
            <div className="flex flex-col gap-1.5">
              {stops.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2.5">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-dp-secondary-container text-dp-secondary text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                  <span className="flex-1 min-w-0 font-sans text-[13px] text-dp-on-surface truncate">{isUrdu && s.label_ur ? s.label_ur : s.label}</span>
                  <span className="shrink-0 flex flex-col items-end font-sans text-[11px] text-dp-on-surface-variant ltr-num">
                    {etas[s.id] && <span>🕒 {etas[s.id]}</span>}
                    {returnEtas[s.id] && <span>↩️ {returnEtas[s.id]}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      <button onClick={() => setShowGroup(true)} className="w-full flex items-center justify-center gap-1.5 bg-white border border-dp-outline-variant rounded-lg p-3 mt-4 font-sans text-[13px] font-semibold text-dp-secondary cursor-pointer">
        <Users size={14} /> {t('mv.routeGroupHeading')}
      </button>
      {showGroup && <RouteGroupPanel routeId={route.id} onClose={() => setShowGroup(false)} />}

      {route.is_monthly_fixed && monthlyDetail && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mt-4">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{t('mv.monthlyFixedBadge')} · {monthlyDetail.active_count}/{monthlyDetail.seats_total}</p>
          {monthlyDetail.my_subscription ? (
            <div className="flex flex-col gap-2">
              {monthlyDetail.my_subscription.status === 'waitlisted' ? (
                <p className="font-sans text-[13px] font-semibold text-amber-700">{t('mv.waitlistPositionLabel').replace('{n}', String(monthlyDetail.my_subscription.queue_position ?? '?'))}</p>
              ) : monthlyDetail.my_subscription.status === 'pending_cancellation' ? (
                <p className="font-sans text-[13px] font-semibold text-amber-700">{t('mv.monthlyPendingCancellationStatusLabel').replace('{date}', monthlyDetail.my_subscription.scheduled_cancellation_at ? new Date(monthlyDetail.my_subscription.scheduled_cancellation_at).toLocaleDateString() : '')}</p>
              ) : (
                <p className="font-sans text-[13px] font-semibold text-emerald-700">✅ {t('mv.monthlyActiveStatusLabel')}</p>
              )}
              <p className="font-sans text-[13px] text-dp-on-surface">{t('mv.yourMonthlyFeeLabel')}: <span className="font-bold ltr-num">₨{fmt(monthlyDetail.my_subscription.monthly_fee_pkr)}</span></p>
              {monthlyDetail.my_subscription.status !== 'pending_cancellation' && (
                <button onClick={leaveSeat} disabled={leavingSeat} className="w-full border border-dp-error text-dp-error rounded-lg py-2 font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
                  {leavingSeat ? t('action.saving') : t('mv.leaveMonthlySeatBtn')}
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant">{t('mv.pickBoardStopLabel')}</label>
              <select value={selectedBoardStopId ?? ''} onChange={(e) => setSelectedBoardStopId(e.target.value || null)} className="input-field">
                <option value="">—</option>
                {stops.map((s) => <option key={s.id} value={s.id}>{isUrdu && s.label_ur ? s.label_ur : s.label}</option>)}
              </select>
              <button onClick={applyForSeat} disabled={applying || !selectedBoardStopId} className="w-full bg-dp-secondary text-white rounded-lg py-2.5 font-sans font-semibold cursor-pointer disabled:opacity-50">
                {applying ? t('mp.placingBooking') : t('mv.applyMonthlySeatBtn')}
              </button>
            </div>
          )}
        </div>
      )}

      {!route.is_monthly_fixed && !bookable && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 mt-4">
          <p className="font-sans text-[13px] text-amber-900">{t('cm.notBookableExplain')}</p>
          {vehicle?.owner_mobile && <p className="font-sans text-[13px] font-semibold text-amber-900 mt-1 ltr-num">{vehicle.owner_mobile}</p>}
        </div>
      )}

      {!route.is_monthly_fixed && bookable && (
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mt-5">
        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('mp.travelDateLabel')}</label>
        <input type="date" min={todayStr()} value={travelDate} onChange={(e) => setTravelDate(e.target.value)} className="input-field" />
        {wrongDay && <p className="font-sans text-[12px] text-dp-error mt-1.5">{t('mp.wrongDayError')}</p>}
        {!wrongDay && travelDate && (
          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">
            {checkingAvailability ? t('action.loading') : available !== null ? `${available} ${t('mp.seatsAvailableSuffix')}` : ''}
          </p>
        )}

        {!wrongDay && travelDate && available !== null && available > 0 && (
          <>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 mt-4">{t('mk.seatsLabel')}</label>
            <div className="flex items-center gap-3">
              <button onClick={() => setSeats((s) => Math.max(1, s - 1))} className="w-8 h-8 rounded-full bg-dp-surface-container-high flex items-center justify-center cursor-pointer"><Minus size={14} /></button>
              <span className="font-sans text-[15px] font-bold ltr-num w-8 text-center">{seats}</span>
              <button onClick={() => setSeats((s) => Math.min(available, s + 1))} className="w-8 h-8 rounded-full bg-dp-secondary text-white flex items-center justify-center cursor-pointer"><Plus size={14} /></button>
            </div>

            {isFlex && (
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">{t('mp.flexEstimateNote').replace('{n}', String(seatsBookedSoFar + seats))}</p>
            )}
            <div className="flex items-center justify-between pt-3 mt-3 border-t border-dp-outline-variant">
              <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('mp.cartTotal')}</p>
              <p className="font-heading text-[19px] font-bold text-dp-secondary">{fmt(total)}</p>
            </div>

            {isPerOrder ? (
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-secondary-container/40 rounded-lg px-3 py-2.5 mt-4">{t('cm.payDirectlyNote')}</p>
            ) : (
              <>
                <div className="mt-4">
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
                  <select value={method} onChange={(e) => setMethod(e.target.value)} className="input-field">
                    <option value="cash">{t('w.cash')}</option>
                    <option value="jazzcash">{t('w.jazzcash')}</option>
                    <option value="easypaisa">{t('w.easypaisa')}</option>
                    <option value="bank">{t('a.bank')}</option>
                  </select>
                </div>
                <div className="mt-3">
                  <DonationReceiptUpload onUpload={setProofPath} />
                </div>
              </>
            )}
            <button onClick={submit} disabled={submitting} className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {submitting ? t('mp.placingBooking') : t('mp.bookSeatsBtn')}
            </button>
          </>
        )}
        {!wrongDay && travelDate && available === 0 && (
          <p className="font-sans text-[13px] text-dp-error mt-3">{t('mp.fullyBookedError')}</p>
        )}
      </div>
      )}

      {/* Real ask, 2026-10-21: "an alert will be sent to the riders... with
          1 seat or 2 seat available and now they can join the ride with
          one way fare" — a seat released by an offboard (RouteGroupPanel's
          own flow) shows up here for anyone, not just people already on
          the outbound leg, bookable one-way at a distance-proportional
          fare (book_standalone_return_seat). */}
      {!route.is_monthly_fixed && bookable && route.is_two_way && !wrongDay && travelDate && (returnSeatsAvailable ?? 0) > 0 && (
        <div className="bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-4 mt-4">
          <p className="font-sans text-[13px] font-bold text-[#166534]">🔄 {t('mv.returnSeatsOpenNote').replace('{n}', String(returnSeatsAvailable))}</p>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('mv.returnSeatHint')}</p>

          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 mt-3">{t('mv.pickBoardStopLabel')}</label>
          <select value={returnBoardStopId ?? ''} onChange={(e) => setReturnBoardStopId(e.target.value || null)} className="input-field">
            <option value="">{t('mv.pickBoardStopLabel')}</option>
            {stops.map((s) => (
              <option key={s.id} value={s.id}>{isUrdu && s.label_ur ? s.label_ur : s.label}</option>
            ))}
          </select>

          {isPerOrder ? (
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-secondary-container/40 rounded-lg px-3 py-2.5 mt-3">{t('cm.payDirectlyNote')}</p>
          ) : (
            <div className="mt-3">
              <DonationReceiptUpload onUpload={setReturnProofPath} />
            </div>
          )}

          <button onClick={bookReturnSeat} disabled={bookingReturn || !returnBoardStopId} className="w-full mt-3 bg-[#166534] text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-[#0f4b27] transition-all disabled:opacity-50">
            {bookingReturn ? t('mp.placingBooking') : t('mv.bookReturnSeatBtn')}
          </button>
        </div>
      )}
      <MobilityBottomNav />
    </div>
  )
}
