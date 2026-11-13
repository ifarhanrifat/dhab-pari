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
import { Users2, Map as MapIcon, UserPlus, Building2, UserCog, Receipt, ChevronRight, Bus, List, Ticket, CheckCircle2, Plus, Pencil, Trash2, RotateCcw, IdCard } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface ScheduleCard {
  vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  route_id: string; origin: string; destination: string; service_code: string | null
  is_active: boolean; departure_time: string | null; return_departure_time: string | null; return_wait_minutes: number | null
  is_two_way: boolean; days_of_week: number[]; runs_today: boolean; state: string
  current_driver_name: string; covered_by_substitute: boolean
}
interface DepartureStats { bookings_today_count: number; runs_scheduled: number; runs_departed: number }
interface FleetVehicleSummary {
  vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  today_profit_pkr: number; month_profit_pkr: number; wallet_balance_pkr: number
}
interface LivePin { owner_name: string; vehicle_type: string; context: string; lat: number; lng: number }

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
  const [photoByVehicle, setPhotoByVehicle] = useState<Record<string, string | null>>({})
  const [scheduleDate, setScheduleDate] = useState(today())
  const [filter, setFilter] = useState('all')
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null)
  const [editDepartureTime, setEditDepartureTime] = useState('')
  const [editReturnTime, setEditReturnTime] = useState('')
  const [editIsTwoWay, setEditIsTwoWay] = useState(false)
  const [editReturnWaitMinutes, setEditReturnWaitMinutes] = useState(300)
  const [editDays, setEditDays] = useState<number[]>([])
  const [savingEdit, setSavingEdit] = useState(false)
  const [busyRouteId, setBusyRouteId] = useState<string | null>(null)

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
      const [{ data: plData }, { data: statsData }] = await Promise.all([
        supabase.rpc('fleet_dashboard_summary'),
        supabase.rpc('fleet_departure_stats', { p_fleet_id: f.fleet_id }),
        loadSchedule(f.fleet_id, scheduleDate),
      ])
      setPl(plData as typeof pl)
      setStats(statsData as DepartureStats)
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
  }
  const toggleEditDay = (d: number) => setEditDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort())

  const saveEdit = async (s: ScheduleCard) => {
    if (editDays.length === 0) { toast.error(t('mv.pickAtLeastOneDayError')); return }
    setSavingEdit(true)
    const { error } = await supabase.rpc('update_vehicle_route_schedule', {
      p_route_id: s.route_id, p_departure_time: editDepartureTime || null, p_days_of_week: editDays,
      p_return_departure_time: editIsTwoWay ? (editReturnTime || null) : null, p_is_two_way: editIsTwoWay, p_return_wait_minutes: editIsTwoWay ? editReturnWaitMinutes : null,
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

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Users2 size={19} /> {fleetName}</h1>

      {/* 864: a horizontally-scrollable stat-card row — today's bookings
          and how many of today's scheduled runs have actually departed,
          from fleet_departure_stats; mirrors the dashboard-stat-row
          pattern of the EasyBus reference, in our own theme. */}
      {stats && (
        <div className="flex gap-2 overflow-x-auto -mx-0.5 px-0.5" style={{ scrollbarWidth: 'none' }}>
          <div className="shrink-0 min-w-[120px] bg-white border border-[#e5e2d0] rounded-xl p-3">
            <div className="flex items-center gap-1.5 text-[#166534]"><Ticket size={13} /><span className="font-sans text-[10px] font-bold uppercase tracking-[0.04em]">{t('mv.statBookingsTodayLabel')}</span></div>
            <p className="font-sans text-[18px] font-extrabold text-[#1e293b] mt-1 ltr-num">{stats.bookings_today_count}</p>
          </div>
          <div className="shrink-0 min-w-[120px] bg-white border border-[#e5e2d0] rounded-xl p-3">
            <div className="flex items-center gap-1.5 text-[#166534]"><CheckCircle2 size={13} /><span className="font-sans text-[10px] font-bold uppercase tracking-[0.04em]">{t('mv.statDeparturesLabel')}</span></div>
            <p className="font-sans text-[18px] font-extrabold text-[#1e293b] mt-1 ltr-num">{stats.runs_departed}/{stats.runs_scheduled}</p>
          </div>
        </div>
      )}

      {/* Condensed fleet P&L — full breakdown lives in the Reports tab now. */}
      {pl && pl.vehicles.length > 0 && (
        <div className="flex gap-2">
          <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-xl p-3">
            <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.todayProfitLabel')}</p>
            <p className="font-sans text-[18px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl.fleet_today_profit_pkr)}</p>
          </div>
          <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-xl p-3">
            <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.monthProfitLabel')}</p>
            <p className="font-sans text-[18px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl.fleet_month_profit_pkr)}</p>
          </div>
        </div>
      )}

      {/* 867: date picker (view any day, not just today), status filter
          chips, and List/Map toggle — real reference shared live
          (EasyBus "Schedule" page), adapted to our own real states
          rather than inventing On Time/Delayed data we don't track. */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] flex items-center gap-1.5 shrink-0"><Bus size={13} /> {t('mv.scheduleHeading')}</p>
          <div className="flex items-center gap-1.5">
            <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)}
              className="px-2 py-1 border border-[#e5e2d0] rounded-lg font-sans text-[11px] ltr-num" />
            <Link href="/portal/fleet/vehicles" className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-bold">
              <Plus size={12} /> {t('mv.addNewBtn')}
            </Link>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {FILTER_CHIPS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)} className="shrink-0 px-2.5 py-1 rounded-lg font-sans text-[11px] font-bold cursor-pointer border"
                style={{ background: filter === f.key ? '#166534' : '#fff', color: filter === f.key ? '#fff' : '#334155', borderColor: filter === f.key ? '#166534' : '#e5e2d0' }}>
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
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-2">
            {livePins.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noLiveVehiclesHint')}</p>
            ) : (
              <LeafletMap
                pins={livePins.map((p): MapPin => ({ lat: p.lat, lng: p.lng, label: `${p.owner_name} · ${p.context}`, color: '#166534', emoji: '🚐', isVehicle: true }))}
                height={220} className="rounded-xl"
              />
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[12px] text-[#94a3b8] text-center">{t('mv.noScheduleYetHint')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((s) => {
              const style = STATE_STYLE[s.state] ?? STATE_STYLE.not_started
              const editing = editingRouteId === s.route_id
              return (
                <div key={`${s.vehicle_id}-${s.route_id}`} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      {photoByVehicle[s.vehicle_id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photoByVehicle[s.vehicle_id]!} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 border border-[#e5e2d0]" />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-[#F0FDF4] flex items-center justify-center shrink-0"><Bus size={15} className="text-[#166534]" /></div>
                      )}
                      <div className="min-w-0">
                        <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate flex items-center gap-1.5">
                          {s.owner_name}{s.vehicle_type ? ` · ${s.vehicle_type}` : ''}
                          {s.service_code && <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[9.5px] font-bold ltr-num">{s.service_code}</span>}
                        </p>
                        <p className="font-sans text-[12.5px] text-[#64748b] mt-0.5">{s.origin} → {s.destination}</p>
                      </div>
                    </div>
                    <span className="shrink-0 px-2 py-1 rounded-full font-sans text-[10px] font-bold" style={{ background: style.bg, color: style.fg }}>{t(style.label)}</span>
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

                  {editing ? (
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex flex-col gap-2">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="block font-sans text-[10.5px] font-bold text-[#64748b] mb-0.5">{t('mv.departureTimeLabel')}</label>
                          <input type="time" value={editDepartureTime} onChange={(e) => setEditDepartureTime(e.target.value)} className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
                        </div>
                        {editIsTwoWay && (
                          <div className="flex-1">
                            <label className="block font-sans text-[10.5px] font-bold text-[#64748b] mb-0.5">{t('cm.returnDepartureTimeLabel')}</label>
                            <input type="time" value={editReturnTime} onChange={(e) => setEditReturnTime(e.target.value)} className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
                          </div>
                        )}
                      </div>

                      {/* Real ask, 2026-11-12: "does these vehicles will
                          have return time schedule as well from Karachi
                          to Peshawar?" — is_two_way/return_departure_time
                          already existed backend-side but this quick
                          editor only ever showed the return field when
                          already on, with no way to turn it on. */}
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={editIsTwoWay} onChange={(e) => setEditIsTwoWay(e.target.checked)} className="accent-[#166534]" />
                        <span className="font-sans text-[12px] font-semibold text-[#1e293b]">{t('mv.isTwoWayToggleLabel')}</span>
                      </label>
                      {editIsTwoWay && (
                        <div className="flex gap-1.5 flex-wrap items-center">
                          <span className="font-sans text-[10.5px] text-[#64748b]">{t('mv.returnWaitMinutesLabel')}</span>
                          {[300, 360, 480].map((mins) => (
                            <button key={mins} type="button" onClick={() => setEditReturnWaitMinutes(mins)}
                              className={`px-2 py-1 rounded-lg font-sans text-[11px] font-semibold cursor-pointer ${editReturnWaitMinutes === mins ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                              {Math.round(mins / 60)}{t('mv.hoursShortSuffix')}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="flex gap-1 flex-wrap">
                        {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                          <button key={d} type="button" onClick={() => toggleEditDay(d)} className={`px-2 py-1 rounded-lg font-sans text-[11px] font-semibold cursor-pointer ${editDays.includes(d) ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                            {t(`mv.dayShort.${d}`)}
                          </button>
                        ))}
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
      </div>

      {/* Quick links to the occasional-use owner tools. */}
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
