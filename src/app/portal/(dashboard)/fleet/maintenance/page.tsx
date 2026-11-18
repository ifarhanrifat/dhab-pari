'use client'

// 2026-11-17: Maintenance work orders + fuel log. Confirmed by direct
// grep (earlier this session) that neither existed anywhere in this
// app — the generic vehicle_expenses log (854) only ever recorded a
// one-time amount+note for 'fuel'/'maintenance' categories, with no
// odometer/litres/rate breakdown and no trackable work-order lifecycle
// (workshop, estimate, due date, status) the way SAFAR's reference
// shows. Backend (892: vehicle_maintenance_orders, vehicle_fuel_log,
// create_maintenance_order, set_maintenance_order_status,
// record_fuel_entry, fleet_maintenance_orders, fleet_fuel_log) was
// already written and applied in an earlier round of this session —
// this is that backend's first and only frontend.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Wrench, Fuel, Plus, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetStatusPill, FleetFormGrid, FleetFormField } from '@/components/portal/FleetPanel'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
interface MaintenanceOrder {
  id: string; vehicle_id: string; vehicle_number: string | null; vehicle_type: string | null
  issue: string; workshop: string | null; estimate_pkr: number | null; due_date: string | null; status: string; created_at: string
}
interface FuelEntry {
  id: string; vehicle_id: string; vehicle_number: string | null; vehicle_type: string | null
  odometer_km: number | null; litres: number; rate_pkr: number; total_pkr: number; created_at: string
}
interface DocAlert {
  vehicle_id: string; owner_name: string; vehicle_number: string | null
  document_type: string; expiry_date: string; days_remaining: number; status: 'expired' | 'expiring_soon'
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { scheduled: 'gray', in_progress: 'amber', hold: 'red', completed: 'green' }
function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function FleetMaintenancePage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [orders, setOrders] = useState<MaintenanceOrder[]>([])
  const [fuelLog, setFuelLog] = useState<FuelEntry[]>([])
  const [docAlerts, setDocAlerts] = useState<DocAlert[]>([])

  const [woVehicle, setWoVehicle] = useState('')
  const [woIssue, setWoIssue] = useState('')
  const [woWorkshop, setWoWorkshop] = useState('')
  const [woEstimate, setWoEstimate] = useState('')
  const [woDue, setWoDue] = useState('')
  const [savingWo, setSavingWo] = useState(false)

  const [fuVehicle, setFuVehicle] = useState('')
  const [fuOdometer, setFuOdometer] = useState('')
  const [fuLitres, setFuLitres] = useState('')
  const [fuRate, setFuRate] = useState('')
  const [savingFuel, setSavingFuel] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string } | null
    setFleetId(f?.fleet_id ?? null)
    if (f) {
      const [{ data: v }, { data: o }, { data: fl }, { data: da }] = await Promise.all([
        supabase.rpc('my_fleet_vehicles'),
        supabase.rpc('fleet_maintenance_orders', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_fuel_log', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_document_alerts', { p_fleet_id: f.fleet_id }),
      ])
      setVehicles((v ?? []) as FleetVehicle[])
      setOrders((o ?? []) as MaintenanceOrder[])
      setFuelLog((fl ?? []) as FuelEntry[])
      setDocAlerts((da ?? []) as DocAlert[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const createOrder = async () => {
    if (!woVehicle || !woIssue.trim()) { toast.error(t('mv.issueVehicleRequiredError')); return }
    setSavingWo(true)
    const { error } = await supabase.rpc('create_maintenance_order', {
      p_vehicle_id: woVehicle, p_issue: woIssue, p_workshop: woWorkshop || null,
      p_estimate_pkr: woEstimate ? Number(woEstimate) : null, p_due_date: woDue || null,
    })
    setSavingWo(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.workOrderCreatedToast'))
    setWoVehicle(''); setWoIssue(''); setWoWorkshop(''); setWoEstimate(''); setWoDue('')
    load()
  }

  const setStatus = async (id: string, status: string) => {
    const { error } = await supabase.rpc('set_maintenance_order_status', { p_id: id, p_status: status })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const recordFuel = async () => {
    if (!fuVehicle || !fuLitres || !fuRate) { toast.error(t('mv.fuelFieldsRequiredError')); return }
    setSavingFuel(true)
    const { error } = await supabase.rpc('record_fuel_entry', {
      p_vehicle_id: fuVehicle, p_litres: Number(fuLitres), p_rate_pkr: Number(fuRate), p_odometer_km: fuOdometer ? Number(fuOdometer) : null,
    })
    setSavingFuel(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.fuelEntryRecordedToast'))
    setFuVehicle(''); setFuOdometer(''); setFuLitres(''); setFuRate('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  const openOrders = orders.filter((o) => o.status !== 'completed')
  const onHoldVehicles = new Set(orders.filter((o) => o.status === 'hold').map((o) => o.vehicle_id))
  const vehicleLabel = (v: { vehicle_number: string | null; vehicle_type: string | null; owner_name?: string }) => v.vehicle_number || v.vehicle_type || v.owner_name || ''
  const in7Days = new Date(); in7Days.setDate(in7Days.getDate() + 7)
  const dueWithin7Days = openOrders.filter((o) => o.due_date && new Date(o.due_date) <= in7Days).length
  const now = new Date()
  const fuelThisMonth = fuelLog.filter((f) => { const d = new Date(f.created_at); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() })
    .reduce((sum, f) => sum + Number(f.total_pkr), 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2 truncate"><Wrench size={19} /> {t('mv.maintenanceHeading')}</h1>
        {/* 2026-11-18: real gap from the button-by-button audit — the
            mockup puts "+Record cost" right on this screen's header;
            the real feature already exists (fleet/expenses), just one
            sidebar nav-hop away until now. */}
        <Link href="/portal/fleet/expenses" className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-bold">
          <Plus size={12} /> {t('mv.logExpenseBtn')}
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FleetStat label={t('mv.openWorkOrdersLabel')} icon={<Wrench size={12} />} value={openOrders.length} />
        <FleetStat label={t('mv.serviceDueSoonLabel')} value={dueWithin7Days} valueClassName={dueWithin7Days > 0 ? 'text-[#b45309]' : 'text-[#166534]'} />
        <FleetStat label={t('mv.fuelSpentThisMonthLabel')} value={`₨${fmt(fuelThisMonth)}`} />
        <FleetStat label={t('mv.onHoldLabel')} icon={<Wrench size={12} />} value={onHoldVehicles.size} valueClassName={onHoldVehicles.size > 0 ? 'text-[#b91c1c]' : 'text-[#166534]'} />
      </div>

      <FleetPanel>
        <FleetPanelHead icon={<Plus size={14} />} title={t('mv.newWorkOrderHeading')} description={t('mv.newWorkOrderDesc')} />
        <FleetPanelBody>
          <FleetFormGrid>
            <FleetFormField label={t('mv.vehicleColumnLabel')} full>
              <select value={woVehicle} onChange={(e) => setWoVehicle(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">—</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>)}
              </select>
            </FleetFormField>
            <FleetFormField label={t('mv.issueLabel')} full>
              <input value={woIssue} onChange={(e) => setWoIssue(e.target.value)} placeholder={t('mv.issuePlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('mv.workshopLabel')}>
              <input value={woWorkshop} onChange={(e) => setWoWorkshop(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('mv.estimateLabel')}>
              <input type="number" value={woEstimate} onChange={(e) => setWoEstimate(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('mv.dueDateLabel')} full>
              <input type="date" value={woDue} onChange={(e) => setWoDue(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label="" full>
              <button onClick={createOrder} disabled={savingWo} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
                {savingWo ? t('action.saving') : t('mv.createWorkOrderBtn')}
              </button>
            </FleetFormField>
          </FleetFormGrid>
        </FleetPanelBody>
      </FleetPanel>

      <FleetPanel>
        <FleetPanelHead icon={<Wrench size={14} />} title={t('mv.workOrdersHeading')}
          action={<FleetStatusPill tone={openOrders.length > 0 ? 'amber' : 'green'}>{openOrders.length} {t('mv.openLabel')}</FleetStatusPill>} />
        {orders.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noWorkOrdersHint')}</p>
        ) : (
          <div className="flex flex-col">
            {orders.map((o) => (
              <div key={o.id} className="px-3.5 py-2.5 border-t border-[#f1f5f9] first:border-t-0 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-sans text-[12.5px] font-bold text-[#1e293b] truncate">
                    <span className="ltr-num">{o.vehicle_number || o.vehicle_type}</span> · {o.issue}
                  </p>
                  <p className="font-sans text-[10.5px] text-[#94a3b8]">
                    {o.workshop ? `${o.workshop} · ` : ''}{o.estimate_pkr ? `₨${o.estimate_pkr.toLocaleString()} · ` : ''}{o.due_date ? <span className="ltr-num">{o.due_date}</span> : ''}
                  </p>
                </div>
                <select value={o.status} onChange={(e) => setStatus(o.id, e.target.value)} className="shrink-0 px-2 py-1 border border-[#e5e2d0] rounded-lg font-sans text-[10.5px]">
                  <option value="scheduled">{t('mv.status.scheduled')}</option>
                  <option value="in_progress">{t('mv.status.in_progress')}</option>
                  <option value="hold">{t('mv.status.hold')}</option>
                  <option value="completed">{t('mv.status.completed')}</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </FleetPanel>

      <FleetPanel>
        <FleetPanelHead icon={<Fuel size={14} />} title={t('mv.newFuelEntryHeading')} />
        <FleetPanelBody>
          <FleetFormGrid>
            <FleetFormField label={t('mv.vehicleColumnLabel')} full>
              <select value={fuVehicle} onChange={(e) => setFuVehicle(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">—</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>)}
              </select>
            </FleetFormField>
            <FleetFormField label={t('mv.odometerLabel')}>
              <input type="number" value={fuOdometer} onChange={(e) => setFuOdometer(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('mv.litresLabel')}>
              <input type="number" value={fuLitres} onChange={(e) => setFuLitres(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('mv.rateLabel')} full>
              <input type="number" value={fuRate} onChange={(e) => setFuRate(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label="" full>
              <button onClick={recordFuel} disabled={savingFuel} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
                {savingFuel ? t('action.saving') : t('mv.recordFuelBtn')}
              </button>
            </FleetFormField>
          </FleetFormGrid>
        </FleetPanelBody>
      </FleetPanel>

      <FleetPanel>
        <FleetPanelHead icon={<Fuel size={14} />} title={t('mv.fuelLogHeading')} />
        {fuelLog.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noFuelEntriesHint')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] bg-[#F9F9F6] border-b border-[#f1f5f9]">
                  <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.vehicleColumnLabel')}</th>
                  <th className="px-3.5 py-1.5 text-end whitespace-nowrap">{t('mv.odometerLabel')}</th>
                  <th className="px-3.5 py-1.5 text-end whitespace-nowrap">{t('mv.litresLabel')}</th>
                  <th className="px-3.5 py-1.5 text-end whitespace-nowrap">{t('mk.totalFareLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {fuelLog.map((f) => (
                  <tr key={f.id} className="border-t border-[#f1f5f9]">
                    <td className="px-3.5 py-2.5 font-sans text-[12px] font-semibold text-[#1e293b] ltr-num whitespace-nowrap">{f.vehicle_number || f.vehicle_type}</td>
                    <td className="px-3.5 py-2.5 text-end font-sans text-[11.5px] text-[#64748b] ltr-num">{f.odometer_km ?? '—'}</td>
                    <td className="px-3.5 py-2.5 text-end font-sans text-[11.5px] text-[#64748b] ltr-num">{f.litres} L</td>
                    <td className="px-3.5 py-2.5 text-end font-sans text-[12px] font-semibold text-[#1e293b] ltr-num">₨{Number(f.total_pkr).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FleetPanel>

      {/* 2026-11-18: real gap found re-reading the mockup in full —
          the "Document expiry alerts" panel was entirely missing from
          this page, even though it already exists on the Dashboard
          (fleet_document_alerts, 881). Reusing the exact same data +
          layout here, where the mockup actually places it. */}
      {docAlerts.length > 0 && (
        <FleetPanel tone="danger">
          <FleetPanelHead tone="danger" icon={<ShieldAlert size={14} />} title={t('mv.documentAlertsHeading')}
            action={<span className="px-2 py-0.5 rounded-full bg-[#FEF2F2] text-[#b91c1c] font-sans text-[10px] font-bold ltr-num">{docAlerts.length}</span>} />
          <div className="divide-y divide-[#f1f5f9]">
            {docAlerts.map((a, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <span className="w-7 h-7 rounded-lg bg-[#FFFBEB] text-[#b45309] flex items-center justify-center shrink-0 font-bold text-[13px]">!</span>
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-[12px] font-bold text-[#1e293b] truncate">{t(`mv.docType.${a.document_type}`)}</p>
                  <p className="font-sans text-[10.5px] text-[#64748b] truncate">{a.owner_name}{a.vehicle_number ? ` · ${a.vehicle_number}` : ''}</p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full font-bold text-[10px] ltr-num ${a.status === 'expired' ? 'bg-[#FEF2F2] text-[#b91c1c]' : 'bg-[#FFFBEB] text-[#b45309]'}`}>
                  {a.status === 'expired' ? t('mv.expiredDaysAgoLabel').replace('{n}', String(Math.abs(a.days_remaining))) : t('mv.expiresInDaysLabel').replace('{n}', String(a.days_remaining))}
                </span>
              </div>
            ))}
          </div>
        </FleetPanel>
      )}
    </div>
  )
}
