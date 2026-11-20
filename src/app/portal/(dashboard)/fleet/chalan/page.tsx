'use client'

// 871: the departure "chalan" (manifest) — real spec given live: at the
// moment the driver starts today's run, the booking officer needs the
// full onboard-at-origin passenger list (manual + online, confirmed vs
// unconfirmed, cash collected) separated from riders booked to board
// further down the route (grouped by stop, not onboard yet). The
// origin itself is locked against new bookings for today once a run
// exists (place_ride_booking/record_manual_booking, same migration) —
// this page stays viewable at any time, before or after departure, so
// the officer can prepare it ahead of time too.
//
// No-show policy confirmed directly: always offer a next-bus transfer
// first (reuses the reschedule RPCs already built, pre-filled to the
// route's own next scheduled day), officer can still fall back to a
// plain cancel.
//
// 924: a real terminal-wise boarding + stop/master-challan workflow
// added on top of all of the above (kept exactly as it was). A bus
// with several terminal stops now gets: a per-terminal "stop desk"
// that boards/no-shows/alights passengers and submits one persisted
// closeout per stop, a Master Trip Challan rolling every stop's
// closeout up with driver advances/handovers into one net result, and
// real terminal-level staff scoping (a counter-assigned staff member's
// desk locks to their own terminal; an owner/admin can pick any stop).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Receipt, Users2, Wallet, ChevronRight, X, RotateCcw, Phone, MessageCircle, Send, Bus, MapPin,
  CheckCircle2, UserX, LogOut, ClipboardCheck, HandCoins,
} from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetStatusPill, FleetKpiRow } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { normalizePakPhone } from '@/lib/receiptExport'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { SeatPickerField } from '@/components/mobility/SeatPickerField'

type Direction = 'outbound' | 'return'

interface RouteOption { route_id: string; origin: string; destination: string; owner_name: string; vehicle_type: string | null; vehicle_number: string | null; vehicle_id: string; days_of_week: number[]; is_two_way: boolean }
interface Passenger {
  id: string; source: 'manual' | 'app'; passenger_name: string; passenger_mobile: string | null; seats: number; seat_numbers: number[] | null
  amount: number; payment_method: string | null; is_confirmed: boolean
  boarded_at: string | null; dropped_off_at: string | null; status: string; counter_id: string | null
}
interface Chalan {
  route_id: string; origin: string; destination: string; travel_date: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  run_started_at: string | null; run_ended_at: string | null
  onboard_now: Passenger[]; next_stops: { label: string; passengers: Passenger[] }[]
  total_confirmed_count: number; total_unconfirmed_count: number; cash_collected_pkr: number
  by_source: { source: 'manual' | 'app'; seats: number }[]
  by_counter: { counter_id: string | null; counter_name: string | null; city: string | null; seats: number }[]
}
interface StopRow {
  id: string; label: string; stop_order: number; counter_id: string | null
  counter_name: string | null; counter_city: string | null; arrival_time: string | null; departure_time: string | null
}
interface StopChallanRow {
  id: string; stop_id: string | null; stop_label: string | null; terminal_city: string | null; terminal_name: string | null
  expected_count: number; boarded_count: number; no_show_count: number
  cash_collected_pkr: number; digital_collected_pkr: number; driver_advance_pkr: number; other_cash_pkr: number
  note: string | null; closed_at: string
}
interface MasterChallan {
  route_id: string; travel_date: string; direction: Direction; origin: string; destination: string
  run_started_at: string | null; run_ended_at: string | null
  stop_challans: StopChallanRow[]; total_stops: number; closed_stops: number
  revenue_pkr: number; expenses_pkr: number; driver_advances_pkr: number; driver_handovers_pkr: number; driver_cash_float_pkr: number; net_result_pkr: number
  handovers: { id: string; amount_pkr: number; received_by_counter_id: string | null; counter_city: string | null; note: string | null; created_at: string }[]
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function today() { return new Date().toISOString().slice(0, 10) }

function nextScheduledDate(daysOfWeek: number[], afterDate: string): string {
  const d = new Date(afterDate + 'T00:00:00')
  for (let i = 1; i <= 14; i++) {
    const next = new Date(d); next.setDate(d.getDate() + i)
    if (daysOfWeek.includes(next.getDay())) return next.toISOString().slice(0, 10)
  }
  return afterDate
}

/** Small +/- count row — the "easy to enter" luggage input, composed into the existing free-text luggage note at boarding time. */
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

export default function FleetChalanPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [myCounterId, setMyCounterId] = useState<string | null>(null)
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [counters, setCounters] = useState<{ id: string; name: string | null; city: string }[]>([])
  const [routeId, setRouteId] = useState('')
  const [travelDate, setTravelDate] = useState(today())
  const [direction, setDirection] = useState<Direction>('outbound')
  const [chalan, setChalan] = useState<Chalan | null>(null)
  const [masterChallan, setMasterChallan] = useState<MasterChallan | null>(null)
  const [stops, setStops] = useState<StopRow[]>([])
  const [loadingChalan, setLoadingChalan] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [transferring, setTransferring] = useState<Passenger | null>(null)
  const [transferDate, setTransferDate] = useState('')
  const [transferSeats, setTransferSeats] = useState<number[]>([])
  const [transferTaken, setTransferTaken] = useState<number[]>([])
  const [vehicleSeating, setVehicleSeating] = useState<{ totalSeats: number; isVanKind: boolean; isSleeper: boolean } | null>(null)
  const [showMessageForm, setShowMessageForm] = useState(false)
  const [messageTitle, setMessageTitle] = useState('')
  const [messageBody, setMessageBody] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)

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

  // Driver handover
  const [showHandoverForm, setShowHandoverForm] = useState(false)
  const [handoverAmount, setHandoverAmount] = useState('')
  const [handoverCounterId, setHandoverCounterId] = useState('')
  const [handoverNote, setHandoverNote] = useState('')
  const [recordingHandover, setRecordingHandover] = useState(false)
  const [isAccountantBlocked, setIsAccountantBlocked] = useState(false)

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string; is_owner: boolean } | null
      setFleetId(f?.fleet_id ?? null)
      setIsOwner(!!f?.is_owner)
      if (f) {
        const { data: counterData } = await supabase.rpc('my_counter')
        setMyCounterId((counterData as { id: string } | null)?.id ?? null)

        // 2026-11-20: 926 — accountants are blocked from booking writes
        // (create/cancel/board/no-show/alight/close-stop) by default;
        // this is a UX convenience to hide actions that will just be
        // rejected server-side either way.
        const { data: ctx } = await supabase.rpc('my_fleet_staff_context', { p_fleet_id: f.fleet_id })
        const staffCtx = ctx as { role: string | null; bookings_unlocked: boolean } | null
        setIsAccountantBlocked(staffCtx?.role === 'accountant' && !staffCtx?.bookings_unlocked)

        const { data: sched } = await supabase.rpc('fleet_vehicle_schedule', { p_fleet_id: f.fleet_id })
        const rows = (sched ?? []) as { route_id: string; origin: string; destination: string; owner_name: string; vehicle_type: string | null; vehicle_number: string | null; vehicle_id: string; is_active: boolean }[]
        const active = rows.filter((r) => r.is_active)
        const opts: RouteOption[] = []
        for (const r of active) {
          const { data: vr } = await supabase.from('vehicle_routes').select('days_of_week, is_two_way').eq('id', r.route_id).single()
          opts.push({ route_id: r.route_id, origin: r.origin, destination: r.destination, owner_name: r.owner_name, vehicle_type: r.vehicle_type, vehicle_number: r.vehicle_number, vehicle_id: r.vehicle_id, days_of_week: vr?.days_of_week ?? [], is_two_way: !!vr?.is_two_way })
        }
        setRoutes(opts)
        if (opts.length > 0) setRouteId(opts[0].route_id)

        const { data: ctrs } = await supabase.from('fleet_counters').select('id, name, city').eq('fleet_id', f.fleet_id)
        setCounters((ctrs ?? []) as { id: string; name: string | null; city: string }[])
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // A route that isn't two-way has no return leg to show a tab for.
  useEffect(() => {
    const r = routes.find((x) => x.route_id === routeId)
    if (r && !r.is_two_way && direction !== 'outbound') setDirection('outbound')
  }, [routeId, routes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!routeId) { setStops([]); return }
    (async () => {
      const { data } = await supabase.from('route_stops')
        .select('id, label, stop_order, counter_id, arrival_time, departure_time, fleet_counters(name, city)')
        .eq('route_id', routeId).order('stop_order')
      const rows = ((data ?? []) as unknown as { id: string; label: string; stop_order: number; counter_id: string | null; arrival_time: string | null; departure_time: string | null; fleet_counters: { name: string | null; city: string } | null }[])
        .map((r) => ({
          id: r.id, label: r.label, stop_order: r.stop_order, counter_id: r.counter_id,
          counter_name: r.fleet_counters?.name ?? null, counter_city: r.fleet_counters?.city ?? null,
          arrival_time: r.arrival_time, departure_time: r.departure_time,
        }))
      setStops(rows)
    })()
  }, [routeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async (rid: string, date: string, dir: Direction) => {
    if (!rid) return
    setLoadingChalan(true)
    const [chalanRes, masterRes] = await Promise.all([
      supabase.rpc('route_departure_chalan', { p_route_id: rid, p_travel_date: date, p_direction: dir }),
      supabase.rpc('route_master_trip_challan', { p_route_id: rid, p_travel_date: date, p_direction: dir }),
    ])
    setLoadingChalan(false)
    if (chalanRes.error) toast.error(friendlyError(chalanRes.error)); else setChalan(chalanRes.data as Chalan)
    if (masterRes.error) toast.error(friendlyError(masterRes.error)); else setMasterChallan(masterRes.data as MasterChallan)
  }

  useEffect(() => { if (routeId) reload(routeId, travelDate, direction) }, [routeId, travelDate, direction]) // eslint-disable-line react-hooks/exhaustive-deps

  const removeUnconfirmed = async (p: Passenger) => {
    if (!confirm(t('mv.confirmCancelBookingHint'))) return
    setBusyId(p.id)
    const rpc = p.source === 'manual' ? 'cancel_manual_booking' : 'cancel_ride_booking'
    const params = p.source === 'manual' ? { p_id: p.id } : { p_booking_id: p.id, p_reason: t('mv.staffCancelledReason') }
    const { error } = await supabase.rpc(rpc, params)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.bookingCancelledToast'))
    reload(routeId, travelDate, direction)
  }

  const cancelConfirmed = async (p: Passenger) => {
    if (!confirm(t('mv.confirmNoShowCancelHint'))) return
    setBusyId(p.id)
    const rpc = p.source === 'manual' ? 'cancel_manual_booking' : 'cancel_ride_booking'
    const params = p.source === 'manual' ? { p_id: p.id } : { p_booking_id: p.id, p_reason: t('mv.noShowReason') }
    const { error } = await supabase.rpc(rpc, params)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.bookingCancelledToast'))
    reload(routeId, travelDate, direction)
  }

  const openTransfer = async (p: Passenger) => {
    const route = routes.find((r) => r.route_id === routeId)
    const suggested = route ? nextScheduledDate(route.days_of_week, travelDate) : travelDate
    setTransferring(p); setTransferDate(suggested); setTransferSeats([])
    if (route) {
      const { data: v } = await supabase.from('vehicles').select('total_seats, is_sleeper, category_id').eq('id', route.vehicle_id).single()
      const { data: vc } = v?.category_id ? await supabase.from('vehicle_categories').select('vehicle_kind').eq('id', v.category_id).single() : { data: null }
      setVehicleSeating(v ? { totalSeats: v.total_seats, isVanKind: vc?.vehicle_kind === 'van', isSleeper: v.is_sleeper } : null)
    }
  }

  useEffect(() => {
    if (!transferring || !vehicleSeating?.isVanKind || !transferDate) { setTransferTaken([]); return }
    supabase.rpc('route_seat_status', { p_route_id: routeId, p_travel_date: transferDate, p_direction: 'outbound' }).then(({ data }) => setTransferTaken((data as number[]) ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferring, transferDate])

  const confirmTransfer = async () => {
    if (!transferring || !transferDate) return
    if (vehicleSeating?.isVanKind && transferSeats.length !== transferring.seats) { toast.error(t('mv.pickASeatError')); return }
    setBusyId(transferring.id)
    const seatNumbers = vehicleSeating?.isVanKind ? transferSeats : null
    const rpc = transferring.source === 'manual' ? 'reschedule_manual_booking' : 'reschedule_ride_booking'
    const params = transferring.source === 'manual'
      ? { p_id: transferring.id, p_new_travel_date: transferDate, p_seat_numbers: seatNumbers }
      : { p_booking_id: transferring.id, p_new_travel_date: transferDate, p_seat_numbers: seatNumbers }
    const { error } = await supabase.rpc(rpc, params)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.noShowTransferredToast'))
    setTransferring(null)
    reload(routeId, travelDate, direction)
  }

  const sendMessage = async () => {
    if (!messageTitle.trim() || !messageBody.trim()) { toast.error(t('mv.messageRequiredError')); return }
    setSendingMessage(true)
    const { data, error } = await supabase.rpc('fleet_notify_route_riders', { p_route_id: routeId, p_travel_date: travelDate, p_title: messageTitle.trim(), p_body: messageBody.trim() })
    setSendingMessage(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.messageSentToast').replace('{n}', String(data ?? 0)))
    setShowMessageForm(false); setMessageTitle(''); setMessageBody('')
  }

  // 2026-11-20: 927 — same UX convenience as the Bookings page's
  // canManageCounter: pre-emptively grey the legacy onboard-now/
  // next-stop panels' own Cancel/No-show-transfer buttons for a
  // wrong-terminal staff member, instead of letting them click into
  // the (already correct) server-side rejection from 926.
  const canManageCounter = (rowCounterId: string | null) => isOwner || !myCounterId || myCounterId === rowCounterId

  // ─── Terminal stop desk ───────────────────────────────────────────
  const isLockedToOwnTerminal = !isOwner && !!myCounterId
  const sequencedStops = direction === 'return' ? [...stops].reverse() : stops
  const stopOptions: { key: string; label: string; counterId: string | null }[] = [
    { key: 'origin', label: `${t('mv.originStopOption')} · ${chalan?.origin ?? ''}`, counterId: null },
    ...sequencedStops.map((s) => ({ key: s.id, label: s.counter_name ? `${s.counter_name} · ${s.counter_city}` : s.label, counterId: s.counter_id })),
  ]
  const visibleStopOptions = isLockedToOwnTerminal
    ? stopOptions.filter((o) => o.counterId === myCounterId)
    : stopOptions

  useEffect(() => {
    if (visibleStopOptions.length === 0) return
    if (!visibleStopOptions.find((o) => o.key === selectedStopKey)) setSelectedStopKey(visibleStopOptions[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, isLockedToOwnTerminal, myCounterId])

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
    reload(routeId, travelDate, direction)
  }

  const noShowPassenger = async (p: Passenger) => {
    if (!confirm(t('mv.confirmMarkNoShowHint'))) return
    setBusyId(p.id)
    const { error } = await supabase.rpc('mark_manual_ticket_no_show', { p_id: p.id, p_reason: t('mv.noShowReason') })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.passengerNoShowToast'))
    reload(routeId, travelDate, direction)
  }

  const alightPassenger = async (p: Passenger) => {
    setBusyId(p.id)
    const { error } = await supabase.rpc('mark_manual_ticket_alighted', { p_id: p.id })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.passengerAlightedToast'))
    reload(routeId, travelDate, direction)
  }

  const closeStop = async () => {
    if (!routeId) return
    if (!confirm(t('mv.confirmCloseStopHint'))) return
    setClosing(true)
    const { error } = await supabase.rpc('close_route_stop_challan', {
      p_route_id: routeId, p_travel_date: travelDate, p_direction: direction,
      p_stop_id: isOriginSelected ? null : selectedStopKey,
      p_driver_advance_pkr: Number(advanceInput || 0), p_other_cash_pkr: Number(otherCashInput || 0), p_note: stopNoteInput.trim() || null,
    })
    setClosing(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.stopChallanCreatedToast'))
    setAdvanceInput('0'); setOtherCashInput('0'); setStopNoteInput('')
    reload(routeId, travelDate, direction)
  }

  const recordHandover = async () => {
    const amt = Number(handoverAmount || 0)
    if (!amt || amt <= 0) { toast.error(t('mv.enterRealAmountError')); return }
    setRecordingHandover(true)
    const { error } = await supabase.rpc('record_route_driver_handover', {
      p_route_id: routeId, p_travel_date: travelDate, p_direction: direction,
      p_amount_pkr: amt, p_received_by_counter_id: handoverCounterId || null, p_note: handoverNote.trim() || null,
    })
    setRecordingHandover(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.handoverRecordedToast'))
    setShowHandoverForm(false); setHandoverAmount(''); setHandoverCounterId(''); setHandoverNote('')
    reload(routeId, travelDate, direction)
  }

  const totalOnboardNow = () => {
    if (!chalan) return 0
    const all = [...chalan.onboard_now, ...chalan.next_stops.flatMap((g) => g.passengers)]
    return all.filter((p) => p.boarded_at && !p.dropped_off_at).length
  }

  const renderRow = (p: Passenger) => (
    <div key={`${p.source}-${p.id}`} className="px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{p.passenger_name}{p.passenger_mobile ? ` · ${p.passenger_mobile}` : ''}</p>
          <p className="font-sans text-[10.5px] text-[#94a3b8]">
            {p.source === 'manual' ? t('mv.sourceManualLabel') : t('mv.sourceOnlineLabel')} · {p.seats} {t('mv.seatsSuffix')}
            {p.seat_numbers && p.seat_numbers.length > 0 ? ` · #${p.seat_numbers.join(', #')}` : ''}
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-0.5">
          <p className="font-sans text-[13px] font-bold text-[#166534] ltr-num">₨{fmt(p.amount)}</p>
          <FleetStatusPill tone={p.is_confirmed ? 'green' : 'amber'}>
            {p.is_confirmed ? t('mv.confirmedLabel') : t('mv.unconfirmedLabel')}
          </FleetStatusPill>
        </div>
      </div>
      {p.passenger_mobile && (
        <div className="flex items-center gap-3 mt-1.5">
          <a href={`tel:${p.passenger_mobile}`} className="flex items-center gap-1 font-sans text-[10.5px] font-semibold text-[#64748b]"><Phone size={11} /> {t('vp.callBtn')}</a>
          <a href={`https://wa.me/${normalizePakPhone(p.passenger_mobile)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 font-sans text-[10.5px] font-semibold text-[#166534]"><MessageCircle size={11} /> WhatsApp</a>
        </div>
      )}
      {transferring?.id === p.id ? (
        <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex flex-col gap-2">
          <input type="date" value={transferDate} min={today()} onChange={(e) => setTransferDate(e.target.value)} className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
          {vehicleSeating?.isVanKind && (
            <SeatPickerField totalSeats={vehicleSeating.totalSeats} takenSeatNumbers={transferTaken} seatsNeeded={p.seats} selected={transferSeats} onChange={setTransferSeats} isSleeper={vehicleSeating.isSleeper} />
          )}
          <div className="flex gap-2">
            <button onClick={confirmTransfer} disabled={busyId === p.id} className="flex-1 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12px] font-bold cursor-pointer disabled:opacity-50">{t('mv.confirmTransferBtn')}</button>
            <button onClick={() => setTransferring(null)} className="flex-1 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
          </div>
        </div>
      ) : isAccountantBlocked ? (
        <p className="font-sans text-[11px] text-[#94a3b8] mt-2 pt-2 border-t border-[#f1f5f9]">{t('mv.accountantBookingsBlockedHint')}</p>
      ) : p.source === 'manual' && !canManageCounter(p.counter_id) ? (
        <p className="font-sans text-[11px] text-[#94a3b8] mt-2 pt-2 border-t border-[#f1f5f9]">{t('mv.cannotManageThisBookingHint')}</p>
      ) : (
        <div className="flex gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
          {p.is_confirmed ? (
            <>
              <button onClick={() => openTransfer(p)} disabled={busyId === p.id} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50"><RotateCcw size={11} /> {t('mv.noShowTransferBtn')}</button>
              <button onClick={() => cancelConfirmed(p)} disabled={busyId === p.id} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50"><X size={11} /> {t('action.cancel')}</button>
            </>
          ) : (
            <button onClick={() => removeUnconfirmed(p)} disabled={busyId === p.id} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50"><X size={11} /> {t('mv.removeBookingBtn')}</button>
          )}
        </div>
      )}
    </div>
  )

  const renderDeskRow = (p: Passenger) => {
    const isManual = p.source === 'manual'
    const boarded = !!p.boarded_at
    const alighted = !!p.dropped_off_at
    const noShow = p.status === 'no_show'
    const isBoardingThis = boardingFor === p.id
    return (
      <div key={`${p.source}-${p.id}`} className="px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{p.passenger_name}{p.passenger_mobile ? ` · ${p.passenger_mobile}` : ''}</p>
            <p className="font-sans text-[10.5px] text-[#94a3b8]">
              {p.source === 'manual' ? t('mv.sourceManualLabel') : t('mv.sourceOnlineLabel')} · {p.seats} {t('mv.seatsSuffix')}
              {p.seat_numbers && p.seat_numbers.length > 0 ? ` · #${p.seat_numbers.join(', #')}` : ''}
            </p>
          </div>
          <FleetStatusPill tone={noShow ? 'red' : alighted ? 'gray' : boarded ? 'green' : 'amber'}>
            {noShow ? t('mv.noShowLabel') : alighted ? t('mv.alightedLabel') : boarded ? t('mv.boardedLabel') : t('mv.awaitingBoardingLabel')}
          </FleetStatusPill>
        </div>
        {isManual && !noShow && isAccountantBlocked && (
          <p className="font-sans text-[11px] text-[#94a3b8] mt-2 pt-2 border-t border-[#f1f5f9]">{t('mv.accountantBookingsBlockedHint')}</p>
        )}
        {isManual && !noShow && !isAccountantBlocked && (
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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  const currentRoute = routes.find((r) => r.route_id === routeId)

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Receipt size={19} /> {t('mv.chalanHeading')}</h1>
      <p className="font-sans text-[11px] text-[#64748b] -mt-1">{t('mv.panelDesc.chalan')}</p>

      {/* Real bug reported live: the date input had no minimum width, so
          a long route name in the select (flex-1) squeezed it down to a
          sliver that clipped the shown date to "26" instead of the real
          value. shrink-0 + an explicit width keep it fully readable. */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select value={routeId} onChange={(e) => setRouteId(e.target.value)} className="flex-1 min-w-0 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] truncate">
          {routes.map((r) => <option key={r.route_id} value={r.route_id}>{r.vehicle_number || r.vehicle_type || r.owner_name} · {r.origin} → {r.destination}</option>)}
        </select>
        <input type="date" value={travelDate} onChange={(e) => setTravelDate(e.target.value)} className="shrink-0 w-full sm:w-[150px] px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
      </div>

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
          {masterChallan && (
            <FleetKpiRow>
              <FleetStat label={t('mv.bookedKpiLabel')} icon={<Users2 size={12} />} value={chalan.total_confirmed_count + chalan.total_unconfirmed_count} />
              <FleetStat label={t('mv.onboardKpiLabel')} icon={<Bus size={12} />} value={totalOnboardNow()} valueClassName="text-[#166534]" />
              <FleetStat label={t('mv.noShowKpiLabel')} icon={<UserX size={12} />} value={masterChallan.stop_challans.reduce((a, sc) => a + sc.no_show_count, 0)} valueClassName="text-[#b91c1c]" />
              <FleetStat label={t('mv.netResultLabel')} icon={<Wallet size={12} />} value={`₨${fmt(masterChallan.net_result_pkr)}`} valueClassName={masterChallan.net_result_pkr >= 0 ? 'text-[#166534]' : 'text-[#b91c1c]'} />
            </FleetKpiRow>
          )}

          <FleetPanel>
            <FleetPanelHead icon={<Bus size={14} />} title={<span className="ltr-num">{chalan.vehicle_number || chalan.vehicle_type}</span>}
              description={`${chalan.vehicle_type} · ${chalan.owner_name} · ${chalan.origin} → ${chalan.destination}`}
              action={<FleetStatusPill tone={chalan.run_started_at ? 'green' : 'gray'}>{chalan.run_started_at ? t('mv.chalanDepartedLabel') : t('mv.chalanNotDepartedLabel')}</FleetStatusPill>} />
            <FleetPanelBody className="p-2.5 grid grid-cols-3 gap-2">
              <FleetStat label={t('mv.confirmedLabel')} icon={<Users2 size={12} />} value={chalan.total_confirmed_count} />
              <FleetStat label={t('mv.unconfirmedLabel')} icon={<Users2 size={12} />} value={chalan.total_unconfirmed_count} valueClassName="text-[#92400e]" />
              <FleetStat label={t('mv.cashLabel')} icon={<Wallet size={12} />} value={`₨${fmt(chalan.cash_collected_pkr)}`} valueClassName="text-[#1e293b]" />
            </FleetPanelBody>
          </FleetPanel>

          {/* 924: ordered stop sequence as a real terminal timeline —
              which terminal, when it's scheduled, and whether its stop
              challan has been closed yet. Tap any stop to open its
              desk below. */}
          <FleetPanel>
            <FleetPanelHead icon={<MapPin size={14} />} title={t('mv.stopSequenceHeading')} description={t('mv.stopSequenceHint')} />
            <FleetPanelBody className="flex flex-col gap-1.5 p-2.5">
              <button onClick={() => setSelectedStopKey('origin')} className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-start ${selectedStopKey === 'origin' ? 'bg-[#F0FDF4] border border-[#166534]' : 'bg-[#F9F9F6] border border-transparent'}`}>
                <span className="font-sans text-[12px] font-semibold text-[#1e293b]">{t('mv.originStopOption')} · {chalan.origin}</span>
                <FleetStatusPill tone={masterChallan?.stop_challans.find((sc) => sc.stop_id === null) ? 'green' : 'gray'}>
                  {masterChallan?.stop_challans.find((sc) => sc.stop_id === null) ? t('mv.closedLabel') : t('mv.pendingLabel')}
                </FleetStatusPill>
              </button>
              {sequencedStops.map((s) => {
                const closed = !!masterChallan?.stop_challans.find((sc) => sc.stop_id === s.id)
                return (
                  <button key={s.id} onClick={() => setSelectedStopKey(s.id)} className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-start ${selectedStopKey === s.id ? 'bg-[#F0FDF4] border border-[#166534]' : 'bg-[#F9F9F6] border border-transparent'}`}>
                    <div className="min-w-0">
                      <p className="font-sans text-[12px] font-semibold text-[#1e293b] truncate">{s.counter_name ? `${s.counter_name} · ${s.counter_city}` : s.label}</p>
                      {(s.arrival_time || s.departure_time) && (
                        <p className="font-sans text-[10px] text-[#94a3b8] ltr-num">{s.arrival_time ? s.arrival_time.slice(0, 5) : ''}{s.departure_time ? ` – ${s.departure_time.slice(0, 5)}` : ''}</p>
                      )}
                    </div>
                    <FleetStatusPill tone={closed ? 'green' : 'gray'}>{closed ? t('mv.closedLabel') : t('mv.pendingLabel')}</FleetStatusPill>
                  </button>
                )
              })}
            </FleetPanelBody>
          </FleetPanel>

          {/* 924: the real terminal-desk workflow — board/no-show/alight
              passengers at the selected stop, then close boarding and
              submit one persisted stop challan. A counter-assigned
              staff member's picker is locked to their own terminal. */}
          <FleetPanel>
            <FleetPanelHead icon={<ClipboardCheck size={14} />} title={t('mv.terminalStopDeskHeading')}
              description={isLockedToOwnTerminal ? t('mv.yourTerminalHint') : t('mv.panelDesc.terminalDesk')} />
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
                  {isAccountantBlocked ? (
                    <p className="font-sans text-[11.5px] text-[#94a3b8] text-center py-2">{t('mv.accountantBookingsBlockedHint')}</p>
                  ) : alreadyClosed ? (
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

          {/* 2026-11-17: real gap confirmed by deep audit — no way to
              see how many seats came from online bookings vs. a
              counter vs. the driver's own walk-up sales, or which
              terminal sold them. Both already computed server-side
              (899), just never surfaced before. */}
          {(chalan.by_source.length > 0 || chalan.by_counter.length > 0) && (
            <FleetPanel>
              <FleetPanelHead icon={<Users2 size={14} />} title={t('mv.bookingChannelsHeading')} />
              <FleetPanelBody className="flex flex-col gap-2 p-2.5">
                {chalan.by_source.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap">
                    {chalan.by_source.map((s) => (
                      <span key={s.source} className="px-2.5 py-1 rounded-lg bg-[#F9F9F6] border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#334155]">
                        {s.source === 'manual' ? t('mv.sourceManualLabel') : t('mv.sourceOnlineLabel')}: <span className="ltr-num font-bold text-[#166534]">{s.seats}</span>
                      </span>
                    ))}
                  </div>
                )}
                {chalan.by_counter.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="font-sans text-[9.5px] font-bold text-[#94a3b8] uppercase tracking-[0.06em]">{t('mv.byTerminalLabel')}</p>
                    {chalan.by_counter.map((c, i) => (
                      <div key={c.counter_id ?? `walkup-${i}`} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#F9F9F6]">
                        <span className="font-sans text-[12px] text-[#1e293b]">{c.counter_name ? `${c.counter_name} · ${c.city}` : t('mv.driverWalkUpLabel')}</span>
                        <span className="font-sans text-[12px] font-bold text-[#166534] ltr-num">{c.seats}</span>
                      </div>
                    ))}
                  </div>
                )}
              </FleetPanelBody>
            </FleetPanel>
          )}

          {showMessageForm ? (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5 flex flex-col gap-2">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b]">{t('mv.messageRidersHeading')}</p>
              <input value={messageTitle} onChange={(e) => setMessageTitle(e.target.value)} placeholder={t('mv.messageTitlePlaceholder')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              <textarea value={messageBody} onChange={(e) => setMessageBody(e.target.value)} rows={2} placeholder={t('mv.messageBodyPlaceholder')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              <div className="flex gap-2">
                <button onClick={sendMessage} disabled={sendingMessage} className="flex-1 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{sendingMessage ? t('action.loading') : t('mv.sendMessageBtn')}</button>
                <button onClick={() => setShowMessageForm(false)} className="flex-1 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowMessageForm(true)} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer">
              <Send size={13} /> {t('mv.messageRidersHeading')}
            </button>
          )}

          <FleetPanel>
            <FleetPanelHead icon={<Users2 size={14} />} title={t('mv.onboardNowHeading')}
              action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{chalan.onboard_now.length}</span>} />
            {chalan.onboard_now.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8] text-center py-5">{t('mv.noBookingsFoundHint')}</p>
            ) : (
              <div className="flex flex-col divide-y divide-[#f1f5f9]">{chalan.onboard_now.map(renderRow)}</div>
            )}
          </FleetPanel>

          {chalan.next_stops.map((grp) => (
            <FleetPanel key={grp.label}>
              <FleetPanelHead icon={<MapPin size={14} />} title={<span className="flex items-center gap-1"><ChevronRight size={12} className={isUrdu ? 'rotate-180' : ''} /> {t('mv.nextStopLabel')}: {grp.label}</span>}
                action={<span className="px-2 py-0.5 rounded-full bg-[#F1F5F9] text-[#64748b] font-sans text-[10px] font-bold ltr-num">{grp.passengers.length}</span>} />
              <div className="flex flex-col divide-y divide-[#f1f5f9]">{grp.passengers.map(renderRow)}</div>
            </FleetPanel>
          ))}

          {/* 924: the Master Trip Challan — every stop's closeout rolled
              into one record, plus driver advances/handovers and the
              trip's real net result. */}
          {masterChallan && (
            <FleetPanel>
              <FleetPanelHead icon={<ClipboardCheck size={14} />} title={t('mv.masterChallanHeading')}
                description={t('mv.masterChallanHint').replace('{closed}', String(masterChallan.closed_stops)).replace('{total}', String(masterChallan.total_stops))} />
              <FleetPanelBody className="flex flex-col gap-2 p-2.5">
                {masterChallan.stop_challans.length === 0 ? (
                  <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.noStopChallansYetHint')}</p>
                ) : (
                  <div className="flex flex-col divide-y divide-[#f1f5f9]">
                    {masterChallan.stop_challans.map((sc) => (
                      <div key={sc.id} className="py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-sans text-[12px] font-bold text-[#1e293b]">{sc.terminal_name ? `${sc.terminal_name} · ${sc.terminal_city}` : sc.stop_label ?? t('mv.originStopOption')}</p>
                          <FleetStatusPill tone="green">{t('mv.closedLabel')}</FleetStatusPill>
                        </div>
                        <p className="font-sans text-[10.5px] text-[#64748b] mt-1">
                          {t('mv.expectedLabel')} {sc.expected_count} · {t('mv.boardedLabel')} {sc.boarded_count} · {t('mv.noShowLabel')} {sc.no_show_count}
                        </p>
                        <p className="font-sans text-[10.5px] text-[#64748b] ltr-num">
                          ₨{fmt(sc.cash_collected_pkr)} {t('mv.cashShortLabel')} · ₨{fmt(sc.digital_collected_pkr)} {t('mv.digitalLabel')}
                          {sc.driver_advance_pkr > 0 ? ` · ₨${fmt(sc.driver_advance_pkr)} ${t('mv.driverAdvanceLabel')}` : ''}
                        </p>
                        {sc.note && <p className="font-sans text-[10.5px] text-[#94a3b8] italic mt-0.5">{sc.note}</p>}
                      </div>
                    ))}
                  </div>
                )}
                <FleetKpiRow className="mt-1">
                  <FleetStat label={t('mv.driverAdvancesLabel')} value={`₨${fmt(masterChallan.driver_advances_pkr)}`} valueClassName="text-[#1e293b]" />
                  <FleetStat label={t('mv.driverHandoversLabel')} value={`₨${fmt(masterChallan.driver_handovers_pkr)}`} valueClassName="text-[#1e293b]" />
                  <FleetStat label={t('mv.driverCashFloatLabel')} value={`₨${fmt(masterChallan.driver_cash_float_pkr)}`} valueClassName={masterChallan.driver_cash_float_pkr > 0 ? 'text-[#b45309]' : 'text-[#166534]'} />
                  <FleetStat label={t('mv.netResultLabel')} value={`₨${fmt(masterChallan.net_result_pkr)}`} valueClassName={masterChallan.net_result_pkr >= 0 ? 'text-[#166534]' : 'text-[#b91c1c]'} />
                </FleetKpiRow>
                {isOwner && (
                  showHandoverForm ? (
                    <div className="flex flex-col gap-2 mt-1 pt-2 border-t border-[#f1f5f9]">
                      <input type="number" min="0" value={handoverAmount} onChange={(e) => setHandoverAmount(e.target.value)} placeholder={t('mv.handoverAmountLabel')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                      <select value={handoverCounterId} onChange={(e) => setHandoverCounterId(e.target.value)} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                        <option value="">{t('mv.handoverReceivedAtLabel')}</option>
                        {counters.map((c) => <option key={c.id} value={c.id}>{c.name ? `${c.name} · ${c.city}` : c.city}</option>)}
                      </select>
                      <input value={handoverNote} onChange={(e) => setHandoverNote(e.target.value)} placeholder={t('mv.handoverNoteLabel')} className="px-2.5 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                      <div className="flex gap-2">
                        <button onClick={recordHandover} disabled={recordingHandover} className="flex-1 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{recordingHandover ? t('action.loading') : t('mv.recordHandoverBtn')}</button>
                        <button onClick={() => setShowHandoverForm(false)} className="flex-1 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setShowHandoverForm(true)} className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-[#e5e2d0] font-sans text-[12px] font-semibold text-[#166534] cursor-pointer mt-1">
                      <HandCoins size={13} /> {t('mv.recordHandoverBtn')}
                    </button>
                  )
                )}
              </FleetPanelBody>
            </FleetPanel>
          )}
        </>
      )}

      <Link href="/portal/fleet" className="font-sans text-[12px] font-semibold text-[#166534] text-center underline underline-offset-2 mt-2">{t('mv.backToDashboardBtn')}</Link>
    </div>
  )
}
