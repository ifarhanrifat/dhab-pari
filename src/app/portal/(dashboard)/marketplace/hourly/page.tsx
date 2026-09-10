'use client'

// Hourly rental — browse vehicles that opted in (offers_hourly, 474),
// book by the hour, and track the request through the full accept/
// decline/in-progress/completed lifecycle (475/477). Price is formulaic
// (rate × hours, locked in at request time) — nothing to negotiate, so
// this is a direct booking like ride_bookings, not a chat thread.
//
// The "My Bookings" tab doubles as the whole post-request experience:
// a still-pending request can be cancelled, a declined one shows why,
// an in-progress trip shows the live distance ticking up (transparency
// toward the same "no dispute" goal the overage billing itself serves —
// nothing about the final bill should be a surprise), and a completed
// one shows the final breakdown.

import { useEffect, useState } from 'react'
import { ArrowLeft, Car, Snowflake, MapPin, X, Clock3, Loader2, AlertCircle, CheckCircle2, Ban } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'

interface Vehicle {
  id: string; owner_name: string; vehicle_type: string; color: string | null; model: string | null; has_ac: boolean
  hourly_rate_pkr: number; hourly_included_km: number | null; hourly_overage_per_km_pkr: number | null; cover_url: string | null
}
interface Booking {
  id: string; hours: number; status: string; pickup_address: string; decline_reason: string | null
  base_amount_pkr: number; total_amount_pkr: number | null; distance_km: number
  requested_at: string; started_at: string | null; ended_at: string | null
  owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null; color: string | null
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const STATUS_COLOR: Record<string, string> = {
  requested: '#9a5714', accepted: '#0f7a4d', in_progress: '#0f7a4d', completed: '#3f4c5c', declined: '#b3261e', cancelled: '#6b6560',
}

export default function HourlyRentalPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [tab, setTab] = useState<'browse' | 'mine'>('browse')
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)

  const [openVehicle, setOpenVehicle] = useState<Vehicle | null>(null)
  const [hours, setHours] = useState(1)
  const [address, setAddress] = useState('')
  const [requesting, setRequesting] = useState(false)

  const loadVehicles = () => supabase.rpc('hourly_bookable_vehicles').then(({ data }) => setVehicles((data ?? []) as Vehicle[]))
  const loadBookings = () => supabase.rpc('my_hourly_bookings').then(({ data }) => setBookings((data ?? []) as Booking[]))

  useEffect(() => {
    if (!user) return
    Promise.all([loadVehicles(), loadBookings()]).then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // A trip in progress is the one state worth refreshing on its own —
  // watching the distance (and therefore the running overage) tick up
  // live is the whole point of showing it at all.
  useEffect(() => {
    if (tab !== 'mine' || !bookings.some((b) => b.status === 'in_progress')) return
    const id = setInterval(loadBookings, 10000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookings])

  const openBooking = (v: Vehicle) => { setOpenVehicle(v); setHours(1); setAddress('') }

  const submitRequest = async () => {
    if (!openVehicle) return
    if (!address.trim()) { toast.error(t('vp.hourlyAddressRequired')); return }
    setRequesting(true)
    const { error } = await supabase.rpc('create_hourly_booking', { p_vehicle_id: openVehicle.id, p_hours: hours, p_pickup_address: address.trim() })
    setRequesting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.hourlyRequestSentToast'))
    setOpenVehicle(null)
    loadBookings()
    setTab('mine')
  }

  const cancelBooking = async (id: string) => {
    if (!confirm(t('vp.confirmCancelHourly'))) return
    const { error } = await supabase.rpc('cancel_hourly_booking', { p_booking_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    loadBookings()
  }

  const estimatedTotal = openVehicle ? openVehicle.hourly_rate_pkr * hours : 0
  const estimatedIncludedKm = openVehicle ? (openVehicle.hourly_included_km ?? 0) * hours : 0

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/marketplace/travel" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.travelPageTitle')}
      </Link>
      <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Clock3 size={22} /> {t('vp.hourlyPageTitle')}</h1>
      <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1 mb-4">{t('vp.hourlyPageSubtitle')}</p>

      <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1 mb-4 w-fit">
        <button onClick={() => setTab('browse')} className={`px-4 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'browse' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>{t('vp.browseTab')}</button>
        <button onClick={() => setTab('mine')} className={`px-4 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all relative ${tab === 'mine' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>
          {t('vp.myBookingsTab')}
          {bookings.some((b) => ['requested', 'accepted', 'in_progress'].includes(b.status)) && <span className="absolute -top-0.5 -end-0.5 w-2 h-2 rounded-full bg-dp-error" />}
        </button>
      </div>

      {tab === 'browse' ? (
        vehicles.length === 0 ? (
          <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('vp.noHourlyVehiclesHint')}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {vehicles.map((v) => (
              <button key={v.id} onClick={() => openBooking(v)}
                className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden text-start cursor-pointer hover:border-dp-secondary hover:shadow-sm transition-all flex flex-col">
                <div className="h-28 bg-dp-surface-container-low shrink-0 flex items-center justify-center">
                  {v.cover_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.cover_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Car size={28} className="text-dp-on-surface-variant/40" />
                  )}
                </div>
                <div className="p-2.5 flex-1 flex flex-col">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface truncate">{v.model || v.vehicle_type}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {v.color && <span className="font-sans text-[10px] text-dp-on-surface-variant">{v.color}</span>}
                    {v.has_ac && <span className="flex items-center gap-0.5 font-sans text-[9.5px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700"><Snowflake size={9} /> {t('mv.hasAcLabel')}</span>}
                  </div>
                  <div className="mt-auto pt-1.5">
                    <p className="font-heading text-[15px] font-bold text-dp-secondary ltr-num">{fmt(v.hourly_rate_pkr)}<span className="font-sans text-[10px] font-normal text-dp-on-surface-variant">/{t('mv.perHourShort')}</span></p>
                    {v.hourly_included_km != null && <p className="font-sans text-[9.5px] text-dp-on-surface-variant ltr-num">{fmt(v.hourly_included_km)}km/{t('mv.perHourShort')} {t('mv.includedShort')}</p>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        bookings.length === 0 ? (
          <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('vp.noHourlyBookingsHint')}</p>
        ) : (
          <div className="space-y-2.5">
            {bookings.map((b) => (
              <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{b.model || b.vehicle_type} — {b.owner_name}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {b.pickup_address}</p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5 ltr-num">{b.hours} {t('vp.hoursShort')} · {fmt(b.base_amount_pkr)}{t('vp.baseAmountSuffix')}</p>
                  </div>
                  <span className="shrink-0 font-sans text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: `${STATUS_COLOR[b.status]}1a`, color: STATUS_COLOR[b.status] }}>{t(`vp.hourlyStatus.${b.status}`)}</span>
                </div>

                {b.status === 'declined' && b.decline_reason && (
                  <p className="flex items-center gap-1.5 font-sans text-[12px] mt-2 pt-2 border-t border-dp-outline-variant" style={{ color: '#b3261e' }}><AlertCircle size={12} /> {b.decline_reason}</p>
                )}
                {b.status === 'in_progress' && (
                  <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-dp-outline-variant">
                    <Loader2 size={12} className="animate-spin text-dp-secondary" />
                    <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('vp.tripInProgressHint')} <span className="font-bold text-dp-secondary ltr-num">{fmt(b.distance_km)}km</span></p>
                  </div>
                )}
                {b.status === 'completed' && (
                  <>
                    <div className="mt-2 pt-2 border-t border-dp-outline-variant flex items-center justify-between">
                      <span className="flex items-center gap-1.5 font-sans text-[12px] text-dp-on-surface-variant"><CheckCircle2 size={12} className="text-emerald-600" /> {fmt(b.distance_km)}km {t('vp.travelledLabel')}</span>
                      <span className="font-heading text-[16px] font-bold text-dp-primary ltr-num">{fmt(b.total_amount_pkr ?? b.base_amount_pkr)}</span>
                    </div>
                    <div className="mt-1.5 flex justify-end">
                      <ReportProblemButton refType="hourly_booking" refId={b.id} kindOptions={['hourly_overage', 'no_show']} />
                    </div>
                  </>
                )}
                {(b.status === 'requested' || b.status === 'accepted') && (
                  <button onClick={() => cancelBooking(b.id)} className="flex items-center gap-1.5 font-sans text-[11.5px] font-semibold mt-2 pt-2 border-t border-dp-outline-variant cursor-pointer" style={{ color: '#b3261e' }}>
                    <Ban size={12} /> {t('vp.cancelBookingBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {openVehicle && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setOpenVehicle(null)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-lg sm:rounded-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="h-32 bg-dp-surface-container-low flex items-center justify-center">
              {openVehicle.cover_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={openVehicle.cover_url} alt="" className="w-full h-full object-cover" />
              ) : <Car size={32} className="text-dp-on-surface-variant/40" />}
            </div>
            <div className="p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <p className="font-heading text-[16px] font-bold text-dp-on-surface">{openVehicle.model || openVehicle.vehicle_type}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant">{openVehicle.color}{openVehicle.has_ac ? ` · ${t('mv.hasAcLabel')}` : ''}</p>
                </div>
                <button onClick={() => setOpenVehicle(null)} className="cursor-pointer"><X size={18} /></button>
              </div>

              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.hoursLabel')}</label>
              <div className="flex items-center gap-2 mb-3">
                <button onClick={() => setHours((h) => Math.max(1, h - 1))} className="w-9 h-9 border border-dp-outline-variant rounded-lg cursor-pointer font-sans text-[16px]">−</button>
                <span className="font-heading text-[18px] font-bold w-10 text-center ltr-num">{hours}</span>
                <button onClick={() => setHours((h) => h + 1)} className="w-9 h-9 border border-dp-outline-variant rounded-lg cursor-pointer font-sans text-[16px]">+</button>
              </div>

              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.pickupAddressLabel')}</label>
              <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} placeholder={t('vp.pickupAddressPlaceholder')}
                className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px] resize-none mb-3" />

              <div className="bg-dp-surface-container-low rounded-lg p-3 mb-3">
                <div className="flex items-center justify-between font-sans text-[13px]">
                  <span className="text-dp-on-surface-variant">{fmt(openVehicle.hourly_rate_pkr)} × {hours}{t('vp.hoursShort')}</span>
                  <span className="font-bold text-dp-on-surface ltr-num">{fmt(estimatedTotal)}</span>
                </div>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">
                  {t('vp.includedThenOverage').replace('{km}', fmt(estimatedIncludedKm)).replace('{rate}', fmt(openVehicle.hourly_overage_per_km_pkr ?? 0))}
                </p>
              </div>

              <button onClick={submitRequest} disabled={requesting} className="w-full bg-dp-secondary text-white rounded-lg py-3 font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {requesting ? t('action.saving') : t('vp.sendRequestBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
