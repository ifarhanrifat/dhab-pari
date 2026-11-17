'use client'

// 860: Fleet Dashboard tab — the redesign's main landing page. Used to be
// everything (P&L, expenses, counters, staff, invites) stacked on one
// long page at my-vehicle/fleet/page.tsx; that content is now split
// across the 5 FleetBottomNav tabs, and this page keeps only what
// belongs on a "what's happening right now" overview: fleet creation
// (unchanged, 853), the per-vehicle schedule cards, a condensed P&L
// summary, the fleet map, and quick links to the occasional-use owner
// tools (Staff, Counters, Invite a driver, Fare Requests) — mirroring
// how ShopBottomNav keeps staff/purchase off its own tab bar.
//
// 867: real reference shared live (EasyBus "Schedule" page) — a date
// picker to view any day, status filter chips, and per-row Edit/Close/
// Relaunch actions. Edit and Close already existed as real RPCs
// (update_vehicle_route_schedule/close_vehicle_route, driver-side only
// until now); Relaunch (reopen_vehicle_route) was genuinely missing —
// once a route was closed there was no way back except re-creating it
// from scratch.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Users2, Map as MapIcon, UserPlus, Building2, UserCog, Receipt, ChevronRight, Bus, List, Ticket, CheckCircle2, Plus, Pencil, Trash2, RotateCcw, IdCard, ShieldAlert, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat } from '@/components/portal/FleetPanel'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface ScheduleCard {
  vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  route_id: string; origin: string; destination: string; service_code: string | null
  is_active: boolean; departure_time: string | null; return_departure_time: string | null; return_wait_minutes: number | null
  is_two_way: boolean; days_of_week: number[]; return_days_of_week: number[] | null; runs_today: boolean; state: string
  current_driver_name: string; covered_by_substitute: boolean
  delay_minutes: number | null; delay_note: string | null
}
interface DepartureStats { bookings_today_count: number; runs_scheduled: number; runs_departed: number }
interface FleetVehicleSummary {
  vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  today_profit_pkr: number; month_profit_pkr: number; wallet_balance_pkr: number
}
interface LivePin { owner_name: string; vehicle_type: string; context: string; lat: number; lng: number }
interface DocAlert { vehicle_id: string; owner_name: string; vehicle_number: string | null; document_type: string; expiry_date: string; days_remaining: number; status: 'expired' | 'expiring_soon' }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtTime(t: string | null) {
  if (!t) return null
  const [h, m] = t.split(':')
  const hour = Number(h); const ampm = hour >= 12 ? 'PM' : 'AM'; const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${m} ${ampm}`
}
function today() { return new Date().toISOString().slice(0, 10) }
// 2026-11-17: real complaint confirmed live — there was no way to tell
// from the schedule list whether a route returns on a different day
// without opening its edit form. days_of_week/return_days_of_week
// already existed on every ScheduleCard; this just surfaces them.
function formatDays(days: number[] | null | undefined, t: (k: string) => string): string {
  if (!days || days.length === 0) return ''
  if (days.length === 7) return t('mv.dailyLabel')
  return [...days].sort().map((d) => t(`mv.dayShort.${d}`)).join(' · ')
}

const STATE_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  not_scheduled_today: { label: 'mv.scheduleNotScheduledToday', bg: '#F1F5F9', fg: '#94a3b8' },
  not_started: { label: 'mv.scheduleNotStarted', bg: '#F1F5F9', fg: '#64748b' },
  outbound_in_progress: { label: 'mv.scheduleOutboundInProgress', bg: '#EFF6FF', fg: '#1d4ed8' },
  waiting_at_destination: { label: 'mv.scheduleWaitingAtDestination', bg: '#FFFBEB', fg: '#b45309' },
  return_in_progress: { label: 'mv.scheduleReturnInProgress', bg: '#EFF6FF', fg: '#1d4ed8' },
  completed_today: { label: 'mv.scheduleCompletedToday', bg: '#F0FDF4', fg: '#166534' },
  closed: { label: 'mv.scheduleClosedLabel', bg: '#FEF2F2', fg: '#b91c1c' },
}

const FILTER_CHIPS: { key: string; label: string; states?: string[] }[] = [
  { key: 'all', label: 'mv.filterAll' },
  { key: 'scheduled', label: 'mv.filterScheduled', states: ['not_started', 'not_scheduled_today'] },
  { key: 'on_the_way', label: 'mv.filterOnTheWay', states: ['outbound_in_progress', 'waiting_at_destination', 'return_in_progress'] },
  { key: 'completed', label: 'mv.filterCompleted', states: ['completed_today'] },
  { key: 'closed', label: 'mv.filterClosed', states: ['closed'] },
]

export default function FleetDashboardPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [fleetName, setFleetName] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [newFleetName, setNewFleetName] = useState('')
  const [creating, setCreating] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleCard[]>([])
  const [pl, setPl] = useState<{ vehicles: FleetVehicleSummary[]; fleet_today_profit_pkr: number; fleet_month_profit_pkr: number } | null>(null)
  const [livePins, setLivePins] = useState<LivePin[]>([])
  const [view, setView] = useState<'list' | 'map'>('list')
  const [stats, setStats] = useState<DepartureStats | null>(null)
  const [docAlerts, setDocAlerts] = useState<DocAlert[]>([])
  const [photoByVehicle, setPhotoByVehicle] = useState<Record<string, string | null>>({})
  const [scheduleDate, setScheduleDate] = useState(today())
  const [filter, setFilter] = useState('all')
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null)
  const [editDepartureTime, setEditDepartureTime] = useState('')
  const [editReturnTime, setEditReturnTime] = useState('')
  const [editIsTwoWay, setEditIsTwoWay] = useState(false)
  const [editReturnWaitMinutes, setEditReturnWaitMinutes] = useState(300)
  const [editDays, setEditDays] = useState<number[]>([])
  const [editReturnOnDifferentDays, setEditReturnOnDifferentDays] = useState(false)
  const [editReturnDays, setEditReturnDays] = useState<number[]>([])
  const [savingEdit, setSavingEdit] = useState(false)
  const [busyRouteId, setBusyRouteId] = useState<string | null>(null)
  const [delayRouteId, setDelayRouteId] = useState<string | null>(null)
  const [delayMinutesInput, setDelayMinutesInput] = useState('')
  const [delayNoteInput, setDelayNoteInput] = useState('')
  const [savingDelay, setSavingDelay] = useState(false)

  const loadSchedule = async (fid: string, date: string) => {
    const { data: sched } = await supabase.rpc('fleet_vehicle_schedule', { p_fleet_id: fid, p_date: date })
    const sc = (sched ?? []) as ScheduleCard[]
    setSchedule(sc)
    const uniqueVehicleIds = Array.from(new Set(sc.map((s) => s.vehicle_id)))
    Promise.all(uniqueVehicleIds.map((id) => supabase.rpc('driver_photo_for_vehicle', { p_vehicle_id: id }).then(({ data }) => [id, data as string | null] as const)))
      .then((pairs) => setPhotoByVehicle(Object.fromEntries(pairs)))
  }

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; name: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setFleetName(f?.name ?? '')
    setIsOwner(f?.is_owner ?? false)
    if (f) {
      const [{ data: plData }, { data: statsData }, { data: docData }] = await Promise.all([
        supabase.rpc('fleet_dashboard_summary'),
        supabase.rpc('fleet_departure_stats', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_document_alerts', { p_fleet_id: f.fleet_id }),
        loadSchedule(f.fleet_id, scheduleDate),
      ])
      setPl(plData as typeof pl)
      setStats(statsData as DepartureStats)
      setDocAlerts((docData ?? []) as DocAlert[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (!fleetId || loading) return
    loadSchedule(fleetId, scheduleDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleDate])

  const createFleet = async () => {
    if (!newFleetName.trim()) { toast.error(t('mv.fleetNameRequiredError')); return }
    setCreating(true)
    const { error } = await supabase.rpc('create_my_fleet', { p_name: newFleetName })
    setCreating(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.fleetCreatedToast'))
    setNewFleetName('')
    load()
  }

  const switchToMap = async () => {
    setView('map')
    if (!fleetId) return
    const { data, error } = await supabase.rpc('fleet_vehicle_locations', { p_fleet_id: fleetId })
    if (error) { toast.error(friendlyError(error)); return }
    setLivePins((data ?? []) as LivePin[])
  }

  const openEdit = (s: ScheduleCard) => {
    setEditingRouteId(s.route_id)
    setEditDepartureTime(s.departure_time ?? '')
    setEditReturnTime(s.return_departure_time ?? '')
    setEditIsTwoWay(s.is_two_way)
    setEditReturnWaitMinutes(s.return_wait_minutes ?? 300)
    setEditDays(s.days_of_week ?? [])
    setEditReturnOnDifferentDays(!!s.return_days_of_week?.length)
    setEditReturnDays(s.return_days_of_week ?? s.days_of_week ?? [])
  }
  const toggleEditDay = (d: number) => setEditDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort())
  const toggleEditReturnDay = (d: number) => setEditReturnDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort())

  const saveEdit = async (s: ScheduleCard) => {
    if (editDays.length === 0) { toast.error(t('mv.pickAtLeastOneDayError')); return }
    if (editIsTwoWay && editReturnOnDifferentDays && editReturnDays.length === 0) { toast.error(t('mv.pickAtLeastOneReturnDayError')); return }
    setSavingEdit(true)
    const { error } = await supabase.rpc('update_vehicle_route_schedule', {
      p_route_id: s.route_id, p_departure_time: editDepartureTime || null, p_days_of_week: editDays,
      p_return_departure_time: editIsTwoWay ? (editReturnTime || null) : null, p_is_two_way: editIsTwoWay, p_return_wait_minutes: editIsTwoWay ? editReturnWaitMinutes : null,
      p_return_days_of_week: editIsTwoWay && editReturnOnDifferentDays ? editReturnDays : null,
    })
    setSavingEdit(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.scheduleUpdatedToast'))
    setEditingRouteId(null)
    if (fleetId) loadSchedule(fleetId, scheduleDate)
  }

  const closeRoute = async (s: ScheduleCard) => {
    if (!confirm(t('mp.confirmCloseRouteHint'))) return
    setBusyRouteId(s.route_id)
    const { error } = await supabase.rpc('close_vehicle_route', { p_route_id: s.route_id, p_reason: t('mv.staffCancelledReason') })
    setBusyRouteId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.routeClosedToast'))
    if (fleetId) loadSchedule(fleetId, scheduleDate)
  }

  const relaunchRoute = async (s: ScheduleCard) => {
    setBusyRouteId(s.route_id)
    const { error } = await supabase.rpc('reopen_vehicle_route', { p_route_id: s.route_id })
    setBusyRouteId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.routeRelaunchedToast'))
    if (fleetId) loadSchedule(fleetId, scheduleDate)
  }

  // 2026-11-17: real gap confirmed by deep audit — no "delayed"
  // concept existed at all, and no way for a booking officer (not
  // just the driver) to set it. This is the officer-facing surface
  // that answers "where does the booking officer change this."
  const openDelay = (s: ScheduleCard) => {
    setDelayRouteId(s.route_id)
    setDelayMinutesInput(s.delay_minutes != null ? String(s.delay_minutes) : '')
    setDelayNoteInput(s.delay_note ?? '')
  }
  const saveDelay = async (s: ScheduleCard) => {
    setSavingDelay(true)
    const direction = s.state === 'return_in_progress' ? 'return' : 'outbound'
    const { error } = await supabase.rpc('set_route_day_delay', {
      p_route_id: s.route_id, p_travel_date: scheduleDate, p_direction: direction,
      p_delay_minutes: delayMinutesInput ? Number(delayMinutesInput) : null, p_note: delayNoteInput || null,
    })
    setSavingDelay(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.delayUpdatedToast'))
    setDelayRouteId(null)
    if (fleetId) loadSchedule(fleetId, scheduleDate)
  }
  const clearDelay = async (s: ScheduleCard) => {
    setSavingDelay(true)
    const direction = s.state === 'return_in_progress' ? 'return' : 'outbound'
    const { error } = await supabase.rpc('set_route_day_delay', { p_route_id: s.route_id, p_travel_date: scheduleDate, p_direction: direction, p_delay_minutes: null })
    setSavingDelay(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.delayClearedToast'))
    if (fleetId) loadSchedule(fleetId, scheduleDate)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  if (!fleetId) {
    return (
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <p className="font-sans text-[13px] text-[#64748b] mb-3">{t('mv.noFleetYetHint')}</p>
        <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fleetNameLabel')}</label>
        <input value={newFleetName} onChange={(e) => setNewFleetName(e.target.value)} placeholder={t('mv.fleetNamePlaceholder')}
          className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5" />
        <button onClick={createFleet} disabled={creating} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
          {creating ? t('action.loading') : t('mv.createFleetBtn')}
        </button>
      </div>
    )
  }

  const filterDef = FILTER_CHIPS.find((f) => f.key === filter)
  const filtered = filter === 'all' ? schedule
    : filter === 'closed' ? schedule.filter((s) => !s.is_active)
    : schedule.filter((s) => s.is_active && filterDef?.states?.includes(s.state))
  const delayedCount = schedule.filter((s) => s.is_active && s.delay_minutes != null).length

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Users2 size={19} /> {fleetName}</h1>

      {/* 2026-11-16: unified into one SAFAR-style stat grid (icon chip,
          uppercase label, big bold value, muted footnote, same shell
          for every tile) — previously two visually different rows
          (plain white cards here, green cards for P&L below) for data
          that's conceptually the same "today's operational position"
          SAFAR's own dashboard groups into one 4-card row. Pure visual
          pass: still fleet_departure_stats/fleet P&L, no new RPCs. */}
      {stats && (
        <div className="grid grid-cols-2 gap-2">
          <FleetStat label={t('mv.statBookingsTodayLabel')} icon={<Ticket size={12} />} value={stats.bookings_today_count} />
          {/* 2026-11-17: design-first pass from the SAFAR mockup's "Active
              buses on road" stat — its on-time/delayed/stopped footnote
              is real, useful context a bare X/Y count didn't have.
              dhab-pari has no "stopped/broken down" concept, so that
              part is left out rather than invented; delayed count is
              real (900's delay_minutes, already in `schedule`). */}
          <FleetStat label={t('mv.statDeparturesLabel')} icon={<CheckCircle2 size={12} />}
            value={<>{stats.runs_departed}<span className="text-[13px] font-semibold text-[#94a3b8]">/{stats.runs_scheduled}</span></>}
            foot={delayedCount > 0 ? t('mv.delayedCountFoot').replace('{n}', String(delayedCount)) : t('mv.allOnTimeFoot')} />
          {pl && pl.vehicles.length > 0 && (
            <>
              <FleetStat label={t('mv.todayProfitLabel')} icon="₨" value={`₨${fmt(pl.fleet_today_profit_pkr)}`} />
              <FleetStat label={t('mv.monthProfitLabel')} icon="₨" value={`₨${fmt(pl.fleet_month_profit_pkr)}`} />
            </>
          )}
        </div>
      )}

      {/* 2026-11-17: design-first pass — the mockup groups every open
          item (expiring documents, delayed routes, pending cash, due
          maintenance) into one "Action centre" list rather than a
          single-purpose panel per alert type. dhab-pari only has real
          data for two of those right now (document expiry, 881; route
          delay, 900) — only those two are combined here, nothing
          invented for the others. 881's original ranking (soonest-
          expiring first) is preserved within the doc-alert rows;
          delayed routes are surfaced first since they're happening
          right now, not a future deadline. */}
      {(docAlerts.length > 0 || delayedCount > 0) && (
        <FleetPanel tone="danger">
          <FleetPanelHead tone="danger" icon={<ShieldAlert size={14} />} title={t('mv.actionCentreHeading')} description={t('mv.panelDesc.docAlerts')}
            action={<span className="px-2 py-0.5 rounded-full bg-[#FEF2F2] text-[#b91c1c] font-sans text-[10px] font-bold ltr-num">{docAlerts.length + delayedCount}</span>} />
          <div className="divide-y divide-[#f1f5f9]">
            {schedule.filter((s) => s.is_active && s.delay_minutes != null).map((s) => (
              <div key={s.route_id} className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12px] font-sans">
                <span className="text-[#1e293b] font-semibold truncate min-w-0 flex items-center gap-1.5">
                  <Clock size={12} className="shrink-0 text-[#b91c1c]" /> {s.vehicle_number || s.vehicle_type} · {s.origin} → {s.destination}
                </span>
                <span className="shrink-0 px-2 py-0.5 rounded-full font-bold text-[10px] ltr-num bg-[#FEF2F2] text-[#b91c1c]">
                  {t('mv.delayedRouteAlertLabel').replace('{n}', String(s.delay_minutes))}
                </span>
              </div>
            ))}
            {docAlerts.map((a, i) => (
              <div key={i} className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12px] font-sans">
                <span className="text-[#1e293b] font-semibold truncate min-w-0">{a.owner_name}{a.vehicle_number ? ` · ${a.vehicle_number}` : ''} · {t(`mv.docType.${a.document_type}`)}</span>
                <span className={`shrink-0 px-2 py-0.5 rounded-full font-bold text-[10px] ltr-num ${a.status === 'expired' ? 'bg-[#FEF2F2] text-[#b91c1c]' : 'bg-[#FFFBEB] text-[#b45309]'}`}>
                  {a.status === 'expired' ? t('mv.expiredDaysAgoLabel').replace('{n}', String(Math.abs(a.days_remaining))) : t('mv.expiresInDaysLabel').replace('{n}', String(a.days_remaining))}
                </span>
              </div>
            ))}
          </div>
        </FleetPanel>
      )}


      {/* 867: date picker (view any day, not just today), status filter
          chips, and List/Map toggle — real reference shared live
          (EasyBus "Schedule" page), adapted to our own real states
          rather than inventing On Time/Delayed data we don't track. */}
      <FleetPanel>
        <FleetPanelHead icon={<Bus size={14} />} title={t('mv.scheduleHeading')} description={t('mv.panelDesc.schedule')}
          action={<>
            <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)}
              className="px-2 py-1 border border-[#e5e2d0] rounded-lg font-sans text-[11px] ltr-num" />
            <Link href="/portal/fleet/vehicles" className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-bold">
              <Plus size={12} /> {t('mv.addNewBtn')}
            </Link>
          </>} />

        <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-b border-[#f1f5f9] bg-[#F9F9F6]">
          <div className="flex items-center gap-1 overflow-x-auto bg-[#F1F5F9] rounded-lg p-0.5" style={{ scrollbarWidth: 'none' }}>
            {FILTER_CHIPS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)} className="shrink-0 px-2.5 py-1 rounded-md font-sans text-[11px] font-bold cursor-pointer"
                style={{ background: filter === f.key ? '#fff' : 'transparent', color: filter === f.key ? '#166534' : '#64748b', boxShadow: filter === f.key ? '0 1px 3px rgba(15,23,42,0.12)' : 'none' }}>
                {t(f.label)}
              </button>
            ))}
          </div>
          <div className="shrink-0 flex items-center bg-[#F1F5F9] rounded-lg p-0.5">
            <button onClick={() => setView('list')} className="flex items-center gap-1 px-2 py-1 rounded-md font-sans text-[11px] font-bold cursor-pointer" style={{ background: view === 'list' ? '#fff' : 'transparent', color: view === 'list' ? '#166534' : '#64748b' }}>
              <List size={12} />
            </button>
            <button onClick={switchToMap} className="flex items-center gap-1 px-2 py-1 rounded-md font-sans text-[11px] font-bold cursor-pointer" style={{ background: view === 'map' ? '#fff' : 'transparent', color: view === 'map' ? '#166534' : '#64748b' }}>
              <MapIcon size={12} />
            </button>
          </div>
        </div>

        {view === 'map' ? (
          <FleetPanelBody className="p-2">
            {/* Real bug reported live: "why is there no map visible on
                the dashboard" — the map component itself used to never
                mount at all whenever no vehicle was currently mid-run and
                pinging its live location (the normal state most of the
                time), leaving just a text hint with no map underneath it.
                Now the map always renders (LeafletMap's own Pakistan-wide
                fallback view when there are no pins to fit), with the
                hint as a caption rather than a full replacement. */}
            {livePins.length === 0 && (
              <p className="font-sans text-[11.5px] text-[#94a3b8] text-center pb-1.5">{t('mv.noLiveVehiclesHint')}</p>
            )}
            <LeafletMap
              pins={livePins.map((p): MapPin => ({ lat: p.lat, lng: p.lng, label: `${p.owner_name} · ${p.context}`, color: '#166534', emoji: '🚐', isVehicle: true }))}
              height={220} className="rounded-xl"
            />
          </FleetPanelBody>
        ) : filtered.length === 0 ? (
          <FleetPanelBody>
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-2">{t('mv.noScheduleYetHint')}</p>
          </FleetPanelBody>
        ) : (
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {filtered.map((s) => {
              const style = STATE_STYLE[s.state] ?? STATE_STYLE.not_started
              const editing = editingRouteId === s.route_id
              return (
                <div key={`${s.vehicle_id}-${s.route_id}`} className="p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      {photoByVehicle[s.vehicle_id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photoByVehicle[s.vehicle_id]!} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 border border-[#e5e2d0]" />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-[#F0FDF4] flex items-center justify-center shrink-0"><Bus size={15} className="text-[#166534]" /></div>
                      )}
                      <div className="min-w-0">
                        {/* 2026-11-16: real complaint, confirmed live and
                            against SAFAR's own reference — a bus should
                            be identified by its registration number
                            first (matching the already-established rule
                            in fleet/drivers, 875), not by who happens to
                            be driving it today. The driver's name stays
                            visible below, unchanged. */}
                        <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate flex items-center gap-1.5 ltr-num">
                          {s.vehicle_number || s.vehicle_type}{s.vehicle_number && s.vehicle_type ? ` · ${s.vehicle_type}` : ''}
                          {s.service_code && <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[9.5px] font-bold ltr-num">{s.service_code}</span>}
                        </p>
                        <p className="font-sans text-[12.5px] text-[#64748b] mt-0.5">{s.origin} → {s.destination}</p>
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className="px-2 py-1 rounded-full font-sans text-[10px] font-bold" style={{ background: style.bg, color: style.fg }}>{t(style.label)}</span>
                      {s.delay_minutes != null && (
                        <span className="px-2 py-0.5 rounded-full bg-[#FEF2F2] text-[#b91c1c] font-sans text-[9.5px] font-bold ltr-num">
                          {t('mv.delayedBadge').replace('{n}', String(s.delay_minutes))}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#f1f5f9]">
                    <span className="font-sans text-[11px] text-[#64748b] ltr-num">
                      {fmtTime(s.departure_time)}{s.is_two_way && s.return_departure_time ? ` → ${fmtTime(s.return_departure_time)}` : ''}
                      {s.return_wait_minutes ? ` · ${t('mv.scheduleWaitLabel')} ${s.return_wait_minutes}${t('mv.minutesSuffix')}` : ''}
                    </span>
                    <span className="font-sans text-[11px] font-semibold" style={{ color: s.covered_by_substitute ? '#b45309' : '#1e293b' }}>
                      {s.current_driver_name}{s.covered_by_substitute ? ` (${t('mv.scheduleSubstituteLabel')})` : ''}
                    </span>
                  </div>
                  {!editing && (formatDays(s.days_of_week, t) || (s.is_two_way && s.return_days_of_week?.length)) && (
                    <div className="font-sans text-[10.5px] text-[#94a3b8] mt-1">
                      {formatDays(s.days_of_week, t) && <>{t('mv.operatingDaysLabel')}: {formatDays(s.days_of_week, t)}</>}
                      {s.is_two_way && s.return_days_of_week && s.return_days_of_week.length > 0 && (
                        <>{formatDays(s.days_of_week, t) ? ' · ' : ''}{t('mv.returnOnDifferentDaysLabel')}: {formatDays(s.return_days_of_week, t)}</>
                      )}
                    </div>
                  )}
                  {!editing && s.is_active && (
                    delayRouteId === s.route_id ? (
                      <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex flex-col gap-1.5">
                        <div className="flex gap-2">
                          <input type="number" min={1} value={delayMinutesInput} onChange={(e) => setDelayMinutesInput(e.target.value)}
                            placeholder={t('mv.delayMinutesPlaceholder')} className="w-24 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
                          <input value={delayNoteInput} onChange={(e) => setDelayNoteInput(e.target.value)} placeholder={t('mv.delayNotePlaceholder')}
                            className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => saveDelay(s)} disabled={savingDelay || !delayMinutesInput} className="flex-1 py-1.5 rounded-lg bg-[#b91c1c] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">
                            {savingDelay ? t('action.saving') : t('mv.markDelayedBtn')}
                          </button>
                          <button onClick={() => setDelayRouteId(null)} className="flex-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                        {s.delay_minutes != null ? (
                          <button onClick={() => clearDelay(s)} disabled={savingDelay} className="text-[11px] font-sans font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                            {t('mv.clearDelayBtn')}
                          </button>
                        ) : (
                          <button onClick={() => openDelay(s)} className="text-[11px] font-sans font-semibold text-[#b91c1c] cursor-pointer">
                            {t('mv.markDelayedBtn')}
                          </button>
                        )}
                      </div>
                    )
                  )}

                  {editing ? (
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex flex-col gap-2.5">
                      {/* 2026-11-17: real complaint confirmed live — this
                          whole form used to be one flat stack with zero
                          grouping (and the operating-days pills had no
                          label at all), which is why it read as "garbage,
                          no design" next to the SAFAR reference. Split
                          into 3 clearly labeled, backgrounded sections so
                          timing/operating-days/return-schedule each read
                          as their own thing, matching the reference's own
                          discipline of a labeled field within a grouped
                          panel rather than a bare row of controls. */}
                      <div className="bg-[#F9F9F6] rounded-lg p-2.5 flex flex-col gap-2">
                        <p className="font-sans text-[9.5px] font-bold text-[#94a3b8] uppercase tracking-[0.06em]">{t('mv.timingSectionLabel')}</p>
                        <div className="flex gap-2">
                          <div className="flex-1">
                            <label className="block font-sans text-[10.5px] font-bold text-[#64748b] mb-0.5">{t('mv.departureTimeLabel')}</label>
                            <input type="time" value={editDepartureTime} onChange={(e) => setEditDepartureTime(e.target.value)} className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num bg-white" />
                          </div>
                          {editIsTwoWay && (
                            <div className="flex-1">
                              <label className="block font-sans text-[10.5px] font-bold text-[#64748b] mb-0.5">{t('cm.returnDepartureTimeLabel')}</label>
                              <input type="time" value={editReturnTime} onChange={(e) => setEditReturnTime(e.target.value)} className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num bg-white" />
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="bg-[#F9F9F6] rounded-lg p-2.5 flex flex-col gap-1.5">
                        <p className="font-sans text-[9.5px] font-bold text-[#94a3b8] uppercase tracking-[0.06em]">{t('mv.operatingDaysLabel')}</p>
                        <div className="flex gap-1 flex-wrap">
                          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                            <button key={d} type="button" onClick={() => toggleEditDay(d)} className={`px-2 py-1 rounded-lg font-sans text-[11px] font-semibold cursor-pointer ${editDays.includes(d) ? 'bg-[#166534] text-white' : 'bg-white text-[#64748b] border border-[#e5e2d0]'}`}>
                              {t(`mv.dayShort.${d}`)}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Real ask, 2026-11-12: "does these vehicles will
                          have return time schedule as well from Karachi
                          to Peshawar?" — is_two_way/return_departure_time
                          already existed backend-side but this quick
                          editor only ever showed the return field when
                          already on, with no way to turn it on. */}
                      <div className="bg-[#F9F9F6] rounded-lg p-2.5 flex flex-col gap-2">
                        <p className="font-sans text-[9.5px] font-bold text-[#94a3b8] uppercase tracking-[0.06em]">{t('mv.returnScheduleSectionLabel')}</p>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={editIsTwoWay} onChange={(e) => setEditIsTwoWay(e.target.checked)} className="accent-[#166534]" />
                          <span className="font-sans text-[12px] font-semibold text-[#1e293b]">{t('mv.isTwoWayToggleLabel')}</span>
                        </label>
                        {editIsTwoWay && (
                          <>
                            {/* 2026-11-17: real complaint — "why do I pick
                                a wait DURATION when I already type the
                                actual return TIME right above?" Removed
                                the redundant picker entirely.
                                editReturnWaitMinutes itself still exists in
                                state (loaded from the route's current
                                value in openEdit, sent back unchanged on
                                save) since it's the real source for the
                                ride-group layover countdown elsewhere
                                (RouteGroupPanel) — this is a UI-only fix,
                                not a data change. */}
                            {/* Real bug reported live: a long route's
                                return leg (e.g. 24h Peshawar→Karachi)
                                departs the NEXT day, not the same day the
                                outbound left — reusing the same days-of-
                                week list for both legs was a real
                                scheduling conflict. */}
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={editReturnOnDifferentDays} onChange={(e) => { setEditReturnOnDifferentDays(e.target.checked); if (e.target.checked && editReturnDays.length === 0) setEditReturnDays(editDays) }} className="accent-[#166534]" />
                              <span className="font-sans text-[12px] font-semibold text-[#1e293b]">{t('mv.returnOnDifferentDaysLabel')}</span>
                            </label>
                            {editReturnOnDifferentDays && (
                              <div className="flex gap-1 flex-wrap">
                                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                                  <button key={d} type="button" onClick={() => toggleEditReturnDay(d)} className={`px-2 py-1 rounded-lg font-sans text-[11px] font-semibold cursor-pointer ${editReturnDays.includes(d) ? 'bg-[#166534] text-white' : 'bg-white text-[#64748b] border border-[#e5e2d0]'}`}>
                                    {t(`mv.dayShort.${d}`)}
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      <Link href={`/portal/my-vehicle/routes?vehicle=${s.vehicle_id}`} className="font-sans text-[11px] font-semibold text-[#166534] underline underline-offset-2">
                        {t('mv.manageStopsBtn')}
                      </Link>

                      <div className="flex gap-2">
                        <button onClick={() => saveEdit(s)} disabled={savingEdit} className="flex-1 px-2.5 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">
                          {savingEdit ? t('action.loading') : t('action.save')}
                        </button>
                        <button onClick={() => setEditingRouteId(null)} className="flex-1 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
                      {s.is_active ? (
                        <>
                          <button onClick={() => openEdit(s)} className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer">
                            <Pencil size={12} /> {t('mv.editBtn')}
                          </button>
                          <button onClick={() => closeRoute(s)} disabled={busyRouteId === s.route_id} className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50">
                            <Trash2 size={12} /> {t('mv.closeBtn')}
                          </button>
                        </>
                      ) : (
                        <button onClick={() => relaunchRoute(s)} disabled={busyRouteId === s.route_id} className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                            <RotateCcw size={12} /> {t('mv.relaunchBtn')}
                          </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </FleetPanel>

      {/* Quick links to the occasional-use owner tools. */}
      <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] -mb-1">{t('mv.panelDesc.quickLinks')}</p>
      <div className="grid grid-cols-2 gap-2">
        <Link href="/portal/fleet/staff" className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex items-center gap-2">
          <UserCog size={16} className="text-[#166534] shrink-0" />
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.fleetStaffHeading')}</span>
          <ChevronRight size={13} className={`shrink-0 ms-auto text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/fleet/counters" className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex items-center gap-2">
          <Building2 size={16} className="text-[#166534] shrink-0" />
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.bookingCountersHeading')}</span>
          <ChevronRight size={13} className={`shrink-0 ms-auto text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/fleet/vehicles" className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex items-center gap-2">
          <Bus size={16} className="text-[#166534] shrink-0" />
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.busManagementHeading')}</span>
          <ChevronRight size={13} className={`shrink-0 ms-auto text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/fleet/chalan" className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex items-center gap-2">
          <Ticket size={16} className="text-[#166534] shrink-0" />
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.chalanHeading')}</span>
          <ChevronRight size={13} className={`shrink-0 ms-auto text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/fleet/drivers" className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex items-center gap-2">
          <IdCard size={16} className="text-[#166534] shrink-0" />
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.driverRosterHeading')}</span>
          <ChevronRight size={13} className={`shrink-0 ms-auto text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        {isOwner && (
          <Link href="/portal/fleet/invite" className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex items-center gap-2">
            <UserPlus size={16} className="text-[#166534] shrink-0" />
            <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.inviteDriverHeading')}</span>
            <ChevronRight size={13} className={`shrink-0 ms-auto text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
          </Link>
        )}
        <Link href="/portal/fleet/fare-requests" className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex items-center gap-2">
          <Receipt size={16} className="text-[#166534] shrink-0" />
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.fareRequestsHeading')}</span>
          <ChevronRight size={13} className={`shrink-0 ms-auto text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      </div>
    </div>
  )
}
