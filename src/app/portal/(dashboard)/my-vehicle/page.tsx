'use client'

// Driver Home — the design file's own `driver:home` screen.
//
// Two real mismatches found auditing against the actual design (not the
// plain prototype used earlier by mistake):
// 1. The profile/toggle/stats/wallet were split across several separate
//    white cards. The design renders all of it as ONE green gradient
//    hero card (#005A36→#166534) — name/vehicle/plate/toggle, a status
//    dot+line, a 2x2 stats grid (today's earnings/total jobs/rating/
//    committee-fee-or-plan-validity), and the gold wallet button, all
//    inside that single card. Rebuilt to match exactly.
// 2. "Publish a shared ride" (📢 اعلان کریں) is the design's own inline
//    Home-screen panel (`pubV`) — real backend already exists for this
//    (place_trip_offer / vehicle_trip_offers, my-vehicle/trips/page.tsx,
//    richer than the design: one-way/return, fare negotiation, live
//    location share). It was never missing, just hidden behind a link
//    tile instead of shown inline here the way the design does. This is
//    a condensed quick-publish version of that same real RPC; the full
//    page (fare offers, live-share toggle, history) is still linked
//    below for anything needing more than the quick path.
//
// City-presence is this app's own real addition (the design has no
// multi-city driver concept) — kept as its own card, not merged into
// the hero, since it isn't part of the design's card at all.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { MapPin, Bus, Route as RouteIcon, Users2, CalendarClock, ChevronRight, AlertCircle, Megaphone } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { useDriverJobsBadge } from '@/components/mobility/DriverJobsBadgeContext'
import { useVehicleLocationRefresh } from '@/hooks/useVehicleLocationRefresh'
import { CityReturnDemandCard } from '@/components/mobility/CityReturnDemandCard'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { fetchRoadRoute, type RoadRoute } from '@/lib/roadRoute'
import { SITE } from '@/lib/constants'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

// Real gap found live ("there was a map... where driver was creating
// route and ilaan"): the design's own destination picker for this panel
// opens a map (drag/tap a pin), same shape as `LocationPickerSheet` —
// already the established picker for hourly pickup/shadi venue/equipment
// site elsewhere in this app. The quick-publish panel below used flat
// city-name buttons instead, with no map at all. Reuses that same
// component now instead of inventing a second, different picker.
//
// Real gap found live, 2026-10-20: "the driver still can select the
// fare on his own, why it's not as per the backend... from where driver
// can select the one way or two way." Two separate bugs confirmed: (1)
// this panel's own "suggested" starting fare used a flat made-up
// 9 PKR/km guess over a straight-line distance — a completely different
// number from the real backend ceiling (place_trip_offer's own
// fare_band_for('trip_share', distance), base 150 + 5/km), so the
// suggestion was never actually "as per the backend" and could land
// above the real ceiling and get silently rejected on submit for longer
// trips. (2) p_trip_type was hardcoded to 'oneway' — the backend has
// always supported 'return' (my-vehicle/trips' own fuller Post Trip form
// already uses it), this quick panel just never exposed the toggle.
// Fixed by fetching the exact same fare_band_for the backend itself
// checks against, showing/suggesting its real `fair` value, and capping
// the stepper there so the driver can never type a number the backend
// would reject — plus the same one-way/return toggle the fuller form has.

interface Vehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string; is_online: boolean; total_seats: number }
interface Summary {
  today_earnings_pkr: number; today_jobs_count: number; pending_bookings_count: number
  avg_rating: number | null; balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null; commission_pct: number
}
interface City { id: string; name: string; name_ur: string | null }
interface Presence { city_id: string }
interface TripOffer { id: string; destination: string; destination_ur: string | null; departure_time_estimate: string | null; seats_available: number; listed_fare_per_seat_pkr: number; status: string }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() }

const DEPARTURE_OFFSETS = [30, 60, 180] as const // minutes; a 4th "tomorrow AM" option is handled separately

export default function MyVehicleHomePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const { count: jobsBadge, refresh: refreshBadge } = useDriverJobsBadge()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [cities, setCities] = useState<City[]>([])
  const [presence, setPresence] = useState<Presence | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [rideEligible, setRideEligible] = useState(false)
  const [myTripOffers, setMyTripOffers] = useState<TripOffer[]>([])
  const [destination, setDestination] = useState<PickedLocation | null>(null)
  const [showDestPicker, setShowDestPicker] = useState(false)
  const [tripType, setTripType] = useState<'oneway' | 'return'>('oneway')
  const [returnDepartureTime, setReturnDepartureTime] = useState('')
  const [returnWaitMinutes, setReturnWaitMinutes] = useState(300)
  const [route, setRoute] = useState<RoadRoute | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [fareBand, setFareBand] = useState<{ min: number; max: number; fair: number } | null>(null)
  const [departureChoice, setDepartureChoice] = useState<number | 'tomorrow'>(60)
  const [seats, setSeats] = useState(4)
  const [fare, setFare] = useState(300)
  const [fareTouched, setFareTouched] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const reloadPresence = async (vehicleId: string) => {
    const { data: p } = await supabase.from('vehicle_city_presence').select('city_id').eq('vehicle_id', vehicleId).eq('is_active', true).maybeSingle()
    setPresence(p ?? null)
  }
  const reloadTripOffers = async (vehicleId: string) => {
    const { data } = await supabase.from('vehicle_trip_offers')
      .select('id, destination, destination_ur, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, status')
      .eq('vehicle_id', vehicleId).eq('status', 'open').order('created_at', { ascending: false })
    setMyTripOffers(data ?? [])
  }

  useEffect(() => {
    if (!user) return
    Promise.all([
      supabase.from('vehicles').select('id, owner_name, vehicle_type, vehicle_number, is_online, total_seats').eq('portal_user_id', user.id).maybeSingle(),
      supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order'),
    ]).then(async ([{ data: v }, { data: c }]) => {
      setCities(c ?? [])
      if (v) {
        setVehicle(v)
        setSeats(Math.min(v.total_seats || 4, 4))
        const [{ data: sc }, { data: offers }] = await Promise.all([
          supabase.from('service_classes').select('id, ride_eligible').eq('is_active', true),
          supabase.from('vehicle_service_offers').select('service_class_id').eq('vehicle_id', v.id).eq('is_active', true),
          supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: v.id }).then(({ data: s }) => setSummary(s as unknown as Summary)),
          reloadPresence(v.id),
          reloadTripOffers(v.id),
        ])
        const mine = new Set((offers ?? []).map((o) => o.service_class_id))
        const myClasses = (sc ?? []).filter((cl) => mine.has(cl.id))
        setRideEligible(myClasses.length === 0 || myClasses.some((cl) => cl.ride_eligible))
      }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useVehicleLocationRefresh(vehicle?.id ?? null, vehicle?.is_online ?? false)

  const toggleOnline = async () => {
    if (!vehicle) return
    const goingOnline = !vehicle.is_online
    setSaving(true)

    // Real ask, 2026-10-17: "why is there a manual 'where are you now'
    // button, why not the system just knows" -- going online now grabs
    // one GPS fix automatically instead. Best-effort only: a denied
    // permission or a timeout still lets the driver go online, just
    // without a location on file for that session (same as before this
    // change existed at all) -- never block the actual toggle on it.
    let lat: number | null = null, lng: number | null = null
    if (goingOnline && typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, maximumAge: 60000 })
        )
        lat = pos.coords.latitude
        lng = pos.coords.longitude
      } catch { /* denied/unavailable — go online anyway, without a location */ }
    }

    const { error } = await supabase.rpc('set_vehicle_online_status', {
      p_vehicle_id: vehicle.id, p_is_online: goingOnline, p_lat: lat, p_lng: lng,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, is_online: goingOnline })
    toast.success(goingOnline ? t('vp.wentOnlineToast') : t('vp.wentOfflineToast'))
  }

  const pickCity = async (cityId: string) => {
    if (!vehicle) return
    setSaving(true)
    const { error } = presence?.city_id === cityId
      ? await supabase.rpc('vehicle_check_out_city', { p_vehicle_id: vehicle.id })
      : await supabase.rpc('vehicle_check_in_city', { p_vehicle_id: vehicle.id, p_city_id: cityId })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reloadPresence(vehicle.id)
  }

  // Real road distance (OSRM) + the exact same fare_band_for the backend
  // itself will check p_listed_fare_per_seat_pkr against — resolved
  // together whenever the destination changes, so the suggestion and the
  // stepper's own cap always match what place_trip_offer will actually
  // accept.
  useEffect(() => {
    if (!destination) { setRoute(null); setFareBand(null); return }
    setRouteLoading(true)
    let cancelled = false
    fetchRoadRoute({ lat: SITE.lat, lng: SITE.lng }, { lat: destination.lat, lng: destination.lng }).then(async (r) => {
      if (cancelled) return
      setRoute(r)
      const { data } = await supabase.rpc('fare_band_for', { p_flow: 'trip_share', p_km: r.distanceKm })
      if (!cancelled) setFareBand((data as { min: number; max: number; fair: number } | null) ?? null)
      setRouteLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.lat, destination?.lng])

  const publishRide = async () => {
    if (!vehicle) return
    if (!destination || !route) { toast.error(t('vp.pickDestinationError')); return }
    if (!vehicle.is_online) { toast.error(t('vp.goOnlineToPostTripHint')); return }
    setPublishing(true)
    const now = new Date()
    let travelDate = now
    let timeEstimate: string
    if (departureChoice === 'tomorrow') {
      travelDate = new Date(now.getTime() + 24 * 3600 * 1000)
      timeEstimate = '08:00'
    } else {
      const dep = new Date(now.getTime() + departureChoice * 60 * 1000)
      travelDate = dep
      timeEstimate = `${String(dep.getHours()).padStart(2, '0')}:${String(dep.getMinutes()).padStart(2, '0')}`
    }
    const { error } = await supabase.rpc('place_trip_offer', {
      p_vehicle_id: vehicle.id, p_trip_type: tripType,
      p_origin: t('vp.myAreaOriginLabel'), p_origin_ur: isUrdu ? t('vp.myAreaOriginLabel') : null,
      p_destination: destination.label, p_destination_ur: isUrdu ? destination.label : null,
      p_classification: 'intercity', p_travel_date: travelDate.toISOString().slice(0, 10), p_departure_time_estimate: timeEstimate,
      p_seats_available: seats, p_listed_fare_per_seat_pkr: fare,
      p_distance_km: Math.round(route.distanceKm), p_dest_lat: destination.lat, p_dest_lng: destination.lng,
      p_return_departure_time_estimate: tripType === 'return' ? (returnDepartureTime || null) : null,
      p_return_wait_minutes: tripType === 'return' ? returnWaitMinutes : null,
    })
    setPublishing(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cm.tripPostedToast'))
    setDestination(null)
    setFareTouched(false)
    setTripType('oneway')
    setReturnDepartureTime('')
    setReturnWaitMinutes(300)
    reloadTripOffers(vehicle.id)
  }

  // The backend ceiling (place_trip_offer) is `fair`, not `max` — `max`
  // is only the top of the wider negotiation band fare *offers* get
  // countered within elsewhere. Suggesting and capping at anything but
  // `fair` here would let the stepper reach a number the backend still
  // rejects.
  //
  // Real bug, reported live: a 'return' trip showed/capped the exact
  // same fare as 'oneway' — 4 riders doing the full round trip ended up
  // paying what should only cover one leg. A return listing's fare is
  // the FULL round trip (a one-way-only booker automatically pays half
  // of it, 693/728), so its ceiling must be double the single-leg fair
  // — place_trip_offer (737) enforces the same doubling server-side.
  const suggestedFare = fareBand ? Math.round(fareBand.fair) * (tripType === 'return' ? 2 : 1) : null
  const fareCeiling = fareBand ? Math.round(fareBand.fair) * (tripType === 'return' ? 2 : 1) : null
  useEffect(() => {
    if (suggestedFare != null && !fareTouched) setFare(suggestedFare)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedFare])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return null // layout's own guard already handled the no-vehicle case

  const depChips: { key: number | 'tomorrow'; label: string }[] = [
    ...DEPARTURE_OFFSETS.map((m) => ({ key: m, label: m < 60 ? t('vp.departInMinutes').replace('{n}', String(m)) : t('vp.departInHours').replace('{n}', String(m / 60)) })),
    { key: 'tomorrow', label: t('vp.departTomorrowAm') },
  ]

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl text-white p-3.5 flex flex-col gap-2.5" style={{ background: 'linear-gradient(to right,#005A36,#166534)', border: '1px solid rgba(212,175,55,.2)' }}>
        <div className="flex items-center gap-2.5">
          <span className="shrink-0 w-[42px] h-[42px] rounded-full bg-[#D4AF37] flex items-center justify-center font-bold text-[18px] text-[#0f172a]">{initials(vehicle.owner_name)}</span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[14.5px] font-bold truncate">{vehicle.owner_name}</p>
            <p className="font-sans text-[10.5px] text-[#dcfce7] truncate">{vehicle.vehicle_type} · <span className="ltr-num">{vehicle.vehicle_number}</span></p>
          </div>
          <button onClick={toggleOnline} disabled={saving} className="relative shrink-0 w-[46px] h-[26px] rounded-full border-0 cursor-pointer disabled:opacity-50 transition-colors" style={{ background: vehicle.is_online ? 'rgba(74,222,128,.9)' : 'rgba(255,255,255,.25)' }}>
            <span className="absolute top-[3px] w-5 h-5 rounded-full bg-white shadow transition-all" style={{ insetInlineStart: vehicle.is_online ? '23px' : '3px' }} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[#dcfce7]">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: vehicle.is_online ? '#4ade80' : '#94a3b8' }} />
          {vehicle.is_online ? t('vp.onlineLabel') : t('vp.offlineLabel')}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold ltr-num leading-tight">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{t('mv.todayLabel')}</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold ltr-num leading-tight">{summary?.today_jobs_count ?? 0}</p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{t('mv.jobsSuffix')}</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold leading-tight">{summary?.avg_rating != null ? `⭐ ${summary.avg_rating}` : '—'}</p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{t('vp.ratingLabel')}</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold ltr-num leading-tight">
              {summary?.commission_mode === 'monthly_lumpsum' ? fmt(summary?.lumpsum_fee_pkr ?? 0) : `${summary?.commission_pct ?? 0}%`}
            </p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{summary?.commission_mode === 'monthly_lumpsum' ? t('mv.lumpsumModeLabel') : t('mv.perOrderModeLabel')}</p>
          </div>
        </div>
        <Link href="/portal/my-vehicle/earnings" className="flex items-center gap-2 rounded-xl px-2.5 py-1.5" style={{ background: '#D4AF37', color: '#0f172a' }}>
          <span className="shrink-0 text-[15px]">💼</span>
          <span className="flex-1 font-sans text-[10.5px] font-bold">{t('vp.walletSummaryLabel')}</span>
          <ChevronRight size={14} className={`shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      </section>

      {rideEligible && (
        <section className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex flex-col gap-2">
          <p className="font-sans text-[12px] font-bold text-[#005A36] flex items-center gap-1.5"><Megaphone size={14} /> {t('vp.publishRideHeading')}</p>
          <p className="font-sans text-[10.5px] text-[#64748b]">{t('vp.publishRideHint')}</p>

          {showDestPicker ? (
            <LocationPickerSheet
              title={t('vp.pickDestinationPlaceholder')}
              initial={destination}
              defaultCenter={[SITE.lat, SITE.lng]}
              inline
              onClose={() => setShowDestPicker(false)}
              onConfirm={(loc) => { setDestination(loc); setShowDestPicker(false) }}
            />
          ) : (
            <>
              <button onClick={() => setShowDestPicker(true)} className="w-full flex items-center gap-2.5 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer">
                <span className="shrink-0 w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center"><MapPin size={14} className="text-[#D4AF37]" /></span>
                <span className={`flex-1 min-w-0 text-[12.5px] truncate ${destination ? 'font-bold text-[#1e293b]' : 'text-[#94a3b8]'}`}>{destination ? destination.label : t('vp.pickDestinationPlaceholder')}</span>
                <span className="shrink-0 font-sans text-[10.5px] font-bold text-[#166534]">🗺️ {t('vp.changeLocationBtn')}</span>
              </button>
              {destination && (
                <LeafletMap
                  pins={[{ lat: SITE.lat, lng: SITE.lng, color: '#166534' }, { lat: destination.lat, lng: destination.lng, color: '#D4AF37' }]}
                  route={route?.path}
                  height={140} className="rounded-xl"
                />
              )}
              {destination && (
                <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">
                  {routeLoading ? t('action.loading') : route ? `🛣️ ${Math.round(route.distanceKm)} km` : ''}
                </p>
              )}
              {fareBand != null && (
                <p className="font-sans text-[11.5px] text-[#166534] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg px-2.5 py-1.5">
                  {t('mv.fairPriceHint').replace('{price}', fmt(fareCeiling ?? 0))}
                </p>
              )}

              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => setTripType('oneway')} className="flex-1 py-1.5 rounded-lg text-[11.5px] font-sans font-bold cursor-pointer border"
                  style={{ background: tripType === 'oneway' ? '#166534' : '#F9F9F6', color: tripType === 'oneway' ? '#fff' : '#64748b', borderColor: tripType === 'oneway' ? '#166534' : '#e5e2d0' }}>
                  {t('cm.tripTypeOneway')}
                </button>
                <button type="button" onClick={() => setTripType('return')} className="flex-1 py-1.5 rounded-lg text-[11.5px] font-sans font-bold cursor-pointer border"
                  style={{ background: tripType === 'return' ? '#166534' : '#F9F9F6', color: tripType === 'return' ? '#fff' : '#64748b', borderColor: tripType === 'return' ? '#166534' : '#e5e2d0' }}>
                  {t('cm.tripTypeReturn')}
                </button>
              </div>
              <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">{tripType === 'return' ? t('cm.tripTypeReturnHint') : t('cm.tripTypeOnewayHint')}</p>
              {tripType === 'return' && (
                <>
                  {/* Real ask, 2026-10-21: "make it same like the route
                      creating but this is not for weekly booking this is
                      for same day return" — a real wait window at the
                      destination (same chips as Routes), not just a
                      static display time. */}
                  <div>
                    <label className="block font-sans text-[10.5px] font-semibold text-[#334155] mb-1">{t('mv.returnWaitMinutesLabel')}</label>
                    <div className="flex gap-1.5 flex-wrap">
                      {[300, 360, 480].map((mins) => (
                        <button key={mins} type="button" onClick={() => setReturnWaitMinutes(mins)}
                          className={`px-2.5 py-1 rounded-lg font-sans text-[11px] font-semibold cursor-pointer ${returnWaitMinutes === mins ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                          {Math.round(mins / 60)}{t('mv.hoursShortSuffix')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block font-sans text-[10.5px] font-semibold text-[#334155] mb-1">{t('cm.returnDepartureTimeLabel')}</label>
                    <input type="time" dir="ltr" value={returnDepartureTime} onChange={(e) => setReturnDepartureTime(e.target.value)} className="w-full border border-[#e5e2d0] rounded-lg px-2.5 py-1.5 text-[12.5px] font-sans" />
                  </div>
                </>
              )}

              <div className="flex items-center gap-1.5 flex-wrap">
                {depChips.map((c) => (
                  <button key={String(c.key)} onClick={() => setDepartureChoice(c.key)} className="px-2.5 py-1 rounded-full text-[10.5px] font-sans font-semibold cursor-pointer"
                    style={{ background: departureChoice === c.key ? '#166534' : '#F9F9F6', color: departureChoice === c.key ? '#fff' : '#334155', border: `1px solid ${departureChoice === c.key ? '#166534' : '#e5e2d0'}` }}>
                    🕒 {c.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="font-sans text-[10.5px] font-semibold text-[#334155]">{t('mk.totalSeatsLabel')}</span>
                  <div dir="ltr" className="flex items-center border border-[#e5e2d0] rounded-lg overflow-hidden">
                    <button onClick={() => setSeats((s) => Math.max(1, s - 1))} className="w-8 h-8 border-0 bg-[#F9F9F6] text-[#166534] font-bold cursor-pointer">−</button>
                    <span className="flex-1 text-center font-bold text-[13px] ltr-num">{seats}</span>
                    <button onClick={() => setSeats((s) => Math.min(vehicle.total_seats || 14, s + 1))} className="w-8 h-8 border-0 bg-[#F9F9F6] text-[#166534] font-bold cursor-pointer">+</button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-sans text-[10.5px] font-semibold text-[#334155]">{tripType === 'return' ? t('cm.listedFareLabelReturn') : t('cm.listedFareLabel')}</span>
                  <div dir="ltr" className="flex items-center border border-[#e5e2d0] rounded-lg overflow-hidden">
                    <button onClick={() => { setFareTouched(true); setFare((f) => Math.max(50, f - 50)) }} className="w-8 h-8 border-0 bg-[#F9F9F6] text-[#166534] font-bold cursor-pointer">−</button>
                    <span className="flex-1 text-center font-bold text-[13px] ltr-num">{fmt(fare)}</span>
                    <button onClick={() => { setFareTouched(true); setFare((f) => fareCeiling != null ? Math.min(fareCeiling, f + 50) : f + 50) }} disabled={fareCeiling != null && fare >= fareCeiling} className="w-8 h-8 border-0 bg-[#F9F9F6] text-[#166534] font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">+</button>
                  </div>
                </div>
              </div>
              {tripType === 'return' && fare > 0 && (
                <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">{t('cm.oneWayAutoHalfHint').replace('{price}', String(Math.round(fare / 2)))}</p>
              )}

              <button onClick={publishRide} disabled={publishing || routeLoading} className="rounded-xl py-2 font-sans text-[12.5px] font-extrabold cursor-pointer disabled:opacity-50" style={{ background: '#D4AF37', color: '#0f172a' }}>
                📢 {publishing ? t('action.saving') : t('cm.postTripBtn')}
              </button>

              {myTripOffers.length > 0 && (
                <div className="flex flex-col gap-1.5 pt-1">
                  {myTripOffers.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 rounded-lg bg-[#f0fdf4] px-2.5 py-1.5">
                      <span className="flex-1 min-w-0 font-sans text-[11px] font-bold text-[#166534] truncate">📍 {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</span>
                      <span className="shrink-0 font-sans text-[10px] text-[#475569] ltr-num">🕒 {r.departure_time_estimate?.slice(0, 5)} · 👥 {r.seats_available}</span>
                    </div>
                  ))}
                </div>
              )}
              <Link href="/portal/my-vehicle/trips" className="font-sans text-[11px] font-semibold text-[#166534] text-center">{t('vp.manageAllTripsLink')}</Link>
            </>
          )}
        </section>
      )}

      {/* Real ask, 2026-10-21: "the feature of creating a route on the main
          page is garbage looking, this feature is incomplete" — Routes used
          to be one plain, unlabeled grid tile ("Routes", same weight as
          Adda/Trips/Weekend) buried under a generic "More" heading, giving
          no hint this is where a driver starts a recurring daily route.
          Given its own prominent card here instead, matching the "Publish
          a shared ride" section right above it in weight and style — the
          /routes page itself already has a real, working create form; this
          just gives it an entry point that looks like it. */}
      <Link href="/portal/my-vehicle/routes" className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3 hover:border-[#166534]">
        <span className="shrink-0 w-10 h-10 rounded-full bg-[#F0FDF4] flex items-center justify-center"><RouteIcon size={18} className="text-[#166534]" /></span>
        <span className="flex-1 min-w-0">
          <span className="block font-sans text-[13px] font-bold text-[#005A36]">{t('mv.postRouteHomeHeading')}</span>
          <span className="block font-sans text-[10.5px] text-[#64748b] mt-0.5">{t('mv.postRouteHomeHint')}</span>
        </span>
        <ChevronRight size={16} className={`shrink-0 text-[#166534] ${isUrdu ? 'rotate-180' : ''}`} />
      </Link>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('vp.cityPresenceLabel')}</p>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5">
          {cities.map((c) => {
            const active = presence?.city_id === c.id
            return (
              <button key={c.id} onClick={() => pickCity(c.id)} disabled={saving} className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer disabled:opacity-50"
                style={{ background: active ? '#166534' : '#fff', color: active ? '#fff' : '#64748b', border: `1px solid ${active ? '#166534' : '#e5e2d0'}` }}>
                {active && <MapPin size={11} className="inline me-1 -mt-0.5" />}
                {isUrdu && c.name_ur ? c.name_ur : c.name}
              </button>
            )
          })}
        </div>
      </div>

      <CityReturnDemandCard />

      {jobsBadge > 0 && (
        <Link href="/portal/my-vehicle/jobs" onClick={() => refreshBadge()} className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-2xl p-3">
          <AlertCircle size={18} className="text-amber-700 shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block font-sans text-[13px] font-bold text-amber-900">{t('vp.newJobsBannerTitle').replace('{n}', String(jobsBadge))}</span>
            <span className="block font-sans text-[11.5px] text-amber-700">{t('vp.newJobsBannerBody')}</span>
          </span>
          <ChevronRight size={16} className={`text-amber-700 shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      )}

      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mt-1">{t('vp.moreServicesHeading')}</p>
      <div className="grid grid-cols-2 gap-2.5">
        <Link href="/portal/my-vehicle/adda" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Bus size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.adda')}</span>
        </Link>
        <Link href="/portal/my-vehicle/trips" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Users2 size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.trips')}</span>
        </Link>
        <Link href="/portal/my-vehicle/weekend" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><CalendarClock size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.weekend')}</span>
        </Link>
      </div>
    </div>
  )
}
