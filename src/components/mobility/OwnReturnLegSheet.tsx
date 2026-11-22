'use client'

// Real bug found live, 2026-11-23: a two-way route (e.g. Peshawar →
// Karachi, with its own return_departure_time/return_days_of_week)
// never appeared in the new search flow's Return tab at all. That tab
// only ever looked for a SEPARATE route record going toCity→fromCity
// (a different company's own route) — a two-way route's return leg
// isn't a separate route row, it's the SAME row's return_departure_
// time/return_days_of_week, booked via the existing
// book_standalone_return_seat RPC (direction='return' on the same
// route_id), not place_ride_booking on a different route. This sheet
// is that booking path's own compact UI — same spirit as the compact
// RouteDetailPanel mode (no date picker, no map, date fixed from the
// search tab), kept separate because the underlying RPC and its
// single-seat-per-call shape genuinely differ from an ordinary
// multi-seat place_ride_booking.
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { SeatPickerField } from '@/components/mobility/SeatPickerField'
import { RideTicketSheet, type RideTicketInfo } from '@/components/mobility/RideTicketSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface RouteInfo {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  return_departure_time: string | null; fare_per_seat_pkr: number | null; vehicle_id: string
}
interface VehicleInfo { id: string; owner_name: string; vehicle_type: string; total_seats: number; commission_mode: string; category_id: string | null; is_sleeper?: boolean }
interface Stop { id: string; label: string; label_ur: string | null; stop_order: number }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function OwnReturnLegSheet({ routeId, travelDate, seatsWanted, onClose, onBooked }: {
  routeId: string; travelDate: string; seatsWanted: number; onClose: () => void; onBooked?: () => void
}) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [route, setRoute] = useState<RouteInfo | null>(null)
  const [vehicle, setVehicle] = useState<VehicleInfo | null>(null)
  const [vehicleKind, setVehicleKind] = useState<string | null>(null)
  const [stops, setStops] = useState<Stop[]>([])
  const [boardStopId, setBoardStopId] = useState<string | null>(null)
  const [takenSeats, setTakenSeats] = useState<number[]>([])
  const [selectedSeats, setSelectedSeats] = useState<number[]>([])
  const [available, setAvailable] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [ticketView, setTicketView] = useState<RideTicketInfo | null>(null)
  const isSeatNumbered = vehicleKind === 'van'
  const isPerOrder = vehicle?.commission_mode === 'per_order'

  useEffect(() => {
    supabase.from('vehicle_routes').select('id, origin, origin_ur, destination, destination_ur, return_departure_time, fare_per_seat_pkr, vehicle_id').eq('id', routeId).single().then(async ({ data: r }) => {
      setRoute(r)
      if (r) {
        const [{ data: v }, { data: st }] = await Promise.all([
          supabase.from('vehicles').select('id, owner_name, vehicle_type, total_seats, commission_mode, category_id, is_sleeper').eq('id', r.vehicle_id).single(),
          supabase.from('route_stops').select('id, label, label_ur, stop_order').eq('route_id', r.id).order('stop_order'),
        ])
        setVehicle(v)
        setStops(st ?? [])
        if (v?.category_id) {
          const { data: vc } = await supabase.from('vehicle_categories').select('vehicle_kind').eq('id', v.category_id).single()
          setVehicleKind(vc?.vehicle_kind ?? null)
        }
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  useEffect(() => {
    supabase.rpc('return_seats_available', { p_route_id: routeId, p_travel_date: travelDate }).then(({ data }) => setAvailable(data as number))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, travelDate])

  useEffect(() => {
    if (!isSeatNumbered) { setTakenSeats([]); return }
    supabase.rpc('route_seat_status', { p_route_id: routeId, p_travel_date: travelDate, p_direction: 'return' }).then(({ data }) => setTakenSeats((data as number[]) ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, travelDate, isSeatNumbered])

  const fare = route?.fare_per_seat_pkr ?? 0
  const total = fare * seatsWanted

  const submit = async () => {
    if (!route) return
    if (!boardStopId) { toast.error(t('mv.pickBoardStopLabel')); return }
    if (isSeatNumbered && selectedSeats.length !== seatsWanted) { toast.error(t('mv.pickASeatError')); return }
    setSubmitting(true)
    const boardStop = stops.find((s) => s.id === boardStopId)
    // book_standalone_return_seat books exactly one seat per call (its
    // real original purpose: one rider grabbing one freed seat) — a
    // multi-seat pick here just calls it once per seat, same as
    // multiple independent riders would.
    type BookResult = { booking_id: string; ticket_no: string; total: number }
    let lastResult: BookResult | null = null
    const ticketNos: string[] = []
    for (let i = 0; i < seatsWanted; i++) {
      const { data, error } = await supabase.rpc('book_standalone_return_seat', {
        p_route_id: route.id, p_travel_date: travelDate, p_board_stop_id: boardStopId,
        p_method: isPerOrder ? 'direct' : null, p_proof_url: null,
        p_seat_number: isSeatNumbered ? selectedSeats[i] : null,
      })
      if (error) { setSubmitting(false); toast.error(friendlyError(error, undefined, isUrdu)); return }
      lastResult = data as BookResult
      ticketNos.push(lastResult.ticket_no)
    }
    setSubmitting(false)
    if (!lastResult) return
    toast.success(t('mv.returnSeatBookedToast').replace('{amount}', fmt(lastResult.total * seatsWanted)))
    setTicketView({
      bookingId: lastResult.booking_id, vehicleId: route.vehicle_id, ticketNo: ticketNos.join(' + '),
      origin: boardStop ? (isUrdu && boardStop.label_ur ? boardStop.label_ur : boardStop.label) : (isUrdu && route.destination_ur ? route.destination_ur : route.destination),
      destination: isUrdu && route.origin_ur ? route.origin_ur : route.origin,
      travelDate, departureTime: route.return_departure_time, seats: seatsWanted,
      seatNumbers: isSeatNumbered ? selectedSeats : null, amountPkr: lastResult.total * seatsWanted,
      paymentConfirmed: false, isPerOrder,
    })
    onBooked?.()
  }

  return (
    <MobilityBottomSheet title={t('mv.routeDetailsHeading')} onClose={onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
        {loading || !route ? (
          <div className="py-10 text-center"><LoadingDots /></div>
        ) : (
          <>
            <h1 className="font-heading text-[18px] font-bold text-dp-primary">
              {isUrdu && route.destination_ur ? route.destination_ur : route.destination} → {isUrdu && route.origin_ur ? route.origin_ur : route.origin}
            </h1>
            {vehicle && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{vehicle.owner_name} · {vehicle.vehicle_type}</p>}
            <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1 ltr-num">
              🕒 {route.return_departure_time ? route.return_departure_time.slice(0, 5) : t('mk.noFixedTime')} · {travelDate}
            </p>
            <p className="font-heading text-[20px] font-bold text-dp-secondary mt-2">{fmt(fare)} <span className="font-sans font-normal text-dp-on-surface-variant text-[13px]">{t('mk.perSeat')}</span></p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant bg-dp-secondary-container/30 rounded-lg px-3 py-2 mt-2">{t('mv.returnSeatHint')}</p>

            <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mt-4">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('mv.pickBoardStopLabel')}</label>
              <select value={boardStopId ?? ''} onChange={(e) => setBoardStopId(e.target.value || null)} className="input-field">
                <option value="">{t('mv.pickBoardStopLabel')}</option>
                {stops.map((s) => <option key={s.id} value={s.id}>{isUrdu && s.label_ur ? s.label_ur : s.label}</option>)}
              </select>

              {available != null && (
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2 ltr-num">{t('mv.returnSeatsOpenNote').replace('{n}', String(available))}</p>
              )}

              {isSeatNumbered && vehicle && (
                <div className="mt-3">
                  <SeatPickerField totalSeats={vehicle.total_seats} takenSeatNumbers={takenSeats} seatsNeeded={seatsWanted} selected={selectedSeats} onChange={setSelectedSeats} isSleeper={vehicle.is_sleeper} />
                </div>
              )}

              <div className="flex items-center justify-between pt-3 mt-3 border-t border-dp-outline-variant">
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('mp.cartTotal')}</p>
                <p className="font-heading text-[19px] font-bold text-dp-secondary">{fmt(total)}</p>
              </div>

              {isPerOrder ? (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-secondary-container/40 rounded-lg px-3 py-2.5 mt-4">{t('cm.payDirectlyNote')}</p>
              ) : (
                <p className="font-sans text-[11.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mt-4">{t('mv.seatNeedsDriverConfirmNote')}</p>
              )}

              <button onClick={submit} disabled={submitting || !boardStopId || (isSeatNumbered && selectedSeats.length !== seatsWanted) || available === 0}
                className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold active:scale-[0.98] cursor-pointer hover:bg-dp-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {submitting ? t('mp.placingBooking') : t('mv.bookReturnSeatBtn')}
              </button>
              {available === 0 && <p className="font-sans text-[13px] text-dp-error mt-3">{t('mv.noReturnSeatsYetHint')}</p>}
            </div>
          </>
        )}
      </div>
      {ticketView && <RideTicketSheet info={ticketView} onClose={() => { setTicketView(null); onClose() }} />}
    </MobilityBottomSheet>
  )
}
