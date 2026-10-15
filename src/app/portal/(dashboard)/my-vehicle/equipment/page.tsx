'use client'

// The driver/owner side of the machinery/tractor/loader accept/decline/
// start/complete/settle lifecycle (646/648) — one combined screen for
// all 3 verticals (not 3 tabs) since most vehicles only ever offer one
// or two of them. Modeled directly on my-vehicle/hourly/page.tsx's own
// lifecycle screen, with no GPS tracking: these are stationary/on-site
// jobs (dig a foundation, plough a field, haul a load), not a moving
// trip, so the only thing "in progress" shows is elapsed time, not a
// live map.
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Jobs tab's equipment rows rather than its own nav tab.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Wrench, MapPin, Check, X, Play, Square, Loader2, AlertCircle, CheckCircle2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { PinStartModal } from '@/components/portal/PinStartModal'
import { ChatButton } from '@/components/portal/ChatButton'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Vehicle { id: string; owner_name: string; commission_mode: string }
interface Booking {
  id: string; kind: string; service_key: string | null; site_address: string; site_lat: number | null; site_lng: number | null; material: string | null
  requested_hours: number | null; status: string; decline_reason: string | null
  rate_pkr: number; mobilization_fee_pkr: number; actual_hours: number | null; total_amount_pkr: number | null
  requested_at: string; started_at: string | null; ended_at: string | null; status_confirmed: boolean
  notes: string | null; payment_method: string
  customer_portal_user_id: string; customer_name: string; customer_mobile: string | null
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyEquipmentBookingsPage() {
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
    supabase.rpc('vehicle_equipment_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => setBookings((data ?? []) as Booking[]))

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, commission_mode').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) await loadBookings(data.id)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const activeJob = bookings.find((b) => b.status === 'in_progress') ?? null

  // Elapsed time on the active job, ticking every second — no GPS poll
  // needed here, just a clock, so a plain interval is enough.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!activeJob) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [activeJob])
  const elapsedHours = activeJob?.started_at ? (now - new Date(activeJob.started_at).getTime()) / 3600000 : 0

  const respond = async (bookingId: string, accept: boolean, reason?: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('respond_equipment_booking', { p_booking_id: bookingId, p_accept: accept, p_reason: reason ?? null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setDecliningId(null); setDeclineReason('')
    loadBookings(vehicle.id)
  }

  const startJob = async (bookingId: string, pin: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('start_equipment_job', { p_booking_id: bookingId, p_pin: pin })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setPinBookingId(null)
    loadBookings(vehicle.id)
  }

  const completeJob = async (bookingId: string) => {
    if (!vehicle || !confirm(t('vp.confirmCompleteJob'))) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('complete_equipment_job', { p_booking_id: bookingId })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.jobCompletedToast'))
    loadBookings(vehicle.id)
  }

  const confirmPayment = async (bookingId: string) => {
    if (!vehicle) return
    setBusyId(bookingId)
    const { error } = await supabase.rpc('confirm_equipment_booking', { p_booking_id: bookingId })
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

  const label = (b: Booking) => b.requested_hours != null ? `${b.requested_hours}${t('vp.hoursShort')} · ${fmt(b.rate_pkr)}/${t('vp.hoursShort')}` : fmt(b.rate_pkr)

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Wrench size={19} /> {t('vp.myEquipmentBookingsHeading')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.myEquipmentBookingsSubtitle')}</p>
      </div>

      {requested.length > 0 && (
        <Section title={t('vp.newRequestsHeading')}>
          {requested.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <BookingHeader b={b} label={label(b)} />
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
              <BookingHeader b={b} label={label(b)} />
              {b.id === activeJob?.id && b.requested_hours != null && (
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#f1f5f9]">
                  <span className="flex items-center gap-1.5 font-sans text-[12px] text-[#166534]"><Loader2 size={12} className="animate-spin" /> {t('vp.jobInProgressHint')}</span>
                  <span className="font-bold text-[15px] text-[#166534] ltr-num">{elapsedHours.toFixed(1)}{t('vp.hoursShort')}</span>
                </div>
              )}
              <button onClick={() => completeJob(b.id)} disabled={busyId === b.id} className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 rounded-xl font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#166534]">
                {busyId === b.id ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />} {t('vp.completeJobBtn')}
              </button>
            </div>
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title={t('vp.readyToStartHeading')}>
          {upcoming.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <BookingHeader b={b} label={label(b)} />
              <button onClick={() => setPinBookingId(b.id)} disabled={busyId === b.id || !!activeJob}
                title={activeJob ? t('vp.anotherJobActiveHint') : ''}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 pt-2 border-t border-[#f1f5f9] rounded-xl font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#005A36]">
                {busyId === b.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />} {t('vp.startJobBtn')}
              </button>
              {activeJob && <p className="font-sans text-[10.5px] text-[#64748b] mt-1 text-center">{t('vp.anotherJobActiveHint')}</p>}
            </div>
          ))}
        </Section>
      )}

      {awaitingSettlement.length > 0 && (
        <Section title={t('vp.awaitingSettlementHeading')}>
          {awaitingSettlement.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <BookingHeader b={b} label={label(b)} />
              <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-sans text-[12px] text-[#64748b]"><CheckCircle2 size={12} className="text-emerald-600" /> {b.actual_hours != null ? `${t('vp.actualHoursLabel')}: ${fmt(b.actual_hours)}${t('vp.hoursShort')}` : t('vp.equipmentStatus.completed')}</span>
                <span className="font-bold text-[16px] text-[#005A36] ltr-num">{fmt(b.total_amount_pkr ?? b.rate_pkr)}</span>
              </div>
              {vehicle.commission_mode === 'per_order' ? (
                <button onClick={() => confirmPayment(b.id)} disabled={busyId === b.id} className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 bg-[#166534] text-white rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                  {busyId === b.id ? <Loader2 size={13} className="animate-spin" /> : <Wallet size={13} />} {t('vp.confirmPaymentBtn')}
                </button>
              ) : (
                <p className="font-sans text-[11px] text-[#64748b] mt-2 text-center">{t('vp.awaitingStaffSettlementHint')}</p>
              )}
              <div className="mt-2">
                <RateAndReport refType="equipment_booking" refId={b.id} againstPartyType="portal_user" againstPartyId={b.customer_portal_user_id} showComplaint={false} />
              </div>
            </div>
          ))}
        </Section>
      )}

      {requested.length === 0 && upcoming.length === 0 && inProgress.length === 0 && awaitingSettlement.length === 0 && history.length === 0 && (
        <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noEquipmentBookingsYetHint')}</p>
      )}

      {history.length > 0 && (
        <Section title={t('vp.historyHeading')}>
          {history.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 opacity-70">
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{b.customer_name}</p>
                <span className="font-sans text-[10px] font-bold" style={{ color: b.status === 'declined' ? '#b91c1c' : b.status === 'cancelled' ? '#64748b' : '#166534' }}>{t(`vp.equipmentStatus.${b.status}`)}</span>
              </div>
              {b.status === 'declined' && b.decline_reason && (
                <p className="flex items-center gap-1.5 font-sans text-[11px] mt-1 text-[#b91c1c]"><AlertCircle size={11} /> {b.decline_reason}</p>
              )}
              {b.status === 'completed' && <p className="font-sans text-[11px] text-[#64748b] ltr-num mt-0.5">{fmt(b.total_amount_pkr ?? b.rate_pkr)}</p>}
            </div>
          ))}
        </Section>
      )}

      {pinBookingId && (
        <PinStartModal
          busy={busyId === pinBookingId}
          onClose={() => setPinBookingId(null)}
          onConfirm={(pin) => startJob(pinBookingId, pin)}
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

function BookingHeader({ b, label }: { b: Booking; label: string }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-sans text-[14px] font-semibold text-[#1e293b]">{b.customer_name}</p>
          <span className="flex items-center gap-3">
            {b.customer_mobile && <a href={`tel:${b.customer_mobile}`} className="font-sans text-[11.5px] text-[#166534] font-semibold ltr-num underline">{b.customer_mobile}</a>}
            <ChatButton refType="equipment_booking" refId={b.id} basePath="/portal/my-vehicle/chat" className="inline-flex items-center gap-1 font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer" />
          </span>
          <p className="font-sans text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {b.site_address}</p>
          {b.notes && <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5 italic">&ldquo;{b.notes}&rdquo;</p>}
        </div>
        <div className="text-end shrink-0">
          <p className="font-sans text-[11.5px] text-[#64748b] ltr-num">{label}</p>
        </div>
      </div>
      {b.site_lat != null && b.site_lng != null && (
        <LeafletMap pins={[{ lat: b.site_lat, lng: b.site_lng, color: '#166534' }]} height={120} className="rounded-xl mt-2" />
      )}
    </div>
  )
}
