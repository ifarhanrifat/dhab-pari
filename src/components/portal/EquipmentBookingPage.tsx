'use client'

// Shared rider UI for the 3 verticals imported from the new "Dhab Pari
// Mobility" design (machinery/tractor/loader) — one component, 3 thin
// page.tsx wrappers (marketplace/machinery, /tractor, /loader), since
// all three share the exact same backend shape (equipment_bookings,
// 646) and almost the same UI, differing only in what's picked before
// requesting: hours (machinery/tractor), an implement (tractor only),
// or a material (loader only, no hours at all).
//
// Modeled directly on marketplace/hourly/page.tsx's browse/mine tabs —
// no negotiation (price is formulaic, same reasoning as hourly), no GPS
// map (these are stationary/on-site jobs, not a moving trip).
//
// Phase 4: re-skinned to the new design's own palette/shapes (the
// mobility/* components' literal hex values, not --color-dp-* tokens),
// and moved under the marketplace/(mobility)/ route group — its shared
// layout already supplies the header/bottom-nav, so no back-link or
// MarketplaceBottomNav here any more. The booking sheet now reuses
// MobilityBottomSheet instead of its own inline modal markup.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Wrench, Tractor, Truck, MapPin, Loader2, AlertCircle, CheckCircle2, Ban, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { ShareBookingButton } from '@/components/portal/ShareBookingButton'
import { CallButton } from '@/components/portal/CallButton'
import { ChatButton } from '@/components/portal/ChatButton'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'
import { fetchRoadRoute, type RoadRoute } from '@/lib/roadRoute'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

type Kind = 'machinery' | 'tractor' | 'loader'
const KINDS: Kind[] = ['machinery', 'tractor', 'loader']

interface TractorService { service_key: string; name_en: string; name_ur: string; rate_pkr: number; unit: string }
interface Vehicle {
  id: string; kind: Kind; owner_name: string; owner_mobile: string | null; vehicle_type: string; color: string | null; model: string | null
  machinery_hourly_rate_pkr: number | null; machinery_hourly_rate_min_pkr: number | null; machinery_min_hours: number | null; machinery_mobilization_fee_pkr: number | null
  loader_trip_rate_pkr: number | null; tractor_services: TractorService[] | null; cover_url: string | null; avg_rating: number | null
  shared_from_other_village: boolean; owner_village_name: string | null
}
// A vehicle's real per-unit rate, by its own kind — used for the hero's
// "from" stat, each card's price line, and the rate-card table, so all
// three read off one definition instead of three ad-hoc branches.
function rateOf(v: Vehicle): number | null {
  if (v.kind === 'machinery') return v.machinery_hourly_rate_pkr
  if (v.kind === 'loader') return v.loader_trip_rate_pkr
  return v.tractor_services?.[0]?.rate_pkr ?? null
}
interface RateOffer { id: string; proposed_rate_pkr: number; counter_rate_pkr: number | null; status: string }
interface Booking {
  id: string; kind: Kind; service_key: string | null; site_address: string; site_lat: number | null; site_lng: number | null; material: string | null
  requested_hours: number | null; status: string; rate_pkr: number; mobilization_fee_pkr: number
  actual_hours: number | null; total_amount_pkr: number | null
  requested_at: string; started_at: string | null; ended_at: string | null; pin: string | null
  notes: string | null; payment_method: string
  pickup_address: string | null; pickup_lat: number | null; pickup_lng: number | null; trip_count: number
  scheduled_date: string | null; scheduled_time: string | null
  vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null; color: string | null
}

const PAYMENT_METHODS: { key: string; emoji: string; labelKey: string }[] = [
  { key: 'cash', emoji: '💵', labelKey: 'mb.payCash' },
  { key: 'jazzcash', emoji: '📱', labelKey: 'mb.payJazzCash' },
  { key: 'easypaisa', emoji: '📲', labelKey: 'mb.payEasypaisa' },
]

const MATERIALS = ['bricks', 'sand', 'bajri', 'soil', 'crop', 'other']

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const STATUS_COLOR: Record<string, string> = {
  requested: '#92400e', accepted: '#166534', in_progress: '#166534', completed: '#334155', declined: '#b91c1c', cancelled: '#64748b',
}

const KIND_ICON: Record<Kind, typeof Wrench> = { machinery: Wrench, tractor: Tractor, loader: Truck }
// Same per-kind tint the home page's category belt already uses (tractor/machine/loading) —
// reused here so a card's icon zone reads as a real colored panel instead of blending into
// the page background, matching the reference design's per-item tinted image zone.
const KIND_TINT: Record<Kind, string> = { machinery: '#fde68a', tractor: '#d1fae5', loader: '#ffedd5' }

export function EquipmentBookingPage({ kind: defaultKind }: { kind: Kind }) {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [tab, setTab] = useState<'browse' | 'mine'>('browse')
  // Real ask, 2026-10-26: the reference design's machinery screen is one
  // unified catalog (construction/lifting/water/farm) filtered by category
  // chips, plus a flat rate-card table underneath — this page used to be 3
  // separate single-kind screens with neither. Our 3 real kinds (machinery/
  // tractor/loader) are the honest equivalent of that category taxonomy
  // (no fabricated cons/lift/water/farm split exists in the real data), so
  // all 3 are fetched together here and `cat` filters client-side; each of
  // the 3 thin page.tsx wrappers just picks which category starts selected.
  const [cat, setCat] = useState<'all' | Kind>(defaultKind)
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)

  const [openVehicle, setOpenVehicle] = useState<Vehicle | null>(null)
  const [hours, setHours] = useState(1)
  const [serviceKey, setServiceKey] = useState('')
  const [material, setMaterial] = useState('bricks')
  const [tripCount, setTripCount] = useState(1)
  const [pickupLoc, setPickupLoc] = useState<PickedLocation | null>(null)
  const [showPickupPicker, setShowPickupPicker] = useState(false)
  const [siteLoc, setSiteLoc] = useState<PickedLocation | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [pickupDropRoute, setPickupDropRoute] = useState<RoadRoute | null>(null)
  const [notes, setNotes] = useState('')
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [requesting, setRequesting] = useState(false)
  const [rateOffer, setRateOffer] = useState<RateOffer | null>(null)
  const [proposeRate, setProposeRate] = useState('')
  const [proposing, setProposing] = useState(false)

  const loadVehicles = () => Promise.all(KINDS.map((k) =>
    supabase.rpc('equipment_bookable_vehicles', { p_kind: k }).then(({ data }) => ((data ?? []) as Omit<Vehicle, 'kind'>[]).map((v) => ({ ...v, kind: k })))
  )).then((lists) => setVehicles(lists.flat()))
  const loadBookings = () => supabase.rpc('my_equipment_bookings').then(({ data }) => setBookings((data ?? []) as Booking[]))

  useEffect(() => {
    if (!user) return
    setLoading(true)
    Promise.all([loadVehicles(), loadBookings()]).then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (tab !== 'mine' || !bookings.some((b) => b.status === 'in_progress')) return
    const id = setInterval(loadBookings, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookings])

  // Real ask, 2026-10-27: "why this system is using two maps lol, it
  // should display start and destination on one map along with route"
  // — the loader's pickup + drop pickers each showed their own small
  // map with just one pin. One shared map with both pins + the real
  // road route between them instead, same reasoning as the city-
  // purchase rebuild earlier this session.
  useEffect(() => {
    if (!pickupLoc || !siteLoc) { setPickupDropRoute(null); return }
    let cancelled = false
    fetchRoadRoute({ lat: pickupLoc.lat, lng: pickupLoc.lng }, { lat: siteLoc.lat, lng: siteLoc.lng }).then((r) => { if (!cancelled) setPickupDropRoute(r) })
    return () => { cancelled = true }
  }, [pickupLoc?.lat, pickupLoc?.lng, siteLoc?.lat, siteLoc?.lng])

  const openBooking = (v: Vehicle) => {
    setOpenVehicle(v)
    setHours(v.machinery_min_hours ?? 1)
    setServiceKey(v.tractor_services?.[0]?.service_key ?? '')
    setMaterial('bricks')
    setTripCount(1)
    setScheduledDate(new Date().toISOString().slice(0, 10))
    setScheduledTime('08:00')
    setPickupLoc(null)
    setSiteLoc(null)
    setNotes('')
    setPaymentMethod('cash')
    setRateOffer(null)
    setProposeRate('')
    if (v.kind === 'machinery') {
      supabase.rpc('my_proposed_machinery_rate', { p_vehicle_id: v.id }).then(({ data }) => setRateOffer((data as RateOffer | null) ?? null))
    }
  }

  const hasNegotiableBand = openVehicle?.kind === 'machinery' && openVehicle.machinery_hourly_rate_min_pkr != null && openVehicle.machinery_hourly_rate_pkr != null && openVehicle.machinery_hourly_rate_min_pkr < openVehicle.machinery_hourly_rate_pkr

  const sendProposal = async () => {
    if (!openVehicle) return
    const rate = Number(proposeRate)
    if (!rate || rate <= 0) { toast.error(t('vp.siteAddressRequired')); return }
    setProposing(true)
    const { error } = await supabase.rpc('propose_machinery_rate', { p_vehicle_id: openVehicle.id, p_proposed_rate_pkr: rate })
    setProposing(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.equipmentRequestSentToast'))
    supabase.rpc('my_proposed_machinery_rate', { p_vehicle_id: openVehicle.id }).then(({ data }) => setRateOffer((data as RateOffer | null) ?? null))
  }

  const acceptCounter = async () => {
    if (!rateOffer) return
    setProposing(true)
    const { error } = await supabase.rpc('accept_machinery_rate_counter', { p_offer_id: rateOffer.id })
    setProposing(false)
    if (error) { toast.error(friendlyError(error)); return }
    setRateOffer({ ...rateOffer, status: 'accepted' })
  }

  const bookAgain = (vehicleId: string) => {
    setTab('browse')
    const v = vehicles.find((x) => x.id === vehicleId)
    if (v) openBooking(v)
  }

  const selectedService = openVehicle?.tractor_services?.find((s) => s.service_key === serviceKey) ?? null
  const acceptedRate = rateOffer?.status === 'accepted' ? (rateOffer.counter_rate_pkr ?? rateOffer.proposed_rate_pkr) : null
  const openKind = openVehicle?.kind
  const unitRate = openKind === 'tractor' ? (selectedService?.rate_pkr ?? 0) : (openKind === 'machinery' ? (acceptedRate ?? openVehicle?.machinery_hourly_rate_pkr ?? 0) : (openVehicle?.loader_trip_rate_pkr ?? 0))
  const mobilization = openKind === 'machinery' ? (openVehicle?.machinery_mobilization_fee_pkr ?? 0) : 0
  const estimatedTotal = openKind === 'loader' ? unitRate * tripCount : unitRate * hours + mobilization

  const submitRequest = async () => {
    if (!openVehicle) return
    if (!siteLoc) { toast.error(t('vp.siteAddressRequired')); return }
    if (openVehicle.kind === 'loader' && !pickupLoc) { toast.error(t('vp.goodsPickupAddressRequired')); return }
    if (!scheduledDate) { toast.error(t('vp.scheduledDateRequired')); return }
    setRequesting(true)
    const { error } = await supabase.rpc('create_equipment_booking', {
      p_vehicle_id: openVehicle.id, p_kind: openVehicle.kind,
      p_service_key: openVehicle.kind === 'tractor' ? serviceKey : null,
      p_hours: openVehicle.kind === 'loader' ? null : hours,
      p_site_address: siteLoc.label,
      p_material: openVehicle.kind === 'loader' ? material : null,
      p_site_lat: siteLoc.lat, p_site_lng: siteLoc.lng,
      p_notes: notes.trim() || null, p_payment_method: paymentMethod,
      p_accepted_offer_id: acceptedRate != null ? rateOffer!.id : null,
      p_pickup_address: openVehicle.kind === 'loader' ? pickupLoc!.label : null,
      p_pickup_lat: openVehicle.kind === 'loader' ? pickupLoc!.lat : null,
      p_pickup_lng: openVehicle.kind === 'loader' ? pickupLoc!.lng : null,
      p_trip_count: openVehicle.kind === 'loader' ? tripCount : 1,
      p_scheduled_date: scheduledDate, p_scheduled_time: scheduledTime || null,
    })
    setRequesting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.equipmentRequestSentToast'))
    setOpenVehicle(null)
    loadBookings()
    setTab('mine')
  }

  const cancelBooking = async (id: string) => {
    if (!confirm(t('vp.confirmCancelEquipment'))) return
    const { error } = await supabase.rpc('cancel_equipment_booking', { p_booking_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    loadBookings()
  }

  const kindTitle = (k: Kind) => t(`vp.${k}PageTitle`)
  const pageTitle = cat === 'all' ? t('mv.tab.equipment') : kindTitle(cat)
  const pageSubtitle = cat === 'all' ? t('vp.equipAllPageSubtitle') : t(`vp.${cat}PageSubtitle`)
  const noVehiclesHint = cat === 'all' ? t('vp.noMachineryVehiclesHint') : t(`vp.no${cat.charAt(0).toUpperCase()}${cat.slice(1)}VehiclesHint`)

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const filteredVehicles = cat === 'all' ? vehicles : vehicles.filter((v) => v.kind === cat)
  const ratedVehicles = vehicles.filter((v) => v.avg_rating != null)
  const avgRating = ratedVehicles.length > 0 ? (ratedVehicles.reduce((sum, v) => sum + (v.avg_rating ?? 0), 0) / ratedVehicles.length).toFixed(1) : '—'
  const minRate = vehicles.length > 0 ? Math.min(...vehicles.map((v) => rateOf(v) ?? Infinity)) : null
  const catChips: ('all' | Kind)[] = ['all', ...KINDS]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1 bg-white border border-[#e5e2d0] rounded-full p-1 w-fit">
        <button onClick={() => setTab('browse')} className="px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'browse' ? '#166534' : 'transparent', color: tab === 'browse' ? '#fff' : '#64748b' }}>{t('vp.browseTab')}</button>
        <button onClick={() => setTab('mine')} className="relative px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'mine' ? '#166534' : 'transparent', color: tab === 'mine' ? '#fff' : '#64748b' }}>
          {t('vp.myBookingsTab')}
          {bookings.some((b) => ['requested', 'accepted', 'in_progress'].includes(b.status)) && <span className="absolute -top-0.5 -end-0.5 w-2 h-2 rounded-full bg-red-500" />}
        </button>
      </div>

      {tab === 'browse' ? (
        <>
          <section className="rounded-2xl p-3.5 flex flex-col gap-2 text-white border border-[#D4AF37]/20" style={{ background: 'linear-gradient(to right, #005A36, #166534)' }}>
            <span className="self-start bg-[#D4AF37] text-[#0f172a] text-[9.5px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1"><Wrench size={11} /> {t('vp.committeeRateHeading')}</span>
            <h1 className="font-extrabold text-[19px] leading-tight">{pageTitle}</h1>
            <p className="text-[11.5px] text-[#dcfce7] leading-snug">{pageSubtitle}</p>
            <div className="grid grid-cols-3 gap-1.5 mt-0.5">
              <div className="rounded-xl bg-white/10 px-2 py-1.5">
                <p className="font-extrabold text-[14px] ltr-num leading-none">{vehicles.length}</p>
                <p className="text-[9px] text-[#dcfce7] mt-1">{t('vp.equipListedStat')}</p>
              </div>
              <div className="rounded-xl bg-white/10 px-2 py-1.5">
                <p className="font-extrabold text-[14px] ltr-num leading-none">{avgRating !== '—' ? `⭐ ${avgRating}` : '—'}</p>
                <p className="text-[9px] text-[#dcfce7] mt-1">{t('vp.equipAvgRatingStat')}</p>
              </div>
              <div className="rounded-xl bg-white/10 px-2 py-1.5">
                <p className="font-extrabold text-[14px] ltr-num leading-none">{minRate != null && Number.isFinite(minRate) ? fmt(minRate) : '—'}</p>
                <p className="text-[9px] text-[#dcfce7] mt-1">{t('vp.equipFromPriceStat')}/{t('vp.hoursShort')}</p>
              </div>
            </div>
          </section>

          <div className="flex gap-1.5 overflow-x-auto -mx-3.5 px-3.5 pb-0.5">
            {catChips.map((c) => {
              const on = cat === c
              return (
                <button key={c} onClick={() => setCat(c)}
                  className="shrink-0 px-3 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer whitespace-nowrap border"
                  style={{ background: on ? '#166534' : '#fff', color: on ? '#fff' : '#334155', borderColor: on ? '#166534' : '#e5e2d0' }}>
                  {c === 'all' ? t('vp.equipAllCategoryChip') : kindTitle(c)}
                </button>
              )
            })}
          </div>

          {filteredVehicles.length === 0 ? (
            <p className="text-center py-10 text-[#94a3b8] text-[14px]">{noVehiclesHint}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {filteredVehicles.map((v) => {
                const CardIcon = KIND_ICON[v.kind]
                const rate = rateOf(v)
                const mob = v.kind === 'machinery' ? v.machinery_mobilization_fee_pkr : null
                const terms = v.kind === 'machinery' && v.machinery_min_hours != null
                  ? `${t('vp.minHoursHint').replace('{hours}', String(v.machinery_min_hours))} · ${mob ? `${t('vp.mobilizationFeeLabel')} ${fmt(mob)}` : t('vp.freeDeliveryLabel')}`
                  : v.kind === 'tractor' && v.tractor_services && v.tractor_services.length > 0
                  ? v.tractor_services.map((s) => (isUrdu ? s.name_ur : s.name_en)).join(', ')
                  : null
                const Wrapper = v.shared_from_other_village ? 'div' : 'button'
                return (
                  <Wrapper key={`${v.kind}-${v.id}`} {...(v.shared_from_other_village ? {} : { onClick: () => openBooking(v) })}
                    className={`w-full flex items-stretch bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden text-start shadow-[0_2px_6px_rgba(0,0,0,0.05)] min-h-[136px] ${v.shared_from_other_village ? '' : 'cursor-pointer'}`}>
                    <div className="w-[34%] shrink-0 relative flex items-center justify-center overflow-hidden" style={{ background: v.cover_url ? '#F9F9F6' : KIND_TINT[v.kind] }}>
                      {v.cover_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={v.cover_url} alt="" className="w-full h-full object-cover" />
                      ) : <CardIcon size={32} className="text-[#0f172a]/60" />}
                      {v.avg_rating != null && (
                        <span className="absolute top-1.5 start-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#16a34a] text-white ltr-num">⭐ {v.avg_rating}</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 p-2.5 flex flex-col gap-0.5">
                      <p className="text-[9px] font-bold uppercase tracking-[0.04em] text-[#16a34a]">{kindTitle(v.kind)}</p>
                      <p className="text-[13.5px] font-bold text-[#005A36] truncate">{vehicleDisplayName(v.vehicle_type, v.model)}</p>
                      <p className="text-[9.5px] text-[#64748b] truncate">{v.owner_name}</p>
                      <div className="flex items-baseline gap-1 mt-0.5">
                        <span className="font-extrabold text-[15px] text-[#166534] ltr-num">{fmt(rate ?? 0)}</span>
                        <span className="text-[9.5px] text-[#64748b]">{v.kind === 'loader' ? t('vp.baseAmountSuffix') : `/${t('vp.hoursShort')}`}</span>
                      </div>
                      {terms && <p className="text-[9.5px] text-[#475569] truncate">{terms}</p>}
                      {v.shared_from_other_village ? (
                        <div className="mt-auto flex items-center justify-between gap-2">
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800">{t('vp.sharedFromVillageBadge').replace('{village}', v.owner_village_name ?? '')}</span>
                          <CallButton phone={v.owner_mobile} className="inline-flex items-center gap-1 text-[10px] font-bold text-[#166534]" />
                        </div>
                      ) : (
                        <span className="mt-auto self-start rounded-[10px] px-3.5 py-1 bg-[#166534] text-white text-[11px] font-bold">{t('vp.bookNowBtn')}</span>
                      )}
                    </div>
                  </Wrapper>
                )
              })}
            </div>
          )}

          {vehicles.length > 0 && (
            <section className="bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden">
              <div className="px-3 py-2.5 text-[12.5px] font-bold text-[#005A36] border-b border-[#f1f5f9]">📋 {t('vp.equipRateCardHeading')}</div>
              <div className="grid grid-cols-[1fr_72px_52px] gap-1.5 px-3 py-1.5 bg-[#F9F9F6] text-[10px] font-bold text-[#64748b]">
                <span>{t('vp.equipRateCardVehicleCol')}</span><span>{t('vp.equipRateCardRateCol')}</span><span>{t('vp.equipRateCardMinCol')}</span>
              </div>
              {vehicles.map((v, i) => {
                const RowIcon = KIND_ICON[v.kind]
                const rate = rateOf(v)
                const unit = v.kind === 'loader' ? t('vp.baseAmountSuffix') : `/${t('vp.hoursShort')}`
                return (
                  <div key={`${v.kind}-${v.id}`} className="grid grid-cols-[1fr_72px_52px] gap-1.5 items-center px-3 py-1.5 border-t border-[#f8fafc]" style={{ background: i % 2 ? '#fcfcfa' : '#fff' }}>
                    <span className="flex items-center gap-1.5 text-[11px] text-[#1e293b] truncate"><RowIcon size={11} className="shrink-0 text-[#64748b]" /> {vehicleDisplayName(v.vehicle_type, v.model)}</span>
                    <span className="font-sans text-[11px] font-bold text-[#166534] ltr-num truncate">{rate != null ? `${fmt(rate)}${v.kind === 'loader' ? '' : unit}` : '—'}</span>
                    <span className="text-[10.5px] text-[#64748b]">{v.kind === 'machinery' && v.machinery_min_hours != null ? `${v.machinery_min_hours}${t('vp.hoursShort')}` : '—'}</span>
                  </div>
                )
              })}
            </section>
          )}
        </>
      ) : (
        bookings.length === 0 ? (
          <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noEquipmentBookingsHint')}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {bookings.map((b) => (
              <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-[#1e293b]">{vehicleDisplayName(b.vehicle_type, b.model)} — {b.owner_name}</p>
                    <p className="text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1">
                      <MapPin size={11} className="shrink-0 mt-0.5" /> {b.kind === 'loader' && b.pickup_address ? `${b.pickup_address} → ${b.site_address}` : b.site_address}
                    </p>
                    {b.scheduled_date && (
                      <p className="text-[11.5px] text-[#64748b] mt-0.5 ltr-num">
                        {new Date(b.scheduled_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}{b.scheduled_time ? ` · ${b.scheduled_time.slice(0, 5)}` : ''}
                      </p>
                    )}
                    <p className="text-[11.5px] text-[#64748b] mt-0.5 ltr-num">
                      {b.kind === 'loader' ? `${b.trip_count} ${t('vp.tripsShort')} · ` : b.requested_hours != null ? `${b.requested_hours} ${t('vp.hoursShort')} · ` : ''}{fmt(b.rate_pkr)}{b.kind === 'loader' ? '' : `/${t('vp.hoursShort')}`}
                    </p>
                    {b.notes && <p className="text-[11.5px] text-[#64748b] mt-0.5 italic">&ldquo;{b.notes}&rdquo;</p>}
                    {(b.status === 'accepted' || b.status === 'in_progress') && (
                      <span className="flex items-center gap-3 mt-1">
                        <CallButton phone={b.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-[#166534]" />
                        <ChatButton refType="equipment_booking" refId={b.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer" />
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: `${STATUS_COLOR[b.status]}1a`, color: STATUS_COLOR[b.status] }}>{t(`vp.equipmentStatus.${b.status}`)}</span>
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

                {b.site_lat != null && b.site_lng != null && b.status !== 'in_progress' && (
                  <LeafletMap pins={[{ lat: b.site_lat, lng: b.site_lng, color: '#166534' }]} height={120} className="rounded-xl mt-2" />
                )}
                {b.status === 'declined' && (
                  <p className="flex items-center gap-1.5 text-[12px] mt-2 pt-2 border-t border-[#f1f5f9]" style={{ color: '#b91c1c' }}><AlertCircle size={12} /> {t('vp.equipmentStatus.declined')}</p>
                )}
                {b.status === 'in_progress' && (
                  <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin text-[#166534]" />
                    <p className="text-[12px] text-[#64748b]">{t('vp.jobInProgressHint')}</p>
                  </div>
                )}
                {b.status === 'completed' && (
                  <>
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[12px] text-[#64748b]"><CheckCircle2 size={12} className="text-emerald-600" /> {b.actual_hours != null ? `${t('vp.actualHoursLabel')}: ${fmt(b.actual_hours)} ${t('vp.hoursShort')}` : t('vp.equipmentStatus.completed')}</span>
                      <span className="font-extrabold text-[16px] text-[#005A36] ltr-num">{fmt(b.total_amount_pkr ?? b.rate_pkr)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <ShareBookingButton
                        title={`${isUrdu ? site.nameUrdu : site.name} ${t('mb.portalSuffix')}`}
                        lines={[`${vehicleDisplayName(b.vehicle_type, b.model)} — ${b.owner_name}`, b.site_address, `${t('vp.totalLabel')}: ${fmt(b.total_amount_pkr ?? b.rate_pkr)}`]}
                      />
                      <ReportProblemButton refType="equipment_booking" refId={b.id} kindOptions={['fare_dispute', 'no_show']} />
                    </div>
                    <div className="mt-2">
                      <RateAndReport refType="equipment_booking" refId={b.id} againstPartyType="vehicle" againstPartyId={b.vehicle_id} showComplaint={false} />
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
          <p className="text-[12px] text-[#64748b] -mt-2 mb-3">{openVehicle.owner_name}</p>

          {openKind === 'tractor' && openVehicle.tractor_services && openVehicle.tractor_services.length > 0 && (
            <>
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1.5">{t('vp.chooseServiceLabel')}</label>
              <div className="flex flex-col gap-2 mb-3">
                {openVehicle.tractor_services.map((s) => {
                  const on = serviceKey === s.service_key
                  return (
                    <button key={s.service_key} onClick={() => setServiceKey(s.service_key)}
                      className="w-full flex items-center justify-between gap-2 rounded-xl border-2 px-3.5 py-3 text-start cursor-pointer transition-colors"
                      style={{ borderColor: on ? '#166534' : '#e5e2d0', background: on ? '#f0fdf4' : '#fff' }}>
                      <span className="font-semibold text-[13.5px] text-[#1e293b]">{isUrdu ? s.name_ur : s.name_en}</span>
                      <span className="shrink-0 font-bold text-[13px] text-[#166534] ltr-num">{fmt(s.rate_pkr)}/{t('vp.hoursShort')}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {openKind === 'loader' && (
            <>
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.chooseMaterialLabel')}</label>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {MATERIALS.map((m) => (
                  <button key={m} onClick={() => setMaterial(m)}
                    className="px-2.5 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border"
                    style={{ background: material === m ? '#166534' : '#fff', color: material === m ? '#fff' : '#334155', borderColor: material === m ? '#166534' : '#e5e2d0' }}>
                    {t(`vp.material.${m}`)}
                  </button>
                ))}
              </div>

              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.tripCountLabel')}</label>
              <div className="flex items-center gap-2 mb-3">
                <button onClick={() => setTripCount((n) => Math.max(1, n - 1))} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">−</button>
                <span className="font-extrabold text-[18px] w-10 text-center ltr-num">{tripCount}</span>
                <button onClick={() => setTripCount((n) => n + 1)} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">+</button>
              </div>

              {showPickupPicker ? (
                <div className="mb-3">
                  <LocationPickerSheet
                    title={t('vp.goodsPickupAddressLabel')}
                    initial={pickupLoc}
                    inline
                    onClose={() => setShowPickupPicker(false)}
                    onConfirm={(loc) => { setPickupLoc(loc); setShowPickupPicker(false) }}
                  />
                </div>
              ) : (
                <>
                  <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.goodsPickupAddressLabel')}</label>
                  <button onClick={() => setShowPickupPicker(true)} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-3">
                    <MapPin size={15} className="text-[#D4AF37] shrink-0" />
                    <span className={`text-[13.5px] truncate ${pickupLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{pickupLoc ? pickupLoc.label : t('vp.goodsPickupAddressPlaceholder')}</span>
                  </button>
                </>
              )}
            </>
          )}

          {openKind !== 'loader' && (
            <>
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.hoursLabel')}</label>
              <div className="flex items-center gap-2 mb-3">
                <button onClick={() => setHours((h) => Math.max(openVehicle.machinery_min_hours ?? 1, h - 1))} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">−</button>
                <span className="font-extrabold text-[18px] w-10 text-center ltr-num">{hours}</span>
                <button onClick={() => setHours((h) => h + 1)} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">+</button>
              </div>
            </>
          )}

          {hasNegotiableBand && (
            <div className="border-2 border-[#e5e2d0] rounded-xl p-3 mb-3">
              {!rateOffer && (
                <>
                  <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.proposeRateLabel')}</label>
                  <p className="text-[11px] text-[#64748b] mb-1.5">{t('vp.proposeRateHint').replace('{min}', fmt(openVehicle.machinery_hourly_rate_min_pkr ?? 0)).replace('{max}', fmt(openVehicle.machinery_hourly_rate_pkr ?? 0))}</p>
                  <div className="flex items-center gap-2">
                    <input type="number" value={proposeRate} onChange={(e) => setProposeRate(e.target.value)} placeholder="0" className="flex-1 border border-[#e5e2d0] rounded-xl p-2 font-sans text-[13px]" />
                    <button onClick={sendProposal} disabled={proposing} className="px-3 py-2 rounded-xl bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{t('vp.proposeRateBtn')}</button>
                  </div>
                </>
              )}
              {rateOffer?.status === 'pending' && (
                <p className="font-sans text-[12.5px] text-amber-700 ltr-num">{t('vp.yourOfferPendingLabel').replace('{price}', fmt(rateOffer.proposed_rate_pkr))}</p>
              )}
              {rateOffer?.status === 'countered' && (
                <>
                  <p className="font-sans text-[12.5px] text-amber-700 ltr-num mb-2">{t('vp.ownerCounteredLabel').replace('{price}', fmt(rateOffer.counter_rate_pkr ?? 0))}</p>
                  <button onClick={acceptCounter} disabled={proposing} className="w-full py-2 rounded-xl bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{t('vp.acceptCounterBtn')}</button>
                </>
              )}
              {rateOffer?.status === 'accepted' && (
                <p className="font-sans text-[12.5px] text-emerald-700 ltr-num">{t('vp.offerAcceptedLabel').replace('{price}', fmt(acceptedRate ?? 0))}</p>
              )}
              {rateOffer?.status === 'rejected' && (
                <p className="font-sans text-[12.5px] text-[#b91c1c]">{t('vp.offerRejectedLabel')}</p>
              )}
            </div>
          )}

          {showPicker ? (
            <div className="mb-3">
              <LocationPickerSheet
                title={openKind === 'loader' ? t('vp.dropAddressLabel') : t('vp.siteAddressLabel')}
                initial={siteLoc}
                inline
                onClose={() => setShowPicker(false)}
                onConfirm={(loc) => { setSiteLoc(loc); setShowPicker(false) }}
              />
            </div>
          ) : (
            <>
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{openKind === 'loader' ? t('vp.dropAddressLabel') : t('vp.siteAddressLabel')}</label>
              <button onClick={() => setShowPicker(true)} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-3">
                <MapPin size={15} className="text-[#166534] shrink-0" />
                <span className={`text-[13.5px] truncate ${siteLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{siteLoc ? siteLoc.label : (openKind === 'loader' ? t('vp.dropAddressPlaceholder') : t('vp.siteAddressPlaceholder'))}</span>
              </button>
              {(pickupLoc || siteLoc) && (() => {
                const pins: LeafletPin[] = []
                if (openKind === 'loader' && pickupLoc) pins.push({ lat: pickupLoc.lat, lng: pickupLoc.lng, label: pickupLoc.label, color: '#D4AF37', emoji: '🛍️' })
                if (siteLoc) pins.push({ lat: siteLoc.lat, lng: siteLoc.lng, label: siteLoc.label, color: '#166534', emoji: '📍' })
                return (
                  <div className="relative mb-3">
                    <LeafletMap pins={pins} route={pickupDropRoute?.path} height={160} className="rounded-xl" />
                    {pickupDropRoute && (
                      <span className="absolute top-2 end-2 z-10 bg-white/95 backdrop-blur-sm text-[10.5px] font-bold px-2 py-1 rounded-full text-[#1e293b] shadow ltr-num">{pickupDropRoute.distanceKm.toFixed(1)} km 🛣️</span>
                    )}
                  </div>
                )
              })()}
            </>
          )}

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.scheduledDateTimeLabel')}</label>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13px]" />
            <input type="date" value={scheduledDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setScheduledDate(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13px]" />
          </div>

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.notesLabel')}</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t('vp.equipmentNotesPlaceholder')}
            className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13px] resize-none mb-3" />

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
              <span className="text-[#64748b] ltr-num">{openKind === 'loader' ? `${fmt(unitRate)} × ${tripCount} ${t('vp.tripsShort')}` : `${fmt(unitRate)} × ${hours}${t('vp.hoursShort')}`}</span>
              <span className="font-bold text-[#1e293b] ltr-num">{fmt(estimatedTotal)}</span>
            </div>
            {mobilization > 0 && (
              <div className="flex items-center justify-between text-[12px] mt-1 text-[#64748b]">
                <span>{t('vp.mobilizationFeeLabel')}</span>
                <span className="ltr-num">{fmt(mobilization)}</span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5 text-[11.5px] text-[#1e3a5f] bg-[#eff6ff] border border-[#bfdbfe] rounded-xl p-2.5 mb-3">
            <p className="flex items-center gap-1.5 font-bold"><AlertCircle size={13} className="shrink-0 text-[#2563eb]" /> {t('vp.howPaymentWorksHeading')}</p>
            <p>1. {t('vp.noAdvanceStepNote')}</p>
            <p>2. {t('vp.paymentStepDriverAcceptsNote')}</p>
            <p>3. {t('vp.paymentStepPayAfterJobNote')}</p>
          </div>

          <button onClick={submitRequest} disabled={requesting || (openKind === 'tractor' && !serviceKey)} className="w-full flex items-center justify-center gap-1.5 bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer disabled:opacity-50">
            {requesting ? t('action.saving') : <>{t('vp.sendRequestBtn')} <span className="ltr-num">· {fmt(estimatedTotal)}</span></>}
          </button>
        </MobilityBottomSheet>
      )}

    </div>
  )
}
