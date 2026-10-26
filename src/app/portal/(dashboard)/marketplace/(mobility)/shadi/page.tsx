'use client'

// Shadi (wedding) vehicle booking — the multi-vehicle sibling of hourly
// rental (474/478). Unlike hourly, the booker hand-picks several
// specific vehicles up front for one wedding day; each driver
// independently accepts/declines against a flat full-day rate; once at
// least one accepts, the booker pays ONE combined non-refundable
// advance to the committee (not per vehicle). No GPS, no start/end trip
// — the distance entered here is shown to drivers purely so they can
// judge the job, it never changes the price.
//
// Phase 4: re-skinned to the new design + moved under marketplace/
// (mobility)/ — same RPCs, same form fields, new visual language.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Users2, Car, Snowflake, Check, Loader2, CalendarDays, MapPin, Star, X, Info } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { CallButton } from '@/components/portal/CallButton'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { CategoryVehiclePicker, type CategoryDef } from '@/components/mobility/CategoryVehiclePicker'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Vehicle {
  id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; color: string | null; model: string | null; has_ac: boolean
  shadi_vehicle_class: string | null
  shadi_full_day_rate_pkr: number; cover_url: string | null; avg_rating: number | null
  shared_from_other_village: boolean; owner_village_name: string | null
}
interface ShadiClass { class_key: string; name_en: string; name_ur: string; full_day_rate_pkr: number; free_km: number; per_extra_km_pkr: number }
interface EventRequest { id: string; status: string }
interface ShadiEvent { id: string; event_date: string; venue_address: string; venue_lat: number | null; venue_lng: number | null; status: string; advance_amount_pkr: number | null; requests: EventRequest[] }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const STATUS_COLOR: Record<string, string> = {
  collecting: '#92400e', advance_announced: '#92400e', confirmed: '#166534', cancelled: '#64748b',
}

export default function ShadiBookingPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const router = useRouter()

  const [tab, setTab] = useState<'new' | 'mine'>('new')
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [classes, setClasses] = useState<ShadiClass[]>([])
  const [events, setEvents] = useState<ShadiEvent[]>([])
  const [loading, setLoading] = useState(true)

  const [eventDate, setEventDate] = useState('')
  const [venueLoc, setVenueLoc] = useState<PickedLocation | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [distanceKm, setDistanceKm] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [openVehicle, setOpenVehicle] = useState<Vehicle | null>(null)

  const loadVehicles = () => supabase.rpc('shadi_bookable_vehicles').then(({ data }) => setVehicles((data ?? []) as Vehicle[]))
  const loadClasses = () => supabase.rpc('shadi_vehicle_classes_list').then(({ data }) => setClasses((data ?? []) as ShadiClass[]))
  const loadEvents = () => supabase.rpc('my_shadi_events').then(({ data }) => setEvents((data ?? []) as ShadiEvent[]))

  useEffect(() => {
    if (!user) return
    Promise.all([loadVehicles(), loadClasses(), loadEvents()]).then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const toggleSelect = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const selectedVehicles = vehicles.filter((v) => selectedIds.has(v.id))
  const estimatedTotal = selectedVehicles.reduce((sum, v) => sum + v.shadi_full_day_rate_pkr, 0)

  // Category cards, the mockup's own wcats/dropdown mechanism — one per
  // real shadi_vehicle_class plus an "other" bucket for any vehicle a
  // driver hasn't classified yet (set_vehicle_catalog_prefs), so nothing
  // silently disappears from the picker just for lacking a class.
  const classifiedKeys = new Set(classes.map((c) => c.class_key))
  const otherVehicles = vehicles.filter((v) => !v.shadi_vehicle_class || !classifiedKeys.has(v.shadi_vehicle_class))
  const vehicleCard = (v: Vehicle) => {
    const picked = selectedIds.has(v.id)
    const Wrapper = v.shared_from_other_village ? 'div' : 'button'
    return (
      <Wrapper key={v.id} {...(v.shared_from_other_village ? {} : { onClick: () => setOpenVehicle(v) })}
        className={`bg-white border-2 rounded-xl overflow-hidden text-start flex flex-col relative ${v.shared_from_other_village ? '' : 'cursor-pointer'}`}
        style={{ borderColor: picked ? '#166534' : '#e5e2d0' }}>
        <div className="h-[70px] relative bg-[#F9F9F6] shrink-0 flex items-center justify-center">
          {v.cover_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.cover_url} alt="" className="w-full h-full object-cover" />
          ) : <Car size={26} className="text-[#94a3b8]" />}
          {v.color && (
            <span className="absolute bottom-1 start-1 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/90 text-[9px] font-bold text-[#1e293b]">
              <span className="w-2 h-2 rounded-full border border-[#cbd5e1] bg-[#cbd5e1]" /> {v.color}
            </span>
          )}
        </div>
        <div className="p-2 flex-1 flex flex-col gap-0.5">
          <p className="text-[10.5px] font-bold text-[#1e293b] truncate">{vehicleDisplayName(v.vehicle_type, v.model)}</p>
          <p className="text-[9px] text-[#64748b] truncate">{v.owner_name}{v.avg_rating != null ? ` · ⭐ ${v.avg_rating}` : ''}</p>
          {v.has_ac && <span className="self-start flex items-center gap-0.5 text-[8.5px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700"><Snowflake size={8} /> {t('mv.hasAcLabel')}</span>}
          <p className="font-extrabold text-[11.5px] text-[#166534] ltr-num">{fmt(v.shadi_full_day_rate_pkr)}</p>
          {v.shared_from_other_village ? (
            <div className="mt-auto flex flex-col gap-0.5">
              <span className="text-[8px] font-bold px-1 py-0.5 rounded-full bg-amber-50 text-amber-800 self-start">{t('vp.sharedFromVillageBadge').replace('{village}', v.owner_village_name ?? '')}</span>
              <CallButton phone={v.owner_mobile} className="inline-flex items-center gap-1 text-[9px] font-bold text-[#166534]" />
            </div>
          ) : (
            <span className="mt-auto rounded-[9px] px-1 py-1 text-center text-[9.5px] font-bold"
              style={{ background: picked ? '#166534' : '#fff', color: picked ? '#fff' : '#166534', border: '1px solid #166534' }}>
              {picked ? `✓ ${t('vp.addedLabel')}` : `+ ${t('vp.addVehicleBtn')}`}
            </span>
          )}
        </div>
      </Wrapper>
    )
  }
  const categoryDefs: CategoryDef[] = [
    ...classes.map((c) => {
      const inClass = vehicles.filter((v) => v.shadi_vehicle_class === c.class_key)
      return {
        key: c.class_key, emoji: c.class_key === 'hiace' ? '🚐' : c.class_key === 'bolan' ? '🚐' : '🚗',
        name: isUrdu ? c.name_ur : c.name_en, vehicleCount: inClass.length,
        fromPricePkr: inClass.length > 0 ? Math.min(...inClass.map((v) => v.shadi_full_day_rate_pkr)) : c.full_day_rate_pkr,
        selectedCount: inClass.filter((v) => selectedIds.has(v.id)).length,
        children: inClass.map(vehicleCard),
      }
    }),
    ...(otherVehicles.length > 0 ? [{
      key: 'other', emoji: '🚗', name: t('vp.otherVehiclesCategory'), vehicleCount: otherVehicles.length,
      fromPricePkr: Math.min(...otherVehicles.map((v) => v.shadi_full_day_rate_pkr)),
      selectedCount: otherVehicles.filter((v) => selectedIds.has(v.id)).length,
      children: otherVehicles.map(vehicleCard),
    }] : []),
  ]

  const submit = async () => {
    if (!eventDate) { toast.error(t('vp.shadiDateRequired')); return }
    if (!venueLoc) { toast.error(t('vp.shadiVenueRequired')); return }
    if (distanceKm === '' || Number(distanceKm) < 0) { toast.error(t('vp.shadiDistanceRequired')); return }
    if (selectedIds.size === 0) { toast.error(t('vp.shadiSelectVehicleRequired')); return }
    setSubmitting(true)
    const { data, error } = await supabase.rpc('create_shadi_event', {
      p_event_date: eventDate, p_venue_address: venueLoc.label, p_distance_km: Number(distanceKm),
      p_notes: notes.trim() || null, p_vehicle_ids: Array.from(selectedIds),
      p_venue_lat: venueLoc.lat, p_venue_lng: venueLoc.lng,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.shadiRequestsSentToast'))
    router.push(`/portal/marketplace/shadi/${data}`)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Users2 size={19} /> {t('vp.shadiPageTitle')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.shadiPageSubtitle')}</p>
      </div>

      <div className="flex items-center gap-1 bg-white border border-[#e5e2d0] rounded-full p-1 w-fit">
        <button onClick={() => setTab('new')} className="px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'new' ? '#166534' : 'transparent', color: tab === 'new' ? '#fff' : '#64748b' }}>{t('vp.newBookingTab')}</button>
        <button onClick={() => setTab('mine')} className="px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'mine' ? '#166534' : 'transparent', color: tab === 'mine' ? '#fff' : '#64748b' }}>{t('vp.myBookingsTab')}</button>
      </div>

      {tab === 'new' ? (
        <>
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.eventDateLabel')}</label>
                <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="dp2-input text-[13.5px]" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.distanceKmLabel')}</label>
                <input type="number" value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} placeholder={t('vp.distanceKmPlaceholder')} className="dp2-input text-[13.5px]" />
              </div>
            </div>
            {showPicker ? (
              <div className="mb-3">
                <LocationPickerSheet
                  title={t('vp.venueAddressLabel')}
                  initial={venueLoc}
                  inline
                  onClose={() => setShowPicker(false)}
                  onConfirm={(loc) => { setVenueLoc(loc); setShowPicker(false) }}
                />
              </div>
            ) : (
              <>
                <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.venueAddressLabel')}</label>
                {venueLoc && <LeafletMap pins={[{ lat: venueLoc.lat, lng: venueLoc.lng, color: '#166534' }]} height={140} className="rounded-xl mb-2" />}
                <button onClick={() => setShowPicker(true)} className="w-full flex items-center gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer mb-3">
                  <MapPin size={15} className="text-[#166534] shrink-0" />
                  <span className={`text-[13.5px] truncate ${venueLoc ? 'text-[#1e293b] font-semibold' : 'text-[#94a3b8]'}`}>{venueLoc ? venueLoc.label : t('vp.venueAddressPlaceholder')}</span>
                </button>
              </>
            )}
            <label className="block text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.shadiNotesLabel')}</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t('vp.shadiNotesPlaceholder')}
              className="dp2-input text-[13.5px] resize-none leading-relaxed" />
          </div>

          <p className="text-[12px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('vp.pickVehiclesHeading')}</p>
          {vehicles.length === 0 ? (
            <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noShadiVehiclesHint')}</p>
          ) : (
            <CategoryVehiclePicker categories={categoryDefs} availableLabel={t('mb.availableLabel')} fromLabel={t('mb.fromPriceLabel')} />
          )}
          {selectedIds.size > 0 && (
            <div className="bg-[#F9F9F6] rounded-2xl p-3 flex flex-col gap-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('vp.selectedVehiclesListHeading')} ({selectedIds.size})</p>
              <div className="flex flex-col gap-1.5">
                {selectedVehicles.map((v) => (
                  <div key={v.id} className="flex items-center gap-2 bg-white rounded-xl px-2.5 py-2">
                    <button onClick={() => toggleSelect(v.id)} className="shrink-0 text-[#b91c1c] cursor-pointer"><X size={14} /></button>
                    <Car size={14} className="shrink-0 text-[#64748b]" />
                    <span className="flex-1 min-w-0 text-[12.5px] font-semibold text-[#1e293b] truncate">
                      {vehicleDisplayName(v.vehicle_type, v.model)}{v.color ? ` · ${v.color}` : ''} · {v.owner_name}
                    </span>
                    <span className="shrink-0 font-bold text-[12.5px] text-[#166534] ltr-num">{fmt(v.shadi_full_day_rate_pkr)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between pt-1.5 border-t border-[#e5e2d0]">
                <span className="text-[13px] font-bold text-[#1e293b]">{t('vp.totalLabel')}</span>
                <span className="font-extrabold text-[16px] text-[#1e293b] ltr-num">{fmt(estimatedTotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] text-[#92400e]">{t('vp.estimatedAdvanceLabel').replace('{pct}', '20')}</span>
                <span className="font-semibold text-[12.5px] text-[#92400e] ltr-num">{fmt(Math.round(estimatedTotal * 0.2))}</span>
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 text-[11px] text-[#1e3a5f] bg-[#eff6ff] border border-[#bfdbfe] rounded-xl p-2.5">
            <Info size={13} className="shrink-0 mt-0.5 text-[#2563eb]" />
            <span>{t('vp.noMoneyBeforeAcceptNote')}</span>
          </div>

          <button onClick={submit} disabled={submitting || vehicles.length === 0} className="w-full bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2">
            {submitting ? <Loader2 size={16} className="animate-spin" /> : null} {t('vp.sendRequestsBtn')}
          </button>
        </>
      ) : (
        events.length === 0 ? (
          <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noShadiBookingsHint')}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {events.map((e) => {
              const accepted = e.requests.filter((r) => r.status === 'accepted').length
              return (
                <Link key={e.id} href={`/portal/marketplace/shadi/${e.id}`} className="block bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-bold text-[#1e293b] flex items-center gap-1.5"><CalendarDays size={13} className="text-[#166534] shrink-0" /> {new Date(e.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                      <p className="text-[12px] text-[#64748b] mt-0.5 truncate">{e.venue_address}</p>
                      <p className="text-[11.5px] text-[#64748b] mt-0.5 ltr-num">{accepted}/{e.requests.length} {t('vp.acceptedOfTotalSuffix')}</p>
                    </div>
                    <span className="shrink-0 text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: `${STATUS_COLOR[e.status]}1a`, color: STATUS_COLOR[e.status] }}>{t(`vp.shadiStatus.${e.status}`)}</span>
                  </div>
                </Link>
              )
            })}
          </div>
        )
      )}

      {openVehicle && (
        <MobilityBottomSheet title={vehicleDisplayName(openVehicle.vehicle_type, openVehicle.model)} onClose={() => setOpenVehicle(null)}>
          <div className="flex flex-col gap-3">
            <div className="h-[160px] rounded-xl bg-[#F9F9F6] flex items-center justify-center overflow-hidden">
              {openVehicle.cover_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={openVehicle.cover_url} alt="" className="w-full h-full object-cover" />
              ) : <Car size={40} className="text-[#94a3b8]" />}
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-bold text-[#1e293b]">{openVehicle.owner_name}</p>
                {openVehicle.avg_rating != null && (
                  <p className="flex items-center gap-1 text-[12px] text-[#64748b] mt-0.5"><Star size={11} className="fill-amber-400 text-amber-400" /> {openVehicle.avg_rating} {t('vp.ratingLabel')}</p>
                )}
              </div>
              {!openVehicle.shared_from_other_village && <CallButton phone={openVehicle.owner_mobile} />}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {openVehicle.color && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-[#F9F9F6] text-[11px] font-semibold text-[#1e293b]">
                  <span className="w-2.5 h-2.5 rounded-full border border-[#cbd5e1] bg-[#cbd5e1]" /> {t('mv.colorLabel')}: {openVehicle.color}
                </span>
              )}
              {openVehicle.has_ac && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-sky-50 text-sky-700 text-[11px] font-semibold"><Snowflake size={11} /> {t('mv.hasAcLabel')}</span>
              )}
            </div>

            <div className="flex items-center justify-between bg-[#F9F9F6] rounded-xl p-3">
              <span className="text-[12.5px] font-semibold text-[#64748b]">{t('vp.fullDayRateLabel')}</span>
              <span className="font-extrabold text-[16px] text-[#166534] ltr-num">{fmt(openVehicle.shadi_full_day_rate_pkr)}</span>
            </div>

            {openVehicle.shared_from_other_village ? (
              <span className="text-[11.5px] font-bold px-2.5 py-1.5 rounded-xl bg-amber-50 text-amber-800 self-start">
                {t('vp.sharedFromVillageBadge').replace('{village}', openVehicle.owner_village_name ?? '')}
              </span>
            ) : (
              <button
                onClick={() => { toggleSelect(openVehicle.id); setOpenVehicle(null) }}
                className="w-full rounded-xl py-3 font-bold cursor-pointer flex items-center justify-center gap-2"
                style={selectedIds.has(openVehicle.id)
                  ? { background: '#fff', color: '#b91c1c', border: '1px solid #e5e2d0' }
                  : { background: '#166534', color: '#fff' }}>
                {selectedIds.has(openVehicle.id) ? t('vp.removeFromSelectionBtn') : <><Check size={16} /> {t('vp.addVehicleBtn')}</>}
              </button>
            )}
          </div>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
