'use client'

// City Purchase — deliberately separate from City Fetch (order-city,
// negotiation kind='fetch'). City Fetch stays a plain "carry this thing
// back" chat; this is the heavier "buy this specific thing for me from a
// specific place" job: an optional photo/prescription attachment, a
// pickup spot, a candidate list showing WHERE each nearby vehicle is
// actually headed, "ask everyone" (broadcast) or "message this one"
// (direct), then a real purchase → bill → deliver → confirm pipeline on
// the detail page (495).
//
// Phase 4: re-skinned to the new design + moved under marketplace/
// (mobility)/ — same RPCs/form fields throughout.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { ShoppingBag, MapPin, Navigation, Clock, ChevronRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { getCurrentPositionOnce, classifyLocationError, type LocationErrorReason } from '@/hooks/useLiveLocation'
import { LocationSettingsModal } from '@/components/portal/LocationSettingsModal'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface Candidate { vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; source: string; reference_destination: string | null; distance_km: number | null }
interface MyRequest { id: string; item: string; status: string; total_fare_pkr: number | null; created_at: string; city_name: string; city_name_ur: string | null; as_role: string }

function fmtKm(km: number) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km` }

export default function CityPurchasePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [cities, setCities] = useState<City[]>([])
  const [cityId, setCityId] = useState('')
  const [item, setItem] = useState('')
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null)
  const [pickupLabel, setPickupLabel] = useState('')
  const [pickupLat, setPickupLat] = useState<number | null>(null)
  const [pickupLng, setPickupLng] = useState<number | null>(null)
  const [checkingLocation, setCheckingLocation] = useState(false)
  const [locationModalReason, setLocationModalReason] = useState<Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'> | null>(null)
  const [budget, setBudget] = useState('')
  const [urgency, setUrgency] = useState<'standard' | '1hr' | '2hr' | 'urgent'>('standard')
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [posting, setPosting] = useState<string | null>(null)
  const [myRequests, setMyRequests] = useState<MyRequest[]>([])

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMyRequests = () => supabase.rpc('my_city_purchase_requests').then(({ data }) => setMyRequests((data ?? []) as MyRequest[]))
  useEffect(() => { if (user) loadMyRequests() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cityId) { setCandidates(null); return }
    setCandidates(null)
    supabase.rpc('city_purchase_candidates', { p_city_id: cityId, p_pickup_lat: pickupLat, p_pickup_lng: pickupLng, p_urgency: urgency }).then(({ data }) => setCandidates((data ?? []) as Candidate[]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, pickupLat, pickupLng, urgency])

  const useMyLocation = async () => {
    setCheckingLocation(true)
    try {
      const pos = await getCurrentPositionOnce()
      setPickupLat(pos.lat); setPickupLng(pos.lng)
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
    if (!item.trim()) { toast.error(t('vp.describeItemFirst')); return false }
    return true
  }

  const post = async (targetVehicleId: string | null) => {
    if (!validate()) return
    setPosting(targetVehicleId ?? 'all')
    const { data: requestId, error } = await supabase.rpc('create_city_purchase_request', {
      p_city_id: cityId, p_item: item.trim(), p_item_attachment_path: attachmentPath,
      p_pickup_label: pickupLabel.trim() || null, p_pickup_lat: pickupLat, p_pickup_lng: pickupLng,
      p_goods_budget_pkr: budget ? Number(budget) : 0, p_target_vehicle_id: targetVehicleId, p_urgency: urgency,
    })
    setPosting(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/city-purchase/${requestId}`)
  }

  if (userLoading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  const pickedCity = cities.find((c) => c.id === cityId)
  const pickupPins: LeafletPin[] = pickupLat != null && pickupLng != null ? [{ lat: pickupLat, lng: pickupLng, color: '#dc2626' }] : []
  const sortedCandidates = [...(candidates ?? [])].sort((a, b) => {
    if (a.distance_km == null && b.distance_km == null) return 0
    if (a.distance_km == null) return 1
    if (b.distance_km == null) return -1
    return a.distance_km - b.distance_km
  })

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><ShoppingBag size={19} /> {t('vp.cityPurchasePageTitle')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.cityPurchaseSubtitle')}</p>
      </div>

      <div className="bg-white border-2 border-[#005A36] rounded-2xl p-3.5 flex flex-col gap-2.5">
        <select value={cityId} onChange={(e) => setCityId(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]">
          <option value="">{t('vp.pickCityOption')}</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
        </select>
        <textarea value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('vp.cityPurchaseItemPlaceholder')} rows={3} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px] resize-none leading-relaxed" />
        <DonationReceiptUpload bucket="city_purchase_attachments" label={t('vp.attachItemPhotoLabel')} onUpload={setAttachmentPath} />
        <input value={pickupLabel} onChange={(e) => setPickupLabel(e.target.value)} placeholder={t('vp.pickupLabelPlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
        {cityId && (
          <div>
            <p className="text-[12px] text-[#64748b] mb-1.5">{t('vp.tapMapForPickupHint')}</p>
            <LeafletMap
              pins={pickupPins} height={180} zoom={13} className="rounded-xl border border-[#e5e2d0]"
              center={pickedCity?.lat != null && pickedCity?.lng != null ? [pickedCity.lat, pickedCity.lng] : undefined}
              onMapClick={(lat, lng) => { setPickupLat(lat); setPickupLng(lng) }}
            />
            <div className="flex items-center gap-3 mt-1.5">
              {pickupLat != null && (
                <button onClick={() => { setPickupLat(null); setPickupLng(null) }} type="button" className="flex items-center gap-1 text-[12px] font-semibold text-[#64748b] cursor-pointer">
                  <X size={12} /> {t('vp.clearPickupPinBtn')}
                </button>
              )}
              <button onClick={useMyLocation} disabled={checkingLocation} type="button" className="flex items-center gap-1.5 text-[12px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                <Navigation size={12} /> {checkingLocation ? t('af.confirmingLocationBtn') : t('vp.useMyLocationBtn')}
              </button>
            </div>
          </div>
        )}
        <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t('vp.goodsBudgetPlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
        <div>
          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.urgencyPickerLabel')}</label>
          <div className="flex flex-wrap gap-1.5">
            {(['standard', '1hr', '2hr', 'urgent'] as const).map((u) => (
              <button key={u} type="button" onClick={() => setUrgency(u)}
                className="px-2.5 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border"
                style={{ background: urgency === u ? '#166534' : '#fff', color: urgency === u ? '#fff' : '#334155', borderColor: urgency === u ? '#166534' : '#e5e2d0' }}>
                {t(`vp.urgency.${u}`)}
              </button>
            ))}
          </div>
        </div>
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

      {myRequests.length > 0 && (
        <div>
          <p className="text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vp.myCityPurchasesHeading')}</p>
          <div className="flex flex-col gap-2">
            {myRequests.map((r) => (
              <button key={r.id} onClick={() => router.push(`/portal/marketplace/city-purchase/${r.id}`)} className="w-full text-start flex items-center justify-between gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3.5 cursor-pointer">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[#1e293b] truncate">{r.item}</p>
                  <p className="text-[12px] text-[#64748b] mt-0.5 flex items-center gap-1"><Clock size={11} /> {isUrdu && r.city_name_ur ? r.city_name_ur : r.city_name} · {t(`vp.cityPurchaseStatus.${r.status}`)}</p>
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
