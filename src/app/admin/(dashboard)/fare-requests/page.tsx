'use client'

// 860: committee review queue for owner-submitted fare-readjustment
// requests (route_fare_change_requests) — the admin-side half of the
// new fleet dashboard's fare-request workflow. Modeled on vehicle-
// registrations/page.tsx's own pending-queue shape; approval/rejection
// is handled by committee_approve_fare_change/committee_reject_fare_change
// (860), both already gated server-side on manage_parties.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { TicketSlash, CheckCircle2, XCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FareRequest {
  id: string; route_id: string; origin: string; destination: string; vehicle_owner_name: string
  current_fare_per_seat_pkr: number; requested_fare_per_seat_pkr: number; reason: string | null; created_at: string
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function AdminFareRequestsPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [rows, setRows] = useState<FareRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    const { data } = await supabase.rpc('admin_pending_fare_change_requests')
    setRows((data ?? []) as FareRequest[])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const approve = async (id: string) => {
    setBusy(id)
    const { error } = await supabase.rpc('committee_approve_fare_change', { p_request_id: id })
    setBusy(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.fareRequestApprovedToast'))
    load()
  }

  const reject = async () => {
    if (!rejectingId) return
    setBusy(rejectingId)
    const { error } = await supabase.rpc('committee_reject_fare_change', { p_request_id: rejectingId, p_reason: rejectReason || null })
    setBusy(null)
    if (error) { toast.error(friendlyError(error)); return }
    setRejectingId(null); setRejectReason('')
    load()
  }

  if (access.loading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="text-center py-12 font-sans text-[13px] text-[#64748b]">{t('dn.noAccessMessage')}</div>
  }

  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <h1 className="font-bold text-[20px] flex items-center gap-2"><TicketSlash size={19} /> {t('nav.fareRequests')}</h1>

      {rows.length === 0 ? (
        <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFareRequestsYetHint')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
              <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">{r.origin} → {r.destination}</p>
              <p className="font-sans text-[12px] text-[#64748b] mt-0.5">{r.vehicle_owner_name}</p>
              <p className="font-sans text-[13px] mt-1.5 ltr-num">₨{fmt(r.current_fare_per_seat_pkr)} → <span className="font-bold text-[#166534]">₨{fmt(r.requested_fare_per_seat_pkr)}</span></p>
              {r.reason && <p className="font-sans text-[12px] text-[#64748b] mt-1">{r.reason}</p>}

              {rejectingId === r.id ? (
                <div className="mt-2.5 flex gap-2">
                  <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder={t('vreg.reasonPlaceholder')}
                    className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                  <button onClick={reject} disabled={busy === r.id} className="shrink-0 px-3 py-2 rounded-lg bg-[#b91c1c] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{t('action.confirm')}</button>
                  <button onClick={() => setRejectingId(null)} className="shrink-0 px-3 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] cursor-pointer">{t('action.cancel')}</button>
                </div>
              ) : (
                <div className="mt-2.5 flex gap-2">
                  <button onClick={() => approve(r.id)} disabled={busy === r.id} className="flex-1 px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                    <CheckCircle2 size={14} /> {t('action.approve')}
                  </button>
                  <button onClick={() => setRejectingId(r.id)} className="flex-1 px-3 py-2 rounded-lg border border-[#e5e2d0] text-[#b91c1c] font-sans text-[12.5px] font-bold cursor-pointer flex items-center justify-center gap-1.5">
                    <XCircle size={14} /> {t('action.reject')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
