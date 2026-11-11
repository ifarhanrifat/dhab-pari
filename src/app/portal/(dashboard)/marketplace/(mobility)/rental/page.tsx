'use client'

// Point-to-point vehicle rental — broadcast to every active vehicle in
// a category, structurally different from hourly (rate × hours, one
// fixed pickup): a real pickup AND destination, a one-way/return
// choice, and an optional driver-wait fee on a return trip. Price is
// formulaic (the category's own fare-guide rate: base + per-km × trip-
// type multiplier + wait fee, all locked in at request time).
//
// Real ask, 2026-11-03: "we can't allow the rider to pick up a
// separate vehicle from the catalog, it will be unjustifying... send
// the calls to all drivers who are nearby so everyone gets a chance."
// Modeled on hourly/page.tsx's same broadcast rewrite (787) — picking
// a category tile + an optional preferred model year goes straight to
// the booking form, no per-vehicle picking step. No live GPS tracking
// here: unlike hourly, both ends of the trip are already fixed at
// request time, so there's no running distance to show while in
// progress.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { MapPin, Navigation, Loader2, AlertCircle, CheckCircle2, Ban, RotateCcw, Users, Home as HomeIcon } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { friendlyError } from '@/lib/errors'
import { haversineKm } from '@/lib/roadRoute'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { ShareBookingButton } from '@/components/portal/ShareBookingButton'
import { CallButton } from '@/components/portal/CallButton'
import { ChatButton } from '@/components/portal/ChatButton'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { RequestWaitingSheet, type WaitingSummary } from '@/components/mobility/RequestWaitingSheet'
import { FarePolicyCard } from '@/components/mobility/FarePolicyCard'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

const TIER_EMOJI: Record<string, string> = {
  small_ac: '🚗', small_non_ac: '🚗', compact_ac: '🚗', compact_non_ac: '🚗', big_ac: '🚘', big_non_ac: '🚖', suv: '🚙', luxury: '🏎️',
  van: '🚐', hiace: '🚌', coaster: '🚍', bus: '🚌',
}
const TIER_ORDER = ['small_ac', 'small_non_ac', 'compact_ac', 'compact_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus']
const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 26 }, (_, i) => CURRENT_YEAR - i)

interface TierOption {
  tier_key: string; vehicle_count: number
  rental_base_pkr: number; rental_per_km_pkr: number; rental_wait_hour_pkr: number
  out_of_city_base_pkr: number; out_of_city_per_km_pkr: number
  // 838: the linked vehicle_categories row's rider-card fields (may be
  // null for a tier no category maps onto yet).
  fare_spread_pct?: number | null; example_models_hint?: string | null; example_models_hint_ur?: string | null
}
interface Booking {
  id: string; from_address: string; from_lat: number | null; from_lng: number | null
  to_address: string; to_lat: number | null; to_lng: number | null
  trip_type: 'one' | 'return'; wait_hours: number; km: number; status: string; decline_reason: string | null; pin: string | null; is_out_of_city?: boolean
  base_amount_pkr: number; trip_amount_pkr: number; wait_amount_pkr: number; total_amount_pkr: number
  requested_at: string; started_at: string | null; ended_at: string | null
  notes: string | null; payment_method: string; vehicle_id: string | null; rental_tier: string | null
  owner_name: string | null; owner_mobile: string | null; vehicle_type: string | null; model: string | null; color: string | null
  category_name: string | null; category_name_ur: string | null
}
interface WaitingExtra {
  tripType: 'one' | 'return'; rentalTier: string
  fromLoc: PickedLocation; toLoc: PickedLocation
}

const PAYMENT_METHODS: { key: string; emoji: string; labelKey: string }[] = [
  { key: 'cash', emoji: '💵', labelKey: 'mb.payCash' },
  { key: 'jazzcash', emoji: '📱', labelKey: 'mb.payJazzCash' },
  { key: 'easypaisa', emoji: '📲', labelKey: 'mb.payEasypaisa' },
]

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// Standalone (not dependent on component state) so the "switch to
// return" fallback can recompute a fare for a booking that no longer
// matches whatever's currently sitting in the open form's fields.
function kmBetween(a: PickedLocation, b: PickedLocation) {
  const rad = (x: number) => (x * Math.PI) / 180
  const dl = rad(b.lat - a.lat), dn = rad(b.lng - a.lng)
  const s = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2
  return Math.max(1, Math.round(6371 * 2 * Math.asin(Math.sqrt(s)) * 1.3))
}
// Real ask, 2026-11-04: Rental's one flat per-km rate was calibrated
// for short in-city hire-and-wait use and silently applied to highway
// trips too, pricing a village-to-outstation-city trip at roughly half
// of what the identical trip costs through Travel. Mirrors Travel's
// own "how far is this pin from the home city" check (destFarFromCity,
// 8km threshold) to pick the tier's out-of-city rate instead.
const OUT_OF_CITY_KM = 8
function isOutOfCityTrip(home: { lat: number; lng: number } | null, from: PickedLocation, to: PickedLocation) {
  if (!home) return false
  return haversineKm(home, from) > OUT_OF_CITY_KM || haversineKm(home, to) > OUT_OF_CITY_KM
}
function tripTotalFor(tier: TierOption, km: number, tripType: 'one' | 'return', waitHours: number, isOutOfCity: boolean) {
  const base = isOutOfCity ? tier.out_of_city_base_pkr : tier.rental_base_pkr
  const perKm = isOutOfCity ? tier.out_of_city_per_km_pkr : tier.rental_per_km_pkr
  const trip = tripType === 'return' ? km * 2 * perKm : km * perKm * 1.5
  const wait = tripType === 'return' ? waitHours * (tier.rental_wait_hour_pkr ?? 0) : 0
  return base + trip + wait
}

const STATUS_COLOR: Record<string, string> = {
  requested: '#92400e', accepted: '#166534', in_progress: '#166534', completed: '#334155', declined: '#b91c1c', cancelled: '#64748b',
}

export default function RentalPage() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [tab, setTab] = useState<'browse' | 'mine'>('browse')
  const [tiers, setTiers] = useState<TierOption[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [homeCity, setHomeCity] = useState<{ lat: number; lng: number } | null>(null)
  const [loading, setLoading] = useState(true)

  const [openTier, setOpenTier] = useState<TierOption | null>(null)
  const [preferredYear, setPreferredYear] = useState<number | null>(null)
  const [tripType, setTripType] = useState<'one' | 'return'>('one')
  const [waitHours, setWaitHours] = useState(0)
  const [fromLoc, setFromLoc] = useState<PickedLocation | null>(null)
  const [toLoc, setToLoc] = useState<PickedLocation | null>(null)
  const [showPicker, setShowPicker] = useState<'from' | 'to' | null>(null)
  const [notes, setNotes] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [requesting, setRequesting] = useState(false)
  const [waiting, setWaiting] = useState<{ id: string; summary: WaitingSummary; since: string | null; extra: WaitingExtra | null } | null>(null)
  const router = useRouter()

  const loadTiers = () => supabase.rpc('rental_tier_options').then(({ data }) => setTiers((data ?? []) as TierOption[]))
  const loadBookings = () => supabase.rpc('my_rental_bookings').then(({ data }) => { const rows = (data ?? []) as Booking[]; setBookings(rows); return rows })
  const tripFacts = (type: 'one' | 'return', wait: number) => [t(type === 'return' ? 'rw.returnTrip' : 'rw.oneWay'), ...(wait > 0 ? [t('rw.waitHours').replace('{n}', String(wait))] : [])]
  const waitingFor = (b: Booking) => ({
    id: b.id, since: b.requested_at,
    summary: {
      vehicleLabel: b.vehicle_type ? vehicleDisplayName(b.vehicle_type, b.model, isUrdu && b.category_name_ur ? b.category_name_ur : b.category_name) : t(`vp.rentalTier.${b.rental_tier}`),
      driverName: b.owner_name, from: b.from_address, to: b.to_address, amount: b.total_amount_pkr, facts: tripFacts(b.trip_type, b.wait_hours),
    },
    extra: (b.rental_tier && b.from_lat != null && b.from_lng != null && b.to_lat != null && b.to_lng != null) ? {
      tripType: b.trip_type, rentalTier: b.rental_tier,
      fromLoc: { lat: b.from_lat, lng: b.from_lng, label: b.from_address }, toLoc: { lat: b.to_lat, lng: b.to_lng, label: b.to_address },
    } as WaitingExtra : null,
  })

  useEffect(() => {
    if (!user) return
    supabase.from('cities').select('lat, lng').eq('is_home_city', true).limit(1).maybeSingle()
      .then(({ data }) => { if (data?.lat != null && data?.lng != null) setHomeCity({ lat: data.lat, lng: data.lng }) })
    Promise.all([loadTiers(), loadBookings()]).then(([, rows]) => {
      setLoading(false)
      const pending = rows.filter((b) => b.status === 'requested').sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0]
      if (pending) setWaiting(waitingFor(pending))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (tab !== 'mine' || !bookings.some((b) => ['requested', 'accepted', 'in_progress'].includes(b.status))) return
    const id = setInterval(loadBookings, 10000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookings])

  const openBooking = (tier: TierOption) => { setOpenTier(tier); setPreferredYear(null); setNotes(''); setPaymentMethod('cash') }
  const bookAgain = (tierKey: string | null) => {
    setTab('browse')
    const tier = tiers.find((x) => x.tier_key === tierKey)
    if (tier) openBooking(tier)
  }

  const km = (() => {
    if (!fromLoc || !toLoc) return 0
    const rad = (x: number) => (x * Math.PI) / 180
    const dl = rad(toLoc.lat - fromLoc.lat), dn = rad(toLoc.lng - fromLoc.lng)
    const s = Math.sin(dl / 2) ** 2 + Math.cos(rad(fromLoc.lat)) * Math.cos(rad(toLoc.lat)) * Math.sin(dn / 2) ** 2
    return Math.max(1, Math.round(6371 * 2 * Math.asin(Math.sqrt(s)) * 1.3))
  })()
  const isOutOfCity = !!fromLoc && !!toLoc && isOutOfCityTrip(homeCity, fromLoc, toLoc)
  const rateFor = (tier: TierOption) => (isOutOfCity
    ? { base: tier.out_of_city_base_pkr, perKm: tier.out_of_city_per_km_pkr }
    : { base: tier.rental_base_pkr, perKm: tier.rental_per_km_pkr })
  const tripFareFor = (tier: TierOption) => { const r = rateFor(tier); return tripType === 'return' ? km * 2 * r.perKm : km * r.perKm * 1.5 }
  const waitFareFor = (tier: TierOption) => (tripType === 'return' ? waitHours * (tier.rental_wait_hour_pkr ?? 0) : 0)
  const totalFor = (tier: TierOption) => rateFor(tier).base + tripFareFor(tier) + waitFareFor(tier)
  const estimatedTrip = openTier ? tripFareFor(openTier) : 0
  const estimatedWait = openTier ? waitFareFor(openTier) : 0
  const estimatedTotal = openTier ? totalFor(openTier) : 0
  const haveRoute = !!fromLoc && !!toLoc

  const submitRequest = async () => {
    if (!openTier) return
    if (!fromLoc || !toLoc) { toast.error(t('vp.rentalFromToRequired')); return }
    setRequesting(true)
    const { data: bookingId, error } = await supabase.rpc('create_rental_booking', {
      p_rental_tier: openTier.tier_key, p_from_address: fromLoc.label, p_from_lat: fromLoc.lat, p_from_lng: fromLoc.lng,
      p_to_address: toLoc.label, p_to_lat: toLoc.lat, p_to_lng: toLoc.lng, p_trip_type: tripType, p_wait_hours: tripType === 'return' ? waitHours : 0,
      p_preferred_year: preferredYear, p_notes: notes.trim() || null, p_payment_method: paymentMethod,
    })
    setRequesting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setWaiting({
      id: bookingId as string, since: null,
      summary: { vehicleLabel: t(`vp.rentalTier.${openTier.tier_key}`), from: fromLoc.label, to: toLoc.label, amount: estimatedTotal, facts: tripFacts(tripType, tripType === 'return' ? waitHours : 0) },
      extra: { tripType, rentalTier: openTier.tier_key, fromLoc, toLoc },
    })
    setOpenTier(null)
    loadBookings()
  }

  // Real ask, 2026-11-03: the rider-facing half of the "no one-way
  // driver in 5 minutes" fallback — cancel the stuck one-way request
  // and resubmit the exact same trip as a return, since drivers
  // actually want those (no deadhead to eat).
  const switchToReturn = async (waitHoursChosen: number) => {
    if (!waiting?.extra) return
    const tier = tiers.find((x) => x.tier_key === waiting.extra!.rentalTier)
    if (!tier) return
    const { fromLoc: f, toLoc: tLoc } = waiting.extra
    await supabase.rpc('cancel_rental_booking', { p_booking_id: waiting.id })
    const { data: newId, error } = await supabase.rpc('create_rental_booking', {
      p_rental_tier: tier.tier_key, p_from_address: f.label, p_from_lat: f.lat, p_from_lng: f.lng,
      p_to_address: tLoc.label, p_to_lat: tLoc.lat, p_to_lng: tLoc.lng, p_trip_type: 'return', p_wait_hours: waitHoursChosen,
      p_payment_method: 'cash',
    })
    if (error) { toast.error(friendlyError(error)); return }
    const km = kmBetween(f, tLoc)
    setWaiting({
      id: newId as string, since: null,
      summary: { vehicleLabel: t(`vp.rentalTier.${tier.tier_key}`), from: f.label, to: tLoc.label, amount: tripTotalFor(tier, km, 'return', waitHoursChosen, isOutOfCityTrip(homeCity, f, tLoc)), facts: tripFacts('return', waitHoursChosen) },
      extra: { tripType: 'return', rentalTier: tier.tier_key, fromLoc: f, toLoc: tLoc },
    })
    toast.success(t('rw.switchedToReturnToast'))
    loadBookings()
  }
  const switchToShared = () => { setWaiting(null); router.push('/portal/marketplace/shared') }

  const cancelBooking = async (id: string) => {
    if (!confirm(t('vp.confirmCancelRental'))) return
    const { error } = await supabase.rpc('cancel_rental_booking', { p_booking_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    loadBookings()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const sortedTiers = [...tiers].sort((a, b) => TIER_ORDER.indexOf(a.tier_key) - TIER_ORDER.indexOf(b.tier_key))

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Navigation size={19} /> {t('vp.rentalPageTitle')}</h1>
        {/* Real ask, 2026-11-03: "how will the rider know which system
            to choose between Travel and Rental?" — a generic one-line
            subtitle read the same as Travel's own pitch. These three
            are the actual, concrete things only Rental offers. */}
        <ul className="text-[12px] text-[#64748b] mt-1 flex flex-col gap-0.5">
          <li>📍 {t('vp.rentalBenefitAnyAddress')}</li>
          <li>⏱️ {t('vp.rentalBenefitWait')}</li>
          <li>🚐 {t('vp.rentalBenefitBigVehicles')}</li>
        </ul>
      </div>

      <div className="flex items-center gap-1 bg-white border border-[#e5e2d0] rounded-full p-1 w-fit">
        <button onClick={() => setTab('browse')} className="px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'browse' ? '#166534' : 'transparent', color: tab === 'browse' ? '#fff' : '#64748b' }}>{t('vp.browseTab')}</button>
        <button onClick={() => setTab('mine')} className="relative px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'mine' ? '#166534' : 'transparent', color: tab === 'mine' ? '#fff' : '#64748b' }}>
          {t('vp.myBookingsTab')}
          {bookings.some((b) => ['requested', 'accepted', 'in_progress'].includes(b.status)) && <span className="absolute -top-0.5 -end-0.5 w-2 h-2 rounded-full bg-red-500" />}
        </button>
      </div>

      {tab === 'browse' ? (
        <>
          <div className="bg-[#005A36] rounded-2xl p-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-white/75">{t('vp.committeeRateHeading')}</p>
            <p className="text-[12.5px] text-white/90 mt-1 leading-[1.6]">{t('vp.rentalFormulaNote')}</p>
          </div>

          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
            <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.tripTypeLabel')}</label>
            <div className="flex items-center gap-2 mb-3">
              <button onClick={() => setTripType('one')} className="flex-1 py-2 rounded-xl text-[13px] font-semibold cursor-pointer border"
                style={{ background: tripType === 'one' ? '#166534' : '#fff', color: tripType === 'one' ? '#fff' : '#334155', borderColor: tripType === 'one' ? '#166534' : '#e5e2d0' }}>
                {t('vp.oneWayLabel')}
              </button>
              <button onClick={() => setTripType('return')} className="flex-1 py-2 rounded-xl text-[13px] font-semibold cursor-pointer border"
                style={{ background: tripType === 'return' ? '#166534' : '#fff', color: tripType === 'return' ? '#fff' : '#334155', borderColor: tripType === 'return' ? '#166534' : '#e5e2d0' }}>
                {t('vp.returnTripLabel')}
              </button>
            </div>

            {showPicker ? (
              <div className="mb-3">
                <LocationPickerSheet
                  title={showPicker === 'from' ? t('vp.rentalFromLabel') : t('vp.rentalToLabel')}
                  initial={showPicker === 'from' ? fromLoc : toLoc}
                  inline
                  onClose={() => setShowPicker(null)}
                  onConfirm={(loc) => { if (showPicker === 'from') setFromLoc(loc); else setToLoc(loc); setShowPicker(null) }}
                />
              </div>
            ) : (
              <>
                <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.rentalFromLabel')}</label>
                <button onClick={() => setShowPicker('from')} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-3">
                  <MapPin size={15} className="text-[#166534] shrink-0" />
                  <span className={`text-[13.5px] truncate ${fromLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{fromLoc ? fromLoc.label : t('vp.rentalFromPlaceholder')}</span>
                </button>

                <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.rentalToLabel')}</label>
                <button onClick={() => setShowPicker('to')} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-3">
                  <MapPin size={15} className="text-[#b91c1c] shrink-0" />
                  <span className={`text-[13.5px] truncate ${toLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{toLoc ? toLoc.label : t('vp.rentalToPlaceholder')}</span>
                </button>

                {haveRoute && (
                  <LeafletMap pins={[{ lat: fromLoc!.lat, lng: fromLoc!.lng, color: '#166534' }, { lat: toLoc!.lat, lng: toLoc!.lng, color: '#b91c1c' }]} height={130} className="rounded-xl mb-3" />
                )}
              </>
            )}

            {tripType === 'return' && (
              <>
                <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.waitHoursLabel')}</label>
                <div className="flex items-center gap-2">
                  <button onClick={() => setWaitHours((h) => Math.max(0, h - 1))} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">−</button>
                  <span className="font-extrabold text-[18px] w-10 text-center ltr-num">{waitHours}</span>
                  <button onClick={() => setWaitHours((h) => h + 1)} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">+</button>
                </div>
              </>
            )}
          </div>

          {!haveRoute ? (
            <p className="text-center py-6 text-[#94a3b8] text-[13.5px]">{t('vp.rentalPickRouteFirstHint')}</p>
          ) : sortedTiers.length === 0 ? (
            <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noRentalVehiclesHint')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {sortedTiers.map((tier) => {
                // 842: real ask — "only one number is ever charged,
                // the range is confusing." Tile now shows the exact
                // same committee figure the booking sheet below
                // itemises, not a spread.
                const hint = isUrdu ? tier.example_models_hint_ur : tier.example_models_hint
                return (
                <button key={tier.tier_key} onClick={() => openBooking(tier)}
                  className="flex flex-col items-start gap-1 bg-white border border-[#e5e2d0] rounded-2xl p-3 text-start cursor-pointer hover:border-[#166534]">
                  <span className="text-[22px]">{TIER_EMOJI[tier.tier_key] ?? '🚗'}</span>
                  <span className="text-[13px] font-bold text-[#1e293b]">{t(`vp.rentalTier.${tier.tier_key}`)}</span>
                  <span className="font-extrabold text-[15px] text-[#166534] ltr-num">{fmt(totalFor(tier))}</span>
                  {hint && <span className="text-[9.5px] text-[#94a3b8] leading-tight">{hint}</span>}
                  <span className="flex items-center gap-1 text-[10px] text-[#94a3b8] ltr-num"><Users size={10} /> {tier.vehicle_count} {t('mb.availableLabel')}</span>
                </button>
                )
              })}
            </div>
          )}
        </>
      ) : (
        bookings.length === 0 ? (
          <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noRentalBookingsHint')}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {bookings.map((b) => (
              <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-[#1e293b]">
                      {b.vehicle_type ? `${vehicleDisplayName(b.vehicle_type, b.model, isUrdu && b.category_name_ur ? b.category_name_ur : b.category_name)} — ${b.owner_name}` : t('vp.hourlySearchingLabel').replace('{tier}', t(`vp.rentalTier.${b.rental_tier}`))}
                    </p>
                    <p className="text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5 text-[#166534]" /> {b.from_address}</p>
                    <p className="text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5 text-[#b91c1c]" /> {b.to_address}</p>
                    <p className="text-[11.5px] text-[#64748b] mt-0.5 ltr-num">{fmt(b.km)}km · {b.trip_type === 'return' ? t('vp.returnTripLabel') : t('vp.oneWayLabel')} · {fmt(b.total_amount_pkr)}</p>
                    {b.notes && <p className="text-[11.5px] text-[#64748b] mt-0.5 italic">&ldquo;{b.notes}&rdquo;</p>}
                    {(b.status === 'accepted' || b.status === 'in_progress') && (
                      <span className="flex items-center gap-3 mt-1">
                        <CallButton phone={b.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-[#166534]" />
                        <ChatButton refType="rental_booking" refId={b.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer" />
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: `${STATUS_COLOR[b.status]}1a`, color: STATUS_COLOR[b.status] }}>{t(`vp.hourlyStatus.${b.status}`)}</span>
                </div>

                {b.status === 'accepted' && b.pin && (
                  <>
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                      <span className="text-[11.5px] text-[#64748b]">{t('vp.yourPinLabel')}</span>
                      <span className="font-extrabold text-[20px] tracking-[0.3em] text-[#005A36] ltr-num">{b.pin}</span>
                    </div>
                    <p className="text-[11px] text-[#64748b] mt-1">{t('vp.yourPinHint')}</p>
                  </>
                )}

                {b.from_lat != null && b.from_lng != null && b.to_lat != null && b.to_lng != null && (
                  <LeafletMap pins={[{ lat: b.from_lat, lng: b.from_lng, color: '#166534' }, { lat: b.to_lat, lng: b.to_lng, color: '#b91c1c' }]} height={140} className="rounded-xl mt-2" />
                )}
                {b.status === 'declined' && b.decline_reason && (
                  <p className="flex items-center gap-1.5 text-[12px] mt-2 pt-2 border-t border-[#f1f5f9]" style={{ color: '#b91c1c' }}><AlertCircle size={12} /> {b.decline_reason}</p>
                )}
                {b.status === 'in_progress' && (
                  <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin text-[#166534]" />
                    <p className="text-[12px] text-[#64748b]">{t('vp.tripInProgressHint')}</p>
                  </div>
                )}
                {b.status === 'completed' && (
                  <>
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[12px] text-[#64748b]"><CheckCircle2 size={12} className="text-emerald-600" /> {t('vp.hourlyStatus.completed')}</span>
                      <span className="font-extrabold text-[16px] text-[#005A36] ltr-num">{fmt(b.total_amount_pkr)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <ShareBookingButton
                        title={`${isUrdu ? site.nameUrdu : site.name} ${t('mb.portalSuffix')}`}
                        lines={[`${b.vehicle_type ? vehicleDisplayName(b.vehicle_type, b.model, isUrdu && b.category_name_ur ? b.category_name_ur : b.category_name) : ''} — ${b.owner_name ?? ''}`, `${b.from_address} → ${b.to_address}`, `${t('vp.totalLabel')}: ${fmt(b.total_amount_pkr)}`]}
                      />
                      <ReportProblemButton refType="rental_booking" refId={b.id} kindOptions={['fare_dispute', 'no_show']} />
                    </div>
                    {b.is_out_of_city && b.trip_type === 'one' && (
                      <button onClick={() => router.push('/portal/marketplace/travel?openGoHome=1')}
                        className="flex items-center gap-2 w-full mt-2 p-2.5 rounded-xl bg-[#FFFBEB] border border-[#D4AF37] text-start cursor-pointer">
                        <HomeIcon size={15} className="text-[#92400e] shrink-0" />
                        <span className="font-sans text-[12px] font-semibold text-[#92400e]">{t('vp.wantRideHomePrompt')}</span>
                      </button>
                    )}
                    {b.vehicle_id && (
                      <div className="mt-2">
                        <RateAndReport refType="rental_booking" refId={b.id} againstPartyType="vehicle" againstPartyId={b.vehicle_id} showComplaint={false} />
                      </div>
                    )}
                  </>
                )}
                {(b.status === 'requested' || b.status === 'accepted') && (
                  <button onClick={() => cancelBooking(b.id)} className="flex items-center gap-1.5 text-[11.5px] font-semibold mt-2 pt-2 border-t border-[#f1f5f9] cursor-pointer" style={{ color: '#b91c1c' }}>
                    <Ban size={12} /> {t('vp.cancelBookingBtn')}
                  </button>
                )}
                {(b.status === 'declined' || b.status === 'cancelled' || b.status === 'completed') && (
                  <button onClick={() => bookAgain(b.rental_tier)} className="flex items-center gap-1.5 text-[11.5px] font-semibold mt-2 pt-2 border-t border-[#f1f5f9] cursor-pointer text-[#166534]">
                    <RotateCcw size={12} /> {t('vp.bookAgainBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {openTier && (
        <MobilityBottomSheet title={t(`vp.rentalTier.${openTier.tier_key}`)} onClose={() => setOpenTier(null)}>
          <div className="bg-[#F9F9F6] rounded-xl p-2.5 mb-3 flex flex-col gap-1">
            <p className="text-[12.5px] text-[#1e293b] flex items-start gap-1.5"><MapPin size={12} className="shrink-0 mt-0.5 text-[#166534]" /> {fromLoc?.label}</p>
            <p className="text-[12.5px] text-[#1e293b] flex items-start gap-1.5"><MapPin size={12} className="shrink-0 mt-0.5 text-[#b91c1c]" /> {toLoc?.label}</p>
          </div>

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.preferredYearLabel')}</label>
          <select value={preferredYear ?? ''} onChange={(e) => setPreferredYear(e.target.value ? Number(e.target.value) : null)} className="dp2-input text-[13.5px] mb-3">
            <option value="">{t('vp.anyYearOption')}</option>
            {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.notesLabel')}</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t('vp.rentalNotesPlaceholder')}
            className="dp2-input text-[13px] resize-none leading-relaxed mb-3" />

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('mb.paymentMethodsHeading')}</label>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {PAYMENT_METHODS.map((p) => (
              <button key={p.key} onClick={() => setPaymentMethod(p.key)}
                className="px-2.5 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border"
                style={{ background: paymentMethod === p.key ? '#166534' : '#fff', color: paymentMethod === p.key ? '#fff' : '#334155', borderColor: paymentMethod === p.key ? '#166534' : '#e5e2d0' }}>
                {p.emoji} {t(p.labelKey)}
              </button>
            ))}
          </div>

          <div className="bg-[#F9F9F6] rounded-xl p-3 mb-3">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-[#64748b]">{t('vp.rentalBaseFareLabel')}</span>
              <span className="font-bold text-[#1e293b] ltr-num">{fmt(rateFor(openTier).base)}</span>
            </div>
            {isOutOfCity && <p className="text-[11px] text-[#166534] font-semibold mt-1">{t('vp.outstationRateAppliedHint')}</p>}
            {fromLoc && toLoc && (
              <div className="flex items-center justify-between text-[13px] mt-1">
                <span className="text-[#64748b]">{t('vp.rentalDistanceFareLabel')} ({fmt(km)}km)</span>
                <span className="font-bold text-[#1e293b] ltr-num">{fmt(estimatedTrip)}</span>
              </div>
            )}
            {tripType === 'return' && waitHours > 0 && (
              <div className="flex items-center justify-between text-[13px] mt-1">
                <span className="text-[#64748b]">{t('vp.rentalWaitFeeLabel')}</span>
                <span className="font-bold text-[#1e293b] ltr-num">{fmt(estimatedWait)}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-[14px] mt-1.5 pt-1.5 border-t border-[#e5e2d0]">
              <span className="font-bold text-[#1e293b]">{t('vp.totalLabel')}</span>
              <span className="font-extrabold text-[#005A36] ltr-num">{fmt(estimatedTotal)}</span>
            </div>
          </div>

          <div className="mb-3"><FarePolicyCard service="rental" /></div>

          <p className="flex items-start gap-1.5 text-[11px] text-[#64748b] mb-3"><AlertCircle size={12} className="shrink-0 mt-0.5 text-[#166534]" /> {t('vp.noAdvanceExplainer')}</p>

          <button onClick={submitRequest} disabled={requesting} className="w-full bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer disabled:opacity-50">
            {requesting ? t('action.saving') : t('vp.sendRequestBtn')}
          </button>
        </MobilityBottomSheet>
      )}

      {waiting && (
        <RequestWaitingSheet kind="rental" bookingId={waiting.id} summary={waiting.summary} since={waiting.since}
          onClose={() => { setWaiting(null); loadBookings() }}
          onViewBooking={() => { setWaiting(null); loadBookings(); setTab('mine') }}
          oneWayFallback={waiting.extra?.tripType === 'one' ? { afterSeconds: 300, onSwitchShared: switchToShared, onSwitchReturn: switchToReturn } : undefined} />
      )}
    </div>
  )
}
