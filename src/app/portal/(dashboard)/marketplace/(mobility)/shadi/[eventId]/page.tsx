'use client'

// One wedding booking's full lifecycle: requests out to hand-picked
// vehicles, each driver's own accept/decline, and — once at least one
// has accepted — a single combined non-refundable advance to the
// committee (announce here, confirmed by staff on the admin side).
//
// Phase 4: re-skinned to the new design + moved under marketplace/
// (mobility)/ — same RPCs throughout, both inline modals now reuse
// MobilityBottomSheet instead of their own markup.

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { ArrowLeft, CalendarDays, MapPin, Ruler, StickyNote, Car, Plus, AlertCircle, CheckCircle2, Ban, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { ShareBookingButton } from '@/components/portal/ShareBookingButton'
import { CallButton } from '@/components/portal/CallButton'
import { ChatButton } from '@/components/portal/ChatButton'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Request {
  id: string; vehicle_id: string | null; class_key: string | null
  owner_name: string | null; owner_mobile: string | null; vehicle_type: string | null; model: string | null; color: string | null
  full_day_rate_pkr: number; status: string; decline_reason: string | null; advance_share_pkr: number | null
  withdrawn_at: string | null; replaces_request_id: string | null
}
interface ShadiEvent {
  id: string; event_date: string; venue_address: string; venue_lat: number | null; venue_lng: number | null; distance_km: number; notes: string | null
  status: string; advance_pct: number | null; advance_amount_pkr: number | null; advance_rejected_reason: string | null
  created_at: string; requests: Request[]
}
interface CandidateVehicle {
  id: string; owner_name: string; vehicle_type: string; color: string | null; model: string | null; shadi_full_day_rate_pkr: number
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const REQ_STATUS_COLOR: Record<string, string> = { open: '#92400e', requested: '#92400e', accepted: '#166534', declined: '#b91c1c', cancelled: '#64748b', withdrawn: '#b91c1c' }

export default function ShadiEventDetailPage() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const { user, loading: userLoading } = usePortalUser()
  const params = useParams<{ eventId: string }>()
  const supabase = createClient()

  const [event, setEvent] = useState<ShadiEvent | null>(null)
  const [classes, setClasses] = useState<{ class_key: string; name_en: string; name_ur: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [showInvite, setShowInvite] = useState(false)
  const [candidates, setCandidates] = useState<CandidateVehicle[]>([])
  const [inviting, setInviting] = useState<string | null>(null)
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
  useEffect(() => { supabase.rpc('shadi_vehicle_classes_list').then(({ data }) => setClasses((data ?? []) as { class_key: string; name_en: string; name_ur: string }[])) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const classNameFor = (key: string | null) => { const c = classes.find((x) => x.class_key === key); return c ? (isUrdu ? c.name_ur : c.name_en) : key }

  const openInvite = (replacingId: string | null = null) => {
    if (!event) return
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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!event) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('vp.shadiEventNotFound')}</div>

  const accepted = event.requests.filter((r) => r.status === 'accepted')
  const canAnnounce = event.status === 'collecting' && accepted.length > 0
  const estimatedPct = 20

  return (
    <div className="flex flex-col gap-3">
      <Link href="/portal/marketplace/shadi" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#005A36] w-fit">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.shadiPageTitle')}
      </Link>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="font-extrabold text-[18px] text-[#005A36] flex items-center gap-1.5"><CalendarDays size={16} /> {new Date(event.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <span className="text-[10.5px] font-bold px-2 py-1 rounded-full" style={{ background: event.status === 'confirmed' ? '#dcfce7' : event.status === 'cancelled' ? '#f1f5f9' : '#fef3c7', color: event.status === 'confirmed' ? '#166534' : event.status === 'cancelled' ? '#64748b' : '#92400e' }}>{t(`vp.shadiStatus.${event.status}`)}</span>
        </div>
        <p className="text-[13px] text-[#64748b] flex items-start gap-1.5 mb-1"><MapPin size={12} className="shrink-0 mt-0.5" /> {event.venue_address}</p>
        <p className="text-[12.5px] text-[#64748b] flex items-center gap-1.5 mb-1 ltr-num"><Ruler size={12} /> {fmt(event.distance_km)}km</p>
        {event.notes && <p className="text-[12.5px] text-[#64748b] flex items-start gap-1.5"><StickyNote size={12} className="shrink-0 mt-0.5" /> {event.notes}</p>}
        {event.venue_lat != null && event.venue_lng != null && (
          <LeafletMap pins={[{ lat: event.venue_lat, lng: event.venue_lng, color: '#166534' }]} height={140} className="rounded-xl mt-2" />
        )}
      </div>

      {event.advance_rejected_reason && event.status === 'collecting' && (
        <div className="flex items-start gap-1.5 border rounded-2xl p-3" style={{ borderColor: '#fca5a5', background: '#fef2f2' }}>
          <AlertCircle size={14} style={{ color: '#b91c1c' }} className="shrink-0 mt-0.5" />
          <p className="text-[12.5px]" style={{ color: '#b91c1c' }}>{t('vp.advanceRejectedNote')} {event.advance_rejected_reason}</p>
        </div>
      )}

      <p className="text-[12px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('vp.requestedVehiclesHeading')}</p>
      <div className="flex flex-col gap-2.5">
        {event.requests.map((r) => {
          const hasLiveReplacement = event.requests.some((other) => other.replaces_request_id === r.id && ['requested', 'accepted'].includes(other.status))
          return (
            <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <Car size={16} className="text-[#64748b] shrink-0" />
                  <div className="min-w-0">
                    {r.status === 'open' ? (
                      <>
                        <p className="text-[13.5px] font-semibold text-[#1e293b] truncate">{classNameFor(r.class_key)}</p>
                        <p className="text-[11px] text-[#92400e]">{t('vp.openSlotLabel')}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[13.5px] font-semibold text-[#1e293b] truncate">{vehicleDisplayName(r.vehicle_type, r.model)} — {r.owner_name}</p>
                        {r.color && <p className="text-[11px] text-[#64748b]">{r.color}</p>}
                        {r.status === 'accepted' && (
                          <span className="flex items-center gap-3 mt-0.5">
                            <CallButton phone={r.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[11px] font-semibold text-[#166534]" />
                            <ChatButton refType="shadi_vehicle_request" refId={r.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[11px] font-semibold text-[#166534] cursor-pointer" />
                          </span>
                        )}
                        {r.replaces_request_id && <p className="text-[10.5px] text-[#64748b] italic">{t('vp.replacementVehicleLabel')}</p>}
                      </>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-[10px] font-bold px-2 py-1 rounded-full" style={{ background: `${REQ_STATUS_COLOR[r.status]}1a`, color: REQ_STATUS_COLOR[r.status] }}>{t(`vp.shadiReqStatus.${r.status}`)}</span>
              </div>
              <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex items-center justify-between">
                <span className="text-[12px] text-[#64748b]">{t('vp.fullDayRateLabel')}</span>
                <span className="font-extrabold text-[14px] text-[#166534] ltr-num">{fmt(r.full_day_rate_pkr)}</span>
              </div>
              {r.status === 'declined' && r.decline_reason && (
                <p className="flex items-center gap-1.5 text-[11.5px] mt-1.5" style={{ color: '#b91c1c' }}><AlertCircle size={11} /> {r.decline_reason}</p>
              )}
              {r.status === 'withdrawn' && (
                <>
                  {r.decline_reason && (
                    <p className="flex items-center gap-1.5 text-[11.5px] mt-1.5" style={{ color: '#b91c1c' }}><AlertCircle size={11} /> {r.decline_reason}</p>
                  )}
                  {event.status === 'confirmed' && r.advance_share_pkr != null && !hasLiveReplacement && (
                    <button onClick={() => openInvite(r.id)} className="w-full flex items-center justify-center gap-1.5 py-2 mt-1.5 border border-[#e5e2d0] rounded-xl text-[12px] font-semibold cursor-pointer">
                      <Plus size={12} /> {t('vp.inviteReplacementBtn')}
                    </button>
                  )}
                  {hasLiveReplacement && <p className="text-[11px] text-[#64748b] mt-1.5">{t('vp.replacementPendingHint')}</p>}
                </>
              )}
              {event.status === 'confirmed' && r.status === 'accepted' && r.advance_share_pkr != null && (
                <>
                  <p className="text-[11.5px] text-[#64748b] mt-1.5 ltr-num">{t('vp.balanceDueLabel')}: <span className="font-bold text-[#1e293b]">{fmt(r.full_day_rate_pkr - r.advance_share_pkr)}</span></p>
                  <div className="flex items-center justify-between mt-1">
                    <ShareBookingButton
                      title={`${isUrdu ? site.nameUrdu : site.name} ${t('mb.portalSuffix')}`}
                      lines={[`${vehicleDisplayName(r.vehicle_type, r.model)} — ${r.owner_name}`, event.venue_address, `${t('vp.totalLabel')}: ${fmt(r.full_day_rate_pkr)}`]}
                    />
                    <ReportProblemButton refType="shadi_request" refId={r.id} kindOptions={['shadi_withdrawal', 'fare_dispute']} />
                  </div>
                  {event.event_date < new Date().toISOString().slice(0, 10) && (
                    <div className="mt-2">
                      <RateAndReport refType="shadi_vehicle_request" refId={r.id} againstPartyType="vehicle" againstPartyId={r.vehicle_id!} showComplaint={false} />
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {event.status === 'collecting' && (
        <button onClick={() => openInvite()} className="w-full flex items-center justify-center gap-1.5 py-2.5 border border-[#e5e2d0] rounded-xl text-[13px] font-semibold cursor-pointer">
          <Plus size={14} /> {t('vp.inviteAnotherVehicleBtn')}
        </button>
      )}

      {event.status === 'advance_announced' && (
        <div className="bg-[#F9F9F6] rounded-2xl p-4 text-center">
          <Loader2 size={18} className="animate-spin text-[#166534] mx-auto mb-1.5" />
          <p className="text-[13px] font-semibold text-[#1e293b]">{t('vp.advanceAwaitingConfirmationHint')}</p>
          <p className="font-extrabold text-[18px] text-[#005A36] ltr-num mt-1">{fmt(event.advance_amount_pkr ?? 0)}</p>
        </div>
      )}

      {event.status === 'confirmed' && (
        <div className="rounded-2xl p-4 text-center border-2" style={{ borderColor: '#166534', background: '#dcfce7' }}>
          <CheckCircle2 size={18} style={{ color: '#166534' }} className="mx-auto mb-1.5" />
          <p className="text-[13px] font-semibold" style={{ color: '#166534' }}>{t('vp.advanceConfirmedHint')}</p>
          <p className="font-extrabold text-[18px] ltr-num mt-1" style={{ color: '#166534' }}>{fmt(event.advance_amount_pkr ?? 0)}</p>
        </div>
      )}

      {(event.status === 'cancelled' || (event.status === 'confirmed' && event.event_date < new Date().toISOString().slice(0, 10))) && (
        <Link href="/portal/marketplace/shadi" className="flex items-center justify-center gap-1.5 text-[12.5px] font-semibold text-[#166534] py-1">
          <RotateCcw size={12} /> {t('vp.bookAgainBtn')}
        </Link>
      )}

      {canAnnounce && (
        <button onClick={() => setShowAdvance(true)} className="w-full bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer">
          {t('vp.payAdvanceBtn')}
        </button>
      )}
      {event.status === 'collecting' && (
        <button onClick={cancelEvent} disabled={busy} className="w-full flex items-center justify-center gap-1.5 py-2.5 text-[13px] font-semibold cursor-pointer disabled:opacity-50" style={{ color: '#b91c1c' }}>
          <Ban size={13} /> {t('vp.cancelShadiEventBtn')}
        </button>
      )}

      {showInvite && (
        <MobilityBottomSheet title={replacingRequestId ? t('vp.inviteReplacementBtn') : t('vp.inviteAnotherVehicleBtn')} onClose={() => setShowInvite(false)}>
          {candidates.length === 0 ? (
            <p className="text-[13px] text-[#64748b] text-center py-6">{t('vp.noMoreCandidatesHint')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {candidates.map((v) => (
                <button key={v.id} onClick={() => invite(v.id)} disabled={inviting === v.id}
                  className="w-full flex items-center justify-between gap-2 border border-[#e5e2d0] rounded-xl p-2.5 text-start cursor-pointer disabled:opacity-50">
                  <div>
                    <p className="text-[13px] font-semibold text-[#1e293b]">{vehicleDisplayName(v.vehicle_type, v.model)} — {v.owner_name}</p>
                    {v.color && <p className="text-[11px] text-[#64748b]">{v.color}</p>}
                  </div>
                  <span className="font-extrabold text-[14px] text-[#166534] ltr-num shrink-0">{fmt(v.shadi_full_day_rate_pkr)}</span>
                </button>
              ))}
            </div>
          )}
        </MobilityBottomSheet>
      )}

      {showAdvance && (
        <MobilityBottomSheet title={t('vp.payAdvanceBtn')} onClose={() => setShowAdvance(false)}>
          <p className="text-[12px] text-[#64748b] mb-3">
            {t('vp.advanceExplainerHint').replace('{pct}', String(event.advance_pct ?? estimatedPct)).replace('{count}', String(accepted.length))}
          </p>
          <div className="bg-[#F9F9F6] rounded-xl p-3 mb-3 flex items-center justify-between">
            <span className="text-[12.5px] text-[#64748b]">{t('vp.acceptedTotalLabel')}</span>
            <span className="font-extrabold text-[15px] text-[#1e293b] ltr-num">{fmt(accepted.reduce((s, r) => s + r.full_day_rate_pkr, 0))}</span>
          </div>
          <label className="block text-[13px] font-semibold text-[#64748b] mb-1.5">{t('w.paymentMethod')}</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px] mb-3">
            <option value="cash">{t('w.cash')}</option>
            <option value="jazzcash">{t('w.jazzcash')}</option>
            <option value="easypaisa">{t('w.easypaisa')}</option>
            <option value="bank">{t('a.bank')}</option>
          </select>
          <div className="mb-3"><DonationReceiptUpload onUpload={setProofPath} /></div>
          <button onClick={submitAdvance} disabled={submittingAdvance} className="w-full bg-[#166534] text-white rounded-xl py-3 font-semibold cursor-pointer disabled:opacity-50">
            {submittingAdvance ? t('action.saving') : t('vp.submitAdvanceBtn')}
          </button>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
