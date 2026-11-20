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

import { useEffect, useState } from 'react'
import {
  Bus, MapPin, Wallet, Plus, Clock, LogIn, LogOut, CheckCircle2, UserX, ClipboardCheck,
  HandCoins, Users2, Banknote, TrendingUp, MessageCircleQuestion,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import {
  FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetFormGrid, FleetFormField, FleetStatusPill, FleetKpiRow,
} from '@/components/portal/FleetPanel'
import { DriverShuffleFloatingButton } from '@/components/mobility/DriverShuffleFloatingButton'

type Direction = 'outbound' | 'return'
type Tab = 'home' | 'trip' | 'cash' | 'pay'

interface MyRoute {
  id: string; origin: string; destination: string; departure_time: string | null; is_two_way: boolean
  days_of_week: number[]; vehicle_id: string; vehicle_number: string | null; vehicle_type: string | null
  fleet_id: string; is_co_driver: boolean
}
interface StopRow { id: string; label: string; stop_order: number; counter_id: string | null; counter_name: string | null; counter_city: string | null }
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

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function today() { return new Date().toISOString().slice(0, 10) }

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
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('home')
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [myCounterId, setMyCounterId] = useState<string | null>(null)
  const [routes, setRoutes] = useState<MyRoute[]>([])
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
    if (myRoutes.length > 0 && !routeId) setRouteId(myRoutes[0].id)

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
    if (!routeId) { setStops([]); return }
    (async () => {
      const { data } = await supabase.from('route_stops')
        .select('id, label, stop_order, counter_id, fleet_counters(name, city)')
        .eq('route_id', routeId).order('stop_order')
      const rows = ((data ?? []) as unknown as { id: string; label: string; stop_order: number; counter_id: string | null; fleet_counters: { name: string | null; city: string } | null }[])
        .map((r) => ({ id: r.id, label: r.label, stop_order: r.stop_order, counter_id: r.counter_id, counter_name: r.fleet_counters?.name ?? null, counter_city: r.fleet_counters?.city ?? null }))
      setStops(rows)
    })()
  }, [routeId]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const visibleStopOptions = isLockedToOwnTerminal ? stopOptions.filter((o) => o.counterId === myCounterId) : stopOptions

  useEffect(() => {
    if (visibleStopOptions.length === 0) return
    if (!visibleStopOptions.find((o) => o.key === selectedStopKey)) setSelectedStopKey(visibleStopOptions[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, myCounterId])

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
    setSavingWalkup(true)
    // Real gap found live: this always sold from the origin (board_stop_id
    // omitted = NULL = implicit origin), which record_manual_booking (926)
    // locks once the bus has departed today — exactly the case for a
    // driver selling a seat mid-route. Pass the currently selected stop
    // desk terminal so a walk-up sale boards where the driver actually is.
    const { error } = await supabase.rpc('record_manual_booking', {
      p_route_id: routeId, p_travel_date: today(), p_seats: Number(walkupSeats) || 1,
      p_passenger_name: walkupName, p_total_amount_pkr: Number(walkupAmount), p_payment_method: 'cash',
      p_board_stop_id: isOriginSelected ? null : selectedStopKey,
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
