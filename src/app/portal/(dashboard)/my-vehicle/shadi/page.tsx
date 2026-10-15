'use client'

// Driver's side of shadi (wedding) booking requests (478): accept or
// decline each hand-picked request against the flat full-day rate the
// committee set. No start/end trip here — once an event's advance is
// confirmed there's nothing left to do in-app; the driver just shows up
// on the day and collects the balance (full-day rate minus their share
// of the advance) directly from the customer. A past event_date is
// purely a display distinction (history), not a status change.
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Jobs tab's shadi rows rather than its own nav tab.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Users2, CalendarDays, MapPin, Ruler, Check, X, Loader2, AlertCircle, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { TrustPill, TrustStrip, type Trust } from '@/components/shared/TrustBadge'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { ChatButton } from '@/components/portal/ChatButton'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Vehicle { id: string; owner_name: string; shadi_vehicle_class: string | null }
interface Request {
  id: string; status: string; decline_reason: string | null; full_day_rate_pkr: number; advance_share_pkr: number | null
  event_id: string; event_date: string; venue_address: string; venue_lat: number | null; venue_lng: number | null; distance_km: number; notes: string | null; event_status: string
  customer_portal_user_id: string; customer_name: string; customer_mobile: string | null; paid_out_at: string | null; customer_trust: Trust | null
}
interface OpenSlot {
  id: string; class_key: string; full_day_rate_pkr: number
  event_id: string; event_date: string; venue_address: string; venue_lat: number | null; venue_lng: number | null; distance_km: number; notes: string | null
  customer_name: string; customer_mobile: string | null; customer_trust: Trust | null
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyShadiRequestsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [requests, setRequests] = useState<Request[]>([])
  const [openSlots, setOpenSlots] = useState<OpenSlot[]>([])
  const [classNames, setClassNames] = useState<Record<string, { name_en: string; name_ur: string }>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const [withdrawReason, setWithdrawReason] = useState('')
  const [claimingId, setClaimingId] = useState<string | null>(null)

  const load = (vehicleId: string) => supabase.rpc('vehicle_shadi_requests', { p_vehicle_id: vehicleId }).then(({ data }) => setRequests((data ?? []) as Request[]))
  const loadOpenSlots = (vehicleId: string) => supabase.rpc('shadi_open_slots_for_vehicle', { p_vehicle_id: vehicleId }).then(({ data }) => setOpenSlots((data ?? []) as OpenSlot[]))

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, shadi_vehicle_class').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) {
        // Deterministic, no-op-if-nothing-due sweep — releasing any advance
        // share whose wedding date has now passed happens incidentally on
        // this visit, not on a schedule. Run before loading so a just-
        // released payout already shows up.
        await supabase.rpc('sweep_due_shadi_advances')
        await Promise.all([load(data.id), loadOpenSlots(data.id)])
      }
      setLoading(false)
    })
    supabase.rpc('shadi_vehicle_classes_list').then(({ data }) => {
      const map: Record<string, { name_en: string; name_ur: string }> = {}
      for (const c of (data ?? []) as { class_key: string; name_en: string; name_ur: string }[]) map[c.class_key] = { name_en: c.name_en, name_ur: c.name_ur }
      setClassNames(map)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const claimSlot = async (slotId: string) => {
    if (!vehicle || !confirm(t('vp.confirmClaimSlot'))) return
    setClaimingId(slotId)
    const { error } = await supabase.rpc('claim_shadi_slot', { p_request_id: slotId, p_vehicle_id: vehicle.id })
    setClaimingId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('vp.slotClaimedToast'))
    await Promise.all([load(vehicle.id), loadOpenSlots(vehicle.id)])
  }

  const respond = async (requestId: string, accept: boolean, reason?: string) => {
    if (!vehicle) return
    setBusyId(requestId)
    const { error } = await supabase.rpc('respond_shadi_request', { p_request_id: requestId, p_accept: accept, p_reason: reason ?? null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setDecliningId(null); setDeclineReason('')
    load(vehicle.id)
  }

  const withdraw = async (requestId: string, reason?: string) => {
    if (!vehicle) return
    setBusyId(requestId)
    const { error } = await supabase.rpc('withdraw_shadi_request', { p_request_id: requestId, p_reason: reason ?? null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setWithdrawingId(null); setWithdrawReason('')
    toast.success(t('vp.withdrawnToast'))
    load(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('cm.noVehicleLinked')}</div>

  const today = new Date().toISOString().slice(0, 10)
  const pending = requests.filter((r) => r.status === 'requested')
  const upcoming = requests.filter((r) => r.status === 'accepted' && r.event_date >= today)
  const past = requests.filter((r) => (r.status === 'accepted' && r.event_date < today) || r.status === 'declined' || r.status === 'cancelled' || r.status === 'withdrawn')

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Users2 size={19} /> {t('vp.myShadiRequestsHeading')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.myShadiRequestsSubtitle')}</p>
      </div>

      {vehicle.shadi_vehicle_class ? (
        <Section title={t('vp.availableByTypeHeading')}>
          {openSlots.length === 0 ? (
            <p className="text-center py-6 text-[#94a3b8] text-[13px]">{t('vp.noOpenSlotsHint')}</p>
          ) : (
            openSlots.map((s) => (
              <div key={s.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[14px] font-semibold text-[#1e293b] flex items-center gap-1.5"><Sparkles size={13} className="text-[#D4AF37] shrink-0" /> {classNames[s.class_key] ? (isUrdu ? classNames[s.class_key].name_ur : classNames[s.class_key].name_en) : s.class_key}</p>
                    <p className="font-sans text-[12px] text-[#64748b] mt-0.5 flex items-center gap-1.5"><CalendarDays size={11} /> {new Date(s.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                    <p className="font-sans text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {s.venue_address}</p>
                  </div>
                  <span className="font-bold text-[15px] text-[#166534] ltr-num shrink-0">{fmt(s.full_day_rate_pkr)}</span>
                </div>
                <button onClick={() => claimSlot(s.id)} disabled={claimingId === s.id} className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-2 pt-2 border-t border-[#f1f5f9] rounded-xl font-sans text-[13px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#005A36]">
                  {claimingId === s.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={13} />} {t('vp.claimSlotBtn')}
                </button>
              </div>
            ))
          )}
        </Section>
      ) : (
        <p className="flex items-center gap-1.5 text-[12px] text-[#92400e] bg-amber-50 border border-amber-200 rounded-xl p-2.5"><AlertCircle size={13} className="shrink-0" /> {t('vp.noFleetClassSetHint')}</p>
      )}

      {pending.length > 0 && (
        <Section title={t('vp.newRequestsHeading')}>
          {pending.map((r) => (
            <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <TrustStrip trust={r.customer_trust} />
              <RequestHeader r={r} />
              {decliningId === r.id ? (
                <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                  <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder={t('vp.declineReasonPlaceholder')}
                    className="w-full border border-[#e5e2d0] rounded-xl p-2 font-sans text-[12.5px] mb-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setDecliningId(null)} className="flex-1 py-2 border border-[#e5e2d0] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                    <button onClick={() => respond(r.id, false, declineReason.trim() || undefined)} disabled={busyId === r.id}
                      className="flex-1 py-2 rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#b91c1c]">{t('vp.confirmDeclineBtn')}</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
                  <button onClick={() => setDecliningId(r.id)} disabled={busyId === r.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-[#e5e2d0] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    <X size={13} /> {t('vp.declineBtn')}
                  </button>
                  <button onClick={() => respond(r.id, true)} disabled={busyId === r.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-[#166534] text-white rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    {busyId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t('vp.acceptBtn')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title={t('vp.upcomingWeddingsHeading')}>
          {upcoming.map((r) => (
            <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <RequestHeader r={r} />
              <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                {r.event_status === 'confirmed' && r.advance_share_pkr != null ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="font-sans text-[12px] text-[#64748b]">{t('vp.collectFromCustomerLabel')}</span>
                      <span className="font-bold text-[15px] text-[#166534] ltr-num">{fmt(r.full_day_rate_pkr - r.advance_share_pkr)}</span>
                    </div>
                    <p className="font-sans text-[11px] text-[#64748b] mt-1">{t('vp.advanceHeldHint').replace('{amount}', fmt(r.advance_share_pkr))}</p>
                  </>
                ) : (
                  <p className="font-sans text-[11.5px] text-[#64748b]">{t('vp.awaitingAdvanceHint')}</p>
                )}
              </div>
              {withdrawingId === r.id ? (
                <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                  <input value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} placeholder={t('vp.withdrawReasonPlaceholder')}
                    className="w-full border border-[#e5e2d0] rounded-xl p-2 font-sans text-[12.5px] mb-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setWithdrawingId(null)} className="flex-1 py-2 border border-[#e5e2d0] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                    <button onClick={() => withdraw(r.id, withdrawReason.trim() || undefined)} disabled={busyId === r.id}
                      className="flex-1 py-2 rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#b91c1c]">{t('vp.confirmWithdrawBtn')}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setWithdrawingId(r.id)} disabled={busyId === r.id}
                  className="w-full mt-2 pt-2 border-t border-[#f1f5f9] font-sans text-[11.5px] font-semibold cursor-pointer disabled:opacity-50 text-center text-[#b91c1c]">
                  {t('vp.withdrawBtn')}
                </button>
              )}
            </div>
          ))}
        </Section>
      )}

      {pending.length === 0 && upcoming.length === 0 && past.length === 0 && (
        <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('vp.noShadiRequestsYetHint')}</p>
      )}

      {past.length > 0 && (
        <Section title={t('vp.historyHeading')}>
          {past.map((r) => (
            <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 opacity-70">
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{r.customer_name} — {new Date(r.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                <span className="font-sans text-[10px] font-bold" style={{ color: r.status === 'declined' || r.status === 'withdrawn' ? '#b91c1c' : r.status === 'cancelled' ? '#64748b' : '#166534' }}>{t(`vp.shadiReqStatus.${r.status === 'accepted' ? 'accepted' : r.status}`)}</span>
              </div>
              {(r.status === 'declined' || r.status === 'withdrawn') && r.decline_reason && (
                <p className="flex items-center gap-1.5 font-sans text-[11px] mt-1 text-[#b91c1c]"><AlertCircle size={10} /> {r.decline_reason}</p>
              )}
              {r.status === 'accepted' && r.event_status === 'confirmed' && r.advance_share_pkr != null && (
                <p className="font-sans text-[11px] mt-1" style={r.paid_out_at ? { color: '#166534' } : undefined}>
                  {r.paid_out_at
                    ? `${t('vp.advanceReleasedLabel')}: ${fmt(r.advance_share_pkr)}`
                    : t('vp.advanceStillHeldHint')}
                </p>
              )}
              {r.status === 'accepted' && r.event_status === 'confirmed' && r.event_date < today && (
                <div className="mt-2">
                  <RateAndReport refType="shadi_vehicle_request" refId={r.id} againstPartyType="portal_user" againstPartyId={r.customer_portal_user_id} showComplaint={false} />
                </div>
              )}
            </div>
          ))}
        </Section>
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

function RequestHeader({ r }: { r: Request }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-sans text-[14px] font-semibold text-[#1e293b] flex items-center gap-1.5"><CalendarDays size={13} className="text-[#166534] shrink-0" /> {new Date(r.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
          <p className="font-sans text-[12px] text-[#64748b] mt-0.5 flex items-center gap-1.5 flex-wrap">{r.customer_name}{r.customer_mobile ? <> · <a href={`tel:${r.customer_mobile}`} className="text-[#166534] font-semibold ltr-num underline">{r.customer_mobile}</a></> : null} <TrustPill trust={r.customer_trust} /> · <ChatButton refType="shadi_vehicle_request" refId={r.id} basePath="/portal/my-vehicle/chat" className="inline-flex items-center gap-1 font-sans text-[12px] font-semibold text-[#166534] cursor-pointer" /></p>
          <p className="font-sans text-[12px] text-[#64748b] mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {r.venue_address}</p>
          <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5 flex items-center gap-1 ltr-num"><Ruler size={11} /> {r.distance_km}km</p>
          {r.notes && <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5">{r.notes}</p>}
        </div>
        <span className="font-bold text-[15px] text-[#166534] ltr-num shrink-0">{fmt(r.full_day_rate_pkr)}</span>
      </div>
      {r.venue_lat != null && r.venue_lng != null && (
        <LeafletMap pins={[{ lat: r.venue_lat, lng: r.venue_lng, color: '#166534' }]} height={120} className="rounded-xl mt-2" />
      )}
    </div>
  )
}
