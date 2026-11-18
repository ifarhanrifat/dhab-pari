'use client'

// 860/864: Bookings tab — counter walk-up booking (855's record_manual_
// booking) plus the station-manager workflow researched this session:
// find an existing booking (by passenger name/mobile), reschedule or
// cancel it, see all of today's bookings, and check the seat position
// of a run departing a few days out. Real gaps confirmed before
// building this: the old version hardcoded every date to today and had
// no search/reschedule at all, across either booking source.

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Ticket, Search, X, Phone, MessageCircle, Printer, UserCheck, Baby, Plus, Mail } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetColumnLabels, FleetStatusPill } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { normalizePakPhone, printNodeInPopup } from '@/lib/receiptExport'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { SeatPickerField } from '@/components/mobility/SeatPickerField'
import { ManualTicketDocument, type ManualTicketData } from '@/components/mobility/ManualTicketDocument'
import { TerminalStopPicker, type PickableStop } from '@/components/mobility/TerminalStopPicker'
import { PickupPinMapPicker } from '@/components/mobility/PickupPinMapPicker'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
// 2026-11-19: real bug fix — is_two_way is what actually decides
// whether "Return" can even be offered. Every real route here IS
// two-way (confirmed directly against production data), with the
// vehicle running the SAME route_id back — there is no separate
// reverse-direction route row to search for, which is the wrong
// model the old Return flow was built on.
interface Route { id: string; origin: string; destination: string; departure_time: string | null; fare_per_seat_pkr: number; is_two_way: boolean }
// 2026-11-17: real gap confirmed by deep audit and the user directly —
// "what if there will be 100+ buses and hundreds of routes, how would
// we book the manual ride as per the demand and search of the rider?"
// A flat two-step vehicle→route dropdown genuinely doesn't scale past
// a handful of buses. SearchableRoute merges what the old cascading
// dropdowns needed separately (vehicle_routes + vehicles + seat kind)
// into one row a destination search can filter directly.
interface SearchableRoute extends Route {
  vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; service_code: string | null
  total_seats: number; is_van_kind: boolean; is_sleeper: boolean
}
interface VehicleSeating { totalSeats: number; isVanKind: boolean; isSleeper: boolean }
interface Counter { id: string; city: string; name: string | null }
interface FoundBooking {
  id: string; source: 'manual' | 'app'; passenger_name: string; passenger_mobile: string | null
  route_id: string; origin: string; destination: string; owner_name: string
  travel_date: string; seats: number; amount_pkr: number; status: string; payment_method: string | null
  vehicle_id: string; is_van_kind: boolean; total_seats: number; is_sleeper: boolean; seat_numbers: number[] | null
  ticket_no: string | null; boarded_at: string | null; vehicle_number: string | null; service_code: string | null
  emergency_contact_phone: string | null; luggage_note: string | null; counter_id: string | null
}
// 2026-11-17: booking wizard Phase A — the reference computes a real
// suggested fare per passenger type (Adult/Child/Infant-own-seat all
// seated and priced differently; a lap infant is the existing
// FreeChild, already unseated and free). No per-stop stage-fare table
// exists in dhab-pari to prorate by boarding segment the way the
// reference does, so this is base fare_per_seat_pkr × type multiplier
// only — a real, honest suggestion, not a fabricated segment price.
const PASSENGER_TYPE_MULTIPLIER: Record<string, number> = { adult: 1, child: 0.75, infant_seat: 0.5 }
interface PaidPassenger { full_name: string; gender: string; type: string }
interface FreeChild { full_name: string; age: string }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function today() { return new Date().toISOString().slice(0, 10) }

export default function FleetBookingsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  // 2026-11-17: deep-linked from the Routes page's "Record walk-up" —
  // a fleet vehicle now lands here with its vehicle/route already
  // picked, instead of a thinner duplicate booking sheet.
  const searchParams = useSearchParams()
  const presetVehicleId = searchParams.get('vehicle')
  const presetRouteId = searchParams.get('route')

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [routes, setRoutes] = useState<Route[]>([])
  const [routeId, setRouteId] = useState('')
  const [pendingRouteId, setPendingRouteId] = useState<string | null>(null)
  const [allRoutes, setAllRoutes] = useState<SearchableRoute[]>([])
  const [routeSearchQuery, setRouteSearchQuery] = useState('')
  const [seatsAvailByRoute, setSeatsAvailByRoute] = useState<Record<string, number>>({})
  const [counters, setCounters] = useState<Counter[]>([])
  const [counterId, setCounterId] = useState('')
  const [myCounter, setMyCounter] = useState<Counter | null>(null)
  const [passengerName, setPassengerName] = useState('')
  const [passengerMobile, setPassengerMobile] = useState('')
  const [seats, setSeats] = useState(1)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [recording, setRecording] = useState(false)
  const [emergencyPhone, setEmergencyPhone] = useState('')
  const [showPassengers, setShowPassengers] = useState(false)
  const [paidPassengers, setPaidPassengers] = useState<PaidPassenger[]>([{ full_name: '', gender: '', type: 'adult' }])
  const [freeChildren, setFreeChildren] = useState<FreeChild[]>([])
  const [printedTicket, setPrintedTicket] = useState<ManualTicketData | null>(null)
  const ticketRef = useRef<HTMLDivElement>(null)
  const [routeStops, setRouteStops] = useState<PickableStop[]>([])
  const [boardStopId, setBoardStopId] = useState<string | null>(null)
  const [showStopPicker, setShowStopPicker] = useState(false)
  // Real ask: "a currently booking position of any bus which is going
  // to depart after few days" — the whole form used to hardcode today.
  const [bookTravelDate, setBookTravelDate] = useState(today())
  const [seating, setSeating] = useState<VehicleSeating | null>(null)
  const [takenSeats, setTakenSeats] = useState<number[]>([])
  const [selectedSeats, setSelectedSeats] = useState<number[]>([])
  // 2026-11-17: booking wizard rebuild Phase B — map-pickup pin (free
  // GPS point, not just a listed stop) and a Return leg booked in the
  // same flow, linked back to the outbound booking as two real rows.
  const [pickupMode, setPickupMode] = useState<'stop' | 'map'>('stop')
  const [pickupLat, setPickupLat] = useState<number | null>(null)
  const [pickupLng, setPickupLng] = useState<number | null>(null)
  const [pickupPoint, setPickupPoint] = useState('')
  const [showPickupPicker, setShowPickupPicker] = useState(false)
  // 2026-11-19: real bug fix — Return used to search for a second,
  // independent route. Every real route is is_two_way=true with no
  // separate reverse row; the vehicle runs the SAME route_id back.
  // dhab-pari already has a real mechanism for this on the rider-app
  // side (book_standalone_return_seat, 727/877) — record_manual_
  // return_booking (918) mirrors it for a counter sale. The return
  // leg is just: same route, a later/valid date, its own boarding
  // stop and seats — never a route picker.
  const [isReturn, setIsReturn] = useState(false)
  const [returnDate, setReturnDate] = useState('')
  const [returnBoardStopId, setReturnBoardStopId] = useState<string | null>(null)
  const [showReturnStopPicker, setShowReturnStopPicker] = useState(false)
  const [returnAmount, setReturnAmount] = useState('')
  const [returnTakenSeats, setReturnTakenSeats] = useState<number[]>([])
  const [returnSelectedSeats, setReturnSelectedSeats] = useState<number[]>([])

  // "Find a booking" — unified across both sources (855's counter sales
  // + rider self-bookings), defaults to today so it doubles as "all of
  // today's bookings" with zero query typed.
  const [searchDate, setSearchDate] = useState(today())
  const [searchQuery, setSearchQuery] = useState('')
  // 2026-11-18: real gap from the button-by-button audit — the RPC
  // used to hard-filter to confirmed(+announced) bookings only, so a
  // cancelled or pending one could never be found or reviewed here at
  // all. Defaulting the filter to 'all' (917) is the fix; the mockup's
  // own filter options (All/Confirmed/Unconfirmed/Cancelled) map to
  // dhab-pari's real statuses as all/confirmed/pending/cancelled.
  const [statusFilter, setStatusFilter] = useState('all')
  const [found, setFound] = useState<FoundBooking[]>([])
  const [searching, setSearching] = useState(false)
  const [rescheduling, setRescheduling] = useState<FoundBooking | null>(null)
  const [rescheduleDate, setRescheduleDate] = useState('')
  const [rescheduleTakenSeats, setRescheduleTakenSeats] = useState<number[]>([])
  const [rescheduleSeats, setRescheduleSeats] = useState<number[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [luggageDrafts, setLuggageDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      setFleetId(f?.fleet_id ?? null)
      if (f) {
        const [{ data: v }, { data: c }, { data: mc }] = await Promise.all([
          supabase.rpc('my_fleet_vehicles'),
          supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id }),
          supabase.rpc('my_counter'),
        ])
        const loadedVehicles = (v ?? []) as FleetVehicle[]
        setVehicles(loadedVehicles)
        setCounters((c ?? []) as Counter[])
        // 2026-11-17: booking wizard Phase A — "booked at: {my own
        // terminal}" shown automatically, matching the reference's
        // session strip, instead of a counter dropdown defaulting
        // blank. Still overridable via the dropdown below.
        const own = mc as Counter | null
        if (own?.id) { setMyCounter(own); setCounterId(own.id) }
        // 2026-11-17: no more auto-selecting the first vehicle by
        // default — a search box doesn't need a starting value the
        // way the old cascading dropdowns did. Only a real deep-link
        // (from the Routes page's "Record walk-up") pre-selects.
        const presetOk = presetVehicleId && loadedVehicles.some((lv) => lv.id === presetVehicleId)
        if (presetOk) { setPendingRouteId(presetRouteId); setVehicleId(presetVehicleId) }
        // fetch every active route across the whole fleet
        // once, up front — this is what the search box filters client-
        // side, instead of only ever knowing one vehicle's routes at a
        // time. Same two queries loadRoutesFor already used per
        // vehicle, just across all of them in one shot.
        const vehicleIds = loadedVehicles.map((lv) => lv.id)
        if (vehicleIds.length > 0) {
          const [{ data: r }, { data: vDetails }] = await Promise.all([
            supabase.from('vehicle_routes').select('id, vehicle_id, origin, destination, departure_time, fare_per_seat_pkr, service_code, is_two_way').in('vehicle_id', vehicleIds).eq('is_active', true),
            supabase.from('vehicles').select('id, total_seats, is_sleeper, vehicle_categories(vehicle_kind)').in('id', vehicleIds),
          ])
          const seatingById = new Map((vDetails ?? []).map((d: unknown) => {
            const row = d as { id: string; total_seats: number; is_sleeper: boolean; vehicle_categories: { vehicle_kind: string } | null }
            return [row.id, { total_seats: row.total_seats, is_sleeper: row.is_sleeper, is_van_kind: row.vehicle_categories?.vehicle_kind === 'van' }]
          }))
          const vehicleById = new Map(loadedVehicles.map((lv) => [lv.id, lv]))
          const merged = ((r ?? []) as (Route & { vehicle_id: string; service_code: string | null })[]).map((route): SearchableRoute | null => {
            const vh = vehicleById.get(route.vehicle_id); const seating2 = seatingById.get(route.vehicle_id)
            if (!vh || !seating2) return null
            return { ...route, owner_name: vh.owner_name, vehicle_type: vh.vehicle_type, vehicle_number: vh.vehicle_number, ...seating2 }
          }).filter((x): x is SearchableRoute => x !== null)
          setAllRoutes(merged)
        }
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const loadRoutesFor = async (vid: string) => {
    setSeating(null)
    if (!vid) { setRoutes([]); setRouteId(''); return }
    const [{ data: r }, { data: v }] = await Promise.all([
      supabase.from('vehicle_routes').select('id, origin, destination, departure_time, fare_per_seat_pkr, is_two_way').eq('vehicle_id', vid).eq('is_active', true),
      supabase.from('vehicles').select('total_seats, is_sleeper, category_id, vehicle_categories(vehicle_kind)').eq('id', vid).single(),
    ])
    const loadedRoutes = (r ?? []) as Route[]
    setRoutes(loadedRoutes)
    const wanted = pendingRouteId || presetRouteId
    setRouteId(wanted && loadedRoutes.some((lr) => lr.id === wanted) ? wanted : '')
    setPendingRouteId(null)
    const vv = v as { total_seats: number; is_sleeper: boolean; vehicle_categories: { vehicle_kind: string } | null } | null
    setSeating(vv ? { totalSeats: vv.total_seats, isVanKind: vv.vehicle_categories?.vehicle_kind === 'van', isSleeper: vv.is_sleeper } : null)
  }

  useEffect(() => { if (vehicleId) loadRoutesFor(vehicleId) }, [vehicleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectSearchResult = (r: SearchableRoute) => { setPendingRouteId(r.id); setVehicleId(r.vehicle_id) }
  const changeRoute = () => { setVehicleId(''); setRouteId(''); setRoutes([]) }

  const filteredRoutes = routeSearchQuery.trim()
    ? allRoutes.filter((r) => `${r.origin} ${r.destination}`.toLowerCase().includes(routeSearchQuery.trim().toLowerCase()))
    : allRoutes

  // 2026-11-17: only ever computed for whatever's currently filtered
  // (typically a handful of matches, never the whole fleet) — reuses
  // route_departure_chalan exactly like the dashboard's Vehicles
  // Requiring Attention panel does for the same reason.
  useEffect(() => {
    if (!routeId && filteredRoutes.length > 0) {
      Promise.all(filteredRoutes.map((r) =>
        supabase.rpc('route_departure_chalan', { p_route_id: r.id, p_travel_date: bookTravelDate })
          .then(({ data }) => [r.id, r.total_seats - ((data as { total_confirmed_count?: number } | null)?.total_confirmed_count ?? 0)] as const)
      )).then((pairs) => setSeatsAvailByRoute(Object.fromEntries(pairs)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSearchQuery, bookTravelDate, allRoutes, routeId])

  const loadTakenSeats = async () => {
    if (!routeId || !seating?.isVanKind) { setTakenSeats([]); return }
    const { data } = await supabase.rpc('route_seat_status', { p_route_id: routeId, p_travel_date: bookTravelDate, p_direction: 'outbound' })
    setTakenSeats((data as number[]) ?? [])
  }

  useEffect(() => {
    setSelectedSeats([])
    if (routeId) loadTakenSeats()
  }, [routeId, bookTravelDate, seating?.isVanKind]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadReturnTakenSeats = async () => {
    if (!routeId || !returnDate || !seating?.isVanKind) { setReturnTakenSeats([]); return }
    const { data } = await supabase.rpc('route_seat_status', { p_route_id: routeId, p_travel_date: returnDate, p_direction: 'return' })
    setReturnTakenSeats((data as number[]) ?? [])
  }
  useEffect(() => {
    setReturnSelectedSeats([])
    if (routeId && returnDate) loadReturnTakenSeats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, returnDate, seating?.isVanKind])

  useEffect(() => {
    setBoardStopId(null); setReturnBoardStopId(null)
    if (!routeId) { setRouteStops([]); return }
    // 2026-11-19: real terminal model (918) — a stop can be linked to
    // a real fleet_counters row (city + optional name), with its own
    // scheduled arrival/departure. Joined directly via PostgREST's
    // nested select since counter_id is a plain FK; no RPC needed.
    supabase.from('route_stops').select('id, label, label_ur, lat, lng, stop_order, counter_id, arrival_time, departure_time, fleet_counters(city,name)').eq('route_id', routeId).order('stop_order')
      .then(({ data }) => setRouteStops(((data ?? []) as unknown as Array<PickableStop & { fleet_counters: { city: string; name: string | null } | null }>).map((s) => ({
        ...s, terminal_city: s.fleet_counters?.city ?? null, terminal_name: s.fleet_counters?.name ?? null,
      }))))
  }, [routeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the paid-passenger name rows in step with the seat count; a single
  // paid seat can only carry a free INFANT (age <= 2, enforced server-side
  // too), 2+ paid seats can carry any under-10 child free.
  useEffect(() => {
    setPaidPassengers((prev) => {
      const next = [...prev]
      while (next.length < seats) next.push({ full_name: '', gender: '', type: 'adult' })
      return next.slice(0, seats)
    })
    if (seats === 1) setFreeChildren((prev) => prev.slice(0, 1))
  }, [seats])

  const runSearch = async () => {
    if (!fleetId) return
    setSearching(true)
    const { data, error } = await supabase.rpc('fleet_search_bookings', { p_fleet_id: fleetId, p_query: searchQuery || null, p_travel_date: searchDate || null, p_status: statusFilter })
    setSearching(false)
    if (error) { toast.error(friendlyError(error)); return }
    setFound((data ?? []) as FoundBooking[])
  }

  useEffect(() => { if (fleetId) runSearch() }, [fleetId, searchDate, statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // Real bug fixed, 2026-11-12: rescheduling used to carry the booking's
  // old seat numbers straight onto the new date with no visibility into
  // which seats are actually free that day and no way to pick different
  // ones — a clash just threw a flat error. Now loads real vacancy for
  // the chosen date and lets the seat picker drive the choice.
  useEffect(() => {
    if (!rescheduling || !rescheduling.is_van_kind || !rescheduleDate) { setRescheduleTakenSeats([]); return }
    supabase.rpc('route_seat_status', { p_route_id: rescheduling.route_id, p_travel_date: rescheduleDate, p_direction: 'outbound' }).then(({ data }) => {
      const taken = (data as number[]) ?? []
      const ownCurrentSeats = rescheduleDate === rescheduling.travel_date ? (rescheduling.seat_numbers ?? []) : []
      setRescheduleTakenSeats(taken.filter((n) => !ownCurrentSeats.includes(n)))
    })
  }, [rescheduling, rescheduleDate]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRoute = routes.find((r) => r.id === routeId)
  const suggestedFare = selectedRoute
    ? Math.round(paidPassengers.reduce((sum, p) => sum + selectedRoute.fare_per_seat_pkr * (PASSENGER_TYPE_MULTIPLIER[p.type] ?? 1), 0))
    : 0

  const recordBooking = async () => {
    if (!routeId || !passengerName.trim() || !amount) { toast.error(t('mv.fillManualBookingError')); return }
    if (seating?.isVanKind && selectedSeats.length !== seats) { toast.error(t('mv.pickASeatError')); return }
    if (pickupMode === 'map' && (pickupLat == null || pickupLng == null)) { toast.error(t('mv.pickPickupPinError')); return }
    if (isReturn) {
      if (!returnDate) { toast.error(t('mv.fillReturnJourneyError')); return }
      if (seating?.isVanKind && returnSelectedSeats.length !== seats) { toast.error(t('mv.pickReturnSeatError')); return }
    }
    setRecording(true)
    const passengers = showPassengers
      ? [
          ...paidPassengers.filter((p) => p.full_name.trim()).map((p) => ({ full_name: p.full_name.trim(), gender: p.gender || null, is_free_child: false })),
          ...freeChildren.filter((c) => c.full_name.trim()).map((c) => ({ full_name: c.full_name.trim(), age: c.age ? Number(c.age) : null, is_free_child: true })),
        ]
      : null
    const { data, error } = await supabase.rpc('record_manual_booking', {
      p_route_id: routeId, p_travel_date: bookTravelDate, p_seats: seats,
      p_passenger_name: passengerName, p_total_amount_pkr: Number(amount),
      p_counter_id: counterId || null, p_passenger_mobile: passengerMobile || null, p_payment_method: method,
      p_seat_numbers: seating?.isVanKind ? selectedSeats : null,
      p_emergency_contact_phone: emergencyPhone || null, p_passengers: passengers,
      p_board_stop_id: pickupMode === 'stop' ? boardStopId : null,
      p_pickup_lat: pickupMode === 'map' ? pickupLat : null, p_pickup_lng: pickupMode === 'map' ? pickupLng : null,
      p_pickup_point: pickupMode === 'map' ? (pickupPoint || null) : null,
    })
    if (error) { setRecording(false); toast.error(friendlyError(error)); return }
    const outboundId = (data as { id?: string } | null)?.id
    const pendingApproval = (data as { pickup_approval_status?: string } | null)?.pickup_approval_status === 'pending'

    // 2026-11-19: real fix — the return leg is the SAME route_id
    // (record_manual_return_booking, 918), not a second independent
    // route search. p_total_amount_pkr is left out when returnAmount
    // is blank so the server computes the real fare from the route's
    // own fraction-remaining math, same as the rider-app's own
    // standalone-return mechanism already does.
    let returnTicketNo: string | undefined
    let returnTotal: number | undefined
    if (isReturn && outboundId) {
      const { data: returnData, error: returnError } = await supabase.rpc('record_manual_return_booking', {
        p_route_id: routeId, p_travel_date: returnDate, p_seats: seats, p_passenger_name: passengerName,
        p_total_amount_pkr: returnAmount ? Number(returnAmount) : null,
        p_counter_id: counterId || null, p_passenger_mobile: passengerMobile || null, p_payment_method: method,
        p_board_stop_id: returnBoardStopId, p_seat_numbers: seating?.isVanKind ? returnSelectedSeats : null,
        p_emergency_contact_phone: emergencyPhone || null, p_passengers: passengers, p_outbound_leg_of: outboundId,
      })
      if (returnError) { setRecording(false); toast.error(friendlyError(returnError)); return }
      returnTicketNo = (returnData as { ticket_no?: string } | null)?.ticket_no
      returnTotal = (returnData as { total_amount_pkr?: number } | null)?.total_amount_pkr
    }
    setRecording(false)
    toast.success(pendingApproval ? t('mv.manualBookingPendingApprovalToast') : t('mv.manualBookingRecordedToast'))
    const ticketNo = (data as { ticket_no?: string } | null)?.ticket_no
    const vehicle = vehicles.find((v) => v.id === vehicleId)
    const boardStop = boardStopId ? routeStops.find((s) => s.id === boardStopId) : null
    if (ticketNo && selectedRoute && vehicle) {
      setPrintedTicket({
        ticketNo, passengerName, passengerMobile: passengerMobile || null, emergencyContactPhone: emergencyPhone || null,
        origin: selectedRoute.origin, destination: selectedRoute.destination, travelDate: bookTravelDate,
        departureTime: selectedRoute.departure_time, seats, seatNumbers: seating?.isVanKind ? selectedSeats : null,
        amountPkr: Number(amount), ownerName: vehicle.owner_name, vehicleNumber: vehicle.vehicle_number, serviceCode: null,
        boardStopLabel: pickupMode === 'map' ? (pickupPoint || t('mv.pickupPinLabel')) : (boardStop?.label ?? null), paymentMethod: method,
        bookedAtTerminal: myCounter ? `${myCounter.city}${myCounter.name ? ` · ${myCounter.name}` : ''}` : (counterId ? counters.find((c) => c.id === counterId)?.city ?? null : null),
        pickupApprovalPending: pendingApproval,
        pickupLat: pickupMode === 'map' ? pickupLat : null, pickupLng: pickupMode === 'map' ? pickupLng : null,
        returnLeg: returnTicketNo && selectedRoute ? {
          // Real two-way model: the return leg is the SAME route,
          // travelled in reverse — origin/destination swap for display.
          ticketNo: returnTicketNo, origin: selectedRoute.destination, destination: selectedRoute.origin, travelDate: returnDate,
          departureTime: null, seats, seatNumbers: seating?.isVanKind ? returnSelectedSeats : null, amountPkr: returnTotal,
        } : null,
      })
    }
    setPassengerName(''); setPassengerMobile(''); setSeats(1); setAmount(''); setSelectedSeats([])
    setEmergencyPhone(''); setPaidPassengers([{ full_name: '', gender: '', type: 'adult' }]); setFreeChildren([]); setShowPassengers(false)
    setBoardStopId(null); setPickupMode('stop'); setPickupLat(null); setPickupLng(null); setPickupPoint('')
    setIsReturn(false); setReturnDate(''); setReturnBoardStopId(null); setReturnAmount(''); setReturnSelectedSeats([])
    loadTakenSeats()
    if (bookTravelDate === searchDate) runSearch()
  }

  const printTicket = () => {
    if (ticketRef.current) printNodeInPopup(ticketRef.current, 'Ticket')
  }

  const boardFound = async (b: FoundBooking) => {
    setBusyId(b.id)
    const note = luggageDrafts[b.id] || null
    const { error } = b.source === 'manual'
      ? await supabase.rpc('board_manual_ticket', { p_id: b.id, p_luggage_note: note })
      : await supabase.rpc('board_ride_bookings', { p_booking_ids: [b.id], p_luggage_note: note })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.boardedToast'))
    runSearch()
  }

  // 2026-11-17: booking wizard Phase A — the reference's ticket has
  // Print + Email + WhatsApp as three real actions; Print and
  // WhatsApp already existed here, Email was the one genuinely
  // missing. Shared text builder so all three stay in sync.
  // 2026-11-17: booking wizard Phase B — wired the pickup GPS/map
  // link, pending-approval note, and Return leg into the shared
  // ticket text too, matching the SAFAR reference's ticketText(): a
  // map-pickup or Return booking should carry that onto the Email/
  // WhatsApp message, not just the on-screen/printed ticket.
  const ticketText = (data: ManualTicketData) => {
    const lines = [
      `Ticket #${data.ticketNo}${data.pickupApprovalPending ? ' (PENDING APPROVAL)' : ''}`,
      `${data.passengerName}`,
      `${data.origin} → ${data.destination}`,
      `${data.travelDate}${data.departureTime ? ` · ${data.departureTime}` : ''}`,
      `${data.seats} seat(s)${data.seatNumbers?.length ? ` (#${data.seatNumbers.join(', ')})` : ''}`,
      `${data.ownerName}${data.vehicleNumber ? ` · ${data.vehicleNumber}` : ''}`,
      ...(data.bookedAtTerminal ? [`Booked at: ${data.bookedAtTerminal}`] : []),
      ...(data.pickupLat != null && data.pickupLng != null
        ? [`Pickup GPS: ${data.pickupLat.toFixed(5)}, ${data.pickupLng.toFixed(5)}`, `Pickup map: https://www.google.com/maps?q=${data.pickupLat},${data.pickupLng}`]
        : []),
      ...(data.pickupApprovalPending ? [`This pickup pin is awaiting route / dispatcher approval.`] : []),
      `Payment: ${data.paymentMethod}`,
      `Fare: ₨${fmt(data.amountPkr)}`,
    ]
    if (data.returnLeg) {
      lines.push(
        '',
        `Return journey · Ticket #${data.returnLeg.ticketNo}`,
        `${data.returnLeg.origin} → ${data.returnLeg.destination}`,
        `${data.returnLeg.travelDate}${data.returnLeg.departureTime ? ` · ${data.returnLeg.departureTime}` : ''}`,
        `${data.returnLeg.seats} seat(s)${data.returnLeg.seatNumbers?.length ? ` (#${data.returnLeg.seatNumbers.join(', ')})` : ''}`,
        ...(data.returnLeg.amountPkr != null ? [`Fare: ₨${fmt(data.returnLeg.amountPkr)}`] : []),
      )
    }
    lines.push('', `Present this ticket number at boarding.`)
    return lines.join('\n')
  }

  const sendTicketWhatsapp = (data: ManualTicketData) => {
    if (!data.passengerMobile) return
    const url = `https://wa.me/${normalizePakPhone(data.passengerMobile)}?text=${encodeURIComponent(ticketText(data))}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const emailTicket = (data: ManualTicketData) => {
    const to = window.prompt(t('mv.enterEmailPrompt'), '')
    if (!to) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast.error(t('mv.invalidEmailError')); return }
    const subject = encodeURIComponent(`Ticket ${data.ticketNo}`)
    const body = encodeURIComponent(ticketText(data))
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`
  }

  const cancelFound = async (b: FoundBooking) => {
    if (!confirm(t('mv.confirmCancelBookingHint'))) return
    setBusyId(b.id)
    const rpc = b.source === 'manual' ? 'cancel_manual_booking' : 'cancel_ride_booking'
    const params = b.source === 'manual' ? { p_id: b.id } : { p_booking_id: b.id, p_reason: t('mv.staffCancelledReason') }
    const { error } = await supabase.rpc(rpc, params)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.bookingCancelledToast'))
    runSearch()
  }

  const confirmReschedule = async () => {
    if (!rescheduling || !rescheduleDate) return
    if (rescheduling.is_van_kind && rescheduleSeats.length !== rescheduling.seats) { toast.error(t('mv.pickASeatError')); return }
    setBusyId(rescheduling.id)
    const seatNumbers = rescheduling.is_van_kind ? rescheduleSeats : null
    const rpc = rescheduling.source === 'manual' ? 'reschedule_manual_booking' : 'reschedule_ride_booking'
    const params = rescheduling.source === 'manual'
      ? { p_id: rescheduling.id, p_new_travel_date: rescheduleDate, p_seat_numbers: seatNumbers }
      : { p_booking_id: rescheduling.id, p_new_travel_date: rescheduleDate, p_seat_numbers: seatNumbers }
    const { error } = await supabase.rpc(rpc, params)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.bookingRescheduledToast'))
    setRescheduling(null); setRescheduleDate(''); setRescheduleSeats([])
    runSearch()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Ticket size={19} /> {t('mv.fleetBookingsHeading')}</h1>
      <p className="font-sans text-[11px] text-[#64748b] -mt-1">{t('mv.panelDesc.bookings')}</p>

      {/* 2026-11-18: kpi-row from the button-by-button audit — the
          mockup's "All/Online/Terminal/Driver on-road" split, computed
          from whatever's currently loaded below (today + current
          filters by default), not a separate fabricated query. Channel
          split uses real data: source='app' is a rider's own booking,
          source='manual' with a counter_id is a real terminal sale,
          source='manual' with none is a counter-less (driver/roadside)
          sale — the only two real channels manual bookings can be. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-white border border-[#e5e2d0] rounded-xl p-2.5">
          <p className="font-sans text-[10px] font-bold text-[#94a3b8] uppercase tracking-[0.04em]">{t('mv.allBookingsTodayLabel')}</p>
          <p className="font-sans text-[17px] font-extrabold text-[#1e293b] ltr-num mt-0.5">{found.length}</p>
        </div>
        <div className="bg-white border border-[#e5e2d0] rounded-xl p-2.5">
          <p className="font-sans text-[10px] font-bold text-[#94a3b8] uppercase tracking-[0.04em]">{t('mv.onlineBookingsLabel')}</p>
          <p className="font-sans text-[17px] font-extrabold text-[#1e293b] ltr-num mt-0.5">{found.filter((b) => b.source === 'app').length}</p>
        </div>
        <div className="bg-white border border-[#e5e2d0] rounded-xl p-2.5">
          <p className="font-sans text-[10px] font-bold text-[#94a3b8] uppercase tracking-[0.04em]">{t('mv.terminalBookingsLabel')}</p>
          <p className="font-sans text-[17px] font-extrabold text-[#1e293b] ltr-num mt-0.5">{found.filter((b) => b.source === 'manual' && b.counter_id).length}</p>
        </div>
        <div className="bg-white border border-[#e5e2d0] rounded-xl p-2.5">
          <p className="font-sans text-[10px] font-bold text-[#94a3b8] uppercase tracking-[0.04em]">{t('mv.driverOnRoadBookingsLabel')}</p>
          <p className="font-sans text-[17px] font-extrabold text-[#1e293b] ltr-num mt-0.5">{found.filter((b) => b.source === 'manual' && !b.counter_id).length}</p>
        </div>
      </div>

      {/* Record a new booking */}
      <FleetPanel>
        <FleetPanelHead icon={<Plus size={14} />} title={t('mv.recordBookingBtn')} description={selectedRoute ? `${selectedRoute.origin} → ${selectedRoute.destination}` : undefined} />
        <FleetPanelBody>
        {/* 2026-11-17: real complaint — "what if there's 100+ buses and
            hundreds of routes, how would we book a manual ride as per
            the demand and search of the rider?" A flat vehicle→route
            dropdown pair doesn't scale. Destination search instead,
            against every active route across the whole fleet
            (allRoutes, fetched once), with real seat availability per
            matching result — not a fabricated number. */}
        {routeId ? (
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 border border-[#166534] bg-[#F0FDF4] rounded-lg mb-2.5">
            <div className="min-w-0">
              <p className="font-sans text-[13px] font-bold text-[#1e293b] truncate">{selectedRoute?.origin} → {selectedRoute?.destination}</p>
              <p className="font-sans text-[11px] text-[#64748b] truncate ltr-num">
                {vehicles.find((v) => v.id === vehicleId)?.vehicle_number || vehicles.find((v) => v.id === vehicleId)?.vehicle_type}
                {selectedRoute?.departure_time ? ` · ${selectedRoute.departure_time}` : ''}
              </p>
            </div>
            <button type="button" onClick={changeRoute} className="shrink-0 font-sans text-[11.5px] font-bold text-[#166534] cursor-pointer">{t('mv.changeRouteLink')}</button>
          </div>
        ) : (
          <>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.travelDateLabel')}</label>
            <input type="date" value={bookTravelDate} min={today()} onChange={(e) => setBookTravelDate(e.target.value)}
              className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2 ltr-num" />
            <div className="relative mb-2">
              <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#94a3b8]" />
              <input value={routeSearchQuery} onChange={(e) => setRouteSearchQuery(e.target.value)} placeholder={t('mv.searchDestinationPlaceholder')}
                className="w-full ps-9 pe-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
            {filteredRoutes.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.noMatchingRoutesHint')}</p>
            ) : (
              <div className="flex flex-col gap-1.5 mb-2.5 max-h-80 overflow-y-auto">
                {filteredRoutes.map((r) => {
                  const avail = seatsAvailByRoute[r.id]
                  return (
                    <button key={r.id} type="button" onClick={() => selectSearchResult(r)}
                      className="flex items-center justify-between gap-2 px-3 py-2 border border-[#e5e2d0] rounded-lg cursor-pointer text-start">
                      <div className="min-w-0">
                        <p className="font-sans text-[12.5px] font-bold text-[#1e293b] truncate">{r.origin} → {r.destination}</p>
                        <p className="font-sans text-[10.5px] text-[#64748b] truncate ltr-num">
                          {r.vehicle_number || r.vehicle_type}{r.departure_time ? ` · ${r.departure_time}` : ''} · ₨{fmt(r.fare_per_seat_pkr)}
                        </p>
                      </div>
                      <span className={`shrink-0 font-sans text-[10.5px] font-bold ltr-num ${avail != null && avail <= 0 ? 'text-[#b91c1c]' : 'text-[#166534]'}`}>
                        {avail != null ? (avail > 0 ? t('mv.seatsAvailLabel').replace('{n}', String(avail)) : t('mp.fullyBookedError')) : ''}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}

        {routeId && (
          <>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.travelDateLabel')}</label>
            <input type="date" value={bookTravelDate} min={today()} onChange={(e) => setBookTravelDate(e.target.value)}
              className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5 ltr-num" />
            {myCounter && (
              <p className="flex items-center gap-1.5 font-sans text-[11px] text-[#64748b] mb-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#166534] shrink-0" />
                {t('mv.bookedAtLabel')}: <span className="font-bold text-[#1e293b]">{myCounter.city}{myCounter.name ? ` · ${myCounter.name}` : ''}</span>
              </p>
            )}
            {counters.length > 0 && (
              <select value={counterId} onChange={(e) => setCounterId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2">
                <option value="">{t('mv.noCounterOption')}</option>
                {counters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
              </select>
            )}
            {routeStops.length > 0 && selectedRoute && (
              <>
                <div className="flex gap-1.5 mb-2">
                  <button type="button" onClick={() => setPickupMode('stop')}
                    className={`flex-1 px-2.5 py-1.5 rounded-lg font-sans text-[11.5px] font-semibold cursor-pointer ${pickupMode === 'stop' ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
                    {t('mv.pickupModeStopOption')}
                  </button>
                  <button type="button" onClick={() => setPickupMode('map')}
                    className={`flex-1 px-2.5 py-1.5 rounded-lg font-sans text-[11.5px] font-semibold cursor-pointer ${pickupMode === 'map' ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
                    {t('mv.pickupModeMapOption')}
                  </button>
                </div>
                {/* 2026-11-19: real fix — "Listed stop" opens a plain
                    list of this route's real terminals/stops now
                    (TerminalStopPicker), never a map. The map stays
                    exactly where the reference puts it: "Map pickup"
                    only. */}
                {pickupMode === 'stop' ? (
                  <button type="button" onClick={() => setShowStopPicker(true)}
                    className="w-full flex items-center justify-between px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2 cursor-pointer">
                    <span className="text-[#64748b]">{t('mv.boardingStopLabel')}</span>
                    <span className="font-semibold text-[#166534]">
                      {(() => {
                        const bs = boardStopId ? routeStops.find((s) => s.id === boardStopId) : null
                        return bs ? (bs.terminal_city ? `${bs.terminal_city}${bs.terminal_name ? ` · ${bs.terminal_name}` : ''}` : bs.label) : selectedRoute.origin
                      })()}
                    </span>
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={() => setShowPickupPicker(true)}
                      className="w-full flex items-center justify-between px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2 cursor-pointer">
                      <span className="text-[#64748b]">{t('mv.choosePickupPinLabel')}</span>
                      <span className="font-semibold text-[#166534] ltr-num">{pickupLat != null ? `${pickupLat.toFixed(4)}, ${pickupLng!.toFixed(4)}` : '—'}</span>
                    </button>
                    {pickupLat != null && (
                      <>
                        <input value={pickupPoint} onChange={(e) => setPickupPoint(e.target.value)} placeholder={t('mv.pickupPointNotePlaceholder')}
                          className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2" />
                        <p className="font-sans text-[10.5px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5 mb-2">{t('mv.pickupApprovalNeededHint')}</p>
                      </>
                    )}
                  </>
                )}
              </>
            )}
            <div className="flex gap-2 mb-2">
              <input value={passengerName} onChange={(e) => setPassengerName(e.target.value)} placeholder={t('mv.passengerNamePlaceholder')}
                className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              <input value={passengerMobile} onChange={(e) => setPassengerMobile(e.target.value)} placeholder={t('mv.passengerMobileOptionalPlaceholder')}
                className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
            <input value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} placeholder={t('mv.emergencyContactPlaceholder')}
              className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2 ltr-num" />

            <button type="button" onClick={() => setShowPassengers((s) => !s)} className="font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer mb-2">
              {showPassengers ? t('mv.hidePassengerDetailsBtn') : t('mv.addPassengerDetailsBtn')}
            </button>
            {showPassengers && (
              <div className="bg-[#f8f6ee] rounded-lg p-2.5 mb-2.5 flex flex-col gap-2">
                <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b]">{t('mv.paidPassengersLabel')}</p>
                {paidPassengers.map((p, i) => (
                  <div key={i} className="flex gap-2">
                    <input value={p.full_name} onChange={(e) => setPaidPassengers((arr) => arr.map((x, j) => j === i ? { ...x, full_name: e.target.value } : x))}
                      placeholder={t('mv.passengerNamePlaceholder')} className="flex-1 px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12.5px]" />
                    <select value={p.gender} onChange={(e) => setPaidPassengers((arr) => arr.map((x, j) => j === i ? { ...x, gender: e.target.value } : x))}
                      className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]">
                      <option value="">{t('mv.genderPlaceholder')}</option>
                      <option value="male">{t('mv.genderMale')}</option>
                      <option value="female">{t('mv.genderFemale')}</option>
                    </select>
                    {/* 2026-11-17: booking wizard Phase A — passenger
                        type drives the fare suggestion below; never
                        sent to record_manual_booking (no column for
                        it), purely a client-side pricing aid. */}
                    <select value={p.type} onChange={(e) => setPaidPassengers((arr) => arr.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}
                      className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]">
                      <option value="adult">{t('mv.passengerTypeAdult')}</option>
                      <option value="child">{t('mv.passengerTypeChild')}</option>
                      <option value="infant_seat">{t('mv.passengerTypeInfantSeat')}</option>
                    </select>
                  </div>
                ))}
                {selectedRoute && (
                  <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-white rounded-lg">
                    <span className="font-sans text-[11px] text-[#64748b]">
                      {t('mv.suggestedFareLabel')}: <span className="font-bold text-[#166534] ltr-num">₨{fmt(suggestedFare)}</span>
                    </span>
                    <button type="button" onClick={() => setAmount(String(suggestedFare))} className="font-sans text-[11px] font-bold text-[#166534] cursor-pointer">{t('mv.useThisFareBtn')}</button>
                  </div>
                )}
                <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mt-1">{t('mv.freeChildrenLabel')}</p>
                <p className="font-sans text-[10.5px] text-[#94a3b8]">{seats >= 2 ? t('mv.freeChildPolicyMulti') : t('mv.freeChildPolicySingle')}</p>
                {freeChildren.map((c, i) => (
                  <div key={i} className="flex gap-2">
                    <input value={c.full_name} onChange={(e) => setFreeChildren((arr) => arr.map((x, j) => j === i ? { ...x, full_name: e.target.value } : x))}
                      placeholder={t('mv.childNamePlaceholder')} className="flex-1 px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12.5px]" />
                    <input type="number" min={0} value={c.age} onChange={(e) => setFreeChildren((arr) => arr.map((x, j) => j === i ? { ...x, age: e.target.value } : x))}
                      placeholder={t('mv.childAgePlaceholder')} className="w-20 px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
                    <button type="button" onClick={() => setFreeChildren((arr) => arr.filter((_, j) => j !== i))} className="p-1.5 text-[#b91c1c] cursor-pointer"><X size={14} /></button>
                  </div>
                ))}
                <button type="button" onClick={() => setFreeChildren((arr) => [...arr, { full_name: '', age: '' }])}
                  className="flex items-center gap-1 font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer">
                  <Baby size={13} /> {t('mv.addFreeChildBtn')}
                </button>
              </div>
            )}
            <div className="flex gap-2 mb-2">
              <input type="number" min={1} max={seating?.totalSeats} value={seats} onChange={(e) => setSeats(Math.max(1, Number(e.target.value)))}
                className="w-20 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder={selectedRoute ? `₨${fmt(selectedRoute.fare_per_seat_pkr * seats)}` : t('mv.expenseAmountPlaceholder')}
                className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              <select value={method} onChange={(e) => setMethod(e.target.value)} className="px-2 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[12.5px]">
                <option value="cash">{t('mv.paymentCash')}</option>
                <option value="jazzcash">JazzCash</option>
              </select>
            </div>
            {seating?.isVanKind && (
              <div className="mb-2.5">
                {isReturn && <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1">{t('mv.outboundSeatsHeading')}</p>}
                <SeatPickerField totalSeats={seating.totalSeats} takenSeatNumbers={takenSeats} seatsNeeded={seats} selected={selectedSeats} onChange={setSelectedSeats} isSleeper={seating.isSleeper} />
              </div>
            )}

            {/* 2026-11-19: real fix — Return only ever makes sense on
                a route the vehicle actually runs back on (is_two_way).
                The outbound leg above is now fully specified (date,
                stop, passenger, seats) before Return is even offered —
                the old layout asked for a return seat before the
                outbound date was chosen, which is what broke it. */}
            {selectedRoute?.is_two_way && (
              <>
                <div className="flex gap-1.5 mb-2">
                  <button type="button" onClick={() => setIsReturn(false)}
                    className={`flex-1 px-2.5 py-1.5 rounded-lg font-sans text-[11.5px] font-semibold cursor-pointer ${!isReturn ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
                    {t('mv.oneWayOption')}
                  </button>
                  <button type="button" onClick={() => { setIsReturn(true); if (!returnDate) setReturnDate(bookTravelDate) }}
                    className={`flex-1 px-2.5 py-1.5 rounded-lg font-sans text-[11.5px] font-semibold cursor-pointer ${isReturn ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
                    {t('mv.returnOption')}
                  </button>
                </div>
                {isReturn && (
                  <div className="bg-[#f8f6ee] rounded-lg p-2.5 mb-2.5 flex flex-col gap-2">
                    <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b]">{t('mv.returnJourneyHeading')}</p>
                    <p className="font-sans text-[11px] font-bold text-[#166534]">{selectedRoute.destination} → {selectedRoute.origin}</p>
                    <label className="block font-sans text-[11px] font-bold text-[#64748b] -mb-1">{t('mv.returnDateLabel')}</label>
                    <input type="date" value={returnDate} min={bookTravelDate} onChange={(e) => setReturnDate(e.target.value)}
                      className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                    <button type="button" onClick={() => setShowReturnStopPicker(true)}
                      className="w-full flex items-center justify-between px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] cursor-pointer bg-white">
                      <span className="text-[#64748b]">{t('mv.returnBoardingStopLabel')}</span>
                      <span className="font-semibold text-[#166534]">
                        {(() => {
                          const bs = returnBoardStopId ? routeStops.find((s) => s.id === returnBoardStopId) : null
                          return bs ? (bs.terminal_city ? `${bs.terminal_city}${bs.terminal_name ? ` · ${bs.terminal_name}` : ''}` : bs.label) : selectedRoute.destination
                        })()}
                      </span>
                    </button>
                    <input type="number" value={returnAmount} onChange={(e) => setReturnAmount(e.target.value)} placeholder={t('mv.returnFareAutoPlaceholder')}
                      className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                    {seating?.isVanKind && (
                      <>
                        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b]">{t('mv.returnSeatsHeading')}</p>
                        <SeatPickerField totalSeats={seating.totalSeats} takenSeatNumbers={returnTakenSeats} seatsNeeded={seats} selected={returnSelectedSeats} onChange={setReturnSelectedSeats} isSleeper={seating.isSleeper} />
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            <button onClick={recordBooking} disabled={recording} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {recording ? t('action.loading') : t('mv.recordBookingBtn')}
            </button>
          </>
        )}
        </FleetPanelBody>
      </FleetPanel>

      {/* Find a booking — defaults to today (= "today's bookings"),
          change the date to check a future run's position, type a
          name/mobile to find one specific booking either source. */}
      <FleetPanel>
        <FleetPanelHead icon={<Search size={14} />} title={t('mv.findBookingHeading')} description={t('mv.panelDesc.findBooking')}
          action={found.length > 0 ? <span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{found.length}</span> : undefined} />
        <div className="flex flex-wrap gap-2 px-3.5 py-2.5 border-b border-[#f1f5f9] bg-[#F9F9F6]">
          <input type="date" value={searchDate} onChange={(e) => setSearchDate(e.target.value)}
            className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[12.5px]">
            <option value="all">{t('mv.statusFilterAllOption')}</option>
            <option value="confirmed">{t('mv.statusFilterConfirmedOption')}</option>
            <option value="pending">{t('mv.statusFilterPendingOption')}</option>
            <option value="cancelled">{t('mv.statusFilterCancelledOption')}</option>
          </select>
          <div className="relative flex-1 min-w-[140px]">
            <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder={t('mv.searchByNameMobilePlaceholder')} className="w-full ps-9 pe-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          <button onClick={runSearch} disabled={searching} className="px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
            {searching ? t('action.loading') : t('mv.searchBtn')}
          </button>
        </div>

        {found.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noBookingsFoundHint')}</p>
        ) : (
          <>
          <FleetColumnLabels labels={[t('mv.passengerNamePlaceholder'), t('w.amount')]} />
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {found.map((b) => {
              // 2026-11-18: real bug the audit's status-filter fix would
              // otherwise have exposed — cancelled/rejected bookings
              // were never visible here before, so nothing gated the
              // Board/Reschedule/Cancel actions against them; both
              // checked only boarded_at. Now that status.filter='all'
              // can surface a cancelled row, it must render as inert.
              const isCancelled = b.status === 'cancelled' || b.status === 'rejected'
              const isPending = b.status === 'announced'
              return (
              <div key={`${b.source}-${b.id}`} className="px-3.5 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{b.passenger_name}{b.passenger_mobile ? ` · ${b.passenger_mobile}` : ''}</p>
                    <p className="font-sans text-[10.5px] text-[#94a3b8]">{b.origin} → {b.destination} · {b.owner_name} · {b.seats} {t('mv.seatsSuffix')} · <span className="ltr-num">{b.travel_date}</span></p>
                    <p className="font-sans text-[10.5px] text-[#94a3b8] ltr-num flex items-center gap-1.5 flex-wrap">
                      {b.ticket_no ? `#${b.ticket_no}` : ''}
                      {b.boarded_at && <FleetStatusPill tone="green">{t('mv.boardedLabel')}</FleetStatusPill>}
                      {isCancelled && <FleetStatusPill tone="red">{t('mv.statusFilterCancelledOption')}</FleetStatusPill>}
                      {isPending && <FleetStatusPill tone="amber">{t('mv.statusFilterPendingOption')}</FleetStatusPill>}
                    </p>
                    {b.luggage_note && <p className="font-sans text-[10.5px] text-[#94a3b8]">🧳 {b.luggage_note}</p>}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    {b.passenger_mobile && (
                      <>
                        <a href={`tel:${b.passenger_mobile}`} className="p-1 text-[#64748b]"><Phone size={13} /></a>
                        <a href={`https://wa.me/${normalizePakPhone(b.passenger_mobile)}`} target="_blank" rel="noopener noreferrer" className="p-1 text-[#166534]"><MessageCircle size={13} /></a>
                      </>
                    )}
                    <span className="font-sans text-[13px] font-bold text-[#166534] ltr-num">₨{fmt(b.amount_pkr)}</span>
                  </div>
                </div>
                {isCancelled ? null : rescheduling?.id === b.id ? (
                  <div className="flex flex-col gap-2 mt-2">
                    <div className="flex gap-2">
                      <input type="date" value={rescheduleDate} min={today()} onChange={(e) => { setRescheduleDate(e.target.value); setRescheduleSeats([]) }}
                        className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
                      <button onClick={confirmReschedule} disabled={busyId === b.id} className="px-3 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">{t('action.save')}</button>
                      <button onClick={() => setRescheduling(null)} className="p-1.5 text-[#64748b] cursor-pointer"><X size={15} /></button>
                    </div>
                    {b.is_van_kind && (
                      <SeatPickerField totalSeats={b.total_seats} takenSeatNumbers={rescheduleTakenSeats} seatsNeeded={b.seats} selected={rescheduleSeats} onChange={setRescheduleSeats} isSleeper={b.is_sleeper} />
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5 mt-2">
                    {!b.boarded_at && (
                      <input value={luggageDrafts[b.id] ?? ''} onChange={(e) => setLuggageDrafts((d) => ({ ...d, [b.id]: e.target.value }))}
                        placeholder={t('mv.luggageNotePlaceholder')} className="w-full px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
                    )}
                    <div className="flex gap-2">
                      {!b.boarded_at && (
                        <button onClick={() => boardFound(b)} disabled={busyId === b.id} className="flex items-center justify-center gap-1 flex-1 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                          <UserCheck size={13} /> {t('mv.boardBtn')}
                        </button>
                      )}
                      <button onClick={() => { setRescheduling(b); setRescheduleDate(b.travel_date); setRescheduleSeats(b.seat_numbers ?? []) }} className="flex-1 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer">{t('mv.rescheduleBtn')}</button>
                      <button onClick={() => cancelFound(b)} disabled={busyId === b.id} className="flex-1 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50">{t('action.cancel')}</button>
                    </div>
                  </div>
                )}
              </div>
              )
            })}
          </div>
          </>
        )}
      </FleetPanel>

      {showStopPicker && selectedRoute && (
        <TerminalStopPicker stops={routeStops} value={boardStopId} onChange={setBoardStopId} originLabel={selectedRoute.origin} onClose={() => setShowStopPicker(false)} />
      )}

      {showReturnStopPicker && selectedRoute && (
        <TerminalStopPicker stops={routeStops} value={returnBoardStopId} onChange={setReturnBoardStopId} originLabel={selectedRoute.destination} onClose={() => setShowReturnStopPicker(false)} />
      )}

      {showPickupPicker && (
        <PickupPinMapPicker stops={routeStops} lat={pickupLat} lng={pickupLng} onChange={(la, ln) => { setPickupLat(la); setPickupLng(ln) }} onClose={() => setShowPickupPicker(false)} />
      )}

      {printedTicket && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setPrintedTicket(null)}>
          <div className="bg-white rounded-2xl max-w-[460px] w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div ref={ticketRef}><ManualTicketDocument data={printedTicket} /></div>
            <div className="flex flex-col gap-2 p-4 pt-0">
              <div className="flex gap-2">
                <button onClick={printTicket} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer">
                  <Printer size={14} /> {t('mv.printTicketBtn')}
                </button>
                {printedTicket.passengerMobile && (
                  <button onClick={() => sendTicketWhatsapp(printedTicket)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#166534] text-[#166534] font-sans text-[12.5px] font-bold cursor-pointer">
                    <MessageCircle size={14} /> {t('mv.sendWhatsappBtn')}
                  </button>
                )}
                <button onClick={() => emailTicket(printedTicket)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#e5e2d0] text-[#334155] font-sans text-[12.5px] font-bold cursor-pointer">
                  <Mail size={14} /> {t('mv.emailTicketBtn')}
                </button>
              </div>
              <button onClick={() => setPrintedTicket(null)} className="w-full px-4 py-2.5 rounded-xl border border-[#e5e2d0] font-sans text-[13px] font-semibold text-[#64748b] cursor-pointer">{t('action.close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
