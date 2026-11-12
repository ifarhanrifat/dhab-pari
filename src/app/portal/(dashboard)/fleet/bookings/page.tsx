'use client'

// 860: Bookings tab — counter walk-up booking (855's record_manual_
// booking/route_manual_bookings_today), genuinely surfaced for the first
// time at the fleet level. It already existed, but only buried inside
// the single-vehicle my-vehicle/routes/page.tsx, which requires a
// personal vehicle to even render (`if (!vehicleId) return null`) — a
// fleet-only owner with no vehicle of their own could never reach it.
// This picks a fleet vehicle, then one of its routes, then books.

import { useEffect, useState } from 'react'
import { Ticket } from 'lucide-react'
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
interface ManualBooking { id: string; passenger_name: string; seats: number; total_amount_pkr: number; payment_method: string; created_at: string }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

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
  const [todayBookings, setTodayBookings] = useState<ManualBooking[]>([])
  // Van/bus/coaster/hiace-kind vehicles sell by seat number, not just a
  // count — record_manual_booking (855) REQUIRES p_seat_numbers to match
  // p_seats exactly for these, same rule the single-vehicle routes page
  // already enforces. Real gap found live, 2026-11-12: this fleet-wide
  // Bookings tab skipped seat selection entirely, which would reject
  // every single booking attempt on a van-kind vehicle (the QA fleet's
  // own Coaster/Bus are both van-kind) with "Pick exactly N seat(s)".
  const [seating, setSeating] = useState<VehicleSeating | null>(null)
  const [takenSeats, setTakenSeats] = useState<number[]>([])
  const [selectedSeats, setSelectedSeats] = useState<number[]>([])

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
    setRouteId(''); setRoutes([]); setTodayBookings([]); setSeating(null)
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

  const loadTodayBookings = async (rid: string) => {
    if (!rid) { setTodayBookings([]); return }
    const { data } = await supabase.rpc('route_manual_bookings_today', { p_route_id: rid })
    setTodayBookings((data ?? []) as ManualBooking[])
  }

  const loadTakenSeats = async (rid: string) => {
    if (!rid || !seating?.isVanKind) { setTakenSeats([]); return }
    const { data } = await supabase.rpc('route_seat_status', { p_route_id: rid, p_travel_date: new Date().toISOString().slice(0, 10), p_direction: 'outbound' })
    setTakenSeats((data as number[]) ?? [])
  }

  useEffect(() => {
    setSelectedSeats([])
    if (routeId) { loadTodayBookings(routeId); loadTakenSeats(routeId) }
  }, [routeId, seating?.isVanKind]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRoute = routes.find((r) => r.id === routeId)

  const recordBooking = async () => {
    if (!routeId || !passengerName.trim() || !amount) { toast.error(t('mv.fillManualBookingError')); return }
    if (seating?.isVanKind && selectedSeats.length !== seats) { toast.error(t('mv.pickASeatError')); return }
    setRecording(true)
    const { error } = await supabase.rpc('record_manual_booking', {
      p_route_id: routeId, p_travel_date: new Date().toISOString().slice(0, 10), p_seats: seats,
      p_passenger_name: passengerName, p_total_amount_pkr: Number(amount),
      p_counter_id: counterId || null, p_passenger_mobile: passengerMobile || null, p_payment_method: method,
      p_seat_numbers: seating?.isVanKind ? selectedSeats : null,
    })
    setRecording(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.manualBookingRecordedToast'))
    setPassengerName(''); setPassengerMobile(''); setSeats(1); setAmount(''); setSelectedSeats([])
    loadTodayBookings(routeId); loadTakenSeats(routeId)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Ticket size={19} /> {t('mv.fleetBookingsHeading')}</h1>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
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

      {routeId && (
        <div>
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('mv.counterTodaysBookingsHeading')}</p>
          {todayBookings.length === 0 ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.noBookingsTodayHint')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {todayBookings.map((b) => (
                <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-lg px-3 py-2 flex items-center justify-between">
                  <div>
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{b.passenger_name}</p>
                    <p className="font-sans text-[10.5px] text-[#94a3b8]">{b.seats} {t('mv.seatsSuffix')} · {b.payment_method}</p>
                  </div>
                  <span className="font-sans text-[13px] font-bold text-[#166534] ltr-num">₨{fmt(b.total_amount_pkr)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
