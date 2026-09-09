'use client'

// One wedding booking's full lifecycle: requests out to hand-picked
// vehicles, each driver's own accept/decline, and — once at least one
// has accepted — a single combined non-refundable advance to the
// committee (announce here, confirmed by staff on the admin side).

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, CalendarDays, MapPin, Ruler, StickyNote, Car, Plus, X, AlertCircle, CheckCircle2, Ban, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface Request {
  id: string; vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null; color: string | null
  full_day_rate_pkr: number; status: string; decline_reason: string | null; advance_share_pkr: number | null
  withdrawn_at: string | null; replaces_request_id: string | null
}
interface ShadiEvent {
  id: string; event_date: string; venue_address: string; distance_km: number; notes: string | null
  status: string; advance_pct: number | null; advance_amount_pkr: number | null; advance_rejected_reason: string | null
  created_at: string; requests: Request[]
}
interface CandidateVehicle {
  id: string; owner_name: string; vehicle_type: string; color: string | null; model: string | null; shadi_full_day_rate_pkr: number
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const REQ_STATUS_COLOR: Record<string, string> = { requested: '#9a5714', accepted: '#0f7a4d', declined: '#b3261e', cancelled: '#6b6560', withdrawn: '#b3261e' }

export default function ShadiEventDetailPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const params = useParams<{ eventId: string }>()
  const supabase = createClient()

  const [event, setEvent] = useState<ShadiEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [showInvite, setShowInvite] = useState(false)
  const [candidates, setCandidates] = useState<CandidateVehicle[]>([])
  const [inviting, setInviting] = useState<string | null>(null)
  // Set when inviting specifically to fill a withdrawn vehicle's slot —
  // routes the pick through invite_shadi_replacement instead of
  // add_shadi_vehicle_request, so the slot's reserved advance share
  // transfers to whoever accepts.
  const [replacingRequestId, setReplacingRequestId] = useState<string | null>(null)

  const [showAdvance, setShowAdvance] = useState(false)
  const [method, setMethod] = useState('cash')
  const [proofPath, setProofPath] = useState('')
  const [submittingAdvance, setSubmittingAdvance] = useState(false)

  const load = () => supabase.rpc('my_shadi_events').then(({ data }) => {
    const found = ((data ?? []) as ShadiEvent[]).find((e) => e.id === params.eventId)
    setEvent(found ?? null)
    setLoading(false)
  })

  useEffect(() => { if (user) load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const openInvite = (replacingId: string | null = null) => {
    if (!event) return
    // Live (not declined/withdrawn/cancelled) requests still occupy their
    // vehicle — never worth offering as a candidate again for this event.
    const takenIds = new Set(event.requests.filter((r) => !['declined', 'withdrawn', 'cancelled'].includes(r.status)).map((r) => r.vehicle_id))
    setReplacingRequestId(replacingId)
    supabase.rpc('shadi_bookable_vehicles').then(({ data }) => {
      setCandidates(((data ?? []) as CandidateVehicle[]).filter((v) => !takenIds.has(v.id)))
      setShowInvite(true)
    })
  }

  const invite = async (vehicleId: string) => {
    if (!event) return
    setInviting(vehicleId)
    const { error } = replacingRequestId
      ? await supabase.rpc('invite_shadi_replacement', { p_event_id: event.id, p_withdrawn_request_id: replacingRequestId, p_vehicle_id: vehicleId })
      : await supabase.rpc('add_shadi_vehicle_request', { p_event_id: event.id, p_vehicle_id: vehicleId })
    setInviting(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.shadiRequestsSentToast'))
    setShowInvite(false)
    load()
  }

  const cancelEvent = async () => {
    if (!event || !confirm(t('vp.confirmCancelShadi'))) return
    setBusy(true)
    const { error } = await supabase.rpc('cancel_shadi_event', { p_event_id: event.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const submitAdvance = async () => {
    if (!event) return
    if (!proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setSubmittingAdvance(true)
    const { data, error } = await supabase.rpc('announce_shadi_advance', { p_event_id: event.id, p_method: method, p_proof_url: proofPath })
    setSubmittingAdvance(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.advanceSubmittedToast').replace('{amount}', fmt((data as { amount: number }).amount)))
    setShowAdvance(false)
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!event) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('vp.shadiEventNotFound')}</div>

  const accepted = event.requests.filter((r) => r.status === 'accepted')
  const canAnnounce = event.status === 'collecting' && accepted.length > 0
  const estimatedPct = 20 // shown only as a rough label before the server computes the real figure; actual pct comes from confirm_shadi_advance's own settings read

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/marketplace/shadi" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.shadiPageTitle')}
      </Link>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="font-heading text-[19px] font-bold text-dp-primary flex items-center gap-1.5"><CalendarDays size={16} /> {new Date(event.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <span className="font-sans text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: event.status === 'confirmed' ? '#0f7a4d1a' : event.status === 'cancelled' ? '#6b65601a' : '#9a57141a', color: event.status === 'confirmed' ? '#0f7a4d' : event.status === 'cancelled' ? '#6b6560' : '#9a5714' }}>{t(`vp.shadiStatus.${event.status}`)}</span>
        </div>
        <p className="font-sans text-[13px] text-dp-on-surface-variant flex items-start gap-1.5 mb-1"><MapPin size={12} className="shrink-0 mt-0.5" /> {event.venue_address}</p>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-center gap-1.5 mb-1 ltr-num"><Ruler size={12} /> {fmt(event.distance_km)}km</p>
        {event.notes && <p className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-start gap-1.5"><StickyNote size={12} className="shrink-0 mt-0.5" /> {event.notes}</p>}
      </div>

      {event.advance_rejected_reason && event.status === 'collecting' && (
        <div className="flex items-start gap-1.5 border rounded-lg p-3 mb-4" style={{ borderColor: '#f4a68f', background: '#fce3dc' }}>
          <AlertCircle size={14} style={{ color: '#ae1800' }} className="shrink-0 mt-0.5" />
          <p className="font-sans text-[12.5px]" style={{ color: '#ae1800' }}>{t('vp.advanceRejectedNote')} {event.advance_rejected_reason}</p>
        </div>
      )}

      <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('vp.requestedVehiclesHeading')}</p>
      <div className="space-y-2.5 mb-4">
        {event.requests.map((r) => {
          const hasLiveReplacement = event.requests.some((other) => other.replaces_request_id === r.id && ['requested', 'accepted'].includes(other.status))
          return (
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <Car size={16} className="text-dp-on-surface-variant shrink-0" />
                  <div className="min-w-0">
                    <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{r.model || r.vehicle_type} — {r.owner_name}</p>
                    {r.color && <p className="font-sans text-[11px] text-dp-on-surface-variant">{r.color}</p>}
                    {r.replaces_request_id && <p className="font-sans text-[10.5px] text-dp-on-surface-variant italic">{t('vp.replacementVehicleLabel')}</p>}
                  </div>
                </div>
                <span className="shrink-0 font-sans text-[10px] font-bold px-2 py-1 rounded-full" style={{ background: `${REQ_STATUS_COLOR[r.status]}1a`, color: REQ_STATUS_COLOR[r.status] }}>{t(`vp.shadiReqStatus.${r.status}`)}</span>
              </div>
              <div className="mt-2 pt-2 border-t border-dp-outline-variant flex items-center justify-between">
                <span className="font-sans text-[12px] text-dp-on-surface-variant">{t('vp.fullDayRateLabel')}</span>
                <span className="font-heading text-[14px] font-bold text-dp-secondary ltr-num">{fmt(r.full_day_rate_pkr)}</span>
              </div>
              {r.status === 'declined' && r.decline_reason && (
                <p className="flex items-center gap-1.5 font-sans text-[11.5px] mt-1.5" style={{ color: '#b3261e' }}><AlertCircle size={11} /> {r.decline_reason}</p>
              )}
              {r.status === 'withdrawn' && (
                <>
                  {r.decline_reason && (
                    <p className="flex items-center gap-1.5 font-sans text-[11.5px] mt-1.5" style={{ color: '#b3261e' }}><AlertCircle size={11} /> {r.decline_reason}</p>
                  )}
                  {event.status === 'confirmed' && r.advance_share_pkr != null && !hasLiveReplacement && (
                    <button onClick={() => openInvite(r.id)} className="w-full flex items-center justify-center gap-1.5 py-2 mt-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-surface-container">
                      <Plus size={12} /> {t('vp.inviteReplacementBtn')}
                    </button>
                  )}
                  {hasLiveReplacement && <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1.5">{t('vp.replacementPendingHint')}</p>}
                </>
              )}
              {event.status === 'confirmed' && r.status === 'accepted' && r.advance_share_pkr != null && (
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5 ltr-num">{t('vp.balanceDueLabel')}: <span className="font-bold text-dp-on-surface">{fmt(r.full_day_rate_pkr - r.advance_share_pkr)}</span></p>
              )}
            </div>
          )
        })}
      </div>

      {event.status === 'collecting' && (
        <button onClick={() => openInvite()} className="w-full flex items-center justify-center gap-1.5 py-2.5 mb-4 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container">
          <Plus size={14} /> {t('vp.inviteAnotherVehicleBtn')}
        </button>
      )}

      {event.status === 'advance_announced' && (
        <div className="bg-dp-surface-container-low rounded-lg p-4 mb-4 text-center">
          <Loader2 size={18} className="animate-spin text-dp-secondary mx-auto mb-1.5" />
          <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{t('vp.advanceAwaitingConfirmationHint')}</p>
          <p className="font-heading text-[18px] font-bold text-dp-primary ltr-num mt-1">{fmt(event.advance_amount_pkr ?? 0)}</p>
        </div>
      )}

      {event.status === 'confirmed' && (
        <div className="rounded-lg p-4 mb-4 text-center border-2" style={{ borderColor: '#0f7a4d', background: '#e9f7ef' }}>
          <CheckCircle2 size={18} style={{ color: '#0f7a4d' }} className="mx-auto mb-1.5" />
          <p className="font-sans text-[13px] font-semibold" style={{ color: '#0f7a4d' }}>{t('vp.advanceConfirmedHint')}</p>
          <p className="font-heading text-[18px] font-bold ltr-num mt-1" style={{ color: '#0f7a4d' }}>{fmt(event.advance_amount_pkr ?? 0)}</p>
        </div>
      )}

      {canAnnounce && (
        <button onClick={() => setShowAdvance(true)} className="w-full bg-dp-secondary text-white rounded-lg py-3 font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all mb-2.5">
          {t('vp.payAdvanceBtn')}
        </button>
      )}
      {event.status === 'collecting' && (
        <button onClick={cancelEvent} disabled={busy} className="w-full flex items-center justify-center gap-1.5 py-2.5 font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50" style={{ color: '#b3261e' }}>
          <Ban size={13} /> {t('vp.cancelShadiEventBtn')}
        </button>
      )}

      {showInvite && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowInvite(false)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-lg sm:rounded-lg p-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <p className="font-heading text-[16px] font-bold text-dp-on-surface">{replacingRequestId ? t('vp.inviteReplacementBtn') : t('vp.inviteAnotherVehicleBtn')}</p>
              <button onClick={() => setShowInvite(false)} className="cursor-pointer"><X size={18} /></button>
            </div>
            {candidates.length === 0 ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant text-center py-6">{t('vp.noMoreCandidatesHint')}</p>
            ) : (
              <div className="space-y-2">
                {candidates.map((v) => (
                  <button key={v.id} onClick={() => invite(v.id)} disabled={inviting === v.id}
                    className="w-full flex items-center justify-between gap-2 border border-dp-outline-variant rounded-lg p-2.5 text-start cursor-pointer hover:border-dp-secondary disabled:opacity-50">
                    <div>
                      <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{v.model || v.vehicle_type} — {v.owner_name}</p>
                      {v.color && <p className="font-sans text-[11px] text-dp-on-surface-variant">{v.color}</p>}
                    </div>
                    <span className="font-heading text-[14px] font-bold text-dp-secondary ltr-num shrink-0">{fmt(v.shadi_full_day_rate_pkr)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showAdvance && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowAdvance(false)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-lg sm:rounded-lg p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <p className="font-heading text-[16px] font-bold text-dp-on-surface">{t('vp.payAdvanceBtn')}</p>
              <button onClick={() => setShowAdvance(false)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">
              {t('vp.advanceExplainerHint').replace('{pct}', String(event.advance_pct ?? estimatedPct)).replace('{count}', String(accepted.length))}
            </p>
            <div className="bg-dp-surface-container-low rounded-lg p-3 mb-3 flex items-center justify-between">
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('vp.acceptedTotalLabel')}</span>
              <span className="font-heading text-[15px] font-bold text-dp-on-surface ltr-num">{fmt(accepted.reduce((s, r) => s + r.full_day_rate_pkr, 0))}</span>
            </div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px] mb-3">
              <option value="cash">{t('w.cash')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
              <option value="bank">{t('a.bank')}</option>
            </select>
            <div className="mb-3"><DonationReceiptUpload onUpload={setProofPath} /></div>
            <button onClick={submitAdvance} disabled={submittingAdvance} className="w-full bg-dp-secondary text-white rounded-lg py-3 font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {submittingAdvance ? t('action.saving') : t('vp.submitAdvanceBtn')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
