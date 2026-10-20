'use client'

// Driver-side management for a monthly-fixed route — active riders (and
// a Revoke action that gives the required month's notice rather than
// removing a seat immediately), the waitlist, and this month's charges
// with a Mark Paid button each. Mirrors the "mark fulfilled" pattern
// already used for per_order bookings (fulfillBooking/confirm_ride_booking
// in this same file's own history) — the driver collects cash directly
// and marks it, which posts the real accounting voucher.

import { useEffect, useState } from 'react'
import { Users, Clock, LogOut, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Subscriber { id: string; name: string; stop_label: string | null; monthly_fee_pkr: number; status: string; scheduled_cancellation_at: string | null }
interface WaitlistRow { id: string; name: string; queue_position: number; monthly_fee_pkr: number }
interface DueCharge { id: string; rider_name: string; month: number; year: number; amount_pkr: number }
interface Detail { seats_total: number; active_count: number; subscribers: Subscriber[]; waitlist: WaitlistRow[]; due_charges: DueCharge[] }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function RouteMonthlySubscribersPanel({ routeId, onClose }: { routeId: string; onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<string | null>(null)

  const load = async () => {
    const { data } = await supabase.rpc('route_monthly_detail', { p_route_id: routeId })
    setDetail(data as Detail | null)
    setLoading(false)
  }
  useEffect(() => { load() }, [routeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const revoke = async (subscriptionId: string) => {
    const reason = window.prompt(t('mv.revokeConfirmPrompt'))
    if (reason === null) return
    setActionId(subscriptionId)
    const { error } = await supabase.rpc('driver_revoke_monthly_seat', { p_subscription_id: subscriptionId, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.riderRevokedToast'))
    load()
  }

  const undoRevoke = async (subscriptionId: string) => {
    setActionId(subscriptionId)
    const { error } = await supabase.rpc('cancel_pending_monthly_revocation', { p_subscription_id: subscriptionId })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.revocationCancelledToast'))
    load()
  }

  const markPaid = async (chargeId: string) => {
    setActionId(chargeId)
    const { error } = await supabase.rpc('mark_monthly_charge_paid', { p_charge_id: chargeId })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.chargeMarkedPaidToast'))
    load()
  }

  return (
    <MobilityBottomSheet title={t('mv.manageRidersBtn')} onClose={onClose}>
      {loading || !detail ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] flex items-center gap-1">
            <Users size={12} /> {t('mv.activeRidersLabel')} ({detail.active_count}/{detail.seats_total})
          </p>
          {detail.subscribers.length === 0 ? (
            <p className="font-sans text-[11.5px] text-[#94a3b8]">{t('mv.noActiveRiders')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {detail.subscribers.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-lg bg-[#F9F9F6] px-2.5 py-1.5">
                  <div className="flex-1 min-w-0">
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{s.name}</p>
                    <p className="font-sans text-[10.5px] text-[#64748b] truncate">{s.stop_label ?? '—'} · ₨{fmt(s.monthly_fee_pkr)}</p>
                    {s.status === 'pending_cancellation' && s.scheduled_cancellation_at && (
                      <p className="font-sans text-[10px] font-bold text-amber-700 flex items-center gap-1 mt-0.5">
                        <Clock size={10} /> {t('mv.pendingCancellationLabel').replace('{date}', new Date(s.scheduled_cancellation_at).toLocaleDateString())}
                      </p>
                    )}
                  </div>
                  {s.status === 'pending_cancellation' ? (
                    <button onClick={() => undoRevoke(s.id)} disabled={actionId === s.id} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#166534] disabled:opacity-50">
                      <Undo2 size={10} /> {t('mv.cancelRevokeBtn')}
                    </button>
                  ) : (
                    <button onClick={() => revoke(s.id)} disabled={actionId === s.id} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10.5px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">
                      <LogOut size={10} /> {t('mv.revokeBtn')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('mv.waitlistLabel')} ({detail.waitlist.length})</p>
          {detail.waitlist.length === 0 ? (
            <p className="font-sans text-[11.5px] text-[#94a3b8]">{t('mv.noWaitlist')}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {detail.waitlist.map((w) => (
                <div key={w.id} className="flex items-center gap-2 rounded-lg bg-[#F9F9F6] px-2.5 py-1.5">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[#64748b] text-white text-[10px] font-bold flex items-center justify-center">{w.queue_position}</span>
                  <span className="flex-1 min-w-0 font-sans text-[12px] font-semibold text-[#1e293b] truncate">{w.name}</span>
                  <span className="shrink-0 font-sans text-[10.5px] text-[#64748b] ltr-num">₨{fmt(w.monthly_fee_pkr)}</span>
                </div>
              ))}
            </div>
          )}

          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('mv.dueChargesLabel')}</p>
          {detail.due_charges.length === 0 ? (
            <p className="font-sans text-[11.5px] text-[#94a3b8]">{t('mv.noDueCharges')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {detail.due_charges.map((c) => (
                <div key={c.id} className="flex items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5">
                  <span className="flex-1 min-w-0 font-sans text-[12px] font-semibold text-[#1e293b] truncate">{c.rider_name} · {c.month}/{c.year}</span>
                  <span className="shrink-0 font-sans text-[11px] font-bold text-amber-700 ltr-num">₨{fmt(c.amount_pkr)}</span>
                  <button onClick={() => markPaid(c.id)} disabled={actionId === c.id} className="shrink-0 px-2 py-1 rounded-lg text-[10.5px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50">
                    {t('mv.markPaidBtn')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </MobilityBottomSheet>
  )
}
