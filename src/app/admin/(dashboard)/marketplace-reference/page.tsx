'use client'

// Real gap found and confirmed while auditing the vehicle-system mockups:
// cities, service_classes, and villages all had admin-write RLS policies
// ready (420, 471) but no admin screen was ever built to use them — a
// wrong distance or rate had to be fixed by hand in the database. One
// simple tabbed CRUD screen for all three, since they're all the same
// shape (a short reference list the committee occasionally corrects),
// not worth three separate pages.

import { useEffect, useState } from 'react'
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
  note: string | null; note_ur: string | null; base_fare_pkr: number; per_km_pkr: number; is_active: boolean; display_order: number
  delivery_eligible: boolean; ride_eligible: boolean
}
interface Village { id: string; name: string; name_ur: string | null; delivery_fee_pkr: number; is_home_village: boolean; is_active: boolean; display_order: number }
interface FareBand { flow: 'trip_share' | 'city_fetch'; base_pkr: number; per_km_pkr: number; spread: number }

const emptyCity = { name: '', name_ur: '', distance_km: 0, is_home_city: false, display_order: 0 }
const emptyServiceClass = { name: '', name_ur: '', category: 'passenger', capacity_label: '', capacity_label_ur: '', note: '', note_ur: '', base_fare_pkr: 0, per_km_pkr: 0, display_order: 0, delivery_eligible: true, ride_eligible: true }
const emptyVillage = { name: '', name_ur: '', delivery_fee_pkr: 0, is_home_village: false, display_order: 0 }
const emptyFareBand = { base_pkr: 0, per_km_pkr: 0, spread: 0.28 }

function fmt(n: number) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function MarketplaceReferencePage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [tab, setTab] = useState<'cities' | 'services' | 'villages' | 'fareBands'>('cities')
  const [cities, setCities] = useState<City[]>([])
  const [services, setServices] = useState<ServiceClass[]>([])
  const [villages, setVillages] = useState<Village[]>([])
  const [fareBands, setFareBands] = useState<FareBand[]>([])
  const [loading, setLoading] = useState(true)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingFlow, setEditingFlow] = useState<'trip_share' | 'city_fetch' | null>(null)
  const [cityForm, setCityForm] = useState(emptyCity)
  const [serviceForm, setServiceForm] = useState(emptyServiceClass)
  const [villageForm, setVillageForm] = useState(emptyVillage)
  const [fareBandForm, setFareBandForm] = useState(emptyFareBand)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const [{ data: c }, { data: s }, { data: v }, { data: fb }] = await Promise.all([
      supabase.from('cities').select('*').order('display_order'),
      supabase.from('service_classes').select('*').order('display_order'),
      supabase.from('villages').select('*').order('display_order'),
      supabase.from('fare_bands').select('*').order('flow'),
    ])
    setCities((c ?? []) as City[]); setServices((s ?? []) as ServiceClass[]); setVillages((v ?? []) as Village[]); setFareBands((fb ?? []) as FareBand[])
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

  const save = async () => {
    setSaving(true)
    const { error } =
      tab === 'cities' ? (editingId ? await supabase.from('cities').update(cityForm).eq('id', editingId) : await supabase.from('cities').insert(cityForm))
      : tab === 'services' ? (editingId ? await supabase.from('service_classes').update(serviceForm).eq('id', editingId) : await supabase.from('service_classes').insert(serviceForm))
      : tab === 'villages' ? (editingId ? await supabase.from('villages').update(villageForm).eq('id', editingId) : await supabase.from('villages').insert(villageForm))
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

      <div className="flex items-center gap-1 bg-dp-surface-container rounded-lg p-1 mb-5 w-fit">
        <button onClick={() => { setTab('cities'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'cities' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><MapPin size={14} /> {t('mr.citiesTab')}</button>
        <button onClick={() => { setTab('services'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'services' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Truck size={14} /> {t('mr.servicesTab')}</button>
        <button onClick={() => { setTab('villages'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'villages' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Home size={14} /> {t('mr.villagesTab')}</button>
        <button onClick={() => { setTab('fareBands'); setShowForm(false) }} className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'fareBands' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}><Gauge size={14} /> {t('mr.fareBandsTab')}</button>
      </div>

      {tab !== 'fareBands' && (
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
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{fmt(s.base_fare_pkr)} base + {fmt(s.per_km_pkr)}/km · {s.capacity_label}</p>
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
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{fb.flow === 'trip_share' ? t('mr.flowTripShare') : t('mr.flowCityFetch')}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{fmt(fb.base_pkr)} base + {fmt(fb.per_km_pkr)}/km · ±{Math.round(fb.spread * 100)}%</p>
              </div>
              <button onClick={() => openEditFareBand(fb)} className="p-2 rounded text-dp-secondary hover:bg-dp-surface-container cursor-pointer"><Pencil size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">{tab === 'fareBands' ? (editingFlow === 'trip_share' ? t('mr.flowTripShare') : t('mr.flowCityFetch')) : editingId ? t('mr.editTitle') : t('mr.addTitle')}</h2>

            {tab === 'cities' && (
              <div className="space-y-2.5">
                <input value={cityForm.name} onChange={(e) => setCityForm({ ...cityForm, name: e.target.value })} placeholder={t('mr.namePlaceholder')} className="input-field" />
                <input value={cityForm.name_ur} onChange={(e) => setCityForm({ ...cityForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" dir="rtl" />
                <input type="number" value={cityForm.distance_km || ''} onChange={(e) => setCityForm({ ...cityForm, distance_km: +e.target.value })} placeholder={t('mr.distanceKmPlaceholder')} className="input-field" />
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={cityForm.is_home_city} onChange={(e) => setCityForm({ ...cityForm, is_home_city: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.isHomeCityLabel')}</span></label>
              </div>
            )}

            {tab === 'services' && (
              <div className="space-y-2.5">
                <input value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} placeholder={t('mr.namePlaceholder')} className="input-field" />
                <input value={serviceForm.name_ur} onChange={(e) => setServiceForm({ ...serviceForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" dir="rtl" />
                <select value={serviceForm.category} onChange={(e) => setServiceForm({ ...serviceForm, category: e.target.value })} className="input-field">
                  <option value="passenger">{t('mr.passengerOption')}</option>
                  <option value="loading">{t('mr.loadingOption')}</option>
                </select>
                <input value={serviceForm.capacity_label ?? ''} onChange={(e) => setServiceForm({ ...serviceForm, capacity_label: e.target.value })} placeholder={t('mr.capacityLabelPlaceholder')} className="input-field" />
                <div className="grid grid-cols-2 gap-2.5">
                  <input type="number" value={serviceForm.base_fare_pkr || ''} onChange={(e) => setServiceForm({ ...serviceForm, base_fare_pkr: +e.target.value })} placeholder={t('mr.baseFarePlaceholder')} className="input-field" />
                  <input type="number" value={serviceForm.per_km_pkr || ''} onChange={(e) => setServiceForm({ ...serviceForm, per_km_pkr: +e.target.value })} placeholder={t('mr.perKmPlaceholder')} className="input-field" />
                </div>
                <div className="pt-1 space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={serviceForm.delivery_eligible} onChange={(e) => setServiceForm({ ...serviceForm, delivery_eligible: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.deliveryEligibleLabel')}</span></label>
                  <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={serviceForm.ride_eligible} onChange={(e) => setServiceForm({ ...serviceForm, ride_eligible: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.rideEligibleLabel')}</span></label>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('mr.eligibilityHint')}</p>
                </div>
              </div>
            )}

            {tab === 'villages' && (
              <div className="space-y-2.5">
                <input value={villageForm.name} onChange={(e) => setVillageForm({ ...villageForm, name: e.target.value })} placeholder={t('mr.namePlaceholder')} className="input-field" />
                <input value={villageForm.name_ur} onChange={(e) => setVillageForm({ ...villageForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" dir="rtl" />
                <input type="number" value={villageForm.delivery_fee_pkr || ''} onChange={(e) => setVillageForm({ ...villageForm, delivery_fee_pkr: +e.target.value })} placeholder={t('mr.deliveryFeePlaceholder')} className="input-field" />
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={villageForm.is_home_village} onChange={(e) => setVillageForm({ ...villageForm, is_home_village: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('mr.isHomeVillageLabel')}</span></label>
              </div>
            )}

            {tab === 'fareBands' && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2.5">
                  <input type="number" value={fareBandForm.base_pkr || ''} onChange={(e) => setFareBandForm({ ...fareBandForm, base_pkr: +e.target.value })} placeholder={t('mr.basePkrPlaceholder')} className="input-field" />
                  <input type="number" value={fareBandForm.per_km_pkr || ''} onChange={(e) => setFareBandForm({ ...fareBandForm, per_km_pkr: +e.target.value })} placeholder={t('mr.perKmPkrPlaceholder')} className="input-field" />
                </div>
                <input type="number" step="0.01" min="0.01" max="0.99" value={fareBandForm.spread || ''} onChange={(e) => setFareBandForm({ ...fareBandForm, spread: +e.target.value })} placeholder={t('mr.spreadPlaceholder')} className="input-field" />
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
