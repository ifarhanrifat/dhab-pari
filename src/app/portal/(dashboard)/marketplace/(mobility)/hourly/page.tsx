'use client'

// Hourly rental — broadcast to every active vehicle in a category,
// book by the hour, track the request through the full accept/
// in-progress/completed lifecycle (475/477). Price is formulaic (the
// category's own fare-guide rate × hours, locked in at request time)
// — nothing to negotiate, so this is a direct booking, not a chat
// thread.
//
// Real ask, 2026-11-03: "when i chose a vehicle category then there
// will be dozens or maybe hundreds of vehicles on that catalog, how
// will the rider choose between them? ... the purpose of these online
// taxi systems is to send the calls to all drivers who are nearby so
// everyone gets a chance for their jobs ... we can't allow the rider
// to pick up a separate vehicle from the catalog, it will be
// unjustifying — only shadi vehicles work this way." This page no
// longer lets a rider browse and pick one specific vehicle at all —
// picking a category tile + an optional preferred model year goes
// straight to the booking form, and the request (787) broadcasts to
// every matching vehicle; whoever accepts first gets the job.
//
// The "My Bookings" tab doubles as the whole post-request experience:
// a still-open (unassigned) request can be cancelled, an in-progress
// trip shows the live distance ticking up, and a completed one shows
// the final breakdown.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { MapPin, Clock3, Loader2, AlertCircle, CheckCircle2, Ban, RotateCcw, Navigation, Users } from 'lucide-react'
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

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

const TIER_EMOJI: Record<string, string> = {
  small_ac: '🚗', small_non_ac: '🚗', big_ac: '🚘', big_non_ac: '🚖', suv: '🚙', luxury: '🏎️',
  van: '🚐', hiace: '🚌', coaster: '🚍', bus: '🚌',
}
const TIER_ORDER = ['small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus']
const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 26 }, (_, i) => CURRENT_YEAR - i)

interface TierOption {
  tier_key: string; vehicle_count: number
  hourly_rate_pkr: number; hourly_included_km_per_hour: number; hourly_overage_per_km_pkr: number
  out_of_city_per_km_pkr: number | null; out_of_city_hourly_rate_pkr: number | null
}
interface Booking {
  id: string; hours: number; status: string; pickup_address: string; pickup_lat: number | null; pickup_lng: number | null; decline_reason: string | null
  destination_address: string | null; is_outstation: boolean; vehicle_id: string | null; rental_tier: string | null
  base_amount_pkr: number; total_amount_pkr: number | null; distance_km: number
  requested_at: string; started_at: string | null; ended_at: string | null; pin: string | null
  notes: string | null; payment_method: string
  owner_name: string | null; owner_mobile: string | null; vehicle_type: string | null; model: string | null; color: string | null
  category_name: string | null; category_name_ur: string | null
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
  const [tiers, setTiers] = useState<TierOption[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)

  const [openTier, setOpenTier] = useState<TierOption | null>(null)
  const [hours, setHours] = useState(2)
  const [preferredYear, setPreferredYear] = useState<number | null>(null)
  const [pickupLoc, setPickupLoc] = useState<PickedLocation | null>(null)
  const [showPicker, setShowPicker] = useState<'pickup' | 'destination' | false>(false)
  const [destinationLoc, setDestinationLoc] = useState<PickedLocation | null>(null)
  const [isOutstation, setIsOutstation] = useState(false)
  const [notes, setNotes] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [requesting, setRequesting] = useState(false)
  const [pickupQuote, setPickupQuote] = useState<TravelQuote | null>(null)
  const [waiting, setWaiting] = useState<{ id: string; summary: WaitingSummary; since: string | null } | null>(null)

  const loadTiers = () => supabase.rpc('hourly_tier_options').then(({ data }) => setTiers((data ?? []) as TierOption[]))
  const loadBookings = () => supabase.rpc('my_hourly_bookings').then(({ data }) => { const rows = (data ?? []) as Booking[]; setBookings(rows); return rows })
  const hoursFact = (h: number) => t('rw.hours').replace('{n}', String(h))
  const waitingFor = (b: Booking) => ({
    id: b.id, since: b.requested_at,
    summary: {
      vehicleLabel: b.vehicle_type ? vehicleDisplayName(b.vehicle_type, b.model) : t(`vp.rentalTier.${b.rental_tier}`),
      driverName: b.owner_name, from: b.pickup_address, amount: b.total_amount_pkr ?? b.base_amount_pkr, facts: [hoursFact(b.hours)],
    },
  })

  useEffect(() => {
    if (!user) return
    Promise.all([loadTiers(), loadBookings()]).then(([, rows]) => {
      setLoading(false)
      const pending = rows.filter((b) => b.status === 'requested').sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0]
      if (pending) setWaiting(waitingFor(pending))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (tab !== 'mine' || !bookings.some((b) => b.status === 'in_progress' || b.status === 'requested')) return
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

  const openBooking = (tier: TierOption) => {
    setOpenTier(tier); setHours(2); setPreferredYear(null); setPickupLoc(null); setDestinationLoc(null); setIsOutstation(false); setNotes(''); setPaymentMethod('cash')
  }

  const bookAgain = (tierKey: string | null) => {
    setTab('browse')
    const tier = tiers.find((x) => x.tier_key === tierKey)
    if (tier) openBooking(tier)
  }

  const submitRequest = async () => {
    if (!openTier) return
    if (!pickupLoc) { toast.error(t('vp.hourlyAddressRequired')); return }
    setRequesting(true)
    const { data: bookingId, error } = await supabase.rpc('create_hourly_booking', {
      p_rental_tier: openTier.tier_key, p_hours: hours, p_pickup_address: pickupLoc.label,
      p_pickup_lat: pickupLoc.lat, p_pickup_lng: pickupLoc.lng, p_preferred_year: preferredYear,
      p_notes: notes.trim() || null, p_payment_method: paymentMethod,
      p_destination_address: destinationLoc?.label || null, p_destination_lat: destinationLoc?.lat ?? null, p_destination_lng: destinationLoc?.lng ?? null,
      p_is_outstation: isOutstation,
    })
    setRequesting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setWaiting({
      id: bookingId as string, since: null,
      summary: { vehicleLabel: t(`vp.rentalTier.${openTier.tier_key}`), from: pickupLoc.label, amount: estimatedTotal, facts: [hoursFact(hours)] },
    })
    setOpenTier(null)
    loadBookings()
  }

  const cancelBooking = async (id: string) => {
    if (!confirm(t('vp.confirmCancelHourly'))) return
    const { error } = await supabase.rpc('cancel_hourly_booking', { p_booking_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    loadBookings()
  }

  // Real fix, 2026-11-05: "why is this vehicle showing Rs 300/hr fare?"
  // — 804 only scaled the overage-per-km rate for an outstation trip;
  // create_hourly_booking (807) now also scales the flat per-hour rate
  // itself by the same ratio Rental's own base fee jumps for this tier,
  // so the estimate shown before booking must match what the server
  // will actually charge, not the in-city number.
  const effectiveHourlyRate = openTier
    ? (isOutstation && openTier.out_of_city_hourly_rate_pkr != null ? openTier.out_of_city_hourly_rate_pkr : openTier.hourly_rate_pkr)
    : 0
  const estimatedTotal = effectiveHourlyRate * hours
  const estimatedIncludedKm = openTier ? openTier.hourly_included_km_per_hour * hours : 0
  const effectiveOveragePerKm = openTier
    ? (isOutstation && openTier.out_of_city_per_km_pkr != null ? openTier.out_of_city_per_km_pkr : openTier.hourly_overage_per_km_pkr)
    : 0

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const sortedTiers = [...tiers].sort((a, b) => TIER_ORDER.indexOf(a.tier_key) - TIER_ORDER.indexOf(b.tier_key))

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
          {sortedTiers.length === 0 ? (
            <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noHourlyVehiclesHint')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {sortedTiers.map((tier) => (
                <button key={tier.tier_key} onClick={() => openBooking(tier)}
                  className="flex flex-col items-start gap-1 bg-white border border-[#e5e2d0] rounded-2xl p-3 text-start cursor-pointer hover:border-[#166534]">
                  <span className="text-[22px]">{TIER_EMOJI[tier.tier_key] ?? '🚗'}</span>
                  <span className="text-[13px] font-bold text-[#1e293b]">{t(`vp.rentalTier.${tier.tier_key}`)}</span>
                  <span className="font-extrabold text-[15px] text-[#166534] ltr-num">{fmt(tier.hourly_rate_pkr)} <span className="font-sans text-[9.5px] font-bold text-[#64748b]">{t('mv.perHourLabel')}</span></span>
                  <span className="flex items-center gap-1 text-[10px] text-[#94a3b8] ltr-num"><Users size={10} /> {tier.vehicle_count} {t('mb.availableLabel')}</span>
                </button>
              ))}
            </div>
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
                    {/* Real ask: a still-open broadcast request has no
                        assigned vehicle yet — show "waiting for a
                        driver" instead of a blank/broken vehicle name. */}
                    <p className="text-[14px] font-bold text-[#1e293b]">
                      {b.vehicle_type ? `${vehicleDisplayName(b.vehicle_type, b.model)} — ${b.owner_name}` : t('vp.hourlySearchingLabel').replace('{tier}', t(`vp.rentalTier.${b.rental_tier}`))}
                    </p>
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
                      <LeafletMap pins={[{ lat: livePos[b.id].lat, lng: livePos[b.id].lng, label: b.owner_name ?? '', emoji: '🚐' }]} height={160} className="rounded-xl mt-2" />
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
                        lines={[`${b.vehicle_type ? vehicleDisplayName(b.vehicle_type, b.model) : ''} — ${b.owner_name ?? ''}`, b.pickup_address, `${t('vp.totalLabel')}: ${fmt(b.total_amount_pkr ?? b.base_amount_pkr)}`]}
                      />
                      <ReportProblemButton refType="hourly_booking" refId={b.id} kindOptions={['hourly_overage', 'no_show']} />
                    </div>
                    {b.vehicle_id && (
                      <div className="mt-2">
                        <RateAndReport refType="hourly_booking" refId={b.id} againstPartyType="vehicle" againstPartyId={b.vehicle_id} showComplaint={false} />
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
          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.hoursLabel')}</label>
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => setHours((h) => Math.max(2, h - 1))} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">−</button>
            <span className="font-extrabold text-[18px] w-10 text-center ltr-num">{hours}</span>
            <button onClick={() => setHours((h) => h + 1)} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">+</button>
          </div>

          {/* Real ask, 2026-11-03: "there is no model year picker for
              the rider... we can choose a model year what the user
              wants to book and all the models of those vehicles will
              get the call." Optional — "any year" broadcasts to the
              whole category; a specific year narrows the broadcast to
              vehicles of that year if any exist, else falls back to
              the whole category automatically (787). */}
          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.preferredYearLabel')}</label>
          <select value={preferredYear ?? ''} onChange={(e) => setPreferredYear(e.target.value ? Number(e.target.value) : null)} className="dp2-input text-[13.5px] mb-3">
            <option value="">{t('vp.anyYearOption')}</option>
            {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>

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

              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.hourlyDestinationLabel')} <span className="font-normal text-[#94a3b8]">({t('action.optional')})</span></label>
              <button onClick={() => setShowPicker('destination')} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-2">
                <Navigation size={15} className="text-[#b91c1c] shrink-0" />
                <span className={`text-[13.5px] truncate ${destinationLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{destinationLoc ? destinationLoc.label : t('vp.hourlyDestinationPlaceholder')}</span>
              </button>
              {/* Real bug found 2026-11-05: this used to only render
                  once a destination was pinned, so a rider who wants an
                  outstation trip without knowing the exact destination
                  address had no way to flag it at all. Flipped: once a
                  destination IS pinned, the server measures both ends
                  for real (808) and this checkbox would be ignored, so
                  it only needs to show when there's no destination to
                  measure against — exactly the one case it matters. */}
              {!destinationLoc && (
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
              <span className="text-[#64748b]">{fmt(effectiveHourlyRate)} × {hours}{t('vp.hoursShort')}</span>
              <span className="font-bold text-[#1e293b] ltr-num">{fmt(estimatedTotal)}</span>
            </div>
            <p className="text-[11px] text-[#64748b] mt-1">
              {t('vp.includedThenOverage').replace('{km}', fmt(estimatedIncludedKm)).replace('{rate}', fmt(effectiveOveragePerKm))}
            </p>
            {isOutstation && <p className="text-[10.5px] font-semibold text-[#92400e] mt-1">{t('vp.hourlyOutstationRateNote')}</p>}
            <p className="text-[10.5px] text-[#64748b] mt-1 leading-[1.6]">{t('vp.hourlyTwoWayNote')}</p>
          </div>

          <div className="flex flex-col gap-2 mb-3">
            <TravelQuoteLine service="hourly" vehicleId={null} lat={pickupLoc?.lat} lng={pickupLoc?.lng} onQuote={setPickupQuote} hideWhenRateIsZero />
            <FarePolicyCard service="hourly" vehicle={{ hourlyRate: effectiveHourlyRate, includedKmPerHour: openTier.hourly_included_km_per_hour, overagePerKm: effectiveOveragePerKm }} />
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
