'use client'

// The driver's side of the point-to-point rental accept/decline/start/
// end lifecycle (653): requested bookings get Accept/Decline, an
// accepted one gets Start Trip (PIN-gated — the rider shows a 4-digit
// code), an in-progress one gets End Trip, and a completed per_order
// booking gets a Confirm Payment button. No live GPS here: unlike
// hourly, both ends of the trip are fixed at request time, so there's
// no distance to track live — modeled on my-vehicle/hourly/page.tsx
// minus that piece.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Navigation, MapPin, Check, X, Play, Square, Loader2, AlertCircle, CheckCircle2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { TrustPill, TrustStrip, type Trust } from '@/components/shared/TrustBadge'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { PinStartModal } from '@/components/portal/PinStartModal'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Vehicle { id: string; owner_name: string; commission_mode: string }
interface Booking {
  id: string; from_address: string; from_lat: number | null; from_lng: number | null
  to_address: string; to_lat: number | null; to_lng: number | null
  trip_type: 'one' | 'return'; wait_hours: number; km: number; status: string; decline_reason: string | null
  base_amount_pkr: number; trip_amount_pkr: number; wait_amount_pkr: number; total_amount_pkr: number; status_confirmed: boolean
  requested_at: string; started_at: string | null; ended_at: string | null
  customer_portal_user_id: string; customer_name: string; customer_mobile: string | null; customer_trust: Trust | null
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyRentalBookingsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [pinBookingId, setPinBookingId] = useState<string | null>(null)

  const loadBookings = (vehicleId: string) =>
    supabase.rpc('vehicle_rental_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => setBookings((data ?? []) as Booking[]))

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

  useEffect(() => {
    if (!vehicle || !bookings.some((b) => ['requested', 'accepted', 'in_progress'].includes(b.status))) return
    const id = setInterval(() => loadBookings(vehicle.id), 10000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, bookings])

  const respond = async (bookingId: string, accept: boolean, reason?: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('respond_rental_booking', { p_booking_id: bookingId, p_accept: accept, p_reason: reason ?? null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setDecliningId(null); setDeclineReason('')
    loadBookings(vehicle.id)
  }

  const startTrip = async (bookingId: string, pin: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('start_rental_trip', { p_booking_id: bookingId, p_pin: pin })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setPinBookingId(null)
    loadBookings(vehicle.id)
  }

  const endTrip = async (bookingId: string) => {
    if (!vehicle || !confirm(t('vp.confirmEndTrip'))) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('end_rental_trip', { p_booking_id: bookingId })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.tripEndedToast'))
    loadBookings(vehicle.id)
  }

  const confirmPayment = async (bookingId: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('confirm_rental_booking', { p_booking_id: bookingId })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.paymentConfirmedToast'))
    loadBookings(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('cm.noVehicleLinked')}</div>

  const requested = bookings.filter((b) => b.status === 'requested')
  const upcoming = bookings.filter((b) => b.status === 'accepted')
  const inProgress = bookings.filter((b) => b.status === 'in_progress')
  const awaitingSettlement = bookings.filter((b) => b.status === 'completed' && !b.status_confirmed)
  const history = bookings.filter((b) => (b.status === 'completed' && b.status_confirmed) || b.status === 'declined' || b.status === 'cancelled')

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Navigation size={19} /> {t('vp.myRentalBookingsHeading')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.myRentalBookingsSubtitle')}</p>
      </div>

      {requested.length > 0 && (
        <Section title={t('vp.newRequestsHeading')}>
          {requested.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <TrustStrip trust={b.customer_trust} />
              <BookingHeader b={b} />
              {decliningId === b.id ? (
                <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                  <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder={t('vp.declineReasonPlaceholder')}
                    className="w-full border border-[#e5e2d0] rounded-xl p-2 font-sans text-[12.5px] mb-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setDecliningId(null)} className="flex-1 py-2 border border-[#e5e2d0] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                    <button onClick={() => respond(b.id, false, declineReason.trim() || undefined)} disabled={busyId === b.id}
                      className="flex-1 py-2 rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#b91c1c]">{t('vp.confirmDeclineBtn')}</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
                  <button onClick={() => setDecliningId(b.id)} disabled={busyId === b.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-[#e5e2d0] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    <X size={13} /> {t('vp.declineBtn')}
                  </button>
                  <button onClick={() => respond(b.id, true)} disabled={busyId === b.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-[#166534] text-white rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
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
            <div key={b.id} className="bg-white border-2 border-[#166534] rounded-2xl p-3.5">
              <BookingHeader b={b} />
              <button onClick={() => endTrip(b.id)} disabled={busyId === b.id} className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 pt-2 border-t border-[#f1f5f9] rounded-xl font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#166534]">
                {busyId === b.id ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />} {t('vp.endTripBtn')}
              </button>
            </div>
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title={t('vp.readyToStartHeading')}>
          {upcoming.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <BookingHeader b={b} />
              <button onClick={() => setPinBookingId(b.id)} disabled={busyId === b.id || !!activeTrip}
                title={activeTrip ? t('vp.anotherTripActiveHint') : ''}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 pt-2 border-t border-[#f1f5f9] rounded-xl font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#005A36]">
                {busyId === b.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />} {t('vp.startTripBtn')}
              </button>
              {activeTrip && <p className="font-sans text-[10.5px] text-[#64748b] mt-1 text-center">{t('vp.anotherTripActiveHint')}</p>}
            </div>
          ))}
        </Section>
      )}

      {awaitingSettlement.length > 0 && (
        <Section title={t('vp.awaitingSettlementHeading')}>
          {awaitingSettlement.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <BookingHeader b={b} />
              <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-sans text-[12px] text-[#64748b]"><CheckCircle2 size={12} className="text-emerald-600" /> {fmt(b.km)}km</span>
                <span className="font-bold text-[16px] text-[#005A36] ltr-num">{fmt(b.total_amount_pkr)}</span>
              </div>
              {vehicle.commission_mode === 'per_order' ? (
                <button onClick={() => confirmPayment(b.id)} disabled={busyId === b.id} className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 bg-[#166534] text-white rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                  {busyId === b.id ? <Loader2 size={13} className="animate-spin" /> : <Wallet size={13} />} {t('vp.confirmPaymentBtn')}
                </button>
              ) : (
                <p className="font-sans text-[11px] text-[#64748b] mt-2 text-center">{t('vp.awaitingStaffSettlementHint')}</p>
              )}
              <div className="mt-2">
                <RateAndReport refType="rental_booking" refId={b.id} againstPartyType="portal_user" againstPartyId={b.customer_portal_user_id} showComplaint={false} />
              </div>
            </div>
          ))}
        </Section>
      )}

      {requested.length === 0 && upcoming.length === 0 && inProgress.length === 0 && awaitingSettlement.length === 0 && history.length === 0 && (
        <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noRentalBookingsYetHint')}</p>
      )}

      {history.length > 0 && (
        <Section title={t('vp.historyHeading')}>
          {history.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 opacity-70">
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{b.customer_name}</p>
                <span className="font-sans text-[10px] font-bold" style={{ color: b.status === 'declined' ? '#b91c1c' : b.status === 'cancelled' ? '#64748b' : '#166534' }}>{t(`vp.hourlyStatus.${b.status}`)}</span>
              </div>
              {b.status === 'completed' && <p className="font-sans text-[11px] text-[#64748b] ltr-num mt-0.5">{fmt(b.total_amount_pkr)} · {fmt(b.km)}km</p>}
            </div>
          ))}
        </Section>
      )}

      {pinBookingId && (
        <PinStartModal
          busy={busyId === pinBookingId}
          onClose={() => setPinBookingId(null)}
          onConfirm={(pin) => startTrip(pinBookingId, pin)}
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2">{title}</p>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

function BookingHeader({ b }: { b: Booking }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-sans text-[14px] font-semibold text-[#1e293b] flex items-center gap-1.5">{b.customer_name} <TrustPill trust={b.customer_trust} /></p>
          {b.customer_mobile && <a href={`tel:${b.customer_mobile}`} className="font-sans text-[11.5px] text-[#166534] font-semibold ltr-num underline">{b.customer_mobile}</a>}
          <p className="font-sans text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5 text-[#166534]" /> {b.from_address}</p>
          <p className="font-sans text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5 text-[#b91c1c]" /> {b.to_address}</p>
        </div>
        <div className="text-end shrink-0">
          <p className="font-sans text-[11.5px] text-[#64748b] ltr-num">{fmt(b.km)}km</p>
          <p className="font-bold text-[15px] text-[#166534] ltr-num">{fmt(b.total_amount_pkr)}</p>
        </div>
      </div>
      {b.from_lat != null && b.from_lng != null && b.to_lat != null && b.to_lng != null && (
        <LeafletMap pins={[{ lat: b.from_lat, lng: b.from_lng, color: '#166534' }, { lat: b.to_lat, lng: b.to_lng, color: '#b91c1c' }]} height={120} className="rounded-xl mt-2" />
      )}
    </div>
  )
}
