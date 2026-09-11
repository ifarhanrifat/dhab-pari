'use client'

// Driver's side of shadi (wedding) booking requests (478): accept or
// decline each hand-picked request against the flat full-day rate the
// committee set. No start/end trip here — once an event's advance is
// confirmed there's nothing left to do in-app; the driver just shows up
// on the day and collects the balance (full-day rate minus their share
// of the advance) directly from the customer. A past event_date is
// purely a display distinction (history), not a status change.

import { useEffect, useState } from 'react'
import { Users2, CalendarDays, MapPin, Ruler, Check, X, Loader2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { TrustPill, TrustStrip, type Trust } from '@/components/shared/TrustBadge'

interface Vehicle { id: string; owner_name: string }
interface Request {
  id: string; status: string; decline_reason: string | null; full_day_rate_pkr: number; advance_share_pkr: number | null
  event_id: string; event_date: string; venue_address: string; distance_km: number; notes: string | null; event_status: string
  customer_name: string; customer_mobile: string | null; paid_out_at: string | null; customer_trust: Trust | null
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
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const [withdrawReason, setWithdrawReason] = useState('')

  const load = (vehicleId: string) => supabase.rpc('vehicle_shadi_requests', { p_vehicle_id: vehicleId }).then(({ data }) => setRequests((data ?? []) as Request[]))

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) {
        // Deterministic, no-op-if-nothing-due sweep — releasing any advance
        // share whose wedding date has now passed happens incidentally on
        // this visit, not on a schedule. Run before loading so a just-
        // released payout already shows up.
        await supabase.rpc('sweep_due_shadi_advances')
        await load(data.id)
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

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

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('cm.noVehicleLinked')}</div>

  const today = new Date().toISOString().slice(0, 10)
  const pending = requests.filter((r) => r.status === 'requested')
  const upcoming = requests.filter((r) => r.status === 'accepted' && r.event_date >= today)
  const past = requests.filter((r) => (r.status === 'accepted' && r.event_date < today) || r.status === 'declined' || r.status === 'cancelled' || r.status === 'withdrawn')

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <h1 className="font-heading text-[24px] font-bold text-dp-primary flex items-center gap-2 mb-1"><Users2 size={22} /> {t('vp.myShadiRequestsHeading')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('vp.myShadiRequestsSubtitle')}</p>

      {pending.length > 0 && (
        <Section title={t('vp.newRequestsHeading')}>
          {pending.map((r) => (
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <TrustStrip trust={r.customer_trust} />
              <RequestHeader r={r} />
              {decliningId === r.id ? (
                <div className="mt-2 pt-2 border-t border-dp-outline-variant">
                  <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder={t('vp.declineReasonPlaceholder')}
                    className="w-full border border-dp-outline-variant rounded-lg p-2 font-sans text-[12.5px] mb-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setDecliningId(null)} className="flex-1 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                    <button onClick={() => respond(r.id, false, declineReason.trim() || undefined)} disabled={busyId === r.id}
                      className="flex-1 py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer text-white disabled:opacity-50" style={{ background: '#b3261e' }}>{t('vp.confirmDeclineBtn')}</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-dp-outline-variant">
                  <button onClick={() => setDecliningId(r.id)} disabled={busyId === r.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    <X size={13} /> {t('vp.declineBtn')}
                  </button>
                  <button onClick={() => respond(r.id, true)} disabled={busyId === r.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50 hover:bg-dp-primary transition-all">
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
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <RequestHeader r={r} />
              <div className="mt-2 pt-2 border-t border-dp-outline-variant">
                {r.event_status === 'confirmed' && r.advance_share_pkr != null ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="font-sans text-[12px] text-dp-on-surface-variant">{t('vp.collectFromCustomerLabel')}</span>
                      <span className="font-heading text-[15px] font-bold ltr-num" style={{ color: '#0f7a4d' }}>{fmt(r.full_day_rate_pkr - r.advance_share_pkr)}</span>
                    </div>
                    <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('vp.advanceHeldHint').replace('{amount}', fmt(r.advance_share_pkr))}</p>
                  </>
                ) : (
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('vp.awaitingAdvanceHint')}</p>
                )}
              </div>
              {withdrawingId === r.id ? (
                <div className="mt-2 pt-2 border-t border-dp-outline-variant">
                  <input value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} placeholder={t('vp.withdrawReasonPlaceholder')}
                    className="w-full border border-dp-outline-variant rounded-lg p-2 font-sans text-[12.5px] mb-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setWithdrawingId(null)} className="flex-1 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                    <button onClick={() => withdraw(r.id, withdrawReason.trim() || undefined)} disabled={busyId === r.id}
                      className="flex-1 py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer text-white disabled:opacity-50" style={{ background: '#b3261e' }}>{t('vp.confirmWithdrawBtn')}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setWithdrawingId(r.id)} disabled={busyId === r.id}
                  className="w-full mt-2 pt-2 border-t border-dp-outline-variant font-sans text-[11.5px] font-semibold cursor-pointer disabled:opacity-50 text-center" style={{ color: '#b3261e' }}>
                  {t('vp.withdrawBtn')}
                </button>
              )}
            </div>
          ))}
        </Section>
      )}

      {pending.length === 0 && upcoming.length === 0 && past.length === 0 && (
        <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('vp.noShadiRequestsYetHint')}</p>
      )}

      {past.length > 0 && (
        <Section title={t('vp.historyHeading')}>
          {past.map((r) => (
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-3 opacity-70">
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface truncate">{r.customer_name} — {new Date(r.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                <span className="font-sans text-[10px] font-bold" style={{ color: r.status === 'declined' || r.status === 'withdrawn' ? '#b3261e' : r.status === 'cancelled' ? '#6b6560' : '#0f7a4d' }}>{t(`vp.shadiReqStatus.${r.status === 'accepted' ? 'accepted' : r.status}`)}</span>
              </div>
              {(r.status === 'declined' || r.status === 'withdrawn') && r.decline_reason && (
                <p className="flex items-center gap-1.5 font-sans text-[11px] mt-1" style={{ color: '#b3261e' }}><AlertCircle size={10} /> {r.decline_reason}</p>
              )}
              {r.status === 'accepted' && r.event_status === 'confirmed' && r.advance_share_pkr != null && (
                <p className="font-sans text-[11px] mt-1" style={{ color: r.paid_out_at ? '#0f7a4d' : undefined }}>
                  {r.paid_out_at
                    ? `${t('vp.advanceReleasedLabel')}: ${fmt(r.advance_share_pkr)}`
                    : t('vp.advanceStillHeldHint')}
                </p>
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
    <div className="mb-5">
      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-2">{title}</p>
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}

function RequestHeader({ r }: { r: Request }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5"><CalendarDays size={13} className="text-dp-secondary shrink-0" /> {new Date(r.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1.5">{r.customer_name}{r.customer_mobile ? ` · ${r.customer_mobile}` : ''} <TrustPill trust={r.customer_trust} /></p>
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-start gap-1"><MapPin size={11} className="shrink-0 mt-0.5" /> {r.venue_address}</p>
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1 ltr-num"><Ruler size={11} /> {r.distance_km}km</p>
        {r.notes && <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{r.notes}</p>}
      </div>
      <span className="font-heading text-[15px] font-bold text-dp-secondary ltr-num shrink-0">{fmt(r.full_day_rate_pkr)}</span>
    </div>
  )
}
