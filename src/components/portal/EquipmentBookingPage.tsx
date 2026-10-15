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
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { ShareBookingButton } from '@/components/portal/ShareBookingButton'
import { CallButton } from '@/components/portal/CallButton'
import { ChatButton } from '@/components/portal/ChatButton'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

type Kind = 'machinery' | 'tractor' | 'loader'

interface TractorService { service_key: string; name_en: string; name_ur: string; rate_pkr: number; unit: string }
interface Vehicle {
  id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; color: string | null; model: string | null
  machinery_hourly_rate_pkr: number | null; machinery_min_hours: number | null; machinery_mobilization_fee_pkr: number | null
  loader_trip_rate_pkr: number | null; tractor_services: TractorService[] | null; cover_url: string | null; avg_rating: number | null
  shared_from_other_village: boolean; owner_village_name: string | null
}
interface Booking {
  id: string; kind: Kind; service_key: string | null; site_address: string; site_lat: number | null; site_lng: number | null; material: string | null
  requested_hours: number | null; status: string; rate_pkr: number; mobilization_fee_pkr: number
  actual_hours: number | null; total_amount_pkr: number | null
  requested_at: string; started_at: string | null; ended_at: string | null; pin: string | null
  notes: string | null; payment_method: string
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

export function EquipmentBookingPage({ kind }: { kind: Kind }) {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const Icon = KIND_ICON[kind]

  const [tab, setTab] = useState<'browse' | 'mine'>('browse')
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)

  const [openVehicle, setOpenVehicle] = useState<Vehicle | null>(null)
  const [hours, setHours] = useState(1)
  const [serviceKey, setServiceKey] = useState('')
  const [material, setMaterial] = useState('bricks')
  const [siteLoc, setSiteLoc] = useState<PickedLocation | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [notes, setNotes] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [requesting, setRequesting] = useState(false)

  const loadVehicles = () => supabase.rpc('equipment_bookable_vehicles', { p_kind: kind }).then(({ data }) => setVehicles((data ?? []) as Vehicle[]))
  const loadBookings = () => supabase.rpc('my_equipment_bookings').then(({ data }) => setBookings(((data ?? []) as Booking[]).filter((b) => b.kind === kind)))

  useEffect(() => {
    if (!user) return
    setLoading(true)
    Promise.all([loadVehicles(), loadBookings()]).then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, kind])

  useEffect(() => {
    if (tab !== 'mine' || !bookings.some((b) => b.status === 'in_progress')) return
    const id = setInterval(loadBookings, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookings])

  const openBooking = (v: Vehicle) => {
    setOpenVehicle(v)
    setHours(v.machinery_min_hours ?? 1)
    setServiceKey(v.tractor_services?.[0]?.service_key ?? '')
    setMaterial('bricks')
    setSiteLoc(null)
    setNotes('')
    setPaymentMethod('cash')
  }

  const bookAgain = (vehicleId: string) => {
    setTab('browse')
    const v = vehicles.find((x) => x.id === vehicleId)
    if (v) openBooking(v)
  }

  const selectedService = openVehicle?.tractor_services?.find((s) => s.service_key === serviceKey) ?? null
  const unitRate = kind === 'tractor' ? (selectedService?.rate_pkr ?? 0) : (kind === 'machinery' ? (openVehicle?.machinery_hourly_rate_pkr ?? 0) : (openVehicle?.loader_trip_rate_pkr ?? 0))
  const mobilization = kind === 'machinery' ? (openVehicle?.machinery_mobilization_fee_pkr ?? 0) : 0
  const estimatedTotal = kind === 'loader' ? unitRate : unitRate * hours + mobilization

  const submitRequest = async () => {
    if (!openVehicle) return
    if (!siteLoc) { toast.error(t('vp.siteAddressRequired')); return }
    setRequesting(true)
    const { error } = await supabase.rpc('create_equipment_booking', {
      p_vehicle_id: openVehicle.id, p_kind: kind,
      p_service_key: kind === 'tractor' ? serviceKey : null,
      p_hours: kind === 'loader' ? null : hours,
      p_site_address: siteLoc.label,
      p_material: kind === 'loader' ? material : null,
      p_site_lat: siteLoc.lat, p_site_lng: siteLoc.lng,
      p_notes: notes.trim() || null, p_payment_method: paymentMethod,
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

  const pageTitle = t(`vp.${kind}PageTitle`)
  const pageSubtitle = t(`vp.${kind}PageSubtitle`)
  const noVehiclesHint = t(`vp.no${kind.charAt(0).toUpperCase()}${kind.slice(1)}VehiclesHint`)

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Icon size={19} /> {pageTitle}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{pageSubtitle}</p>
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
          </div>
          {vehicles.length === 0 ? (
            <p className="text-center py-10 text-[#94a3b8] text-[14px]">{noVehiclesHint}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {vehicles.map((v) => {
                const rate = kind === 'machinery' ? v.machinery_hourly_rate_pkr : kind === 'loader' ? v.loader_trip_rate_pkr : (v.tractor_services?.[0]?.rate_pkr ?? 0)
                const mob = kind === 'machinery' ? v.machinery_mobilization_fee_pkr : null
                const terms = kind === 'machinery' && v.machinery_min_hours != null
                  ? `${t('vp.minHoursHint').replace('{hours}', String(v.machinery_min_hours))} · ${mob ? `${t('vp.mobilizationFeeLabel')} ${fmt(mob)}` : t('vp.freeDeliveryLabel')}`
                  : kind === 'tractor' && v.tractor_services && v.tractor_services.length > 0
                  ? v.tractor_services.map((s) => (isUrdu ? s.name_ur : s.name_en)).join(', ')
                  : null
                const Wrapper = v.shared_from_other_village ? 'div' : 'button'
                return (
                  <Wrapper key={v.id} {...(v.shared_from_other_village ? {} : { onClick: () => openBooking(v) })}
                    className={`w-full flex items-stretch bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden text-start shadow-[0_2px_6px_rgba(0,0,0,0.05)] min-h-[136px] ${v.shared_from_other_village ? '' : 'cursor-pointer'}`}>
                    <div className="w-[34%] shrink-0 relative bg-[#F9F9F6] flex items-center justify-center overflow-hidden">
                      {v.cover_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={v.cover_url} alt="" className="w-full h-full object-cover" />
                      ) : <Icon size={32} className="text-[#94a3b8]" />}
                      {v.avg_rating != null && (
                        <span className="absolute top-1.5 start-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#16a34a] text-white ltr-num">⭐ {v.avg_rating}</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 p-2.5 flex flex-col gap-0.5">
                      <p className="text-[9px] font-bold uppercase tracking-[0.04em] text-[#16a34a]">{pageTitle}</p>
                      <p className="text-[13.5px] font-bold text-[#005A36] truncate">{vehicleDisplayName(v.vehicle_type, v.model)}</p>
                      <p className="text-[9.5px] text-[#64748b] truncate">{v.owner_name}</p>
                      <div className="flex items-baseline gap-1 mt-0.5">
                        <span className="font-extrabold text-[15px] text-[#166534] ltr-num">{fmt(rate ?? 0)}</span>
                        <span className="text-[9.5px] text-[#64748b]">{kind === 'loader' ? t('vp.baseAmountSuffix') : `/${t('vp.hoursShort')}`}</span>
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
                    <p className="text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {b.site_address}</p>
                    <p className="text-[11.5px] text-[#64748b] mt-0.5 ltr-num">
                      {b.requested_hours != null ? `${b.requested_hours} ${t('vp.hoursShort')} · ` : ''}{fmt(b.rate_pkr)}{kind === 'loader' ? '' : `/${t('vp.hoursShort')}`}
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
                        title={t('mb.appName')}
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

          {kind === 'tractor' && openVehicle.tractor_services && openVehicle.tractor_services.length > 0 && (
            <>
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.chooseServiceLabel')}</label>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {openVehicle.tractor_services.map((s) => (
                  <button key={s.service_key} onClick={() => setServiceKey(s.service_key)}
                    className="px-2.5 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border"
                    style={{ background: serviceKey === s.service_key ? '#166534' : '#fff', color: serviceKey === s.service_key ? '#fff' : '#334155', borderColor: serviceKey === s.service_key ? '#166534' : '#e5e2d0' }}>
                    {isUrdu ? s.name_ur : s.name_en} · {fmt(s.rate_pkr)}
                  </button>
                ))}
              </div>
            </>
          )}

          {kind === 'loader' && (
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
            </>
          )}

          {kind !== 'loader' && (
            <>
              <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.hoursLabel')}</label>
              <div className="flex items-center gap-2 mb-3">
                <button onClick={() => setHours((h) => Math.max(openVehicle.machinery_min_hours ?? 1, h - 1))} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">−</button>
                <span className="font-extrabold text-[18px] w-10 text-center ltr-num">{hours}</span>
                <button onClick={() => setHours((h) => h + 1)} className="w-9 h-9 border border-[#e5e2d0] rounded-xl cursor-pointer text-[16px]">+</button>
              </div>
            </>
          )}

          <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.siteAddressLabel')}</label>
          {siteLoc && <LeafletMap pins={[{ lat: siteLoc.lat, lng: siteLoc.lng, color: '#166534' }]} height={140} className="rounded-xl mb-2" />}
          <button onClick={() => setShowPicker(true)} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-3">
            <MapPin size={15} className="text-[#166534] shrink-0" />
            <span className={`text-[13.5px] truncate ${siteLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{siteLoc ? siteLoc.label : t('vp.siteAddressPlaceholder')}</span>
          </button>

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
              <span className="text-[#64748b]">{kind === 'loader' ? t('vp.baseAmountSuffix') : `${fmt(unitRate)} × ${hours}${t('vp.hoursShort')}`}</span>
              <span className="font-bold text-[#1e293b] ltr-num">{fmt(estimatedTotal)}</span>
            </div>
            {mobilization > 0 && (
              <div className="flex items-center justify-between text-[12px] mt-1 text-[#64748b]">
                <span>{t('vp.mobilizationFeeLabel')}</span>
                <span className="ltr-num">{fmt(mobilization)}</span>
              </div>
            )}
          </div>

          <p className="flex items-start gap-1.5 text-[11px] text-[#64748b] mb-3"><AlertCircle size={12} className="shrink-0 mt-0.5 text-[#166534]" /> {t('vp.noAdvanceExplainer')}</p>

          <button onClick={submitRequest} disabled={requesting || (kind === 'tractor' && !serviceKey)} className="w-full bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer disabled:opacity-50">
            {requesting ? t('action.saving') : t('vp.sendRequestBtn')}
          </button>
        </MobilityBottomSheet>
      )}

      {showPicker && (
        <LocationPickerSheet
          title={t('vp.siteAddressLabel')}
          initial={siteLoc}
          onClose={() => setShowPicker(false)}
          onConfirm={(loc) => { setSiteLoc(loc); setShowPicker(false) }}
        />
      )}
    </div>
  )
}
