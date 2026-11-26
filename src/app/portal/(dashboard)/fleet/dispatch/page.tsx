'use client'

// 2026-11-18: Dispatch board (design-first plan, screen 6, part 1) —
// from safar_admin_dashboard-1.html's "Schedules & dispatch" view.
// Deliberately built on ZERO new backend: fleet_vehicle_schedule (903)
// already carries the exact per-route state machine the mockup's
// dispatch-status column needs, fleet_maintenance_orders (892) and
// fleet_vehicle_documents (907) already carry the real readiness
// signals. This screen's only job is combining three already-real
// data sources into one dispatch-status pill per departure — no
// invented "crew incomplete" rule, since dhab-pari has no real policy
// for required crew size to check that against.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ChevronLeft, Repeat2, Send, Bus } from 'lucide-react'
import { toast } from 'sonner'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetStatusPill } from '@/components/portal/FleetPanel'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface ScheduleRow {
  vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; total_seats: number
  route_id: string; origin: string; destination: string; service_code: string | null; is_active: boolean
  departure_time: string | null; is_two_way: boolean; runs_today: boolean; state: string
  current_driver_name: string | null; delay_minutes: number | null
  // 941: this board is the fleet's real go/no-go dispatch view — it
  // already folds in maintenance holds and document expiry, but was
  // completely blind to whether the driver had actually checked in,
  // which is exactly the "will everyone reach before the bus leaves"
  // question this board exists to answer. Only flagged once a home
  // terminal is actually configured for that driver (929/932) — a
  // fleet that hasn't set one up yet keeps today's exact behavior
  // rather than wrongly blocking dispatch over missing admin setup.
  driver_home_terminal_city: string | null; driver_checked_in: boolean
}
interface MaintenanceOrder { vehicle_id: string; status: string }
interface VehicleDocRow { vehicle_id: string; status: 'valid' | 'expiring_soon' | 'expired' }
interface ChalanRow { route_id: string; total_confirmed_count: number }

type DispatchStatus = 'maintenance_hold' | 'docs_expired' | 'docs_expiring' | 'driver_not_ready' | 'ready' | 'in_progress'
function dispatchStatusFor(r: ScheduleRow, maintenanceVehicles: Set<string>, docs: VehicleDocRow[]): DispatchStatus {
  if (maintenanceVehicles.has(r.vehicle_id)) return 'maintenance_hold'
  const rows = docs.filter((d) => d.vehicle_id === r.vehicle_id)
  if (rows.some((d) => d.status === 'expired')) return 'docs_expired'
  if (rows.some((d) => d.status === 'expiring_soon')) return 'docs_expiring'
  if (r.state === 'not_started' && r.driver_home_terminal_city && !r.driver_checked_in) return 'driver_not_ready'
  if (r.state === 'not_started') return 'ready'
  return 'in_progress'
}
const DISPATCH_TONE: Record<DispatchStatus, 'red' | 'amber' | 'green' | 'blue'> = {
  maintenance_hold: 'red', docs_expired: 'red', docs_expiring: 'amber', driver_not_ready: 'amber', ready: 'green', in_progress: 'blue',
}
const DISPATCH_LABEL_KEY: Record<DispatchStatus, string> = {
  maintenance_hold: 'mv.dispatchStatusMaintenanceHold', docs_expired: 'mv.dispatchStatusDocsExpired', docs_expiring: 'mv.dispatchStatusDocsExpiring',
  driver_not_ready: 'mv.dispatchStatusDriverNotReady', ready: 'mv.dispatchStatusReady', in_progress: 'mv.availOnTripLabel',
}
const TABS = ['all', 'scheduled', 'ready', 'departed'] as const
type Tab = (typeof TABS)[number]

export default function FleetDispatchPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [schedule, setSchedule] = useState<ScheduleRow[]>([])
  const [maintenanceVehicles, setMaintenanceVehicles] = useState<Set<string>>(new Set())
  const [docs, setDocs] = useState<VehicleDocRow[]>([])
  const [chalan, setChalan] = useState<Record<string, number>>({})
  const [tab, setTab] = useState<Tab>('all')
  // Real gap pointed out directly, 2026-11-26: "if the bus will not
  // reach due to maintenance issue or out of order then the terminal
  // will shift that route to any other bus if available" — the
  // backend for this already existed (route_run_substitutions, 819/
  // 851, via driver_request_substitute) but had no UI any terminal/
  // fleet staff member could actually reach; this board (owner/staff
  // only — my_managed_fleet already excludes role='driver') is where
  // that go/no-go decision is already made, so the action belongs here.
  const [fleetVehicles, setFleetVehicles] = useState<{ id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }[]>([])
  const [reassigningRouteId, setReassigningRouteId] = useState<string | null>(null)
  const [reassignVehicleId, setReassignVehicleId] = useState('')
  const [reassignBusy, setReassignBusy] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string } | null
    if (!f) { setLoading(false); return }
    const [{ data: sched }, { data: maint }, { data: docRows }, { data: vehicles }] = await Promise.all([
      supabase.rpc('fleet_vehicle_schedule', { p_fleet_id: f.fleet_id }),
      supabase.rpc('fleet_maintenance_orders', { p_fleet_id: f.fleet_id }),
      supabase.rpc('fleet_vehicle_documents', { p_fleet_id: f.fleet_id }),
      supabase.rpc('my_fleet_vehicles'),
    ])
    const todays = ((sched ?? []) as ScheduleRow[]).filter((r) => r.is_active && r.runs_today)
    setSchedule(todays)
    setMaintenanceVehicles(new Set(((maint ?? []) as MaintenanceOrder[]).filter((m) => m.status !== 'completed').map((m) => m.vehicle_id)))
    setDocs((docRows ?? []) as VehicleDocRow[])
    setFleetVehicles((vehicles ?? []) as { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }[])

    // 2026-11-18: real seat occupancy, same bounded pattern as the
    // Dashboard's Vehicles Requiring Attention panel — only for
    // today's actual departures (small, already-filtered set).
    const entries = await Promise.all(todays.map((r) =>
      supabase.rpc('route_departure_chalan', { p_route_id: r.route_id, p_travel_date: new Date().toISOString().slice(0, 10) })
        .then(({ data }) => [r.route_id, (data as { total_confirmed_count?: number } | null)?.total_confirmed_count ?? 0] as const)
    ))
    setChalan(Object.fromEntries(entries))
    setLoading(false)
  }

  const confirmReassign = async (routeId: string) => {
    if (!reassignVehicleId) return
    setReassignBusy(true)
    const { error } = await supabase.rpc('driver_request_substitute', { p_route_id: routeId, p_substitute_vehicle_id: reassignVehicleId })
    setReassignBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.handOffDoneToast'))
    setReassigningRouteId(null); setReassignVehicleId('')
    load()
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const dispatched = schedule.filter((r) => dispatchStatusFor(r, maintenanceVehicles, docs) === 'in_progress' || r.state === 'completed_today').length
  const waiting = schedule.filter((r) => r.state === 'waiting_at_destination').length
  const issues = schedule.filter((r) => ['maintenance_hold', 'docs_expired', 'docs_expiring', 'driver_not_ready'].includes(dispatchStatusFor(r, maintenanceVehicles, docs))).length

  const filtered = schedule.filter((r) => {
    const status = dispatchStatusFor(r, maintenanceVehicles, docs)
    if (tab === 'scheduled') return r.state === 'not_started'
    if (tab === 'ready') return status === 'ready'
    if (tab === 'departed') return status === 'in_progress' || r.state === 'completed_today'
    return true
  })
  const twoWayCount = schedule.filter((r) => r.is_two_way).length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><Send size={17} /> {t('mv.dispatchBoardHeading')}</h1>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <FleetStat label={t('mv.statTodaysDeparturesLabel')} value={schedule.length} icon={<Bus size={12} />} />
        <FleetStat label={t('mv.statDispatchedLabel')} value={dispatched} />
        <FleetStat label={t('mv.statWaitingAtTerminalsLabel')} value={waiting} />
        <FleetStat label={t('mv.statIssuesPendingLabel')} value={issues} valueClassName={issues > 0 ? 'text-[#b91c1c]' : 'text-[#166534]'} />
      </div>

      <FleetPanel>
        <FleetPanelHead icon={<Send size={14} />} title={t('mv.dispatchBoardHeading')} description={t('mv.panelDesc.dispatchBoard')} />
        <div className="flex gap-1.5 p-3 pb-0 flex-wrap">
          {TABS.map((tb) => (
            <button key={tb} onClick={() => setTab(tb)}
              className={`px-2.5 py-1 rounded-full font-sans text-[11px] font-semibold cursor-pointer ${tab === tb ? 'bg-[#166534] text-white' : 'bg-[#F1F5F9] text-[#64748b]'}`}>
              {t(`mv.dispatchTab${tb.charAt(0).toUpperCase()}${tb.slice(1)}`)}
            </button>
          ))}
        </div>
        {filtered.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noDeparturesHint')}</p>
        ) : (
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {filtered.map((r) => {
              const status = dispatchStatusFor(r, maintenanceVehicles, docs)
              const occ = chalan[r.route_id]
              return (
                <div key={r.route_id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-sans text-[13px] font-bold text-[#1e293b] ltr-num">{r.departure_time ?? '—'}</p>
                    <FleetStatusPill tone={DISPATCH_TONE[status]}>{t(DISPATCH_LABEL_KEY[status])}</FleetStatusPill>
                  </div>
                  <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] mt-0.5">{r.origin} → {r.destination}</p>
                  <p className="font-sans text-[11px] text-[#64748b] mt-0.5">
                    {r.vehicle_number || r.vehicle_type} · {r.current_driver_name ?? '—'}
                    {occ != null && r.total_seats > 0 && <span className="ltr-num"> · {occ}/{r.total_seats}</span>}
                  </p>
                  {(status === 'maintenance_hold') && (
                    <Link href="/portal/fleet/maintenance" className="font-sans text-[10.5px] font-semibold text-[#166534] mt-1 inline-block">{t('mv.reviewMaintenanceLink')} →</Link>
                  )}
                  {(status === 'docs_expired' || status === 'docs_expiring') && (
                    <Link href="/portal/fleet/vehicles" className="font-sans text-[10.5px] font-semibold text-[#166534] mt-1 inline-block">{t('mv.reviewMaintenanceLink')} →</Link>
                  )}
                  {status === 'driver_not_ready' && (
                    <Link href="/portal/fleet/staff" className="font-sans text-[10.5px] font-semibold text-[#166534] mt-1 inline-block">{t('mv.fleetStaffHeading')} →</Link>
                  )}
                  {r.state === 'not_started' && (
                    reassigningRouteId === r.route_id ? (
                      <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-[#f1f5f9]">
                        <select value={reassignVehicleId} onChange={(e) => setReassignVehicleId(e.target.value)}
                          className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px]">
                          <option value="">{t('mv.pickAnotherBusPlaceholder')}</option>
                          {fleetVehicles.filter((v) => v.id !== r.vehicle_id).map((v) => (
                            <option key={v.id} value={v.id}>{v.vehicle_number || v.vehicle_type} · {v.owner_name}</option>
                          ))}
                        </select>
                        <div className="flex gap-2">
                          <button onClick={() => confirmReassign(r.route_id)} disabled={reassignBusy || !reassignVehicleId}
                            className="flex-1 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">
                            {reassignBusy ? t('action.saving') : t('action.save')}
                          </button>
                          <button onClick={() => { setReassigningRouteId(null); setReassignVehicleId('') }}
                            className="flex-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setReassigningRouteId(r.route_id); setReassignVehicleId('') }}
                        className="flex items-center gap-1 font-sans text-[10.5px] font-semibold text-[#b45309] mt-1.5 cursor-pointer">
                        <Repeat2 size={11} /> {t('mv.busNotReachingBtn')}
                      </button>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
      </FleetPanel>

      {/* 2026-11-18: the mockup's 3 explainer cards — Driver duty rule
          reuses the exact real text already shipped on the Staff page
          (no new content needed); Dispatch checklist is read-only and
          backed by real data, not fabricated checkboxes; Return trip
          link points at the EXISTING two-way/return-leg setup in the
          real route editor rather than a fake "linked return" modal. */}
      <FleetPanel>
        <FleetPanelHead icon={<Repeat2 size={14} />} title={t('mv.dutyComplianceHeading')} />
        <FleetPanelBody>
          <p className="font-sans text-[11px] text-[#64748b] leading-relaxed">{t('mv.dutyRuleExplainer')}</p>
          <Link href="/portal/fleet/staff" className="font-sans text-[11px] font-semibold text-[#166534] mt-2 inline-block">{t('mv.fleetStaffHeading')} →</Link>
        </FleetPanelBody>
      </FleetPanel>

      <FleetPanel>
        <FleetPanelHead title={t('mv.dispatchChecklistHeading')} description={t('mv.panelDesc.dispatchChecklist')} />
        <FleetPanelBody className="p-3.5 flex flex-col gap-1.5">
          <p className="font-sans text-[11.5px] text-[#1e293b] flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${schedule.every((r) => !docs.some((d) => d.vehicle_id === r.vehicle_id && d.status !== 'valid')) ? 'bg-[#166534]' : 'bg-[#b91c1c]'}`} />
            {t('mv.checklistDocsValidLabel')}
          </p>
          <p className="font-sans text-[11.5px] text-[#1e293b] flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${maintenanceVehicles.size === 0 ? 'bg-[#166534]' : 'bg-[#b91c1c]'}`} />
            {t('mv.checklistNoMaintenanceLabel')}
          </p>
        </FleetPanelBody>
      </FleetPanel>

      <FleetPanel>
        <FleetPanelHead title={t('mv.returnTripLinkHeading')} description={t('mv.panelDesc.returnTripLink')} />
        <FleetPanelBody>
          <p className="font-sans text-[11.5px] text-[#1e293b] ltr-num">{t('mv.twoWayRoutesCountLabel').replace('{n}', String(twoWayCount)).replace('{m}', String(schedule.length))}</p>
          <Link href="/portal/my-vehicle/routes" className="font-sans text-[11px] font-semibold text-[#166534] mt-2 inline-block">{t('mv.manageRouteLink')} →</Link>
        </FleetPanelBody>
      </FleetPanel>
    </div>
  )
}
