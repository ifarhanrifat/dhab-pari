'use client'

// The real content of the route detail/booking experience, extracted
// from route/[routeId]/page.tsx so the exact same logic can render
// either as that standalone page (kept alive — dozens of server-side
// notifications across this app deep-link to it directly) or inside a
// popup opened from a card tap or the floating button, which is now
// the primary in-app flow. Real ask, 2026-11-06: "why not we use a
// popup module for this procedure... book, cancel, reschedule... this
// will be saved in the floating button rather than a page."
//
// Cancel reuses cancel_ride_booking (436) exactly as-is — it already
// supported a rider cancelling their own booking (with its existing
// late-cancellation cutoff), it just never had a rider-facing button
// anywhere. Reschedule is genuinely new (confirmed nothing like it
// existed for any booking type) — scoped to fixed-fare bookings only,
// since a flex-split fare depends on who else books that specific
// date and isn't safe to silently recompute here.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Minus, Plus, MapPin, Bus, Users, CalendarClock } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { FarePolicyCard } from '@/components/mobility/FarePolicyCard'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { RouteGroupPanel } from '@/components/mobility/RouteGroupPanel'
import { RequestWaitingSheet, type WaitingSummary } from '@/components/mobility/RequestWaitingSheet'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { estimateArrivalTime, estimateReturnArrivalTime } from '@/lib/roadRoute'
import type { LeafletMapHandle, MapPin as LeafletMapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_mode: string; total_fare_pkr: number | null; fare_per_seat_pkr: number; departure_time: string | null; return_departure_time: string | null; days_of_week: number[]
  origin_lat: number | null; origin_lng: number | null; destination_lat: number | null; destination_lng: number | null
  route_path: { lat: number; lng: number }[] | null; route_duration_min: number | null
  is_monthly_fixed: boolean; monthly_reference_fee_pkr: number | null
  is_two_way: boolean; return_wait_minutes: number | null
  seat_override: number | null
}
interface Vehicle { id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; total_seats: number; commission_mode: string }
interface Stop { id: string; label: string; label_ur: string | null; lat: number; lng: number; stop_order: number }
interface MonthlySubscription { id: string; status: string; monthly_fee_pkr: number; queue_position: number | null; scheduled_cancellation_at: string | null }
interface MonthlyDetail { is_monthly_fixed: boolean; monthly_reference_fee_pkr: number | null; seats_total: number; active_count: number; my_subscription: MonthlySubscription | null; my_leave_days: string[] }
interface DepositPreview { monthly_fee_pkr: number; deposit_pkr: number; days_remaining: number; days_total: number }
interface AttendanceRow { run_date: string; present: boolean; marked_at: string }
interface MyBooking { id: string; travel_date: string; seats: number; total_amount_pkr: number; status: string }

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

export function RouteDetailPanel({ routeId }: { routeId: string }) {
  const { t, isUrdu } = useLocale()
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
  const [waiting, setWaiting] = useState<{ id: string; summary: WaitingSummary } | null>(null)
  const [bookable, setBookable] = useState(true)
  const [stops, setStops] = useState<Stop[]>([])
  const [showGroup, setShowGroup] = useState(false)
  const [monthlyDetail, setMonthlyDetail] = useState<MonthlyDetail | null>(null)
  const [selectedBoardStopId, setSelectedBoardStopId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [leavingSeat, setLeavingSeat] = useState(false)
  const [leaveDate, setLeaveDate] = useState('')
  const [markingLeave, setMarkingLeave] = useState(false)
  const [myAttendance, setMyAttendance] = useState<AttendanceRow[]>([])
  const [decliningAttendance, setDecliningAttendance] = useState(false)
  const [returnSeatsAvailable, setReturnSeatsAvailable] = useState<number | null>(null)
  const [returnBoardStopId, setReturnBoardStopId] = useState<string | null>(null)
  const [returnProofPath, setReturnProofPath] = useState('')
  const [bookingReturn, setBookingReturn] = useState(false)
  const [myBookings, setMyBookings] = useState<MyBooking[]>([])
  const [actionId, setActionId] = useState<string | null>(null)
  const [reschedulingId, setReschedulingId] = useState<string | null>(null)
  const mapRef = useRef<LeafletMapHandle>(null)
  const [rescheduleDate, setRescheduleDate] = useState('')
  // Real ask, 2026-11-07: a villager boarding mid-route shouldn't pay
  // the full origin→destination fare — pick where you get on and off,
  // same distance-proportional math monthly seats already use
  // (route_fraction_remaining), now extended to ordinary per-day
  // bookings (fixed-fare routes only — see migration 822).
  const [boardStopId, setBoardStopId] = useState<string | null>(null)
  const [alightStopId, setAlightStopId] = useState<string | null>(null)
  const [segmentFraction, setSegmentFraction] = useState(1)
  const [depositPreview, setDepositPreview] = useState<DepositPreview | null>(null)
  const [applyProofPath, setApplyProofPath] = useState('')
  const [applyMethod, setApplyMethod] = useState('cash')
  const [leaveDateEnd, setLeaveDateEnd] = useState('')

  const loadMyBookings = async () => {
    if (!user) return
    const { data } = await supabase.from('ride_bookings').select('id, travel_date, seats, total_amount_pkr, status')
      .eq('route_id', routeId).eq('portal_user_id', user.id).in('status', ['announced', 'confirmed']).gte('travel_date', todayStr()).order('travel_date')
    setMyBookings((data ?? []) as MyBooking[])
  }

  useEffect(() => {
    supabase.from('vehicle_routes').select('*').eq('id', routeId).single().then(async ({ data: r }) => {
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
          const { data: att } = await supabase.rpc('my_route_attendance', { p_route_id: r.id })
          setMyAttendance((att ?? []) as AttendanceRow[])
        }
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  useEffect(() => { loadMyBookings() }, [user, routeId]) // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    if (!route || route.fare_mode === 'flex' || !boardStopId || !alightStopId) { setSegmentFraction(1); return }
    const boardStop = stops.find((s) => s.id === boardStopId)
    const alightStop = stops.find((s) => s.id === alightStopId)
    if (!boardStop || !alightStop) { setSegmentFraction(1); return }
    Promise.all([
      supabase.rpc('route_fraction_remaining', { p_route_id: route.id, p_lat: boardStop.lat, p_lng: boardStop.lng }),
      supabase.rpc('route_fraction_remaining', { p_route_id: route.id, p_lat: alightStop.lat, p_lng: alightStop.lng }),
    ]).then(([a, b]) => {
      const f = (a.data as number) - (b.data as number)
      setSegmentFraction(f > 0 ? f : 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.id, boardStopId, alightStopId, stops])

  useEffect(() => {
    if (!route?.is_monthly_fixed || monthlyDetail?.my_subscription || !selectedBoardStopId) { setDepositPreview(null); return }
    supabase.rpc('preview_monthly_deposit', { p_route_id: route.id, p_board_stop_id: selectedBoardStopId }).then(({ data }) => {
      setDepositPreview(data as DepositPreview | null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.id, route?.is_monthly_fixed, selectedBoardStopId, monthlyDetail?.my_subscription])

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
    loadMyBookings()
  }

  const isFlex = route?.fare_mode === 'flex'
  // Live estimate only — the actual charge locks in server-side
  // (place_ride_booking, migration 437) at whatever the split is the
  // moment this booking is placed. seatsBookedSoFar comes from
  // route_seats_available (already fetched, already public) rather
  // than a second query.
  const effectiveSeats = route?.seat_override ?? vehicle?.total_seats ?? 0
  const seatsBookedSoFar = isFlex && effectiveSeats && available !== null ? effectiveSeats - available : 0
  const estimatedPerSeatNow = isFlex && route?.total_fare_pkr ? route.total_fare_pkr / Math.max(1, seatsBookedSoFar + seats) : 0
  const minPerSeatIfFull = isFlex && route?.total_fare_pkr && effectiveSeats ? route.total_fare_pkr / effectiveSeats : 0
  const total = !route ? 0 : isFlex ? Math.round(seats * estimatedPerSeatNow) : Math.round(seats * route.fare_per_seat_pkr * segmentFraction)
  const isPerOrder = vehicle?.commission_mode === 'per_order'

  const submit = async () => {
    if (!route) return
    if (!travelDate) { toast.error(t('mp.pickDateFirst')); return }
    if (!isPerOrder && !proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    if ((boardStopId && !alightStopId) || (!boardStopId && alightStopId)) { toast.error(t('mv.pickBothStopsError')); return }
    setSubmitting(true)
    const { data: placed, error } = await supabase.rpc('place_ride_booking', {
      p_route_id: route.id, p_travel_date: travelDate, p_seats: seats, p_method: isPerOrder ? 'direct' : method, p_proof_url: isPerOrder ? null : proofPath,
      p_board_stop_id: boardStopId, p_alight_stop_id: alightStopId,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    // Stays on a live "waiting for the driver" popup until they confirm
    // or decline, instead of a toast and a jump back to the hub.
    setWaiting({
      id: (placed as { booking_id: string }).booking_id,
      summary: {
        vehicleLabel: vehicle ? vehicleDisplayName(vehicle.vehicle_type) : t('mv.tab.routes'), driverName: vehicle?.owner_name ?? null,
        from: isUrdu && route.origin_ur ? route.origin_ur : route.origin, to: isUrdu && route.destination_ur ? route.destination_ur : route.destination,
        amount: total, facts: [travelDate, t('rw.seats').replace('{n}', String(seats))],
      },
    })
    loadMyBookings()
  }

  const cancelMyBooking = async (bookingId: string) => {
    if (!window.confirm(t('mp.confirmCancelConfirmedHint'))) return
    setActionId(bookingId)
    const { error } = await supabase.rpc('cancel_ride_booking', { p_booking_id: bookingId, p_reason: t('mp.riderCancelledReason') })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingCancelledToast'))
    loadMyBookings()
  }

  const rescheduleBooking = async (bookingId: string) => {
    if (!rescheduleDate) return
    setActionId(bookingId)
    const { error } = await supabase.rpc('reschedule_ride_booking', { p_booking_id: bookingId, p_new_travel_date: rescheduleDate })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.bookingRescheduledToast'))
    setReschedulingId(null); setRescheduleDate('')
    loadMyBookings()
  }

  const reloadMonthlyDetail = async () => {
    if (!route) return
    const { data: md } = await supabase.rpc('route_monthly_detail', { p_route_id: route.id })
    setMonthlyDetail(md as MonthlyDetail | null)
    const { data: att } = await supabase.rpc('my_route_attendance', { p_route_id: route.id })
    setMyAttendance((att ?? []) as AttendanceRow[])
  }

  const declineTodaysAttendance = async () => {
    if (!monthlyDetail?.my_subscription) return
    setDecliningAttendance(true)
    const { error } = await supabase.rpc('decline_todays_attendance', { p_subscription_id: monthlyDetail.my_subscription.id })
    setDecliningAttendance(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.attendanceDeclinedToast'))
    reloadMonthlyDetail()
  }

  const applyForSeat = async () => {
    if (!route || !selectedBoardStopId) { toast.error(t('mv.pickBoardStopLabel')); return }
    if (!isPerOrder && (depositPreview?.deposit_pkr ?? 0) > 0 && !applyProofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setApplying(true)
    const { error } = await supabase.rpc('apply_for_monthly_seat', {
      p_route_id: route.id, p_board_stop_id: selectedBoardStopId,
      p_method: isPerOrder ? 'direct' : applyMethod, p_proof_url: isPerOrder ? null : (applyProofPath || null),
    })
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

  const markLeave = async () => {
    if (!monthlyDetail?.my_subscription || !leaveDate) return
    setMarkingLeave(true)
    const { error } = await supabase.rpc('mark_subscription_leave_day', {
      p_subscription_id: monthlyDetail.my_subscription.id, p_leave_date: leaveDate, p_leave_date_end: leaveDateEnd || null,
    })
    setMarkingLeave(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.leaveDayMarkedToast'))
    setLeaveDate(''); setLeaveDateEnd('')
    reloadMonthlyDetail()
  }

  const cancelLeave = async (date: string) => {
    if (!monthlyDetail?.my_subscription) return
    const { error } = await supabase.rpc('cancel_subscription_leave_day', { p_subscription_id: monthlyDetail.my_subscription.id, p_leave_date: date })
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reloadMonthlyDetail()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>
  if (!route) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('mp.routeNotFound')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
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

      {route.origin_lat != null && route.origin_lng != null && route.destination_lat != null && route.destination_lng != null && (() => {
        const etas = computeStopEtas(route.route_path ?? [], route.route_duration_min, route.departure_time, stops)
        const returnEtas = computeReturnStopEtas(route.route_path ?? [], route.route_duration_min, route.return_departure_time, stops)
        // Real ask, 2026-11-06: "the map is not showing all the stops"
        // — stops are now real pins on the same map as origin/
        // destination, not a separate plain-text list, with a banner
        // popup (name + scheduled ETA) just like the live view.
        const stopPins: LeafletMapPin[] = stops.map((s, i) => {
          const name = isUrdu && s.label_ur ? s.label_ur : s.label
          const etaLine = [etas[s.id] ? `🕒 ${etas[s.id]}` : null, returnEtas[s.id] ? `↩️ ${returnEtas[s.id]}` : null].filter(Boolean).join(' · ')
          return { lat: s.lat, lng: s.lng, emoji: '📍', color: '#f59e0b', popupHtml: `<div style="font-family:sans-serif;min-width:140px"><b>${i + 1}. ${name}</b>${etaLine ? `<br/><span style="color:#166534;font-weight:600">${etaLine}</span>` : ''}</div>` }
        })
        const pins: LeafletMapPin[] = [
          { lat: route.origin_lat!, lng: route.origin_lng!, label: isUrdu && route.origin_ur ? route.origin_ur : route.origin, color: '#16a34a' },
          ...stopPins,
          { lat: route.destination_lat!, lng: route.destination_lng!, label: isUrdu && route.destination_ur ? route.destination_ur : route.destination, color: '#dc2626' },
        ]
        return (
          <>
            <div className="mt-4">
              <LeafletMap ref={mapRef} className="rounded-lg" pins={pins} route={route.route_path ?? undefined} />
            </div>
            {stops.length > 0 && (
              <div className="flex gap-2 overflow-x-auto hide-scrollbar mt-3 pb-1">
                {stops.map((s, i) => (
                  <button key={s.id} type="button" onClick={() => mapRef.current?.focusPin(i + 1)}
                    className="shrink-0 bg-white border border-dp-outline-variant rounded-xl px-2.5 py-1.5 min-w-[130px] text-start cursor-pointer">
                    <p className="font-sans text-[12px] font-semibold text-dp-on-surface truncate">{i + 1}. {isUrdu && s.label_ur ? s.label_ur : s.label}</p>
                    <p className="font-sans text-[10.5px] text-dp-on-surface-variant ltr-num">
                      {[etas[s.id] ? `🕒 ${etas[s.id]}` : null, returnEtas[s.id] ? `↩️ ${returnEtas[s.id]}` : null].filter(Boolean).join(' · ')}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </>
        )
      })()}

      <button onClick={() => setShowGroup(true)} className="w-full flex items-center justify-center gap-1.5 bg-white border border-dp-outline-variant rounded-lg p-3 mt-4 font-sans text-[13px] font-semibold text-dp-secondary cursor-pointer">
        <Users size={14} /> {t('mv.routeGroupHeading')}
      </button>
      {showGroup && <RouteGroupPanel routeId={route.id} onClose={() => setShowGroup(false)} departureTime={route.departure_time} />}

      {!route.is_monthly_fixed && myBookings.length > 0 && (
        <div className="flex flex-col gap-2 mt-4">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('mv.myUpcomingSeatsHeading')}</p>
          {myBookings.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-center justify-between gap-3">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface ltr-num">{b.travel_date} · {t('rw.seats').replace('{n}', String(b.seats))}</p>
                <p className="font-sans text-[13px] font-bold text-dp-secondary ltr-num">₨{fmt(b.total_amount_pkr)}</p>
              </div>
              {reschedulingId === b.id ? (
                <div className="flex items-center gap-1.5 mt-2">
                  <input type="date" min={todayStr()} value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} className="input-field flex-1 text-[12.5px]" />
                  <button onClick={() => rescheduleBooking(b.id)} disabled={actionId === b.id || !rescheduleDate} className="shrink-0 px-2.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold cursor-pointer disabled:opacity-50">{t('action.save')}</button>
                  <button onClick={() => { setReschedulingId(null); setRescheduleDate('') }} className="shrink-0 px-2.5 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                </div>
              ) : (
                <div className="flex items-center gap-3 mt-2">
                  <button onClick={() => { setReschedulingId(b.id); setRescheduleDate(b.travel_date) }} disabled={actionId === b.id} className="inline-flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary cursor-pointer disabled:opacity-50"><CalendarClock size={12} /> {t('mv.rescheduleBtn')}</button>
                  <button onClick={() => cancelMyBooking(b.id)} disabled={actionId === b.id} className="font-sans text-[12px] font-semibold text-dp-error cursor-pointer disabled:opacity-50">{t('mp.cancelBookingBtn')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

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
              {myAttendance.length > 0 && (() => {
                const todayRow = myAttendance.find((a) => a.run_date === todayStr())
                return (
                  <div className="bg-sky-50 border border-sky-200 rounded-lg p-2.5 flex flex-col gap-1.5">
                    <p className="font-sans text-[11.5px] font-bold text-sky-900">{t('mv.myAttendanceHeading')}</p>
                    {todayRow?.present && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-sans text-[12px] font-semibold text-sky-800">✅ {t('mv.markedPresentTodayLabel')}</span>
                        <button onClick={declineTodaysAttendance} disabled={decliningAttendance} className="text-[11.5px] font-bold text-dp-error cursor-pointer disabled:opacity-50">
                          {decliningAttendance ? t('action.saving') : t('mv.notOnboardedBtn')}
                        </button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {myAttendance.slice(0, 7).map((a) => (
                        <span key={a.run_date} className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ltr-num ${a.present ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                          {a.run_date.slice(5)}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })()}
              {monthlyDetail.my_subscription.status !== 'waitlisted' && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 flex flex-col gap-1.5">
                  <p className="font-sans text-[11.5px] font-bold text-amber-900">{t('mv.markLeaveDayHeading')}</p>
                  {monthlyDetail.my_leave_days.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {monthlyDetail.my_leave_days.map((d) => (
                        <span key={d} className="inline-flex items-center gap-1 bg-white border border-amber-300 rounded-full px-2 py-0.5 font-sans text-[11px] text-amber-800 ltr-num">
                          {d} <button onClick={() => cancelLeave(d)} className="text-amber-500 cursor-pointer font-bold">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1.5 items-center">
                    <input type="date" value={leaveDate} min={todayStr()} onChange={(e) => setLeaveDate(e.target.value)} className="input-field flex-1 text-[12.5px]" />
                    <span className="font-sans text-[11px] text-amber-700">{t('mv.toLabel')}</span>
                    <input type="date" value={leaveDateEnd} min={leaveDate || todayStr()} onChange={(e) => setLeaveDateEnd(e.target.value)} className="input-field flex-1 text-[12.5px]" placeholder={t('mv.sameDayHint')} />
                  </div>
                  <p className="font-sans text-[10.5px] text-amber-700">{t('mv.leaveRangeHint')}</p>
                  <button onClick={markLeave} disabled={markingLeave || !leaveDate} className="w-full px-3 py-1.5 rounded-lg bg-amber-600 text-white font-sans text-[12px] font-semibold cursor-pointer disabled:opacity-50">
                    {markingLeave ? t('action.saving') : t('mv.markLeaveDayBtn')}
                  </button>
                </div>
              )}
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
              {depositPreview && (
                <div className="bg-sky-50 border border-sky-200 rounded-lg p-2.5 flex flex-col gap-1">
                  <p className="font-sans text-[12px] text-sky-900">{t('mv.monthlyFeeLabel')}: <span className="font-bold ltr-num">₨{fmt(depositPreview.monthly_fee_pkr)}</span></p>
                  {depositPreview.deposit_pkr > 0 ? (
                    <>
                      <p className="font-sans text-[12.5px] font-bold text-sky-900">{t('mv.advanceDueLabel')}: <span className="ltr-num">₨{fmt(depositPreview.deposit_pkr)}</span></p>
                      <p className="font-sans text-[10.5px] text-sky-700 ltr-num">{t('mv.advanceDaysHint').replace('{remaining}', String(depositPreview.days_remaining)).replace('{total}', String(depositPreview.days_total))}</p>
                    </>
                  ) : (
                    <p className="font-sans text-[11.5px] text-sky-700">{t('mv.noAdvanceDueHint')}</p>
                  )}
                </div>
              )}
              {depositPreview && depositPreview.deposit_pkr > 0 && !isPerOrder && (
                <>
                  <select value={applyMethod} onChange={(e) => setApplyMethod(e.target.value)} className="input-field">
                    <option value="cash">{t('w.cash')}</option>
                    <option value="jazzcash">{t('w.jazzcash')}</option>
                    <option value="easypaisa">{t('w.easypaisa')}</option>
                    <option value="bank">{t('a.bank')}</option>
                  </select>
                  <DonationReceiptUpload onUpload={setApplyProofPath} />
                </>
              )}
              {depositPreview && depositPreview.deposit_pkr > 0 && isPerOrder && (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-secondary-container/40 rounded-lg px-3 py-2.5">{t('cm.payDirectlyNote')}</p>
              )}
              <button onClick={applyForSeat} disabled={applying || !selectedBoardStopId || (!isPerOrder && (depositPreview?.deposit_pkr ?? 0) > 0 && !applyProofPath)} className="w-full bg-dp-secondary text-white rounded-lg py-2.5 font-sans font-semibold active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
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
        {!isFlex && stops.length > 0 && (
          <div className="mb-4 pb-4 border-b border-dp-outline-variant">
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{t('mv.boardAlightHeading')}</p>
            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mv.boardStopLabel')}</label>
            <select value={boardStopId ?? ''} onChange={(e) => setBoardStopId(e.target.value || null)} className="input-field">
              <option value="">{t('mv.fullRouteOption')}</option>
              {stops.map((s) => <option key={s.id} value={s.id}>{isUrdu && s.label_ur ? s.label_ur : s.label}</option>)}
            </select>
            {boardStopId && (
              <>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1 mt-2.5">{t('mv.alightStopLabel')}</label>
                <select value={alightStopId ?? ''} onChange={(e) => setAlightStopId(e.target.value || null)} className="input-field">
                  <option value="">—</option>
                  {stops.map((s) => <option key={s.id} value={s.id}>{isUrdu && s.label_ur ? s.label_ur : s.label}</option>)}
                </select>
              </>
            )}
            {boardStopId && alightStopId && (
              <p className="font-sans text-[11.5px] text-dp-secondary mt-1.5">{t('mv.segmentFareHint').replace('{pct}', String(Math.round(segmentFraction * 100)))}</p>
            )}
          </div>
        )}
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
            <div className="mt-3"><FarePolicyCard service="seat" defaultOpen={false} /></div>
            <button onClick={submit} disabled={submitting} className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold active:scale-[0.98] cursor-pointer hover:bg-dp-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
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
      {waiting && (
        <RequestWaitingSheet kind="seat" bookingId={waiting.id} summary={waiting.summary}
          onClose={() => setWaiting(null)}
          onViewBooking={() => { setWaiting(null); router.push('/portal/marketplace/trips') }} />
      )}
    </div>
  )
}
