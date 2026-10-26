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
//
// Real complaint, 2026-10-27: "why this system is using two maps lol"
// — found live on this screen too (the loader form had the same bug,
// fixed earlier the same session). Rebuilt on the same LocationPickerSheet
// + one shared map pattern as city-purchase: no more manual city
// dropdown (the destination city is now auto-matched from the dropoff
// pin, same nearestCity() reasoning city-purchase already uses for its
// pickup point), no more disconnected free-text label + raw tap-map
// pair, no more hand-rolled "use my location" button (LocationPickerSheet
// already has GPS/search/Urdu reverse-geocoding built in).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { Package, MapPin, Clock, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { fetchRoadRoute, type RoadRoute } from '@/lib/roadRoute'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

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
  const [description, setDescription] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [recipientMobile, setRecipientMobile] = useState('')
  const [pickupLoc, setPickupLoc] = useState<PickedLocation | null>(null)
  const [showPickupPicker, setShowPickupPicker] = useState(false)
  const [dropoffLoc, setDropoffLoc] = useState<PickedLocation | null>(null)
  const [showDropoffPicker, setShowDropoffPicker] = useState(false)
  const [pdRoute, setPdRoute] = useState<RoadRoute | null>(null)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [posting, setPosting] = useState<string | null>(null)
  const [myDeliveries, setMyDeliveries] = useState<MyDelivery[]>([])

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMyDeliveries = () => supabase.rpc('my_parcel_deliveries').then(({ data }) => setMyDeliveries((data ?? []) as MyDelivery[]))
  useEffect(() => { if (user) loadMyDeliveries() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // The destination city is auto-matched from the dropoff pin instead
  // of a manual dropdown — same reasoning city-purchase already uses
  // for its own pickup point.
  const nearestCity = (loc: PickedLocation | null): City | null => {
    if (!loc) return null
    const withCoords = cities.filter((c) => c.lat != null && c.lng != null)
    if (withCoords.length === 0) return null
    return withCoords.reduce((best, c) => {
      const d = haversineKm(loc, { lat: c.lat!, lng: c.lng! })
      const bestD = haversineKm(loc, { lat: best.lat!, lng: best.lng! })
      return d < bestD ? c : best
    })
  }
  const matchedCity = nearestCity(dropoffLoc)
  const cityId = matchedCity?.id ?? ''

  useEffect(() => {
    if (!pickupLoc || !dropoffLoc) { setPdRoute(null); return }
    let cancelled = false
    fetchRoadRoute({ lat: pickupLoc.lat, lng: pickupLoc.lng }, { lat: dropoffLoc.lat, lng: dropoffLoc.lng }).then((r) => { if (!cancelled) setPdRoute(r) })
    return () => { cancelled = true }
  }, [pickupLoc?.lat, pickupLoc?.lng, dropoffLoc?.lat, dropoffLoc?.lng])

  useEffect(() => {
    if (!cityId) { setCandidates(null); return }
    setCandidates(null)
    supabase.rpc('city_purchase_candidates', { p_city_id: cityId, p_pickup_lat: pickupLoc?.lat ?? null, p_pickup_lng: pickupLoc?.lng ?? null }).then(({ data }) => setCandidates((data ?? []) as Candidate[]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, pickupLoc?.lat, pickupLoc?.lng])

  const validate = () => {
    if (!pickupLoc) { toast.error(t('vp.pickupLabelPlaceholder')); return false }
    if (!dropoffLoc) { toast.error(t('vp.dropoffLabelPlaceholder')); return false }
    if (!cityId) { toast.error(t('vp.pickCityFirstError')); return false }
    if (!description.trim()) { toast.error(t('vp.describeItemFirst')); return false }
    return true
  }

  const post = async (targetVehicleId: string | null) => {
    if (!validate()) return
    setPosting(targetVehicleId ?? 'all')
    const { data: deliveryId, error } = await supabase.rpc('create_parcel_delivery', {
      p_city_id: cityId, p_description: description.trim(),
      p_pickup_label: pickupLoc!.label, p_pickup_lat: pickupLoc!.lat, p_pickup_lng: pickupLoc!.lng,
      p_dropoff_label: dropoffLoc!.label, p_dropoff_lat: dropoffLoc!.lat, p_dropoff_lng: dropoffLoc!.lng,
      p_recipient_name: recipientName.trim() || null, p_recipient_mobile: recipientMobile.trim() || null,
      p_target_vehicle_id: targetVehicleId,
    })
    setPosting(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/parcel/${deliveryId}`)
  }

  if (userLoading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  const mapPins: LeafletPin[] = []
  if (pickupLoc) mapPins.push({ lat: pickupLoc.lat, lng: pickupLoc.lng, label: pickupLoc.label, color: '#dc2626', emoji: '📦' })
  if (dropoffLoc) mapPins.push({ lat: dropoffLoc.lat, lng: dropoffLoc.lng, label: dropoffLoc.label, color: '#166534', emoji: '📍' })
  const sortedCandidates = [...(candidates ?? [])].sort((a, b) => {
    if (a.distance_km == null && b.distance_km == null) return 0
    if (a.distance_km == null) return 1
    if (b.distance_km == null) return -1
    return a.distance_km - b.distance_km
  })

  if (showPickupPicker) {
    return <LocationPickerSheet title={t('vp.pickupLabelPlaceholder')} initial={pickupLoc} inline onClose={() => setShowPickupPicker(false)} onConfirm={(loc) => { setPickupLoc(loc); setShowPickupPicker(false) }} />
  }
  if (showDropoffPicker) {
    return <LocationPickerSheet title={t('vp.dropoffLabelPlaceholder')} initial={dropoffLoc} inline onClose={() => setShowDropoffPicker(false)} onConfirm={(loc) => { setDropoffLoc(loc); setShowDropoffPicker(false) }} />
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Package size={19} /> {t('vp.parcelPageTitle')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.parcelSubtitle')}</p>
      </div>

      <div className="bg-white border-2 border-[#005A36] rounded-2xl p-3.5 flex flex-col gap-2.5">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('vp.parcelDescriptionPlaceholder')} rows={3} className="dp2-input text-[13.5px] resize-none leading-relaxed" />
        <div className="grid grid-cols-2 gap-2">
          <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder={t('vp.recipientNamePlaceholder')} className="dp2-input text-[13.5px]" />
          <input value={recipientMobile} onChange={(e) => setRecipientMobile(e.target.value)} placeholder={t('vp.recipientMobilePlaceholder')} className="dp2-input text-[13.5px]" />
        </div>

        <button onClick={() => setShowPickupPicker(true)} className="w-full flex items-center gap-2.5 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer">
          <span className="shrink-0 w-9 h-9 rounded-lg bg-rose-50 flex items-center justify-center"><Package size={15} className="text-[#dc2626]" /></span>
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] text-[#64748b]">{t('vp.pickupLabelPlaceholder')}</span>
            <span className={`block text-[13.5px] font-bold truncate ${pickupLoc ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{pickupLoc ? pickupLoc.label : t('vp.pickupLabelPlaceholder')}</span>
          </span>
          <span className="shrink-0 text-[11px] font-bold text-[#166534]">{t('vp.changeLocationBtn')}</span>
        </button>

        <button onClick={() => setShowDropoffPicker(true)} className="w-full flex items-center gap-2.5 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer">
          <span className="shrink-0 w-9 h-9 rounded-lg bg-[#dcfce7] flex items-center justify-center"><MapPin size={15} className="text-[#166534]" /></span>
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] text-[#64748b]">{t('vp.dropoffLabelPlaceholder')}</span>
            <span className={`block text-[13.5px] font-bold truncate ${dropoffLoc ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{dropoffLoc ? dropoffLoc.label : t('vp.dropoffLabelPlaceholder')}</span>
          </span>
          <span className="shrink-0 text-[11px] font-bold text-[#166534]">{t('vp.changeLocationBtn')}</span>
        </button>

        {mapPins.length > 0 && (
          <div className="relative">
            <LeafletMap pins={mapPins} route={pdRoute?.path} height={180} className="rounded-xl" />
            {pdRoute && (
              <span className="absolute top-2 end-2 z-10 bg-white/95 backdrop-blur-sm text-[10.5px] font-bold px-2 py-1 rounded-full text-[#1e293b] shadow ltr-num">{pdRoute.distanceKm.toFixed(1)} km 🛣️</span>
            )}
          </div>
        )}
        {dropoffLoc && !matchedCity && (
          <p className="text-[11px] text-amber-700">{t('vp.pickCityFirstError')}</p>
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

    </div>
  )
}
