'use client'

// The driver's side of the full accept/decline/start/end lifecycle
// (475/477) — requested bookings get Accept/Decline (decline asks for a
// reason, same as every other reject flow in this app), an accepted one
// gets Start Trip (the moment GPS tracking actually begins — never
// earlier), an in-progress one shows the live distance and Ends Trip,
// and a completed-but-unsettled per_order booking gets a Confirm
// Payment button once the driver's actually been paid in person.
//
// Only one booking for this vehicle can ever be in_progress at a time
// (enforced server-side too, 477) — a vehicle can't physically be on
// two trips, so Start Trip is simply not offered on a second accepted
// booking while one is already running.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Clock3, MapPin, Check, X, Play, Square, Loader2, AlertCircle, CheckCircle2, Wallet, Radio } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { TrustPill, TrustStrip, type Trust } from '@/components/shared/TrustBadge'

interface Vehicle { id: string; owner_name: string; commission_mode: string }
interface Booking {
  id: string; hours: number; status: string; pickup_address: string; decline_reason: string | null
  base_amount_pkr: number; total_amount_pkr: number | null; distance_km: number
  included_km: number; overage_km: number | null; overage_amount_pkr: number | null
  requested_at: string; started_at: string | null; ended_at: string | null; status_confirmed: boolean
  customer_name: string; customer_mobile: string | null; customer_trust: Trust | null
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyHourlyBookingsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')

  const loadBookings = (vehicleId: string) =>
    supabase.rpc('vehicle_hourly_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => setBookings((data ?? []) as Booking[]))

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, commission_mode').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) await loadBookings(data.id)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const activeTrip = bookings.find((b) => b.status === 'in_progress') ?? null

  // GPS only ever runs while a trip is actually in_progress — the toggle
  // is implicit (tied to activeTrip existing), not a separate switch the
  // driver could forget to flip.
  const { error: locError, isNative } = useLiveLocation({
    enabled: !!activeTrip,
    minIntervalMs: 12000,
    backgroundTitle: t('vp.hourlyTrackingNotifTitle'),
    backgroundMessage: t('vp.hourlyTrackingNotifBody'),
    onFix: async ({ lat, lng }) => {
      if (!activeTrip) return
      const { error } = await supabase.rpc('ping_hourly_trip_location', { p_booking_id: activeTrip.id, p_lat: lat, p_lng: lng })
      // Raises once the trip's no longer in_progress (ended elsewhere,
      // e.g. a second device) — refresh so the UI catches up instead of
      // silently retrying a ping that will never succeed.
      if (error && vehicle) loadBookings(vehicle.id)
    },
  })

  // Distance ticking up live while a trip runs — re-poll only then.
  useEffect(() => {
    if (!vehicle || !activeTrip) return
    const id = setInterval(() => loadBookings(vehicle.id), 10000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, activeTrip?.id])

  const respond = async (bookingId: string, accept: boolean, reason?: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('respond_hourly_booking', { p_booking_id: bookingId, p_accept: accept, p_reason: reason ?? null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setDecliningId(null); setDeclineReason('')
    loadBookings(vehicle.id)
  }

  const startTrip = async (bookingId: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('start_hourly_trip', { p_booking_id: bookingId })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    loadBookings(vehicle.id)
  }

  const endTrip = async (bookingId: string) => {
    if (!vehicle || !confirm(t('vp.confirmEndTrip'))) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('end_hourly_trip', { p_booking_id: bookingId })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.tripEndedToast'))
    loadBookings(vehicle.id)
  }

  const confirmPayment = async (bookingId: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('confirm_hourly_booking', { p_booking_id: bookingId })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.paymentConfirmedToast'))
    loadBookings(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('cm.noVehicleLinked')}</div>

  const requested = bookings.filter((b) => b.status === 'requested')
  const upcoming = bookings.filter((b) => b.status === 'accepted')
  const inProgress = bookings.filter((b) => b.status === 'in_progress')
  const awaitingSettlement = bookings.filter((b) => b.status === 'completed' && !b.status_confirmed)
  const history = bookings.filter((b) => (b.status === 'completed' && b.status_confirmed) || b.status === 'declined' || b.status === 'cancelled')

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/my-vehicle" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {vehicle.owner_name}
      </Link>
      <h1 className="font-heading text-[24px] font-bold text-dp-primary flex items-center gap-2 mb-1"><Clock3 size={22} /> {t('vp.myHourlyBookingsHeading')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('vp.myHourlyBookingsSubtitle')}</p>

      {activeTrip && locError && (
        <div className="flex items-center gap-1.5 border rounded-lg p-2.5 mb-3" style={{ borderColor: '#f4a68f', background: '#fce3dc' }}>
          <AlertCircle size={13} style={{ color: '#ae1800' }} className="shrink-0" />
          <p className="font-sans text-[11.5px]" style={{ color: '#ae1800' }}>{locError}</p>
        </div>
      )}

      {requested.length > 0 && (
        <Section title={t('vp.newRequestsHeading')}>
          {requested.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <TrustStrip trust={b.customer_trust} />
              <BookingHeader b={b} />
              {decliningId === b.id ? (
                <div className="mt-2 pt-2 border-t border-dp-outline-variant">
                  <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder={t('vp.declineReasonPlaceholder')}
                    className="w-full border border-dp-outline-variant rounded-lg p-2 font-sans text-[12.5px] mb-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setDecliningId(null)} className="flex-1 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                    <button onClick={() => respond(b.id, false, declineReason.trim() || undefined)} disabled={busyId === b.id}
                      className="flex-1 py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer text-white disabled:opacity-50" style={{ background: '#b3261e' }}>{t('vp.confirmDeclineBtn')}</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-dp-outline-variant">
                  <button onClick={() => setDecliningId(b.id)} disabled={busyId === b.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    <X size={13} /> {t('vp.declineBtn')}
                  </button>
                  <button onClick={() => respond(b.id, true)} disabled={busyId === b.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50 hover:bg-dp-primary transition-all">
                    {busyId === b.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t('vp.acceptBtn')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {inProgress.length > 0 && (
        <Section title={t('vp.inProgressHeading')}>
          {inProgress.map((b) => (
            <div key={b.id} className="bg-white border-2 rounded-lg p-3.5" style={{ borderColor: '#0f7a4d' }}>
              <BookingHeader b={b} />
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-dp-outline-variant">
                <span className="flex items-center gap-1.5 font-sans text-[12px]" style={{ color: '#0f7a4d' }}>
                  <Radio size={12} className="animate-pulse" /> {isNative ? t('vp.trackingActiveHintNative') : t('vp.trackingActiveHint')}
                </span>
                <span className="font-heading text-[15px] font-bold ltr-num" style={{ color: '#0f7a4d' }}>{fmt(b.distance_km)}km</span>
              </div>
              <button onClick={() => endTrip(b.id)} disabled={busyId === b.id} className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50" style={{ background: '#0f7a4d' }}>
                {busyId === b.id ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />} {t('vp.endTripBtn')}
              </button>
            </div>
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title={t('vp.readyToStartHeading')}>
          {upcoming.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <BookingHeader b={b} />
              <button onClick={() => startTrip(b.id)} disabled={busyId === b.id || !!activeTrip}
                title={activeTrip ? t('vp.anotherTripActiveHint') : ''}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 pt-2 border-t border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50" style={{ background: '#201e1d' }}>
                {busyId === b.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />} {t('vp.startTripBtn')}
              </button>
              {activeTrip && <p className="font-sans text-[10.5px] text-dp-on-surface-variant mt-1 text-center">{t('vp.anotherTripActiveHint')}</p>}
            </div>
          ))}
        </Section>
      )}

      {awaitingSettlement.length > 0 && (
        <Section title={t('vp.awaitingSettlementHeading')}>
          {awaitingSettlement.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <BookingHeader b={b} />
              <div className="mt-2 pt-2 border-t border-dp-outline-variant flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-sans text-[12px] text-dp-on-surface-variant"><CheckCircle2 size={12} className="text-emerald-600" /> {fmt(b.distance_km)}km {t('vp.travelledLabel')}{b.overage_km ? ` (+${fmt(b.overage_km)}km ${t('vp.overageLabel')})` : ''}</span>
                <span className="font-heading text-[16px] font-bold text-dp-primary ltr-num">{fmt(b.total_amount_pkr ?? b.base_amount_pkr)}</span>
              </div>
              {vehicle.commission_mode === 'per_order' ? (
                <button onClick={() => confirmPayment(b.id)} disabled={busyId === b.id} className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50 hover:bg-dp-primary transition-all">
                  {busyId === b.id ? <Loader2 size={13} className="animate-spin" /> : <Wallet size={13} />} {t('vp.confirmPaymentBtn')}
                </button>
              ) : (
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-2 text-center">{t('vp.awaitingStaffSettlementHint')}</p>
              )}
            </div>
          ))}
        </Section>
      )}

      {requested.length === 0 && upcoming.length === 0 && inProgress.length === 0 && awaitingSettlement.length === 0 && history.length === 0 && (
        <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('vp.noHourlyBookingsYetHint')}</p>
      )}

      {history.length > 0 && (
        <Section title={t('vp.historyHeading')}>
          {history.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3 opacity-70">
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface truncate">{b.customer_name}</p>
                <span className="font-sans text-[10px] font-bold" style={{ color: b.status === 'declined' ? '#b3261e' : b.status === 'cancelled' ? '#6b6560' : '#0f7a4d' }}>{t(`vp.hourlyStatus.${b.status}`)}</span>
              </div>
              {b.status === 'completed' && <p className="font-sans text-[11px] text-dp-on-surface-variant ltr-num mt-0.5">{fmt(b.total_amount_pkr ?? b.base_amount_pkr)} · {fmt(b.distance_km)}km</p>}
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-2">{title}</p>
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}

function BookingHeader({ b }: { b: Booking }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5">{b.customer_name} <TrustPill trust={b.customer_trust} /></p>
        {b.customer_mobile && <p className="font-sans text-[11.5px] text-dp-on-surface-variant ltr-num">{b.customer_mobile}</p>}
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {b.pickup_address}</p>
      </div>
      <div className="text-end shrink-0">
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant ltr-num">{b.hours}h</p>
        <p className="font-heading text-[15px] font-bold text-dp-secondary ltr-num">{fmt(b.base_amount_pkr)}</p>
      </div>
    </div>
  )
}
