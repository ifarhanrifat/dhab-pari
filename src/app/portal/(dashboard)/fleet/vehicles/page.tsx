'use client'

// 864/865: "Bus Management" — a fleet owner/staff member could only ever
// edit the catalog settings (color/model/AC/sleeper/hourly-shadi-rental
// toggles, photos) of a vehicle they personally drive, through any
// screen, confirmed live. This lists every fleet vehicle and links each
// into catalog/page.tsx's now-widened ?vehicle=<id> fetch-by-id path.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Bus, Plus, Milestone, Settings2, Snowflake } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetFormGrid, FleetFormField, FleetStat, FleetStatusPill } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { VehicleCatalogForm } from '@/components/mobility/VehicleCatalogForm'

interface FleetVehicle {
  id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; portal_user_id: string
  category_name: string | null; vehicle_kind: string | null; total_seats: number | null; is_sleeper: boolean
  model: string | null; model_year: number | null; has_ac: boolean
}
interface VehicleCategory { id: string; name: string }
interface FleetDriver { id: string; portal_user_id: string; full_name: string; routes_assigned_count: number; primary_vehicle_number: string | null; primary_route_label: string | null }
interface ScheduleRow { vehicle_id: string; state: string }
interface MaintenanceOrder { vehicle_id: string; status: string }
interface VehicleDocRow { vehicle_id: string; status: 'valid' | 'expiring_soon' | 'expired' }

// 2026-11-17: Vehicles screen rebuild (design-first plan, screen 3) —
// the mockup's fleet-register table shows a real Availability pill per
// bus. fleet_vehicle_schedule (903) and fleet_maintenance_orders (892)
// already carry this fleet-wide; no new backend concept, just real
// derived state, never fabricated.
type Availability = 'on_trip' | 'at_terminal' | 'maintenance' | 'available' | 'no_route'
function availabilityFor(vehicleId: string, schedule: ScheduleRow[], openMaintenance: Set<string>): Availability {
  if (openMaintenance.has(vehicleId)) return 'maintenance'
  const row = schedule.find((s) => s.vehicle_id === vehicleId)
  if (!row) return 'no_route'
  if (row.state === 'outbound_in_progress' || row.state === 'return_in_progress') return 'on_trip'
  if (row.state === 'waiting_at_destination') return 'at_terminal'
  return 'available'
}
const AVAIL_TONE: Record<Availability, 'blue' | 'red' | 'green' | 'gray'> = {
  on_trip: 'blue', at_terminal: 'blue', maintenance: 'red', available: 'green', no_route: 'gray',
}
const AVAIL_LABEL_KEY: Record<Availability, string> = {
  on_trip: 'mv.availOnTripLabel', at_terminal: 'mv.availAtTerminalLabel', maintenance: 'mv.availMaintenanceLabel',
  available: 'mv.availAvailableLabel', no_route: 'mv.availNoRouteLabel',
}

// Worst status wins: expired > expiring_soon > valid > not set.
type DocState = 'expired' | 'expiring_soon' | 'valid' | 'not_set'
function docStateFor(vehicleId: string, docs: VehicleDocRow[]): DocState {
  const rows = docs.filter((d) => d.vehicle_id === vehicleId)
  if (rows.some((r) => r.status === 'expired')) return 'expired'
  if (rows.some((r) => r.status === 'expiring_soon')) return 'expiring_soon'
  if (rows.length > 0) return 'valid'
  return 'not_set'
}
const DOC_TONE: Record<DocState, 'red' | 'amber' | 'green' | 'gray'> = { expired: 'red', expiring_soon: 'amber', valid: 'green', not_set: 'gray' }
const DOC_LABEL_KEY: Record<DocState, string> = {
  expired: 'mv.docStatusExpired', expiring_soon: 'mv.docStatusExpiringSoon', valid: 'mv.docStatusValid', not_set: 'mv.docStatusNotSet',
}

const emptyBusForm = { category_id: '', model: '', color: '', vehicle_number: '', total_seats: '', has_ac: false, model_year: '', primary_driver_fleet_staff_id: '' }

// 2026-11-17: real complaint — "how to know which driver is where
// from this window during selecting driver?" A bare name + a route
// count gave no indication of which vehicle a driver actually drives
// or what route it's currently running.
function driverWhereLabel(d: FleetDriver, t: (k: string) => string): string {
  if (!d.primary_vehicle_number) return t('mv.noVehicleAssignedHint')
  return d.primary_route_label ? `${d.primary_vehicle_number} · ${d.primary_route_label}` : `${d.primary_vehicle_number} · ${t('mv.noActiveRouteHint')}`
}

export default function FleetVehiclesPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [settingsVehicle, setSettingsVehicle] = useState<FleetVehicle | null>(null)
  const [categories, setCategories] = useState<VehicleCategory[]>([])
  const [drivers, setDrivers] = useState<FleetDriver[]>([])
  const [showAddBus, setShowAddBus] = useState(false)
  const [busForm, setBusForm] = useState(emptyBusForm)
  const [savingBus, setSavingBus] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleRow[]>([])
  const [openMaintenance, setOpenMaintenance] = useState<Set<string>>(new Set())
  const [docs, setDocs] = useState<VehicleDocRow[]>([])

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string } | null
    setFleetId(f?.fleet_id ?? null)
    if (f) {
      const [{ data: v }, { data: cats }, { data: drv }, { data: sched }, { data: maint }, { data: docRows }] = await Promise.all([
        supabase.rpc('my_fleet_vehicles'),
        supabase.from('vehicle_categories').select('id, name').eq('is_active', true).in('name', ['Bus', 'Coaster']),
        supabase.rpc('my_fleet_drivers', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_vehicle_schedule', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_maintenance_orders', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_vehicle_documents', { p_fleet_id: f.fleet_id }),
      ])
      setVehicles((v ?? []) as FleetVehicle[])
      setCategories((cats ?? []) as VehicleCategory[])
      setDrivers((drv ?? []) as FleetDriver[])
      setSchedule((sched ?? []) as ScheduleRow[])
      setOpenMaintenance(new Set(((maint ?? []) as MaintenanceOrder[]).filter((m) => m.status !== 'completed').map((m) => m.vehicle_id)))
      setDocs((docRows ?? []) as VehicleDocRow[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // 888: "Add a bus" used to link to the driver-invite page — confirmed
  // live, that only lets someone ELSE self-register their own vehicle.
  // This creates the vehicle directly, right now, owner-authored.
  const createBus = async () => {
    if (!busForm.category_id || !busForm.total_seats) { toast.error(t('mv.busCategorySeatsRequiredError')); return }
    setSavingBus(true)
    const { error } = await supabase.rpc('create_fleet_vehicle_direct', {
      p_fleet_id: fleetId, p_category_id: busForm.category_id, p_model: busForm.model || null, p_color: busForm.color || null,
      p_vehicle_number: busForm.vehicle_number || null, p_total_seats: Number(busForm.total_seats), p_has_ac: busForm.has_ac,
      p_model_year: busForm.model_year ? Number(busForm.model_year) : null, p_primary_driver_fleet_staff_id: busForm.primary_driver_fleet_staff_id || null,
    })
    setSavingBus(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.busAddedToast'))
    setShowAddBus(false)
    setBusForm(emptyBusForm)
    load()
  }

  // 893: the actual fix for "there is no way staff can add the driver
  // for a route" — a vehicle's driver was previously fixed forever to
  // whoever happened to self-register it. Now a real, repeatable
  // reassignment, owner/non-driver-staff only (can_administer_vehicle).
  const reassignDriver = async (vehicleId: string, fleetStaffId: string) => {
    if (!fleetStaffId) return
    const { error } = await supabase.rpc('set_vehicle_primary_driver', { p_vehicle_id: vehicleId, p_fleet_staff_id: fleetStaffId })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.driverReassignedToast'))
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Bus size={19} /> {t('mv.busManagementHeading')}</h1>
        <button onClick={() => setShowAddBus(true)} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer">
          <Plus size={13} /> {t('mv.addBusBtn')}
        </button>
      </div>
      <p className="font-sans text-[11px] text-[#64748b] -mt-2">{t('mv.addBusHint')}</p>
      <Link href="/portal/fleet/invite" className="font-sans text-[11.5px] font-semibold text-[#166534] -mt-1.5">{t('mv.inviteDriverHeading')} →</Link>

      <div className="grid grid-cols-2 gap-2.5">
        <FleetStat label={t('mv.statTotalVehiclesLabel')} value={vehicles.length} icon={<Bus size={12} />} />
        <FleetStat label={t('mv.statAvailableForScheduleLabel')} value={vehicles.filter((v) => availabilityFor(v.id, schedule, openMaintenance) === 'available').length} />
        <FleetStat label={t('mv.statInMaintenanceLabel')} value={vehicles.filter((v) => openMaintenance.has(v.id)).length} valueClassName="text-[#b45309]" />
        <FleetStat label={t('mv.statDocsExpiringLabel')} value={vehicles.filter((v) => ['expiring_soon', 'expired'].includes(docStateFor(v.id, docs))).length} valueClassName="text-[#b91c1c]" />
      </div>

      <FleetPanel>
        <FleetPanelHead icon={<Bus size={14} />} title={t('mv.busManagementHeading')} description={t('mv.panelDesc.vehicles')}
          action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{vehicles.length}</span>} />
      {vehicles.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noVehiclesYetHint')}</p>
      ) : (
        <div className="flex flex-col divide-y divide-[#f1f5f9]">
          {vehicles.map((v) => (
            <div key={v.id} className="px-3.5 py-3">
              {/* 2026-11-16: real complaint — "Bus Management" showed the
                  driver's personal name as the bus's primary identifier.
                  A bus is identified by its registration first, same
                  rule fleet/drivers (875) already follows; the driver's
                  name moves to the secondary line. */}
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-lg bg-[#F0FDF4] text-[#166534] flex items-center justify-center shrink-0"><Bus size={15} /></span>
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate ltr-num">{v.vehicle_number || v.vehicle_type}</p>
                  <p className="font-sans text-[11.5px] text-[#64748b]">
                    {v.category_name || v.vehicle_type} · {v.owner_name}
                    {v.total_seats != null && ` · ${t(v.is_sleeper ? 'mv.berthsSleeperSuffixLabel' : 'mv.seatsSuffixLabel').replace('{n}', String(v.total_seats))}`}
                    {v.has_ac && <span className="inline-flex items-center gap-0.5 ms-1 text-[#1d4ed8]"><Snowflake size={10} className="inline" /> {t('mv.acBadgeLabel')}</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <FleetStatusPill tone={DOC_TONE[docStateFor(v.id, docs)]}>{t(DOC_LABEL_KEY[docStateFor(v.id, docs)])}</FleetStatusPill>
                <FleetStatusPill tone={AVAIL_TONE[availabilityFor(v.id, schedule, openMaintenance)]}>{t(AVAIL_LABEL_KEY[availabilityFor(v.id, schedule, openMaintenance)])}</FleetStatusPill>
              </div>
              {drivers.length > 0 && (
                <select value={drivers.find((d) => d.portal_user_id === v.portal_user_id)?.id ?? ''} onChange={(e) => reassignDriver(v.id, e.target.value)}
                  className="mt-2 w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px]">
                  <option value="">{t('mv.noDriverYetOption')}</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name} · {driverWhereLabel(d, t)}</option>)}
                </select>
              )}
              <div className="flex gap-2 mt-2.5">
                {/* Real bug reported live: this used to navigate clean out
                    of the Fleet shell into my-vehicle's own layout — a
                    different bottom nav entirely — for what's really just
                    a settings form. Opens in place now. "Routes" stays a
                    real page link: that destination is a 1300+ line
                    multi-section screen (stops, schedule, bookings,
                    luggage, ride-group) too large to fold into a popup
                    responsibly in this pass. */}
                <button onClick={() => setSettingsVehicle(v)} className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer">
                  <Settings2 size={13} /> {t('mv.vehicleSettingsBtn')}
                </button>
                <Link href={`/portal/my-vehicle/routes?vehicle=${v.id}`} className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534]">
                  <Milestone size={13} /> {t('mv.manageRoutesBtn')}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
      </FleetPanel>

      {settingsVehicle && (
        <MobilityBottomSheet title={`${t('mv.vehicleSettingsBtn')} · ${settingsVehicle.owner_name}`} onClose={() => setSettingsVehicle(null)}>
          <VehicleCatalogForm vehicleId={settingsVehicle.id} showHeading={false} />
        </MobilityBottomSheet>
      )}

      {showAddBus && (
        <MobilityBottomSheet title={t('mv.addBusBtn')} onClose={() => setShowAddBus(false)}>
          <FleetFormGrid>
            <FleetFormField label={t('mv.vehicleCategoryLabel')} full>
              <select value={busForm.category_id} onChange={(e) => setBusForm({ ...busForm, category_id: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">—</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FleetFormField>
            <FleetFormField label={t('vr.modelSearchPlaceholder')}>
              <input value={busForm.model} onChange={(e) => setBusForm({ ...busForm, model: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('vr.colorPlaceholder')}>
              <input value={busForm.color} onChange={(e) => setBusForm({ ...busForm, color: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('vr.vehicleNumberPlaceholder')}>
              <input value={busForm.vehicle_number} onChange={(e) => setBusForm({ ...busForm, vehicle_number: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('mv.modelYearLabel')}>
              <input type="number" value={busForm.model_year} onChange={(e) => setBusForm({ ...busForm, model_year: e.target.value })} placeholder="2022" className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('vr.totalSeatsPlaceholder')}>
              <input type="number" value={busForm.total_seats} onChange={(e) => setBusForm({ ...busForm, total_seats: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <div className="flex items-end min-w-0">
              <label className="flex items-center gap-2 font-sans text-[12.5px] text-[#1e293b] pb-2.5">
                <input type="checkbox" checked={busForm.has_ac} onChange={(e) => setBusForm({ ...busForm, has_ac: e.target.checked })} className="accent-[#166534]" /> {t('mv.hasAcLabel')}
              </label>
            </div>
            <FleetFormField label={t('mv.primaryDriverLabel')} full>
              <select value={busForm.primary_driver_fleet_staff_id} onChange={(e) => setBusForm({ ...busForm, primary_driver_fleet_staff_id: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">{t('mv.noDriverYetOption')}</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name} · {driverWhereLabel(d, t)}</option>)}
              </select>
              <p className="font-sans text-[10px] text-[#94a3b8] mt-1">{t('mv.addDriverFirstHint')}</p>
            </FleetFormField>
            <button onClick={createBus} disabled={savingBus} className="col-span-2 w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
              {savingBus ? t('action.saving') : t('action.save')}
            </button>
          </FleetFormGrid>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
