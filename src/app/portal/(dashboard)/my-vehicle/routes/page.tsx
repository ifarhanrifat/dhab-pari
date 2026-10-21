'use client'

// My Routes + Bookings — its own screen, matching the design zip's
// "ROUTE BOOKINGS" screen (this used to be a section embedded on the
// driver dashboard, moved out per direct instruction). A driver creates
// and schedules their own routes here too (self-serve, migration
// 672_driver_self_post_route.sql — the comment that used to be here
// claiming creation was staff-only was stale relative to that), plus
// the day-to-day management: closing a route no longer run, and
// confirming/rejecting/cancelling bookings.
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Home screen's own "Post a daily route" card or the Jobs
// tab's route rows.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { MapPin, Signpost, CheckCircle2, XCircle, Ban, Clock, Plus, Megaphone, Users, Route as RouteIcon, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { fetchRoadRouteAlternatives, fetchMultiWaypointRoute, type RoadRouteAlternative } from '@/lib/roadRoute'
import { RouteStopsEditor } from '@/components/mobility/RouteStopsEditor'
import { RouteGroupPanel } from '@/components/mobility/RouteGroupPanel'
import { RouteMonthlySubscribersPanel } from '@/components/mobility/RouteMonthlySubscribersPanel'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

const DAYS = [0, 1, 2, 3, 4, 5, 6]
// Real ask, 2026-10-20: "remove the set of destination in english,
// there is no need for that, destination and starting point will be
// in urdu" — one name per end now, always Urdu, sent as both
// p_origin/p_origin_ur (and destination's equivalent) so every display
// path (Urdu or not) shows the same real name instead of an English
// one that was never wanted.
const emptyRouteForm = {
  origin: '', destination: '',
  classification: 'intercity', fare_mode: 'fixed', total_fare_pkr: '' as string | number,
  // Real ask, 2026-10-21: whether a route also runs back used to be
  // implied purely by whether the driver happened to fill in the
  // optional return-time field below — nothing told them filling it in
  // is what makes "Start Return Trip" show up later. Now an explicit
  // choice; toggling it off always clears return_departure_time so a
  // half-filled field can never silently leave a route two-way.
  is_two_way: false,
  departure_time: '', return_departure_time: '', days_of_week: [] as number[], distance_km: '' as string,
  is_monthly_fixed: false, monthly_reference_fee_pkr: '' as string | number,
}

interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface Route {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_mode: string; fare_per_seat_pkr: number; total_fare_pkr: number | null; is_active: boolean
  departure_time: string | null; return_departure_time: string | null; days_of_week: number[]
  route_path: { lat: number; lng: number }[] | null; route_duration_min: number | null
  is_monthly_fixed: boolean; monthly_reference_fee_pkr: number | null
}
interface RouteIlan { id: string; vehicle_route_id: string; status: string; is_paused: boolean; ends_at: string; created_at: string }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleRoutesPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const router = useRouter()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [commissionMode, setCommissionMode] = useState<string | null>(null)
  const [totalSeats, setTotalSeats] = useState<number | null>(null)
  const [routeFairPerSeat, setRouteFairPerSeat] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [routes, setRoutes] = useState<Route[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [ilansByRoute, setIlansByRoute] = useState<Record<string, RouteIlan>>({})
  const [actionId, setActionId] = useState<string | null>(null)
  const [closingRouteId, setClosingRouteId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyRouteForm)
  const [posting, setPosting] = useState(false)
  // Real gap found live, 2026-10-20: this form's distance_km was a bare
  // guessed number the driver typed in — no map, no real coordinates
  // ever reached create_vehicle_route_self's own p_origin_lat/lng
  // params even though the RPC has long supported them. Mirrors the
  // same map-pick + OSRM-road-distance pattern just added to the Home
  // screen's quick-publish panel.
  const [originPoint, setOriginPoint] = useState<PickedLocation | null>(null)
  const [destPoint, setDestPoint] = useState<PickedLocation | null>(null)
  const [showOriginPicker, setShowOriginPicker] = useState(false)
  const [showDestPicker, setShowDestPicker] = useState(false)
  // Real ask, 2026-10-20: a driver who already knows the villages his
  // van passes through should search each one by name (search already
  // resolves a real coordinate) and have the actual route drawn
  // through all of them in order — rather than OSRM picking whatever
  // "shortest path" it wants between just the two endpoints, which may
  // not match the real road the van takes at all.
  const [viaStops, setViaStops] = useState<PickedLocation[]>([])
  const [showViaPicker, setShowViaPicker] = useState(false)
  // Real roads to a city aren't all the one obvious line a flat map
  // shows — OSRM can return several genuinely distinct driven paths
  // between the same two points; the driver picks which one he
  // actually drives rather than the system guessing. Only meaningful
  // with no via-stops — once specific villages are pinned, there's
  // only one real path threading all of them.
  const [pathOptions, setPathOptions] = useState<RoadRouteAlternative[]>([])
  const [chosenPathIdx, setChosenPathIdx] = useState(0)
  const [multiWaypointPath, setMultiWaypointPath] = useState<{ distanceKm: number; durationMin: number; path: { lat: number; lng: number }[] } | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [stopsRouteId, setStopsRouteId] = useState<string | null>(null)
  const [pendingIlanRoute, setPendingIlanRoute] = useState<{ origin: string; destination: string } | null>(null)
  const [groupRouteId, setGroupRouteId] = useState<string | null>(null)
  const [editSchedule, setEditSchedule] = useState<{ id: string; departure_time: string; return_departure_time: string; days_of_week: number[] } | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [stopCounts, setStopCounts] = useState<Record<string, number>>({})
  const [nextRunSeats, setNextRunSeats] = useState<Record<string, number>>({})
  const [monthlyActiveCounts, setMonthlyActiveCounts] = useState<Record<string, number>>({})
  const [monthlyRidersRouteId, setMonthlyRidersRouteId] = useState<string | null>(null)

  const reload = async (id: string) => {
    const [{ data: rts }, { data: b }] = await Promise.all([
      supabase.from('vehicle_routes').select('id, origin, origin_ur, destination, destination_ur, fare_mode, fare_per_seat_pkr, total_fare_pkr, is_active, departure_time, return_departure_time, days_of_week, route_path, route_duration_min, is_monthly_fixed, monthly_reference_fee_pkr')
        .eq('vehicle_id', id).order('created_at', { ascending: false }),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
        .eq('vehicle_routes.vehicle_id', id).order('created_at', { ascending: false }).limit(20),
    ])
    setRoutes(rts ?? [])
    setBookings((b ?? []) as unknown as Booking[])

    if (rts && rts.length > 0) {
      const { data: ilans } = await supabase.from('commercial_ilans')
        .select('id, vehicle_route_id, status, is_paused, ends_at, created_at')
        .in('vehicle_route_id', rts.map((r) => r.id)).order('created_at', { ascending: false })
      // Only the most recent ilan per route matters for the card's status —
      // older rejected/cancelled/expired ones from a previous "run again" don't.
      const latest: Record<string, RouteIlan> = {}
      for (const i of (ilans ?? []) as RouteIlan[]) {
        if (!latest[i.vehicle_route_id]) latest[i.vehicle_route_id] = i
      }
      setIlansByRoute(latest)

      // Real ask, 2026-10-20: the card showed nothing about its stops
      // or whether it's actually full — both now computed for every
      // active route's own next upcoming running day.
      const { data: stopRows } = await supabase.from('route_stops').select('route_id').in('route_id', rts.map((r) => r.id))
      const counts: Record<string, number> = {}
      for (const row of stopRows ?? []) counts[row.route_id] = (counts[row.route_id] ?? 0) + 1
      setStopCounts(counts)

      const activeRoutes = (rts as Route[]).filter((r) => r.is_active && !r.is_monthly_fixed)
      const seatEntries = await Promise.all(activeRoutes.map(async (r) => {
        const today = new Date()
        let nextDate: string | null = null
        for (let i = 0; i < 7; i++) {
          const d = new Date(today.getTime() + i * 86400000)
          if (r.days_of_week.includes(d.getDay())) { nextDate = d.toISOString().slice(0, 10); break }
        }
        if (!nextDate) return [r.id, null] as const
        const { data: seats } = await supabase.rpc('route_seats_available', { p_route_id: r.id, p_travel_date: nextDate })
        return [r.id, seats as number | null] as const
      }))
      setNextRunSeats(Object.fromEntries(seatEntries.filter((e): e is [string, number] => e[1] != null)))

      const monthlyFixedRoutes = (rts as Route[]).filter((r) => r.is_active && r.is_monthly_fixed)
      if (monthlyFixedRoutes.length > 0) {
        const { data: subRows } = await supabase.from('route_subscriptions').select('route_id').eq('status', 'active').in('route_id', monthlyFixedRoutes.map((r) => r.id))
        const activeCounts: Record<string, number> = {}
        for (const row of subRows ?? []) activeCounts[row.route_id] = (activeCounts[row.route_id] ?? 0) + 1
        setMonthlyActiveCounts(activeCounts)
      } else setMonthlyActiveCounts({})
    } else { setIlansByRoute({}); setStopCounts({}); setNextRunSeats({}); setMonthlyActiveCounts({}) }
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, commission_mode, total_seats').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) { setVehicleId(data.id); setCommissionMode(data.commission_mode); setTotalSeats(data.total_seats); await reload(data.id) }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const fulfillBooking = async (id: string) => {
    setActionId(id)
    const { error } = await supabase.rpc('confirm_ride_booking', { p_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingConfirmedToast'))
    if (vehicleId) reload(vehicleId)
  }
  const cancelBooking = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('reject_ride_booking', { p_booking_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingRejectedToast'))
    if (vehicleId) reload(vehicleId)
  }
  const saveSchedule = async () => {
    if (!editSchedule) return
    if (editSchedule.days_of_week.length === 0) { toast.error(t('mv.pickAtLeastOneDayError')); return }
    setSavingSchedule(true)
    const { error } = await supabase.rpc('update_vehicle_route_schedule', {
      p_route_id: editSchedule.id, p_departure_time: editSchedule.departure_time || null, p_days_of_week: editSchedule.days_of_week,
      p_return_departure_time: editSchedule.return_departure_time || null,
    })
    setSavingSchedule(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.scheduleUpdatedToast'))
    setEditSchedule(null)
    if (vehicleId) reload(vehicleId)
  }

  const closeRoute = async (routeId: string) => {
    if (!confirm(t('mp.confirmCloseRouteHint'))) return
    setClosingRouteId(routeId)
    const { data, error } = await supabase.rpc('close_vehicle_route', { p_route_id: routeId, p_reason: t('mp.driverCancelledReason') })
    setClosingRouteId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const n = (data as { bookings_cancelled?: number } | null)?.bookings_cancelled ?? 0
    toast.success(n > 0 ? t('mp.routeClosedWithBookingsToast').replace('{n}', String(n)) : t('mp.routeClosedToast'))
    if (vehicleId) reload(vehicleId)
  }
  const toggleDay = (d: number) => {
    setForm((f) => ({ ...f, days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter((x) => x !== d) : [...f.days_of_week, d].sort() }))
  }

  useEffect(() => {
    if (!originPoint || !destPoint) { setPathOptions([]); setMultiWaypointPath(null); return }
    setRouteLoading(true)
    let cancelled = false

    if (viaStops.length > 0) {
      setPathOptions([])
      const points = [originPoint, ...viaStops, destPoint].map((p) => ({ lat: p.lat, lng: p.lng }))
      fetchMultiWaypointRoute(points).then((r) => {
        if (cancelled) return
        setMultiWaypointPath(r)
        if (r) setForm((f) => ({ ...f, distance_km: String(Math.round(r.distanceKm)) }))
        setRouteLoading(false)
      })
    } else {
      setMultiWaypointPath(null)
      fetchRoadRouteAlternatives({ lat: originPoint.lat, lng: originPoint.lng }, { lat: destPoint.lat, lng: destPoint.lng }).then((options) => {
        if (cancelled) return
        setPathOptions(options)
        setChosenPathIdx(0)
        setForm((f) => ({ ...f, distance_km: String(Math.round(options[0].distanceKm)) }))
        setRouteLoading(false)
      })
    }
    return () => { cancelled = true }
  }, [originPoint?.lat, originPoint?.lng, destPoint?.lat, destPoint?.lng, viaStops])

  const chosenPath = viaStops.length > 0 ? multiWaypointPath : (pathOptions[chosenPathIdx] ?? null)
  const pickPathOption = (i: number) => {
    setChosenPathIdx(i)
    setForm((f) => ({ ...f, distance_km: String(Math.round(pathOptions[i].distanceKm)) }))
  }

  // Real bug found live, 2026-10-20: fare_band_for('route', km) is a
  // PER-SEAT fair price (same formula as trip_share, which really is
  // per-seat) — the backend ceiling now correctly scales it by this
  // vehicle's own seat count (migration 722) rather than comparing it
  // straight against the whole-vehicle total, which silently divided
  // the real per-seat price by however many seats the vehicle has.
  // This hint shows the same per-seat number the backend actually
  // enforces, plus what that means as a total for this vehicle.
  useEffect(() => {
    const km = form.distance_km ? Number(form.distance_km) : null
    if (!km || km <= 0) { setRouteFairPerSeat(null); return }
    let cancelled = false
    supabase.rpc('fare_band_for', { p_flow: 'route', p_km: km }).then(({ data }) => {
      if (!cancelled) setRouteFairPerSeat((data as { fair?: number } | null)?.fair ?? null)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.distance_km])

  const postRoute = async () => {
    if (!vehicleId || !form.origin.trim() || !form.destination.trim()) { toast.error(t('mk.nameRequired')); return }
    if (form.days_of_week.length === 0) { toast.error(t('mv.pickAtLeastOneDayError')); return }
    const distanceKm = form.distance_km ? Number(form.distance_km) : null
    const totalFare = form.total_fare_pkr ? Number(form.total_fare_pkr) : null
    const monthlyFee = form.monthly_reference_fee_pkr ? Number(form.monthly_reference_fee_pkr) : null
    if (form.is_monthly_fixed) {
      if (!monthlyFee || monthlyFee <= 0) { toast.error(t('mv.enterMonthlyFeeError')); return }
    } else if (!distanceKm && (!totalFare || totalFare <= 0)) {
      // A distance lets the backend compute the fair fare on its own
      // (and reject anything typed above it) — only require a manually
      // typed total fare when no distance is given at all.
      toast.error(t('mv.enterTotalFareError')); return
    }
    setPosting(true)
    // Urdu is now the only name collected (real ask: "there is no need
    // for [English]... destination and starting point will be in
    // urdu") — sent as both the plain and _ur fields so every existing
    // display path (which falls back to the plain field when not in
    // Urdu mode) still shows this same real name instead of defaulting
    // to blank or some other language.
    const { data, error } = await supabase.rpc('create_vehicle_route_self', {
      p_vehicle_id: vehicleId,
      p_origin: form.origin, p_origin_ur: form.origin || null,
      p_destination: form.destination, p_destination_ur: form.destination || null,
      p_classification: form.classification, p_fare_mode: form.fare_mode, p_total_fare_pkr: totalFare,
      p_departure_time: form.departure_time || null, p_return_departure_time: form.is_two_way ? (form.return_departure_time || null) : null, p_days_of_week: form.days_of_week,
      p_distance_km: distanceKm,
      p_origin_lat: originPoint?.lat ?? null, p_origin_lng: originPoint?.lng ?? null,
      p_destination_lat: destPoint?.lat ?? null, p_destination_lng: destPoint?.lng ?? null,
      p_route_path: chosenPath ? chosenPath.path : null, p_route_duration_min: chosenPath ? chosenPath.durationMin : null,
      p_is_monthly_fixed: form.is_monthly_fixed, p_monthly_reference_fee_pkr: monthlyFee,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }

    const routeId = data as string

    // Each named via-stop the driver searched and pinned becomes a
    // real stop, in order, with its own real searched label — no
    // Photon guessing needed here, the driver already told us exactly
    // what each one is.
    for (let i = 0; i < viaStops.length; i++) {
      const v = viaStops[i]
      await supabase.rpc('create_route_stop', {
        p_route_id: routeId, p_label: v.label, p_label_ur: v.label, p_lat: v.lat, p_lng: v.lng, p_village_id: null, p_stop_order: i + 1,
      })
    }

    toast.success(t('mv.routePosted'))
    setShowForm(false)
    setPendingIlanRoute({ origin: form.origin, destination: form.destination })
    setForm(emptyRouteForm)
    setOriginPoint(null)
    setDestPoint(null)
    setViaStops([])
    setPathOptions([])
    setChosenPathIdx(0)
    setMultiWaypointPath(null)
    if (vehicleId) reload(vehicleId)
    // Real ask, 2026-10-20: "i cant see manage stops feature anywhere
    // while setting the weekly route" — it was a card action the
    // driver had to go find afterward. Opening it immediately, right
    // where creation just finished, is what actually makes it
    // discoverable — skipped when stops were already pinned above,
    // since there's nothing left to add; the driver can still reopen
    // it later from the route card to add more.
    if (viaStops.length === 0) setStopsRouteId(routeId)
    else if (confirm(t('mv.advertiseThisRidePrompt'))) {
      router.push(`/portal/my-vehicle/ilan?route=${routeId}&origin=${encodeURIComponent(form.origin)}&destination=${encodeURIComponent(form.destination)}`)
    }
  }

  const cancelConfirmedBooking = async (id: string) => {
    if (!confirm(t('mp.confirmCancelConfirmedHint'))) return
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('cancel_ride_booking', { p_booking_id: id, p_reason: reason || t('mp.driverCancelledReason') })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingCancelledToast'))
    if (vehicleId) reload(vehicleId)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicleId) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Signpost size={19} /> {t('mp.myRoutesHeading')}</h1>
        <button onClick={() => setShowForm((v) => !v)} className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-semibold cursor-pointer">
          <Plus size={14} /> {t('mv.postRouteBtn')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5 flex flex-col gap-2.5">
          <p className="font-sans text-[13px] font-bold text-[#1e293b]">{t('mv.postRouteHeading')}</p>

          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] -mb-1">{t('mv.routeBasicsSectionLabel')}</p>
          <div className="grid grid-cols-2 gap-2">
            <input value={form.origin} onChange={(e) => setForm((f) => ({ ...f, origin: e.target.value }))} placeholder={t('mv.originUrPlaceholder')} dir="rtl" className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            <input value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))} placeholder={t('mv.destinationUrPlaceholder')} dir="rtl" className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.classificationLabel')}</label>
              <select value={form.classification} onChange={(e) => setForm((f) => ({ ...f, classification: e.target.value }))} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="intercity">{t('mv.classification.intercity')}</option>
                <option value="out_of_city">{t('mv.classification.out_of_city')}</option>
              </select>
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fareModeLabel')}</label>
              <select value={form.fare_mode} onChange={(e) => setForm((f) => ({ ...f, fare_mode: e.target.value }))} disabled={form.is_monthly_fixed} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] disabled:opacity-40">
                <option value="fixed">{t('mv.fareMode.fixed')}</option>
                <option value="flex">{t('mv.fareMode.flex')}</option>
              </select>
            </div>
          </div>

          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] -mb-1 mt-1">{t('mv.routePricingSectionLabel')}</p>
          {/* Real ask, 2026-10-20: "these vehicles can be monthly
              fixed... fix lumpsum charges per month... whether they
              travel or no travel, they must need to pay" — a second
              model alongside the normal per-date open booking above,
              for a school/teacher van with the same riders every day. */}
          <label className="flex items-center gap-2 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] font-semibold text-[#1e293b] cursor-pointer">
            <input type="checkbox" checked={form.is_monthly_fixed} onChange={(e) => setForm((f) => ({ ...f, is_monthly_fixed: e.target.checked }))} />
            {t('mv.monthlyFixedToggleLabel')}
          </label>
          {form.is_monthly_fixed && (
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.monthlyReferenceFeeLabel')}</label>
              <input type="number" value={form.monthly_reference_fee_pkr} onChange={(e) => setForm((f) => ({ ...f, monthly_reference_fee_pkr: e.target.value }))} placeholder={t('mv.monthlyReferenceFeePlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              <p className="font-sans text-[10.5px] text-[#64748b] mt-1">{t('mv.monthlyReferenceFeeHint')}</p>
            </div>
          )}
          {showOriginPicker ? (
            <LocationPickerSheet
              title={t('mv.pickOriginOnMapBtn')}
              initial={originPoint}
              inline
              onClose={() => setShowOriginPicker(false)}
              onConfirm={(loc) => { setOriginPoint(loc); setShowOriginPicker(false) }}
            />
          ) : showDestPicker ? (
            <LocationPickerSheet
              title={t('mv.pickDestinationOnMapBtn')}
              initial={destPoint}
              defaultCenter={originPoint ? [originPoint.lat, originPoint.lng] : undefined}
              inline
              onClose={() => setShowDestPicker(false)}
              onConfirm={(loc) => { setDestPoint(loc); setShowDestPicker(false) }}
            />
          ) : showViaPicker ? (
            <LocationPickerSheet
              title={t('mv.addViaStopBtn')}
              defaultCenter={originPoint ? [originPoint.lat, originPoint.lng] : undefined}
              inline
              onClose={() => setShowViaPicker(false)}
              onConfirm={(loc) => { setViaStops((rows) => [...rows, loc]); setShowViaPicker(false) }}
            />
          ) : (
            <>
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] -mb-1 mt-1">{t('mv.routePathSectionLabel')}</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setShowOriginPicker(true)} className="flex items-center gap-1.5 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[12px] font-semibold text-start cursor-pointer">
                  <MapPin size={13} className="shrink-0 text-[#166534]" />
                  <span className={`truncate ${originPoint ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{originPoint ? originPoint.label : t('mv.pickOriginOnMapBtn')}</span>
                </button>
                <button type="button" onClick={() => setShowDestPicker(true)} className="flex items-center gap-1.5 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[12px] font-semibold text-start cursor-pointer">
                  <MapPin size={13} className="shrink-0 text-[#D4AF37]" />
                  <span className={`truncate ${destPoint ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{destPoint ? destPoint.label : t('mv.pickDestinationOnMapBtn')}</span>
                </button>
              </div>
              <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">{t('mv.routeMapPointsHint')}</p>

              {/* Real ask, 2026-10-20: search each village by name (the
                  search already resolves a real coordinate, confirmed
                  working) and route through all of them in order —
                  rather than letting OSRM guess a path between just
                  origin/destination that may not match the real road
                  the van takes through its known villages. */}
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.viaStopsLabel')}</label>
                {viaStops.length > 0 && (
                  <div className="flex flex-col gap-1 mb-1.5">
                    {viaStops.map((v, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-lg bg-[#f0fdf4] px-2.5 py-1.5">
                        <span className="shrink-0 w-5 h-5 rounded-full bg-[#166534] text-white text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                        <span className="flex-1 min-w-0 font-sans text-[12px] font-semibold text-[#166534] truncate">{v.label}</span>
                        <button type="button" onClick={() => setViaStops((rows) => rows.filter((_, idx) => idx !== i))} className="shrink-0 font-sans text-[11px] font-bold text-[#b91c1c] cursor-pointer">✕</button>
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" onClick={() => setShowViaPicker(true)} className="flex items-center justify-center gap-1.5 w-full border border-[#e5e2d0] rounded-lg py-2 font-sans text-[12px] font-semibold text-[#166534] cursor-pointer">
                  <Plus size={13} /> {t('mv.addViaStopBtn')}
                </button>
              </div>

              {originPoint && destPoint && (
                <LeafletMap
                  pins={[
                    { lat: originPoint.lat, lng: originPoint.lng, color: '#166534' },
                    ...viaStops.map((v) => ({ lat: v.lat, lng: v.lng, color: '#166534', emoji: '📍' })),
                    { lat: destPoint.lat, lng: destPoint.lng, color: '#D4AF37' },
                  ]}
                  route={chosenPath?.path}
                  height={140} className="rounded-xl"
                />
              )}
              {originPoint && destPoint && routeLoading && (
                <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">{t('action.loading')}</p>
              )}
              {originPoint && destPoint && viaStops.length === 0 && pathOptions.length > 1 && (
                <div>
                  <p className="font-sans text-[11px] font-bold text-[#005A36]">{t('mv.routePathOptionsHeading')}</p>
                  <p className="font-sans text-[10px] text-[#64748b] mb-1.5">{t('mv.routePathOptionsHint')}</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {pathOptions.map((opt, i) => (
                      <button key={i} type="button" onClick={() => pickPathOption(i)}
                        className="px-2.5 py-1.5 rounded-full text-[11px] font-sans font-semibold cursor-pointer border"
                        style={{ background: chosenPathIdx === i ? '#166534' : '#F9F9F6', color: chosenPathIdx === i ? '#fff' : '#334155', borderColor: chosenPathIdx === i ? '#166534' : '#e5e2d0' }}>
                        {t('mv.routePathOption').replace('{n}', String(i + 1))} · {Math.round(opt.distanceKm)}km
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {originPoint && destPoint && !routeLoading && chosenPath && (
                <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">🛣️ {Math.round(chosenPath.distanceKm)} km</p>
              )}

              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('cm.distanceKmOptionalLabel')}</label>
                <input type="number" value={form.distance_km} onChange={(e) => setForm((f) => ({ ...f, distance_km: e.target.value }))} placeholder={t('cm.distanceKmPlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </div>
            </>
          )}
          {!form.is_monthly_fixed && (
          <input type="number" value={form.total_fare_pkr} onChange={(e) => setForm((f) => ({ ...f, total_fare_pkr: e.target.value }))} placeholder={t('mv.totalFarePlaceholder')} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          )}
          {totalSeats != null && (
            <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">{t('mv.yourVehicleSeatsNote').replace('{n}', String(totalSeats))}</p>
          )}
          {!form.is_monthly_fixed && routeFairPerSeat != null && (
            <p className="font-sans text-[11.5px] text-[#166534] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg px-2.5 py-1.5">
              {t('mv.routeFairPriceHint').replace('{perSeat}', fmt(Math.round(routeFairPerSeat))).replace('{total}', fmt(Math.round(routeFairPerSeat * (totalSeats ?? 1)))).replace('{n}', String(totalSeats ?? 1))}
            </p>
          )}
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] -mb-1 mt-1">{t('mv.routeScheduleSectionLabel')}</p>
          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.departureTimeLabel')}</label>
            <input type="time" value={form.departure_time} onChange={(e) => setForm((f) => ({ ...f, departure_time: e.target.value }))} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full" />
          </div>
          {/* Real ask, 2026-10-21: "the return ride button is displaying
              like going back empty? why?" traced back to this form never
              asking whether a route runs back at all — two-way used to be
              implied purely by whether the optional return-time field
              below happened to get filled in, with nothing explaining
              that connection. An explicit toggle now owns that decision;
              turning it off always clears return_departure_time. */}
          <label className="flex items-center gap-2 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] font-semibold text-[#1e293b] cursor-pointer">
            <input type="checkbox" checked={form.is_two_way} onChange={(e) => setForm((f) => ({ ...f, is_two_way: e.target.checked, return_departure_time: e.target.checked ? f.return_departure_time : '' }))} />
            {t('mv.isTwoWayToggleLabel')}
          </label>
          {form.is_two_way && (
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('cm.returnDepartureTimeLabel')}</label>
              <input type="time" value={form.return_departure_time} onChange={(e) => setForm((f) => ({ ...f, return_departure_time: e.target.value }))} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full" />
            </div>
          )}
          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.daysOfWeekLabel')}</label>
            <div className="flex gap-1.5 flex-wrap">
              {DAYS.map((d) => (
                <button key={d} type="button" onClick={() => toggleDay(d)} className={`px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer ${form.days_of_week.includes(d) ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                  {t(`mv.dayShort.${d}`)}
                </button>
              ))}
            </div>
          </div>
          <button onClick={postRoute} disabled={posting} className="mt-1 px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {t('mv.postRouteSubmitBtn')}
          </button>
        </div>
      )}

      {routes.length === 0 && !showForm && <p className="font-sans text-[13px] text-[#94a3b8] text-center py-6">{t('mv.noRoutesYet')}</p>}

      {routes.length > 0 && (
        <div className="flex flex-col gap-2">
          {routes.map((r) => {
            const ilan = ilansByRoute[r.id]
            const ilanLive = ilan && ilan.status === 'approved' && !ilan.is_paused && new Date(ilan.ends_at).getTime() > Date.now()
            const ilanPending = ilan && ilan.status === 'pending_approval'
            const ilanPaused = ilan && ilan.status === 'approved' && ilan.is_paused && new Date(ilan.ends_at).getTime() > Date.now()
            const ilanHref = `/portal/my-vehicle/ilan?route=${r.id}&origin=${encodeURIComponent(isUrdu && r.origin_ur ? r.origin_ur : r.origin)}&destination=${encodeURIComponent(isUrdu && r.destination_ur ? r.destination_ur : r.destination)}`
            return (
              <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[13.5px] font-semibold text-[#1e293b] truncate flex items-center gap-1"><Signpost size={12} className="shrink-0 text-[#166534]" /> {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
                    <p className="font-sans text-[12px] text-[#64748b] mt-0.5">
                      {r.is_monthly_fixed
                        ? `${t('mv.monthlyReferenceFeeLabel')}: ${fmt(r.monthly_reference_fee_pkr ?? 0)}`
                        : r.fare_mode === 'flex' ? `${t('mp.flexModeLabel')} · ${fmt(r.total_fare_pkr ?? 0)} ${t('mp.totalSuffix')}` : `${fmt(r.fare_per_seat_pkr)} ${t('mk.perSeat')}`}
                      {!r.is_active && ` · ${t('mp.routeClosedLabel')}`}
                    </p>
                    {(r.departure_time || r.return_departure_time) && (
                      <p className="font-sans text-[11px] text-[#64748b] mt-0.5 ltr-num">
                        {r.departure_time && `🕒 ${r.departure_time.slice(0, 5)}`}
                        {r.return_departure_time && ` · ↩️ ${r.return_departure_time.slice(0, 5)}`}
                      </p>
                    )}
                    {r.is_active && (
                      <div className="flex items-center gap-2 mt-1">
                        {stopCounts[r.id] > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#F9F9F6] font-sans text-[10px] font-semibold text-[#334155]">
                            📍 {stopCounts[r.id]} {t('mp.routeStopsHeading')}
                          </span>
                        )}
                        {r.is_monthly_fixed ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 font-sans text-[10px] font-bold text-amber-700">
                            ✅ {t('mv.monthlyFixedBadge')} · {t('mv.seatsOfTotal').replace('{active}', String(monthlyActiveCounts[r.id] ?? 0)).replace('{total}', String(totalSeats ?? '?'))}
                          </span>
                        ) : nextRunSeats[r.id] != null && (
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-sans text-[10px] font-bold ${nextRunSeats[r.id] > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-[#b91c1c]'}`}>
                            {nextRunSeats[r.id] > 0 ? `🪑 ${nextRunSeats[r.id]} ${t('mv.seatsLeftSuffix')}` : t('mp.fullyBookedError')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {r.is_active && (
                    <button onClick={() => closeRoute(r.id)} disabled={closingRouteId === r.id} className="shrink-0 px-2.5 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">
                      {t('mp.closeRouteBtn')}
                    </button>
                  )}
                </div>
                {r.is_active && (
                  <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
                    {ilanLive ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><Megaphone size={12} /> {t('il.adIsRunningLabel')}</span>
                    ) : ilanPending ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock size={12} /> {t('il.statusPending')}</span>
                    ) : ilanPaused ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Ban size={12} /> {t('il.pausedBadge')}</span>
                    ) : (
                      <span className="text-[11px] text-[#94a3b8]">{t('il.noAdRunningLabel')}</span>
                    )}
                    {ilanPaused ? (
                      <Link href="/portal/my-vehicle/ilan" className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-sans font-semibold cursor-pointer border border-[#166534] text-[#166534]">
                        <Megaphone size={12} /> {t('il.manageAdBtn')}
                      </Link>
                    ) : !ilanLive && !ilanPending && (
                      <Link href={ilanHref} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-sans font-semibold cursor-pointer border border-[#166534] text-[#166534]">
                        <Megaphone size={12} /> {ilan ? t('il.runAdAgainBtn') : t('il.runAdBtn')}
                      </Link>
                    )}
                  </div>
                )}
                {r.is_active && (
                  <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-[#f1f5f9]">
                    <button onClick={() => setEditSchedule({ id: r.id, departure_time: r.departure_time ?? '', return_departure_time: r.return_departure_time ?? '', days_of_week: r.days_of_week ?? [] })}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#334155]">
                      <Pencil size={11} /> {t('mv.editScheduleBtn')}
                    </button>
                    <button onClick={() => setStopsRouteId(r.id)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#334155]">
                      <RouteIcon size={11} /> {t('mv.manageStopsBtn')}
                    </button>
                    <button onClick={() => setGroupRouteId(r.id)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#166534]">
                      <Users size={11} /> {t('mv.routeGroupBtn')}
                    </button>
                    {r.is_monthly_fixed && (
                      <button onClick={() => setMonthlyRidersRouteId(r.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-sans font-semibold cursor-pointer border border-amber-200 text-amber-700 bg-amber-50">
                        <Users size={11} /> {t('mv.manageRidersBtn')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div>
        <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('mp.bookingsHeading')}</p>
        {bookings.length === 0 && <p className="font-sans text-[13px] text-[#94a3b8] text-center py-6">{t('cm.noBookingsYet')}</p>}
        <div className="flex flex-col gap-2">
          {bookings.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate flex items-center gap-1">
                    <MapPin size={12} className="shrink-0 text-[#166534]" />
                    {b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—'}
                  </p>
                  <p className="font-sans text-[12px] text-[#64748b] mt-0.5">{new Date(b.travel_date).toLocaleDateString('en-GB')} · {b.seats} {t('mk.seatsLabel')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[14px] font-bold text-[#166534]">{fmt(b.total_amount_pkr)}</p>
                  {b.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>}
                  {b.status === 'rejected' && <span className="inline-flex items-center gap-1 text-[#b91c1c] text-[11px] font-bold" title={b.rejected_reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>}
                  {b.status === 'cancelled' && <span className="inline-flex items-center gap-1 text-[#64748b] text-[11px] font-bold"><Ban size={11} /> {t('mp.cancelledStatus')}</span>}
                  {b.status === 'announced' && commissionMode !== 'per_order' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>}
                </div>
              </div>
              {b.status === 'announced' && commissionMode === 'per_order' && (
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-[#f1f5f9]">
                  <span className="font-sans text-[11px] text-[#64748b]">{t('cm.markFulfilledHint')}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => cancelBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b] disabled:opacity-50">{t('mp.rejectBtn')}</button>
                    <button onClick={() => fulfillBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{t('cm.markFulfilledBtn')}</button>
                  </div>
                </div>
              )}
              {b.status === 'confirmed' && (
                <div className="flex items-center justify-end gap-2 mt-2.5 pt-2.5 border-t border-[#f1f5f9]">
                  <button onClick={() => cancelConfirmedBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">{t('mp.cancelBookingBtn')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {stopsRouteId && (() => {
        const r = routes.find((rt) => rt.id === stopsRouteId)
        const closingRouteId = stopsRouteId
        return (
          <RouteStopsEditor
            routeId={stopsRouteId}
            routePath={r?.route_path ?? null}
            departureTime={r?.departure_time ?? null}
            durationMin={r?.route_duration_min ?? null}
            returnDepartureTime={r?.return_departure_time ?? null}
            onClose={() => {
              setStopsRouteId(null)
              if (pendingIlanRoute) {
                const { origin, destination } = pendingIlanRoute
                setPendingIlanRoute(null)
                if (confirm(t('mv.advertiseThisRidePrompt'))) {
                  router.push(`/portal/my-vehicle/ilan?route=${closingRouteId}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`)
                }
              }
            }}
          />
        )
      })()}
      {groupRouteId && (
        <RouteGroupPanel routeId={groupRouteId} onClose={() => setGroupRouteId(null)} />
      )}
      {monthlyRidersRouteId && (
        <RouteMonthlySubscribersPanel routeId={monthlyRidersRouteId} onClose={() => { setMonthlyRidersRouteId(null); if (vehicleId) reload(vehicleId) }} />
      )}
      {editSchedule && (
        <MobilityBottomSheet title={t('mv.editScheduleHeading')} onClose={() => setEditSchedule(null)}>
          <div className="flex flex-col gap-3">
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.departureTimeLabel')}</label>
              <input type="time" value={editSchedule.departure_time} onChange={(e) => setEditSchedule({ ...editSchedule, departure_time: e.target.value })} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('cm.returnDepartureTimeLabel')}</label>
              <input type="time" value={editSchedule.return_departure_time} onChange={(e) => setEditSchedule({ ...editSchedule, return_departure_time: e.target.value })} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.daysOfWeekLabel')}</label>
              <div className="flex gap-1.5 flex-wrap">
                {DAYS.map((d) => {
                  const on = editSchedule.days_of_week.includes(d)
                  return (
                    <button key={d} type="button" onClick={() => setEditSchedule({ ...editSchedule, days_of_week: on ? editSchedule.days_of_week.filter((x) => x !== d) : [...editSchedule.days_of_week, d].sort() })}
                      className="px-2.5 py-1.5 rounded-full text-[11.5px] font-sans font-semibold cursor-pointer border"
                      style={{ background: on ? '#166534' : '#F9F9F6', color: on ? '#fff' : '#334155', borderColor: on ? '#166534' : '#e5e2d0' }}>
                      {t(['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat'][d])}
                    </button>
                  )
                })}
              </div>
            </div>
            <button onClick={saveSchedule} disabled={savingSchedule} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
              {savingSchedule ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
