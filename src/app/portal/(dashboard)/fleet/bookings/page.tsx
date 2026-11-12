'use client'

// 860/864: Bookings tab — counter walk-up booking (855's record_manual_
// booking) plus the station-manager workflow researched this session:
// find an existing booking (by passenger name/mobile), reschedule or
// cancel it, see all of today's bookings, and check the seat position
// of a run departing a few days out. Real gaps confirmed before
// building this: the old version hardcoded every date to today and had
// no search/reschedule at all, across either booking source.

import { useEffect, useState } from 'react'
import { Ticket, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { SeatPickerField } from '@/components/mobility/SeatPickerField'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
interface Route { id: string; origin: string; destination: string; departure_time: string | null; fare_per_seat_pkr: number }
interface VehicleSeating { totalSeats: number; isVanKind: boolean; isSleeper: boolean }
interface Counter { id: string; city: string; name: string | null }
interface FoundBooking {
  id: string; source: 'manual' | 'app'; passenger_name: string; passenger_mobile: string | null
  route_id: string; origin: string; destination: string; owner_name: string
  travel_date: string; seats: number; amount_pkr: number; status: string; payment_method: string | null
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function today() { return new Date().toISOString().slice(0, 10) }

export default function FleetBookingsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [routes, setRoutes] = useState<Route[]>([])
  const [routeId, setRouteId] = useState('')
  const [counters, setCounters] = useState<Counter[]>([])
  const [counterId, setCounterId] = useState('')
  const [passengerName, setPassengerName] = useState('')
  const [passengerMobile, setPassengerMobile] = useState('')
  const [seats, setSeats] = useState(1)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [recording, setRecording] = useState(false)
  // Real ask: "a currently booking position of any bus which is going
  // to depart after few days" — the whole form used to hardcode today.
  const [bookTravelDate, setBookTravelDate] = useState(today())
  const [seating, setSeating] = useState<VehicleSeating | null>(null)
  const [takenSeats, setTakenSeats] = useState<number[]>([])
  const [selectedSeats, setSelectedSeats] = useState<number[]>([])

  // "Find a booking" — unified across both sources (855's counter sales
  // + rider self-bookings), defaults to today so it doubles as "all of
  // today's bookings" with zero query typed.
  const [searchDate, setSearchDate] = useState(today())
  const [searchQuery, setSearchQuery] = useState('')
  const [found, setFound] = useState<FoundBooking[]>([])
  const [searching, setSearching] = useState(false)
  const [rescheduling, setRescheduling] = useState<FoundBooking | null>(null)
  const [rescheduleDate, setRescheduleDate] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      setFleetId(f?.fleet_id ?? null)
      if (f) {
        const [{ data: v }, { data: c }] = await Promise.all([
          supabase.rpc('my_fleet_vehicles'),
          supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id }),
        ])
        setVehicles((v ?? []) as FleetVehicle[])
        setCounters((c ?? []) as Counter[])
        if ((v ?? []).length > 0) setVehicleId((v as FleetVehicle[])[0].id)
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const loadRoutesFor = async (vid: string) => {
    setRouteId(''); setSeating(null)
    if (!vid) return
    const [{ data: r }, { data: v }] = await Promise.all([
      supabase.from('vehicle_routes').select('id, origin, destination, departure_time, fare_per_seat_pkr').eq('vehicle_id', vid).eq('is_active', true),
      supabase.from('vehicles').select('total_seats, is_sleeper, category_id, vehicle_categories(vehicle_kind)').eq('id', vid).single(),
    ])
    setRoutes((r ?? []) as Route[])
    const vv = v as { total_seats: number; is_sleeper: boolean; vehicle_categories: { vehicle_kind: string } | null } | null
    setSeating(vv ? { totalSeats: vv.total_seats, isVanKind: vv.vehicle_categories?.vehicle_kind === 'van', isSleeper: vv.is_sleeper } : null)
  }

  useEffect(() => { if (vehicleId) loadRoutesFor(vehicleId) }, [vehicleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadTakenSeats = async () => {
    if (!routeId || !seating?.isVanKind) { setTakenSeats([]); return }
    const { data } = await supabase.rpc('route_seat_status', { p_route_id: routeId, p_travel_date: bookTravelDate, p_direction: 'outbound' })
    setTakenSeats((data as number[]) ?? [])
  }

  useEffect(() => {
    setSelectedSeats([])
    if (routeId) loadTakenSeats()
  }, [routeId, bookTravelDate, seating?.isVanKind]) // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = async () => {
    if (!fleetId) return
    setSearching(true)
    const { data, error } = await supabase.rpc('fleet_search_bookings', { p_fleet_id: fleetId, p_query: searchQuery || null, p_travel_date: searchDate || null })
    setSearching(false)
    if (error) { toast.error(friendlyError(error)); return }
    setFound((data ?? []) as FoundBooking[])
  }

  useEffect(() => { if (fleetId) runSearch() }, [fleetId, searchDate]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRoute = routes.find((r) => r.id === routeId)

  const recordBooking = async () => {
    if (!routeId || !passengerName.trim() || !amount) { toast.error(t('mv.fillManualBookingError')); return }
    if (seating?.isVanKind && selectedSeats.length !== seats) { toast.error(t('mv.pickASeatError')); return }
    setRecording(true)
    const { error } = await supabase.rpc('record_manual_booking', {
      p_route_id: routeId, p_travel_date: bookTravelDate, p_seats: seats,
      p_passenger_name: passengerName, p_total_amount_pkr: Number(amount),
      p_counter_id: counterId || null, p_passenger_mobile: passengerMobile || null, p_payment_method: method,
      p_seat_numbers: seating?.isVanKind ? selectedSeats : null,
    })
    setRecording(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.manualBookingRecordedToast'))
    setPassengerName(''); setPassengerMobile(''); setSeats(1); setAmount(''); setSelectedSeats([])
    loadTakenSeats()
    if (bookTravelDate === searchDate) runSearch()
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
    setBusyId(rescheduling.id)
    const rpc = rescheduling.source === 'manual' ? 'reschedule_manual_booking' : 'reschedule_ride_booking'
    const params = rescheduling.source === 'manual' ? { p_id: rescheduling.id, p_new_travel_date: rescheduleDate } : { p_booking_id: rescheduling.id, p_new_travel_date: rescheduleDate }
    const { error } = await supabase.rpc(rpc, params)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.bookingRescheduledToast'))
    setRescheduling(null); setRescheduleDate('')
    runSearch()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Ticket size={19} /> {t('mv.fleetBookingsHeading')}</h1>

      {/* Record a new booking */}
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{t('mv.recordBookingBtn')}</p>
        <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.selectVehicleLabel')}</label>
        <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5">
          {vehicles.map((v) => <option key={v.id} value={v.id}>{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</option>)}
        </select>

        <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.selectRouteLabel')}</label>
        <select value={routeId} onChange={(e) => setRouteId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5">
          <option value="">{t('mv.selectRoutePlaceholder')}</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.origin} → {r.destination}{r.departure_time ? ` · ${r.departure_time}` : ''}</option>)}
        </select>

        {routeId && (
          <>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.travelDateLabel')}</label>
            <input type="date" value={bookTravelDate} min={today()} onChange={(e) => setBookTravelDate(e.target.value)}
              className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5 ltr-num" />
            {counters.length > 0 && (
              <select value={counterId} onChange={(e) => setCounterId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2">
                <option value="">{t('mv.noCounterOption')}</option>
                {counters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
              </select>
            )}
            <div className="flex gap-2 mb-2">
              <input value={passengerName} onChange={(e) => setPassengerName(e.target.value)} placeholder={t('mv.passengerNamePlaceholder')}
                className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              <input value={passengerMobile} onChange={(e) => setPassengerMobile(e.target.value)} placeholder={t('mv.passengerMobileOptionalPlaceholder')}
                className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
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
                <SeatPickerField totalSeats={seating.totalSeats} takenSeatNumbers={takenSeats} seatsNeeded={seats} selected={selectedSeats} onChange={setSelectedSeats} isSleeper={seating.isSleeper} />
              </div>
            )}
            <button onClick={recordBooking} disabled={recording} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {recording ? t('action.loading') : t('mv.recordBookingBtn')}
            </button>
          </>
        )}
      </div>

      {/* Find a booking — defaults to today (= "today's bookings"),
          change the date to check a future run's position, type a
          name/mobile to find one specific booking either source. */}
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{t('mv.findBookingHeading')}</p>
        <div className="flex gap-2 mb-2.5">
          <input type="date" value={searchDate} onChange={(e) => setSearchDate(e.target.value)}
            className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
          <div className="relative flex-1">
            <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder={t('mv.searchByNameMobilePlaceholder')} className="w-full ps-9 pe-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          <button onClick={runSearch} disabled={searching} className="px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
            {searching ? t('action.loading') : t('mv.searchBtn')}
          </button>
        </div>

        {found.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.noBookingsFoundHint')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {found.map((b) => (
              <div key={`${b.source}-${b.id}`} className="border border-[#e5e2d0] rounded-lg px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{b.passenger_name}{b.passenger_mobile ? ` · ${b.passenger_mobile}` : ''}</p>
                    <p className="font-sans text-[10.5px] text-[#94a3b8]">{b.origin} → {b.destination} · {b.owner_name} · {b.seats} {t('mv.seatsSuffix')} · <span className="ltr-num">{b.travel_date}</span></p>
                  </div>
                  <span className="shrink-0 font-sans text-[13px] font-bold text-[#166534] ltr-num">₨{fmt(b.amount_pkr)}</span>
                </div>
                {rescheduling?.id === b.id ? (
                  <div className="flex gap-2 mt-2">
                    <input type="date" value={rescheduleDate} min={today()} onChange={(e) => setRescheduleDate(e.target.value)}
                      className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
                    <button onClick={confirmReschedule} disabled={busyId === b.id} className="px-3 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">{t('action.save')}</button>
                    <button onClick={() => setRescheduling(null)} className="p-1.5 text-[#64748b] cursor-pointer"><X size={15} /></button>
                  </div>
                ) : (
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => { setRescheduling(b); setRescheduleDate(b.travel_date) }} className="flex-1 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer">{t('mv.rescheduleBtn')}</button>
                    <button onClick={() => cancelFound(b)} disabled={busyId === b.id} className="flex-1 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50">{t('action.cancel')}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
