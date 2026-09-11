'use client'

// City Purchase — deliberately separate from City Fetch (order-city,
// negotiation kind='fetch'). City Fetch stays a plain "carry this thing
// back" chat; this is the heavier "buy this specific thing for me from a
// specific place" job: an optional photo/prescription attachment, a
// pickup spot, a candidate list showing WHERE each nearby vehicle is
// actually headed (so the villager can judge fit themselves, per the
// design conversation), "ask everyone" (broadcast) or "message this
// one" (direct), then a real purchase → bill → deliver → confirm
// pipeline on the detail page (495).

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
import { MarketplaceBottomNav } from '@/components/portal/MarketplaceBottomNav'
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
    supabase.rpc('city_purchase_candidates', { p_city_id: cityId, p_pickup_lat: pickupLat, p_pickup_lng: pickupLng }).then(({ data }) => setCandidates((data ?? []) as Candidate[]))
    // Re-runs whenever the pickup pin changes too, so distances update the
    // moment the villager taps the map — not just when the city changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, pickupLat, pickupLng])

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
      p_goods_budget_pkr: budget ? Number(budget) : 0, p_target_vehicle_id: targetVehicleId,
    })
    setPosting(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/city-purchase/${requestId}`)
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const pickedCity = cities.find((c) => c.id === cityId)
  const pickupPins: LeafletPin[] = pickupLat != null && pickupLng != null ? [{ lat: pickupLat, lng: pickupLng, color: '#dc2626' }] : []
  // Nearest-first, distance-unknown candidates last — the RPC already
  // sorts this way; re-sorting client-side too so it stays correct if a
  // stale response ever lands out of order during rapid pin changes.
  const sortedCandidates = [...(candidates ?? [])].sort((a, b) => {
    if (a.distance_km == null && b.distance_km == null) return 0
    if (a.distance_km == null) return 1
    if (b.distance_km == null) return -1
    return a.distance_km - b.distance_km
  })

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16 max-w-lg mx-auto">
      <div className="mb-5">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><ShoppingBag size={22} className="text-dp-secondary" /> {t('vp.cityPurchasePageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vp.cityPurchaseSubtitle')}</p>
      </div>

      <div className="bg-white border-2 border-dp-primary rounded-lg p-3.5 mb-5 space-y-2.5">
        <select value={cityId} onChange={(e) => setCityId(e.target.value)} className="input-field">
          <option value="">{t('vp.pickCityOption')}</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
        </select>
        <textarea value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('vp.cityPurchaseItemPlaceholder')} rows={2} className="input-field resize-none" />
        <DonationReceiptUpload bucket="city_purchase_attachments" label={t('vp.attachItemPhotoLabel')} onUpload={setAttachmentPath} />
        <input value={pickupLabel} onChange={(e) => setPickupLabel(e.target.value)} placeholder={t('vp.pickupLabelPlaceholder')} className="input-field" />
        {cityId && (
          <div>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mb-1.5">{t('vp.tapMapForPickupHint')}</p>
            <LeafletMap
              pins={pickupPins} height={180} zoom={13} className="rounded-lg border border-dp-outline-variant"
              center={pickedCity?.lat != null && pickedCity?.lng != null ? [pickedCity.lat, pickedCity.lng] : undefined}
              onMapClick={(lat, lng) => { setPickupLat(lat); setPickupLng(lng) }}
            />
            <div className="flex items-center gap-3 mt-1.5">
              {pickupLat != null && (
                <button onClick={() => { setPickupLat(null); setPickupLng(null) }} type="button" className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
                  <X size={12} /> {t('vp.clearPickupPinBtn')}
                </button>
              )}
              <button onClick={useMyLocation} disabled={checkingLocation} type="button" className="flex items-center gap-1.5 font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer disabled:opacity-50">
                <Navigation size={12} /> {checkingLocation ? t('af.confirmingLocationBtn') : t('vp.useMyLocationBtn')}
              </button>
            </div>
          </div>
        )}
        <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t('vp.goodsBudgetPlaceholder')} className="input-field" />
        <button onClick={() => post(null)} disabled={posting !== null} className="w-full bg-dp-primary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50">
          {posting === 'all' ? t('action.saving') : t('vp.askEveryoneBtn')}
        </button>
        <p className="font-sans text-[11px] text-dp-on-surface-variant text-center">{t('vp.orMessageOneHint')}</p>
      </div>

      {cityId && (
        <div className="mb-6">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vp.candidateVehiclesHeading')}</p>
          {candidates === null && <p className="font-sans text-[13px] text-dp-on-surface-variant"><LoadingDots /></p>}
          {candidates && candidates.length === 0 && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('vp.noCandidatesNote')}</p>}
          <div className="space-y-2">
            {sortedCandidates.map((c) => (
              <div key={c.vehicle_id} className="bg-white border border-dp-outline-variant rounded-lg p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{c.owner_name} <span className="font-normal text-[11px] text-dp-on-surface-variant">· {c.vehicle_type}</span></p>
                  <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${c.source === 'presence' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800'}`}>
                    {t(`vp.candidateSource.${c.source}`)}
                  </span>
                </div>
                {c.reference_destination && (
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><MapPin size={11} /> {c.reference_destination}</p>
                )}
                <p className="font-sans text-[11.5px] mt-0.5 flex items-center gap-1 ltr-num">
                  {c.distance_km != null
                    ? <span className="text-dp-secondary font-semibold">≈ {fmtKm(c.distance_km)} {t('vp.fromPickupSpotLabel')}</span>
                    : <span className="text-dp-on-surface-variant opacity-70">{t('vp.distanceUnknownNote')}</span>}
                </p>
                <button onClick={() => post(c.vehicle_id)} disabled={posting !== null} className="mt-2 px-3 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container disabled:opacity-50">
                  {posting === c.vehicle_id ? t('action.saving') : t('vp.messageThisOneBtn')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {myRequests.length > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vp.myCityPurchasesHeading')}</p>
          <div className="space-y-2">
            {myRequests.map((r) => (
              <button key={r.id} onClick={() => router.push(`/portal/marketplace/city-purchase/${r.id}`)} className="w-full text-start flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors cursor-pointer">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{r.item}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1"><Clock size={11} /> {isUrdu && r.city_name_ur ? r.city_name_ur : r.city_name} · {t(`vp.cityPurchaseStatus.${r.status}`)}</p>
                </div>
                <ChevronRight size={16} className={`text-dp-on-surface-variant shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
              </button>
            ))}
          </div>
        </div>
      )}

      {locationModalReason && <LocationSettingsModal reason={locationModalReason} onClose={() => setLocationModalReason(null)} />}
      <MarketplaceBottomNav />
    </div>
  )
}
