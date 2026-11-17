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

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Receipt, Users2, Wallet, ChevronRight, X, RotateCcw, Phone, MessageCircle, Send, Bus, MapPin } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetStatusPill } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { normalizePakPhone } from '@/lib/receiptExport'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { SeatPickerField } from '@/components/mobility/SeatPickerField'

interface RouteOption { route_id: string; origin: string; destination: string; owner_name: string; vehicle_type: string | null; vehicle_number: string | null; vehicle_id: string; days_of_week: number[] }
interface Passenger { id: string; source: 'manual' | 'app'; passenger_name: string; passenger_mobile: string | null; seats: number; seat_numbers: number[] | null; amount: number; payment_method: string | null; is_confirmed: boolean }
interface Chalan {
  route_id: string; origin: string; destination: string; travel_date: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  run_started_at: string | null; run_ended_at: string | null
  onboard_now: Passenger[]; next_stops: { label: string; passengers: Passenger[] }[]
  total_confirmed_count: number; total_unconfirmed_count: number; cash_collected_pkr: number
  by_source: { source: 'manual' | 'app'; seats: number }[]
  by_counter: { counter_id: string | null; counter_name: string | null; city: string | null; seats: number }[]
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

export default function FleetChalanPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [routeId, setRouteId] = useState('')
  const [travelDate, setTravelDate] = useState(today())
  const [chalan, setChalan] = useState<Chalan | null>(null)
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

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      setFleetId(f?.fleet_id ?? null)
      if (f) {
        const { data: sched } = await supabase.rpc('fleet_vehicle_schedule', { p_fleet_id: f.fleet_id })
        const rows = (sched ?? []) as { route_id: string; origin: string; destination: string; owner_name: string; vehicle_type: string | null; vehicle_number: string | null; vehicle_id: string; is_active: boolean }[]
        const active = rows.filter((r) => r.is_active)
        const opts: RouteOption[] = []
        for (const r of active) {
          const { data: vr } = await supabase.from('vehicle_routes').select('days_of_week').eq('id', r.route_id).single()
          opts.push({ route_id: r.route_id, origin: r.origin, destination: r.destination, owner_name: r.owner_name, vehicle_type: r.vehicle_type, vehicle_number: r.vehicle_number, vehicle_id: r.vehicle_id, days_of_week: vr?.days_of_week ?? [] })
        }
        setRoutes(opts)
        if (opts.length > 0) setRouteId(opts[0].route_id)
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const loadChalan = async (rid: string, date: string) => {
    if (!rid) return
    setLoadingChalan(true)
    const { data, error } = await supabase.rpc('route_departure_chalan', { p_route_id: rid, p_travel_date: date })
    setLoadingChalan(false)
    if (error) { toast.error(friendlyError(error)); return }
    setChalan(data as Chalan)
  }

  useEffect(() => { if (routeId) loadChalan(routeId, travelDate) }, [routeId, travelDate]) // eslint-disable-line react-hooks/exhaustive-deps

  const removeUnconfirmed = async (p: Passenger) => {
    if (!confirm(t('mv.confirmCancelBookingHint'))) return
    setBusyId(p.id)
    const rpc = p.source === 'manual' ? 'cancel_manual_booking' : 'cancel_ride_booking'
    const params = p.source === 'manual' ? { p_id: p.id } : { p_booking_id: p.id, p_reason: t('mv.staffCancelledReason') }
    const { error } = await supabase.rpc(rpc, params)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.bookingCancelledToast'))
    loadChalan(routeId, travelDate)
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
    loadChalan(routeId, travelDate)
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
    loadChalan(routeId, travelDate)
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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

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

      {loadingChalan ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : !chalan ? (
        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-8">{t('mv.noScheduleYetHint')}</p>
      ) : (
        <>
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
        </>
      )}

      <Link href="/portal/fleet" className="font-sans text-[12px] font-semibold text-[#166534] text-center underline underline-offset-2 mt-2">{t('mv.backToDashboardBtn')}</Link>
    </div>
  )
}
