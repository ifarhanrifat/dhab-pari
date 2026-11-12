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
import { useRouter, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { MapPin, Signpost, CheckCircle2, XCircle, Ban, Clock, Plus, Megaphone, Users, Route as RouteIcon, Pencil, ArrowLeft } from 'lucide-react'
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
import { CityReturnDemandCard } from '@/components/mobility/CityReturnDemandCard'
import { SeatPickerField } from '@/components/mobility/SeatPickerField'

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
  // Real ask, 2026-11-11: fare mode is driver-chosen again, for every
  // vehicle kind alike (848) — "keep them all same" rather than
  // locking cars to flat and vans to local. 'fixed' = local, stop-to-
  // stop fare; 'flex' = non-stop, flat fare regardless of stop. The
  // default is reset per-vehicle in selectVehicle()/the mount effect
  // below to match what each vehicle kind used to do automatically,
  // but it's always overridable here now.
  classification: 'intercity', fare_mode: 'fixed', total_fare_pkr: '' as string | number,
  // Real ask, 2026-10-21: whether a route also runs back used to be
  // implied purely by whether the driver happened to fill in the
  // optional return-time field below — nothing told them filling it in
  // is what makes "Start Return Trip" show up later. Now an explicit
  // choice; toggling it off always clears return_departure_time so a
  // half-filled field can never silently leave a route two-way.
  is_two_way: false, return_wait_minutes: 300 as number,
  departure_time: '', return_departure_time: '', days_of_week: [] as number[], distance_km: '' as string,
  is_monthly_fixed: false, monthly_reference_fee_pkr: '' as string | number,
  // 864: optional, cosmetic/organizational route label shown on the
  // fleet dashboard's schedule cards and bookings list (e.g. "PK-KH101").
  service_code: '',
}

interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null; seat_accepted_at: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface Route {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_mode: string; fare_per_seat_pkr: number; total_fare_pkr: number | null; is_active: boolean
  departure_time: string | null; return_departure_time: string | null; days_of_week: number[]
  route_path: { lat: number; lng: number }[] | null; route_duration_min: number | null
  is_monthly_fixed: boolean; monthly_reference_fee_pkr: number | null
  is_two_way: boolean; return_wait_minutes: number | null
  seat_override: number | null
  service_code: string | null
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
  const [isSleeper, setIsSleeper] = useState(false)
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
  // Real ask, 2026-11-11: the driver home page's two buttons
  // (?mode=monthly / ?mode=regular) replace the old single "Post a
  // route" entry point — reaching this page with one of those params
  // auto-opens the form with is_monthly_fixed implied, hiding the
  // checkbox entirely since it's no longer a decision to make here.
  // No param (an old bookmark, or "manage route" when one already
  // exists) keeps today's behaviour, checkbox and all.
  const searchParams = useSearchParams()
  const [modeLocked, setModeLocked] = useState<'monthly' | 'regular' | null>(null)
  // Real ask: "just once, on this date" absorbs the retired home-page
  // quick-poster's one real capability — a true one-off post, not a
  // weekly recurrence. Only meaningful for a non-monthly route.
  const [recurrence, setRecurrence] = useState<'weekly' | 'once'>('weekly')
  const [oneOffDate, setOneOffDate] = useState('')
  // Minimal fleet-booker support (844): a driver who owns a fleet with
  // more than just their own vehicle picks which one this route is
  // for; everyone else never sees this at all.
  const [fleetVehicles, setFleetVehicles] = useState<{ id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }[]>([])
  // 855: a counter sells against the SAME shared seat pool a rider's
  // own app booking would — no separate inventory to keep in sync.
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [fleetCounters, setFleetCounters] = useState<{ id: string; city: string; name: string | null }[]>([])
  const [manualBookingRouteId, setManualBookingRouteId] = useState<string | null>(null)
  const [manualCounterId, setManualCounterId] = useState('')
  const [manualPassengerName, setManualPassengerName] = useState('')
  const [manualPassengerMobile, setManualPassengerMobile] = useState('')
  const [manualSeats, setManualSeats] = useState(1)
  const [manualAmount, setManualAmount] = useState('')
  const [manualMethod, setManualMethod] = useState('cash')
  const [manualSeatNumbers, setManualSeatNumbers] = useState<number[]>([])
  const [manualTakenSeats, setManualTakenSeats] = useState<number[]>([])
  const [recordingManual, setRecordingManual] = useState(false)

  // 856: route-aware luggage, own fare, separate from a seat sale —
  // staff enters the fare directly, same "cashier physically present"
  // logic as a walk-up seat sale.
  const [luggageRouteId, setLuggageRouteId] = useState<string | null>(null)
  const [luggageCounterId, setLuggageCounterId] = useState('')
  const [senderName, setSenderName] = useState('')
  const [senderMobile, setSenderMobile] = useState('')
  const [receiverName, setReceiverName] = useState('')
  const [receiverMobile, setReceiverMobile] = useState('')
  const [luggageDescription, setLuggageDescription] = useState('')
  const [luggageFare, setLuggageFare] = useState('')
  const [luggageMethod, setLuggageMethod] = useState('cash')
  const [recordingLuggage, setRecordingLuggage] = useState(false)
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)
  // 848: which vehicle's own kind decides the sensible default for the
  // Local/Non-stop fare toggle below (van-kind used to default to
  // local/fixed automatically, car/suv to non-stop/flex) — still just
  // a default now, always overridable by the driver for any kind.
  const [vehicleKind, setVehicleKind] = useState<string | null>(null)
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
  const [editSchedule, setEditSchedule] = useState<{ id: string; departure_time: string; return_departure_time: string; days_of_week: number[]; is_two_way: boolean; return_wait_minutes: number; seat_override: string } | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [stopCounts, setStopCounts] = useState<Record<string, number>>({})
  const [nextRunSeats, setNextRunSeats] = useState<Record<string, number>>({})
  const [monthlyActiveCounts, setMonthlyActiveCounts] = useState<Record<string, number>>({})
  const [monthlyRidersRouteId, setMonthlyRidersRouteId] = useState<string | null>(null)
  const [handOffRouteId, setHandOffRouteId] = useState<string | null>(null)
  const [handOffSearch, setHandOffSearch] = useState('')
  const [handOffResults, setHandOffResults] = useState<{ id: string; owner_name: string; vehicle_number: string | null; vehicle_type: string }[]>([])
  const [handingOff, setHandingOff] = useState(false)
  const [coveringToday, setCoveringToday] = useState<{ route_id: string; origin: string; destination: string; departure_time: string | null; reason: string }[]>([])
  // Real bug found 2026-11-07 ("garbage... why there is plenty of
  // garbage is displaying"): this list had zero filtering — every
  // booking ever made on this vehicle's routes, including months-old
  // cancelled/rejected/expired ones, sat in one flat dump with no way
  // to tell a real pending confirmation apart from old noise. Same
  // active/past segmented pattern the rider's own Bookings list already
  // uses, so a driver sees what needs attention by default.
  const [bookingsSeg, setBookingsSeg] = useState<'active' | 'past'>('active')

  const reload = async (id: string) => {
    const [{ data: rts }, { data: b }] = await Promise.all([
      supabase.from('vehicle_routes').select('id, origin, origin_ur, destination, destination_ur, fare_mode, fare_per_seat_pkr, total_fare_pkr, is_active, departure_time, return_departure_time, days_of_week, route_path, route_duration_min, is_monthly_fixed, monthly_reference_fee_pkr, is_two_way, return_wait_minutes, seat_override, service_code')
        .eq('vehicle_id', id).order('created_at', { ascending: false }),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, seat_accepted_at, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
        .eq('vehicle_routes.vehicle_id', id).order('created_at', { ascending: false }).limit(20),
    ])
    setRoutes(rts ?? [])
    setBookings((b ?? []) as unknown as Booking[])
    supabase.rpc('my_substitute_assignments_today').then(({ data }) => setCoveringToday((data ?? []) as typeof coveringToday))

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

  // 848: looks up a vehicle's vehicle_kind (van/car/suv, via its
  // category) purely to pick a sensible default for the Local/Non-stop
  // fare toggle — never used to gate or lock anything anymore.
  const fetchVehicleKind = async (id: string): Promise<string | null> => {
    const { data: v } = await supabase.from('vehicles').select('category_id').eq('id', id).single()
    if (!v?.category_id) return null
    const { data: c } = await supabase.from('vehicle_categories').select('vehicle_kind').eq('id', v.category_id).single()
    return c?.vehicle_kind ?? null
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, commission_mode, total_seats').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) {
        setVehicleId(data.id); setCommissionMode(data.commission_mode); setTotalSeats(data.total_seats); setSelectedVehicleId(data.id)
        await reload(data.id)
        const kind = await fetchVehicleKind(data.id)
        setVehicleKind(kind)
        setForm((f) => ({ ...f, fare_mode: kind === 'van' ? 'fixed' : 'flex' }))
      }
      // Real gap, 2026-11-12: a fleet owner/staff member with no personal
      // vehicle of their own (reached here from Bus Management's "Routes"
      // link) used to get nothing at all — this whole switcher assumed
      // the signed-in account always drove a vehicle too. my_fleet_
      // vehicles/my_managed_fleet now run regardless, and the ?vehicle=
      // param (or the first fleet vehicle) seeds selectedVehicleId when
      // there's no vehicle of the user's own to default to.
      const { data: fleet } = await supabase.rpc('my_fleet_vehicles')
      const fv = (fleet ?? []) as typeof fleetVehicles
      setFleetVehicles(fv)
      const { data: mf } = await supabase.rpc('my_managed_fleet')
      const f = mf as { fleet_id: string } | null
      if (f) {
        setFleetId(f.fleet_id)
        const { data: counters } = await supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id })
        setFleetCounters((counters ?? []) as typeof fleetCounters)
      }
      if (!data && fv.length > 0) {
        const vehicleParam = searchParams.get('vehicle')
        const initial = (vehicleParam && fv.some((v) => v.id === vehicleParam)) ? vehicleParam : fv[0].id
        await selectVehicle(initial)
      }
      setLoading(false)
    })
    const mode = searchParams.get('mode')
    if (mode === 'monthly' || mode === 'regular') {
      setModeLocked(mode)
      setShowForm(true)
      setForm((f) => ({ ...f, is_monthly_fixed: mode === 'monthly' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const fulfillBooking = async (id: string) => {
    setActionId(id)
    const { error } = await supabase.rpc('confirm_ride_booking', { p_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingConfirmedToast'))
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
  }
  const cancelBooking = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('reject_ride_booking', { p_booking_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingRejectedToast'))
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
  }
  const saveSchedule = async () => {
    if (!editSchedule) return
    if (editSchedule.days_of_week.length === 0) { toast.error(t('mv.pickAtLeastOneDayError')); return }
    setSavingSchedule(true)
    const { error } = await supabase.rpc('update_vehicle_route_schedule', {
      p_route_id: editSchedule.id, p_departure_time: editSchedule.departure_time || null, p_days_of_week: editSchedule.days_of_week,
      p_return_departure_time: editSchedule.is_two_way ? (editSchedule.return_departure_time || null) : null,
      p_is_two_way: editSchedule.is_two_way, p_return_wait_minutes: editSchedule.is_two_way ? editSchedule.return_wait_minutes : null,
    })
    if (!error) {
      const seatOverride = editSchedule.seat_override.trim() ? Number(editSchedule.seat_override) : null
      await supabase.rpc('set_route_seat_override', { p_route_id: editSchedule.id, p_seat_override: seatOverride })
    }
    setSavingSchedule(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.scheduleUpdatedToast'))
    setEditSchedule(null)
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
  }

  const closeRoute = async (routeId: string) => {
    if (!confirm(t('mp.confirmCloseRouteHint'))) return
    setClosingRouteId(routeId)
    const { data, error } = await supabase.rpc('close_vehicle_route', { p_route_id: routeId, p_reason: t('mp.driverCancelledReason') })
    setClosingRouteId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const n = (data as { bookings_cancelled?: number } | null)?.bookings_cancelled ?? 0
    toast.success(n > 0 ? t('mp.routeClosedWithBookingsToast').replace('{n}', String(n)) : t('mp.routeClosedToast'))
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
  }
  // 848: picking a fleet vehicle here now does two things at once —
  // sets which vehicle a NEW route gets posted for (as before), and
  // switches the whole page's "my routes / my bookings" view to that
  // vehicle (real gap found 2026-11-11: a fleet owner could create a
  // route for another vehicle but never see/manage it afterward,
  // since this used to only ever reload the owner's OWN vehicleId).
  const selectVehicle = async (id: string) => {
    setSelectedVehicleId(id)
    const { data } = await supabase.from('vehicles').select('total_seats').eq('id', id).single()
    if (data) setTotalSeats(data.total_seats)
    const kind = await fetchVehicleKind(id)
    setVehicleKind(kind)
    setForm((f) => ({ ...f, fare_mode: kind === 'van' ? 'fixed' : 'flex' }))
    await reload(id)
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
    const postVehicleId = selectedVehicleId ?? vehicleId
    if (!postVehicleId || !form.origin.trim() || !form.destination.trim()) { toast.error(t('mk.nameRequired')); return }
    if (recurrence === 'once' && !form.is_monthly_fixed) {
      if (!oneOffDate) { toast.error(t('mv.pickOneOffDateError')); return }
    } else if (form.days_of_week.length === 0) {
      toast.error(t('mv.pickAtLeastOneDayError')); return
    }
    const oneOffDays = recurrence === 'once' && oneOffDate ? [new Date(`${oneOffDate}T00:00:00`).getDay()] : null
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
      p_vehicle_id: postVehicleId,
      p_origin: form.origin, p_origin_ur: form.origin || null,
      p_destination: form.destination, p_destination_ur: form.destination || null,
      p_classification: form.classification, p_fare_mode: form.fare_mode, p_total_fare_pkr: totalFare,
      p_departure_time: form.departure_time || null, p_return_departure_time: form.is_two_way ? (form.return_departure_time || null) : null,
      p_days_of_week: oneOffDays ?? form.days_of_week,
      p_distance_km: distanceKm,
      p_origin_lat: originPoint?.lat ?? null, p_origin_lng: originPoint?.lng ?? null,
      p_destination_lat: destPoint?.lat ?? null, p_destination_lng: destPoint?.lng ?? null,
      p_route_path: chosenPath ? chosenPath.path : null, p_route_duration_min: chosenPath ? chosenPath.durationMin : null,
      p_is_monthly_fixed: form.is_monthly_fixed, p_monthly_reference_fee_pkr: monthlyFee,
      p_is_two_way: form.is_two_way, p_return_wait_minutes: form.is_two_way ? form.return_wait_minutes : null,
      p_one_off_date: oneOffDays ? oneOffDate : null,
      p_service_code: form.service_code.trim() || null,
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
        p_route_id: routeId, p_label: v.label, p_label_ur: null, p_lat: v.lat, p_lng: v.lng, p_village_id: null, p_stop_order: i + 1,
      })
    }

    toast.success(t('mv.routePosted'))
    setShowForm(false)
    setModeLocked(null)
    setRecurrence('weekly')
    setOneOffDate('')
    setPendingIlanRoute({ origin: form.origin, destination: form.destination })
    setForm(emptyRouteForm)
    setOriginPoint(null)
    setDestPoint(null)
    setViaStops([])
    setPathOptions([])
    setChosenPathIdx(0)
    setMultiWaypointPath(null)
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
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

  const editMonthlyFee = async (r: Route) => {
    const input = window.prompt(t('mv.editMonthlyFeePrompt'), String(r.monthly_reference_fee_pkr ?? ''))
    if (input == null) return
    const fee = Number(input)
    if (!fee || fee <= 0) { toast.error(t('mv.monthlyReferenceFeeRequiredError')); return }
    const { error } = await supabase.rpc('set_route_monthly_pricing', { p_route_id: r.id, p_is_monthly_fixed: true, p_monthly_reference_fee_pkr: fee })
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.monthlyFeeUpdatedToast'))
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
  }

  useEffect(() => {
    if (!handOffRouteId || !handOffSearch.trim()) { setHandOffResults([]); return }
    const handle = setTimeout(() => {
      supabase.from('vehicles').select('id, owner_name, vehicle_number, vehicle_type').eq('is_active', true)
        .or(`owner_name.ilike.%${handOffSearch.trim()}%,vehicle_number.ilike.%${handOffSearch.trim()}%`).limit(8)
        .then(({ data }) => setHandOffResults(data ?? []))
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handOffSearch, handOffRouteId])

  const confirmHandOff = async (substituteVehicleId: string) => {
    if (!handOffRouteId) return
    setHandingOff(true)
    const { error } = await supabase.rpc('driver_request_substitute', { p_route_id: handOffRouteId, p_substitute_vehicle_id: substituteVehicleId })
    setHandingOff(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.handOffDoneToast'))
    setHandOffRouteId(null); setHandOffSearch(''); setHandOffResults([])
  }

  // 855: a counter cashier (or a solo driver with no counter at all —
  // p_counter_id is optional) logs a walk-up cash sale. isVanKindRoute
  // reuses the same vehicleKind already resolved for the fare-mode
  // default, no second lookup needed.
  const isVanKindRoute = vehicleKind === 'van'
  const openManualBooking = async (routeId: string) => {
    setManualBookingRouteId(routeId)
    setManualCounterId(''); setManualPassengerName(''); setManualPassengerMobile(''); setManualSeats(1); setManualAmount(''); setManualMethod('cash'); setManualSeatNumbers([])
    if (isVanKindRoute) {
      const { data } = await supabase.rpc('route_seat_status', { p_route_id: routeId, p_travel_date: new Date().toISOString().slice(0, 10), p_direction: 'outbound' })
      setManualTakenSeats((data as number[]) ?? [])
    }
  }
  const recordManualBooking = async () => {
    if (!manualBookingRouteId || !manualPassengerName.trim() || !manualAmount) { toast.error(t('mv.fillManualBookingError')); return }
    if (isVanKindRoute && manualSeatNumbers.length !== manualSeats) { toast.error(t('mv.pickASeatError')); return }
    setRecordingManual(true)
    const { error } = await supabase.rpc('record_manual_booking', {
      p_route_id: manualBookingRouteId, p_travel_date: new Date().toISOString().slice(0, 10), p_seats: manualSeats,
      p_passenger_name: manualPassengerName, p_total_amount_pkr: Number(manualAmount),
      p_counter_id: manualCounterId || null, p_passenger_mobile: manualPassengerMobile || null, p_payment_method: manualMethod,
      p_seat_numbers: isVanKindRoute ? manualSeatNumbers : null,
    })
    setRecordingManual(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.manualBookingRecordedToast'))
    setManualBookingRouteId(null)
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
  }

  const openLuggageBooking = (routeId: string) => {
    setLuggageRouteId(routeId)
    setLuggageCounterId(''); setSenderName(''); setSenderMobile(''); setReceiverName(''); setReceiverMobile(''); setLuggageDescription(''); setLuggageFare(''); setLuggageMethod('cash')
  }
  const recordLuggage = async () => {
    if (!luggageRouteId || !senderName.trim() || !receiverName.trim() || !receiverMobile.trim() || !luggageDescription.trim()) { toast.error(t('mv.fillLuggageError')); return }
    setRecordingLuggage(true)
    const { error } = await supabase.rpc('record_luggage_booking', {
      p_route_id: luggageRouteId, p_travel_date: new Date().toISOString().slice(0, 10),
      p_sender_name: senderName, p_receiver_name: receiverName, p_receiver_mobile: receiverMobile, p_description: luggageDescription,
      p_fare_pkr: Number(luggageFare) || 0, p_counter_id: luggageCounterId || null, p_sender_mobile: senderMobile || null, p_payment_method: luggageMethod,
    })
    setRecordingLuggage(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.luggageRecordedToast'))
    setLuggageRouteId(null)
  }

  const cancelConfirmedBooking = async (id: string) => {
    if (!confirm(t('mp.confirmCancelConfirmedHint'))) return
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('cancel_ride_booking', { p_booking_id: id, p_reason: reason || t('mp.driverCancelledReason') })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingCancelledToast'))
    const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicleId && !selectedVehicleId) return null

  return (
    <div className="flex flex-col gap-3">
      {!vehicleId && (
        <Link href="/portal/fleet/vehicles" className="inline-flex items-center gap-1 font-sans text-[12px] font-semibold text-[#166534] -mb-1">
          <ArrowLeft size={13} className={isUrdu ? 'rotate-180' : ''} /> {t('mv.busManagementHeading')}
        </Link>
      )}
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Signpost size={19} /> {t('mp.myRoutesHeading')}</h1>
        <button onClick={() => { setShowForm((v) => !v); setModeLocked(null) }} className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-semibold cursor-pointer">
          <Plus size={14} /> {t('mv.postRouteBtn')}
        </button>
      </div>

      {/* 848: persistent fleet view-switcher — only ever shown when this
          driver owns other vehicles in a fleet. Picking one here switches
          the whole page (routes, bookings, schedule edits, closing a
          route) to that vehicle, not just which vehicle a NEW route gets
          posted for. The same picker also appears inside the create-route
          form below, bound to the same selectedVehicleId. */}
      {fleetVehicles.length > 0 && (
        <div>
          <label className="block font-sans text-[11px] font-bold text-[#64748b] mb-1 uppercase tracking-[0.05em]">{t('mv.fleetViewSwitcherLabel')}</label>
          <div className="flex gap-1.5 flex-wrap">
            {[...(vehicleId ? [{ id: vehicleId, owner_name: t('mv.fleetMyOwnVehicleLabel'), vehicle_type: '', vehicle_number: null }] : []), ...fleetVehicles].map((v) => (
              <button key={v.id} type="button" onClick={() => selectVehicle(v.id)}
                className="px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer border"
                style={{ background: selectedVehicleId === v.id ? '#166534' : '#F9F9F6', color: selectedVehicleId === v.id ? '#fff' : '#334155', borderColor: selectedVehicleId === v.id ? '#166534' : '#e5e2d0' }}>
                {v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {coveringToday.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3.5 flex flex-col gap-2">
          <p className="font-sans text-[12px] font-bold text-amber-900 uppercase tracking-[0.05em]">{t('mv.coveringTodayHeading')}</p>
          {coveringToday.map((c) => (
            <button key={c.route_id} type="button" onClick={() => setGroupRouteId(c.route_id)} className="flex items-center justify-between gap-2 bg-white rounded-xl px-3 py-2 cursor-pointer">
              <span className="font-sans text-[13px] font-semibold text-[#1e293b] truncate">{c.origin} → {c.destination}</span>
              <span className="font-sans text-[10.5px] text-amber-700 shrink-0">{c.reason === 'admin_assigned' ? t('mv.coveringReasonAdminAssigned') : t('mv.coveringReasonDriverRequested')}</span>
            </button>
          ))}
        </div>
      )}

      {showForm && (
        <MobilityBottomSheet title={t('mv.postRouteHeading')} onClose={() => { setShowForm(false); setModeLocked(null); setRecurrence('weekly'); setOneOffDate('') }}>
        <div className="flex flex-col gap-2.5">
          <CityReturnDemandCard limit={6} />

          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] -mb-1">{t('mv.routeBasicsSectionLabel')}</p>
          {/* Labelled, not placeholder-only: a placeholder vanishes the moment
              a driver starts typing, leaving two identical unnamed boxes.
              dir="auto" so a name typed in English isn't forced right-aligned. */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mb.fromLabel')}</label>
              <input value={form.origin} onChange={(e) => setForm((f) => ({ ...f, origin: e.target.value }))} placeholder={t('mv.originUrPlaceholder')} dir="auto" className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mb.toLabel')}</label>
              <input value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))} placeholder={t('mv.destinationUrPlaceholder')} dir="auto" className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
          </div>
          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.classificationLabel')}</label>
            <select value={form.classification} onChange={(e) => setForm((f) => ({ ...f, classification: e.target.value }))} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
              <option value="intercity">{t('mv.classification.intercity')}</option>
              <option value="out_of_city">{t('mv.classification.out_of_city')}</option>
            </select>
          </div>

          {/* Real ask, 2026-11-11: minimal fleet-booker support — only
              ever shown when this driver actually owns other vehicles
              in a fleet; everyone else never sees this. */}
          {fleetVehicles.length > 0 && (
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fleetVehiclePickerLabel')}</label>
              <div className="flex flex-col gap-1.5">
                {[...(vehicleId ? [{ id: vehicleId, owner_name: t('mv.fleetMyOwnVehicleLabel'), vehicle_type: '', vehicle_number: null }] : []), ...fleetVehicles].map((v) => (
                  <button key={v.id} type="button" onClick={() => selectVehicle(v.id)}
                    className="flex items-center justify-between gap-2 border rounded-lg px-3 py-2 cursor-pointer text-start"
                    style={{ background: selectedVehicleId === v.id ? '#F0FDF4' : '#fff', borderColor: selectedVehicleId === v.id ? '#166534' : '#e5e2d0' }}>
                    <span className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</span>
                    {v.vehicle_number && <span className="font-sans text-[11px] text-[#64748b] ltr-num">{v.vehicle_number}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] -mb-1 mt-1">{t('mv.routePricingSectionLabel')}</p>
          {/* Real ask, 2026-11-11: fare mode driver-chosen again, same
              choice for every vehicle kind ("keep them all same" rather
              than locking cars to flat) — applies whether or not this is
              a monthly-fixed route too (monthly fee fractions by stop
              under Local, stays the full reference fee under Non-stop). */}
          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fareModeLabel')}</label>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setForm((f) => ({ ...f, fare_mode: 'fixed' }))} className="flex-1 py-1.5 rounded-lg text-[11.5px] font-sans font-bold cursor-pointer border"
                style={{ background: form.fare_mode === 'fixed' ? '#166534' : '#F9F9F6', color: form.fare_mode === 'fixed' ? '#fff' : '#64748b', borderColor: form.fare_mode === 'fixed' ? '#166534' : '#e5e2d0' }}>
                {t('mv.fareMode.fixed')}
              </button>
              <button type="button" onClick={() => setForm((f) => ({ ...f, fare_mode: 'flex' }))} className="flex-1 py-1.5 rounded-lg text-[11.5px] font-sans font-bold cursor-pointer border"
                style={{ background: form.fare_mode === 'flex' ? '#166534' : '#F9F9F6', color: form.fare_mode === 'flex' ? '#fff' : '#64748b', borderColor: form.fare_mode === 'flex' ? '#166534' : '#e5e2d0' }}>
                {t('mv.fareMode.flex')}
              </button>
            </div>
          </div>
          {/* Real ask, 2026-10-20: "these vehicles can be monthly
              fixed... fix lumpsum charges per month... whether they
              travel or no travel, they must need to pay" — a second
              model alongside the normal per-date open booking above,
              for a school/teacher van with the same riders every day.
              Real ask, 2026-11-11: reaching this form via one of the
              two home-page buttons already decides this — the checkbox
              only still shows on the old no-param entry path. */}
          {!modeLocked && (
            <label className="flex items-center gap-2 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] font-semibold text-[#1e293b] cursor-pointer">
              <input type="checkbox" checked={form.is_monthly_fixed} onChange={(e) => setForm((f) => ({ ...f, is_monthly_fixed: e.target.checked }))} />
              {t('mv.monthlyFixedToggleLabel')}
            </label>
          )}
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
          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.serviceCodeOptionalLabel')}</label>
            <input value={form.service_code} onChange={(e) => setForm((f) => ({ ...f, service_code: e.target.value }))} placeholder={t('mv.serviceCodePlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
          </div>
          {!form.is_monthly_fixed && (
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mk.totalFareLabel')}</label>
              <input type="number" value={form.total_fare_pkr} onChange={(e) => setForm((f) => ({ ...f, total_fare_pkr: e.target.value }))} placeholder={t('mv.totalFarePlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
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
            <>
              {/* Real ask, 2026-10-21: "it should work like this... it
                  could be 6 hour waiting time or 5 or 8 hours the vehicle
                  will leave on its time" — a wait window at the
                  destination, not a second static clock time. Kept
                  alongside the existing return-time field as a display
                  hint ("usually leaves around...") since drivers still
                  find a clock time easier to picture than a duration. */}
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.returnWaitMinutesLabel')}</label>
                <div className="flex gap-1.5 flex-wrap">
                  {[300, 360, 480].map((mins) => (
                    <button key={mins} type="button" onClick={() => setForm((f) => ({ ...f, return_wait_minutes: mins }))}
                      className={`px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer ${form.return_wait_minutes === mins ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                      {Math.round(mins / 60)}{t('mv.hoursShortSuffix')}
                    </button>
                  ))}
                  <input type="number" min={30} step={30} value={form.return_wait_minutes} onChange={(e) => setForm((f) => ({ ...f, return_wait_minutes: Number(e.target.value) }))}
                    className="w-24 px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" placeholder={t('mv.customMinutesPlaceholder')} />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('cm.returnDepartureTimeLabel')}</label>
                <input type="time" value={form.return_departure_time} onChange={(e) => setForm((f) => ({ ...f, return_departure_time: e.target.value }))} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full" />
              </div>
            </>
          )}
          {/* Real ask, 2026-11-11: "just once, on this date" absorbs the
              retired home-page quick-poster's one real capability.
              Monthly-fixed routes are always weekly — a one-off
              monthly subscription makes no sense. */}
          {!form.is_monthly_fixed && (
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => setRecurrence('weekly')} className="flex-1 py-1.5 rounded-lg text-[11.5px] font-sans font-bold cursor-pointer border"
                style={{ background: recurrence === 'weekly' ? '#166534' : '#F9F9F6', color: recurrence === 'weekly' ? '#fff' : '#64748b', borderColor: recurrence === 'weekly' ? '#166534' : '#e5e2d0' }}>
                {t('mv.recurrenceWeeklyBtn')}
              </button>
              <button type="button" onClick={() => setRecurrence('once')} className="flex-1 py-1.5 rounded-lg text-[11.5px] font-sans font-bold cursor-pointer border"
                style={{ background: recurrence === 'once' ? '#166534' : '#F9F9F6', color: recurrence === 'once' ? '#fff' : '#64748b', borderColor: recurrence === 'once' ? '#166534' : '#e5e2d0' }}>
                {t('mv.recurrenceOnceBtn')}
              </button>
            </div>
          )}
          {recurrence === 'once' && !form.is_monthly_fixed ? (
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.oneOffDateLabel')}</label>
              <input type="date" value={oneOffDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setOneOffDate(e.target.value)} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full ltr-num" />
            </div>
          ) : (
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
          )}
          <button onClick={postRoute} disabled={posting} className="mt-1 px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {t('mv.postRouteSubmitBtn')}
          </button>
        </div>
        </MobilityBottomSheet>
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
                    <p className="font-sans text-[13.5px] font-semibold text-[#1e293b] truncate flex items-center gap-1">
                      <Signpost size={12} className="shrink-0 text-[#166534]" /> {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}
                      {r.service_code && <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{r.service_code}</span>}
                    </p>
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
                  // Real bug found live, 2026-11-08: "these are having
                  // overflowing and not visible on the same rows" — up to
                  // 6 buttons in one non-wrapping flex row ran off-screen
                  // on a phone with no way to reach the later ones.
                  // flex-wrap lets them drop to a second row instead of
                  // being cut off; tightened padding/text keeps most of
                  // them on one row on a normal phone width.
                  <div className="flex items-center flex-wrap gap-1 mt-2 pt-2 border-t border-[#f1f5f9]">
                    <button onClick={() => setEditSchedule({ id: r.id, departure_time: r.departure_time ?? '', return_departure_time: r.return_departure_time ?? '', days_of_week: r.days_of_week ?? [], is_two_way: r.is_two_way, return_wait_minutes: r.return_wait_minutes ?? 300, seat_override: r.seat_override != null ? String(r.seat_override) : '' })}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#334155]">
                      <Pencil size={10} /> {t('mv.editScheduleBtn')}
                    </button>
                    <button onClick={() => setStopsRouteId(r.id)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#334155]">
                      <RouteIcon size={10} /> {t('mv.manageStopsBtn')}
                    </button>
                    <button onClick={() => setGroupRouteId(r.id)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#166534]">
                      <Users size={10} /> {r.is_monthly_fixed ? t('mv.startManageRideBtn') : t('mv.routeGroupBtn')}
                    </button>
                    <button onClick={() => setHandOffRouteId(r.id)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#334155]">
                      <Users size={10} /> {t('mv.handOffRunBtn')}
                    </button>
                    {!r.is_monthly_fixed && (
                      <button onClick={() => openManualBooking(r.id)}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-[#166534] text-[#166534] bg-[#F0FDF4]">
                        <Plus size={10} /> {t('mv.recordWalkUpBtn')}
                      </button>
                    )}
                    <button onClick={() => openLuggageBooking(r.id)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-amber-300 text-amber-700 bg-amber-50">
                      <Plus size={10} /> {t('mv.recordLuggageBtn')}
                    </button>
                    {r.is_monthly_fixed && (
                      <>
                        <button onClick={() => setMonthlyRidersRouteId(r.id)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-amber-200 text-amber-700 bg-amber-50">
                          <Users size={10} /> {t('mv.manageRidersBtn')}
                        </button>
                        <button onClick={() => editMonthlyFee(r)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-amber-200 text-amber-700 bg-amber-50">
                          <Pencil size={10} /> {t('mv.editMonthlyFeeBtn')}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em]">{t('mp.bookingsHeading')}</p>
          <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-[#f2f1e8]">
            {(['active', 'past'] as const).map((k) => (
              <button key={k} onClick={() => setBookingsSeg(k)}
                className="rounded-[7px] px-2.5 py-1 text-[10.5px] font-bold cursor-pointer"
                style={{ background: bookingsSeg === k ? '#166534' : 'transparent', color: bookingsSeg === k ? '#fff' : '#64748b' }}>
                {k === 'active' ? t('mb.bookingsActiveTab') : t('mb.bookingsPastTab')}
              </button>
            ))}
          </div>
        </div>
        {(() => {
          const todayStr = new Date().toISOString().slice(0, 10)
          const isActive = (b: Booking) => ['announced', 'confirmed'].includes(b.status) && b.travel_date >= todayStr
          const shown = bookings.filter((b) => (bookingsSeg === 'active' ? isActive(b) : !isActive(b)))
          return shown.length === 0 ? (
            <p className="font-sans text-[13px] text-[#94a3b8] text-center py-6">{t('cm.noBookingsYet')}</p>
          ) : (
        <div className="flex flex-col gap-2">
          {shown.map((b) => (
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
              {b.status === 'announced' && !b.seat_accepted_at && (
                <p className="font-sans text-[11px] font-bold text-amber-700 mt-1.5">{t('mv.openGroupToConfirmSeatHint')}</p>
              )}
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
          )
        })()}
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
        <RouteMonthlySubscribersPanel routeId={monthlyRidersRouteId} onClose={() => { setMonthlyRidersRouteId(null); const vid = selectedVehicleId ?? vehicleId; if (vid) reload(vid) }} />
      )}
      {handOffRouteId && (
        <MobilityBottomSheet title={t('mv.handOffRunHeading')} onClose={() => { setHandOffRouteId(null); setHandOffSearch(''); setHandOffResults([]) }}>
          <div className="flex flex-col gap-2.5">
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b]">{t('mv.pickSubstituteVehicleLabel')}</label>
            <input value={handOffSearch} onChange={(e) => setHandOffSearch(e.target.value)} placeholder={t('mv.handOffSearchPlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            {handOffResults.map((v) => (
              <button key={v.id} type="button" onClick={() => confirmHandOff(v.id)} disabled={handingOff}
                className="flex items-center justify-between gap-2 border border-[#e5e2d0] rounded-lg px-3 py-2 cursor-pointer disabled:opacity-50">
                <span className="font-sans text-[13px] font-semibold text-[#1e293b]">{v.owner_name} · {v.vehicle_type}</span>
                <span className="font-sans text-[11.5px] text-[#64748b] ltr-num">{v.vehicle_number}</span>
              </button>
            ))}
            <p className="font-sans text-[11.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{t('mv.handOffSettleNote')}</p>
          </div>
        </MobilityBottomSheet>
      )}
      {manualBookingRouteId && (
        <MobilityBottomSheet title={t('mv.recordWalkUpHeading')} onClose={() => setManualBookingRouteId(null)}>
          <div className="flex flex-col gap-2.5">
            {fleetCounters.length > 0 && (
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.counterLabel')}</label>
                <select value={manualCounterId} onChange={(e) => setManualCounterId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                  <option value="">—</option>
                  {fleetCounters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.passengerNameLabel')}</label>
              <input value={manualPassengerName} onChange={(e) => setManualPassengerName(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.passengerMobileOptionalLabel')}</label>
              <input value={manualPassengerMobile} onChange={(e) => setManualPassengerMobile(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
            <div className="flex items-center gap-3">
              <label className="font-sans text-[13px] font-semibold text-[#64748b]">{t('mk.seatsLabel')}</label>
              <button type="button" onClick={() => setManualSeats((s) => Math.max(1, s - 1))} className="w-8 h-8 rounded-full bg-[#f2f1e8] flex items-center justify-center cursor-pointer">−</button>
              <span className="font-sans text-[15px] font-bold ltr-num w-6 text-center">{manualSeats}</span>
              <button type="button" onClick={() => setManualSeats((s) => s + 1)} className="w-8 h-8 rounded-full bg-[#166534] text-white flex items-center justify-center cursor-pointer">+</button>
            </div>
            {isVanKindRoute && totalSeats && (
              <SeatPickerField totalSeats={totalSeats} takenSeatNumbers={manualTakenSeats} seatsNeeded={manualSeats} selected={manualSeatNumbers} onChange={setManualSeatNumbers} isSleeper={isSleeper} />
            )}
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fareCollectedLabel')}</label>
              <input type="number" value={manualAmount} onChange={(e) => setManualAmount(e.target.value)} placeholder={t('mv.expenseAmountPlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('w.paymentMethod')}</label>
              <select value={manualMethod} onChange={(e) => setManualMethod(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="cash">{t('w.cash')}</option>
                <option value="jazzcash">{t('w.jazzcash')}</option>
                <option value="easypaisa">{t('w.easypaisa')}</option>
                <option value="bank">{t('a.bank')}</option>
              </select>
            </div>
            <button onClick={recordManualBooking} disabled={recordingManual} className="mt-1 px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {recordingManual ? t('action.loading') : t('mv.recordWalkUpBtn')}
            </button>
          </div>
        </MobilityBottomSheet>
      )}
      {luggageRouteId && (
        <MobilityBottomSheet title={t('mv.recordLuggageHeading')} onClose={() => setLuggageRouteId(null)}>
          <div className="flex flex-col gap-2.5">
            {fleetCounters.length > 0 && (
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.counterLabel')}</label>
                <select value={luggageCounterId} onChange={(e) => setLuggageCounterId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                  <option value="">—</option>
                  {fleetCounters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.senderNameLabel')}</label>
                <input value={senderName} onChange={(e) => setSenderName(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </div>
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.senderMobileOptionalLabel')}</label>
                <input value={senderMobile} onChange={(e) => setSenderMobile(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.receiverNameLabel')}</label>
                <input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </div>
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.receiverMobileLabel')}</label>
                <input value={receiverMobile} onChange={(e) => setReceiverMobile(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </div>
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.luggageDescriptionLabel')}</label>
              <input value={luggageDescription} onChange={(e) => setLuggageDescription(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fareCollectedLabel')}</label>
              <input type="number" value={luggageFare} onChange={(e) => setLuggageFare(e.target.value)} placeholder={t('mv.expenseAmountPlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('w.paymentMethod')}</label>
              <select value={luggageMethod} onChange={(e) => setLuggageMethod(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="cash">{t('w.cash')}</option>
                <option value="jazzcash">{t('w.jazzcash')}</option>
                <option value="easypaisa">{t('w.easypaisa')}</option>
                <option value="bank">{t('a.bank')}</option>
              </select>
            </div>
            <button onClick={recordLuggage} disabled={recordingLuggage} className="mt-1 px-4 py-2.5 rounded-xl bg-amber-600 text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {recordingLuggage ? t('action.loading') : t('mv.recordLuggageBtn')}
            </button>
          </div>
        </MobilityBottomSheet>
      )}
      {editSchedule && (
        <MobilityBottomSheet title={t('mv.editScheduleHeading')} onClose={() => setEditSchedule(null)}>
          <div className="flex flex-col gap-3">
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.departureTimeLabel')}</label>
              <input type="time" value={editSchedule.departure_time} onChange={(e) => setEditSchedule({ ...editSchedule, departure_time: e.target.value })} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full" />
            </div>
            <label className="flex items-center gap-2 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] font-semibold text-[#1e293b] cursor-pointer">
              <input type="checkbox" checked={editSchedule.is_two_way} onChange={(e) => setEditSchedule({ ...editSchedule, is_two_way: e.target.checked, return_departure_time: e.target.checked ? editSchedule.return_departure_time : '' })} />
              {t('mv.isTwoWayToggleLabel')}
            </label>
            {editSchedule.is_two_way && (
              <>
                <div>
                  <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.returnWaitMinutesLabel')}</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {[300, 360, 480].map((mins) => (
                      <button key={mins} type="button" onClick={() => setEditSchedule({ ...editSchedule, return_wait_minutes: mins })}
                        className={`px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer ${editSchedule.return_wait_minutes === mins ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                        {Math.round(mins / 60)}{t('mv.hoursShortSuffix')}
                      </button>
                    ))}
                    <input type="number" min={30} step={30} value={editSchedule.return_wait_minutes} onChange={(e) => setEditSchedule({ ...editSchedule, return_wait_minutes: Number(e.target.value) })}
                      className="w-24 px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" placeholder={t('mv.customMinutesPlaceholder')} />
                  </div>
                </div>
                <div>
                  <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('cm.returnDepartureTimeLabel')}</label>
                  <input type="time" value={editSchedule.return_departure_time} onChange={(e) => setEditSchedule({ ...editSchedule, return_departure_time: e.target.value })} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full" />
                </div>
              </>
            )}
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
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.seatOverrideLabel')}</label>
              <input type="number" min={1} value={editSchedule.seat_override} onChange={(e) => setEditSchedule({ ...editSchedule, seat_override: e.target.value })}
                placeholder={totalSeats ? String(totalSeats) : ''} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] w-full ltr-num" />
              <p className="font-sans text-[10.5px] text-[#94a3b8] mt-1">{t('mv.seatOverrideHint').replace('{n}', String(totalSeats ?? '—'))}</p>
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
