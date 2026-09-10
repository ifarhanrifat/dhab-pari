'use client'

// Shadi (wedding) vehicle booking — the multi-vehicle sibling of hourly
// rental (474/478). Unlike hourly, the booker hand-picks several
// specific vehicles up front for one wedding day; each driver
// independently accepts/declines against a flat full-day rate; once at
// least one accepts, the booker pays ONE combined non-refundable
// advance to the committee (not per vehicle). No GPS, no start/end trip
// — the distance entered here is shown to drivers purely so they can
// judge the job, it never changes the price.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Users2, Car, Snowflake, Check, Loader2, CalendarDays } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarketplaceBottomNav } from '@/components/portal/MarketplaceBottomNav'

interface Vehicle {
  id: string; owner_name: string; vehicle_type: string; color: string | null; model: string | null; has_ac: boolean
  shadi_full_day_rate_pkr: number; cover_url: string | null
}
interface EventRequest { id: string; status: string }
interface ShadiEvent { id: string; event_date: string; venue_address: string; status: string; advance_amount_pkr: number | null; requests: EventRequest[] }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const STATUS_COLOR: Record<string, string> = {
  collecting: '#9a5714', advance_announced: '#9a5714', confirmed: '#0f7a4d', cancelled: '#6b6560',
}

export default function ShadiBookingPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const router = useRouter()

  const [tab, setTab] = useState<'new' | 'mine'>('new')
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [events, setEvents] = useState<ShadiEvent[]>([])
  const [loading, setLoading] = useState(true)

  const [eventDate, setEventDate] = useState('')
  const [venueAddress, setVenueAddress] = useState('')
  const [distanceKm, setDistanceKm] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  const loadVehicles = () => supabase.rpc('shadi_bookable_vehicles').then(({ data }) => setVehicles((data ?? []) as Vehicle[]))
  const loadEvents = () => supabase.rpc('my_shadi_events').then(({ data }) => setEvents((data ?? []) as ShadiEvent[]))

  useEffect(() => {
    if (!user) return
    Promise.all([loadVehicles(), loadEvents()]).then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const toggleSelect = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const selectedVehicles = vehicles.filter((v) => selectedIds.has(v.id))
  const estimatedTotal = selectedVehicles.reduce((sum, v) => sum + v.shadi_full_day_rate_pkr, 0)

  const submit = async () => {
    if (!eventDate) { toast.error(t('vp.shadiDateRequired')); return }
    if (!venueAddress.trim()) { toast.error(t('vp.shadiVenueRequired')); return }
    if (distanceKm === '' || Number(distanceKm) < 0) { toast.error(t('vp.shadiDistanceRequired')); return }
    if (selectedIds.size === 0) { toast.error(t('vp.shadiSelectVehicleRequired')); return }
    setSubmitting(true)
    const { data, error } = await supabase.rpc('create_shadi_event', {
      p_event_date: eventDate, p_venue_address: venueAddress.trim(), p_distance_km: Number(distanceKm),
      p_notes: notes.trim() || null, p_vehicle_ids: Array.from(selectedIds),
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.shadiRequestsSentToast'))
    router.push(`/portal/marketplace/shadi/${data}`)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <Link href="/portal/marketplace/travel" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.travelPageTitle')}
      </Link>
      <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Users2 size={22} /> {t('vp.shadiPageTitle')}</h1>
      <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1 mb-4">{t('vp.shadiPageSubtitle')}</p>

      <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1 mb-4 w-fit">
        <button onClick={() => setTab('new')} className={`px-4 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'new' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>{t('vp.newBookingTab')}</button>
        <button onClick={() => setTab('mine')} className={`px-4 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'mine' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>{t('vp.myBookingsTab')}</button>
      </div>

      {tab === 'new' ? (
        <>
          <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.eventDateLabel')}</label>
                <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px]" />
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.distanceKmLabel')}</label>
                <input type="number" value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} placeholder={t('vp.distanceKmPlaceholder')} className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px]" />
              </div>
            </div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.venueAddressLabel')}</label>
            <textarea value={venueAddress} onChange={(e) => setVenueAddress(e.target.value)} rows={2} placeholder={t('vp.venueAddressPlaceholder')}
              className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px] resize-none mb-3" />
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.shadiNotesLabel')}</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t('vp.shadiNotesPlaceholder')}
              className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px] resize-none" />
          </div>

          <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('vp.pickVehiclesHeading')}</p>
          {vehicles.length === 0 ? (
            <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('vp.noShadiVehiclesHint')}</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
              {vehicles.map((v) => {
                const picked = selectedIds.has(v.id)
                return (
                  <button key={v.id} onClick={() => toggleSelect(v.id)}
                    className={`bg-white border-2 rounded-lg overflow-hidden text-start cursor-pointer transition-all flex flex-col relative ${picked ? 'border-dp-secondary' : 'border-dp-outline-variant hover:border-dp-secondary/50'}`}>
                    {picked && <span className="absolute top-1.5 end-1.5 z-10 w-5 h-5 rounded-full bg-dp-secondary text-white flex items-center justify-center"><Check size={12} /></span>}
                    <div className="h-24 bg-dp-surface-container-low shrink-0 flex items-center justify-center">
                      {v.cover_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={v.cover_url} alt="" className="w-full h-full object-cover" />
                      ) : <Car size={26} className="text-dp-on-surface-variant/40" />}
                    </div>
                    <div className="p-2.5 flex-1 flex flex-col">
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface truncate">{v.model || v.vehicle_type}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {v.color && <span className="font-sans text-[10px] text-dp-on-surface-variant">{v.color}</span>}
                        {v.has_ac && <span className="flex items-center gap-0.5 font-sans text-[9.5px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700"><Snowflake size={9} /> {t('mv.hasAcLabel')}</span>}
                      </div>
                      <p className="font-heading text-[15px] font-bold text-dp-secondary ltr-num mt-auto pt-1.5">{fmt(v.shadi_full_day_rate_pkr)}<span className="font-sans text-[10px] font-normal text-dp-on-surface-variant">/{t('mv.perDayShort')}</span></p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {selectedIds.size > 0 && (
            <div className="bg-dp-surface-container-low rounded-lg p-3 mb-3 flex items-center justify-between">
              <span className="font-sans text-[13px] text-dp-on-surface-variant">{selectedIds.size} {t('vp.vehiclesSelectedSuffix')}</span>
              <span className="font-heading text-[16px] font-bold text-dp-on-surface ltr-num">{fmt(estimatedTotal)}</span>
            </div>
          )}
          <button onClick={submit} disabled={submitting || vehicles.length === 0} className="w-full bg-dp-secondary text-white rounded-lg py-3 font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            {submitting ? <Loader2 size={16} className="animate-spin" /> : null} {t('vp.sendRequestsBtn')}
          </button>
        </>
      ) : (
        events.length === 0 ? (
          <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('vp.noShadiBookingsHint')}</p>
        ) : (
          <div className="space-y-2.5">
            {events.map((e) => {
              const accepted = e.requests.filter((r) => r.status === 'accepted').length
              return (
                <Link key={e.id} href={`/portal/marketplace/shadi/${e.id}`} className="block bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5"><CalendarDays size={13} className="text-dp-secondary shrink-0" /> {new Date(e.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 truncate">{e.venue_address}</p>
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5 ltr-num">{accepted}/{e.requests.length} {t('vp.acceptedOfTotalSuffix')}</p>
                    </div>
                    <span className="shrink-0 font-sans text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: `${STATUS_COLOR[e.status]}1a`, color: STATUS_COLOR[e.status] }}>{t(`vp.shadiStatus.${e.status}`)}</span>
                  </div>
                </Link>
              )
            })}
          </div>
        )
      )}
      <MarketplaceBottomNav />
    </div>
  )
}
