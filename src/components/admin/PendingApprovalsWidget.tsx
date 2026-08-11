'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ShieldCheck, Send } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Request { id: string; system: string; kind: string; particular: string; amount_pkr: number; created_at: string }
interface RosterName { id: string; full_name: string }

const systemLabels: Record<string, string> = { water_supply: 'Water Supply', donors_projects: 'Donors & Projects' }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function PendingApprovalsWidget() {
  const { t } = useLocale()
  const supabase = createClient()
  const [requests, setRequests] = useState<Request[]>([])
  const [waitingOn, setWaitingOn] = useState<Record<string, string[]>>({})
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const { data: pending } = await supabase.from('approval_requests').select('id, system, kind, particular, amount_pkr, created_at').eq('status', 'pending').order('created_at', { ascending: false })
    setRequests(pending ?? [])

    if ((pending ?? []).length > 0) {
      const { data: confirmations } = await supabase.from('approval_confirmations').select('approval_request_id, approver_id, confirmed').in('approval_request_id', (pending ?? []).map((r) => r.id)).is('confirmed', null)
      const systemsPresent = Array.from(new Set((pending ?? []).map((r) => r.system)))
      const nameMap: Record<string, string> = {}
      for (const sys of systemsPresent) {
        const { data: roster } = await supabase.rpc('get_approvers_roster', { p_system: sys })
        for (const person of (roster ?? []) as RosterName[]) nameMap[person.id] = person.full_name
      }
      const grouped: Record<string, string[]> = {}
      for (const c of confirmations ?? []) {
        (grouped[c.approval_request_id] ??= []).push(nameMap[c.approver_id] ?? 'Approver')
      }
      setWaitingOn(grouped)
    } else {
      setWaitingOn({})
    }
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const resend = async (id: string) => {
    setResendingId(id)
    const { error } = await supabase.rpc('resend_approval_notifications', { p_request_id: id })
    setResendingId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Reminder sent')
  }

  if (loading || requests.length === 0) return null

  return (
    <div className="bg-white rounded-lg border border-amber-300 overflow-hidden mb-8">
      <div className="px-5 py-3.5 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-sans text-[14px] font-bold text-amber-900">
          <ShieldCheck size={16} /> Awaiting Approval ({requests.length})
        </span>
        <Link href="/admin/approvals" className="font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline">{t('y.openApprovals')}</Link>
      </div>
      <div>
        {requests.map((r) => {
          const waiting = waitingOn[r.id] ?? []
          return (
            <div key={r.id} className="flex items-center justify-between gap-3 px-5 py-3 border-t border-dp-outline-variant first:border-t-0 flex-wrap">
              <div className="min-w-0">
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{r.particular}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">
                  {systemLabels[r.system]} · Rs. {fmt(r.amount_pkr)} · Waiting on: {waiting.length > 0 ? waiting.join(', ') : 'all confirmed'}
                </p>
              </div>
              <button
                disabled={resendingId === r.id || waiting.length === 0}
                onClick={() => resend(r.id)}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-40"
              >
                <Send size={12} /> {t('y.resend')}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
