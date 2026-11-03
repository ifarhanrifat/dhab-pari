'use client'

// Real ask, 2026-10-30 (screenshot of the ride sheet): the "pick a
// vehicle type and call any driver" sheet still looked like the old
// plain popup — a title, a grey fare row and a spinner while waiting —
// while every other booking had moved to the new request design. This
// is the same design for ride-dispatch: a hero with the vehicle and the
// fare, the pickup -> drop-off route, and while the request is out, the
// same pulsing "searching" screen that holds until a driver accepts or
// the rider cancels (no tap-outside close while searching). The page
// keeps all its own logic; this only renders the shell around it.

import { useEffect, useState, type ReactNode } from 'react'
import { X as XIcon, Check, CircleSlash, Clock, Loader2 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { nextEscalationMinutesRemaining } from '@/lib/rideEscalation'

export type RideSheetPhase = 'form' | 'searching' | 'scheduled' | 'found' | 'closed'

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function RideRequestShell({
  emoji, title, fare, from, to, distanceKm, phase, since, scheduledFor, isOutOfCity, escalationCount, onClose, onCancel, children,
}: {
  emoji: string; title: string; fare: number | null; from: string | null; to: string | null; distanceKm: number | null
  phase: RideSheetPhase; since?: string | null; scheduledFor?: string | null
  isOutOfCity?: boolean; escalationCount?: number
  onClose: () => void; onCancel: () => Promise<void> | void; children?: ReactNode
}) {
  const { t, isUrdu } = useLocale()
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [openedAt] = useState(() => Date.now())

  useEffect(() => {
    if (phase !== 'searching') return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [phase])
  useEffect(() => {
    if (phase === 'found' && typeof navigator !== 'undefined') navigator.vibrate?.([120, 60, 120])
  }, [phase])

  const holding = phase === 'searching' || phase === 'scheduled'
  const startedAt = since ? new Date(since).getTime() : openedAt
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const timer = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  const cancel = async () => {
    if (!confirming) { setConfirming(true); return }
    setCancelling(true)
    await onCancel()
    setCancelling(false); setConfirming(false)
  }

  const heroBg = phase === 'found' ? 'linear-gradient(160deg,#065f46,#16a34a)'
    : phase === 'closed' ? 'linear-gradient(160deg,#475569,#64748b)'
    : 'linear-gradient(150deg,#0f3d2e,#166534 60%,#15803d)'

  return (
    <div className="fixed inset-0 bg-black/55 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200"
      onClick={holding ? undefined : onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-[420px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[94vh] overflow-y-auto shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 duration-300">

        <div className="relative px-5 pt-2.5 pb-8 text-white transition-[background] duration-500" style={{ backgroundImage: heroBg }}>
          <div className="w-10 h-1 rounded-full bg-white/40 mx-auto sm:hidden" />
          {!holding && (
            <button onClick={onClose} aria-label="Close" className="absolute top-3 end-3 w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center cursor-pointer">
              <XIcon size={16} />
            </button>
          )}

          {phase === 'form' ? (
            <div className="mt-4">
              <div className="flex items-center gap-3.5">
                <div className="w-16 h-16 rounded-2xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center text-[34px] shrink-0">{emoji}</div>
                <div className="min-w-0">
                  <p className="font-sans text-[20px] font-extrabold leading-tight truncate">{title}</p>
                  <span className="inline-block mt-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-white/20">{t('cm.tripTypeOneway')}</span>
                </div>
              </div>
              {fare != null && (
                <div className="mt-4">
                  <p className="font-sans text-[11.5px] font-semibold text-white/80">{t('mb.fareForTripLabel')}</p>
                  <p className="font-sans text-[34px] font-black leading-none mt-1"><span className="ltr-num">₨{fmt(fare)}</span></p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center text-center pt-5">
              <div className="relative w-28 h-28 flex items-center justify-center">
                {phase === 'searching' && (
                  <>
                    <span className="absolute inset-0 rounded-full border-2 border-white/40 animate-ping [animation-duration:2.2s]" />
                    <span className="absolute inset-3 rounded-full border-2 border-white/30 animate-ping [animation-duration:2.2s] [animation-delay:.7s]" />
                    <span className="absolute inset-6 rounded-full bg-white/10" />
                  </>
                )}
                <div className="relative w-16 h-16 rounded-full bg-white flex items-center justify-center shadow-lg text-[30px] animate-in zoom-in-50 duration-300">
                  {phase === 'searching' && emoji}
                  {phase === 'scheduled' && <Clock size={30} className="text-[#166534]" />}
                  {phase === 'found' && <Check size={34} strokeWidth={3} className="text-[#16a34a]" />}
                  {phase === 'closed' && <CircleSlash size={30} className="text-[#475569]" />}
                </div>
              </div>
              <p className="font-sans text-[19px] font-extrabold mt-3 leading-tight">
                {phase === 'searching' ? t('rr.searchingHeading') : phase === 'scheduled' ? t('mb.rideScheduledHeading') : phase === 'found' ? t('rr.foundHeading') : t('rw.cancelledHeading')}
              </p>
              <p className="font-sans text-[13px] text-white/85 mt-1 max-w-[310px]">
                {phase === 'searching' ? t('rr.searchingHint').replace('{type}', title)
                  : phase === 'scheduled' ? (scheduledFor ? new Date(scheduledFor).toLocaleString(isUrdu ? 'ur-PK' : 'en-PK', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')
                  : phase === 'found' ? t('rr.foundHint')
                  : t('mb.rideRequestCancelledNote')}
              </p>
              {phase === 'searching' && (
                <span className="mt-3 inline-flex items-center gap-1.5 bg-white/15 px-3 py-1 rounded-full font-sans text-[12px] font-semibold">
                  <Loader2 size={13} className="animate-spin" /> <span className="ltr-num">{timer}</span>
                </span>
              )}
              {/* Real ask, 2026-11-03: "bykea keeps saying no drivers,
                  increase your offer" — our system steps the fare up
                  automatically instead of asking the rider to bid
                  (788), but it should never feel like a silent/sneaky
                  increase — said up front, before it ever happens. */}
              {phase === 'searching' && (() => {
                const minsLeft = since ? nextEscalationMinutesRemaining(since, escalationCount ?? 0, isOutOfCity ?? false, now) : null
                return (
                  <p className="font-sans text-[11.5px] text-white/70 mt-2 max-w-[280px] text-center leading-[1.6]">
                    {minsLeft != null ? t('mb.nextFareStepHint').replace('{minutes}', String(minsLeft)) : (since ? t('mb.maxFareReachedHint') : t('rr.autoEscalationNote'))}
                  </p>
                )
              })()}
            </div>
          )}
        </div>

        <div className="relative -mt-5 bg-white rounded-t-[24px] px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-3.5">
          {(from || to) && (
            <div className="rounded-2xl border border-[#e8eaee] p-3.5 flex gap-3">
              <div className="flex flex-col items-center pt-1">
                <span className="w-3 h-3 rounded-full border-[3px] border-[#16a34a] bg-white" />
                <span className="w-0.5 flex-1 my-1 bg-[repeating-linear-gradient(to_bottom,#cbd5e1_0_4px,transparent_4px_8px)]" />
                <span className="w-3 h-3 rounded-[3px] bg-[#0f172a]" />
              </div>
              <div className="min-w-0 flex-1 flex flex-col gap-3">
                <div>
                  <p className="font-sans text-[11px] font-semibold text-[#94a3b8]">{t('rq.pickup')}</p>
                  <p className="font-sans text-[14px] font-semibold text-[#0f172a] leading-snug"><bdi>{from ?? '—'}</bdi></p>
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-sans text-[11px] font-semibold text-[#94a3b8]">{t('rq.dropoff')}</p>
                    <p className="font-sans text-[14px] font-semibold text-[#0f172a] leading-snug"><bdi>{to ?? '—'}</bdi></p>
                  </div>
                  {distanceKm != null && <span className="shrink-0 text-[11.5px] font-bold text-[#475569] bg-[#f1f5f9] px-2 py-0.5 rounded-full"><span className="ltr-num">{fmt(distanceKm)} km</span></span>}
                </div>
              </div>
            </div>
          )}

          {phase === 'form' ? children : (
            <>
              {phase !== 'closed' && fare != null && (
                <div className="flex items-center justify-between rounded-2xl bg-[#F9F9F6] px-3.5 py-3">
                  <span className="flex items-center gap-2 font-sans text-[13px] font-semibold text-[#334155]"><span className="text-[20px]">{emoji}</span> {title}</span>
                  <span className="font-sans text-[17px] font-extrabold text-[#166534]"><span className="ltr-num">₨{fmt(fare)}</span></span>
                </div>
              )}
              {holding && (
                <button onClick={cancel} disabled={cancelling}
                  className={`h-[50px] rounded-2xl font-sans text-[14.5px] font-bold cursor-pointer active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 ${confirming ? 'bg-[#b91c1c] text-white' : 'bg-[#fef2f2] text-[#b91c1c]'}`}>
                  {cancelling && <Loader2 size={16} className="animate-spin" />}
                  {confirming ? t('rw.confirmCancelBtn') : t('rw.cancelRequestBtn')}
                </button>
              )}
              {phase === 'found' && <div className="flex justify-center py-1"><Loader2 size={20} className="animate-spin text-[#166534]" /></div>}
              {phase === 'closed' && (
                <button onClick={onClose} className="h-[50px] rounded-2xl bg-[#15803d] text-white font-sans text-[14.5px] font-bold cursor-pointer active:scale-[0.98]">
                  {t('rw.chooseAnotherBtn')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
