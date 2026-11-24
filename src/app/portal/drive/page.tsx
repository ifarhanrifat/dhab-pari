'use client'

// 2026-11-20: full rebuild against the SAFAR_Driver_Trip_Operations.html
// blueprint, following the same process as the admin Chalan rebuild
// (924/926/927/928): read the real spec, audit what already exists,
// build only the real gaps. Confirmed by direct audit: the trip-ops
// RPCs (close_route_stop_challan, board_manual_ticket, mark_manual_
// ticket_no_show/alighted, route_departure_chalan, route_master_trip_
// challan) already gate on can_manage_vehicle, which a driver already
// passes — so Trip Ops here is a real port of the Chalan page's desk,
// pre-scoped to the driver's own route(s), not new backend. What was
// genuinely missing (929/930/931/932): a GPS-geofenced attendance
// check-in (haversine_km against the driver's home_terminal_id — a
// separate concept from counter_id, which scopes terminal-desk writes
// and would have wrongly restricted a driver who also had one set), a
// driver payroll self-view, and a real submit/confirm cash handover
// (a driver's submission alone must not settle the cash).
//
// The old version of this page (read-only onboard list + a walk-up
// form) is folded into the new Trip tab; nothing from it is lost.

import { Suspense, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import {
  Bus, MapPin, Wallet, Plus, Minus, Clock, LogIn, LogOut, CheckCircle2, UserX, ClipboardCheck,
  HandCoins, Users2, Banknote, TrendingUp, MessageCircleQuestion, Radio, Navigation, Play,
  Crosshair, Send, Gauge, Route as RouteIcon, Maximize2, Minimize2, MessageCircle, CalendarDays,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'
import { haversineKm } from '@/lib/roadRoute'
import { LoadingDots } from '@/components/shared/LoadingDots'
import {
  FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetFormGrid, FleetFormField, FleetStatusPill, FleetKpiRow,
} from '@/components/portal/FleetPanel'
import { DriverShuffleFloatingButton } from '@/components/mobility/DriverShuffleFloatingButton'
import type { MapPin as LeafletPin, LeafletMapHandle } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

type Direction = 'outbound' | 'return'
type Tab = 'home' | 'trip' | 'cash' | 'pay'

interface MyRoute {
  id: string; origin: string; destination: string; departure_time: string | null; is_two_way: boolean
  days_of_week: number[]; vehicle_id: string; vehicle_number: string | null; vehicle_type: string | null
  fleet_id: string; is_co_driver: boolean
}
interface StopRow {
  id: string; label: string; stop_order: number; counter_id: string | null; counter_name: string | null; counter_city: string | null
  lat: number | null; lng: number | null; arrival_time: string | null; departure_time: string | null
}
interface Passenger {
  id: string; source: 'manual' | 'app'; passenger_name: string; passenger_mobile: string | null; seats: number
  amount: number; boarded_at: string | null; dropped_off_at: string | null; status: string; counter_id: string | null
}
interface Chalan {
  origin: string; destination: string; run_started_at: string | null
  onboard_now: Passenger[]; next_stops: { label: string; passengers: Passenger[] }[]
  total_confirmed_count: number; total_unconfirmed_count: number; cash_collected_pkr: number
}
interface StopChallanRow {
  id: string; stop_id: string | null; stop_label: string | null; terminal_city: string | null; terminal_name: string | null
  expected_count: number; boarded_count: number; no_show_count: number
  cash_collected_pkr: number; digital_collected_pkr: number; driver_advance_pkr: number
}
interface Handover { id: string; amount_pkr: number; counter_city: string | null; status: 'pending' | 'confirmed'; created_at: string }
interface MasterChallan {
  stop_challans: StopChallanRow[]; total_stops: number; closed_stops: number
  driver_advances_pkr: number; driver_handovers_pkr: number; driver_cash_float_pkr: number; net_result_pkr: number
  handovers: Handover[]
}
interface AttendanceStatus { has_terminal: boolean; counter_city: string | null; counter_name: string | null; checked_in: boolean; since: string | null }
interface PayrollEntry { id: string; amount_pkr: number; [k: string]: unknown }
interface Payroll {
  pay_frequency: string; current_monthly_salary_pkr: number | null
  commission_this_month_pkr: number; recent_commissions: (PayrollEntry & { seats: number; status: string; created_at: string })[]
  overtime_this_month_pkr: number; recent_overtime: (PayrollEntry & { work_date: string; hours: number | null; note: string | null })[]
  recent_salary_payments: (PayrollEntry & { paid_on: string; note: string | null })[]
}
interface CashPosition { vehicle_id: string; cash_in_hand_pkr: number }
interface CatchRequestRow {
  id: string; name: string; seats: number; seat_accepted_at: string | null; boarded_at: string | null
  is_mid_route_catch: boolean; catch_lat: number | null; catch_lng: number | null; catch_updated_at: string | null
  alight_stop_id: string | null; total_amount_pkr: number | null; announced_method: string | null
  catch_request_expires_at: string | null
}
// route_onboard_roster (938) — every rider currently boarded and not yet
// dropped off, across both booking tables, for the live-trip popup's
// "who's on board, where are they getting off" cards.
interface OnboardRow {
  source: 'ride_booking' | 'manual'; id: string; name: string; mobile: string | null; seats: number
  alight_stop_id: string | null; alight_label: string | null; alight_lat: number | null; alight_lng: number | null
  alight_request_lat: number | null; alight_request_lng: number | null; alight_requested_at: string | null
  is_mid_route_catch: boolean; boarded_at: string
}
interface ChatMessage {
  id: string; sender_role: 'driver' | 'rider'; sender_name: string; is_me: boolean; body: string; created_at: string
}
// 942: the driver-facing half of the job calendar — "when and where is
// my next job," merging default routes, same-day cover, and any
// roster-planned day someone else's route was assigned to me.
interface JobCalendarEntry {
  route_id: string; origin: string; destination: string; departure_time: string | null
  vehicle_number: string | null; vehicle_type: string; the_date: string; via: string
}
interface LeaveDay { the_date: string; reason: string | null }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function today() { return new Date().toISOString().slice(0, 10) }
// 944: minutes from now until today's scheduled departure_time
// ("HH:MM:SS"), in Asia/Karachi — negative once departure has passed.
function minutesUntilDeparture(departureTime: string | null): number | null {
  if (!departureTime) return null
  const nowKhi = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }))
  const [h, m] = departureTime.split(':').map(Number)
  const dep = new Date(nowKhi); dep.setHours(h, m, 0, 0)
  return Math.round((dep.getTime() - nowKhi.getTime()) / 60000)
}

// Nearest-vertex projection onto a stored route_path — the exact same
// approach route_catch_feasibility (859) uses server-side for "how far
// along this road is this point," just computed client-side so the
// live-trip popup's speed HUD / KPI strip / per-stop distance+ETA can
// update instantly from the driver's own GPS fixes without a round
// trip. Deliberately the same nearest-vertex approximation as the
// backend (not a finer per-segment projection) so the numbers shown
// here always agree with what the backend's own eligibility checks see.
function projectOntoRoute(path: { lat: number; lng: number }[], point: { lat: number; lng: number }) {
  if (!path || path.length < 2) return { distanceAlongKm: 0, offRouteKm: 0, totalKm: 0 }
  const cum: number[] = new Array(path.length).fill(0)
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + haversineKm(path[i - 1], path[i])
  let bestIdx = 0, bestDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversineKm(point, path[i])
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  return { distanceAlongKm: cum[bestIdx], offRouteKm: bestDist, totalKm: cum[path.length - 1] }
}
function etaMinutesFor(kmAhead: number, speedKph: number | null) {
  return Math.max(0, Math.round(kmAhead / Math.max(12, speedKph ?? 0) * 60))
}

// Avatar gradient + initial — matches the design reference's .avatar.g1..g5
// palette exactly, cycled by a stable hash of the rider's id so the same
// rider keeps the same color across re-renders.
const AVATAR_GRADIENTS = [
  'linear-gradient(145deg,#1c6a4c,#0f3d2e)', 'linear-gradient(145deg,#7a5bb5,#4a3277)',
  'linear-gradient(145deg,#b5772f,#7a4a14)', 'linear-gradient(145deg,#2f7fb5,#1a4d73)',
  'linear-gradient(145deg,#b53f5e,#73203a)',
]
function avatarBackground(seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length]
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-[#F9F9F6] rounded-lg">
      <span className="font-sans text-[11px] text-[#334155]">{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onChange(Math.max(0, value - 1))} className="w-6 h-6 rounded-md border border-[#e5e2d0] font-bold text-[#166534] cursor-pointer">−</button>
        <span className="font-sans text-[12px] font-bold w-4 text-center ltr-num">{value}</span>
        <button type="button" onClick={() => onChange(value + 1)} className="w-6 h-6 rounded-md border border-[#e5e2d0] font-bold text-[#166534] cursor-pointer">+</button>
      </div>
    </div>
  )
}

export default function DriveOperationsPage() {
  return (
    <Suspense fallback={<div className="text-center py-12"><LoadingDots /></div>}>
      <DriveOperationsPageInner />
    </Suspense>
  )
}

function DriveOperationsPageInner() {
  // 2026-11-21: real gap found via a live screenshot — the global
  // floating bookings hub (FloatingBookingsHub.tsx, mounted on every
  // /portal/(dashboard) page) had its own, much older shortcut straight
  // into the driver's live route via RouteGroupPanel, completely
  // bypassing this page's own redesigned trip popup. Driver taps that
  // button from the home dashboard → sees the old generic "Route
  // Group" UI instead, looking like a regression even though nothing
  // here changed. Fixed at the source (FloatingBookingsHub now links
  // here instead), and this page honors an optional ?route= so the
  // right route is selected before the existing run-started auto-open
  // effect (below) fires — a driver with more than one route would
  // otherwise land on whichever one happens to load first.
  const requestedRouteId = useSearchParams().get('route')
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('home')
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [myCounterId, setMyCounterId] = useState<string | null>(null)
  const [routes, setRoutes] = useState<MyRoute[]>([])
  const [jobCalendar, setJobCalendar] = useState<JobCalendarEntry[]>([])
  const [leaveDays, setLeaveDays] = useState<LeaveDay[]>([])
  const [routeId, setRouteId] = useState('')
  const [direction, setDirection] = useState<Direction>('outbound')
  const [stops, setStops] = useState<StopRow[]>([])
  const [counters, setCounters] = useState<{ id: string; name: string | null; city: string }[]>([])
  const [chalan, setChalan] = useState<Chalan | null>(null)
  const [masterChallan, setMasterChallan] = useState<MasterChallan | null>(null)
  const [loadingChalan, setLoadingChalan] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cashInHand, setCashInHand] = useState<number | null>(null)
  const [attendance, setAttendance] = useState<AttendanceStatus | null>(null)
  const [checkingAttendance, setCheckingAttendance] = useState(false)
  const [payroll, setPayroll] = useState<Payroll | null>(null)
  const [vehicleSeating, setVehicleSeating] = useState<{ totalSeats: number; isVanKind: boolean } | null>(null)
  const [routePath, setRoutePath] = useState<{ lat: number; lng: number }[] | null>(null)
  const [staffedStopIds, setStaffedStopIds] = useState<Set<string>>(new Set())
  const [sharing, setSharing] = useState(false)
  const [myLivePos, setMyLivePos] = useState<{ lat: number; lng: number } | null>(null)
  const [showTripPopup, setShowTripPopup] = useState(false)
  const tripMapRef = useRef<LeafletMapHandle>(null)
  const [mapExpanded, setMapExpanded] = useState(false)
  const autoOpenedRunRef = useRef<string | null>(null)
  const [catchRequests, setCatchRequests] = useState<CatchRequestRow[]>([])
  const [catchActionId, setCatchActionId] = useState<string | null>(null)
  const newCatchIdsRef = useRef<Set<string>>(new Set())
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Onboard roster — "who's on board right now, where are they getting
  // off" (938), plus client-side speed/ETA/remaining-distance derived
  // from the driver's own GPS fixes against routePath.
  const [onboardRoster, setOnboardRoster] = useState<OnboardRow[]>([])
  const [offloadActionId, setOffloadActionId] = useState<string | null>(null)
  const [speedKph, setSpeedKph] = useState<number | null>(null)
  const lastFixRef = useRef<{ lat: number; lng: number; t: number } | null>(null)
  const [endingTrip, setEndingTrip] = useState(false)
  // Real gap found live, 2026-11-24: start_route_run (the one RPC that
  // actually creates today's route_runs row — everything else here,
  // including route_departure_chalan's own run_started_at it reads back,
  // is downstream of that row existing) was only ever called from
  // RouteGroupPanel, the solo-owner screen a fleet employee-driver is
  // deliberately redirected away from (my-vehicle/layout.tsx) straight
  // to this page — which never got the button. Its own permission check
  // (is_route_owner → can_manage_vehicle) already covers fleet_staff
  // fine; this was purely a missing frontend action, not a backend gate.
  const [startingRoute, setStartingRoute] = useState(false)
  const [startStakeInfo, setStartStakeInfo] = useState<{ applies: boolean; stake_pkr: number; balance_pkr: number; can_afford: boolean } | null>(null)

  // Trip-scoped chat (938) — a new, route+date-scoped chat, separate
  // from the village-carpool system's route_chat_messages (deliberately
  // never used for fleet routes, per this page's own earlier note).
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages.length, showTripPopup])

  // 942: upcoming jobs + leave, next 14 days — the driver-facing half
  // of the job calendar, shown on the Home tab right under "My Routes".
  useEffect(() => {
    if (!user) return
    const from = today()
    const to = new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10)
    supabase.rpc('my_driver_job_calendar', { p_date_from: from, p_date_to: to }).then(({ data }) => {
      const rows = (data ?? []) as (JobCalendarEntry | { leave_dates: LeaveDay[] })[]
      const leaveRow = rows.find((r): r is { leave_dates: LeaveDay[] } => 'leave_dates' in r)
      setLeaveDays(leaveRow?.leave_dates ?? [])
      setJobCalendar(rows.filter((r): r is JobCalendarEntry => 'route_id' in r))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Terminal stop desk
  const [selectedStopKey, setSelectedStopKey] = useState<string>('origin')
  const [boardingFor, setBoardingFor] = useState<string | null>(null)
  const [suitcases, setSuitcases] = useState(0)
  const [smallBags, setSmallBags] = useState(0)
  const [handCarry, setHandCarry] = useState(0)
  const [advanceInput, setAdvanceInput] = useState('0')
  const [otherCashInput, setOtherCashInput] = useState('0')
  const [stopNoteInput, setStopNoteInput] = useState('')
  const [closing, setClosing] = useState(false)

  // Walk-up sale
  const [walkupName, setWalkupName] = useState('')
  const [walkupSeats, setWalkupSeats] = useState('1')
  const [walkupAmount, setWalkupAmount] = useState('')
  const [savingWalkup, setSavingWalkup] = useState(false)

  // Cash handover
  const [handoverAmount, setHandoverAmount] = useState('')
  const [handoverCounterId, setHandoverCounterId] = useState('')
  const [handoverNote, setHandoverNote] = useState('')
  const [submittingHandover, setSubmittingHandover] = useState(false)

  // Payroll dispute
  const [disputeNote, setDisputeNote] = useState('')
  const [sendingDispute, setSendingDispute] = useState(false)

  const load = async () => {
    const { data: v } = await supabase.from('vehicles').select('id, fleet_id, portal_user_id, vehicle_number, vehicle_type').eq('portal_user_id', user!.id).maybeSingle()
    const { data: coDriverRoutes } = await supabase
      .from('vehicle_routes')
      .select('id, origin, destination, departure_time, is_two_way, days_of_week, vehicle_id, vehicles(fleet_id, vehicle_number, vehicle_type)')
      .eq('co_driver_portal_user_id', user!.id).eq('is_active', true)

    const myRoutes: MyRoute[] = []
    let myFleetId: string | null = (v as { fleet_id: string | null } | null)?.fleet_id ?? null

    if (v) {
      const { data: r } = await supabase.from('vehicle_routes')
        .select('id, origin, destination, departure_time, is_two_way, days_of_week, vehicle_id')
        .eq('vehicle_id', (v as { id: string }).id).eq('is_active', true)
      for (const row of (r ?? []) as { id: string; origin: string; destination: string; departure_time: string | null; is_two_way: boolean; days_of_week: number[]; vehicle_id: string }[]) {
        myRoutes.push({
          ...row, vehicle_number: (v as { vehicle_number: string | null }).vehicle_number, vehicle_type: (v as { vehicle_type: string | null }).vehicle_type,
          fleet_id: myFleetId!, is_co_driver: false,
        })
      }
    }
    for (const row of (coDriverRoutes ?? []) as unknown as { id: string; origin: string; destination: string; departure_time: string | null; is_two_way: boolean; days_of_week: number[]; vehicle_id: string; vehicles: { fleet_id: string; vehicle_number: string | null; vehicle_type: string | null } | null }[]) {
      if (myRoutes.find((x) => x.id === row.id)) continue
      myFleetId = myFleetId ?? row.vehicles?.fleet_id ?? null
      myRoutes.push({
        id: row.id, origin: row.origin, destination: row.destination, departure_time: row.departure_time, is_two_way: row.is_two_way,
        days_of_week: row.days_of_week, vehicle_id: row.vehicle_id, vehicle_number: row.vehicles?.vehicle_number ?? null, vehicle_type: row.vehicles?.vehicle_type ?? null,
        fleet_id: row.vehicles?.fleet_id ?? '', is_co_driver: true,
      })
    }

    setRoutes(myRoutes)
    setFleetId(myFleetId)
    if (requestedRouteId && myRoutes.find((r) => r.id === requestedRouteId)) { setRouteId(requestedRouteId); setTab('trip') }
    else if (myRoutes.length > 0 && !routeId) setRouteId(myRoutes[0].id)

    if (myFleetId) {
      const [{ data: ctrs }, { data: att }, { data: pay }, { data: ctx }] = await Promise.all([
        supabase.from('fleet_counters').select('id, name, city').eq('fleet_id', myFleetId),
        supabase.rpc('my_driver_attendance_status', { p_fleet_id: myFleetId }),
        supabase.rpc('my_driver_payroll', { p_fleet_id: myFleetId }),
        supabase.rpc('my_fleet_staff_context', { p_fleet_id: myFleetId }),
      ])
      setCounters((ctrs ?? []) as { id: string; name: string | null; city: string }[])
      setAttendance(att as AttendanceStatus | null)
      setPayroll(pay as Payroll | null)
      setMyCounterId((ctx as { counter_id: string | null } | null)?.counter_id ?? null)

      if (v) {
        const { data: cp } = await supabase.rpc('fleet_vehicle_cash_positions', { p_fleet_id: myFleetId })
        const mine = ((cp ?? []) as CashPosition[]).find((p) => p.vehicle_id === (v as { id: string }).id)
        setCashInHand(mine?.cash_in_hand_pkr ?? 0)
      }
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    const r = routes.find((x) => x.id === routeId)
    if (r && !r.is_two_way && direction !== 'outbound') setDirection('outbound')
  }, [routeId, routes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!routeId) { setStops([]); setRoutePath(null); setStaffedStopIds(new Set()); return }
    (async () => {
      const [{ data }, { data: vr }, { data: staffed }] = await Promise.all([
        supabase.from('route_stops')
          .select('id, label, stop_order, counter_id, lat, lng, arrival_time, departure_time, fleet_counters(name, city)')
          .eq('route_id', routeId).order('stop_order'),
        supabase.from('vehicle_routes').select('route_path').eq('id', routeId).single(),
        supabase.rpc('route_staffed_stop_ids', { p_route_id: routeId }),
      ])
      setStaffedStopIds(new Set((staffed as string[] | null) ?? []))
      // Real gap found while building the alight/KPI features: this used
      // to only pull lat/lng through the stop's linked terminal, so any
      // stop without a counter_id (most of them) had no coordinates at
      // all here — route_stops.lat/lng (717) are real, NOT NULL columns
      // on every stop regardless of a terminal link; use those directly.
      const rows = ((data ?? []) as unknown as { id: string; label: string; stop_order: number; counter_id: string | null; lat: number; lng: number; arrival_time: string | null; departure_time: string | null; fleet_counters: { name: string | null; city: string } | null }[])
        .map((r) => ({
          id: r.id, label: r.label, stop_order: r.stop_order, counter_id: r.counter_id,
          counter_name: r.fleet_counters?.name ?? null, counter_city: r.fleet_counters?.city ?? null,
          lat: r.lat, lng: r.lng,
          arrival_time: r.arrival_time, departure_time: r.departure_time,
        }))
      setStops(rows)
      setRoutePath((vr?.route_path as { lat: number; lng: number }[] | null) ?? null)
    })()
  }, [routeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Real gap found live: nothing on the driver's own screen ever pushed
  // GPS anywhere, even though the admin's Live Fleet Map (fleet_vehicle_
  // locations, 854) and route_live_locations have existed for a while —
  // a fleet driver's dot just never showed up because nobody called
  // ping_route_location (717). Same primitive RouteGroupPanel already
  // uses for village-carpool routes — reused here directly (deliberately
  // NOT the whole RouteGroupPanel, which my-vehicle/routes/page.tsx
  // explicitly excludes for fare_mode='terminal_zone' fleet routes,
  // since its chat/roster/wait-window machinery is for a different
  // booking system; the GPS-share/map primitives themselves are generic).
  // 944: real follow-up — "will everyone reach before the bus leaves"
  // was only ever answered with a binary checked-in flag, because
  // sharing only ever turned on once a run had already started.
  // route_live_locations/ping_route_location were never actually tied
  // to an active run (just route_id + sharing_location) — nothing
  // backend stopped pre-trip sharing except this one condition. Widened
  // to also share in a ±2h window around the scheduled departure, so
  // the admin gets a real live distance/ETA before departure instead of
  // nothing — bounded so a driver's phone isn't pinging GPS all day for
  // a 9pm departure. nowTick (already ticking every second elsewhere in
  // this file) keeps preTripActive fresh without re-firing the RPC
  // every tick — the effect only depends on the derived boolean itself.
  const preTripMinutes = minutesUntilDeparture(routes.find((r) => r.id === routeId)?.departure_time ?? null)
  const preTripActive = preTripMinutes != null && preTripMinutes <= 120 && preTripMinutes >= -120
  useEffect(() => {
    if (!routeId) { setSharing(false); return }
    if (!chalan?.run_started_at && !preTripActive) { setSharing(false); return }
    supabase.rpc('set_route_location_sharing', { p_route_id: routeId, p_on: true }).then(({ error }) => {
      if (!error) setSharing(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, chalan?.run_started_at, preTripActive])

  const { error: geoError } = useLiveLocation({
    enabled: sharing,
    minIntervalMs: 12000,
    backgroundTitle: t('cm.liveShareNotifTitle'),
    backgroundMessage: t('cm.liveShareNotifBody'),
    onFix: async ({ lat, lng }) => {
      setMyLivePos({ lat, lng })
      // Client-side speed from consecutive fixes — the browser's own
      // GPS speed field is unreliable/often null on low-accuracy fixes,
      // so this derives km/h the same way the design's speed HUD wants
      // it, ignoring gaps too large (backgrounded tab) to mean anything.
      const now = Date.now()
      const last = lastFixRef.current
      if (last) {
        const dtSec = (now - last.t) / 1000
        if (dtSec >= 3 && dtSec <= 60) {
          const km = haversineKm(last, { lat, lng })
          setSpeedKph(Math.min(140, Math.round((km / dtSec) * 3600)))
        }
      }
      lastFixRef.current = { lat, lng, t: now }
      const { error } = await supabase.rpc('ping_route_location', { p_route_id: routeId, p_lat: lat, p_lng: lng })
      if (error) setSharing(false)
    },
  })

  // Onboard roster (938) — "who's on board right now, where are they
  // getting off." Same poll+realtime pattern as the catch-requests
  // card above, triggered by boarded_at changes, free-GPS alight
  // requests, and offloads (board_ride_bookings/mark_ride_booking_
  // alighted/request_mid_route_alight all fire from elsewhere, so this
  // can't rely on a local mutation alone).
  const loadOnboardRoster = async (rid: string) => {
    if (!rid) { setOnboardRoster([]); return }
    const { data } = await supabase.rpc('route_onboard_roster', { p_route_id: rid })
    setOnboardRoster((data ?? []) as OnboardRow[])
  }
  useEffect(() => {
    if (!routeId) { setOnboardRoster([]); return }
    loadOnboardRoster(routeId)
    const interval = setInterval(() => loadOnboardRoster(routeId), 12000)
    const channel = supabase
      .channel(`drive_pending_requests:${user!.id}:alight`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_notifications', filter: `portal_user_id=eq.${user!.id}` },
        (payload) => {
          if ((payload.new as { event_type: string }).event_type === 'route_alight_request') loadOnboardRoster(routeId)
        })
      .subscribe()
    return () => { clearInterval(interval); supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  // Trip-scoped chat (938) — scoped to route_id + today's travel date.
  const loadChat = async (rid: string) => {
    if (!rid) { setChatMessages([]); return }
    const { data } = await supabase.rpc('route_trip_chat_messages', { p_route_id: rid, p_travel_date: today() })
    setChatMessages((data ?? []) as ChatMessage[])
  }
  useEffect(() => {
    if (!routeId) { setChatMessages([]); return }
    loadChat(routeId)
    const channel = supabase
      .channel(`route_trip_chat:${routeId}:${today()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_group_messages', filter: `route_trip_route_id=eq.${routeId}` },
        () => loadChat(routeId))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  // Mid-route "catch" requests (check_catch_feasibility/place_ride_booking,
  // 850/859/920) already only let a rider request a pickup when they're
  // on this route's actual road and still ahead of the bus — that gate
  // is untouched. What was missing entirely was the driver side: before
  // 935, a catch booking confirmed itself instantly with zero driver
  // visibility on /portal/drive. route_today_ad_hoc_bookings already
  // returns every catch row (is_mid_route_catch, catch_lat/lng,
  // seat_accepted_at) — reused as-is, just filtered here to catch rows.
  const loadCatchRequests = async (rid: string) => {
    if (!rid) { setCatchRequests([]); return }
    const { data } = await supabase.rpc('route_today_ad_hoc_bookings', { p_route_id: rid })
    const rows = ((data ?? []) as CatchRequestRow[]).filter((r) => r.is_mid_route_catch)
    setCatchRequests(rows)
  }

  useEffect(() => {
    if (!routeId) { setCatchRequests([]); return }
    loadCatchRequests(routeId)
    const interval = setInterval(() => loadCatchRequests(routeId), 12000)
    // Real crash found live, confirmed via a connected device: this used
    // the exact same channel topic (`pending_requests:${user.id}`) as
    // PendingRequestOverlay.tsx, which the root layout.tsx mounts on
    // every page — Supabase's realtime client reuses a channel object
    // for a repeated topic, so this second `.on()` call landed on an
    // already-`.subscribe()`'d channel and threw ("cannot add
    // postgres_changes callbacks ... after subscribe()"), uncaught,
    // crashing the whole page before anything below it could render.
    // A distinct topic avoids the collision entirely.
    const channel = supabase
      .channel(`drive_pending_requests:${user!.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_notifications', filter: `portal_user_id=eq.${user!.id}` },
        (payload) => {
          if ((payload.new as { event_type: string }).event_type === 'route_catch_request') loadCatchRequests(routeId)
        })
      .subscribe()
    return () => { clearInterval(interval); supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  // Force the popup open the moment a genuinely NEW catch request shows
  // up (not already-seen), even if the driver had dismissed it for some
  // other reason — urgent, time-boxed, matches the auto-open-on-run-
  // start precedent above but keyed per-booking instead of per-run so
  // it doesn't re-trigger for a request already seen once.
  useEffect(() => {
    const pendingUnseen = catchRequests.filter((r) => !r.seat_accepted_at && !newCatchIdsRef.current.has(r.id))
    if (pendingUnseen.length === 0) return
    for (const r of pendingUnseen) newCatchIdsRef.current.add(r.id)
    setShowTripPopup(true)
  }, [catchRequests])

  useEffect(() => {
    const anyPending = catchRequests.some((r) => !r.seat_accepted_at)
    if (!anyPending) return
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [catchRequests])

  const acceptCatch = async (id: string) => {
    setCatchActionId(id)
    const { error } = await supabase.rpc('accept_ride_booking_seat', { p_booking_id: id })
    setCatchActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.seatAcceptedToast'))
    loadCatchRequests(routeId)
    reload(routeId, direction)
  }
  const declineCatch = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setCatchActionId(id)
    const { error } = await supabase.rpc('decline_ride_booking_seat', { p_booking_id: id, p_reason: reason || null })
    setCatchActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.seatDeclinedToast'))
    loadCatchRequests(routeId)
  }

  // Offload a specific onboard rider — the real gap this whole card was
  // built to close (938): works identically for a formal-stop proximity
  // alert or a free-GPS alight request, since both just end with
  // "they're off now."
  const offloadRider = async (row: OnboardRow) => {
    setOffloadActionId(row.id)
    const { error } = await supabase.rpc('mark_ride_booking_alighted', { p_booking_id: row.id, p_source: row.source === 'manual' ? 'manual' : 'ride_booking' })
    setOffloadActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dr.riderOffloadedToast'))
    loadOnboardRoster(routeId)
  }
  const declineAlightRequest = async (row: OnboardRow) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setOffloadActionId(row.id)
    const { error } = await supabase.rpc('decline_mid_route_alight_request', { p_booking_id: row.id, p_reason: reason || null })
    setOffloadActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dr.alightRequestDeclinedToast'))
    loadOnboardRoster(routeId)
  }

  const sendChat = async (override?: string) => {
    const body = (override ?? chatInput).trim()
    if (!body || !routeId) return
    setChatSending(true)
    const { error } = await supabase.rpc('send_route_trip_message', { p_route_id: routeId, p_travel_date: today(), p_body: body })
    setChatSending(false)
    if (error) { toast.error(friendlyError(error)); return }
    if (!override) setChatInput('')
    loadChat(routeId)
  }

  const startRoute = async () => {
    if (!routeId) return
    setStartingRoute(true)
    const { error } = await supabase.rpc('start_route_run', { p_route_id: routeId, p_direction: direction })
    setStartingRoute(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dr.routeStartedToast'))
    reload(routeId, direction)
  }

  const endTripNow = async () => {
    if (!confirm(t('dr.confirmEndTripHint'))) return
    setEndingTrip(true)
    const { error } = await supabase.rpc('end_route_run', { p_route_id: routeId })
    setEndingTrip(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dr.tripEndedToast'))
    setShowTripPopup(false)
    reload(routeId, direction)
  }

  // Real ask: "driver will always get a job on floating button" — the
  // live trip view opens on its own the moment a run goes active (once
  // per run, via the ref guard), matching the always-visible pattern
  // DriverShuffleFloatingButton already uses for the shuffle status. A
  // driver can still close it and reopen later from the floating button.
  useEffect(() => {
    if (!chalan?.run_started_at || autoOpenedRunRef.current === chalan.run_started_at) return
    autoOpenedRunRef.current = chalan.run_started_at
    setShowTripPopup(true)
  }, [chalan?.run_started_at])

  // A van-kind vehicle requires explicit seat numbers on every booking
  // (record_manual_booking, 926) — real gap found live: the walk-up
  // form had no seat picker at all, so a sale on a van always rejected
  // with "Pick exactly 1 seat(s)." Rather than make a driver browse a
  // seat map mid-route, auto-assign the next free seat number.
  useEffect(() => {
    const r = routes.find((x) => x.id === routeId)
    if (!r) { setVehicleSeating(null); return }
    (async () => {
      const { data: v } = await supabase.from('vehicles').select('total_seats, category_id').eq('id', r.vehicle_id).single()
      const { data: vc } = v?.category_id ? await supabase.from('vehicle_categories').select('vehicle_kind').eq('id', v.category_id).single() : { data: null }
      setVehicleSeating(v ? { totalSeats: v.total_seats, isVanKind: vc?.vehicle_kind === 'van' } : null)
    })()
  }, [routeId, routes]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async (rid: string, dir: Direction) => {
    if (!rid) return
    setLoadingChalan(true)
    const [chalanRes, masterRes] = await Promise.all([
      supabase.rpc('route_departure_chalan', { p_route_id: rid, p_travel_date: today(), p_direction: dir }),
      supabase.rpc('route_master_trip_challan', { p_route_id: rid, p_travel_date: today(), p_direction: dir }),
    ])
    setLoadingChalan(false)
    if (chalanRes.error) toast.error(friendlyError(chalanRes.error)); else setChalan(chalanRes.data as Chalan)
    if (masterRes.error) toast.error(friendlyError(masterRes.error)); else setMasterChallan(masterRes.data as MasterChallan)
  }

  useEffect(() => { if (routeId) reload(routeId, direction) }, [routeId, direction]) // eslint-disable-line react-hooks/exhaustive-deps

  // Same stake preview RouteGroupPanel already shows before its own
  // start button — fetched fresh whenever the route/direction changes
  // while no run is active yet, so a changed balance is never stale.
  // Reads `routes` directly rather than the later `currentRoute` const
  // below (computed after an early return earlier in this component, so
  // out of reach for a hook, which must never run conditionally).
  useEffect(() => {
    const vehicleId = routes.find((r) => r.id === routeId)?.vehicle_id
    if (!vehicleId || chalan?.run_started_at) { setStartStakeInfo(null); return }
    supabase.rpc('vehicle_ride_stake_info', { p_vehicle_id: vehicleId }).then(({ data: s }) => setStartStakeInfo(s ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, routes, chalan?.run_started_at])

  // ─── Attendance ─────────────────────────────────────────────────────
  const doCheckIn = () => {
    if (!navigator.geolocation) { toast.error(t('dr.locationDeniedError')); return }
    setCheckingAttendance(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { error } = await supabase.rpc('driver_check_in', { p_lat: pos.coords.latitude, p_lng: pos.coords.longitude })
        setCheckingAttendance(false)
        if (error) { toast.error(friendlyError(error)); return }
        toast.success(t('dr.checkedInToast'))
        load()
      },
      () => { setCheckingAttendance(false); toast.error(t('dr.locationDeniedError')) },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }
  const doCheckOut = async () => {
    setCheckingAttendance(true)
    const { error } = await supabase.rpc('driver_check_out')
    setCheckingAttendance(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dr.checkedOutToast'))
    load()
  }

  // ─── Trip ops (ported from Chalan's terminal desk, scoped to my route) ──
  const sequencedStops = direction === 'return' ? [...stops].reverse() : stops
  const isLockedToOwnTerminal = !!myCounterId
  const stopOptions: { key: string; label: string; counterId: string | null }[] = [
    { key: 'origin', label: `${t('mv.originStopOption')} · ${chalan?.origin ?? ''}`, counterId: null },
    ...sequencedStops.map((s) => ({ key: s.id, label: s.counter_name ? `${s.counter_name} · ${s.counter_city}` : s.label, counterId: s.counter_id })),
  ]
  // Real gap raised by the user: this dropdown used to list every stop on
  // the route flatly — ones already closed today, and ones that have
  // their own dedicated terminal staff (that's staff-only territory;
  // close_route_stop_challan now rejects a driver there too, enforced
  // server-side via driver_blocked_from_staffed_counter, 936/937 — this
  // is just the matching UI declutter, not the only guard).
  const closedStopKeys = new Set((masterChallan?.stop_challans ?? []).map((sc) => sc.stop_id ?? 'origin'))
  const nextStopKey = chalan && chalan.next_stops.length > 0
    ? sequencedStops.find((s) => (s.counter_name ? `${s.counter_name} · ${s.counter_city}` : s.label) === chalan.next_stops[0].label)?.id ?? null
    : null
  const visibleStopOptions = stopOptions
    .filter((o) => !isLockedToOwnTerminal || o.counterId === myCounterId)
    .filter((o) => !closedStopKeys.has(o.key))
    .filter((o) => o.counterId === myCounterId || !staffedStopIds.has(o.key))

  useEffect(() => {
    if (visibleStopOptions.length === 0) return
    if (visibleStopOptions.find((o) => o.key === selectedStopKey)) return
    setSelectedStopKey((visibleStopOptions.find((o) => o.key === nextStopKey) ?? visibleStopOptions[0]).key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, myCounterId, masterChallan, chalan, staffedStopIds])

  const isOriginSelected = selectedStopKey === 'origin'
  const selectedStop = isOriginSelected ? null : stops.find((s) => s.id === selectedStopKey) ?? null
  const deskQueue: Passenger[] = !chalan ? [] : isOriginSelected ? chalan.onboard_now : (chalan.next_stops.find((g) => g.label === selectedStop?.label)?.passengers ?? [])
  const alreadyClosed = !!masterChallan?.stop_challans.find((sc) => (sc.stop_id ?? null) === (isOriginSelected ? null : selectedStopKey))

  const openBoardingLuggage = (p: Passenger) => { setBoardingFor(p.id); setSuitcases(0); setSmallBags(0); setHandCarry(0) }

  const confirmBoarding = async (p: Passenger) => {
    const parts: string[] = []
    if (suitcases > 0) parts.push(`${suitcases} ${t('mv.suitcasesLabel')}`)
    if (smallBags > 0) parts.push(`${smallBags} ${t('mv.smallBagsLabel')}`)
    if (handCarry > 0) parts.push(`${handCarry} ${t('mv.handCarryLabel')}`)
    setBusyId(p.id)
    const { error } = await supabase.rpc('board_manual_ticket', { p_id: p.id, p_luggage_note: parts.length > 0 ? parts.join(', ') : null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.passengerBoardedToast'))
    setBoardingFor(null)
    reload(routeId, direction)
  }

  const noShowPassenger = async (p: Passenger) => {
    if (!confirm(t('mv.confirmMarkNoShowHint'))) return
    setBusyId(p.id)
    const { error } = await supabase.rpc('mark_manual_ticket_no_show', { p_id: p.id, p_reason: t('mv.noShowReason') })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.passengerNoShowToast'))
    reload(routeId, direction)
  }

  const alightPassenger = async (p: Passenger) => {
    setBusyId(p.id)
    const { error } = await supabase.rpc('mark_manual_ticket_alighted', { p_id: p.id })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.passengerAlightedToast'))
    reload(routeId, direction)
  }

  const closeStop = async () => {
    if (!routeId) return
    if (!confirm(t('mv.confirmCloseStopHint'))) return
    setClosing(true)
    const { error } = await supabase.rpc('close_route_stop_challan', {
      p_route_id: routeId, p_travel_date: today(), p_direction: direction,
      p_stop_id: isOriginSelected ? null : selectedStopKey,
      p_driver_advance_pkr: Number(advanceInput || 0), p_other_cash_pkr: Number(otherCashInput || 0), p_note: stopNoteInput.trim() || null,
    })
    setClosing(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.stopChallanCreatedToast'))
    setAdvanceInput('0'); setOtherCashInput('0'); setStopNoteInput('')
    reload(routeId, direction)
  }

  const recordWalkup = async () => {
    if (!routeId || !walkupName.trim() || !walkupAmount) { toast.error(t('mv.walkupFieldsRequiredError')); return }
    const seats = Number(walkupSeats) || 1
    let seatNumbers: number[] | undefined
    if (vehicleSeating?.isVanKind) {
      const { data: taken } = await supabase.rpc('route_seat_status', { p_route_id: routeId, p_travel_date: today(), p_direction: direction })
      const takenSet = new Set((taken as number[]) ?? [])
      const free: number[] = []
      for (let n = 1; n <= vehicleSeating.totalSeats && free.length < seats; n++) if (!takenSet.has(n)) free.push(n)
      if (free.length < seats) { toast.error(t('mv.pickASeatError')); return }
      seatNumbers = free
    }
    setSavingWalkup(true)
    // Real gap found live: this always sold from the origin (board_stop_id
    // omitted = NULL = implicit origin), which record_manual_booking (926)
    // locks once the bus has departed today — exactly the case for a
    // driver selling a seat mid-route. Pass the currently selected stop
    // desk terminal so a walk-up sale boards where the driver actually is.
    const { error } = await supabase.rpc('record_manual_booking', {
      p_route_id: routeId, p_travel_date: today(), p_seats: seats,
      p_passenger_name: walkupName, p_total_amount_pkr: Number(walkupAmount), p_payment_method: 'cash',
      p_board_stop_id: isOriginSelected ? null : selectedStopKey, p_seat_numbers: seatNumbers,
    })
    setSavingWalkup(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.walkupRecordedToast'))
    setWalkupName(''); setWalkupSeats('1'); setWalkupAmount('')
    reload(routeId, direction)
  }

  const submitHandover = async () => {
    const amt = Number(handoverAmount || 0)
    if (!amt || amt <= 0) { toast.error(t('mv.enterRealAmountError')); return }
    setSubmittingHandover(true)
    const { error } = await supabase.rpc('submit_route_driver_handover', {
      p_route_id: routeId, p_travel_date: today(), p_direction: direction,
      p_amount_pkr: amt, p_received_by_counter_id: handoverCounterId || null, p_note: handoverNote.trim() || null,
    })
    setSubmittingHandover(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dr.handoverSubmittedToast'))
    setHandoverAmount(''); setHandoverCounterId(''); setHandoverNote('')
    reload(routeId, direction)
  }

  const sendDispute = async () => {
    if (!disputeNote.trim()) { toast.error(t('dr.queryRequiredError')); return }
    setSendingDispute(true)
    const { error } = await supabase.rpc('raise_payroll_dispute', { p_fleet_id: fleetId, p_note: disputeNote.trim() })
    setSendingDispute(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dr.querySentToast'))
    setDisputeNote('')
  }

  const renderDeskRow = (p: Passenger) => {
    const boarded = !!p.boarded_at
    const alighted = !!p.dropped_off_at
    const noShow = p.status === 'no_show'
    const isBoardingThis = boardingFor === p.id
    return (
      <div key={`${p.source}-${p.id}`} className="px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{p.passenger_name}{p.passenger_mobile ? ` · ${p.passenger_mobile}` : ''}</p>
            <p className="font-sans text-[10.5px] text-[#94a3b8]">{p.seats} {t('mv.seatsSuffix')}</p>
          </div>
          <FleetStatusPill tone={noShow ? 'red' : alighted ? 'gray' : boarded ? 'green' : 'amber'}>
            {noShow ? t('mv.noShowLabel') : alighted ? t('mv.alightedLabel') : boarded ? t('mv.boardedLabel') : t('mv.awaitingBoardingLabel')}
          </FleetStatusPill>
        </div>
        {p.source === 'manual' && !noShow && (
          isBoardingThis ? (
            <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex flex-col gap-1.5">
              <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8]">{t('mv.luggageHeading')}</p>
              <Stepper label={t('mv.suitcasesLabel')} value={suitcases} onChange={setSuitcases} />
              <Stepper label={t('mv.smallBagsLabel')} value={smallBags} onChange={setSmallBags} />
              <Stepper label={t('mv.handCarryLabel')} value={handCarry} onChange={setHandCarry} />
              <div className="flex gap-2 mt-1">
                <button onClick={() => confirmBoarding(p)} disabled={busyId === p.id} className="flex-1 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12px] font-bold cursor-pointer disabled:opacity-50">{t('mv.confirmBoardingBtn')}</button>
                <button onClick={() => setBoardingFor(null)} className="flex-1 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
              </div>
            </div>
          ) : (
            <div className="flex gap-1.5 mt-2 pt-2 border-t border-[#f1f5f9] flex-wrap">
              {!boarded && (
                <>
                  <button onClick={() => openBoardingLuggage(p)} disabled={busyId === p.id} className="flex-1 min-w-[100px] flex items-center justify-center gap-1 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-bold cursor-pointer disabled:opacity-50"><CheckCircle2 size={11} /> {t('mv.markBoardedBtn')}</button>
                  <button onClick={() => noShowPassenger(p)} disabled={busyId === p.id} className="flex-1 min-w-[100px] flex items-center justify-center gap-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50"><UserX size={11} /> {t('mv.markNoShowBtn')}</button>
                </>
              )}
              {boarded && !alighted && (
                <button onClick={() => alightPassenger(p)} disabled={busyId === p.id} className="flex-1 min-w-[100px] flex items-center justify-center gap-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#64748b] cursor-pointer disabled:opacity-50"><LogOut size={11} /> {t('mv.markAlightedBtn')}</button>
              )}
            </div>
          )
        )}
      </div>
    )
  }

  // 879's mid-route shuffle button has its own independent data fetch
  // (not derived from this page's state) and was previously only ever
  // mounted on my-vehicle/layout.tsx — this page sits outside that
  // layout entirely (portal/drive isn't under the my-vehicle route
  // group), so a driver using the real driver app never saw it. Mounted
  // unconditionally here, including through the loading/no-route early
  // returns, since the button renders null on its own until a route is
  // actually active.
  if (userLoading || loading) return <><DriverShuffleFloatingButton /><div className="text-center py-12"><LoadingDots /></div></>
  if (routes.length === 0) return <><DriverShuffleFloatingButton /><p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noVehicleAssignedHint')}</p></>

  const currentRoute = routes.find((r) => r.id === routeId)

  return (
    <div className="flex flex-col gap-3 p-3">
      <DriverShuffleFloatingButton />

      {/* 2026-11-20: real ask — "I need popup module to display these
          things" — this was built as just another scrolling Trip-tab
          card at first. Converted into an actual popup (same fixed-
          overlay pattern DriverShuffleFloatingButton's own confirm
          dialog already uses in this file), auto-opened the moment a
          run goes active and reachable again any time via the trigger
          row on the Trip tab — matching the blueprint's "Trip" screen:
          live map, next stop, and a real done/current/upcoming stop
          timeline (ported from Chalan's own Stop Sequence panel). */}
      {showTripPopup && chalan && (() => {
        // Real visual port of driver-live-trip.html's styling (dark-
        // green/gold/cream token palette, speed HUD + map controls +
        // next-stop ribbon over the map, KPI accent-bar cards, avatar-
        // card alight alerts and rider rows, rail/node/line stop
        // timeline, chat bubbles + quick chips) — but NOT that file's
        // mobile tab-bar pagination, which was the reference HTML's own
        // responsive-breakpoint choice, never something the user asked
        // for. The user's actual original spec (re-read directly):
        // stops "under the map," a sidebar of cards (next stop/speed/
        // ETA) visible alongside, the onboard route group visible, and
        // a chat box "at the bottom" — i.e. one continuous view with
        // chat anchored as a persistent footer, not four screens a
        // driver has to tap between while driving. Restructured to
        // match that: everything below scrolls together in the user's
        // own described order, chat is a fixed bottom section.
        // Stop pins keep a stable id→index lookup so the stop belt
        // (below) can call focusPin on the exact right marker without
        // re-deriving the filter/order logic twice.
        const stopsWithCoords = stops.filter((s) => s.lat != null && s.lng != null)
        const stopPinIndexById = new Map(stopsWithCoords.map((s, i) => [s.id, i]))
        const mapPins: LeafletPin[] = [
          ...stopsWithCoords.map((s): LeafletPin => ({
            lat: s.lat!, lng: s.lng!, emoji: '📍', color: '#d4a13c',
            popupHtml: `<b>${s.counter_name ? `${s.counter_name} · ${s.counter_city}` : s.label}</b>`,
          })),
          ...catchRequests.filter((r) => !r.seat_accepted_at && r.catch_lat != null && r.catch_lng != null).map((r): LeafletPin => ({
            lat: r.catch_lat!, lng: r.catch_lng!, emoji: '🙋', color: '#c73c3c',
            popupHtml: `<b>${r.name || t('dr.catchRequestRiderFallback')}</b>`,
          })),
          // A rider's free-GPS "drop me off here" request — the real
          // purpose of this pin: it marks the EXACT point on the road
          // where a boarded passenger wants off, not the next formal
          // stop, so the driver can see it directly on the map, always
          // open (no need to tap it) since it's the thing this view
          // exists to surface.
          ...onboardRoster.filter((r) => r.alight_request_lat != null && r.alight_request_lng != null).map((r): LeafletPin => ({
            lat: r.alight_request_lat!, lng: r.alight_request_lng!, emoji: '🛑', color: '#2f6fb0',
            popupHtml: `<b>${r.name}</b><br/>${t('dr.freeGpsAlightBadge')}`,
            openPopup: true,
          })),
          ...(myLivePos ? [{ lat: myLivePos.lat, lng: myLivePos.lng, emoji: '🚐', color: '#1c6a4c', isVehicle: true, label: t('dr.myBusLabel') } as LeafletPin] : []),
        ]
        const vehiclePinIndex = mapPins.findIndex((p) => p.isVehicle)
        const driverKmNow = (myLivePos && routePath && routePath.length >= 2) ? projectOntoRoute(routePath, myLivePos).distanceAlongKm : null
        const kmAheadOf = (lat: number, lng: number) => (driverKmNow != null && routePath ? Math.max(0, projectOntoRoute(routePath, { lat, lng }).distanceAlongKm - driverKmNow) : null)
        // 2026-11-21: real ask — "move the stops onto the same belt we
        // already use for vehicle drivers in the old app" (the
        // horizontal stop-pill strip RouteGroupPanel.tsx's own
        // fullscreen map already renders at the bottom of the map,
        // ported verbatim here) instead of a separate full-width
        // card — frees real vertical space for riders/chat, and is the
        // one place "next stop" info needs to live now, so the
        // redundant floating map card this view also had is gone.
        const stopBeltRows = sequencedStops.filter((s) => s.lat != null && s.lng != null).map((s) => {
          const label = s.counter_name ? `${s.counter_name} · ${s.counter_city}` : s.label
          return {
            id: s.id, label,
            done: !!masterChallan?.stop_challans.find((sc) => sc.stop_id === s.id),
            isNext: chalan.next_stops[0]?.label === label,
            dist: kmAheadOf(s.lat!, s.lng!),
            pinIndex: stopPinIndexById.get(s.id) ?? null,
          }
        })
        const alightDue = onboardRoster.map((r) => {
          const isFreeRequest = r.alight_request_lat != null && r.alight_request_lng != null
          const point = isFreeRequest ? { lat: r.alight_request_lat!, lng: r.alight_request_lng! } : (r.alight_lat != null && r.alight_lng != null ? { lat: r.alight_lat, lng: r.alight_lng } : null)
          const kmAhead = point ? kmAheadOf(point.lat, point.lng) : null
          return { r, isFreeRequest, kmAhead }
        }).filter((x) => x.kmAhead != null && (x.isFreeRequest || x.kmAhead <= 5)) as { r: OnboardRow; isFreeRequest: boolean; kmAhead: number }[]
        alightDue.sort((a, b) => a.kmAhead - b.kmAhead)
        const pendingCatch = catchRequests.filter((r) => !r.seat_accepted_at)
        const acceptedCatch = catchRequests.filter((r) => r.seat_accepted_at && !r.boarded_at)
        const QUICK_CHIPS = [t('dr.quickChip1'), t('dr.quickChip2'), t('dr.quickChip3'), t('dr.quickChip4')]

        return (
        <div className="fixed inset-0 bg-black/60 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowTripPopup(false)}>
          <div className="rounded-t-2xl sm:rounded-2xl w-full sm:max-w-[420px] h-[97vh] sm:h-[780px] overflow-hidden flex flex-col" style={{ background: '#f3f1e9' }} onClick={(e) => e.stopPropagation()}>

            {/* Topbar */}
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 shrink-0" style={{ background: 'linear-gradient(180deg,#0f3d2e,#0b2e22)' }}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: 'radial-gradient(120% 120% at 30% 20%,#e8bd63,#b8862f)' }}>
                <Bus size={15} color="#2a1c05" />
              </div>
              <p className="font-sans text-[13px] font-bold text-white truncate flex-1 min-w-0">{t('dr.openLiveTripBtn')}</p>
              <span className="inline-flex items-center gap-1.5 shrink-0 rounded-full px-2.5 py-1 font-sans text-[10px] font-bold" style={{ background: 'rgba(42,138,99,.22)', border: '1px solid rgba(123,214,170,.35)', color: '#b9f0d2' }}>
                <span className="relative inline-flex w-[7px] h-[7px] rounded-full shrink-0" style={{ background: '#54e39b' }}>
                  {sharing && <span className="absolute -inset-1 rounded-full animate-ping" style={{ border: '2px solid #54e39b' }} />}
                </span>
                {sharing ? t('dr.liveSharingOnLabel') : t('dr.liveSharingOffLabel')}
              </span>
              <button onClick={() => setShowTripPopup(false)} className="w-7 h-7 rounded-lg flex items-center justify-center text-white shrink-0 cursor-pointer" style={{ background: 'rgba(255,255,255,.1)' }}>✕</button>
            </div>

            {/* Trip strip */}
            <div className="flex items-center gap-2 px-3.5 py-2 shrink-0 flex-wrap" style={{ background: '#14523c' }}>
              <span className="flex items-center gap-2 rounded-full pe-3 ps-1 py-1" style={{ background: 'rgba(0,0,0,.18)', border: '1px solid rgba(255,255,255,.12)' }}>
                <span className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold ltr-num" style={{ background: '#d4a13c', color: '#2a1c05' }}>{currentRoute?.vehicle_number || currentRoute?.vehicle_type || '—'}</span>
                <span className="font-sans text-[12px] font-bold text-white truncate">{chalan.origin} → {chalan.destination}</span>
              </span>
              <span className="font-sans text-[10.5px] text-[#b7cdc0] truncate">{user?.full_name}</span>
              {sharing && geoError && <span className="font-sans text-[10px] text-amber-200 truncate">· {geoError}</span>}
            </div>

            {/* One continuous scrolling view — map, then stops/KPI
                sidebar cards, then alight alerts, then route group —
                matching the order the user originally described. In
                full-map mode the map card itself is given flex-1/
                min-h-0 so it fills exactly the space available between
                the trip strip and the chat footer — the real cause of
                the "blank space under the map" bug: everything below
                used to just disappear while the scroll container kept
                its full height. */}
            <div className={mapExpanded ? 'flex-1 min-h-0 flex flex-col p-3' : 'flex-1 overflow-y-auto p-3 flex flex-col gap-2.5'}>
              {(() => {
                  return (
                  <>
                  {stops.some((s) => s.lat != null) ? (
                    <div className={`relative rounded-xl overflow-hidden ${mapExpanded ? 'flex-1 min-h-0' : ''}`} style={{ border: '1px solid #e2ded0', background: '#e7eadf' }}>
                      <LeafletMap ref={tripMapRef} pins={mapPins} route={routePath ?? undefined} height={mapExpanded ? '100%' : 300} />

                      {/* Full-map toggle sits first in the top-start
                          corner; the speed HUD (compact view only)
                          stacks directly below it in the same column
                          instead of overlapping it — the real alignment
                          bug from the previous pass. */}
                      <button
                        onClick={() => setMapExpanded((v) => !v)}
                        className="absolute z-[5] flex items-center gap-1.5 rounded-full px-3 py-2 font-sans text-[12px] font-bold cursor-pointer"
                        style={mapExpanded
                          ? { top: 10, insetInlineEnd: 10, background: '#14523c', color: '#fff' }
                          : { top: 10, insetInlineStart: 10, background: '#14523c', color: '#fff' }}
                      >
                        {mapExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />} {t(mapExpanded ? 'dr.exitFullMapBtn' : 'dr.fullMapBtn')}
                      </button>

                      {!mapExpanded && (
                        <>
                          <div className="absolute z-[5] rounded-xl px-3.5 py-2.5 text-center min-w-[84px]" style={{ top: 54, insetInlineStart: 10, background: 'rgba(11,46,34,.88)', border: '1px solid rgba(255,255,255,.14)', backdropFilter: 'blur(6px)' }}>
                            <p className="font-sans text-[30px] font-bold text-white leading-none ltr-num">{speedKph ?? '—'}</p>
                            <p className="font-sans text-[9.5px] mt-0.5" style={{ color: '#b7cdc0' }}>{t('dr.kphUnit')}</p>
                            <div className="mt-1.5 mx-auto rounded-full overflow-hidden" style={{ width: 60, height: 4, background: 'rgba(255,255,255,.16)' }}>
                              <div className="h-full rounded-full" style={{ width: `${Math.min(100, ((speedKph ?? 0) / 90) * 100)}%`, background: 'linear-gradient(90deg,#e8bd63,#7be3ac)' }} />
                            </div>
                          </div>

                          <div className="absolute z-[5] flex flex-col gap-1.5" style={{ top: 10, insetInlineEnd: 10 }}>
                            <button onClick={() => tripMapRef.current?.zoomIn()} className="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer" style={{ background: 'rgba(255,255,255,.94)', color: '#0f3d2e' }}><Plus size={14} /></button>
                            <button onClick={() => tripMapRef.current?.zoomOut()} className="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer" style={{ background: 'rgba(255,255,255,.94)', color: '#0f3d2e' }}><Minus size={14} /></button>
                            {vehiclePinIndex >= 0 && (
                              <button onClick={() => tripMapRef.current?.focusPin(vehiclePinIndex, 14)} className="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer" style={{ background: '#14523c', color: '#fff' }}><Crosshair size={14} /></button>
                            )}
                          </div>
                        </>
                      )}

                      {mapExpanded && vehiclePinIndex >= 0 && (
                        <div className="absolute z-[5] flex flex-col gap-1.5" style={{ top: 10, insetInlineStart: 10 }}>
                          <button onClick={() => tripMapRef.current?.zoomIn()} className="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer" style={{ background: 'rgba(255,255,255,.94)', color: '#0f3d2e' }}><Plus size={14} /></button>
                          <button onClick={() => tripMapRef.current?.zoomOut()} className="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer" style={{ background: 'rgba(255,255,255,.94)', color: '#0f3d2e' }}><Minus size={14} /></button>
                          <button onClick={() => tripMapRef.current?.focusPin(vehiclePinIndex, 14)} className="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer" style={{ background: '#14523c', color: '#fff' }}><Crosshair size={14} /></button>
                        </div>
                      )}

                      {/* Legend — full-map mode only */}
                      {mapExpanded && (
                        <div className="absolute z-[5] rounded-xl p-2.5 flex flex-col gap-1" style={{ bottom: 70, insetInlineEnd: 10, background: 'rgba(11,46,34,.85)' }}>
                          {[
                            { color: '#1c6a4c', label: t('dr.legendBusLabel'), shape: 'circle' },
                            { color: '#54e39b', label: t('dr.legendRouteLabel'), shape: 'line' },
                            { color: '#2a8a63', label: t('dr.legendStartLabel'), shape: 'pin' },
                            { color: '#c73c3c', label: t('dr.legendDestLabel'), shape: 'pin' },
                          ].map((l) => (
                            <div key={l.label} className="flex items-center gap-1.5">
                              {l.shape === 'line' ? (
                                <span style={{ width: 10, height: 3, borderRadius: 2, background: l.color }} />
                              ) : (
                                <span className="rounded-full" style={{ width: 8, height: 8, background: l.color }} />
                              )}
                              <span className="font-sans text-[9.5px]" style={{ color: '#f4f7f3' }}>{l.label}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* A single small remaining-distance chip — full-
                          map mode only. "Next stop" is no longer
                          duplicated here: it's what the stop belt below
                          is for, and the compact-mode KPI strip already
                          covers remaining distance when the map isn't
                          expanded. */}
                      {mapExpanded && (() => {
                        const remainingKm = routePath && routePath.length >= 2 && driverKmNow != null ? Math.max(0, projectOntoRoute(routePath, routePath[routePath.length - 1]).distanceAlongKm - driverKmNow) : null
                        return (
                          <div className="absolute z-[5] flex items-center gap-1.5 rounded-xl px-3 py-2" style={{ top: 54, insetInlineEnd: 10, background: 'rgba(11,46,34,.88)', border: '1px solid rgba(255,255,255,.14)' }}>
                            <RouteIcon size={13} style={{ color: '#b7cdc0' }} />
                            <p className="font-sans text-[12px] font-bold text-white ltr-num">{remainingKm != null ? `≈${remainingKm.toFixed(0)} ${t('dr.kmUnit')}` : '—'}</p>
                          </div>
                        )
                      })()}

                      {/* Stop belt — ported from the horizontal stop
                          strip RouteGroupPanel.tsx's own fullscreen map
                          already uses for drivers elsewhere in this app
                          ("the same old belt"). Always on, compact and
                          full-map alike, so there's one single place
                          "next stop" lives instead of a card repeating
                          what this already shows. */}
                      {stopBeltRows.length > 0 && (
                        <div className="absolute inset-x-0 bottom-0 pt-7 pb-2 px-2 z-[4]" style={{ background: 'linear-gradient(to top, rgba(10,30,22,.5), transparent)' }}>
                          <div className="flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                            {stopBeltRows.map((s) => (
                              <button
                                key={s.id}
                                type="button"
                                onClick={() => { if (s.pinIndex != null) tripMapRef.current?.focusPin(s.pinIndex, 14) }}
                                className="shrink-0 rounded-xl px-3 py-2 min-w-[110px] text-start cursor-pointer"
                                style={{ background: '#fff', border: s.isNext ? '1.5px solid #d4a13c' : '1px solid transparent' }}
                              >
                                <p className="font-sans text-[11px] font-bold truncate" style={{ color: s.done ? '#94a3b8' : '#16221c', textDecorationLine: s.done ? 'line-through' : 'none' }}>{s.label}</p>
                                <p className="font-sans text-[10px] font-bold ltr-num" style={{ color: s.done ? '#94a3b8' : s.isNext ? '#b8862f' : '#166534' }}>
                                  {s.done ? t('dr.stopPassedHint') : s.dist != null ? `${etaMinutesFor(s.dist, speedKph)} ${t('dr.minUnit')}` : '—'}
                                </p>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="font-sans text-[12px] text-center py-6" style={{ color: '#7a857d' }}>{t('dr.noMoreStopsHint')}</p>
                  )}

                  {!mapExpanded && (
                  <>
                  {/* KPI strip */}
                  {(() => {
                    const remainingKm = routePath && routePath.length >= 2 && driverKmNow != null ? Math.max(0, projectOntoRoute(routePath, routePath[routePath.length - 1]).distanceAlongKm - driverKmNow) : null
                    return (
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { icon: <Gauge size={13} />, label: t('dr.currentSpeedLabel'), value: speedKph ?? '—', unit: t('dr.kphUnit'), bar: '#2a8a63' },
                          { icon: <Clock size={13} />, label: t('dr.etaToDestLabel'), value: remainingKm != null ? etaMinutesFor(remainingKm, speedKph) : '—', unit: t('dr.minUnit'), bar: '#d4a13c' },
                          { icon: <RouteIcon size={13} />, label: t('dr.remainingDistLabel'), value: remainingKm != null ? remainingKm.toFixed(1) : '—', unit: t('dr.kmUnit'), bar: '#2f6fb0' },
                        ].map((kpi, i) => (
                          <div key={i} className="relative rounded-xl p-2.5 overflow-hidden" style={{ background: '#fff', border: '1px solid #e2ded0' }}>
                            <span className="absolute inset-y-0 start-0" style={{ width: 4, background: kpi.bar }} />
                            <p className="flex items-center gap-1.5 font-sans text-[10px]" style={{ color: '#7a857d' }}>{kpi.icon}{kpi.label}</p>
                            <p className="font-sans text-[18px] font-bold mt-0.5 ltr-num" style={{ color: '#16221c' }}>{kpi.value}<span className="font-sans text-[10.5px] font-semibold ms-1" style={{ color: '#7a857d' }}>{kpi.unit}</span></p>
                          </div>
                        ))}
                      </div>
                    )
                  })()}

                  {/* Alight alerts */}
                  {alightDue.length > 0 && (
                    <div className="rounded-2xl overflow-hidden" style={{ background: '#fff', border: '1px solid #e2ded0' }}>
                      <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderBottom: '1px solid #f1f5f9', background: '#faf8f2' }}>
                        <span className="w-8 h-8 rounded-[10px] flex items-center justify-center" style={{ background: '#fbf2de', color: '#b8862f' }}><UserX size={15} /></span>
                        <p className="font-sans text-[13px] font-bold flex-1" style={{ color: '#16221c' }}>{t('dr.alightAlertsHeading')}</p>
                        <span className="rounded-full px-2.5 py-1 font-sans text-[11px] font-bold ltr-num" style={{ background: '#eeece3', color: '#4a564e' }}>{alightDue.length}</span>
                      </div>
                      <div className="p-2.5 flex flex-col gap-2">
                        {alightDue.map(({ r, isFreeRequest, kmAhead }) => {
                          const urgent = kmAhead <= 2
                          return (
                            <div key={r.id} className="relative rounded-xl p-2.5 pe-3 ps-3 flex gap-2.5 overflow-hidden" style={{ background: urgent ? 'linear-gradient(180deg,#fbe9e9,#fff)' : 'linear-gradient(180deg,#fbf2de,#fff)', border: `1px solid ${urgent ? 'rgba(179,43,43,.35)' : 'rgba(184,134,47,.4)'}` }}>
                              <span className="absolute inset-y-0 start-0" style={{ width: 4, background: urgent ? '#c73c3c' : '#d4a13c' }} />
                              <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 font-sans text-[14px] font-bold text-white" style={{ backgroundImage: avatarBackground(r.id) }}>{r.name.trim().charAt(0).toUpperCase() || '?'}</span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-sans text-[13.5px] font-bold truncate" style={{ color: '#16221c' }}>{r.name}</p>
                                  {isFreeRequest && <span className="shrink-0 rounded-full px-2 py-0.5 font-sans text-[9px] font-bold" style={{ background: '#2f6fb0', color: '#fff' }}>{t('dr.freeGpsAlightBadge')}</span>}
                                </div>
                                <p className="font-sans text-[11px] mt-0.5" style={{ color: '#4a564e' }}>
                                  {!isFreeRequest && r.alight_label ? r.alight_label : t('dr.freeGpsAlightBadge')} · <span className="ltr-num">{r.seats}</span> {t('dr.catchRequestSeatsLabel').replace('{n}', '').trim()}
                                </p>
                                <p className="font-sans text-[11.5px] font-bold mt-1" style={{ color: urgent ? '#b32b2b' : '#b8862f' }}>
                                  {urgent ? t('dr.alightNowHint') : t('dr.alightSoonHint')} — <span className="ltr-num">{kmAhead.toFixed(1)}</span> {t('dr.kmUnit')} · <span className="ltr-num">{etaMinutesFor(kmAhead, speedKph)}</span> {t('dr.minUnit')}
                                </p>
                                <div className="flex gap-2 mt-2">
                                  <button onClick={() => offloadRider(r)} disabled={offloadActionId === r.id} className="flex-1 py-1.5 rounded-full font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50" style={{ background: urgent ? 'linear-gradient(180deg,#c73c3c,#b32b2b)' : 'linear-gradient(180deg,#d4a13c,#b8862f)', color: urgent ? '#fff' : '#2a1c05' }}>{t('dr.offloadPassengerBtn')}</button>
                                  {isFreeRequest && (
                                    <button onClick={() => declineAlightRequest(r)} disabled={offloadActionId === r.id} className="flex-1 py-1.5 rounded-full font-sans text-[11.5px] font-semibold cursor-pointer disabled:opacity-50" style={{ background: '#fff', border: '1px solid #cfc9b6', color: '#4a564e' }}>{t('dr.cantStopHereBtn')}</button>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Mid-route catch requests */}
                  {(pendingCatch.length > 0 || acceptedCatch.length > 0) && (
                    <div className="rounded-2xl overflow-hidden" style={{ background: '#fff', border: '1px solid #e2ded0' }}>
                      <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderBottom: '1px solid #f1f5f9', background: '#faf8f2' }}>
                        <span className="w-8 h-8 rounded-[10px] flex items-center justify-center" style={{ background: '#fbf2de', color: '#b8862f' }}><Navigation size={15} /></span>
                        <p className="font-sans text-[13px] font-bold flex-1" style={{ color: '#16221c' }}>{t('dr.catchRequestsHeading')}</p>
                      </div>
                      <div className="p-2.5 flex flex-col gap-2">
                        {pendingCatch.map((r) => {
                          const msLeft = r.catch_request_expires_at ? new Date(r.catch_request_expires_at).getTime() - nowTick : null
                          const expired = msLeft != null && msLeft <= 0
                          const mm = msLeft != null && msLeft > 0 ? Math.floor(msLeft / 60000) : 0
                          const ss = msLeft != null && msLeft > 0 ? Math.floor((msLeft % 60000) / 1000) : 0
                          const alightStop = stops.find((s) => s.id === r.alight_stop_id)
                          const distKm = myLivePos && r.catch_lat != null && r.catch_lng != null ? haversineKm(myLivePos, { lat: r.catch_lat, lng: r.catch_lng }) : null
                          return (
                            <div key={r.id} className="rounded-xl p-2.5 flex flex-col gap-1" style={{ background: '#faf8f2', border: '1px solid #e2ded0' }}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-sans text-[12.5px] font-bold" style={{ color: '#16221c' }}>{r.name || t('dr.catchRequestRiderFallback')}</span>
                                <span className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold ltr-num" style={{ background: expired ? '#eeece3' : '#fbf2de', color: expired ? '#7a857d' : '#b8862f' }}>
                                  {expired ? t('dr.catchRequestExpiredLabel') : t('dr.catchRequestExpiresLabel').replace('{mmss}', `${mm}:${String(ss).padStart(2, '0')}`)}
                                </span>
                              </div>
                              <p className="font-sans text-[11px]" style={{ color: '#4a564e' }}>
                                {t('dr.catchRequestSeatsLabel').replace('{n}', String(r.seats))}
                                {alightStop ? ` · ${t('dr.catchRequestAlightLabel').replace('{stop}', alightStop.counter_name ? `${alightStop.counter_name} · ${alightStop.counter_city}` : alightStop.label)}` : ''}
                                {distKm != null ? ` · ${t('dr.catchRequestDistanceLabel').replace('{km}', distKm.toFixed(1))}` : ''}
                              </p>
                              <div className="flex gap-2 mt-1">
                                <button onClick={() => acceptCatch(r.id)} disabled={catchActionId === r.id || expired} className="flex-1 py-1.5 rounded-full font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50" style={{ background: '#1c6a4c', color: '#fff' }}>{t('dr.acceptCatchBtn')}</button>
                                <button onClick={() => declineCatch(r.id)} disabled={catchActionId === r.id} className="flex-1 py-1.5 rounded-full font-sans text-[11.5px] font-semibold cursor-pointer disabled:opacity-50" style={{ background: '#fff', border: '1px solid #cfc9b6', color: '#b32b2b' }}>{t('dr.declineCatchBtn')}</button>
                              </div>
                            </div>
                          )
                        })}
                        {acceptedCatch.length > 0 && (
                          <p className="font-sans text-[11px]" style={{ color: '#4a564e' }}>{t('dr.acceptedCatchHeading')}: {acceptedCatch.map((r) => r.name || t('dr.catchRequestRiderFallback')).join(', ')}</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Stops no longer get their own card here — they live
                      on the belt attached to the map above now (the
                      real point of moving them there: this frees the
                      space for Riders/Chat below). */}
                  <div className="rounded-2xl overflow-hidden" style={{ background: '#fff', border: '1px solid #e2ded0' }}>
                    <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderBottom: '1px solid #f1f5f9', background: '#faf8f2' }}>
                      <span className="w-8 h-8 rounded-[10px] flex items-center justify-center" style={{ background: '#e3f2ea', color: '#14523c' }}><Users2 size={15} /></span>
                      <p className="font-sans text-[13px] font-bold flex-1" style={{ color: '#16221c' }}>{t('dr.onboardRosterHeading')}</p>
                      <span className="rounded-full px-2.5 py-1 font-sans text-[11px] font-bold ltr-num" style={{ background: '#eeece3', color: '#4a564e' }}>{onboardRoster.reduce((sum, r) => sum + r.seats, 0)}</span>
                    </div>
                    <div className="p-2.5 flex flex-col overflow-y-auto" style={{ maxHeight: 280 }}>
                      {onboardRoster.length === 0 ? (
                        <p className="font-sans text-[12px] text-center py-4" style={{ color: '#7a857d' }}>{t('dr.noOneOnboardHint')}</p>
                      ) : onboardRoster.map((r) => {
                        const point = r.alight_request_lat != null ? { lat: r.alight_request_lat, lng: r.alight_request_lng! } : (r.alight_lat != null ? { lat: r.alight_lat, lng: r.alight_lng! } : null)
                        const kmAhead = point ? kmAheadOf(point.lat, point.lng) : null
                        const soon = kmAhead != null && kmAhead <= 5
                        return (
                          <div key={r.id} className="flex items-center gap-2.5 py-2" style={{ borderTop: '1px solid #f1f5f9' }}>
                            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 font-sans text-[12.5px] font-bold text-white" style={{ backgroundImage: avatarBackground(r.id) }}>{r.name.trim().charAt(0).toUpperCase() || '?'}</span>
                            <div className="min-w-0 flex-1">
                              <p className="font-sans text-[12.5px] font-semibold truncate" style={{ color: '#16221c' }}>{r.name}</p>
                              <p className="font-sans text-[10.5px] truncate" style={{ color: '#7a857d' }}>{r.alight_request_lat != null ? t('dr.freeGpsAlightBadge') : (r.alight_label ?? '—')} · <span className="ltr-num">{r.seats}</span></p>
                            </div>
                            <span className="shrink-0 rounded-full px-2.5 py-1 font-sans text-[10.5px] font-bold" style={{ background: soon ? '#fbf2de' : '#e3f2ea', color: soon ? '#b8862f' : '#14523c' }}>{soon ? t('dr.riderStateSoon') : t('dr.riderStateOn')}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="rounded-2xl p-3 flex flex-col gap-2" style={{ background: '#fff', border: '1px solid #e2ded0' }}>
                    <button
                      onClick={async () => {
                        const on = !sharing
                        const { error } = await supabase.rpc('set_route_location_sharing', { p_route_id: routeId, p_on: on })
                        if (!error) setSharing(on)
                      }}
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-full font-sans text-[13px] font-bold cursor-pointer"
                      style={{ background: 'linear-gradient(180deg,#2a8a63,#1c6a4c)', color: '#fff' }}
                    >
                      <Radio size={14} className={sharing ? 'animate-pulse' : ''} /> {sharing ? t('dr.liveSharingOnLabel') : t('dr.liveSharingOffLabel')}
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => { setShowTripPopup(false); setTab('trip') }} className="py-2.5 rounded-full font-sans text-[12.5px] font-semibold cursor-pointer" style={{ background: '#fff', border: '1px solid #cfc9b6', color: '#4a564e' }}>{t('dr.openStopDeskBtn')}</button>
                      <button onClick={endTripNow} disabled={endingTrip} className="py-2.5 rounded-full font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50" style={{ background: 'linear-gradient(180deg,#c73c3c,#b32b2b)', color: '#fff' }}>{endingTrip ? t('action.loading') : t('dr.endTripBtn')}</button>
                    </div>
                  </div>
                  </>
                  )}
                  </>
                  )
              })()}
            </div>

            {/* Chat — pinned as a persistent footer, not a tab, per the
                user's own original description ("at the bottom there
                is a chat box from where driver can send messages") —
                always reachable without navigating away from the map/
                stops/riders above. 2026-11-21: given real breathing
                room now that the Stops card moved onto the map belt,
                so the log is taller, scrolls through full history (not
                just the last 6), and auto-scrolls to the newest message. */}
            <div className="shrink-0 flex flex-col" style={{ borderTop: '1px solid #e2ded0', background: '#faf8f2' }}>
              <div className="flex items-center gap-1.5 px-3 pt-2">
                <MessageCircle size={13} style={{ color: '#14523c' }} />
                <p className="font-sans text-[11px] font-bold" style={{ color: '#14523c' }}>{t('dr.tripChatHeading')}</p>
                {chatMessages.length > 0 && <span className="rounded-full px-1.5 py-0.5 font-sans text-[9.5px] font-bold ltr-num" style={{ background: '#eeece3', color: '#4a564e' }}>{chatMessages.length}</span>}
              </div>
              <div ref={chatScrollRef} className="flex flex-col gap-2 px-3 pt-1.5 pb-1 overflow-y-auto scroll-smooth" style={{ maxHeight: 170 }}>
                {chatMessages.length === 0 ? (
                  <p className="font-sans text-[10.5px] text-center py-3" style={{ color: '#7a857d' }}>{t('dr.noChatMessagesHint')}</p>
                ) : chatMessages.map((m) => (
                  <div key={m.id} className="max-w-[82%] rounded-2xl px-3 py-2" style={m.is_me
                    ? { alignSelf: 'flex-end', background: 'linear-gradient(180deg,#2a8a63,#1c6a4c)', color: '#fff', borderStartStartRadius: 16, borderEndEndRadius: 5, boxShadow: '0 1px 4px rgba(20,82,60,.25)' }
                    : { alignSelf: 'flex-start', background: '#fff', border: '1px solid #e2ded0', color: '#16221c', borderStartEndRadius: 16, borderEndStartRadius: 5, boxShadow: '0 1px 3px rgba(0,0,0,.05)' }}>
                    {!m.is_me && <p className="font-sans text-[9.5px] font-bold mb-0.5" style={{ color: '#14523c' }}>{m.sender_name}</p>}
                    <p className="font-sans text-[12.5px] leading-snug">{m.body}</p>
                    <p className="font-sans text-[8.5px] mt-1 text-end ltr-num" style={{ color: m.is_me ? 'rgba(255,255,255,.65)' : '#9ca8a0' }}>
                      {new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 overflow-x-auto px-3 pt-2" style={{ scrollbarWidth: 'none' }}>
                {QUICK_CHIPS.map((c) => (
                  <button key={c} onClick={() => sendChat(c)} disabled={chatSending} className="shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 font-sans text-[11px] cursor-pointer disabled:opacity-50" style={{ background: '#fff', border: '1px solid #cfc9b6', color: '#4a564e' }}>{c}</button>
                ))}
              </div>
              <div className="flex items-center gap-2 p-2.5">
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendChat() }} placeholder={t('dr.chatPlaceholder')} className="flex-1 px-3.5 py-2.5 rounded-full font-sans text-[13px]" style={{ background: '#fff', border: '1px solid #cfc9b6', color: '#16221c' }} />
                <button onClick={() => sendChat()} disabled={chatSending || !chatInput.trim()} className="w-10 h-10 rounded-full flex items-center justify-center cursor-pointer disabled:opacity-50 shrink-0" style={{ backgroundImage: 'linear-gradient(145deg,#2a8a63,#14523c)', color: '#fff' }}><Send size={16} /></button>
              </div>
            </div>
          </div>
        </div>
        )
      })()}
      <h1 className="font-bold text-[20px] text-dp-primary flex items-center gap-2"><Bus size={19} /> SAFAR Driver</h1>

      <div className="flex gap-1.5 bg-white border border-[#e5e2d0] rounded-xl p-1">
        {([
          ['home', t('dr.homeTab')], ['trip', t('dr.tripTab')], ['cash', t('dr.cashTab')], ['pay', t('dr.payTab')],
        ] as [Tab, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`flex-1 py-2 rounded-lg font-sans text-[12px] font-bold cursor-pointer ${tab === key ? 'bg-[#166534] text-white' : 'text-[#64748b]'}`}>{label}</button>
        ))}
      </div>

      {tab === 'home' && (
        <>
          <FleetPanel>
            <FleetPanelHead icon={<Clock size={14} />} title={t('dr.attendanceHeading')}
              action={attendance?.checked_in ? <FleetStatusPill tone="green">{t('dr.checkedInStatusLabel')}</FleetStatusPill> : undefined} />
            <FleetPanelBody className="flex flex-col gap-2">
              {!attendance?.has_terminal ? (
                <p className="font-sans text-[12px] text-[#94a3b8]">{t('dr.attendanceNoTerminalHint')}</p>
              ) : (
                <>
                  <p className="font-sans text-[12px] text-[#1e293b]">
                    {attendance.checked_in
                      ? t('dr.attendanceCheckedInHint').replace('{terminal}', attendance.counter_name ? `${attendance.counter_name} · ${attendance.counter_city}` : attendance.counter_city ?? '').replace('{time}', attendance.since ? new Date(attendance.since).toLocaleTimeString() : '')
                      : t('dr.attendanceNotCheckedInHint')}
                  </p>
                  {attendance.checked_in ? (
                    <button onClick={doCheckOut} disabled={checkingAttendance} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50">
                      <LogOut size={14} /> {checkingAttendance ? t('dr.gettingLocationHint') : t('dr.checkOutBtn')}
                    </button>
                  ) : (
                    <button onClick={doCheckIn} disabled={checkingAttendance} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                      <LogIn size={14} /> {checkingAttendance ? t('dr.gettingLocationHint') : t('dr.checkInBtn')}
                    </button>
                  )}
                </>
              )}
            </FleetPanelBody>
          </FleetPanel>

          <FleetPanel>
            <FleetPanelHead icon={<MapPin size={14} />} title={t('dr.myRoutesHeading')} />
            {routes.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8] text-center py-5">{t('dr.noRouteAssignedHint')}</p>
            ) : (
              <div className="flex flex-col divide-y divide-[#f1f5f9]">
                {routes.map((r) => (
                  <div key={r.id} className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{r.origin} → {r.destination}</p>
                      <p className="font-sans text-[10.5px] text-[#94a3b8] ltr-num">{r.vehicle_number || r.vehicle_type}{r.departure_time ? ` · ${r.departure_time.slice(0, 5)}` : ''}</p>
                    </div>
                    {r.is_co_driver && <FleetStatusPill tone="blue">{t('dr.coDriverLabel')}</FleetStatusPill>}
                  </div>
                ))}
              </div>
            )}
          </FleetPanel>

          {/* 942: "when and where is my next job" — merges my own
              default routes with any day I've been roster-assigned to
              cover someone else's, and my own upcoming leave days. */}
          {(jobCalendar.length > 0 || leaveDays.length > 0) && (
            <FleetPanel>
              <FleetPanelHead icon={<CalendarDays size={14} />} title={t('dr.jobCalendarHeading')} description={t('dr.jobCalendarDesc')} />
              <div className="flex flex-col divide-y divide-[#f1f5f9]">
                {jobCalendar.slice(0, 7).map((j) => (
                  <div key={`${j.route_id}|${j.the_date}`} className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{j.origin} → {j.destination}</p>
                      <p className="font-sans text-[10.5px] text-[#94a3b8] ltr-num">
                        {new Date(j.the_date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                        {j.departure_time ? ` · ${j.departure_time.slice(0, 5)}` : ''} · {j.vehicle_number || j.vehicle_type}
                      </p>
                    </div>
                    {j.via === 'roster_override' && <FleetStatusPill tone="amber">{t('dr.coveringForLabel')}</FleetStatusPill>}
                  </div>
                ))}
                {leaveDays.map((l) => (
                  <div key={l.the_date} className="px-3.5 py-2.5 flex items-center justify-between gap-2" style={{ background: '#FEF2F2' }}>
                    <p className="font-sans text-[12px] font-semibold text-[#b91c1c]">
                      {t('dr.onLeaveLabel')} · {new Date(l.the_date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}{l.reason ? ` · ${l.reason}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </FleetPanel>
          )}
        </>
      )}

      {tab === 'trip' && (
        <>
          {routes.length > 1 && (
            <select value={routeId} onChange={(e) => setRouteId(e.target.value)} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
              {routes.map((r) => <option key={r.id} value={r.id}>{r.vehicle_number || r.vehicle_type} · {r.origin} → {r.destination}</option>)}
            </select>
          )}
          {currentRoute?.is_two_way && (
            <div className="flex gap-2">
              <button onClick={() => setDirection('outbound')} className={`flex-1 py-2 rounded-lg font-sans text-[12.5px] font-bold cursor-pointer ${direction === 'outbound' ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>{t('mv.directionOutboundTab')}</button>
              <button onClick={() => setDirection('return')} className={`flex-1 py-2 rounded-lg font-sans text-[12.5px] font-bold cursor-pointer ${direction === 'return' ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>{t('mv.directionReturnTab')}</button>
            </div>
          )}

          {loadingChalan ? (
            <div className="text-center py-8"><LoadingDots /></div>
          ) : !chalan ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-8">{t('mv.noScheduleYetHint')}</p>
          ) : (
            <>
              <FleetPanelBody className="grid grid-cols-3 gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-2.5">
                <FleetStat label={t('mv.confirmedLabel')} icon={<Users2 size={12} />} value={chalan.total_confirmed_count} />
                <FleetStat label={t('mv.unconfirmedLabel')} icon={<Users2 size={12} />} value={chalan.total_unconfirmed_count} valueClassName="text-[#92400e]" />
                <FleetStat label={t('mv.cashLabel')} icon={<Wallet size={12} />} value={`₨${fmt(chalan.cash_collected_pkr)}`} valueClassName="text-[#1e293b]" />
              </FleetPanelBody>

              {chalan.run_started_at ? (
                <button onClick={() => setShowTripPopup(true)} className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl bg-[#102a36] text-white cursor-pointer">
                  <span className="flex items-center gap-2 font-sans text-[12.5px] font-bold"><Navigation size={14} /> {t('dr.openLiveTripBtn')}</span>
                  <FleetStatusPill tone={sharing ? 'green' : 'amber'}><Radio size={9} className={sharing ? 'animate-pulse' : ''} /> {sharing ? t('dr.liveSharingOnLabel') : t('dr.liveSharingOffLabel')}</FleetStatusPill>
                </button>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {startStakeInfo?.applies && (
                    <p className={`font-sans text-[10.5px] rounded-lg px-2 py-1 ${startStakeInfo.can_afford ? 'bg-white border border-[#e5e2d0] text-[#64748b]' : 'bg-rose-50 text-rose-700 font-semibold'}`}>
                      {t('mv.startingStakeNote').replace('{stake}', String(startStakeInfo.stake_pkr)).replace('{balance}', String(Math.round(startStakeInfo.balance_pkr)))}
                    </p>
                  )}
                  <button onClick={startRoute} disabled={startingRoute || (startStakeInfo?.applies && !startStakeInfo.can_afford)}
                    className="flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-2xl bg-[#166534] text-white cursor-pointer disabled:opacity-50">
                    <Play size={14} /> <span className="font-sans text-[12.5px] font-bold">{startingRoute ? t('action.loading') : t('dr.startRouteBtn')}</span>
                  </button>
                </div>
              )}

              <FleetPanel>
                <FleetPanelHead icon={<ClipboardCheck size={14} />} title={t('mv.terminalStopDeskHeading')} description={isLockedToOwnTerminal ? t('mv.yourTerminalHint') : undefined} />
                <FleetPanelBody className="flex flex-col gap-2 p-2.5">
                  {visibleStopOptions.length === 0 ? (
                    <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.noTerminalAssignedHint')}</p>
                  ) : (
                    <>
                      {!isLockedToOwnTerminal && (
                        <select value={selectedStopKey} onChange={(e) => setSelectedStopKey(e.target.value)} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                          {visibleStopOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                        </select>
                      )}
                      {deskQueue.length === 0 ? (
                        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.noBookingsFoundHint')}</p>
                      ) : (
                        <div className="flex flex-col divide-y divide-[#f1f5f9] -mx-2.5">{deskQueue.map(renderDeskRow)}</div>
                      )}
                      {alreadyClosed ? (
                        <p className="font-sans text-[11.5px] text-[#166534] font-semibold text-center py-2 bg-[#F0FDF4] rounded-lg">{t('mv.stopAlreadyClosedHint')}</p>
                      ) : (
                        <div className="flex flex-col gap-2 pt-2 border-t border-[#f1f5f9]">
                          <div className="grid grid-cols-2 gap-2">
                            <input type="number" min="0" value={advanceInput} onChange={(e) => setAdvanceInput(e.target.value)} placeholder={t('mv.driverAdvanceLabel')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                            <input type="number" min="0" value={otherCashInput} onChange={(e) => setOtherCashInput(e.target.value)} placeholder={t('mv.otherCashPaymentLabel')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                          </div>
                          <input value={stopNoteInput} onChange={(e) => setStopNoteInput(e.target.value)} placeholder={t('mv.stopChallanNoteLabel')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                          <button onClick={closeStop} disabled={closing} className="py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{closing ? t('action.loading') : t('mv.closeStopBtn')}</button>
                        </div>
                      )}
                    </>
                  )}
                </FleetPanelBody>
              </FleetPanel>

              <FleetPanel>
                <FleetPanelHead icon={<Plus size={14} />} title={t('mv.addWalkupPassengerHeading')} />
                <FleetPanelBody>
                  <FleetFormGrid>
                    <FleetFormField label={t('mv.passengerNameLabel')} full>
                      <input value={walkupName} onChange={(e) => setWalkupName(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                    </FleetFormField>
                    <FleetFormField label={t('mv.seatsSuffix')}>
                      <input type="number" min={1} value={walkupSeats} onChange={(e) => setWalkupSeats(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                    </FleetFormField>
                    <FleetFormField label={t('mv.cashCollectedLabel')}>
                      <input type="number" value={walkupAmount} onChange={(e) => setWalkupAmount(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                    </FleetFormField>
                    <FleetFormField label="" full>
                      <button onClick={recordWalkup} disabled={savingWalkup} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
                        {savingWalkup ? t('action.saving') : t('mv.recordWalkupBtn')}
                      </button>
                    </FleetFormField>
                  </FleetFormGrid>
                </FleetPanelBody>
              </FleetPanel>
            </>
          )}
        </>
      )}

      {tab === 'cash' && (
        <>
          <FleetKpiRow cols={2}>
            <FleetStat label={t('mv.cashInHandLabel')} icon={<Wallet size={12} />} value={cashInHand !== null ? `₨${fmt(cashInHand)}` : '—'} />
            <FleetStat label={t('mv.driverCashFloatLabel')} icon={<Banknote size={12} />} value={masterChallan ? `₨${fmt(masterChallan.driver_cash_float_pkr)}` : '—'} valueClassName={(masterChallan?.driver_cash_float_pkr ?? 0) > 0 ? 'text-[#b45309]' : 'text-[#166534]'} />
          </FleetKpiRow>

          {masterChallan && (
            <FleetPanel>
              <FleetPanelHead icon={<HandCoins size={14} />} title={t('mv.masterChallanHeading')} />
              <FleetPanelBody className="flex flex-col gap-2 p-2.5">
                <FleetKpiRow cols={2}>
                  <FleetStat label={t('mv.driverAdvancesLabel')} value={`₨${fmt(masterChallan.driver_advances_pkr)}`} valueClassName="text-[#1e293b]" />
                  <FleetStat label={t('mv.driverHandoversLabel')} value={`₨${fmt(masterChallan.driver_handovers_pkr)}`} valueClassName="text-[#1e293b]" />
                </FleetKpiRow>
                {masterChallan.handovers.length > 0 && (
                  <div className="flex flex-col divide-y divide-[#f1f5f9] mt-1">
                    {masterChallan.handovers.map((h) => (
                      <div key={h.id} className="py-1.5 flex items-center justify-between gap-2">
                        <span className="font-sans text-[12px] text-[#1e293b]">₨{fmt(h.amount_pkr)}{h.counter_city ? ` · ${h.counter_city}` : ''}</span>
                        <FleetStatusPill tone={h.status === 'confirmed' ? 'green' : 'amber'}>{h.status === 'confirmed' ? t('dr.confirmedHandoverLabel') : t('dr.pendingHandoverLabel')}</FleetStatusPill>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-col gap-2 pt-2 border-t border-[#f1f5f9]">
                  <input type="number" min="0" value={handoverAmount} onChange={(e) => setHandoverAmount(e.target.value)} placeholder={t('mv.handoverAmountLabel')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                  <select value={handoverCounterId} onChange={(e) => setHandoverCounterId(e.target.value)} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                    <option value="">{t('mv.handoverReceivedAtLabel')}</option>
                    {counters.map((c) => <option key={c.id} value={c.id}>{c.name ? `${c.name} · ${c.city}` : c.city}</option>)}
                  </select>
                  <input value={handoverNote} onChange={(e) => setHandoverNote(e.target.value)} placeholder={t('mv.handoverNoteLabel')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                  <button onClick={submitHandover} disabled={submittingHandover} className="py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                    {submittingHandover ? t('action.loading') : t('dr.submitHandoverBtn')}
                  </button>
                </div>
              </FleetPanelBody>
            </FleetPanel>
          )}
        </>
      )}

      {tab === 'pay' && payroll && (
        <>
          <FleetPanel>
            <FleetPanelHead icon={<Wallet size={14} />} title={t('dr.myPayHeading')} />
            <FleetPanelBody className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-sans text-[11px] text-[#64748b]">{t('dr.currentSalaryLabel')}</span>
                <span className="font-sans text-[14px] font-bold text-[#166534] ltr-num">{payroll.current_monthly_salary_pkr != null ? `₨${fmt(payroll.current_monthly_salary_pkr)}` : t('dr.noSalarySetHint')}</span>
              </div>
              <FleetKpiRow cols={2}>
                <FleetStat label={t('dr.commissionThisMonthLabel')} icon={<TrendingUp size={12} />} value={`₨${fmt(payroll.commission_this_month_pkr)}`} />
                <FleetStat label={t('dr.overtimeThisMonthLabel')} icon={<Clock size={12} />} value={`₨${fmt(payroll.overtime_this_month_pkr)}`} />
              </FleetKpiRow>
            </FleetPanelBody>
          </FleetPanel>

          {payroll.recent_overtime.length > 0 && (
            <FleetPanel>
              <FleetPanelHead title={t('dr.recentOvertimeHeading')} />
              <div className="flex flex-col divide-y divide-[#f1f5f9]">
                {payroll.recent_overtime.map((o) => (
                  <div key={o.id} className="px-3.5 py-2 flex items-center justify-between gap-2">
                    <span className="font-sans text-[12px] text-[#1e293b] ltr-num">{o.work_date}{o.hours ? ` · ${o.hours}h` : ''}</span>
                    <span className="font-sans text-[12px] font-bold text-[#166534] ltr-num">₨{fmt(Number(o.amount_pkr))}</span>
                  </div>
                ))}
              </div>
            </FleetPanel>
          )}

          {payroll.recent_commissions.length > 0 && (
            <FleetPanel>
              <FleetPanelHead title={t('dr.recentCommissionsHeading')} />
              <div className="flex flex-col divide-y divide-[#f1f5f9]">
                {payroll.recent_commissions.map((c) => (
                  <div key={c.id} className="px-3.5 py-2 flex items-center justify-between gap-2">
                    <span className="font-sans text-[12px] text-[#1e293b] ltr-num">{new Date(c.created_at).toLocaleDateString()} · {c.seats} {t('mv.seatsSuffix')}</span>
                    <span className="font-sans text-[12px] font-bold text-[#166534] ltr-num">₨{fmt(Number(c.amount_pkr))}</span>
                  </div>
                ))}
              </div>
            </FleetPanel>
          )}

          {payroll.recent_salary_payments.length > 0 && (
            <FleetPanel>
              <FleetPanelHead title={t('dr.recentSalaryPaymentsHeading')} />
              <div className="flex flex-col divide-y divide-[#f1f5f9]">
                {payroll.recent_salary_payments.map((s) => (
                  <div key={s.id} className="px-3.5 py-2 flex items-center justify-between gap-2">
                    <span className="font-sans text-[12px] text-[#1e293b] ltr-num">{s.paid_on}</span>
                    <span className="font-sans text-[12px] font-bold text-[#166534] ltr-num">₨{fmt(Number(s.amount_pkr))}</span>
                  </div>
                ))}
              </div>
            </FleetPanel>
          )}

          <FleetPanel>
            <FleetPanelHead icon={<MessageCircleQuestion size={14} />} title={t('dr.raiseQueryBtn')} />
            <FleetPanelBody className="flex flex-col gap-2">
              <textarea value={disputeNote} onChange={(e) => setDisputeNote(e.target.value)} rows={2} placeholder={t('dr.queryPlaceholder')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              <button onClick={sendDispute} disabled={sendingDispute} className="py-2 rounded-xl border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                {sendingDispute ? t('action.loading') : t('dr.raiseQueryBtn')}
              </button>
            </FleetPanelBody>
          </FleetPanel>
        </>
      )}
    </div>
  )
}
