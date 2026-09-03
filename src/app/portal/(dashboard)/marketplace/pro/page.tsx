'use client'

// Pro / Loading service — whole-vehicle charter by class (Car AC,
// Rickshaw, Suzuki Dala, ...) rather than a specific driver's own posted
// trip. Pick a class, pick a destination city, toggle one-way/return to
// see the system-computed fare (pro_service_fare, migration 420), then
// pick one of the vehicles actually offering that class
// (vehicles_offering_service, 426) to request from — same negotiation
// reuse as fetch/share, kind='pro'.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Truck, Car, Bike as BikeIcon, Package, Phone, Send, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface City { id: string; name: string; name_ur: string | null; distance_km: number; is_home_city: boolean }
interface ServiceClass {
  id: string; name: string; name_ur: string | null; category: string
  capacity_label: string | null; capacity_label_ur: string | null; note: string | null; note_ur: string | null
  base_fare_pkr: number; per_km_pkr: number
}
interface OfferingVehicle { vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; vehicle_number: string | null; allows_out_of_city: boolean }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function roundTo10(n: number) { return Math.round(n / 10) * 10 }
function proFare(km: number, base: number, perKm: number, isReturn: boolean) { return roundTo10((base + km * perKm) * (isReturn ? 1.85 : 1)) }

export default function ProServicePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [classes, setClasses] = useState<ServiceClass[]>([])
  const [cities, setCities] = useState<City[]>([])
  const [tab, setTab] = useState<'passenger' | 'loading'>('passenger')
  const [selectedClass, setSelectedClass] = useState<ServiceClass | null>(null)
  const [cityId, setCityId] = useState('')
  const [isReturn, setIsReturn] = useState(false)
  const [offering, setOffering] = useState<OfferingVehicle[] | null>(null)
  const [requestingId, setRequestingId] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('service_classes').select('*').eq('is_active', true).order('display_order').then(({ data }) => setClasses((data ?? []) as ServiceClass[]))
    supabase.from('cities').select('id, name, name_ur, distance_km, is_home_city').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedClass) { setOffering(null); return }
    setOffering(null)
    supabase.rpc('vehicles_offering_service', { p_service_class_id: selectedClass.id }).then(({ data }) => setOffering((data ?? []) as OfferingVehicle[]))
  }, [selectedClass]) // eslint-disable-line react-hooks/exhaustive-deps

  const request = async (vehicleId: string, eligible: boolean) => {
    if (!selectedClass || !cityId) { toast.error(t('vp.pickCityOption')); return }
    if (!eligible) { toast.error(t('vp.notOutOfCityCapableNote')); return }
    setRequestingId(vehicleId)
    const { data: threadId, error } = await supabase.rpc('request_pro_service', {
      p_vehicle_id: vehicleId, p_service_class_id: selectedClass.id, p_city_id: cityId, p_is_return: isReturn,
    })
    setRequestingId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/negotiations/${threadId}`)
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const city = cities.find((c) => c.id === cityId)
  const estFare = selectedClass && city ? proFare(city.distance_km, selectedClass.base_fare_pkr, selectedClass.per_km_pkr, isReturn) : null

  if (selectedClass) {
    return (
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto">
        <button onClick={() => setSelectedClass(null)} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:text-dp-secondary mb-3 cursor-pointer">
          <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.backToServices')}
        </button>
        <div className="mb-5">
          <h1 className="font-heading text-[22px] font-bold text-dp-primary">{isUrdu && selectedClass.name_ur ? selectedClass.name_ur : selectedClass.name}</h1>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{isUrdu ? (selectedClass.note_ur || selectedClass.note) : selectedClass.note} · {isUrdu ? (selectedClass.capacity_label_ur || selectedClass.capacity_label) : selectedClass.capacity_label}</p>
        </div>

        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-5 space-y-2.5">
          <select value={cityId} onChange={(e) => setCityId(e.target.value)} className="input-field">
            <option value="">{t('vp.pickCityOption')}</option>
            {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setIsReturn(false)} className={`py-2 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${!isReturn ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{t('vp.oneWayBtn')}</button>
            <button type="button" onClick={() => setIsReturn(true)} className={`py-2 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${isReturn ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{t('vp.returnTripBtn')}</button>
          </div>
          {estFare != null && (
            <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.estimatedFareLabel')} <span className="font-bold text-dp-secondary ltr-num">{fmt(estFare)}</span></p>
          )}
        </div>

        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vp.vehiclesOfferingHeading')}</p>
        {offering === null && cityId && <p className="font-sans text-[13px] text-dp-on-surface-variant"><LoadingDots /></p>}
        {offering !== null && offering.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.noVehiclesOfferingNote')}</p>}
        {!cityId && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.pickCityFirstNote')}</p>}
        <div className="space-y-2">
          {cityId && (offering ?? []).map((v) => {
            const eligible = city?.is_home_city || v.allows_out_of_city
            return (
            <div key={v.vehicle_id} className={`flex items-center justify-between gap-3 bg-white border rounded-lg p-3 ${eligible ? 'border-dp-outline-variant' : 'border-dp-outline-variant opacity-50'}`}>
              <div className="min-w-0">
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{v.owner_name}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{v.vehicle_type}{v.vehicle_number ? ` · ${v.vehicle_number}` : ''}</p>
                {!eligible && <p className="font-sans text-[11px] text-dp-error mt-0.5">{t('vp.notOutOfCityCapableNote')}</p>}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {eligible && v.owner_mobile && <a href={`tel:${v.owner_mobile}`} className="flex items-center justify-center w-8 h-8 rounded-full bg-dp-secondary-container/50 text-dp-secondary hover:bg-dp-secondary hover:text-white transition-colors"><Phone size={13} /></a>}
                <button onClick={() => request(v.vehicle_id, eligible)} disabled={requestingId === v.vehicle_id || !eligible} className="flex items-center gap-1 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                  <Send size={12} /> {requestingId === v.vehicle_id ? t('action.saving') : t('vp.requestBtn')}
                </button>
              </div>
            </div>
          )})}
        </div>
      </div>
    )
  }

  const visible = classes.filter((c) => c.category === tab)
  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Truck size={22} className="text-dp-secondary" /> {t('vp.proPageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vp.proPageSubtitle')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-5">
        <button onClick={() => setTab('passenger')} className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'passenger' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}><Car size={14} /> {t('vp.passengerTabLabel')}</button>
        <button onClick={() => setTab('loading')} className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'loading' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}><Package size={14} /> {t('vp.loadingTabLabel')}</button>
      </div>

      <div className="space-y-2">
        {visible.map((c) => (
          <button key={c.id} onClick={() => setSelectedClass(c)} className="w-full text-start flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors cursor-pointer">
            <div className="flex items-center gap-2.5 min-w-0">
              {c.category === 'passenger' ? <Car size={16} className="text-dp-secondary shrink-0" /> : <BikeIcon size={16} className="text-dp-secondary shrink-0" />}
              <div className="min-w-0">
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface truncate">{isUrdu && c.name_ur ? c.name_ur : c.name}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 truncate">{isUrdu ? (c.capacity_label_ur || c.capacity_label) : c.capacity_label}</p>
              </div>
            </div>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant shrink-0">{t('vp.fromLabel')} <span className="ltr-num font-semibold text-dp-on-surface">{fmt(c.base_fare_pkr)}</span></p>
          </button>
        ))}
      </div>
    </div>
  )
}
