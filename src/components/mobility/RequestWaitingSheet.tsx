'use client'

// Real ask, 2026-10-30: "I want to book a rental ride... when I send
// that, an alert appeared 'request sent, waiting for driver' and that
// alert disappeared. Is this how modern apps send requests? It should
// wait on the same popup until the driver accepts." Hourly, rental,
// equipment and route/adda seat bookings all went out with a toast and
// closed the sheet, leaving the rider to go and dig the result out of
// "My bookings" themselves. Ride-dispatch already had the right shape
// (it stays on a "waiting for a driver" sheet until someone accepts);
// this is that same moment for every booking that goes to ONE chosen
// driver.
//
// It holds the screen until the driver answers — no tap-outside close
// while waiting, only an explicit cancel — and flips live to accepted
// (PIN + call the driver), declined (with the driver's reason) or
// cancelled. Status comes from the same rider RPCs/table the "My
// bookings" lists already read, kept live by useRealtimeRefresh (all
// four tables are in the realtime publication since 726) with a short
// poll underneath.

import { useCallback, useEffect, useState } from 'react'
import { Car, Clock, Tractor, Bus, Check, X as XIcon, Phone, Loader2, CircleSlash, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh'

export type WaitingKind = 'hourly' | 'rental' | 'equipment' | 'seat'

export interface WaitingSummary {
  vehicleLabel: string
  driverName?: string | null
  from?: string | null
  to?: string | null
  amount?: number | null
  facts?: string[]
}

type Phase = 'waiting' | 'accepted' | 'declined' | 'cancelled'
interface Live { phase: Phase; reason: string | null; pin: string | null; driverName: string | null; driverMobile: string | null; advanceDue?: number; advancePct?: number }

const TABLE: Record<WaitingKind, string> = { hourly: 'hourly_bookings', rental: 'rental_bookings', equipment: 'equipment_bookings', seat: 'ride_bookings' }
const ICON: Record<WaitingKind, LucideIcon> = { hourly: Clock, rental: Car, equipment: Tractor, seat: Bus }

function phaseOf(kind: WaitingKind, status: string): Phase {
  if (kind === 'seat') {
    if (status === 'announced') return 'waiting'
    if (status === 'rejected') return 'declined'
    if (status === 'cancelled') return 'cancelled'
    return 'accepted'
  }
  if (status === 'requested') return 'waiting'
  if (status === 'declined') return 'declined'
  if (status === 'cancelled') return 'cancelled'
  return 'accepted'
}

async function loadLive(kind: WaitingKind, id: string): Promise<Live | null> {
  const supabase = createClient()
  if (kind === 'seat') {
    const { data } = await supabase.from('ride_bookings').select('status, cancellation_reason').eq('id', id).maybeSingle()
    if (!data) return null
    return { phase: phaseOf(kind, data.status), reason: data.cancellation_reason ?? null, pin: null, driverName: null, driverMobile: null }
  }
  const rpc = kind === 'hourly' ? 'my_hourly_bookings' : kind === 'rental' ? 'my_rental_bookings' : 'my_equipment_bookings'
  const { data } = await supabase.rpc(rpc)
  const b = ((data ?? []) as { id: string; status: string; decline_reason: string | null; pin: string | null; owner_name: string | null; owner_mobile: string | null; advance_status?: string; advance_amount_pkr?: number; advance_pct?: number }[]).find((r) => r.id === id)
  if (!b) return null
  // An equipment job with an advance still to pay isn't confirmed yet —
  // its PIN only matters once the committee has the advance (776).
  const advanceDue = b.advance_status === 'due' || b.advance_status === 'rejected' || b.advance_status === 'announced'
  return {
    phase: phaseOf(kind, b.status), reason: b.decline_reason, pin: advanceDue ? null : b.pin, driverName: b.owner_name, driverMobile: b.owner_mobile,
    advanceDue: advanceDue ? Number(b.advance_amount_pkr ?? 0) : undefined, advancePct: b.advance_pct,
  }
}

async function cancelRequest(kind: WaitingKind, id: string, reason: string) {
  const supabase = createClient()
  if (kind === 'hourly') return supabase.rpc('cancel_hourly_booking', { p_booking_id: id })
  if (kind === 'rental') return supabase.rpc('cancel_rental_booking', { p_booking_id: id })
  if (kind === 'equipment') return supabase.rpc('cancel_equipment_booking', { p_booking_id: id })
  return supabase.rpc('cancel_ride_booking', { p_booking_id: id, p_reason: reason })
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

interface Props {
  kind: WaitingKind
  bookingId: string
  summary: WaitingSummary
  // Opened at (for the elapsed timer) — the booking's own requested_at
  // when reopening an existing request after a page reload.
  since?: string | null
  onClose: () => void
  onViewBooking: () => void
  // Real ask, 2026-11-03: "when the oneway searching will be finished
  // for a certain time period... pause the oneway button and ask the
  // rider to choose ride sharing or two-way instead" — a one-way Rental
  // request specifically has few willing drivers (deadhead return with
  // no built-in compensation), so after a few minutes with no driver,
  // offer a way out instead of leaving the rider stuck watching a spinner.
  // Only Rental's one-way flow passes this; every other booking kind
  // behaves exactly as before.
  oneWayFallback?: { afterSeconds: number; onSwitchShared: () => void; onSwitchReturn: () => void | Promise<void> }
}

export function RequestWaitingSheet({ kind, bookingId, summary, since, onClose, onViewBooking, oneWayFallback }: Props) {
  const { t, isUrdu } = useLocale()
  const [live, setLive] = useState<Live | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [startedAt] = useState(() => (since ? new Date(since).getTime() : Date.now()))
  const [now, setNow] = useState(() => Date.now())

  const reload = useCallback(() => {
    loadLive(kind, bookingId).then((l) => { if (l) setLive(l) })
  }, [kind, bookingId])
  const phase: Phase = live?.phase ?? 'waiting'
  useRealtimeRefresh(TABLE[kind], phase === 'waiting' ? bookingId : null, reload, 5000)

  useEffect(() => {
    if (phase !== 'waiting') return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [phase])

  // A buzz the moment the driver answers, same as the driver side gets
  // when a request lands.
  useEffect(() => {
    if (phase !== 'waiting' && typeof navigator !== 'undefined') navigator.vibrate?.(phase === 'accepted' ? [120, 60, 120] : 200)
  }, [phase])

  const doCancel = async () => {
    if (!confirmCancel) { setConfirmCancel(true); return }
    setCancelling(true)
    const { error } = await cancelRequest(kind, bookingId, t('mp.riderCancelledReason'))
    setCancelling(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); setConfirmCancel(false); return }
    toast.success(t('rw.cancelledToast'))
    onClose()
  }

  const Icon = ICON[kind]
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const elapsedText = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const driver = live?.driverName ?? summary.driverName ?? null

  return (
    <div className="fixed inset-0 bg-black/55 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200"
      onClick={phase === 'waiting' ? undefined : onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-[400px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[94vh] overflow-y-auto shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 duration-300">

        {/* Status hero */}
        <div className="relative px-5 pt-8 pb-7 flex flex-col items-center text-center text-white transition-colors duration-500"
          style={{ backgroundImage: phase === 'accepted' ? 'linear-gradient(160deg,#065f46,#16a34a)' : phase === 'declined' || phase === 'cancelled' ? 'linear-gradient(160deg,#475569,#64748b)' : 'linear-gradient(160deg,#0f3d2e,#166534)' }}>
          <div className="relative w-28 h-28 flex items-center justify-center">
            {phase === 'waiting' && (
              <>
                <span className="absolute inset-0 rounded-full border-2 border-white/40 animate-ping [animation-duration:2.2s]" />
                <span className="absolute inset-3 rounded-full border-2 border-white/30 animate-ping [animation-duration:2.2s] [animation-delay:.7s]" />
                <span className="absolute inset-6 rounded-full bg-white/10" />
              </>
            )}
            <div className={`relative w-16 h-16 rounded-full flex items-center justify-center shadow-lg ${phase === 'waiting' ? 'bg-white text-[#166534]' : 'bg-white/95'} ${phase !== 'waiting' ? 'animate-in zoom-in-50 duration-300' : ''}`}>
              {phase === 'waiting' && <Icon size={30} />}
              {phase === 'accepted' && <Check size={34} strokeWidth={3} className="text-[#16a34a]" />}
              {phase === 'declined' && <XIcon size={32} strokeWidth={3} className="text-[#b91c1c]" />}
              {phase === 'cancelled' && <CircleSlash size={30} className="text-[#475569]" />}
            </div>
          </div>
          <p className="font-sans text-[19px] font-extrabold mt-3 leading-tight">
            {phase === 'waiting' ? t('rw.waitingHeading') : phase === 'accepted' ? t('rw.acceptedHeading') : phase === 'declined' ? t('rw.declinedHeading') : t('rw.cancelledHeading')}
          </p>
          <p className="font-sans text-[13px] text-white/85 mt-1 max-w-[300px]">
            {phase === 'waiting'
              ? (driver ? t('rw.waitingHintNamed').replace('{driver}', driver) : t('rw.waitingHint'))
              : phase === 'accepted' ? (driver ? t('rw.acceptedHintNamed').replace('{driver}', driver) : t('rw.acceptedHint'))
              : phase === 'declined' ? t('rw.declinedHint') : t('rw.cancelledHint')}
          </p>
          {phase === 'waiting' && (
            <span className="mt-3 inline-flex items-center gap-1.5 bg-white/15 px-3 py-1 rounded-full font-sans text-[12px] font-semibold">
              <Loader2 size={13} className="animate-spin" /> <span className="ltr-num">{elapsedText}</span>
            </span>
          )}
        </div>

        <div className="px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-3.5">
          {phase === 'declined' && live?.reason && (
            <div className="rounded-2xl bg-[#fef2f2] border border-[#fecaca] p-3">
              <p className="font-sans text-[11px] font-semibold text-[#b91c1c]">{t('rw.driverSaidLabel')}</p>
              <p className="font-sans text-[13.5px] text-[#7f1d1d]"><bdi>{live.reason}</bdi></p>
            </div>
          )}

          {phase === 'accepted' && live?.advanceDue != null && (
            <div className="rounded-2xl bg-[#fffbeb] border border-[#fde68a] p-3.5">
              <p className="font-sans text-[13px] font-bold text-[#92400e]">{t('eqa.payHeading').replace('{pct}', String(live.advancePct ?? 0))} <span className="ltr-num">· ₨{fmt(live.advanceDue)}</span></p>
              <p className="font-sans text-[12px] text-[#92400e]/80 mt-0.5">{t('eqa.payHint')}</p>
            </div>
          )}

          {phase === 'accepted' && live?.pin && (
            <div className="rounded-2xl bg-[#f0fdf4] border border-[#bbf7d0] p-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-sans text-[12px] font-bold text-[#166534]">{t('vp.yourPinLabel')}</p>
                <p className="font-sans text-[11.5px] text-[#166534]/80 leading-snug">{t('vp.yourPinHint')}</p>
              </div>
              <span className="font-sans text-[26px] font-black tracking-[0.2em] text-[#14532d] ltr-num shrink-0">{live.pin}</span>
            </div>
          )}

          {/* What was requested */}
          <div className="rounded-2xl border border-[#e8eaee] p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-full bg-[#f0fdf4] text-[#166534] flex items-center justify-center shrink-0"><Icon size={19} /></span>
              <div className="min-w-0 flex-1">
                <p className="font-sans text-[14px] font-bold text-[#0f172a] truncate"><bdi>{summary.vehicleLabel}</bdi></p>
                {driver && <p className="font-sans text-[12px] text-[#64748b] truncate"><bdi>{driver}</bdi></p>}
              </div>
              {summary.amount != null && <span className="font-sans text-[16px] font-extrabold text-[#0f172a] shrink-0"><span className="ltr-num">₨{fmt(summary.amount)}</span></span>}
            </div>
            {(summary.from || summary.to) && (
              <div className="flex gap-3 ps-3">
                <div className="flex flex-col items-center pt-1.5">
                  <span className="w-2.5 h-2.5 rounded-full border-[2.5px] border-[#16a34a]" />
                  {summary.to && <span className="w-0.5 flex-1 my-1 bg-[#e2e8f0]" />}
                  {summary.to && <span className="w-2.5 h-2.5 rounded-[2px] bg-[#0f172a]" />}
                </div>
                <div className="min-w-0 flex-1 flex flex-col gap-2">
                  {summary.from && <p className="font-sans text-[13px] font-semibold text-[#334155] leading-snug"><bdi>{summary.from}</bdi></p>}
                  {summary.to && <p className="font-sans text-[13px] font-semibold text-[#334155] leading-snug"><bdi>{summary.to}</bdi></p>}
                </div>
              </div>
            )}
            {summary.facts && summary.facts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {summary.facts.map((f, i) => <span key={i} className="px-2.5 py-1 rounded-full bg-[#f1f5f9] font-sans text-[12px] font-semibold text-[#334155]"><bdi>{f}</bdi></span>)}
              </div>
            )}
          </div>

          {phase === 'waiting' && oneWayFallback && elapsed >= oneWayFallback.afterSeconds && (
            <div className="rounded-2xl bg-[#fffbeb] border border-[#fde68a] p-3.5 flex flex-col gap-2.5">
              <p className="font-sans text-[13px] font-bold text-[#92400e]">{t('rw.noOneWayDriverHeading')}</p>
              <p className="font-sans text-[12px] text-[#92400e]/80 leading-snug">{t('rw.noOneWayDriverHint')}</p>
              <div className="flex gap-2">
                <button onClick={oneWayFallback.onSwitchShared} className="flex-1 py-2 rounded-xl bg-white border border-[#fde68a] text-[#92400e] font-sans text-[12.5px] font-bold cursor-pointer">{t('rw.switchToSharedBtn')}</button>
                <button onClick={oneWayFallback.onSwitchReturn} className="flex-1 py-2 rounded-xl bg-[#92400e] text-white font-sans text-[12.5px] font-bold cursor-pointer">{t('rw.switchToReturnBtn')}</button>
              </div>
            </div>
          )}

          {phase === 'waiting' && (
            <button onClick={doCancel} disabled={cancelling}
              className={`h-[50px] rounded-2xl font-sans text-[14.5px] font-bold cursor-pointer active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 ${confirmCancel ? 'bg-[#b91c1c] text-white' : 'bg-[#fef2f2] text-[#b91c1c]'}`}>
              {cancelling && <Loader2 size={16} className="animate-spin" />}
              {confirmCancel ? t('rw.confirmCancelBtn') : t('rw.cancelRequestBtn')}
            </button>
          )}

          {phase === 'accepted' && (
            <div className="flex gap-2.5">
              {live?.driverMobile && (
                <a href={`tel:${live.driverMobile}`} className="flex-1 h-[50px] rounded-2xl bg-[#f1f5f9] text-[#0f172a] font-sans text-[14.5px] font-bold flex items-center justify-center gap-2">
                  <Phone size={17} /> {t('vp.callBtn')}
                </a>
              )}
              <button onClick={onViewBooking} className="flex-[1.6] h-[50px] rounded-2xl bg-[#15803d] text-white font-sans text-[14.5px] font-bold shadow-[0_8px_20px_-6px_rgba(21,128,61,0.6)] cursor-pointer active:scale-[0.98] transition-transform">
                {live?.advanceDue != null ? t('eqa.payBtn') : t('rw.viewBookingBtn')}
              </button>
            </div>
          )}

          {(phase === 'declined' || phase === 'cancelled') && (
            <button onClick={onClose} className="h-[50px] rounded-2xl bg-[#15803d] text-white font-sans text-[14.5px] font-bold cursor-pointer active:scale-[0.98] transition-transform">
              {t('rw.chooseAnotherBtn')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
