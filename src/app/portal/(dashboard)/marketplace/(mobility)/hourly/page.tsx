'use client'

// Hourly rental — browse vehicles that opted in (offers_hourly, 474),
// book by the hour, and track the request through the full accept/
// decline/in-progress/completed lifecycle (475/477). Price is formulaic
// (rate × hours, locked in at request time) — nothing to negotiate, so
// this is a direct booking like ride_bookings, not a chat thread.
//
// The "My Bookings" tab doubles as the whole post-request experience:
// a still-pending request can be cancelled, a declined one shows why,
// an in-progress trip shows the live distance ticking up, and a
// completed one shows the final breakdown.
//
// Phase 4: re-skinned to the new design + moved under marketplace/
// (mobility)/ — the booking sheet now reuses MobilityBottomSheet.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Car, Snowflake, MapPin, Clock3, Loader2, AlertCircle, CheckCircle2, Ban, RotateCcw, Star, Navigation } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { friendlyError } from '@/lib/errors'
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
import { RequestWaitingSheet, type WaitingSummary } from '@/components/mobility/RequestWaitingSheet'
import { FarePolicyCard, TravelQuoteLine } from '@/components/mobility/FarePolicyCard'
import { HourlyMeter } from '@/components/mobility/HourlyMeter'
import type { TravelQuote } from '@/lib/farePolicy'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { CategoryVehiclePicker, type CategoryDef } from '@/components/mobility/CategoryVehiclePicker'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

// Real ask, 2026-11-03: "when i chose this feature its showing the
// list of all vehicles separately and not in the category shape...
// this will also have the same categories but it will add buses,
// coasters, hiace." Reuses the exact same rental_tier + CategoryVehiclePicker
// mechanism the Car Rental page (653/714) already has, extended to
// also carry the van/Hiace/Coaster/Bus tiers (786) — not a second,
// parallel category system.
const HOURLY_TIERS = [
  { key: 'small_ac', emoji: '🚗' }, { key: 'small_non_ac', emoji: '🚗' },
  { key: 'big_ac', emoji: '🚐' }, { key: 'big_non_ac', emoji: '🚐' },
  { key: 'suv', emoji: '🚙' }, { key: 'luxury', emoji: '🚘' },
  { key: 'van', emoji: '🚐' }, { key: 'hiace', emoji: '🚌' },
  { key: 'coaster', emoji: '🚍' }, { key: 'bus', emoji: '🚌' },
] as const

interface Vehicle {
  id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; color: string | null; model: string | null; has_ac: boolean
  hourly_rate_pkr: number; hourly_included_km: number | null; hourly_overage_per_km_pkr: number | null; cover_url: string | null
  category_name: string | null; category_name_ur: string | null; rental_tier: string | null; avg_rating: number | null
  shared_from_other_village: boolean; owner_village_name: string | null
}
interface Booking {
  id: string; hours: number; status: string; pickup_address: string; pickup_lat: number | null; pickup_lng: number | null; decline_reason: string | null
  destination_address: string | null; is_outstation: boolean
  base_amount_pkr: number; total_amount_pkr: number | null; distance_km: number
  requested_at: string; started_at: string | null; ended_at: string | null; pin: string | null
  notes: string | null; payment_method: string
  vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null; color: string | null
  category_name: string | null; category_name_ur: string | null
  hourly_rate_pkr?: number; included_km?: number; overage_per_km_pkr?: number; overtime_minutes?: number; overtime_amount_pkr?: number
}

const PAYMENT_METHODS: { key: string; emoji: string; labelKey: string }[] = [
  { key: 'cash', emoji: '💵', labelKey: 'mb.payCash' },
  { key: 'jazzcash', emoji: '📱', labelKey: 'mb.payJazzCash' },
  { key: 'easypaisa', emoji: '📲', labelKey: 'mb.payEasypaisa' },
]

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const STATUS_COLOR: Record<string, string> = {
  requested: '#92400e', accepted: '#166534', in_progress: '#166534', completed: '#334155', declined: '#b91c1c', cancelled: '#64748b',
}

export default function HourlyRentalPage() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [tab, setTab] = useState<'browse' | 'mine'>('browse')
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)

  const [openVehicle, setOpenVehicle] = useState<Vehicle | null>(null)
  const [hours, setHours] = useState(1)
  const [pickupLoc, setPickupLoc] = useState<PickedLocation | null>(null)
  const [showPicker, setShowPicker] = useState<'pickup' | 'destination' | false>(false)
  // Real ask, 2026-11-03: "check the request procedure... where he
  // wants to go, how many hours he wants to book... make him choose
  // the request a comfortable way." Purely informational — billing
  // stays live-GPS for the whole hired window exactly as before
  // (786's own header comment) — but the driver's request card can now
  // show the rider's real plan before deciding, instead of a bare
  // pickup point and an hour count.
  const [destinationLoc, setDestinationLoc] = useState<PickedLocation | null>(null)
  const [isOutstation, setIsOutstation] = useState(false)
  const [notes, setNotes] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [requesting, setRequesting] = useState(false)
  const [pickupQuote, setPickupQuote] = useState<TravelQuote | null>(null)
  const [waiting, setWaiting] = useState<{ id: string; summary: WaitingSummary; since: string | null } | null>(null)

  const loadVehicles = () => supabase.rpc('hourly_bookable_vehicles').then(({ data }) => setVehicles((data ?? []) as Vehicle[]))
  const loadBookings = () => supabase.rpc('my_hourly_bookings').then(({ data }) => { const rows = (data ?? []) as Booking[]; setBookings(rows); return rows })
  const hoursFact = (h: number) => t('rw.hours').replace('{n}', String(h))
  const waitingFor = (b: Booking) => ({
    id: b.id, since: b.requested_at,
    summary: { vehicleLabel: vehicleDisplayName(b.vehicle_type, b.model), driverName: b.owner_name, from: b.pickup_address, amount: b.total_amount_pkr ?? b.base_amount_pkr, facts: [hoursFact(b.hours)] },
  })

  useEffect(() => {
    if (!user) return
    Promise.all([loadVehicles(), loadBookings()]).then(([, rows]) => {
      setLoading(false)
      // A request still waiting on its driver reopens its waiting
      // popup — reloading the page shouldn't lose the "waiting" screen.
      const pending = rows.filter((b) => b.status === 'requested').sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0]
      if (pending) setWaiting(waitingFor(pending))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (tab !== 'mine' || !bookings.some((b) => b.status === 'in_progress')) return
    const id = setInterval(loadBookings, 10000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookings])

  const [livePos, setLivePos] = useState<Record<string, { lat: number; lng: number }>>({})
  useEffect(() => {
    const active = bookings.filter((b) => b.status === 'in_progress')
    if (tab !== 'mine' || active.length === 0) return
    const poll = () => {
      Promise.all(active.map((b) =>
        supabase.from('hourly_booking_locations').select('lat, lng').eq('booking_id', b.id).order('recorded_at', { ascending: false }).limit(1).maybeSingle()
          .then(({ data }) => [b.id, data] as const)))
        .then((pairs) => setLivePos((prev) => {
          const next = { ...prev }
          for (const [id, data] of pairs) if (data) next[id] = { lat: Number(data.lat), lng: Number(data.lng) }
          return next
        }))
    }
    poll()
    const id = setInterval(poll, 12000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookings])

  const openBooking = (v: Vehicle) => { setOpenVehicle(v); setHours(1); setPickupLoc(null); setDestinationLoc(null); setIsOutstation(false); setNotes(''); setPaymentMethod('cash') }

  const bookAgain = (vehicleId: string) => {
    setTab('browse')
    const v = vehicles.find((x) => x.id === vehicleId)
    if (v) openBooking(v)
  }

  const tierVehicleCard = (v: Vehicle) => {
    const Wrapper = v.shared_from_other_village ? 'div' : 'button'
    return (
      <Wrapper key={v.id} {...(v.shared_from_other_village ? {} : { onClick: () => openBooking(v) })}
        className={`flex flex-col gap-1.5 bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden text-start ${v.shared_from_other_village ? '' : 'cursor-pointer'}`}>
        <div className="w-full aspect-square bg-[#F9F9F6] shrink-0 flex items-center justify-center overflow-hidden">
          {v.cover_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.cover_url} alt="" className="w-full h-full object-cover" />
          ) : <Car size={26} className="text-[#94a3b8]" />}
        </div>
        <div className="px-2 pb-2">
          <p className="text-[12px] font-bold text-[#1e293b] truncate">{vehicleDisplayName(v.vehicle_type, v.model)}</p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {v.color && <span className="text-[9.5px] text-[#64748b]">{v.color}</span>}
            {v.has_ac && <span className="flex items-center gap-0.5 text-[8.5px] px-1 py-0.5 rounded-full bg-sky-50 text-sky-700"><Snowflake size={8} /> {t('mv.hasAcLabel')}</span>}
            {v.avg_rating != null && <span className="flex items-center gap-0.5 text-[8.5px] text-amber-700"><Star size={8} className="fill-amber-400 text-amber-400" /> {v.avg_rating}</span>}
          </div>
          <p className="font-extrabold text-[13px] text-[#166534] ltr-num mt-0.5">{fmt(v.hourly_rate_pkr)} <span className="font-sans text-[9px] font-bold text-[#64748b]">{t('mv.perHourLabel')}</span></p>
          {v.hourly_included_km != null && <p className="text-[9.5px] text-[#64748b] ltr-num">{fmt(v.hourly_included_km)}km {t('mv.includedShort')}</p>}
          {v.shared_from_other_village && (
            <div className="flex items-center justify-between gap-1 mt-1">
              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800">{t('vp.sharedFromVillageBadge').replace('{village}', v.owner_village_name ?? '')}</span>
              <CallButton phone={v.owner_mobile} className="inline-flex items-center gap-1 text-[8px] font-bold text-[#166534]" />
            </div>
          )}
        </div>
      </Wrapper>
    )
  }
  const classifiedHourlyTierKeys = new Set(HOURLY_TIERS.map((rt) => rt.key))
  const otherHourlyTierVehicles = vehicles.filter((v) => !v.rental_tier || !classifiedHourlyTierKeys.has(v.rental_tier as typeof HOURLY_TIERS[number]['key']))
  const hourlyTierCategoryDefs: CategoryDef[] = [
    ...HOURLY_TIERS.map((rt) => {
      const inTier = vehicles.filter((v) => v.rental_tier === rt.key)
      return {
        key: rt.key, emoji: rt.emoji, name: t(`vp.rentalTier.${rt.key}`), vehicleCount: inTier.length,
        fromPricePkr: inTier.length > 0 ? Math.min(...inTier.map((v) => v.hourly_rate_pkr)) : null,
        selectedCount: 0, children: inTier.map(tierVehicleCard),
      }
    }),
    ...(otherHourlyTierVehicles.length > 0 ? [{
      key: 'other', emoji: '🚗', name: t('vp.otherVehiclesCategory'), vehicleCount: otherHourlyTierVehicles.length,
      fromPricePkr: Math.min(...otherHourlyTierVehicles.map((v) => v.hourly_rate_pkr)), selectedCount: 0, children: otherHourlyTierVehicles.map(tierVehicleCard),
    }] : []),
  ]

  const submitRequest = async () => {
    if (!openVehicle) return
    if (!pickupLoc) { toast.error(t('vp.hourlyAddressRequired')); return }
    setRequesting(true)
    const { data: bookingId, error } = await supabase.rpc('create_hourly_booking', {
      p_vehicle_id: openVehicle.id, p_hours: hours, p_pickup_address: pickupLoc.label,
      p_pickup_lat: pickupLoc.lat, p_pickup_lng: pickupLoc.lng,
      p_notes: notes.trim() || null, p_payment_method: paymentMethod,
      p_destination_address: destinationLoc?.label || null, p_destination_lat: destinationLoc?.lat ?? null, p_destination_lng: destinationLoc?.lng ?? null,
      p_is_outstation: isOutstation,
    })
    setRequesting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setWaiting({
      id: bookingId as string, since: null,
      summary: { vehicleLabel: vehicleDisplayName(openVehicle.vehicle_type, openVehicle.model), driverName: openVehicle.owner_name, from: pickupLoc.label, amount: estimatedTotal, facts: [hoursFact(hours)] },
    })
    setOpenVehicle(null)
    loadBookings()
  }

  const cancelBooking = async (id: string) => {
    if (!confirm(t('vp.confirmCancelHourly'))) return
    const { error } = await supabase.rpc('cancel_hourly_booking', { p_booking_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    loadBookings()
  }

  const estimatedTotal = openVehicle ? openVehicle.hourly_rate_pkr * hours : 0
  const estimatedIncludedKm = openVehicle ? (openVehicle.hourly_included_km ?? 0) * hours : 0

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Clock3 size={19} /> {t('vp.hourlyPageTitle')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.hourlyPageSubtitle')}</p>
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
            <p className="text-[12.5px] text-white/90 mt-1 leading-[1.6]">{t('vp.hourlyFormulaNote')}</p>
            <p className="text-[11.5px] text-white/80 mt-1.5 leading-[1.6]">{t('vp.hourlyTwoWayNote')}</p>
          </div>
          {vehicles.length === 0 ? (
            <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noHourlyVehiclesHint')}</p>
          ) : (
            <CategoryVehiclePicker categories={hourlyTierCategoryDefs} availableLabel={t('mb.availableLabel')} fromLabel={t('mb.fromPriceLabel')} />
          )}
        </>
      ) : (
        bookings.length === 0 ? (
          <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noHourlyBookingsHint')}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {bookings.map((b) => (
              <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-[#1e293b]">{vehicleDisplayName(b.vehicle_type, b.model)} — {b.owner_name}</p>
                    <p className="text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {b.pickup_address}</p>
                    {b.destination_address && (
                      <p className="text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1">
                        <Navigation size={11} className="shrink-0 mt-0.5 text-[#b91c1c]" /> {b.destination_address}
                        {b.is_outstation && <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800">{t('vp.hourlyOutstationBadge')}</span>}
                      </p>
                    )}
                    <p className="text-[11.5px] text-[#64748b] mt-0.5 ltr-num">{b.hours} {t('vp.hoursShort')} · {fmt(b.base_amount_pkr)}{t('vp.baseAmountSuffix')}</p>
                    {b.notes && <p className="text-[11.5px] text-[#64748b] mt-0.5 italic">&ldquo;{b.notes}&rdquo;</p>}
                    {(b.status === 'accepted' || b.status === 'in_progress') && (
                      <span className="flex items-center gap-3 mt-1">
                        <CallButton phone={b.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-[#166534]" />
                        <ChatButton refType="hourly_booking" refId={b.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer" />
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: `${STATUS_COLOR[b.status]}1a`, color: STATUS_COLOR[b.status] }}>{t(`vp.hourlyStatus.${b.status}`)}</span>
                </div>

                {b.status === 'accepted' && b.pin && (
                  <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                    <span className="text-[11.5px] text-[#64748b]">{t('vp.yourPinLabel')}</span>
                    <span className="font-extrabold text-[20px] tracking-[0.3em] text-[#005A36] ltr-num">{b.pin}</span>
                  </div>
                )}
                {b.status === 'accepted' && b.pin && (
                  <p className="text-[11px] text-[#64748b] mt-1">{t('vp.yourPinHint')}</p>
                )}

                {b.pickup_lat != null && b.pickup_lng != null && b.status !== 'in_progress' && (
                  <LeafletMap pins={[{ lat: b.pickup_lat, lng: b.pickup_lng, color: '#166534' }]} height={120} className="rounded-xl mt-2" />
                )}
                {b.status === 'declined' && b.decline_reason && (
                  <p className="flex items-center gap-1.5 text-[12px] mt-2 pt-2 border-t border-[#f1f5f9]" style={{ color: '#b91c1c' }}><AlertCircle size={12} /> {b.decline_reason}</p>
                )}
                {b.status === 'in_progress' && (
                  <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                    <div className="flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin text-[#166534]" />
                      <p className="text-[12px] text-[#64748b]">{t('vp.tripInProgressHint')} <span className="font-bold text-[#166534] ltr-num">{fmt(b.distance_km)}km</span></p>
                    </div>
                    <div className="mt-2"><HourlyMeter row={b} /></div>
                    {livePos[b.id] && (
                      <LeafletMap pins={[{ lat: livePos[b.id].lat, lng: livePos[b.id].lng, label: b.owner_name, emoji: '🚐' }]} height={160} className="rounded-xl mt-2" />
                    )}
                  </div>
                )}
                {b.status === 'completed' && (
                  <>
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[12px] text-[#64748b]"><CheckCircle2 size={12} className="text-emerald-600" /> {fmt(b.distance_km)}km {t('vp.travelledLabel')}</span>
                      <span className="font-extrabold text-[16px] text-[#005A36] ltr-num">{fmt(b.total_amount_pkr ?? b.base_amount_pkr)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <ShareBookingButton
                        title={`${isUrdu ? site.nameUrdu : site.name} ${t('mb.portalSuffix')}`}
                        lines={[`${vehicleDisplayName(b.vehicle_type, b.model)} — ${b.owner_name}`, b.pickup_address, `${t('vp.totalLabel')}: ${fmt(b.total_amount_pkr ?? b.base_amount_pkr)}`]}
                      />
                      <ReportProblemButton refType="hourly_booking" refId={b.id} kindOptions={['hourly_overage', 'no_show']} />
                    </div>
                    <div className="mt-2">
                      <RateAndReport refType="hourly_booking" refId={b.id} againstPartyType="vehicle" againstPartyId={b.vehicle_id} showComplaint={false} />
                    </div>
                  </>
                )}
                {(b.status === 'requested' || b.status === 'accepted') && (
                  <button onClick={() => cancelBooking(b.id)} className="flex items-center gap-1.5 text-[11.5px] font-semibold mt-2 pt-2 border-t border-[#f1f5f9] cursor-pointer" style={{ color: '#b91c1c' }}>
                    <Ban size={12} /> {t('vp.cancelBookingBtn')}
                  </button>
                )}
                {(b.status === 'declined' || b.status === 'cancelled' || b.status === 'completed') && (
                  <button onClick={() => bookAgain(b.vehicle_id)} className="flex items-center gap-1.5 text-[11.5px] font-semibold mt-2 pt-2 border-t border-[#f1f5f9] cursor-pointer text-[#166534]">
                    <RotateCcw size={12} /> {t('vp.bookAgainBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {openVehicle && (
        <MobilityBottomSheet title={vehicleDisplayName(openVehicle.vehicle_type, openVehicle.model)} onClose={() => setOpenVehicle(null)}>
          <p className="text-[12px] text-[#64748b] -mt-2 mb-3">{openVehicle.color}{openVehicle.has_ac ? ` · ${t('mv.hasAcLabel')}` : ''}</p>

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.hoursLabel')}</label>
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => setHours((h) => Math.max(1, h - 1))} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">−</button>
            <span className="font-extrabold text-[18px] w-10 text-center ltr-num">{hours}</span>
            <button onClick={() => setHours((h) => h + 1)} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">+</button>
          </div>

          {showPicker ? (
            <div className="mb-3">
              <LocationPickerSheet
                title={showPicker === 'pickup' ? t('vp.pickupAddressLabel') : t('vp.hourlyDestinationLabel')}
                initial={showPicker === 'pickup' ? pickupLoc : destinationLoc}
                inline
                onClose={() => setShowPicker(false)}
                onConfirm={(loc) => { if (showPicker === 'pickup') setPickupLoc(loc); else setDestinationLoc(loc); setShowPicker(false) }}
              />
            </div>
          ) : (
            <>
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.pickupAddressLabel')}</label>
              {pickupLoc && <LeafletMap pins={[{ lat: pickupLoc.lat, lng: pickupLoc.lng, color: '#166534' }]} height={140} className="rounded-xl mb-2" />}
              <button onClick={() => setShowPicker('pickup')} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-3">
                <MapPin size={15} className="text-[#166534] shrink-0" />
                <span className={`text-[13.5px] truncate ${pickupLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{pickupLoc ? pickupLoc.label : t('vp.pickupAddressPlaceholder')}</span>
              </button>

              {/* Real ask, 2026-11-03: "where he wants to go... make
                  him choose the request a comfortable way" — optional
                  (billing stays GPS-based regardless), but tells the
                  driver the rider's real plan before they decide. */}
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.hourlyDestinationLabel')} <span className="font-normal text-[#94a3b8]">({t('action.optional')})</span></label>
              <button onClick={() => setShowPicker('destination')} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-2">
                <Navigation size={15} className="text-[#b91c1c] shrink-0" />
                <span className={`text-[13.5px] truncate ${destinationLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{destinationLoc ? destinationLoc.label : t('vp.hourlyDestinationPlaceholder')}</span>
              </button>
              {destinationLoc && (
                <label className="flex items-center gap-2 mb-3 cursor-pointer">
                  <input type="checkbox" checked={isOutstation} onChange={(e) => setIsOutstation(e.target.checked)} className="accent-[#166534]" />
                  <span className="font-sans text-[12.5px] text-[#1e293b]">{t('vp.hourlyIsOutstationLabel')}</span>
                </label>
              )}
            </>
          )}

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.notesLabel')}</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t('vp.hourlyNotesPlaceholder')}
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
              <span className="text-[#64748b]">{fmt(openVehicle.hourly_rate_pkr)} × {hours}{t('vp.hoursShort')}</span>
              <span className="font-bold text-[#1e293b] ltr-num">{fmt(estimatedTotal)}</span>
            </div>
            <p className="text-[11px] text-[#64748b] mt-1">
              {t('vp.includedThenOverage').replace('{km}', fmt(estimatedIncludedKm)).replace('{rate}', fmt(openVehicle.hourly_overage_per_km_pkr ?? 0))}
            </p>
            <p className="text-[10.5px] text-[#64748b] mt-1 leading-[1.6]">{t('vp.hourlyTwoWayNote')}</p>
          </div>

          <div className="flex flex-col gap-2 mb-3">
            <TravelQuoteLine service="hourly" vehicleId={openVehicle.id} lat={pickupLoc?.lat} lng={pickupLoc?.lng} onQuote={setPickupQuote} />
            <FarePolicyCard service="hourly" vehicle={{ hourlyRate: openVehicle.hourly_rate_pkr, includedKmPerHour: openVehicle.hourly_included_km, overagePerKm: openVehicle.hourly_overage_per_km_pkr }} />
          </div>

          <p className="flex items-start gap-1.5 text-[11px] text-[#64748b] mb-3"><AlertCircle size={12} className="shrink-0 mt-0.5 text-[#166534]" /> {t('vp.noAdvanceExplainer')}</p>

          <button onClick={submitRequest} disabled={requesting || (!!pickupLoc && !!pickupQuote?.too_far)} className="w-full bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer disabled:opacity-50">
            {requesting ? t('action.saving') : t('vp.sendRequestBtn')}
          </button>
        </MobilityBottomSheet>
      )}

      {waiting && (
        <RequestWaitingSheet kind="hourly" bookingId={waiting.id} summary={waiting.summary} since={waiting.since}
          onClose={() => { setWaiting(null); loadBookings() }}
          onViewBooking={() => { setWaiting(null); loadBookings(); setTab('mine') }} />
      )}
    </div>
  )
}
