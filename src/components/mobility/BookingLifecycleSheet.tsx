'use client'

// One popup for a driver's whole hourly / rental / equipment job —
// accept → PIN start → live in-progress → finish → confirm payment →
// rate — the same shape RideLifecycleSheet already gives ride-dispatch.
// Before this, a driver tapping one of these jobs in the Jobs tab got a
// small accept/decline sheet whose only other option was "View full
// details", which navigated off to that vertical's own page to find the
// same booking again in a long list before they could start or finish
// it. The per-vertical pages stay (they're the listing), and open this
// same sheet for a single booking, so the lifecycle lives in exactly one
// place.
//
// No new backend: the existing per-vertical RPCs (vehicle_*_bookings,
// respond_*, start_* with the 652 PIN, end_*/complete_*, confirm_*) are
// called exactly as the pages already called them.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Loader2, AlertTriangle, CheckCircle2, Ban, Navigation, Phone, Radio, X, Check, Wallet, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { HourlyMeter } from '@/components/mobility/HourlyMeter'
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh'
import { useLiveLocation } from '@/hooks/useLiveLocation'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { ChatButton } from '@/components/portal/ChatButton'
import { TrustStrip, type Trust } from '@/components/shared/TrustBadge'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

export type LifecycleKind = 'hourly' | 'rental' | 'equipment'

// The three verticals' vehicle_*_bookings rows, read through one shape.
interface Row {
  id: string; status: string; status_confirmed: boolean; decline_reason: string | null
  // Real ask, 2026-11-03: "we can't allow the rider to pick up a
  // separate vehicle from the catalog... send the calls to all drivers
  // nearby so everyone gets a chance." Hourly/rental requests now
  // broadcast to every matching vehicle (787) — vehicle_id stays null
  // until someone accepts, so a still-open row has nothing to
  // "decline" (declining would just mean another driver gets it
  // instead, not that the request goes away).
  vehicle_id?: string | null
  requested_at: string; started_at: string | null; ended_at: string | null
  notes: string | null; payment_method: string
  customer_portal_user_id: string; customer_name: string; customer_mobile: string | null; customer_trust?: Trust | null
  // hourly
  hours?: number; pickup_address?: string; pickup_lat?: number | null; pickup_lng?: number | null
  distance_km?: number; included_km?: number; overage_km?: number | null
  // rental
  from_address?: string; from_lat?: number | null; from_lng?: number | null
  to_address?: string; to_lat?: number | null; to_lng?: number | null
  trip_type?: 'one' | 'return'; wait_hours?: number; km?: number
  // equipment
  kind?: string; site_address?: string; site_lat?: number | null; site_lng?: number | null
  material?: string | null; requested_hours?: number | null; rate_pkr?: number; actual_hours?: number | null
  // money
  base_amount_pkr?: number; total_amount_pkr: number | null
  hourly_rate_pkr?: number; overage_per_km_pkr?: number; overtime_minutes?: number; overtime_amount_pkr?: number
  travel_km?: number; travel_charge_pkr?: number
  advance_pct?: number; advance_amount_pkr?: number; advance_status?: string
}

const LIST_RPC: Record<LifecycleKind, string> = { hourly: 'vehicle_hourly_bookings', rental: 'vehicle_rental_bookings', equipment: 'vehicle_equipment_bookings' }
const RESPOND_RPC: Record<LifecycleKind, string> = { hourly: 'respond_hourly_booking', rental: 'respond_rental_booking', equipment: 'respond_equipment_booking' }
const START_RPC: Record<LifecycleKind, string> = { hourly: 'start_hourly_trip', rental: 'start_rental_trip', equipment: 'start_equipment_job' }
const FINISH_RPC: Record<LifecycleKind, string> = { hourly: 'end_hourly_trip', rental: 'end_rental_trip', equipment: 'complete_equipment_job' }
const CONFIRM_RPC: Record<LifecycleKind, string> = { hourly: 'confirm_hourly_booking', rental: 'confirm_rental_booking', equipment: 'confirm_equipment_booking' }
const REF_TYPE = { hourly: 'hourly_booking', rental: 'rental_booking', equipment: 'equipment_booking' } as const

// Requested → Accepted → Underway → Done → Paid; declined/cancelled stop the bar.
const STEPS = ['requested', 'accepted', 'in_progress', 'completed', 'paid'] as const

function fmt(n: number | null | undefined) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function mapsLink(lat: number, lng: number) { return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` }

export function BookingLifecycleSheet({ kind, bookingId, vehicleId, commissionMode, onClose, onChanged, trackLocation = true }: {
  kind: LifecycleKind; bookingId: string; vehicleId: string; commissionMode: string
  onClose: () => void; onChanged?: () => void
  // The hourly page already runs its own trip GPS; it passes false so the
  // same trip isn't pinged twice while the sheet is open on top of it.
  trackLocation?: boolean
}) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()

  const [row, setRow] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [pin, setPin] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const reload = () => {
    supabase.rpc(LIST_RPC[kind], { p_vehicle_id: vehicleId }).then(({ data }) => {
      setRow(((data ?? []) as Row[]).find((b) => b.id === bookingId) ?? null)
      setLoading(false)
    })
  }
  useRealtimeRefresh(`${kind}_bookings`, bookingId, reload)

  const inProgress = row?.status === 'in_progress'

  // Hourly bills by distance actually driven, so while a trip runs the
  // driver's GPS is pinged the same way the hourly page always has.
  const { error: locError, isNative } = useLiveLocation({
    enabled: trackLocation && kind === 'hourly' && inProgress,
    minIntervalMs: 12000,
    backgroundTitle: t('vp.hourlyTrackingNotifTitle'),
    backgroundMessage: t('vp.hourlyTrackingNotifBody'),
    onFix: async ({ lat, lng }) => {
      const { error } = await supabase.rpc('ping_hourly_trip_location', { p_booking_id: bookingId, p_lat: lat, p_lng: lng })
      if (error) reload()
    },
  })

  // Live distance (hourly) and elapsed time (equipment) while underway.
  useEffect(() => {
    if (!inProgress) return
    const tick = setInterval(() => setNow(Date.now()), 30000)
    const poll = kind === 'hourly' ? setInterval(reload, 10000) : null
    return () => { clearInterval(tick); if (poll) clearInterval(poll) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inProgress, kind])

  const run = async (rpc: string, args: Record<string, unknown>, successMsg?: string) => {
    setBusy(true)
    const { error } = await supabase.rpc(rpc, args)
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return false }
    if (successMsg) toast.success(successMsg)
    reload()
    onChanged?.()
    return true
  }

  const respond = async (accept: boolean) => {
    const ok = await run(RESPOND_RPC[kind], { p_booking_id: bookingId, p_accept: accept, p_reason: accept ? null : (declineReason.trim() || null) })
    if (ok) { setDeclining(false); setDeclineReason('') }
  }
  const start = async () => {
    const ok = await run(START_RPC[kind], { p_booking_id: bookingId, p_pin: pin })
    if (ok) setPin('')
  }
  const finish = async () => {
    if (!confirm(kind === 'equipment' ? t('vp.confirmCompleteJob') : t('vp.confirmEndTrip'))) return
    await run(FINISH_RPC[kind], { p_booking_id: bookingId }, kind === 'equipment' ? t('vp.jobCompletedToast') : t('vp.tripEndedToast'))
  }
  const confirmPayment = () => run(CONFIRM_RPC[kind], { p_booking_id: bookingId }, t('vp.paymentConfirmedToast'))

  if (loading || !row) {
    return (
      <MobilityBottomSheet onClose={onClose}>
        {loading
          ? <div className="flex justify-center py-8"><LoadingDots /></div>
          : <p className="text-center py-8 text-[13.5px] text-[#64748b]">{t('p.couldNotLoad')}</p>}
      </MobilityBottomSheet>
    )
  }

  const kindTitle = kind === 'hourly' ? t('vp.hourlyPageTitle') : kind === 'rental' ? t('vp.rentalPageTitle') : t(`vp.${row.kind ?? 'machinery'}PageTitle`)
  // Driver-facing wording — the per-vertical status keys are written from
  // the rider's side ("Waiting for driver"), wrong in the driver's own popup.
  const statusLabel = row.status === 'requested' ? t('vp.newRequestsHeading')
    : row.status === 'accepted' ? t('vp.readyToStartHeading')
    : row.status === 'in_progress' ? t('vp.inProgressHeading')
    : row.status === 'completed' && !row.status_confirmed ? t('vp.awaitingSettlementHeading')
    : kind === 'equipment' ? t(`vp.equipmentStatus.${row.status}`) : t(`vp.hourlyStatus.${row.status}`)
  const stopped = row.status === 'declined' || row.status === 'cancelled'
  const stepIndex = row.status === 'completed' ? (row.status_confirmed ? 4 : 3) : STEPS.indexOf(row.status as typeof STEPS[number])
  const amount = row.total_amount_pkr ?? row.base_amount_pkr ?? row.rate_pkr ?? 0
  // Equipment with a 20% advance (776): the job can't start until the
  // committee confirms it, and the driver collects only the remainder.
  const advancePending = kind === 'equipment' && ['due', 'rejected', 'announced'].includes(row.advance_status ?? '')
  const advanceHeld = kind === 'equipment' && ['confirmed', 'released'].includes(row.advance_status ?? '') ? Number(row.advance_amount_pkr ?? 0) : 0
  const elapsedHours = row.started_at ? (now - new Date(row.started_at).getTime()) / 3600000 : 0

  // Where the driver is headed right now: the pickup/site before starting,
  // the rental's drop-off once underway.
  const pickup = kind === 'hourly' ? { lat: row.pickup_lat, lng: row.pickup_lng, label: row.pickup_address }
    : kind === 'rental' ? { lat: row.from_lat, lng: row.from_lng, label: row.from_address }
    : { lat: row.site_lat, lng: row.site_lng, label: row.site_address }
  const dropoff = kind === 'rental' ? { lat: row.to_lat, lng: row.to_lng, label: row.to_address } : null
  const navTarget = kind === 'rental' && inProgress ? dropoff : pickup
  const pins = [
    ...(pickup.lat != null && pickup.lng != null ? [{ lat: pickup.lat, lng: pickup.lng, label: pickup.label, color: '#dc2626', emoji: '📍' }] : []),
    ...(dropoff && dropoff.lat != null && dropoff.lng != null ? [{ lat: dropoff.lat, lng: dropoff.lng, label: dropoff.label, color: '#166534', emoji: '🏁' }] : []),
  ]

  return (
    <MobilityBottomSheet title={row.customer_name} onClose={onClose} minHeight="60vh">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.05em] px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">{kindTitle}</span>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${stopped ? 'bg-slate-100 text-slate-500' : 'bg-[#F0FDF4] text-[#166534]'}`}>{statusLabel}</span>
        </div>

        {!stopped && (
          <div dir="ltr" className="grid grid-cols-5 gap-1" aria-hidden>
            {STEPS.map((s, i) => (
              <span key={s} className="h-1 rounded-full" style={{ background: i <= stepIndex ? '#16a34a' : '#e5e2d0' }} />
            ))}
          </div>
        )}

        {row.status === 'requested' && <TrustStrip trust={row.customer_trust} />}

        <div className="flex items-center justify-between bg-[#F9F9F6] rounded-xl p-3">
          <div className="min-w-0">
            <p className="font-sans text-[12px] text-[#64748b]">{t('mb.fareForTripLabel')}</p>
            <p className="font-sans text-[11.5px] text-[#64748b] ltr-num mt-0.5">
              {kind === 'hourly' && `${row.hours}h · ${fmt(row.included_km)}km`}
              {kind === 'rental' && `${fmt(row.km)}km${row.trip_type === 'return' ? ` · ↺ ${row.wait_hours}h` : ''}`}
              {kind === 'equipment' && `${row.requested_hours ?? '—'}h × ${fmt(row.rate_pkr)}`}
            </p>
          </div>
          <span className="font-sans text-[20px] font-extrabold text-[#166534] ltr-num shrink-0">₨{fmt(amount)}</span>
        </div>

        <div className="flex flex-col gap-1">
          <p className="font-sans text-[13px] text-[#1e293b] flex items-start gap-1.5"><span className="shrink-0">📍</span> {pickup.label}</p>
          {dropoff && <p className="font-sans text-[13px] text-[#1e293b] flex items-start gap-1.5"><span className="shrink-0">🏁</span> {dropoff.label}</p>}
          {row.material && <p className="font-sans text-[12px] text-[#64748b]">{row.material}</p>}
          {row.notes && <p className="font-sans text-[12px] text-[#64748b] italic">&ldquo;{row.notes}&rdquo;</p>}
        </div>

        {pins.length > 0 && (row.status === 'accepted' || inProgress || row.status === 'requested') && (
          <LeafletMap pins={pins} height={170} className="rounded-xl" />
        )}

        {!stopped && (
          <div className="grid grid-cols-3 gap-2">
            {row.customer_mobile ? (
              <a href={`tel:${row.customer_mobile}`} className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#166534]">
                <Phone size={14} /> {t('vp.callBtn')}
              </a>
            ) : <span />}
            <ChatButton refType={REF_TYPE[kind]} refId={row.id} basePath="/portal/my-vehicle/chat"
              className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer" />
            {navTarget && navTarget.lat != null && navTarget.lng != null ? (
              <a href={mapsLink(navTarget.lat, navTarget.lng)} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#166534]">
                <Navigation size={14} /> {t('cm.navigateBtn')}
              </a>
            ) : <span />}
          </div>
        )}

        {row.status === 'requested' && (kind === 'equipment' || row.vehicle_id) ? (
          declining ? (
            <div className="flex flex-col gap-2 pt-1">
              <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder={t('vp.declineReasonPlaceholder')}
                className="w-full border border-[#e5e2d0] rounded-xl p-2.5 font-sans text-[13px]" />
              <div className="flex items-center gap-2">
                <button onClick={() => setDeclining(false)} className="flex-1 py-2.5 border border-[#e5e2d0] rounded-xl font-sans text-[13px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                <button onClick={() => respond(false)} disabled={busy} className="flex-1 py-2.5 rounded-xl font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#b91c1c]">{t('vp.confirmDeclineBtn')}</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => setDeclining(true)} disabled={busy} className="flex-1 flex items-center justify-center gap-1.5 py-3 border border-[#e5e2d0] rounded-xl font-sans text-[14px] font-semibold cursor-pointer disabled:opacity-50 text-[#b91c1c]">
                <X size={15} /> {t('vp.declineBtn')}
              </button>
              <button onClick={() => respond(true)} disabled={busy} className="flex-1 flex items-center justify-center gap-1.5 py-3 bg-[#166534] text-white rounded-xl font-sans text-[14px] font-bold cursor-pointer disabled:opacity-50">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('vp.acceptBtn')}
              </button>
            </div>
          )
        ) : row.status === 'requested' ? (
          <button onClick={() => respond(true)} disabled={busy} className="w-full flex items-center justify-center gap-1.5 py-3 bg-[#166534] text-white rounded-xl font-sans text-[14px] font-bold cursor-pointer disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('vp.acceptBtn')}
          </button>
        ) : null}

        {row.status === 'accepted' && advancePending && (
          <div className="rounded-xl bg-[#fffbeb] border border-[#fde68a] p-3">
            <p className="font-sans text-[12.5px] font-semibold text-[#92400e]">
              {(row.advance_status === 'announced' ? t('eqa.driverChecking') : t('eqa.driverWaiting'))
                .replace('{pct}', String(row.advance_pct ?? 0)).replace('{amount}', fmt(row.advance_amount_pkr ?? 0))}
            </p>
          </div>
        )}
        {row.status === 'accepted' && !advancePending && (
          <div className="flex flex-col gap-2 pt-3 border-t border-[#f1f5f9]">
            <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{t('vp.pinAskHint')}</p>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              inputMode="numeric" maxLength={4} placeholder="••••" dir="ltr"
              className="w-full text-center tracking-[0.5em] font-bold text-[20px] ltr-num border border-[#e5e2d0] rounded-xl py-2" />
            <button onClick={start} disabled={busy || pin.length !== 4}
              className="w-full py-3 rounded-xl text-[14px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {kind === 'equipment' ? t('vp.startJobBtn') : t('vp.startTripBtn')}
            </button>
          </div>
        )}

        {inProgress && (
          <div className="flex flex-col gap-2 pt-1">
            <div className="flex items-center justify-between bg-[#F0FDF4] rounded-xl px-3 py-2.5">
              <span className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-bold text-[#166534]">
                <Radio size={13} className="animate-pulse" />
                {kind === 'hourly' ? (isNative ? t('vp.trackingActiveHintNative') : t('vp.trackingActiveHint')) : t('cm.rideInProgressLabel')}
              </span>
              <span className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">
                {kind === 'hourly' ? `${fmt(row.distance_km)}km` : kind === 'equipment' ? `${elapsedHours.toFixed(1)}h` : ''}
              </span>
            </div>
            {kind === 'hourly' && row.hours != null && (
              <HourlyMeter row={{ hours: row.hours, started_at: row.started_at, distance_km: row.distance_km ?? 0, included_km: row.included_km, overage_per_km_pkr: row.overage_per_km_pkr, hourly_rate_pkr: row.hourly_rate_pkr, base_amount_pkr: row.base_amount_pkr }} />
            )}
            {advanceHeld > 0 && <p className="font-sans text-[12px] font-semibold text-[#166534] text-center ltr-num">{t('eqa.driverHeld').replace('{amount}', fmt(advanceHeld)).replace('{collect}', fmt(Math.max(0, amount - advanceHeld)))}</p>}
            {kind === 'hourly' && trackLocation && locError && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 flex items-start gap-2">
                <AlertTriangle size={14} className="text-amber-700 shrink-0 mt-0.5" />
                <p className="font-sans text-[12px] text-amber-900">{t('cm.geoErrorMsg')}</p>
              </div>
            )}
            <button onClick={finish} disabled={busy}
              className="w-full py-3 rounded-xl text-[14px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />} {kind === 'equipment' ? t('vp.completeJobBtn') : t('vp.endTripBtn')}
            </button>
          </div>
        )}

        {row.status === 'completed' && (
          <div className="flex flex-col gap-2.5 pt-1">
            <div className="flex flex-col items-center gap-1 py-2 text-center">
              <CheckCircle2 size={26} className="text-[#166534]" />
              <p className="font-sans text-[13.5px] font-bold text-[#166534]">{statusLabel}</p>
              {kind === 'hourly' && (
                <p className="font-sans text-[12px] text-[#64748b] ltr-num">{fmt(row.distance_km)}km {t('vp.travelledLabel')}{row.overage_km ? ` (+${fmt(row.overage_km)}km ${t('vp.overageLabel')})` : ''}</p>
              )}
              {kind === 'hourly' && !!row.overtime_minutes && (
                <p className="font-sans text-[12px] text-[#92400e]">{t('hm.overtime').replace('{min}', String(row.overtime_minutes)).replace('{amount}', fmt(row.overtime_amount_pkr ?? 0))}</p>
              )}
              {kind === 'equipment' && row.actual_hours != null && <p className="font-sans text-[12px] text-[#64748b] ltr-num">{row.actual_hours}h</p>}
              {advanceHeld > 0 && <p className="font-sans text-[12px] font-semibold text-[#166534] ltr-num">{t('eqa.driverHeld').replace('{amount}', fmt(advanceHeld)).replace('{collect}', fmt(Math.max(0, amount - advanceHeld)))}</p>}
            </div>
            {!row.status_confirmed && (commissionMode === 'per_order' ? (
              <button onClick={confirmPayment} disabled={busy}
                className="w-full py-3 rounded-xl text-[14px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50 flex items-center justify-center gap-1.5">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />} {t('vp.confirmPaymentBtn')}
              </button>
            ) : (
              <p className="font-sans text-[12px] text-[#64748b] text-center">{t('vp.awaitingStaffSettlementHint')}</p>
            ))}
            <RateAndReport refType={REF_TYPE[kind]} refId={row.id} againstPartyType="portal_user" againstPartyId={row.customer_portal_user_id} showComplaint={false} />
          </div>
        )}

        {stopped && (
          <div className="flex flex-col items-center gap-1.5 py-6 text-center">
            <Ban size={22} className="text-[#94a3b8]" />
            <p className="font-sans text-[13px] text-[#64748b]">{statusLabel}</p>
            {row.decline_reason && <p className="font-sans text-[12px] text-[#94a3b8] italic">&ldquo;{row.decline_reason}&rdquo;</p>}
          </div>
        )}
      </div>
    </MobilityBottomSheet>
  )
}
