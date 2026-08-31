'use client'

// Marketplace phase 2 — admin catalog CRUD for vehicles + their routes.
// A vehicle is staff-listed (a driver/owner asks the committee to be
// listed). Booking/checkout land in phase 3 once place_ride_booking()/
// confirm_ride_booking() exist. Same two-level shape as shops/page.tsx and
// academy-fees/page.tsx: one `selected` piece of state switches between
// the parent grid and the detail panel, everything else is a modal.
//
// A route has no trip/calendar table of its own — it's a recurring
// schedule (which days it runs); how many seats are left on any given
// travel date is computed live from ride_bookings once phase 3 exists,
// the same way training_batches_for_join() already computes spots_left.
// This page only manages the schedule itself, not bookings against it.

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Bus, PlusCircle, X, Pencil, Trash2, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSystemAccess } from '@/hooks/useSystemAccess'

interface Vehicle {
  id: string; owner_name: string; owner_mobile: string | null; owner_whatsapp: string | null
  vehicle_type: string; vehicle_number: string | null; total_seats: number; is_active: boolean
}
interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_per_seat_pkr: number; departure_time: string | null; days_of_week: number[]; is_active: boolean
}

const emptyVehicle = { owner_name: '', owner_mobile: '', owner_whatsapp: '', vehicle_type: '', vehicle_number: '', total_seats: 4, is_active: true }
const emptyRoute = {
  origin: '', origin_ur: '', destination: '', destination_ur: '', classification: 'intercity',
  fare_per_seat_pkr: 0, departure_time: '', days_of_week: [0, 1, 2, 3, 4, 5, 6] as number[], is_active: true,
}

const DAY_KEYS = ['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat']

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function AdminVehiclesPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <AdminVehiclesInner />
    </Suspense>
  )
}

function AdminVehiclesInner() {
  const { t, isUrdu } = useLocale()
  const searchParams = useSearchParams()
  const access = useSystemAccess()
  const supabase = createClient()

  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [routeCountByVehicle, setRouteCountByVehicle] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Vehicle | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])

  const [showVehicleForm, setShowVehicleForm] = useState(false)
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null)
  const [vehicleForm, setVehicleForm] = useState(emptyVehicle)

  const [showRouteForm, setShowRouteForm] = useState(false)
  const [editingRoute, setEditingRoute] = useState<Route | null>(null)
  const [routeForm, setRouteForm] = useState(emptyRoute)

  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data } = await supabase.from('vehicles').select('*').order('owner_name')
    setVehicles(data ?? [])
    if (data && data.length > 0) {
      const { data: allRoutes } = await supabase.from('vehicle_routes').select('id, vehicle_id').in('vehicle_id', data.map((v) => v.id))
      const counts: Record<string, number> = {}
      for (const r of allRoutes ?? []) counts[r.vehicle_id] = (counts[r.vehicle_id] ?? 0) + 1
      setRouteCountByVehicle(counts)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    const vehicleParam = searchParams.get('vehicle')
    if (!vehicleParam || vehicles.length === 0) return
    const v = vehicles.find((x) => x.id === vehicleParam)
    if (v) openVehicle(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles.length, searchParams])

  const loadRoutes = async (vehicleId: string) => {
    const { data } = await supabase.from('vehicle_routes').select('*').eq('vehicle_id', vehicleId).order('origin')
    setRoutes(data ?? [])
  }

  const openVehicle = (v: Vehicle) => { setSelected(v); loadRoutes(v.id) }

  const openNewVehicle = () => { setEditingVehicle(null); setVehicleForm(emptyVehicle); setShowVehicleForm(true) }
  const openEditVehicle = (v: Vehicle) => {
    setEditingVehicle(v)
    setVehicleForm({
      owner_name: v.owner_name, owner_mobile: v.owner_mobile ?? '', owner_whatsapp: v.owner_whatsapp ?? '',
      vehicle_type: v.vehicle_type, vehicle_number: v.vehicle_number ?? '', total_seats: v.total_seats, is_active: v.is_active,
    })
    setShowVehicleForm(true)
  }

  const saveVehicle = async () => {
    if (!vehicleForm.owner_name.trim() || !vehicleForm.vehicle_type.trim()) { toast.error(t('mk.nameRequired')); return }
    setSaving(true)
    const payload = { ...vehicleForm, owner_mobile: vehicleForm.owner_mobile || null, owner_whatsapp: vehicleForm.owner_whatsapp || null, vehicle_number: vehicleForm.vehicle_number || null }
    const { error } = editingVehicle
      ? await supabase.from('vehicles').update(payload).eq('id', editingVehicle.id)
      : await supabase.from('vehicles').insert(payload)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.vehicleSaved'))
    setShowVehicleForm(false)
    load()
    if (selected && editingVehicle) setSelected({ ...selected, ...payload })
  }

  const deleteVehicle = async (v: Vehicle) => {
    if (!confirm(t('mk.confirmDeleteVehicle'))) return
    const { error } = await supabase.from('vehicles').delete().eq('id', v.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.vehicleDeleted'))
    if (selected?.id === v.id) setSelected(null)
    load()
  }

  const openNewRoute = () => { setEditingRoute(null); setRouteForm(emptyRoute); setShowRouteForm(true) }
  const openEditRoute = (r: Route) => {
    setEditingRoute(r)
    setRouteForm({
      origin: r.origin, origin_ur: r.origin_ur ?? '', destination: r.destination, destination_ur: r.destination_ur ?? '',
      classification: r.classification, fare_per_seat_pkr: r.fare_per_seat_pkr, departure_time: r.departure_time ?? '',
      days_of_week: r.days_of_week, is_active: r.is_active,
    })
    setShowRouteForm(true)
  }

  const toggleDay = (d: number) => {
    setRouteForm((f) => ({ ...f, days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter((x) => x !== d) : [...f.days_of_week, d].sort() }))
  }

  const saveRoute = async () => {
    if (!selected || !routeForm.origin.trim() || !routeForm.destination.trim()) { toast.error(t('mk.nameRequired')); return }
    if (routeForm.days_of_week.length === 0) { toast.error(t('mk.pickAtLeastOneDay')); return }
    setSaving(true)
    const payload = {
      vehicle_id: selected.id, origin: routeForm.origin, origin_ur: routeForm.origin_ur || null,
      destination: routeForm.destination, destination_ur: routeForm.destination_ur || null,
      classification: routeForm.classification, fare_per_seat_pkr: routeForm.fare_per_seat_pkr,
      departure_time: routeForm.departure_time || null, days_of_week: routeForm.days_of_week, is_active: routeForm.is_active,
    }
    const { error } = editingRoute
      ? await supabase.from('vehicle_routes').update(payload).eq('id', editingRoute.id)
      : await supabase.from('vehicle_routes').insert(payload)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.routeSaved'))
    setShowRouteForm(false)
    loadRoutes(selected.id)
    load()
  }

  const deleteRoute = async (r: Route) => {
    if (!confirm(t('mk.confirmDeleteRoute'))) return
    const { error } = await supabase.from('vehicle_routes').delete().eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.routeDeleted'))
    if (selected) loadRoutes(selected.id)
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('dn.noAccessMessage')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      {!selected ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
            <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2"><Bus size={24} /> {t('mk.vehiclesTitle')}</h1>
            <button onClick={openNewVehicle} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('mk.newVehicleBtn')}</button>
          </div>

          {loading && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('action.loading')}</p>}
          {!loading && vehicles.length === 0 && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('mk.noVehiclesYet')}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {vehicles.map((v) => (
              <button key={v.id} onClick={() => openVehicle(v)} className="text-start bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-colors cursor-pointer">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-sans text-[15px] font-bold text-dp-on-surface truncate">{v.owner_name}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{v.vehicle_type}{v.vehicle_number ? ` · ${v.vehicle_number}` : ''}</p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${v.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                    {v.is_active ? t('mk.active') : t('mk.inactive')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-3">
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{v.total_seats} {t('mk.seatsLabel')}</span>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{routeCountByVehicle[v.id] ?? 0} {t('mk.routesCount')}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
            <div>
              <button onClick={() => setSelected(null)} className="font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer mb-1">{t('mk.backToVehicles')}</button>
              <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary">{selected.owner_name}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => openEditVehicle(selected)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container"><Pencil size={14} /> {t('mk.editVehicleBtn')}</button>
              <button onClick={openNewRoute} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('mk.newRouteBtn')}</button>
            </div>
          </div>

          {routes.length === 0 && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('mk.noRoutesYet')}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {routes.map((r) => (
              <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface flex items-center gap-1.5">
                    <MapPin size={14} className="text-dp-secondary shrink-0" />
                    {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}
                  </p>
                  <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${r.classification === 'intercity' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'}`}>
                    {r.classification === 'intercity' ? t('mk.intercity') : t('mk.outOfCity')}
                  </span>
                </div>
                <p className="font-sans text-[15px] font-bold text-dp-secondary mt-1.5">{fmt(r.fare_per_seat_pkr)} <span className="font-normal text-dp-on-surface-variant text-[12px]">{t('mk.perSeat')}</span></p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                  {r.departure_time ? r.departure_time.slice(0, 5) : t('mk.noFixedTime')}
                  {' · '}
                  {r.days_of_week.length === 7 ? t('mk.everyDay') : r.days_of_week.map((d) => t(DAY_KEYS[d])).join(', ')}
                </p>
                {!r.is_active && <span className="inline-block mt-1.5 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('mk.inactive')}</span>}
                <div className="flex items-center gap-1 mt-2 pt-2 border-t border-dp-outline-variant/60">
                  <button onClick={() => openEditRoute(r)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={14} /></button>
                  <button onClick={() => deleteRoute(r)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {showVehicleForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowVehicleForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingVehicle ? t('mk.editVehicleBtn') : t('mk.newVehicleBtn')}</h2>
              <button onClick={() => setShowVehicleForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input value={vehicleForm.owner_name} onChange={(e) => setVehicleForm({ ...vehicleForm, owner_name: e.target.value })} placeholder={t('mk.ownerNamePlaceholder')} className="input-field" />
              <div className="grid grid-cols-2 gap-3">
                <input value={vehicleForm.owner_mobile} onChange={(e) => setVehicleForm({ ...vehicleForm, owner_mobile: e.target.value })} placeholder={t('a.phone')} className="input-field" />
                <input value={vehicleForm.owner_whatsapp} onChange={(e) => setVehicleForm({ ...vehicleForm, owner_whatsapp: e.target.value })} placeholder={t('w.whatsapp')} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={vehicleForm.vehicle_type} onChange={(e) => setVehicleForm({ ...vehicleForm, vehicle_type: e.target.value })} placeholder={t('mk.vehicleTypePlaceholder')} className="input-field" />
                <input value={vehicleForm.vehicle_number} onChange={(e) => setVehicleForm({ ...vehicleForm, vehicle_number: e.target.value })} placeholder={t('mk.vehicleNumberPlaceholder')} className="input-field" />
              </div>
              <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={vehicleForm.total_seats || ''} onChange={(e) => setVehicleForm({ ...vehicleForm, total_seats: +e.target.value })} className="input-field" placeholder="0" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={vehicleForm.is_active} onChange={(e) => setVehicleForm({ ...vehicleForm, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('mk.vehicleActiveLabel')}</span></label>
              <button onClick={saveVehicle} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

      {showRouteForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowRouteForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingRoute ? t('mk.editRouteBtn') : t('mk.newRouteBtn')}</h2>
              <button onClick={() => setShowRouteForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input value={routeForm.origin} onChange={(e) => setRouteForm({ ...routeForm, origin: e.target.value })} placeholder={t('mk.originPlaceholder')} className="input-field" />
                <input value={routeForm.destination} onChange={(e) => setRouteForm({ ...routeForm, destination: e.target.value })} placeholder={t('mk.destinationPlaceholder')} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={routeForm.origin_ur} onChange={(e) => setRouteForm({ ...routeForm, origin_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
                <input value={routeForm.destination_ur} onChange={(e) => setRouteForm({ ...routeForm, destination_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              </div>
              <select value={routeForm.classification} onChange={(e) => setRouteForm({ ...routeForm, classification: e.target.value })} className="input-field">
                <option value="intercity">{t('mk.intercity')}</option>
                <option value="out_of_city">{t('mk.outOfCity')}</option>
              </select>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.farePerSeatLabel')}</label><input type="number" value={routeForm.fare_per_seat_pkr || ''} onChange={(e) => setRouteForm({ ...routeForm, fare_per_seat_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.departureTimeLabel')}</label><input type="time" value={routeForm.departure_time} onChange={(e) => setRouteForm({ ...routeForm, departure_time: e.target.value })} className="input-field" /></div>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('mk.daysOfWeekLabel')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_KEYS.map((k, i) => (
                    <button key={i} type="button" onClick={() => toggleDay(i)} className={`px-2.5 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer transition-all ${routeForm.days_of_week.includes(i) ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                      {t(k)}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={routeForm.is_active} onChange={(e) => setRouteForm({ ...routeForm, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('mk.routeActiveLabel')}</span></label>
              <button onClick={saveRoute} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
