'use client'

// City Purchase ("Purchase for Me") — rebuilt to match the reference
// design's own screen exactly. Real ask, 2026-10-26: "the existing
// screen is ugly and using two maps inside it which is absolutely
// garbage and wrong... completely copy the design." The old version
// picked a city from a dropdown, typed a free-text pickup label, then
// had its own separate small map just for dropping a pickup pin — two
// disconnected "where" interactions with no delivery address at all.
// This one uses the same full-screen LocationPickerSheet two other
// bookings already use (pickup shop, delivery address — defaulting to
// a saved "My Home" if one exists), one shared map showing both pins,
// a real formulaic fee (area base fee + per-km fuel, city_purchase_
// fee_estimate — see migration 732 for why these specific numbers),
// an area (city/out-of-city) and ride (bike/car) toggle — bike forced
// off for out-of-city, both in the UI and server-side — and a tip
// stepper. The existing candidate-discovery/trust-score/urgency-tier
// system (495/701/705/710) stays exactly as it is; this just always
// broadcasts to it (no more "ask everyone vs message this one" split,
// which the reference doesn't have either) instead of also exposing a
// candidate-browsing list the reference's screen never shows.
//
// Reusing a `vehicles` row for the service-fee formula would mean every
// vehicle owner needs a per-km rate configured first; city_purchase_
// fee_estimate instead reads two flat site_settings knobs (base fee per
// area + fuel per km) so this works for every village on day one, the
// same reasoning migration 732's own comment gives.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { ShoppingBag, Clock, ChevronRight, Info } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null; is_home_city: boolean }
interface FeeEstimate { distance_fare_pkr: number; detour_fuel_pkr: number; tip_pkr: number; total_fee_pkr: number }
interface MyRequest { id: string; item: string; status: string; total_fare_pkr: number | null; estimated_fee_pkr: number | null; created_at: string; city_name: string; city_name_ur: string | null; as_role: string }
type Area = 'city' | 'out_of_city'
type RideType = 'bike' | 'car'

const PAYMENT_METHODS: { key: string; emoji: string; labelKey: string }[] = [
  { key: 'cash', emoji: '💵', labelKey: 'mb.payCash' },
  { key: 'jazzcash', emoji: '📱', labelKey: 'mb.payJazzCash' },
  { key: 'easypaisa', emoji: '📲', labelKey: 'mb.payEasypaisa' },
]

function fmt(n: number) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

export default function CityPurchasePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [cities, setCities] = useState<City[]>([])
  const [loading, setLoading] = useState(true)
  const [myRequests, setMyRequests] = useState<MyRequest[]>([])

  const [pickupLoc, setPickupLoc] = useState<PickedLocation | null>(null)
  const [showPickupPicker, setShowPickupPicker] = useState(false)
  const [deliveryLoc, setDeliveryLoc] = useState<PickedLocation | null>(null)
  const [showDeliveryPicker, setShowDeliveryPicker] = useState(false)

  const [item, setItem] = useState('')
  const [budget, setBudget] = useState('')
  const [tipPkr, setTipPkr] = useState(0)
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().slice(0, 10))
  const [scheduledTime, setScheduledTime] = useState('08:00')
  const [area, setArea] = useState<Area>('city')
  const [rideType, setRideType] = useState<RideType>('bike')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng, is_home_city').eq('is_active', true).order('display_order').then(({ data }) => setCities((data ?? []) as City[]))
    // Real ask, 2026-10-26: the picker's own "Save as My Home" bookmark
    // (localStorage-only, same key LocationPickerSheet writes) doubles
    // as this screen's default delivery address — no second place to
    // save a home address, no backend needed for a single-device default.
    try {
      const raw = localStorage.getItem('dp-mobility-home')
      if (raw) setDeliveryLoc(JSON.parse(raw))
    } catch { /* ignore */ }
    setLoading(false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMyRequests = () => supabase.rpc('my_city_purchase_requests').then(({ data }) => setMyRequests((data ?? []) as MyRequest[]))
  useEffect(() => { if (user) loadMyRequests() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // Area forces ride-type: a motorbike is never offered for an
  // out-of-city delivery (direct instruction) — flip to car the instant
  // the area changes, not just at submit time, so the toggle's disabled
  // state is never showing a now-invalid prior selection.
  useEffect(() => { if (area === 'out_of_city' && rideType === 'bike') setRideType('car') }, [area, rideType])

  const distanceKm = pickupLoc && deliveryLoc ? haversineKm(pickupLoc, deliveryLoc) : null

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

  // Real gap found, 2026-10-26: this preview used to invent its own
  // flat area-base-fee + one-way haversine(pickup, delivery) number —
  // completely different math from what accept_city_purchase_request
  // actually charges once a driver accepts (round-trip city.distance_km
  // × the vehicle's own per_km_pkr, plus a pickup-detour top-up). A
  // rider could see one number here and get charged something else
  // entirely. Now calls the same real formula server-side (migration
  // 733's city_purchase_fee_estimate), using the matched city the
  // backend will actually bill against — the only unknown left is the
  // driver's own service fee, added once someone accepts.
  const matchedCity = nearestCity(pickupLoc)
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  useEffect(() => {
    if (!matchedCity || !pickupLoc) { setFeeEstimate(null); return }
    setEstimating(true)
    let cancelled = false
    supabase.rpc('city_purchase_fee_estimate', {
      p_city_id: matchedCity.id, p_pickup_lat: pickupLoc.lat, p_pickup_lng: pickupLoc.lng, p_tip_pkr: tipPkr, p_ride_type: rideType,
    }).then(({ data }) => { if (!cancelled) { setFeeEstimate((data as FeeEstimate) ?? null); setEstimating(false) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedCity?.id, pickupLoc?.lat, pickupLoc?.lng, tipPkr, rideType])
  const totalFee = feeEstimate?.total_fee_pkr ?? 0

  const post = async () => {
    if (!pickupLoc) { toast.error(t('vp.pickupShopPlaceholder')); return }
    if (!deliveryLoc) { toast.error(t('vp.deliveryHomePlaceholder')); return }
    if (!item.trim()) { toast.error(t('vp.describeItemFirst')); return }
    if (!scheduledDate) { toast.error(t('vp.scheduledDateRequired')); return }
    const city = nearestCity(pickupLoc)
    if (!city) { toast.error(t('vp.pickCityFirstError')); return }
    setPosting(true)
    const { data: requestId, error } = await supabase.rpc('create_city_purchase_request', {
      p_city_id: city.id, p_item: item.trim(), p_item_attachment_path: null,
      p_pickup_label: pickupLoc.label, p_pickup_lat: pickupLoc.lat, p_pickup_lng: pickupLoc.lng,
      p_goods_budget_pkr: budget ? Number(budget) : 0, p_target_vehicle_id: null, p_urgency: 'standard',
      p_delivery_label: deliveryLoc.label, p_delivery_lat: deliveryLoc.lat, p_delivery_lng: deliveryLoc.lng,
      p_area: area, p_ride_type: rideType, p_scheduled_date: scheduledDate, p_scheduled_time: scheduledTime || null,
      p_tip_pkr: tipPkr, p_payment_method: paymentMethod,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/city-purchase/${requestId}`)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  const mapPins: LeafletPin[] = []
  if (pickupLoc) mapPins.push({ lat: pickupLoc.lat, lng: pickupLoc.lng, label: pickupLoc.label, color: '#D4AF37', emoji: '🛍️' })
  if (deliveryLoc) mapPins.push({ lat: deliveryLoc.lat, lng: deliveryLoc.lng, label: deliveryLoc.label, color: '#166534', emoji: '🏠' })

  if (showPickupPicker) {
    return <LocationPickerSheet title={t('vp.pickupShopLabel')} initial={pickupLoc} inline onClose={() => setShowPickupPicker(false)} onConfirm={(loc) => { setPickupLoc(loc); setShowPickupPicker(false) }} />
  }
  if (showDeliveryPicker) {
    return <LocationPickerSheet title={t('vp.deliveryHomeLabel')} initial={deliveryLoc} inline onClose={() => setShowDeliveryPicker(false)} onConfirm={(loc) => { setDeliveryLoc(loc); setShowDeliveryPicker(false) }} />
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><ShoppingBag size={19} /> {t('vp.cityPurchasePageTitle')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.cityPurchaseSubtitle')}</p>
      </div>

      <button onClick={() => setShowPickupPicker(true)} className="w-full flex items-center gap-2.5 bg-white border border-[#e5e2d0] rounded-2xl p-3 text-start cursor-pointer">
        <span className="shrink-0 w-9 h-9 rounded-xl bg-[#ffe4e6] flex items-center justify-center text-[15px]">🛍️</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] text-[#64748b]">{t('vp.pickupShopLabel')}</span>
          <span className={`block text-[13.5px] font-bold truncate ${pickupLoc ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{pickupLoc ? pickupLoc.label : t('vp.pickupShopPlaceholder')}</span>
        </span>
        <span className="shrink-0 text-[11px] font-bold text-[#166534]">{t('vp.changeLocationBtn')}</span>
      </button>

      <button onClick={() => setShowDeliveryPicker(true)} className="w-full flex items-center gap-2.5 bg-white border border-[#e5e2d0] rounded-2xl p-3 text-start cursor-pointer">
        <span className="shrink-0 w-9 h-9 rounded-xl bg-[#dcfce7] flex items-center justify-center text-[15px]">🏠</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] text-[#64748b]">{t('vp.deliveryHomeLabel')}</span>
          <span className={`block text-[13.5px] font-bold truncate ${deliveryLoc ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{deliveryLoc ? deliveryLoc.label : t('vp.deliveryHomePlaceholder')}</span>
        </span>
        <span className="shrink-0 text-[11px] font-bold text-[#166534]">{t('vp.changeLocationBtn')}</span>
      </button>

      {mapPins.length > 0 && (
        <div className="relative">
          <LeafletMap pins={mapPins} height={190} className="rounded-2xl" />
          {distanceKm != null && (
            <span className="absolute top-2 end-2 z-10 bg-white/95 backdrop-blur-sm text-[10.5px] font-bold px-2 py-1 rounded-full text-[#1e293b] shadow ltr-num">{distanceKm.toFixed(1)} km 🚚</span>
          )}
        </div>
      )}

      <div className="bg-[#fffbeb] border border-[#fde68a] rounded-2xl p-3 flex items-center gap-3">
        <span className="text-[12.5px] font-bold text-[#1e293b] shrink-0">{t('vp.additionalTipLabel')}</span>
        <div dir="ltr" className="flex items-center border border-[#e5e2d0] rounded-xl overflow-hidden bg-white shrink-0">
          <button onClick={() => setTipPkr((v) => Math.max(0, v - 50))} className="w-8 h-8 border-0 text-[#166534] font-extrabold cursor-pointer">−</button>
          <span className="w-16 text-center font-extrabold text-[13px] ltr-num">{fmt(tipPkr)}</span>
          <button onClick={() => setTipPkr((v) => v + 50)} className="w-8 h-8 border-0 text-[#166534] font-extrabold cursor-pointer">+</button>
        </div>
        <span className="text-[10.5px] text-[#92400e] flex-1 min-w-0">{t('vp.additionalTipHint')}</span>
      </div>

      <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.scheduledDateTimeLabel')}</label>
      <div className="grid grid-cols-2 gap-2">
        <input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13px]" />
        <input type="date" value={scheduledDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setScheduledDate(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13px]" />
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.areaLabel')}</label>
        <div className="flex gap-1.5">
          {(['out_of_city', 'city'] as const).map((a) => (
            <button key={a} onClick={() => setArea(a)} className="flex-1 flex items-center justify-center gap-1 px-2.5 py-2 rounded-xl text-[12.5px] font-bold cursor-pointer border"
              style={{ background: area === a ? '#166534' : '#fff', color: area === a ? '#fff' : '#334155', borderColor: area === a ? '#166534' : '#e5e2d0' }}>
              {a === 'city' ? `🏙️ ${t('vp.areaCity')}` : `🚚 ${t('vp.areaOutOfCity')}`}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.rideTypeLabel')}</label>
        <div className="flex gap-1.5">
          {(['bike', 'car'] as const).map((r) => {
            const disabled = r === 'bike' && area === 'out_of_city'
            return (
              <button key={r} onClick={() => !disabled && setRideType(r)} disabled={disabled}
                className="flex-1 flex items-center justify-center gap-1 px-2.5 py-2 rounded-xl text-[12.5px] font-bold border disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: rideType === r && !disabled ? '#166534' : '#fff', color: rideType === r && !disabled ? '#fff' : '#334155', borderColor: rideType === r && !disabled ? '#166534' : '#e5e2d0', cursor: disabled ? 'not-allowed' : 'pointer' }}>
                {r === 'bike' ? `🏍️ ${t('vp.rideTypeBike')}` : `🚗 ${t('vp.rideTypeCar')}`}
              </button>
            )
          })}
        </div>
        {area === 'out_of_city' && <p className="text-[11px] text-[#92400e] mt-1">{t('vp.bikeDisabledOutOfCityNote')}</p>}
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('mb.paymentMethodsHeading')}</label>
        <div className="flex flex-wrap gap-1.5">
          {PAYMENT_METHODS.map((p) => (
            <button key={p.key} onClick={() => setPaymentMethod(p.key)}
              className="px-2.5 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border"
              style={{ background: paymentMethod === p.key ? '#166534' : '#fff', color: paymentMethod === p.key ? '#fff' : '#334155', borderColor: paymentMethod === p.key ? '#166534' : '#e5e2d0' }}>
              {p.emoji} {t(p.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.cityPurchaseItemPlaceholder')}</label>
        <textarea value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('vp.cityPurchaseItemPlaceholder')} rows={3} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px] resize-none leading-relaxed mb-2" />
        <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t('vp.goodsBudgetPlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
      </div>

      <div className="bg-[#F9F9F6] rounded-xl p-3">
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-[#64748b]">{t('vp.fuelFeeLabel')} <span className="ltr-num">({matchedCity ? matchedCity.name : '—'} · {t('vp.roundTripNote')})</span></span>
          <span className="font-bold text-[#1e293b] ltr-num">{fmt(feeEstimate?.distance_fare_pkr ?? 0)}</span>
        </div>
        {!!feeEstimate?.detour_fuel_pkr && (
          <div className="flex items-center justify-between text-[12px] mt-1 text-[#64748b]">
            <span>{t('vp.detourFuelLabel')}</span>
            <span className="ltr-num">{fmt(feeEstimate.detour_fuel_pkr)}</span>
          </div>
        )}
        {tipPkr > 0 && (
          <div className="flex items-center justify-between text-[12px] mt-1 text-[#64748b]">
            <span>{t('vp.additionalTipLabel')}</span>
            <span className="ltr-num">{fmt(tipPkr)}</span>
          </div>
        )}
        <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[#e5e2d0]">
          <span className="font-bold text-[13.5px] text-[#1e293b]">{estimating ? t('action.loading') : t('vp.totalFeeLabel')}</span>
          <span className="font-extrabold text-[16px] text-[#166534] ltr-num">{fmt(totalFee)}</span>
        </div>
        <p className="text-[10.5px] text-[#94a3b8] mt-1">{t('vp.driverServiceFeeAddedLaterNote')}</p>
        <p className="text-[10.5px] text-[#94a3b8] mt-0.5">{t('vp.goodsCostSeparateNote')}</p>
      </div>

      <div className="flex flex-col gap-1.5 text-[11.5px] text-[#1e3a5f] bg-[#eff6ff] border border-[#bfdbfe] rounded-xl p-2.5">
        <p className="flex items-center gap-1.5 font-bold"><Info size={13} className="shrink-0 text-[#2563eb]" /> {t('vp.howPaymentWorksHeading')}</p>
        <p>1. {t('vp.noAdvanceStepNote')}</p>
        <p>2. {t('vp.paymentStepDriverAcceptsNote')}</p>
        <p>3. {t('vp.paymentStepPayAfterJobNote')}</p>
      </div>

      <button onClick={post} disabled={posting} className="w-full bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2">
        {posting ? t('action.saving') : <>{t('vp.sendRequestBtn')} <span className="ltr-num">· {fmt(totalFee)}</span></>}
      </button>

      {myRequests.length > 0 && (
        <div>
          <p className="text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2 mt-1">{t('vp.myCityPurchasesHeading')}</p>
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
    </div>
  )
}
