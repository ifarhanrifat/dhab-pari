'use client'

// 864/865: "Bus Management" — a fleet owner/staff member could only ever
// edit the catalog settings (color/model/AC/sleeper/hourly-shadi-rental
// toggles, photos) of a vehicle they personally drive, through any
// screen, confirmed live. This lists every fleet vehicle and links each
// into catalog/page.tsx's now-widened ?vehicle=<id> fetch-by-id path.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Bus, Plus, Milestone, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { VehicleCatalogForm } from '@/components/mobility/VehicleCatalogForm'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
interface VehicleCategory { id: string; name: string }
interface FleetDriver { id: string; full_name: string; routes_assigned_count: number }

const emptyBusForm = { category_id: '', model: '', color: '', vehicle_number: '', total_seats: '', has_ac: false, model_year: '', primary_driver_fleet_staff_id: '' }

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

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string } | null
    setFleetId(f?.fleet_id ?? null)
    if (f) {
      const [{ data: v }, { data: cats }, { data: drv }] = await Promise.all([
        supabase.rpc('my_fleet_vehicles'),
        supabase.from('vehicle_categories').select('id, name').eq('is_active', true).in('name', ['Bus', 'Coaster']),
        supabase.rpc('my_fleet_drivers', { p_fleet_id: f.fleet_id }),
      ])
      setVehicles((v ?? []) as FleetVehicle[])
      setCategories((cats ?? []) as VehicleCategory[])
      setDrivers((drv ?? []) as FleetDriver[])
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

      {vehicles.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noVehiclesYetHint')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {vehicles.map((v) => (
            <div key={v.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              {/* 2026-11-16: real complaint — "Bus Management" showed the
                  driver's personal name as the bus's primary identifier.
                  A bus is identified by its registration first, same
                  rule fleet/drivers (875) already follows; the driver's
                  name moves to the secondary line. */}
              <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate ltr-num">{v.vehicle_number || v.vehicle_type}</p>
              <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5">{v.vehicle_type} · {v.owner_name}</p>
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

      {settingsVehicle && (
        <MobilityBottomSheet title={`${t('mv.vehicleSettingsBtn')} · ${settingsVehicle.owner_name}`} onClose={() => setSettingsVehicle(null)}>
          <VehicleCatalogForm vehicleId={settingsVehicle.id} showHeading={false} />
        </MobilityBottomSheet>
      )}

      {showAddBus && (
        <MobilityBottomSheet title={t('mv.addBusBtn')} onClose={() => setShowAddBus(false)}>
          <div className="flex flex-col gap-3">
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.vehicleCategoryLabel')}</label>
              <select value={busForm.category_id} onChange={(e) => setBusForm({ ...busForm, category_id: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">—</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('vr.modelSearchPlaceholder')}</label>
                <input value={busForm.model} onChange={(e) => setBusForm({ ...busForm, model: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </div>
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('vr.colorPlaceholder')}</label>
                <input value={busForm.color} onChange={(e) => setBusForm({ ...busForm, color: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('vr.vehicleNumberPlaceholder')}</label>
                <input value={busForm.vehicle_number} onChange={(e) => setBusForm({ ...busForm, vehicle_number: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </div>
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.modelYearLabel')}</label>
                <input type="number" value={busForm.model_year} onChange={(e) => setBusForm({ ...busForm, model_year: e.target.value })} placeholder="2022" className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 items-end">
              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('vr.totalSeatsPlaceholder')}</label>
                <input type="number" value={busForm.total_seats} onChange={(e) => setBusForm({ ...busForm, total_seats: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </div>
              <label className="flex items-center gap-2 font-sans text-[12.5px] text-[#1e293b] pb-2.5">
                <input type="checkbox" checked={busForm.has_ac} onChange={(e) => setBusForm({ ...busForm, has_ac: e.target.checked })} className="accent-[#166534]" /> {t('mv.hasAcLabel')}
              </label>
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.primaryDriverLabel')}</label>
              <select value={busForm.primary_driver_fleet_staff_id} onChange={(e) => setBusForm({ ...busForm, primary_driver_fleet_staff_id: e.target.value })} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                <option value="">{t('mv.noDriverYetOption')}</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name} · {d.routes_assigned_count} {t('mv.routesAssignedSuffix')}</option>)}
              </select>
              <p className="font-sans text-[10px] text-[#94a3b8] mt-1">{t('mv.addDriverFirstHint')}</p>
            </div>
            <button onClick={createBus} disabled={savingBus} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
              {savingBus ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
