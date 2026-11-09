'use client'

// Real gap found and confirmed while auditing the vehicle-system mockups:
// cities, service_classes, and villages all had admin-write RLS policies
// ready (420, 471) but no admin screen was ever built to use them — a
// wrong distance or rate had to be fixed by hand in the database. One
// simple tabbed CRUD screen for all three, since they're all the same
// shape (a short reference list the committee occasionally corrects),
// not worth three separate pages.
//
// Real cleanup, 2026-11-03: "almost all tabs are having base fares and
// duplicate functions" — service_classes' base_fare_pkr/per_km_pkr only
// ever fed the old "Pro Service" charter-booking flow (426), which is
// unreachable from any nav today — every real ride/delivery/equipment
// flow now prices off vehicle_categories (707+) or service_fare_policies
// (776). This tab's only LIVE purpose left is the eligibility gate
// (ride_eligible/delivery_eligible/...), so the price fields are dropped
// from the form entirely rather than left to confuse the committee.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { Pencil, Plus, MapPin, Truck, Home, Gauge } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface City { id: string; name: string; name_ur: string | null; distance_km: number; is_home_city: boolean; is_active: boolean; display_order: number }
interface ServiceClass {
  id: string; name: string; name_ur: string | null; category: string; capacity_label: string | null; capacity_label_ur: string | null
  note: string | null; note_ur: string | null; is_active: boolean; display_order: number
  delivery_eligible: boolean; ride_eligible: boolean; home_city_delivery_eligible: boolean; outstation_delivery_eligible: boolean
}
interface Village { id: string; name: string; name_ur: string | null; delivery_fee_pkr: number; is_home_village: boolean; is_active: boolean; display_order: number }
interface FareBand { flow: 'trip_share' | 'city_fetch' | 'route'; base_pkr: number; per_km_pkr: number; spread: number }
interface VehicleCategory {
  id: string; key: string; name: string; name_ur: string | null; emoji: string
  base_fare_pkr: number; per_km_pkr: number; intercity_commission_pct: number; out_of_city_commission_pct: number; is_active: boolean
  category_group: 'passenger' | 'loading' | 'machinery'; out_of_city_eligible: boolean
  out_of_city_base_fare_pkr: number | null; out_of_city_per_km_pkr: number | null
  hourly_rate_pkr: number | null; hourly_included_km: number | null; hourly_overage_per_km_pkr: number | null; shadi_full_day_rate_pkr: number | null
}
interface RentalTierGuide {
  tier_key: string; hourly_rate_pkr: number; hourly_included_km_per_hour: number; hourly_overage_per_km_pkr: number
  rental_base_pkr: number; rental_per_km_pkr: number; rental_wait_hour_pkr: number
  out_of_city_base_pkr: number; out_of_city_per_km_pkr: number
}

const emptyCity = { name: '', name_ur: '', distance_km: 0, is_home_city: false, display_order: 0 }
const emptyServiceClass = { name: '', name_ur: '', category: 'passenger', capacity_label: '', capacity_label_ur: '', note: '', note_ur: '', display_order: 0, delivery_eligible: true, ride_eligible: true, home_city_delivery_eligible: true, outstation_delivery_eligible: true }
const emptyVillage = { name: '', name_ur: '', delivery_fee_pkr: 0, is_home_village: false, display_order: 0 }
const emptyFareBand = { base_pkr: 0, per_km_pkr: 0, spread: 0.28 }
const emptyVehicleCategory = {
  name: '', name_ur: '', emoji: '', base_fare_pkr: 0, per_km_pkr: 0, intercity_commission_pct: 10, out_of_city_commission_pct: 15, category_group: 'passenger' as 'passenger' | 'loading' | 'machinery', out_of_city_eligible: true, out_of_city_base_fare_pkr: 0, out_of_city_per_km_pkr: 0,
  hourly_rate_pkr: 0, hourly_included_km: 0, hourly_overage_per_km_pkr: 0, shadi_full_day_rate_pkr: 0,
}
const emptyRentalTierGuide = { tier_key: '', hourly_rate_pkr: 0, hourly_included_km_per_hour: 0, hourly_overage_per_km_pkr: 0, rental_base_pkr: 0, rental_per_km_pkr: 0, rental_wait_hour_pkr: 0, out_of_city_base_pkr: 0, out_of_city_per_km_pkr: 0 }

function fmt(n: number) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function flowLabelKey(flow: 'trip_share' | 'city_fetch' | 'route') {
  return flow === 'trip_share' ? 'mr.flowTripShare' : flow === 'route' ? 'mr.flowRoute' : 'mr.flowCityFetch'
}

// Every input in these forms gets a real label above it now — "the
// admin staff can't define what we need to put there" when the only
// hint was a placeholder that vanishes the moment they click in.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-sans text-[11.5px] font-semibold text-dp-on-surface-variant">{label}</span>
      {children}
    </label>
  )
}

export default function MarketplaceReferencePage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [tab, setTab] = useState<'cities' | 'services' | 'villages' | 'fareBands' | 'vehicleCategories' | 'rentalTiers'>('cities')
  const [cities, setCities] = useState<City[]>([])
  const [services, setServices] = useState<ServiceClass[]>([])
  const [villages, setVillages] = useState<Village[]>([])
  const [fareBands, setFareBands] = useState<FareBand[]>([])
  const [vehicleCategories, setVehicleCategories] = useState<VehicleCategory[]>([])
  const [rentalTiers, setRentalTiers] = useState<RentalTierGuide[]>([])
  const [loading, setLoading] = useState(true)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingFlow, setEditingFlow] = useState<'trip_share' | 'city_fetch' | 'route' | null>(null)
  const [editingTierKey, setEditingTierKey] = useState<string | null>(null)
  const [cityForm, setCityForm] = useState(emptyCity)
  const [serviceForm, setServiceForm] = useState(emptyServiceClass)
  const [villageForm, setVillageForm] = useState(emptyVillage)
  const [fareBandForm, setFareBandForm] = useState(emptyFareBand)
  const [vehicleCategoryForm, setVehicleCategoryForm] = useState(emptyVehicleCategory)
  const [rentalTierForm, setRentalTierForm] = useState(emptyRentalTierGuide)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const [{ data: c }, { data: s }, { data: v }, { data: fb }, { data: vc }, { data: rt }] = await Promise.all([
      supabase.from('cities').select('*').order('display_order'),
      supabase.from('service_classes').select('*').order('display_order'),
      supabase.from('villages').select('*').order('display_order'),
      supabase.from('fare_bands').select('*').order('flow'),
      supabase.from('vehicle_categories').select('*').order('display_order'),
      supabase.from('rental_tier_fare_guides').select('*').order('display_order'),
    ])
    setCities((c ?? []) as City[]); setServices((s ?? []) as ServiceClass[]); setVillages((v ?? []) as Village[]); setFareBands((fb ?? []) as FareBand[])
    setVehicleCategories((vc ?? []) as VehicleCategory[])
    setRentalTiers((rt ?? []) as RentalTierGuide[])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = () => {
    setEditingId(null)
    if (tab === 'cities') setCityForm(emptyCity)
    else if (tab === 'services') setServiceForm(emptyServiceClass)
    else setVillageForm(emptyVillage)
    setShowForm(true)
  }
  const openEditCity = (c: City) => { setEditingId(c.id); setCityForm({ ...c, name_ur: c.name_ur ?? '' }); setShowForm(true) }
  const openEditService = (s: ServiceClass) => { setEditingId(s.id); setServiceForm({ ...s, name_ur: s.name_ur ?? '', capacity_label: s.capacity_label ?? '', capacity_label_ur: s.capacity_label_ur ?? '', note: s.note ?? '', note_ur: s.note_ur ?? '' }); setShowForm(true) }
  const openEditVillage = (v: Village) => { setEditingId(v.id); setVillageForm({ ...v, name_ur: v.name_ur ?? '' }); setShowForm(true) }
  const openEditFareBand = (fb: FareBand) => { setEditingFlow(fb.flow); setFareBandForm({ base_pkr: fb.base_pkr, per_km_pkr: fb.per_km_pkr, spread: fb.spread }); setShowForm(true) }
  const openEditVehicleCategory = (vc: VehicleCategory) => {
    setEditingId(vc.id)
    setVehicleCategoryForm({
      name: vc.name, name_ur: vc.name_ur ?? '', emoji: vc.emoji, base_fare_pkr: vc.base_fare_pkr, per_km_pkr: vc.per_km_pkr, intercity_commission_pct: vc.intercity_commission_pct, out_of_city_commission_pct: vc.out_of_city_commission_pct, category_group: vc.category_group, out_of_city_eligible: vc.out_of_city_eligible, out_of_city_base_fare_pkr: vc.out_of_city_base_fare_pkr ?? 0, out_of_city_per_km_pkr: vc.out_of_city_per_km_pkr ?? 0,
      hourly_rate_pkr: vc.hourly_rate_pkr ?? 0, hourly_included_km: vc.hourly_included_km ?? 0, hourly_overage_per_km_pkr: vc.hourly_overage_per_km_pkr ?? 0, shadi_full_day_rate_pkr: vc.shadi_full_day_rate_pkr ?? 0,
    })
    setShowForm(true)
  }
  const openEditRentalTier = (g: RentalTierGuide) => { setEditingTierKey(g.tier_key); setRentalTierForm({ ...g }); setShowForm(true) }

  const save = async () => {
    setSaving(true)
    const { error } =
      tab === 'cities' ? (editingId ? await supabase.from('cities').update(cityForm).eq('id', editingId) : await supabase.from('cities').insert(cityForm))
      : tab === 'services' ? (editingId ? await supabase.from('service_classes').update(serviceForm).eq('id', editingId) : await supabase.from('service_classes').insert(serviceForm))
      : tab === 'villages' ? (editingId ? await supabase.from('villages').update(villageForm).eq('id', editingId) : await supabase.from('villages').insert(villageForm))
      : tab === 'vehicleCategories' ? await supabase.from('vehicle_categories').update(vehicleCategoryForm).eq('id', editingId)
      : tab === 'rentalTiers' ? await supabase.rpc('admin_update_rental_tier_fare_guide', {
          p_tier_key: editingTierKey, p_hourly_rate_pkr: rentalTierForm.hourly_rate_pkr, p_hourly_included_km_per_hour: rentalTierForm.hourly_included_km_per_hour,
          p_hourly_overage_per_km_pkr: rentalTierForm.hourly_overage_per_km_pkr, p_rental_base_pkr: rentalTierForm.rental_base_pkr,
          p_rental_per_km_pkr: rentalTierForm.rental_per_km_pkr, p_rental_wait_hour_pkr: rentalTierForm.rental_wait_hour_pkr,
          p_out_of_city_base_pkr: rentalTierForm.out_of_city_base_pkr, p_out_of_city_per_km_pkr: rentalTierForm.out_of_city_per_km_pkr,
        })
      : await supabase.from('fare_bands').update(fareBandForm).eq('flow', editingFlow)
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('g.saveChanges'))
    setShowForm(false)
    load()
  }

  const toggleActive = async (table: string, id: string, isActive: boolean) => {
    await supabase.from(table).update({ is_active: !isActive }).eq('id', id)
    load()
  }

  if (access.loading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('mr.noAccessMessage')}</p></div>
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('mr.pageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('mr.pageSubtitle')}</p>
      </div>

      <div className="flex items-center gap-1 bg-dp-surface-container rounded-lg p-1 mb-5 w-fit flex-wrap">
        <button onClick={() => { setTab('cities'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'cities' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><MapPin size={14} /> {t('mr.citiesTab')}</button>
        <button onClick={() => { setTab('services'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'services' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Truck size={14} /> {t('mr.servicesTab')}</button>
        <button onClick={() => { setTab('villages'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'villages' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Home size={14} /> {t('mr.villagesTab')}</button>
        <button onClick={() => { setTab('fareBands'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'fareBands' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Gauge size={14} /> {t('mr.fareBandsTab')}</button>
        <button onClick={() => { setTab('vehicleCategories'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'vehicleCategories' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Truck size={14} /> {t('mr.vehicleCategoriesTab')}</button>
        <button onClick={() => { setTab('rentalTiers'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'rentalTiers' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Gauge size={14} /> {t('mr.rentalTiersTab')}</button>
      </div>

      {tab === 'cities' && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('mr.citiesHint')}</p>}
      {tab === 'services' && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('mr.servicesHint')}</p>}
      {tab === 'villages' && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('mr.villagesHint')}</p>}

      {tab !== 'fareBands' && tab !== 'vehicleCategories' && tab !== 'rentalTiers' && (
        <button onClick={openNew} className="flex items-center gap-1.5 px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all mb-4"><Plus size={14} /> {t('mr.addNewBtn')}</button>
      )}

      {tab === 'cities' && (
        <div className="space-y-2">
          {cities.map((c) => (
            <div key={c.id} className={`bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3 ${!c.is_active ? 'opacity-50' : ''}`}>
              <div>
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{c.name}{c.is_home_city && <span className="ms-2 font-sans text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container">{t('mr.homeBadge')}</span>}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{fmt(c.distance_km)}km</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => toggleActive('cities', c.id, c.is_active)} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">{c.is_active ? t('mr.deactivateBtn') : t('mr.activateBtn')}</button>
                <button onClick={() => openEditCity(c)} className="p-2 rounded text-dp-secondary hover:bg-dp-surface-container cursor-pointer"><Pencil size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'services' && (
        <div className="space-y-2">
          {services.map((s) => (
            <div key={s.id} className={`bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3 ${!s.is_active ? 'opacity-50' : ''}`}>
              <div>
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5 flex-wrap">
                  {s.name} <span className="font-normal text-[11px] text-dp-on-surface-variant">· {s.category}</span>
                  {s.delivery_eligible && <span className="font-sans text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container">{t('mr.deliveryEligibleBadge')}</span>}
                  {s.ride_eligible && <span className="font-sans text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container">{t('mr.rideEligibleBadge')}</span>}
                </p>
                {s.capacity_label && <p className="font-sans text-[12px] text-dp-on-surface-variant">{s.capacity_label}</p>}
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => toggleActive('service_classes', s.id, s.is_active)} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">{s.is_active ? t('mr.deactivateBtn') : t('mr.activateBtn')}</button>
                <button onClick={() => openEditService(s)} className="p-2 rounded text-dp-secondary hover:bg-dp-surface-container cursor-pointer"><Pencil size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'villages' && (
        <div className="space-y-2">
          {villages.map((v) => (
            <div key={v.id} className={`bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3 ${!v.is_active ? 'opacity-50' : ''}`}>
              <div>
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{v.name}{v.is_home_village && <span className="ms-2 font-sans text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container">{t('mr.homeBadge')}</span>}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{fmt(v.delivery_fee_pkr)}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => toggleActive('villages', v.id, v.is_active)} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">{v.is_active ? t('mr.deactivateBtn') : t('mr.activateBtn')}</button>
                <button onClick={() => openEditVillage(v)} className="p-2 rounded text-dp-secondary hover:bg-dp-surface-container cursor-pointer"><Pencil size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'fareBands' && (
        <div className="space-y-2">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-2">{t('mr.fareBandsHint')}</p>
          {fareBands.map((fb) => (
            <div key={fb.flow} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3">
              <div>
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{t(flowLabelKey(fb.flow))}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{fmt(fb.base_pkr)} base + {fmt(fb.per_km_pkr)}/km · ±{Math.round(fb.spread * 100)}%</p>
              </div>
              <button onClick={() => openEditFareBand(fb)} className="p-2 rounded text-dp-secondary hover:bg-dp-surface-container cursor-pointer"><Pencil size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {tab === 'vehicleCategories' && (
        <div className="space-y-2">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-2">{t('mr.vehicleCategoriesHint')}</p>
          {vehicleCategories.filter((vc) => vc.is_active).map((vc) => (
            <div key={vc.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3">
              <div>
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5">
                  {vc.emoji} {isUrdu && vc.name_ur ? vc.name_ur : vc.name}
                  {!vc.out_of_city_eligible && <span className="font-sans text-[9.5px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">{t('mr.homeCityOnlyBadge')}</span>}
                </p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{fmt(vc.base_fare_pkr)} base + {fmt(vc.per_km_pkr)}/km · {vc.intercity_commission_pct}% / {vc.out_of_city_commission_pct}%</p>
                {vc.out_of_city_eligible && (
                  <p className="font-sans text-[12px] text-amber-700 ltr-num">{t('mr.outstationRateLabel')}: {fmt(vc.out_of_city_base_fare_pkr ?? 0)} base + {fmt(vc.out_of_city_per_km_pkr ?? 0)}/km</p>
                )}
                {vc.hourly_rate_pkr ? <p className="font-sans text-[11.5px] text-dp-on-surface-variant ltr-num">{t('vr.wantsHourlyLabel')}: {fmt(vc.hourly_rate_pkr)}/hr · {fmt(vc.hourly_included_km ?? 0)}km incl.</p> : null}
                {vc.shadi_full_day_rate_pkr ? <p className="font-sans text-[11.5px] text-dp-on-surface-variant ltr-num">{t('vr.wantsShadiLabel')}: {fmt(vc.shadi_full_day_rate_pkr)}/day</p> : null}
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => toggleActive('vehicle_categories', vc.id, vc.is_active)} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">{t('mr.deactivateBtn')}</button>
                <button onClick={() => openEditVehicleCategory(vc)} className="p-2 rounded text-dp-secondary hover:bg-dp-surface-container cursor-pointer"><Pencil size={14} /></button>
              </div>
            </div>
          ))}
          {vehicleCategories.some((vc) => !vc.is_active) && (
            <details className="mt-2">
              <summary className="font-sans text-[12px] text-dp-on-surface-variant cursor-pointer">{t('mr.inactiveCategoriesToggle')}</summary>
              <div className="space-y-2 mt-2">
                {vehicleCategories.filter((vc) => !vc.is_active).map((vc) => (
                  <div key={vc.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3 opacity-50">
                    <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{vc.emoji} {isUrdu && vc.name_ur ? vc.name_ur : vc.name}</p>
                    <button onClick={() => toggleActive('vehicle_categories', vc.id, vc.is_active)} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">{t('mr.activateBtn')}</button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {tab === 'rentalTiers' && (
        <div className="space-y-2">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-2">{t('mr.rentalTiersHint')}</p>
          {rentalTiers.map((g) => (
            <div key={g.tier_key} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3">
              <div>
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{t(`vp.rentalTier.${g.tier_key}`)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{t('mr.hourlyRatesHeading')}: {fmt(g.hourly_rate_pkr)}/hr · {fmt(g.hourly_included_km_per_hour)}km {t('mr.includedLabel')} · {fmt(g.hourly_overage_per_km_pkr)}/km {t('mr.overageLabel')}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{t('mr.rentalRatesHeading')}: {fmt(g.rental_base_pkr)} base + {fmt(g.rental_per_km_pkr)}/km + {fmt(g.rental_wait_hour_pkr)}/hr {t('mr.waitLabel')}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{t('mr.outstationRateLabel')}: {fmt(g.out_of_city_base_pkr)} base + {fmt(g.out_of_city_per_km_pkr)}/km</p>
              </div>
              <button onClick={() => openEditRentalTier(g)} className="p-2 rounded text-dp-secondary hover:bg-dp-surface-container cursor-pointer"><Pencil size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">{tab === 'fareBands' ? (editingFlow ? t(flowLabelKey(editingFlow)) : '') : tab === 'vehicleCategories' ? vehicleCategoryForm.name : tab === 'rentalTiers' ? (editingTierKey ? t(`vp.rentalTier.${editingTierKey}`) : '') : editingId ? t('mr.editTitle') : t('mr.addTitle')}</h2>

            {tab === 'cities' && (
              <div className="space-y-2.5">
                <Field label={t('mr.nameLabel')}><input value={cityForm.name} onChange={(e) => setCityForm({ ...cityForm, name: e.target.value })} placeholder={t('mr.namePlaceholder')} className="input-field" /></Field>
                <Field label={t('mr.nameUrLabel')}><input value={cityForm.name_ur} onChange={(e) => setCityForm({ ...cityForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" dir="rtl" /></Field>
                <Field label={t('mr.distanceKmLabel')}><input type="number" value={cityForm.distance_km || ''} onChange={(e) => setCityForm({ ...cityForm, distance_km: +e.target.value })} placeholder={t('mr.distanceKmPlaceholder')} className="input-field" /></Field>
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={cityForm.is_home_city} onChange={(e) => setCityForm({ ...cityForm, is_home_city: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.isHomeCityLabel')}</span></label>
              </div>
            )}

            {tab === 'services' && (
              <div className="space-y-2.5">
                <Field label={t('mr.nameLabel')}><input value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} placeholder={t('mr.namePlaceholder')} className="input-field" /></Field>
                <Field label={t('mr.nameUrLabel')}><input value={serviceForm.name_ur} onChange={(e) => setServiceForm({ ...serviceForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" dir="rtl" /></Field>
                <Field label={t('mr.categoryLabel')}>
                  <select value={serviceForm.category} onChange={(e) => setServiceForm({ ...serviceForm, category: e.target.value })} className="input-field">
                    <option value="passenger">{t('mr.passengerOption')}</option>
                    <option value="loading">{t('mr.loadingOption')}</option>
                  </select>
                </Field>
                <Field label={t('mr.capacityLabelLabel')}><input value={serviceForm.capacity_label ?? ''} onChange={(e) => setServiceForm({ ...serviceForm, capacity_label: e.target.value })} placeholder={t('mr.capacityLabelPlaceholder')} className="input-field" /></Field>
                <div className="pt-1 space-y-1.5">
                  <p className="font-sans text-[11.5px] font-semibold text-dp-on-surface-variant">{t('mr.rideDeliveryEligibilityHeading')}</p>
                  <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={serviceForm.delivery_eligible} onChange={(e) => setServiceForm({ ...serviceForm, delivery_eligible: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.deliveryEligibleLabel')}</span></label>
                  <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={serviceForm.ride_eligible} onChange={(e) => setServiceForm({ ...serviceForm, ride_eligible: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.rideEligibleLabel')}</span></label>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.eligibilityHint')}</p>
                  <div className="pt-1.5 mt-1.5 border-t border-dp-outline-variant space-y-1.5">
                    <p className="font-sans text-[11.5px] font-semibold text-dp-on-surface-variant">{t('mr.deliveryZoneEligibilityHeading')}</p>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={serviceForm.home_city_delivery_eligible} onChange={(e) => setServiceForm({ ...serviceForm, home_city_delivery_eligible: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.homeCityDeliveryEligibleLabel')}</span></label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={serviceForm.outstation_delivery_eligible} onChange={(e) => setServiceForm({ ...serviceForm, outstation_delivery_eligible: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.outstationDeliveryEligibleLabel')}</span></label>
                    <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.categoryEligibilityHint')}</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'villages' && (
              <div className="space-y-2.5">
                <Field label={t('mr.nameLabel')}><input value={villageForm.name} onChange={(e) => setVillageForm({ ...villageForm, name: e.target.value })} placeholder={t('mr.namePlaceholder')} className="input-field" /></Field>
                <Field label={t('mr.nameUrLabel')}><input value={villageForm.name_ur} onChange={(e) => setVillageForm({ ...villageForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" dir="rtl" /></Field>
                <Field label={t('mr.deliveryFeeLabel')}><input type="number" value={villageForm.delivery_fee_pkr || ''} onChange={(e) => setVillageForm({ ...villageForm, delivery_fee_pkr: +e.target.value })} placeholder={t('mr.deliveryFeePlaceholder')} className="input-field" /></Field>
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={villageForm.is_home_village} onChange={(e) => setVillageForm({ ...villageForm, is_home_village: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.isHomeVillageLabel')}</span></label>
              </div>
            )}

            {tab === 'fareBands' && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label={t('mr.basePkrLabel')}><input type="number" value={fareBandForm.base_pkr || ''} onChange={(e) => setFareBandForm({ ...fareBandForm, base_pkr: +e.target.value })} placeholder={t('mr.basePkrPlaceholder')} className="input-field" /></Field>
                  <Field label={t('mr.perKmPkrLabel')}><input type="number" value={fareBandForm.per_km_pkr || ''} onChange={(e) => setFareBandForm({ ...fareBandForm, per_km_pkr: +e.target.value })} placeholder={t('mr.perKmPkrPlaceholder')} className="input-field" /></Field>
                </div>
                <Field label={t('mr.spreadLabel')}><input type="number" step="0.01" min="0.01" max="0.99" value={fareBandForm.spread || ''} onChange={(e) => setFareBandForm({ ...fareBandForm, spread: +e.target.value })} placeholder={t('mr.spreadPlaceholder')} className="input-field" /></Field>
              </div>
            )}

            {tab === 'vehicleCategories' && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label={t('mr.nameLabel')}><input value={vehicleCategoryForm.name} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, name: e.target.value })} placeholder={t('mr.namePlaceholder')} className="input-field" /></Field>
                  <Field label={t('mr.nameUrLabel')}><input value={vehicleCategoryForm.name_ur} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" dir="rtl" /></Field>
                </div>
                <Field label={t('mr.emojiLabel')}><input value={vehicleCategoryForm.emoji} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, emoji: e.target.value })} placeholder={t('mr.emojiPlaceholder')} className="input-field" /></Field>
                <Field label={t('mr.categoryGroupLabel')}>
                  <select value={vehicleCategoryForm.category_group} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, category_group: e.target.value as 'passenger' | 'loading' | 'machinery' })} className="input-field">
                    <option value="passenger">{t('mr.categoryGroupPassenger')}</option>
                    <option value="loading">{t('mr.categoryGroupLoading')}</option>
                    <option value="machinery">{t('mr.categoryGroupMachinery')}</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2 font-sans text-[13px] text-dp-on-surface cursor-pointer">
                  <input type="checkbox" checked={vehicleCategoryForm.out_of_city_eligible} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, out_of_city_eligible: e.target.checked })} className="cursor-pointer" />
                  {t('mr.outOfCityEligibleLabel')}
                </label>
                <p className="font-sans text-[11.5px] font-semibold text-dp-on-surface-variant pt-1">{t('mr.inCityRateHeading')}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label={t('mr.basePkrLabel')}><input type="number" value={vehicleCategoryForm.base_fare_pkr || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, base_fare_pkr: +e.target.value })} placeholder={t('mr.basePkrPlaceholder')} className="input-field" /></Field>
                  <Field label={t('mr.perKmPkrLabel')}><input type="number" value={vehicleCategoryForm.per_km_pkr || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, per_km_pkr: +e.target.value })} placeholder={t('mr.perKmPkrPlaceholder')} className="input-field" /></Field>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label={t('mr.intercityCommissionLabel')}><input type="number" value={vehicleCategoryForm.intercity_commission_pct || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, intercity_commission_pct: +e.target.value })} placeholder={t('mr.intercityCommissionPlaceholder')} className="input-field" /></Field>
                  <Field label={t('mr.outOfCityCommissionLabel')}><input type="number" value={vehicleCategoryForm.out_of_city_commission_pct || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, out_of_city_commission_pct: +e.target.value })} placeholder={t('mr.outOfCityCommissionPlaceholder')} className="input-field" /></Field>
                </div>
                {vehicleCategoryForm.out_of_city_eligible && (
                  <div className="pt-2 mt-1 border-t border-dp-outline-variant space-y-1.5">
                    <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{t('mr.outstationRateLabel')}</p>
                    <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.outstationRateHint')}</p>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label={t('mr.outstationBaseLabel')}><input type="number" value={vehicleCategoryForm.out_of_city_base_fare_pkr || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, out_of_city_base_fare_pkr: +e.target.value })} placeholder={t('mr.outstationBasePlaceholder')} className="input-field" /></Field>
                      <Field label={t('mr.outstationPerKmLabel')}><input type="number" value={vehicleCategoryForm.out_of_city_per_km_pkr || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, out_of_city_per_km_pkr: +e.target.value })} placeholder={t('mr.outstationPerKmPlaceholder')} className="input-field" /></Field>
                    </div>
                  </div>
                )}
                {/* Real ask, 2026-11-10: "no manual input for the admin
                    end — admin just attaches a category, that's it" —
                    the hourly/shadi rate now has to live here, on the
                    category, since admin_approve_vehicle_registration
                    (834) no longer accepts them as input at all. Leave
                    these at 0 (shown as blank) for a category that
                    shouldn't offer that service — approving a driver
                    who requested it is then blocked with a clear
                    message instead of silently inserting a 0 rate. */}
                <div className="pt-2 mt-1 border-t border-dp-outline-variant space-y-1.5">
                  <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{t('mr.hourlyRatesHeading')}</p>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.categoryHourlyShadiHint')}</p>
                  <div className="grid grid-cols-3 gap-2.5">
                    <Field label={t('mk.hourlyRatePlaceholder')}><input type="number" value={vehicleCategoryForm.hourly_rate_pkr || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, hourly_rate_pkr: +e.target.value })} className="input-field" /></Field>
                    <Field label={t('mk.includedKmPlaceholder')}><input type="number" value={vehicleCategoryForm.hourly_included_km || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, hourly_included_km: +e.target.value })} className="input-field" /></Field>
                    <Field label={t('mk.overageRatePlaceholder')}><input type="number" value={vehicleCategoryForm.hourly_overage_per_km_pkr || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, hourly_overage_per_km_pkr: +e.target.value })} className="input-field" /></Field>
                  </div>
                  <Field label={t('mk.shadiRatePlaceholder')}><input type="number" value={vehicleCategoryForm.shadi_full_day_rate_pkr || ''} onChange={(e) => setVehicleCategoryForm({ ...vehicleCategoryForm, shadi_full_day_rate_pkr: +e.target.value })} className="input-field" /></Field>
                </div>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.vehicleCategoryEditHint')}</p>
              </div>
            )}

            {tab === 'rentalTiers' && (
              <div className="space-y-2.5">
                <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{t('mr.hourlyRatesHeading')}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label={t('mr.hourlyRateLabel')}><input type="number" value={rentalTierForm.hourly_rate_pkr || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, hourly_rate_pkr: +e.target.value })} placeholder={t('mr.basePkrPlaceholder')} className="input-field" /></Field>
                  <Field label={t('mr.hourlyIncludedKmLabel')}><input type="number" value={rentalTierForm.hourly_included_km_per_hour || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, hourly_included_km_per_hour: +e.target.value })} className="input-field" /></Field>
                </div>
                <Field label={t('mr.hourlyOverageLabel')}><input type="number" value={rentalTierForm.hourly_overage_per_km_pkr || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, hourly_overage_per_km_pkr: +e.target.value })} placeholder={t('mr.perKmPkrPlaceholder')} className="input-field" /></Field>

                <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface pt-1">{t('mr.rentalRatesHeading')}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label={t('mr.basePkrLabel')}><input type="number" value={rentalTierForm.rental_base_pkr || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, rental_base_pkr: +e.target.value })} placeholder={t('mr.basePkrPlaceholder')} className="input-field" /></Field>
                  <Field label={t('mr.perKmPkrLabel')}><input type="number" value={rentalTierForm.rental_per_km_pkr || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, rental_per_km_pkr: +e.target.value })} placeholder={t('mr.perKmPkrPlaceholder')} className="input-field" /></Field>
                </div>
                <Field label={t('mr.rentalWaitHourLabel')}><input type="number" value={rentalTierForm.rental_wait_hour_pkr || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, rental_wait_hour_pkr: +e.target.value })} className="input-field" /></Field>

                <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface pt-1">{t('mr.outstationRateLabel')}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.outstationRateHint')}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label={t('mr.outstationBaseLabel')}><input type="number" value={rentalTierForm.out_of_city_base_pkr || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, out_of_city_base_pkr: +e.target.value })} placeholder={t('mr.outstationBasePlaceholder')} className="input-field" /></Field>
                  <Field label={t('mr.outstationPerKmLabel')}><input type="number" value={rentalTierForm.out_of_city_per_km_pkr || ''} onChange={(e) => setRentalTierForm({ ...rentalTierForm, out_of_city_per_km_pkr: +e.target.value })} placeholder={t('mr.outstationPerKmPlaceholder')} className="input-field" /></Field>
                </div>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.rentalTierEditHint')}</p>
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer">{t('action.cancel')}</button>
              <button onClick={save} disabled={saving} className="flex-1 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
