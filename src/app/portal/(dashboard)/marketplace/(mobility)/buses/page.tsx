'use client'

// Real ask, 2026-10-30: "for the sharing ride I want a tab for the
// riders who can browse these saved sharing routes — like a complete bus
// booking system, where the driver can chat with the bookers and confirm
// when and where the vehicle will leave... with beautiful cards for each
// city's vehicles." Every piece already existed but was scattered: the
// drivers' saved weekly routes (vehicle_routes), one-off shared trips
// (vehicle_trip_offers), seat booking + the route's own group chat and
// live departure status (route/[routeId], RouteGroupPanel), the rider's
// own seats (ride_bookings). This is the one place to browse them all,
// grouped by destination city, as bus-ticket style cards — booking and
// the group chat stay on the route's own page, one tap away.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Search, Clock, Users, ArrowRight, CalendarDays, Repeat, MapPinned, MapPin, ArrowRightLeft, X, Minus, Plus, Check, Pencil, Lock, Filter as FilterIcon, ChevronRight, Calendar as CalendarIcon, Users2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { FarePolicyCard } from '@/components/mobility/FarePolicyCard'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { RouteBookingSheet } from '@/components/mobility/RouteBookingSheet'
import { OwnReturnLegSheet } from '@/components/mobility/OwnReturnLegSheet'
import { friendlyError } from '@/lib/errors'

interface VehicleLite { owner_name: string; vehicle_type: string; model: string | null; color: string | null; total_seats: number | null; has_ac: boolean | null; vehicle_number: string | null }
interface RouteRow {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_per_seat_pkr: number | null; departure_time: string | null; return_departure_time: string | null; days_of_week: number[] | null
  return_days_of_week: number[] | null
  is_two_way: boolean | null; is_monthly_fixed: boolean | null; monthly_reference_fee_pkr: number | null; distance_km: number | null; route_duration_min: number | null
  service_class: string | null
  vehicles: VehicleLite | null
  source_tenant_name?: string | null
}
interface TripRow {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  travel_date: string; departure_time_estimate: string | null; seats_available: number; listed_fare_per_seat_pkr: number; trip_type: string | null
  vehicles: VehicleLite | null
  source_tenant_name?: string | null
}
interface NearbyTehsilRow {
  kind: 'route' | 'trip'; id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_per_seat_pkr?: number | null; departure_time?: string | null; return_departure_time?: string | null
  days_of_week?: number[] | null; is_two_way?: boolean | null; distance_km?: number | null; route_duration_min?: number | null
  travel_date?: string | null; departure_time_estimate?: string | null; seats_available?: number | null
  owner_name: string; vehicle_type: string; model: string | null; color: string | null; total_seats: number | null; has_ac: boolean | null; vehicle_number: string | null
  source_tenant_id: string; source_tenant_name: string
}
const SERVICE_CLASSES = ['economy', 'business', 'executive', 'sleeper', 'luxury'] as const

const PALETTE = [
  ['#065f46', '#10b981'], ['#1e3a8a', '#3b82f6'], ['#7c2d12', '#f97316'], ['#581c87', '#a855f7'], ['#0f766e', '#2dd4bf'], ['#9d174d', '#ec4899'],
]
function hashIdx(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % PALETTE.length }
type VehicleGroup = 'shared' | 'auto' | 'bike' | 'car'
function vehicleGroupFor(type: string | undefined): VehicleGroup {
  const t = (type ?? '').toLowerCase()
  if (/coaster|bus|hiace|van|wagon|bolan|carry/.test(t)) return 'shared'
  if (/rickshaw|qingqi|loader/.test(t)) return 'auto'
  if (/bike|motor/.test(t)) return 'bike'
  return 'car'
}
function emojiFor(type: string | undefined) {
  const g = vehicleGroupFor(type)
  if (g === 'shared') return '🚐'
  if (g === 'auto') return '🛺'
  if (g === 'bike') return '🏍️'
  return '🚗'
}
function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function BusesPage() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const router = useRouter()
  const [crossTenantTarget, setCrossTenantTarget] = useState<{ kind: 'route'; row: RouteRow } | { kind: 'trip'; row: TripRow } | null>(null)
  const [openRouteId, setOpenRouteId] = useState<string | null>(null)
  const [bookSeats, setBookSeats] = useState(1)
  const [bookDate, setBookDate] = useState('')
  const [booking, setBooking] = useState(false)
  const [routes, setRoutes] = useState<RouteRow[]>([])
  const [trips, setTrips] = useState<TripRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [city, setCity] = useState<string | null>(null)
  const [vehicleGroup, setVehicleGroup] = useState<VehicleGroup | null>(null)
  const [view, setView] = useState<'perRide' | 'monthly'>('perRide')
  // 2026-11-22: real ask — "dozens of bus services running from one
  // same city to same destination city... rider can search the buses
  // routes of all services and then filter out the cheapest fare one
  // too." The existing destination-grouped browse below stays exactly
  // as-is for "I don't know where I'm going yet" browsing — this is a
  // real From→To search layered on top of it, matching every operator
  // (same-tenant and cross-tenant alike, already pulled into `routes`/
  // `trips`) for that exact pair, sorted cheapest-first by default.
  //
  // 2026-11-22, same day — real spec from the user, a full step-based
  // search: From/To → one-way or round trip → departure (and return)
  // date → seat count → Search, then departure/return as two separate
  // tabs, each with its own editable date to shop that leg, a service-
  // class filter (economy/business/executive/sleeper/luxury — the
  // existing vehicle_routes.service_class column, already set per
  // route via set_route_service_class and already shown as a badge on
  // RouteDetailPanel), picking a bus from either tab opens the exact
  // same existing RouteBookingSheet (stops/seats/submit unchanged) —
  // this page only adds the search/tabs/filter wrapper around it.
  const [fromCity, setFromCity] = useState('')
  const [toCity, setToCity] = useState('')
  const [sortBy, setSortBy] = useState<'price' | 'time'>('price')
  const [tripType, setTripType] = useState<'oneway' | 'roundtrip'>('oneway')
  const [departDate, setDepartDate] = useState('')
  const [returnDate, setReturnDate] = useState('')
  const [seatsWanted, setSeatsWanted] = useState(1)
  const [serviceClassFilter, setServiceClassFilter] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [activeTab, setActiveTab] = useState<'departure' | 'return'>('departure')
  const [departureBooked, setDepartureBooked] = useState(false)
  const [returnBooked, setReturnBooked] = useState(false)
  const [bookingLegTab, setBookingLegTab] = useState<'departure' | 'return' | null>(null)
  const [ownReturnLegRouteId, setOwnReturnLegRouteId] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    const today = new Date().toISOString().slice(0, 10)
    const veh = 'vehicles(owner_name, vehicle_type, model, color, total_seats, has_ac, vehicle_number)'
    Promise.all([
      supabase.from('vehicle_routes').select(`id, origin, origin_ur, destination, destination_ur, fare_per_seat_pkr, departure_time, return_departure_time, days_of_week, return_days_of_week, is_two_way, is_monthly_fixed, monthly_reference_fee_pkr, distance_km, route_duration_min, service_class, ${veh}`).eq('is_active', true).order('departure_time'),
      supabase.from('vehicle_trip_offers').select(`id, origin, origin_ur, destination, destination_ur, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, trip_type, ${veh}`).eq('status', 'open').gte('travel_date', today).order('travel_date'),
      supabase.rpc('nearby_tehsil_rides'),
    ]).then(([r, o, nearby]) => {
      const ownRoutes = (r.data ?? []) as unknown as RouteRow[]
      const ownTrips = (o.data ?? []) as unknown as TripRow[]
      const nearbyRows = ((nearby.data ?? []) as NearbyTehsilRow[])
      const nearbyRoutes: RouteRow[] = nearbyRows.filter((n) => n.kind === 'route').map((n) => ({
        id: n.id, origin: n.origin, origin_ur: n.origin_ur, destination: n.destination, destination_ur: n.destination_ur,
        fare_per_seat_pkr: n.fare_per_seat_pkr ?? null, departure_time: n.departure_time ?? null, return_departure_time: n.return_departure_time ?? null,
        days_of_week: n.days_of_week ?? null, return_days_of_week: null, is_two_way: n.is_two_way ?? null, is_monthly_fixed: false, monthly_reference_fee_pkr: null,
        distance_km: n.distance_km ?? null, route_duration_min: n.route_duration_min ?? null, service_class: null,
        vehicles: { owner_name: n.owner_name, vehicle_type: n.vehicle_type, model: n.model, color: n.color, total_seats: n.total_seats, has_ac: n.has_ac, vehicle_number: n.vehicle_number },
        source_tenant_name: n.source_tenant_name,
      }))
      const nearbyTrips: TripRow[] = nearbyRows.filter((n) => n.kind === 'trip').map((n) => ({
        id: n.id, origin: n.origin, origin_ur: n.origin_ur, destination: n.destination, destination_ur: n.destination_ur,
        travel_date: n.travel_date ?? '', departure_time_estimate: n.departure_time_estimate ?? null, seats_available: n.seats_available ?? 0,
        listed_fare_per_seat_pkr: n.fare_per_seat_pkr ?? 0, trip_type: null,
        vehicles: { owner_name: n.owner_name, vehicle_type: n.vehicle_type, model: n.model, color: n.color, total_seats: n.total_seats, has_ac: n.has_ac, vehicle_number: n.vehicle_number },
        source_tenant_name: n.source_tenant_name,
      }))
      setRoutes([...ownRoutes, ...nearbyRoutes])
      setTrips([...ownTrips, ...nearbyTrips])
      setLoading(false)
    })
  }, [user])

  // Real bug found live, 2026-11-25: departureBooked/returnBooked are
  // plain in-memory flags, only ever flipped true right after a booking
  // succeeds in THIS page session — so the return tab's "book your
  // departure first" lock re-locks the instant the page reloads (the
  // tab gets backgrounded and discarded, the rider closes the app and
  // comes back later, anything), even though their departure seat is
  // already real and paid for. Self-heals here by checking for a real,
  // active booking matching each leg whenever the search itself changes,
  // same city-matching rule computeLegResults already uses — this never
  // overrides the immediate post-booking flip (handleLegBooked), it only
  // ever flips false -> true to catch up with reality.
  useEffect(() => {
    if (!user || !searched || !fromCity || !toCity || !departDate) return
    const supabase = createClient()
    const sameCity = (a: string, key: string) => a.trim().toLowerCase() === key
    const dates = tripType === 'roundtrip' && returnDate ? [departDate, returnDate] : [departDate]
    supabase.from('ride_bookings')
      .select('travel_date, direction, vehicle_routes(origin, destination)')
      .eq('portal_user_id', user.id).in('travel_date', dates).in('status', ['announced', 'confirmed'])
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as { travel_date: string; direction: string; vehicle_routes: { origin: string; destination: string } | null }[]
        const hasLeg = (fromKey: string, toKey: string, date: string) => rows.some((row) =>
          row.travel_date === date && row.vehicle_routes && sameCity(row.vehicle_routes.origin, fromKey) && sameCity(row.vehicle_routes.destination, toKey))
        if (hasLeg(fromCity, toCity, departDate)) setDepartureBooked(true)
        if (tripType === 'roundtrip' && returnDate && hasLeg(toCity, fromCity, returnDate)) setReturnBooked(true)
      })
  }, [user, searched, fromCity, toCity, departDate, returnDate, tripType])

  const nm = (en: string, ur: string | null) => (isUrdu && ur ? ur : en)
  const timeLabel = (tm: string | null) => {
    if (!tm) return '—'
    const [h, m] = tm.split(':').map(Number)
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(isUrdu ? 'ur-PK' : 'en-PK', { hour: 'numeric', minute: '2-digit' })
  }

  // Group every route and trip by destination city.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (a: string, b: string | null, c: string, d: string | null) =>
      !q || [a, b, c, d].some((x) => x && x.toLowerCase().includes(q))
    const groupOk = (type: string | undefined) => !vehicleGroup || vehicleGroupFor(type) === vehicleGroup
    const map = new Map<string, { key: string; label: string; routes: RouteRow[]; trips: TripRow[] }>()
    const add = (dest: string, destUr: string | null) => {
      const key = dest.trim().toLowerCase()
      if (!map.has(key)) map.set(key, { key, label: nm(dest, destUr), routes: [], trips: [] })
      return map.get(key)!
    }
    const wantMonthly = view === 'monthly'
    for (const r of routes) if (!!r.is_monthly_fixed === wantMonthly && match(r.origin, r.origin_ur, r.destination, r.destination_ur) && groupOk(r.vehicles?.vehicle_type)) add(r.destination, r.destination_ur).routes.push(r)
    if (!wantMonthly) for (const o of trips) if (match(o.origin, o.origin_ur, o.destination, o.destination_ur) && groupOk(o.vehicles?.vehicle_type)) add(o.destination, o.destination_ur).trips.push(o)
    return Array.from(map.values()).sort((a, b) => (b.routes.length + b.trips.length) - (a.routes.length + a.trips.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, trips, query, vehicleGroup, view, isUrdu])
  const shown = city ? groups.filter((g) => g.key === city) : groups

  // Real cities actually served, derived from the data itself (same
  // source groups/destination tabs already use) rather than a fixed
  // list — a new fleet's route shows up here the moment it's created.
  const cityOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of routes) { seen.set(r.origin.trim().toLowerCase(), nm(r.origin, r.origin_ur)); seen.set(r.destination.trim().toLowerCase(), nm(r.destination, r.destination_ur)) }
    for (const o of trips) { seen.set(o.origin.trim().toLowerCase(), nm(o.origin, o.origin_ur)); seen.set(o.destination.trim().toLowerCase(), nm(o.destination, o.destination_ur)) }
    return Array.from(seen.entries()).map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, trips, isUrdu])

  const canSearch = !!fromCity && !!toCity && fromCity !== toCity && !!departDate && (tripType === 'oneway' || !!returnDate)

  const computeLegResults = (fromKey: string, toKey: string, date: string) => {
    if (!fromKey || !toKey) return { routes: [] as RouteRow[], trips: [] as TripRow[] }
    const sameCity = (a: string, key: string) => a.trim().toLowerCase() === key
    const groupOk = (type: string | undefined) => !vehicleGroup || vehicleGroupFor(type) === vehicleGroup
    const classOk = (sc: string | null) => !serviceClassFilter || sc === serviceClassFilter
    const wantMonthly = view === 'monthly'
    const dow = date ? new Date(`${date}T00:00:00`).getDay() : null
    const r = routes.filter((r) => !!r.is_monthly_fixed === wantMonthly && sameCity(r.origin, fromKey) && sameCity(r.destination, toKey) && groupOk(r.vehicles?.vehicle_type) && classOk(r.service_class) && (dow === null || (r.days_of_week ?? []).includes(dow)))
    const o = !wantMonthly && !serviceClassFilter ? trips.filter((o) => sameCity(o.origin, fromKey) && sameCity(o.destination, toKey) && groupOk(o.vehicles?.vehicle_type) && (!date || o.travel_date === date)) : []
    const routeFare = (x: RouteRow) => x.is_monthly_fixed ? (x.monthly_reference_fee_pkr ?? Infinity) : (x.fare_per_seat_pkr ?? Infinity)
    r.sort((a, b) => sortBy === 'price' ? routeFare(a) - routeFare(b) : (a.departure_time ?? '99:99').localeCompare(b.departure_time ?? '99:99'))
    o.sort((a, b) => sortBy === 'price' ? (a.listed_fare_per_seat_pkr ?? Infinity) - (b.listed_fare_per_seat_pkr ?? Infinity) : (a.departure_time_estimate ?? '99:99').localeCompare(b.departure_time_estimate ?? '99:99'))
    return { routes: r, trips: o }
  }
  const departureResults = useMemo(() => computeLegResults(fromCity, toCity, departDate),
    [routes, trips, fromCity, toCity, departDate, vehicleGroup, view, sortBy, serviceClassFilter])
  const returnResults = useMemo(() => computeLegResults(toCity, fromCity, returnDate),
    [routes, trips, fromCity, toCity, returnDate, vehicleGroup, view, sortBy, serviceClassFilter])
  const legResults = activeTab === 'return' ? returnResults : departureResults

  // Real bug found live, 2026-11-23: "selected Peshawar to Karachi for
  // departure, no bus is appearing in return route for any date." A
  // two-way route's return leg is the SAME route row (return_departure_
  // time/return_days_of_week), not a separate route going toCity→
  // fromCity — returnResults above only ever finds a genuinely separate
  // company's route, so a route's own built-in return leg never showed
  // up at all. These are that leg, booked via book_standalone_return_
  // seat (OwnReturnLegSheet) rather than place_ride_booking, since it's
  // a different RPC/shape under the hood.
  const ownReturnLegs = useMemo(() => {
    if (!fromCity || !toCity || !returnDate) return [] as RouteRow[]
    const sameCity = (a: string, key: string) => a.trim().toLowerCase() === key
    const groupOk = (type: string | undefined) => !vehicleGroup || vehicleGroupFor(type) === vehicleGroup
    const classOk = (sc: string | null) => !serviceClassFilter || sc === serviceClassFilter
    const dow = new Date(`${returnDate}T00:00:00`).getDay()
    return routes.filter((r) => r.is_two_way && !r.is_monthly_fixed && sameCity(r.origin, fromCity) && sameCity(r.destination, toCity) && groupOk(r.vehicles?.vehicle_type) && classOk(r.service_class) && (r.return_days_of_week ?? r.days_of_week ?? []).includes(dow))
  }, [routes, fromCity, toCity, returnDate, vehicleGroup, serviceClassFilter])

  const cheapestLegFare = useMemo(() => {
    const fares = [
      ...legResults.routes.map((r) => r.is_monthly_fixed ? null : r.fare_per_seat_pkr),
      ...legResults.trips.map((o) => o.listed_fare_per_seat_pkr),
    ].filter((f): f is number => f != null)
    return fares.length ? Math.min(...fares) : null
  }, [legResults])

  const resetSearch = () => {
    setFromCity(''); setToCity(''); setTripType('oneway'); setDepartDate(''); setReturnDate('')
    setSeatsWanted(1); setServiceClassFilter(null); setSearched(false); setActiveTab('departure')
    setDepartureBooked(false); setReturnBooked(false)
  }

  const handleLegBooked = () => {
    if (bookingLegTab === 'departure') {
      setDepartureBooked(true)
      if (tripType === 'roundtrip') { toast.success(t('bus.nowPickReturnToast')); setActiveTab('return') }
    } else if (bookingLegTab === 'return') {
      setReturnBooked(true)
    }
  }

  const openRoute = (r: RouteRow, legTab?: 'departure' | 'return') => {
    setBookingLegTab(legTab ?? null)
    const legDate = legTab === 'return' ? returnDate : legTab === 'departure' ? departDate : ''
    if (r.source_tenant_name) { setBookSeats(legTab ? seatsWanted : 1); setBookDate(legDate); setCrossTenantTarget({ kind: 'route', row: r }) }
    else setOpenRouteId(r.id)
  }
  const openTrip = (o: TripRow, legTab?: 'departure' | 'return') => {
    setBookingLegTab(legTab ?? null)
    if (o.source_tenant_name) { setBookSeats(legTab ? seatsWanted : 1); setCrossTenantTarget({ kind: 'trip', row: o }) }
    else router.push('/portal/marketplace/shared')
  }

  const confirmCrossTenantBooking = async () => {
    if (!crossTenantTarget) return
    const supabase = createClient()
    setBooking(true)
    // 845/846: a van-kind route (bus/coaster/hiace) now requires seat
    // numbers. This cross-tenant fallback sheet is a deliberately
    // simplified secondary path (no map, no stop picker) — rather than
    // building a full seat picker here too, the lowest free seat
    // numbers are auto-assigned from route_seat_status, same real
    // collision protection server-side either way. The primary route
    // page (RouteDetailPanel) is where a rider picks their own seat.
    let seatNumbers: number[] | null = null
    if (crossTenantTarget.kind === 'route') {
      const { data: routeRow } = await supabase.from('vehicle_routes').select('vehicle_id').eq('id', crossTenantTarget.row.id).single()
      const { data: veh } = routeRow ? await supabase.from('vehicles').select('total_seats, category_id').eq('id', routeRow.vehicle_id).single() : { data: null }
      const { data: vc } = veh?.category_id ? await supabase.from('vehicle_categories').select('vehicle_kind').eq('id', veh.category_id).single() : { data: null }
      if (vc?.vehicle_kind === 'van' && veh) {
        const { data: taken } = await supabase.rpc('route_seat_status', { p_route_id: crossTenantTarget.row.id, p_travel_date: bookDate, p_direction: 'outbound' })
        const takenSet = new Set((taken as number[]) ?? [])
        const free: number[] = []
        for (let n = 1; n <= veh.total_seats && free.length < bookSeats; n++) if (!takenSet.has(n)) free.push(n)
        if (free.length < bookSeats) { toast.error(t('bus.notEnoughSeatsError')); setBooking(false); return }
        seatNumbers = free
      }
    }
    const { error } = crossTenantTarget.kind === 'route'
      ? await supabase.rpc('place_ride_booking', { p_route_id: crossTenantTarget.row.id, p_travel_date: bookDate, p_seats: bookSeats, p_method: 'cash', p_proof_url: null, p_seat_numbers: seatNumbers })
      : await supabase.rpc('book_trip_offer', { p_trip_offer_id: crossTenantTarget.row.id, p_seats_requested: bookSeats })
    setBooking(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('bus.crossTenantBookedToast'))
    setCrossTenantTarget(null)
    handleLegBooked()
  }

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  // 2026-11-23 — real ask, matching a reference design file: swapped the
  // old vertical gradient-hero card for a flatter, single-row card
  // (icon box · route + stats · price + book) with a "best choice"
  // ribbon on the single cheapest result in a results set — same data,
  // same tap target, just the reference's layout. Extracted so the same
  // card renders in the destination-grouped browse below and in the new
  // From→To search results.
  const bestChoiceRibbon = (
    <span className="absolute -top-2.5 start-3 inline-flex items-center gap-1 bg-[#eab308] text-[#422006] text-[10px] font-bold px-2.5 py-1 rounded-full shadow-sm">
      ⭐ {t('bus.bestChoiceBadge')}
    </span>
  )
  const renderRoute = (r: RouteRow, legTab?: 'departure' | 'return', isBestChoice?: boolean) => {
    return (
      <div key={r.id} role="button" tabIndex={0} onClick={() => openRoute(r, legTab)} className="relative rounded-2xl bg-white border border-[#e5e7eb] shadow-[0_6px_18px_-12px_rgba(15,23,42,0.35)] p-3 pt-4 flex items-center gap-3 active:scale-[0.99] transition-transform cursor-pointer">
        {isBestChoice && bestChoiceRibbon}
        <span className="shrink-0 w-14 h-14 rounded-2xl bg-[#f1f5f9] flex items-center justify-center text-[28px]">{emojiFor(r.vehicles?.vehicle_type)}</span>
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[14px] font-bold text-[#0f172a] flex items-center gap-1.5">
            <bdi className="truncate">{nm(r.origin, r.origin_ur)}</bdi>
            <ArrowRight size={13} className="shrink-0 rtl:rotate-180 text-[#94a3b8]" />
            <bdi className="truncate">{nm(r.destination, r.destination_ur)}</bdi>
          </p>
          <p className="font-sans text-[11.5px] text-[#64748b] truncate mt-0.5">{r.vehicles ? vehicleDisplayName(r.vehicles.vehicle_type, r.vehicles.model) : '—'} · {r.vehicles?.owner_name}</p>
          <div className="mt-1.5 flex items-center gap-2.5 flex-wrap font-sans text-[10.5px] text-[#64748b]">
            {r.vehicles?.total_seats != null && <span className="flex items-center gap-1"><Users size={11} /> {r.vehicles.total_seats} {t('bus.seatsShort')}</span>}
            <span className="flex items-center gap-1"><Clock size={11} /> <span className="ltr-num">{timeLabel(r.departure_time)}</span></span>
            {r.route_duration_min != null && <span className="ltr-num">{Math.round(r.route_duration_min)} {t('bus.durationUnit')}</span>}
          </div>
        </div>
        <div className="text-end shrink-0 flex flex-col items-end gap-1.5">
          {r.is_monthly_fixed ? (
            <>
              <p className="font-sans text-[16px] font-black text-[#6b21a8] ltr-num">₨{fmt(r.monthly_reference_fee_pkr ?? 0)}</p>
              <span className="inline-flex items-center gap-0.5 h-8 px-3 rounded-full bg-[#6b21a8] text-white font-sans text-[11.5px] font-bold">{t('bus.applyMonthlyBtn')} <ChevronRight size={12} className="rtl:rotate-180" /></span>
            </>
          ) : (
            <>
              {r.fare_per_seat_pkr != null && <p className="font-sans text-[16px] font-black text-[#14532d] ltr-num">₨{fmt(r.fare_per_seat_pkr)}</p>}
              <span className="inline-flex items-center gap-0.5 h-8 px-3 rounded-full bg-[#15803d] text-white font-sans text-[11.5px] font-bold">{t('bus.book')} <ChevronRight size={12} className="rtl:rotate-180" /></span>
            </>
          )}
        </div>
      </div>
    )
  }
  // Real ask, 2026-11-23 — "the return selection bus booking card is
  // simple and not matching with the original bus booking card design."
  // Same flat card as renderRoute, mirrored for the return leg:
  // return_departure_time instead of departure_time, destination→origin
  // instead of origin→destination, return_days_of_week instead of
  // days_of_week, and a "Same vehicle" badge in place of the two-way
  // badge (there's nothing to compare against here — this IS the
  // two-way badge's own other half).
  const renderOwnReturnLeg = (r: RouteRow, isBestChoice?: boolean) => {
    return (
      <div key={r.id} role="button" tabIndex={0} onClick={() => setOwnReturnLegRouteId(r.id)} className="relative rounded-2xl bg-white border border-[#e5e7eb] shadow-[0_6px_18px_-12px_rgba(15,23,42,0.35)] p-3 pt-4 flex items-center gap-3 active:scale-[0.99] transition-transform cursor-pointer">
        {isBestChoice && bestChoiceRibbon}
        <span className="shrink-0 w-14 h-14 rounded-2xl bg-[#f1f5f9] flex items-center justify-center text-[28px]">{emojiFor(r.vehicles?.vehicle_type)}</span>
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[14px] font-bold text-[#0f172a] flex items-center gap-1.5">
            <bdi className="truncate">{nm(r.destination, r.destination_ur)}</bdi>
            <ArrowRight size={13} className="shrink-0 rtl:rotate-180 text-[#94a3b8]" />
            <bdi className="truncate">{nm(r.origin, r.origin_ur)}</bdi>
          </p>
          <p className="font-sans text-[11.5px] text-[#64748b] truncate mt-0.5">{r.vehicles ? vehicleDisplayName(r.vehicles.vehicle_type, r.vehicles.model) : '—'} · {r.vehicles?.owner_name}</p>
          <div className="mt-1.5 flex items-center gap-2.5 flex-wrap font-sans text-[10.5px] text-[#64748b]">
            {r.vehicles?.total_seats != null && <span className="flex items-center gap-1"><Users size={11} /> {r.vehicles.total_seats} {t('bus.seatsShort')}</span>}
            <span className="flex items-center gap-1"><Clock size={11} /> <span className="ltr-num">{timeLabel(r.return_departure_time)}</span></span>
            {r.route_duration_min != null && <span className="ltr-num">{Math.round(r.route_duration_min)} {t('bus.durationUnit')}</span>}
          </div>
        </div>
        <div className="text-end shrink-0 flex flex-col items-end gap-1.5">
          {r.fare_per_seat_pkr != null && <p className="font-sans text-[16px] font-black text-[#14532d] ltr-num">₨{fmt(r.fare_per_seat_pkr)}</p>}
          <span className="inline-flex items-center gap-0.5 h-8 px-3 rounded-full bg-[#15803d] text-white font-sans text-[11.5px] font-bold">{t('bus.book')} <ChevronRight size={12} className="rtl:rotate-180" /></span>
        </div>
      </div>
    )
  }
  const renderTrip = (o: TripRow, legTab?: 'departure' | 'return', isBestChoice?: boolean) => (
    <div key={o.id} role="button" tabIndex={0} onClick={() => openTrip(o, legTab)} className="relative rounded-2xl bg-white border border-dashed border-[#94a3b8] p-3 pt-4 flex items-center gap-3 active:scale-[0.99] transition-transform cursor-pointer">
      {isBestChoice && bestChoiceRibbon}
      <span className="shrink-0 w-14 h-14 rounded-2xl bg-[#f1f5f9] flex items-center justify-center text-[28px]">{emojiFor(o.vehicles?.vehicle_type)}</span>
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[10.5px] font-bold text-[#7c3aed] flex items-center gap-1"><CalendarDays size={11} /> {t('bus.oneOffTrip')} · <span className="ltr-num">{o.travel_date}</span> · {timeLabel(o.departure_time_estimate)}</p>
        <p className="font-sans text-[14px] font-bold text-[#0f172a] truncate mt-0.5"><bdi>{nm(o.origin, o.origin_ur)}</bdi> <ArrowRight size={13} className="inline shrink-0 rtl:rotate-180 text-[#94a3b8]" /> <bdi>{nm(o.destination, o.destination_ur)}</bdi></p>
        <p className="font-sans text-[11.5px] text-[#64748b] truncate mt-1.5 flex items-center gap-1"><Users size={11} /> {o.seats_available} {t('bus.seatsLeft')} · {o.vehicles?.owner_name}{o.source_tenant_name ? ` · 🏘️ ${o.source_tenant_name}` : ''}</p>
      </div>
      <div className="text-end shrink-0 flex flex-col items-end gap-1.5">
        <p className="font-sans text-[16px] font-black text-[#14532d] ltr-num">₨{fmt(o.listed_fare_per_seat_pkr)}</p>
        <span className="inline-flex items-center gap-0.5 h-8 px-3 rounded-full bg-[#15803d] text-white font-sans text-[11.5px] font-bold">{t('bus.book')} <ChevronRight size={12} className="rtl:rotate-180" /></span>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* 2026-11-23 — real ask, matching a reference design file: the
          plain text hero (title/subtitle/keyword search) is replaced by
          an actual banner — headline + a decorative bus "sticker" + a
          carousel-dot strip, same spirit as the reference's photo
          banner (no real photo asset to drop in, so a large flat bus
          emoji stands in — same emoji vocabulary emojiFor() already
          uses everywhere else on this very page). The keyword search
          box moved down into the destination-grouped browse section
          below (it only ever filtered that list), freeing this banner
          to be purely the visual header the reference shows. */}
      <div className="relative overflow-hidden rounded-[24px] text-white" style={{ backgroundImage: 'linear-gradient(140deg,#0f3d2e,#166534 55%,#15803d)' }}>
        <div className="relative z-10 px-4 pt-4 pb-4 max-w-[68%]">
          <p className="font-sans text-[19px] font-black leading-snug">{t('bus.bannerHeadline')}</p>
          <p className="font-sans text-[12px] text-white/80 mt-1.5 leading-snug">{t('bus.bannerSubline')}</p>
        </div>
        <span className="absolute -bottom-4 end-0 text-[92px] leading-none opacity-90 select-none pointer-events-none" aria-hidden="true">🚌</span>
        <div className="relative z-10 flex justify-center gap-1.5 pb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/35" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/35" />
        </div>
      </div>

      {/* 2026-11-22: real ask — a proper step-based search, matching how
          an air-ticket round trip actually works: From/To → one-way or
          round trip → departure (and return) date → seat count → one
          deliberate Search tap. Only after that does the results area
          (two tabs for a round trip) appear — nothing auto-filters
          while the rider is still filling the form in. */}
      {!searched ? (
        <div className="flex flex-col gap-3 -mt-6 relative z-10">
          {/* 2026-11-27 — real ask, matching a reference design file
              exactly: Monthly Fixed vs General (per-ride) sharing as two
              prominent cards, ABOVE the from/to fields — not a small
              pill tucked inside the form. Same `view` state as before,
              just restyled and repositioned. */}
          <div className="flex items-center gap-2">
            <button onClick={() => setView('perRide')}
              className={`flex-1 min-w-0 rounded-2xl p-3 text-start cursor-pointer border ${view === 'perRide' ? 'bg-[#166534] border-[#166534] text-white' : 'bg-white border-[#e5e7eb] text-[#0f172a]'}`}>
              <span className="flex items-center gap-1.5 font-sans text-[13px] font-bold"><Users2 size={14} /> {t('bus.tabPerRide')}</span>
              <span className={`block font-sans text-[10.5px] mt-0.5 ${view === 'perRide' ? 'text-white/75' : 'text-[#64748b]'}`}>{t('bus.perRideSubline')}</span>
            </button>
            <button onClick={() => { setView('monthly'); setTripType('oneway') }}
              className={`flex-1 min-w-0 rounded-2xl p-3 text-start cursor-pointer border ${view === 'monthly' ? 'bg-[#166534] border-[#166534] text-white' : 'bg-white border-[#e5e7eb] text-[#0f172a]'}`}>
              <span className="flex items-center gap-1.5 font-sans text-[13px] font-bold"><CalendarIcon size={14} /> {t('bus.tabMonthly')}</span>
              <span className={`block font-sans text-[10.5px] mt-0.5 ${view === 'monthly' ? 'text-white/75' : 'text-[#64748b]'}`}>{t('bus.monthlySubline')}</span>
            </button>
          </div>

          <div className="bg-white border border-[#e5e7eb] rounded-[20px] p-3.5 flex flex-col gap-3 shadow-[0_8px_24px_-14px_rgba(15,23,42,0.35)]">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 bg-[#f8fafc] border border-[#e5e7eb] rounded-xl px-3 py-2">
                <label className="flex items-center gap-1 font-sans text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#94a3b8] mb-1"><MapPin size={10} /> {t('bus.fromLabel')}</label>
                <select value={fromCity} onChange={(e) => setFromCity(e.target.value)} className="w-full font-sans text-[13.5px] font-bold text-[#0f172a] bg-transparent outline-none">
                  <option value="">{t('bus.anyCityOption')}</option>
                  {cityOptions.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <button type="button" aria-label={t('bus.swapCitiesAlt')} onClick={() => { const a = fromCity; setFromCity(toCity); setToCity(a) }}
                className="shrink-0 w-9 h-9 rounded-full border border-[#e5e7eb] flex items-center justify-center text-[#166534] cursor-pointer">
                <ArrowRightLeft size={15} />
              </button>
              <div className="flex-1 min-w-0 bg-[#f8fafc] border border-[#e5e7eb] rounded-xl px-3 py-2">
                <label className="flex items-center gap-1 font-sans text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#94a3b8] mb-1"><MapPin size={10} /> {t('bus.toLabel')}</label>
                <select value={toCity} onChange={(e) => setToCity(e.target.value)} className="w-full font-sans text-[13.5px] font-bold text-[#0f172a] bg-transparent outline-none">
                  <option value="">{t('bus.anyCityOption')}</option>
                  {cityOptions.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
            </div>

            {view === 'perRide' && (
              <div className="flex items-center gap-2">
                <button onClick={() => setTripType('oneway')}
                  className={`flex-1 h-10 rounded-xl font-sans text-[12.5px] font-bold cursor-pointer flex items-center justify-center gap-1.5 border ${tripType === 'oneway' ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>
                  {t('bus.oneWayOption')} <ArrowRight size={13} className="rtl:rotate-180" />
                </button>
                <button onClick={() => setTripType('roundtrip')}
                  className={`flex-1 h-10 rounded-xl font-sans text-[12.5px] font-bold cursor-pointer flex items-center justify-center gap-1.5 border ${tripType === 'roundtrip' ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>
                  <Repeat size={13} /> {t('bus.roundTripOption')}
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <label className="flex items-center gap-1 font-sans text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#94a3b8] mb-1"><Users size={10} /> {t('bus.seatsCountLabel')}</label>
                <div className="flex items-center gap-2 bg-[#f8fafc] border border-[#e5e7eb] rounded-lg px-1.5 py-1 h-[34px]">
                  <button type="button" onClick={() => setSeatsWanted((s) => Math.max(1, s - 1))} className="shrink-0 w-6 h-6 rounded-full bg-white border border-[#e5e7eb] flex items-center justify-center cursor-pointer"><Minus size={12} /></button>
                  <span className="flex-1 font-sans text-[14px] font-bold ltr-num text-center">{seatsWanted}</span>
                  <button type="button" onClick={() => setSeatsWanted((s) => Math.min(20, s + 1))} className="shrink-0 w-6 h-6 rounded-full bg-[#166534] text-white flex items-center justify-center cursor-pointer"><Plus size={12} /></button>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <label className="flex items-center gap-1 font-sans text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#94a3b8] mb-1"><CalendarDays size={10} /> {t('bus.departDateLabel')}</label>
                <input type="date" value={departDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDepartDate(e.target.value)} className="w-full font-sans text-[13px] font-bold text-[#0f172a] bg-[#f8fafc] border border-[#e5e7eb] rounded-lg px-2 h-[34px]" />
              </div>
            </div>

            {/* Always visible once in per-ride mode (matching the
                reference's collapsed hint row), active only once
                round-trip is actually picked — same canSearch gating as
                before, just no longer hidden entirely for one-way. */}
            {view === 'perRide' && (
              tripType === 'roundtrip' ? (
                <div className="flex-1 min-w-0">
                  <label className="block font-sans text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#94a3b8] mb-1">{t('bus.returnDateLabel')}</label>
                  <input type="date" value={returnDate} min={departDate || new Date().toISOString().slice(0, 10)} onChange={(e) => setReturnDate(e.target.value)} className="w-full font-sans text-[13px] font-bold text-[#0f172a] bg-[#f8fafc] border border-[#e5e7eb] rounded-lg px-2 py-1.5" />
                </div>
              ) : (
                <p className="flex items-center gap-1.5 font-sans text-[11px] text-[#94a3b8] bg-[#f8fafc] border border-[#e5e7eb] rounded-lg px-2.5 py-2">
                  <CalendarIcon size={12} /> {t('bus.returnDateCollapsedHint')}
                </p>
              )
            )}

            <button onClick={() => { setSearched(true); setActiveTab('departure'); setDepartureBooked(false); setReturnBooked(false) }} disabled={!canSearch}
              className="w-full h-11 rounded-xl bg-[#166534] text-white font-sans text-[14px] font-bold cursor-pointer disabled:opacity-40 flex items-center justify-center gap-2">
              <Search size={16} /> {t('bus.searchBtn')}
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-[#e5e7eb] rounded-[20px] p-3.5 flex items-center justify-between gap-3 -mt-6 relative z-10 shadow-[0_8px_24px_-14px_rgba(15,23,42,0.35)]">
          <div className="min-w-0">
            <p className="font-sans text-[13.5px] font-bold text-[#0f172a] truncate">
              {cityOptions.find((c) => c.key === fromCity)?.label} → {cityOptions.find((c) => c.key === toCity)?.label}
            </p>
            <p className="font-sans text-[11px] text-[#64748b] mt-0.5 ltr-num">
              {departDate}{tripType === 'roundtrip' ? ` ⇄ ${returnDate}` : ''} · {t('rw.seats').replace('{n}', String(seatsWanted))}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setSearched(false)} className="flex items-center gap-1 h-8 px-3 rounded-full bg-[#f1f5f9] font-sans text-[11.5px] font-bold text-[#334155] cursor-pointer">
              <Pencil size={11} /> {t('bus.editSearchBtn')}
            </button>
            <button onClick={resetSearch} aria-label={t('bus.clearSearchBtn')} className="w-8 h-8 rounded-full bg-[#fef2f2] flex items-center justify-center text-[#b91c1c] cursor-pointer">
              <X size={14} />
            </button>
          </div>
        </div>
      )}


      {/* 2026-11-23 — real ask, matching a reference design file: each
          filter row gets its own labeled heading (funnel/pin icon + text)
          instead of a bare pill row, same pattern for vehicle and city. */}
      <p className="flex items-center gap-1.5 font-sans text-[12px] font-bold text-[#334155]"><FilterIcon size={13} className="text-[#166534]" /> {t('bus.filterByVehicleHeading')}</p>
      <div className="flex gap-2 overflow-x-auto hide-scrollbar -mt-1.5">
        {([null, 'shared', 'car', 'auto', 'bike'] as const).map((g) => (
          <button key={g ?? 'all'} onClick={() => setVehicleGroup(g)}
            className={`shrink-0 h-9 px-3.5 rounded-full font-sans text-[12.5px] font-bold border flex items-center gap-1 ${vehicleGroup === g ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>
            {g === null ? t('bus.filterAll') : g === 'shared' ? t('bus.filterShared') : g === 'car' ? t('bus.filterCar') : g === 'auto' ? t('bus.filterAuto') : t('bus.filterBike')}
            {vehicleGroup === g && <Check size={11} />}
          </button>
        ))}
      </div>

      <FarePolicyCard service="seat" defaultOpen={false} />

      {searched ? (
        <section className="flex flex-col gap-2.5">
          {/* 2026-11-22: real ask — "two tabs will appear, one for
              departure and 2nd for return... user will keep changing
              the dates while in the tabs to search the cheapest bus."
              Each tab keeps its own editable date (prefilled from the
              search form) and runs the exact same cheapest-first
              filtering against that date — picking a bus from the
              Departure tab auto-switches here to Return once booked
              (handleLegBooked), same as two independent one-way
              searches, any operator either side. */}
          {tripType === 'roundtrip' && (
            <>
              {/* Real ask, 2026-11-23 — "we can't go back to choose the
                  return ride because the rider needs to book the
                  departure first in case he wants a return seat too."
                  The Return tab stays locked (not just unstyled — a
                  real disabled button) until departureBooked flips
                  true, which only happens from a real successful
                  booking (handleLegBooked), which also auto-switches
                  here for the rider — so this lock is normally never
                  even seen, just a safety rail if they try to skip
                  ahead. */}
              <div className="flex gap-1 bg-[#f1f5f9] rounded-full p-1">
                {(['departure', 'return'] as const).map((tb) => {
                  const locked = tb === 'return' && !departureBooked
                  return (
                    <button key={tb} onClick={() => !locked && setActiveTab(tb)} disabled={locked}
                      className={`flex-1 h-9 rounded-full font-sans text-[12.5px] font-bold cursor-pointer flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50 ${activeTab === tb ? 'bg-white text-[#166534] shadow-sm' : 'text-[#64748b]'}`}>
                      {locked ? <Lock size={11} /> : (tb === 'departure' ? departureBooked : returnBooked) && <Check size={12} className="text-[#16a34a]" />}
                      {tb === 'departure' ? t('bus.departureTabLabel') : t('bus.returnTabLabel2')}
                    </button>
                  )
                })}
              </div>
              {activeTab === 'departure' && !departureBooked && (
                <p className="font-sans text-[11px] text-[#64748b] -mt-1.5">{t('bus.bookDepartureFirstHint')}</p>
              )}
            </>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={activeTab === 'return' ? returnDate : departDate}
              min={activeTab === 'return' ? (departDate || new Date().toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10)}
              onChange={(e) => (activeTab === 'return' ? setReturnDate(e.target.value) : setDepartDate(e.target.value))}
              className="font-sans text-[12.5px] font-bold text-[#0f172a] bg-[#f8fafc] border border-[#e5e7eb] rounded-lg px-2 py-1.5" />
            <div className="flex gap-1 bg-[#f1f5f9] rounded-full p-0.5 shrink-0">
              {(['price', 'time'] as const).map((s) => (
                <button key={s} onClick={() => setSortBy(s)} className={`h-7 px-2.5 rounded-full font-sans text-[11px] font-bold cursor-pointer ${sortBy === s ? 'bg-white text-[#166534] shadow-sm' : 'text-[#64748b]'}`}>
                  {s === 'price' ? t('bus.sortCheapest') : t('bus.sortEarliest')}
                </button>
              ))}
            </div>
          </div>

          {/* Real ask, same day — "also there will be option inside the
              tabs for service type like sleeper, business class,
              economy etc." Reuses vehicle_routes.service_class, the
              same column RouteDetailPanel already shows as a badge. */}
          <div className="flex gap-1.5 overflow-x-auto hide-scrollbar">
            <button onClick={() => setServiceClassFilter(null)} className={`shrink-0 h-8 px-3 rounded-full font-sans text-[11.5px] font-bold border ${!serviceClassFilter ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>{t('bus.anyServiceClassOption')}</button>
            {SERVICE_CLASSES.map((sc) => (
              <button key={sc} onClick={() => setServiceClassFilter(sc)} className={`shrink-0 h-8 px-3 rounded-full font-sans text-[11.5px] font-bold border ${serviceClassFilter === sc ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>{t(`mv.serviceClass.${sc}`)}</button>
            ))}
          </div>

          {activeTab === 'return' && ownReturnLegs.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <p className="font-sans text-[12px] font-bold text-[#0f172a] uppercase tracking-[0.05em]">{t('bus.ownReturnLegsHeading')}</p>
              {ownReturnLegs.map((r) => renderOwnReturnLeg(r))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="font-sans text-[13px] font-bold text-[#0f172a]">
              {t('bus.searchResultsHeading').replace('{n}', String(legResults.routes.length + legResults.trips.length))
                .replace('{from}', cityOptions.find((c) => c.key === (activeTab === 'return' ? toCity : fromCity))?.label ?? '')
                .replace('{to}', cityOptions.find((c) => c.key === (activeTab === 'return' ? fromCity : toCity))?.label ?? '')}
            </p>
            {cheapestLegFare != null && <p className="font-sans text-[11.5px] font-bold text-[#166534] shrink-0">{t('bus.cheapestFareLabel')} ₨{fmt(cheapestLegFare)}</p>}
          </div>
          {legResults.routes.length === 0 && legResults.trips.length === 0 && ownReturnLegs.length === 0 && (
            <p className="text-center font-sans text-[13px] text-[#64748b] py-10">{t('bus.noResultsForPairHint')}</p>
          )}
          {legResults.routes.map((r) => renderRoute(r, activeTab, !r.is_monthly_fixed && r.fare_per_seat_pkr === cheapestLegFare))}
          {legResults.trips.map((o) => renderTrip(o, activeTab, o.listed_fare_per_seat_pkr === cheapestLegFare))}
        </section>
      ) : (
      <>
      {shown.length === 0 && <p className="text-center font-sans text-[13px] text-[#64748b] py-10">{t('bus.empty')}</p>}

      {shown.map((g) => {
        const groupFares = [
          ...g.routes.map((r) => r.is_monthly_fixed ? null : r.fare_per_seat_pkr),
          ...g.trips.map((o) => o.listed_fare_per_seat_pkr),
        ].filter((f): f is number => f != null)
        const groupCheapest = groupFares.length ? Math.min(...groupFares) : null
        return (
          <section key={g.key} className="flex flex-col gap-2.5">
            <p className="flex items-center gap-2 font-sans text-[16px] font-extrabold text-[#0f172a]"><span className="w-1.5 h-5 rounded-full bg-[#16a34a]" /> <bdi>{g.label}</bdi></p>
            {g.routes.map((r) => renderRoute(r, undefined, !r.is_monthly_fixed && r.fare_per_seat_pkr === groupCheapest))}
            {g.trips.map((o) => renderTrip(o, undefined, o.listed_fare_per_seat_pkr === groupCheapest))}
          </section>
        )
      })}
      </>
      )}

      {crossTenantTarget && (
        <MobilityBottomSheet title={t('bus.crossTenantSheetTitle')} onClose={() => setCrossTenantTarget(null)}>
          <div className="flex flex-col gap-3">
            <p className="font-sans text-[11.5px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 inline-flex items-center gap-1 self-start">
              <MapPinned size={12} /> {crossTenantTarget.row.source_tenant_name}
            </p>
            <p className="font-sans text-[15px] font-bold text-[#0f172a]">
              <bdi>{nm(crossTenantTarget.row.origin, crossTenantTarget.row.origin_ur)}</bdi> → <bdi>{nm(crossTenantTarget.row.destination, crossTenantTarget.row.destination_ur)}</bdi>
            </p>
            <p className="font-sans text-[12.5px] text-[#64748b]">
              {crossTenantTarget.row.vehicles ? vehicleDisplayName(crossTenantTarget.row.vehicles.vehicle_type, crossTenantTarget.row.vehicles.model) : '—'} · {crossTenantTarget.row.vehicles?.owner_name}
            </p>
            {crossTenantTarget.kind === 'route' && (
              bookingLegTab ? (
                <p className="font-sans text-[13px] font-semibold text-[#0f172a] ltr-num">{t('bus.travelDateLabel')}: {bookDate}</p>
              ) : (
                <div>
                  <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('bus.travelDateLabel')}</label>
                  <input type="date" value={bookDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setBookDate(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                </div>
              )
            )}
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('bus.seatsLabel')}</label>
              <input type="number" min={1} value={bookSeats} onChange={(e) => setBookSeats(Math.max(1, Number(e.target.value)))} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
            <p className="font-sans text-[16px] font-black text-[#14532d]">
              <span className="ltr-num">₨{fmt((crossTenantTarget.kind === 'route' ? crossTenantTarget.row.fare_per_seat_pkr ?? 0 : crossTenantTarget.row.listed_fare_per_seat_pkr) * bookSeats)}</span>
            </p>
            <button onClick={confirmCrossTenantBooking} disabled={booking || (crossTenantTarget.kind === 'route' && !bookDate)}
              className="w-full py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {booking ? t('action.saving') : t('bus.confirmBookingBtn')}
            </button>
          </div>
        </MobilityBottomSheet>
      )}
      {openRouteId && (
        <RouteBookingSheet routeId={openRouteId} onClose={() => setOpenRouteId(null)}
          initialDate={bookingLegTab === 'return' ? returnDate : bookingLegTab === 'departure' ? departDate : undefined}
          initialSeats={bookingLegTab ? seatsWanted : undefined}
          onBooked={handleLegBooked}
          compact={!!bookingLegTab} />
      )}
      {ownReturnLegRouteId && (
        <OwnReturnLegSheet routeId={ownReturnLegRouteId} travelDate={returnDate} seatsWanted={seatsWanted}
          onClose={() => setOwnReturnLegRouteId(null)} onBooked={() => setReturnBooked(true)} />
      )}
    </div>
  )
}
