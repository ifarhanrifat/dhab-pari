'use client'

// Parcel Delivery — "a rider can collect a parcel from a villager and
// deliver it to a city or out-of-city destination," distinct from City
// Purchase ("buy something new and bring it back," which this screen is
// modeled directly on) and from City Fetch (a pure negotiation-chat with
// no tracked pickup/delivery lifecycle). Same candidate-matching RPC as
// City Purchase (city_purchase_candidate_vehicles) — identical
// eligibility gate, just no item-attachment/goods-budget concept since
// nothing is being bought, and a real pickup+dropoff pair instead of a
// single pickup spot.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { Package, MapPin, Navigation, Clock, ChevronRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { getCurrentPositionOnce, classifyLocationError, type LocationErrorReason } from '@/hooks/useLiveLocation'
import { LocationSettingsModal } from '@/components/portal/LocationSettingsModal'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface Candidate { vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; source: string; reference_destination: string | null; distance_km: number | null }
interface MyDelivery { id: string; description: string; status: string; total_fare_pkr: number | null; created_at: string; city_name: string; city_name_ur: string | null; as_role: string }

function fmtKm(km: number) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km` }

export default function ParcelDeliveryPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [cities, setCities] = useState<City[]>([])
  const [cityId, setCityId] = useState('')
  const [description, setDescription] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [recipientMobile, setRecipientMobile] = useState('')
  const [pickupLabel, setPickupLabel] = useState('')
  const [pickupLat, setPickupLat] = useState<number | null>(null)
  const [pickupLng, setPickupLng] = useState<number | null>(null)
  const [dropoffLabel, setDropoffLabel] = useState('')
  const [dropoffLat, setDropoffLat] = useState<number | null>(null)
  const [dropoffLng, setDropoffLng] = useState<number | null>(null)
  const [checkingLocation, setCheckingLocation] = useState(false)
  const [locationModalReason, setLocationModalReason] = useState<Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'> | null>(null)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [posting, setPosting] = useState<string | null>(null)
  const [myDeliveries, setMyDeliveries] = useState<MyDelivery[]>([])

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMyDeliveries = () => supabase.rpc('my_parcel_deliveries').then(({ data }) => setMyDeliveries((data ?? []) as MyDelivery[]))
  useEffect(() => { if (user) loadMyDeliveries() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cityId) { setCandidates(null); return }
    setCandidates(null)
    supabase.rpc('city_purchase_candidates', { p_city_id: cityId, p_pickup_lat: pickupLat, p_pickup_lng: pickupLng }).then(({ data }) => setCandidates((data ?? []) as Candidate[]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, pickupLat, pickupLng])

  const useMyLocation = async (which: 'pickup' | 'dropoff') => {
    setCheckingLocation(true)
    try {
      const pos = await getCurrentPositionOnce()
      if (which === 'pickup') { setPickupLat(pos.lat); setPickupLng(pos.lng) } else { setDropoffLat(pos.lat); setDropoffLng(pos.lng) }
      toast.success(t('vp.locationCapturedToast'))
    } catch (err) {
      const reason = classifyLocationError(err)
      if (reason === 'timeout') toast.error(t('af.locationTimeoutHint'))
      else setLocationModalReason(reason === 'permission_denied' ? 'permission_denied' : 'services_disabled')
    }
    setCheckingLocation(false)
  }

  const validate = () => {
    if (!cityId) { toast.error(t('vp.pickCityFirstError')); return false }
    if (!description.trim()) { toast.error(t('vp.describeItemFirst')); return false }
    return true
  }

  const post = async (targetVehicleId: string | null) => {
    if (!validate()) return
    setPosting(targetVehicleId ?? 'all')
    const { data: deliveryId, error } = await supabase.rpc('create_parcel_delivery', {
      p_city_id: cityId, p_description: description.trim(),
      p_pickup_label: pickupLabel.trim() || null, p_pickup_lat: pickupLat, p_pickup_lng: pickupLng,
      p_dropoff_label: dropoffLabel.trim() || null, p_dropoff_lat: dropoffLat, p_dropoff_lng: dropoffLng,
      p_recipient_name: recipientName.trim() || null, p_recipient_mobile: recipientMobile.trim() || null,
      p_target_vehicle_id: targetVehicleId,
    })
    setPosting(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/parcel/${deliveryId}`)
  }

  if (userLoading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  const pickedCity = cities.find((c) => c.id === cityId)
  const pickupPins: LeafletPin[] = pickupLat != null && pickupLng != null ? [{ lat: pickupLat, lng: pickupLng, color: '#dc2626' }] : []
  const dropoffPins: LeafletPin[] = dropoffLat != null && dropoffLng != null ? [{ lat: dropoffLat, lng: dropoffLng, color: '#166534' }] : []
  const sortedCandidates = [...(candidates ?? [])].sort((a, b) => {
    if (a.distance_km == null && b.distance_km == null) return 0
    if (a.distance_km == null) return 1
    if (b.distance_km == null) return -1
    return a.distance_km - b.distance_km
  })

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Package size={19} /> {t('vp.parcelPageTitle')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.parcelSubtitle')}</p>
      </div>

      <div className="bg-white border-2 border-[#005A36] rounded-2xl p-3.5 flex flex-col gap-2.5">
        <select value={cityId} onChange={(e) => setCityId(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]">
          <option value="">{t('vp.pickCityOption')}</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
        </select>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('vp.parcelDescriptionPlaceholder')} rows={3} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px] resize-none leading-relaxed" />
        <div className="grid grid-cols-2 gap-2">
          <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder={t('vp.recipientNamePlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
          <input value={recipientMobile} onChange={(e) => setRecipientMobile(e.target.value)} placeholder={t('vp.recipientMobilePlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
        </div>

        <input value={pickupLabel} onChange={(e) => setPickupLabel(e.target.value)} placeholder={t('vp.pickupLabelPlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
        {cityId && (
          <div>
            <p className="text-[12px] text-[#64748b] mb-1.5">{t('vp.tapMapForPickupHint')}</p>
            <LeafletMap
              pins={pickupPins} height={160} zoom={13} className="rounded-xl border border-[#e5e2d0]"
              center={pickedCity?.lat != null && pickedCity?.lng != null ? [pickedCity.lat, pickedCity.lng] : undefined}
              onMapClick={(lat, lng) => { setPickupLat(lat); setPickupLng(lng) }}
            />
            <div className="flex items-center gap-3 mt-1.5">
              {pickupLat != null && (
                <button onClick={() => { setPickupLat(null); setPickupLng(null) }} type="button" className="flex items-center gap-1 text-[12px] font-semibold text-[#64748b] cursor-pointer">
                  <X size={12} /> {t('vp.clearPickupPinBtn')}
                </button>
              )}
              <button onClick={() => useMyLocation('pickup')} disabled={checkingLocation} type="button" className="flex items-center gap-1.5 text-[12px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                <Navigation size={12} /> {checkingLocation ? t('af.confirmingLocationBtn') : t('vp.useMyLocationBtn')}
              </button>
            </div>
          </div>
        )}

        <input value={dropoffLabel} onChange={(e) => setDropoffLabel(e.target.value)} placeholder={t('vp.dropoffLabelPlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
        {cityId && (
          <div>
            <p className="text-[12px] text-[#64748b] mb-1.5">{t('vp.tapMapForDropoffHint')}</p>
            <LeafletMap
              pins={dropoffPins} height={160} zoom={13} className="rounded-xl border border-[#e5e2d0]"
              center={pickedCity?.lat != null && pickedCity?.lng != null ? [pickedCity.lat, pickedCity.lng] : undefined}
              onMapClick={(lat, lng) => { setDropoffLat(lat); setDropoffLng(lng) }}
            />
            <div className="flex items-center gap-3 mt-1.5">
              {dropoffLat != null && (
                <button onClick={() => { setDropoffLat(null); setDropoffLng(null) }} type="button" className="flex items-center gap-1 text-[12px] font-semibold text-[#64748b] cursor-pointer">
                  <X size={12} /> {t('vp.clearPickupPinBtn')}
                </button>
              )}
              <button onClick={() => useMyLocation('dropoff')} disabled={checkingLocation} type="button" className="flex items-center gap-1.5 text-[12px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                <Navigation size={12} /> {checkingLocation ? t('af.confirmingLocationBtn') : t('vp.useMyLocationBtn')}
              </button>
            </div>
          </div>
        )}

        <button onClick={() => post(null)} disabled={posting !== null} className="w-full bg-[#005A36] text-white py-2.5 rounded-xl text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">
          {posting === 'all' ? t('action.saving') : t('vp.askEveryoneBtn')}
        </button>
        <p className="text-[11px] text-[#64748b] text-center">{t('vp.orMessageOneHint')}</p>
      </div>

      {cityId && (
        <div>
          <p className="text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vp.candidateVehiclesHeading')}</p>
          {candidates === null && <p className="text-[13px] text-[#64748b]"><LoadingDots /></p>}
          {candidates && candidates.length === 0 && <p className="text-[12.5px] text-[#64748b]">{t('vp.noCandidatesNote')}</p>}
          <div className="flex flex-col gap-2">
            {sortedCandidates.map((c) => (
              <div key={c.vehicle_id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13.5px] font-semibold text-[#1e293b]">{c.owner_name} <span className="font-normal text-[11px] text-[#64748b]">· {c.vehicle_type}</span></p>
                  <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${c.source === 'presence' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800'}`}>
                    {t(`vp.candidateSource.${c.source}`)}
                  </span>
                </div>
                {c.reference_destination && (
                  <p className="text-[12px] text-[#64748b] mt-1 flex items-center gap-1"><MapPin size={11} /> {c.reference_destination}</p>
                )}
                <p className="text-[11.5px] mt-0.5 flex items-center gap-1 ltr-num">
                  {c.distance_km != null
                    ? <span className="text-[#166534] font-semibold">≈ {fmtKm(c.distance_km)} {t('vp.fromPickupSpotLabel')}</span>
                    : <span className="text-[#64748b] opacity-70">{t('vp.distanceUnknownNote')}</span>}
                </p>
                <button onClick={() => post(c.vehicle_id)} disabled={posting !== null} className="mt-2 px-3 py-1.5 rounded-xl text-[12px] font-semibold cursor-pointer border border-[#e5e2d0] text-[#166534] disabled:opacity-50">
                  {posting === c.vehicle_id ? t('action.saving') : t('vp.messageThisOneBtn')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {myDeliveries.length > 0 && (
        <div>
          <p className="text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vp.myParcelDeliveriesHeading')}</p>
          <div className="flex flex-col gap-2">
            {myDeliveries.map((d) => (
              <button key={d.id} onClick={() => router.push(`/portal/marketplace/parcel/${d.id}`)} className="w-full text-start flex items-center justify-between gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3.5 cursor-pointer">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[#1e293b] truncate">{d.description}</p>
                  <p className="text-[12px] text-[#64748b] mt-0.5 flex items-center gap-1"><Clock size={11} /> {isUrdu && d.city_name_ur ? d.city_name_ur : d.city_name} · {t(`vp.parcelStatus.${d.status}`)}</p>
                </div>
                <ChevronRight size={16} className={`text-[#64748b] shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
              </button>
            ))}
          </div>
        </div>
      )}

      {locationModalReason && <LocationSettingsModal reason={locationModalReason} onClose={() => setLocationModalReason(null)} />}
    </div>
  )
}
