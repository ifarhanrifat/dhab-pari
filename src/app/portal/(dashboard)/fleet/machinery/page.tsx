'use client'

// 980: the machinery operational layer — a fleet admin running several
// machines (excavators, loaders, tractors) couldn't see requests across
// the whole fleet (only the one specific machine's own bound driver
// account ever got notified), had no live "which machine is free, which
// is busy until when" board, and had no self-service way to add a new
// machine the way a bus fleet owner already can. Mirrors fleet/vehicles'
// own "Add a bus" pattern exactly, for machinery instead.

import { useEffect, useState } from 'react'
import { Construction, Plus, Clock3, CircleDot, Settings2, Trash2 } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetFormGrid, FleetFormField, FleetStat, FleetStatusPill } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { BookingLifecycleSheet } from '@/components/mobility/BookingLifecycleSheet'

interface Category { id: string; key: string; name: string }
interface Driver { id: string; portal_user_id: string; full_name: string }
interface AvailabilityRow {
  vehicle_id: string; owner_name: string; vehicle_type: string; model: string | null; vehicle_number: string | null
  offers_machinery: boolean; offers_tractor: boolean; offers_loader: boolean
  status: 'free' | 'in_progress' | 'committed'
  current_booking: { id: string; kind: string; site_address: string; customer_name: string; started_at: string; estimated_free_at: string | null } | null
  next_scheduled: { id: string; kind: string; site_address: string; customer_name: string; scheduled_date: string; scheduled_time: string | null } | null
}
interface RequestRow {
  id: string; vehicle_id: string; vehicle_label: string; kind: string; site_address: string; requested_hours: number | null
  rate_pkr: number; mobilization_fee_pkr: number; customer_name: string; scheduled_date: string | null; scheduled_time: string | null; requested_at: string
}
interface TractorService { id: string; service_key: string; name_en: string; name_ur: string; rate_pkr: number; unit: string }
const emptyService = { name_en: '', name_ur: '', rate_pkr: '' }

const emptyMachineForm = {
  category_id: '', model: '', color: '', vehicle_number: '', model_year: '', primary_driver_fleet_staff_id: '',
  offers_machinery: false, machinery_hourly_rate_pkr: '', machinery_min_hours: '', machinery_mobilization_fee_pkr: '',
  offers_tractor: false, offers_loader: false, loader_trip_rate_pkr: '',
}

const STATUS_TONE: Record<string, 'green' | 'blue' | 'amber'> = { free: 'green', in_progress: 'blue', committed: 'amber' }
const STATUS_KEY: Record<string, string> = { free: 'mv.machineFreeLabel', in_progress: 'mv.machineBusyLabel', committed: 'mv.machineCommittedLabel' }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function FleetMachineryPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [availability, setAvailability] = useState<AvailabilityRow[]>([])
  const [requests, setRequests] = useState<RequestRow[]>([])
  const [openBooking, setOpenBooking] = useState<{ id: string; vehicleId: string } | null>(null)

  const [showAddMachine, setShowAddMachine] = useState(false)
  const [machineForm, setMachineForm] = useState(emptyMachineForm)
  const [savingMachine, setSavingMachine] = useState(false)

  // 982: tractor_services RLS now also allows can_manage_vehicle(), so a
  // fleet owner can set a tractor's per-service rates themselves — the
  // exact same upsert pattern the admin page's own saveTractorService
  // already uses, just reachable from the portal now.
  const [servicesVehicle, setServicesVehicle] = useState<{ vehicle_id: string; label: string } | null>(null)
  const [services, setServices] = useState<TractorService[]>([])
  const [newService, setNewService] = useState(emptyService)
  const [savingService, setSavingService] = useState(false)

  const loadServices = async (vehicleId: string) => {
    const { data } = await supabase.from('tractor_services').select('id, service_key, name_en, name_ur, rate_pkr, unit').eq('vehicle_id', vehicleId)
    setServices((data ?? []) as TractorService[])
  }
  const openServices = (vehicleId: string, label: string) => {
    setServicesVehicle({ vehicle_id: vehicleId, label })
    setNewService(emptyService)
    loadServices(vehicleId)
  }
  const saveService = async () => {
    if (!servicesVehicle || !newService.name_en.trim() || !newService.name_ur.trim() || !newService.rate_pkr) return
    setSavingService(true)
    const serviceKey = newService.name_en.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
    const { error } = await supabase.from('tractor_services')
      .upsert({ vehicle_id: servicesVehicle.vehicle_id, service_key: serviceKey, name_en: newService.name_en.trim(), name_ur: newService.name_ur.trim(), rate_pkr: Number(newService.rate_pkr), unit: 'hour' }, { onConflict: 'vehicle_id,service_key' })
    setSavingService(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.serviceAddedToast'))
    setNewService(emptyService)
    loadServices(servicesVehicle.vehicle_id)
  }
  const deleteService = async (id: string) => {
    if (!servicesVehicle) return
    await supabase.from('tractor_services').delete().eq('id', id)
    loadServices(servicesVehicle.vehicle_id)
  }

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string } | null
    setFleetId(f?.fleet_id ?? null)
    if (f) {
      const [{ data: cats }, { data: drv }, { data: avail }, { data: reqs }] = await Promise.all([
        supabase.from('vehicle_categories').select('id, key, name').eq('is_active', true).in('key', ['machinery', 'tractor', 'loader']),
        supabase.rpc('my_fleet_drivers', { p_fleet_id: f.fleet_id }),
        supabase.rpc('equipment_fleet_availability', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_equipment_bookings', { p_fleet_id: f.fleet_id, p_status: 'requested' }),
      ])
      setCategories((cats ?? []) as Category[])
      setDrivers((drv ?? []) as Driver[])
      setAvailability((avail ?? []) as AvailabilityRow[])
      setRequests((reqs ?? []) as RequestRow[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const selectedCategory = categories.find((c) => c.id === machineForm.category_id)

  const createMachine = async () => {
    if (!machineForm.category_id) { toast.error(t('mv.busCategorySeatsRequiredError')); return }
    setSavingMachine(true)
    const { data: newVehicleId, error } = await supabase.rpc('create_fleet_vehicle_direct', {
      p_fleet_id: fleetId, p_category_id: machineForm.category_id, p_model: machineForm.model || null, p_color: machineForm.color || null,
      p_vehicle_number: machineForm.vehicle_number || null, p_total_seats: 1, p_has_ac: false,
      p_model_year: machineForm.model_year ? Number(machineForm.model_year) : null, p_primary_driver_fleet_staff_id: machineForm.primary_driver_fleet_staff_id || null,
      p_offers_machinery: selectedCategory?.key === 'machinery', p_machinery_hourly_rate_pkr: machineForm.machinery_hourly_rate_pkr ? Number(machineForm.machinery_hourly_rate_pkr) : null,
      p_machinery_min_hours: machineForm.machinery_min_hours ? Number(machineForm.machinery_min_hours) : null,
      p_machinery_mobilization_fee_pkr: machineForm.machinery_mobilization_fee_pkr ? Number(machineForm.machinery_mobilization_fee_pkr) : null,
      p_offers_tractor: selectedCategory?.key === 'tractor', p_offers_loader: selectedCategory?.key === 'loader',
      p_loader_trip_rate_pkr: machineForm.loader_trip_rate_pkr ? Number(machineForm.loader_trip_rate_pkr) : null,
    })
    setSavingMachine(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.machineAddedToast'))
    setShowAddMachine(false)
    const addedTractor = selectedCategory?.key === 'tractor'
    const addedModel = machineForm.model
    setMachineForm(emptyMachineForm)
    load()
    // A brand-new tractor has zero services and can't be booked at all
    // until at least one is added — open that sheet immediately instead
    // of leaving it to a separate, easy-to-forget step.
    if (addedTractor && typeof newVehicleId === 'string') openServices(newVehicleId, addedModel || t('mv.fleetMachineryHeading'))
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Construction size={19} /> {t('mv.fleetMachineryHeading')}</h1>
        <button onClick={() => setShowAddMachine(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer shrink-0">
          <Plus size={13} /> {t('mv.addMachineBtn')}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <FleetStat label={t('mv.statTotalMachinesLabel')} value={availability.length} icon={<Construction size={12} />} />
        <FleetStat label={t('mv.statMachinesFreeLabel')} value={availability.filter((a) => a.status === 'free').length} valueClassName="text-[#166534]" />
        <FleetStat label={t('mv.statPendingRequestsLabel')} value={requests.length} valueClassName={requests.length > 0 ? 'text-[#b45309]' : undefined} />
      </div>

      <FleetPanel>
        <FleetPanelHead icon={<CircleDot size={14} />} title={t('mv.machineryBoardHeading')} description={t('mv.panelDesc.machineryBoard')} />
        {availability.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noMachinesYetHint')}</p>
        ) : (
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {availability.map((a) => (
              <div key={a.vehicle_id} className="px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate">{a.model || a.vehicle_type}</p>
                    <p className="font-sans text-[11.5px] text-[#64748b]">{a.vehicle_type} · {a.owner_name}</p>
                  </div>
                  <FleetStatusPill tone={STATUS_TONE[a.status]}>{t(STATUS_KEY[a.status])}</FleetStatusPill>
                </div>
                {/* Real gap caught live: once a request is accepted it
                    drops off the Requests panel below (status is no
                    longer 'requested'), and this line used to be plain
                    text — on a fresh page load there was then no way
                    back into that booking's sheet at all to reassign,
                    report a delay, or chat. Both lines now reopen the
                    same BookingLifecycleSheet the Requests panel uses. */}
                {a.current_booking && (
                  <button onClick={() => setOpenBooking({ id: a.current_booking!.id, vehicleId: a.vehicle_id })}
                    className="w-full text-left font-sans text-[11.5px] text-[#64748b] mt-1.5 flex items-center gap-1 cursor-pointer hover:text-[#166534]">
                    <Clock3 size={11} />
                    {a.current_booking.site_address} · {a.current_booking.customer_name}
                    {a.current_booking.estimated_free_at && ` · ${t('mv.freeAroundLabel')} ${new Date(a.current_booking.estimated_free_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
                  </button>
                )}
                {!a.current_booking && a.next_scheduled && (
                  <button onClick={() => setOpenBooking({ id: a.next_scheduled!.id, vehicleId: a.vehicle_id })}
                    className="w-full text-left font-sans text-[11.5px] text-[#64748b] mt-1.5 flex items-center gap-1 cursor-pointer hover:text-[#166534]">
                    <Clock3 size={11} />
                    {t('mv.nextJobLabel')}: {a.next_scheduled.site_address} — {a.next_scheduled.scheduled_date}{a.next_scheduled.scheduled_time ? ` ${a.next_scheduled.scheduled_time.slice(0, 5)}` : ''}
                  </button>
                )}
                {a.offers_tractor && (
                  <button onClick={() => openServices(a.vehicle_id, a.model || a.vehicle_type)}
                    className="flex items-center gap-1.5 mt-2 px-2.5 py-1 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">
                    <Settings2 size={11} /> {t('mv.manageServicesBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </FleetPanel>

      <FleetPanel>
        <FleetPanelHead icon={<Construction size={14} />} title={t('mv.machineryPendingRequestsHeading')} description={t('mv.panelDesc.machineryRequests')}
          action={requests.length > 0 ? <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-sans text-[10px] font-bold ltr-num">{requests.length}</span> : undefined} />
        {requests.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noPendingRequestsHint')}</p>
        ) : (
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {requests.map((r) => (
              <button key={r.id} onClick={() => setOpenBooking({ id: r.id, vehicleId: r.vehicle_id })}
                className="px-3.5 py-3 text-left cursor-pointer flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-[13px] font-bold text-[#1e293b] truncate">{r.vehicle_label} · {r.customer_name}</p>
                  <p className="font-sans text-[11.5px] text-[#64748b] truncate">{r.site_address}</p>
                </div>
                <span className="font-sans text-[13px] font-bold text-[#166534] ltr-num shrink-0">₨{fmt(r.rate_pkr)}</span>
              </button>
            ))}
          </div>
        )}
      </FleetPanel>

      {openBooking && (
        <BookingLifecycleSheet kind="equipment" bookingId={openBooking.id} vehicleId={openBooking.vehicleId} commissionMode="per_order"
          onClose={() => setOpenBooking(null)} onChanged={load} />
      )}

      {servicesVehicle && (
        <MobilityBottomSheet title={`${t('mv.tractorServicesHeading')} · ${servicesVehicle.label}`} onClose={() => setServicesVehicle(null)}>
          <div className="flex flex-col gap-3">
            {services.length === 0 ? (
              <p className="font-sans text-[12.5px] text-[#94a3b8] text-center py-4">{t('mv.noServicesYetHint')}</p>
            ) : (
              <div className="flex flex-col divide-y divide-[#f1f5f9]">
                {services.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate">{s.name_en}</p>
                      <p className="font-sans text-[11px] text-[#64748b] ltr-num">₨{fmt(s.rate_pkr)} / {s.unit}</p>
                    </div>
                    <button onClick={() => deleteService(s.id)} className="p-1.5 rounded-lg text-[#b91c1c] cursor-pointer shrink-0"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-2 pt-2 border-t border-[#f1f5f9]">
              <div className="flex gap-2">
                <input value={newService.name_en} onChange={(e) => setNewService({ ...newService, name_en: e.target.value })} placeholder={t('mk.tractorServiceNamePlaceholder')} className="flex-1 min-w-0 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                <input value={newService.name_ur} onChange={(e) => setNewService({ ...newService, name_ur: e.target.value })} placeholder={t('mk.tractorServiceNameUrPlaceholder')} dir="rtl" className="flex-1 min-w-0 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </div>
              <div className="flex gap-2">
                <input type="number" value={newService.rate_pkr} onChange={(e) => setNewService({ ...newService, rate_pkr: e.target.value })} placeholder={t('mk.tractorServiceRatePlaceholder')} className="flex-1 min-w-0 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                <button onClick={saveService} disabled={savingService || !newService.name_en.trim() || !newService.name_ur.trim() || !newService.rate_pkr}
                  className="px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50 shrink-0">
                  {t('action.save')}
                </button>
              </div>
            </div>
          </div>
        </MobilityBottomSheet>
      )}

      {showAddMachine && (
        <MobilityBottomSheet title={t('mv.addMachineBtn')} onClose={() => setShowAddMachine(false)}>
          <FleetFormGrid>
            <FleetFormField label={t('mv.vehicleCategoryLabel')} full>
              <select value={machineForm.category_id} onChange={(e) => setMachineForm({ ...machineForm, category_id: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">—</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FleetFormField>
            <FleetFormField label={t('vr.modelSearchPlaceholder')}>
              <input value={machineForm.model} onChange={(e) => setMachineForm({ ...machineForm, model: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('vr.vehicleNumberPlaceholder')}>
              <input value={machineForm.vehicle_number} onChange={(e) => setMachineForm({ ...machineForm, vehicle_number: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>

            {selectedCategory?.key === 'machinery' && (
              <>
                <FleetFormField label={t('mv.machineryHourlyRateLabel')}>
                  <input type="number" value={machineForm.machinery_hourly_rate_pkr} onChange={(e) => setMachineForm({ ...machineForm, machinery_hourly_rate_pkr: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                </FleetFormField>
                <FleetFormField label={t('mv.machineryMinHoursLabel')}>
                  <input type="number" value={machineForm.machinery_min_hours} onChange={(e) => setMachineForm({ ...machineForm, machinery_min_hours: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                </FleetFormField>
                <FleetFormField label={t('mv.machineryMobilizationFeeLabel')} full>
                  <input type="number" value={machineForm.machinery_mobilization_fee_pkr} onChange={(e) => setMachineForm({ ...machineForm, machinery_mobilization_fee_pkr: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                </FleetFormField>
              </>
            )}
            {selectedCategory?.key === 'loader' && (
              <FleetFormField label={t('mv.loaderTripRateLabel')} full>
                <input type="number" value={machineForm.loader_trip_rate_pkr} onChange={(e) => setMachineForm({ ...machineForm, loader_trip_rate_pkr: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </FleetFormField>
            )}
            {selectedCategory?.key === 'tractor' && (
              <p className="col-span-2 font-sans text-[11px] text-[#94a3b8]">{t('mv.tractorServicesAfterAddHint')}</p>
            )}

            <FleetFormField label={t('mv.primaryDriverLabel')} full>
              <select value={machineForm.primary_driver_fleet_staff_id} onChange={(e) => setMachineForm({ ...machineForm, primary_driver_fleet_staff_id: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">{t('mv.noDriverYetOption')}</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
              </select>
              <p className="font-sans text-[10px] text-[#94a3b8] mt-1">{t('mv.addDriverFirstHint')}</p>
            </FleetFormField>
            <button onClick={createMachine} disabled={savingMachine} className="col-span-2 w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
              {savingMachine ? t('action.saving') : t('action.save')}
            </button>
          </FleetFormGrid>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
