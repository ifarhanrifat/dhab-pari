'use client'

// "My conversations" re-skinned in the new design — same data/logic as
// the page this replaces (my_negotiation_threads, one list for all three
// kinds: fetch/share/pro), just the new visual language.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MessageCircle, Package, Users, Truck, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface ThreadRow {
  id: string; kind: string; status: string; item: string | null; agreed_amount_pkr: number | null
  created_at: string; as_role: 'user' | 'driver'; vehicle_owner_name: string; vehicle_type: string; last_message: string | null
}
const kindIcon = { fetch: Package, share: Users, pro: Truck } as const
const KIND_TINT: Record<string, string> = { fetch: '#ffe4e6', share: '#e0f2fe', pro: '#fde68a' }

export default function NegotiationsInboxPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const [threads, setThreads] = useState<ThreadRow[] | null>(null)

  useEffect(() => {
    if (!user) return
    supabase.rpc('my_negotiation_threads').then(({ data }) => setThreads((data ?? []) as ThreadRow[]))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || threads === null) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><MessageCircle size={19} /> {t('vp.myConversationsTitle')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.myConversationsSubtitle')}</p>
      </div>

      {threads.length === 0 && (
        <div className="border-2 border-dashed border-[#e5e2d0] rounded-2xl p-6 text-center text-[13px] text-[#94a3b8]">{t('vp.noConversationsYet')}</div>
      )}

      {threads.map((th) => {
        const KindIcon = kindIcon[th.kind as keyof typeof kindIcon] ?? Package
        return (
          <Link key={th.id} href={`/portal/marketplace/negotiations/${th.id}`} className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
            <span className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: KIND_TINT[th.kind] ?? '#f1f5f9' }}><KindIcon size={17} className="text-[#1e293b]" /></span>
            <div className="flex-1 min-w-0">
              <p className="text-[13.5px] font-bold text-[#1e293b] truncate">{th.item}</p>
              <p className="text-[11.5px] text-[#64748b] truncate">{th.as_role === 'user' ? th.vehicle_owner_name : t('vp.incomingRequestLabel')}{th.last_message ? ` · ${th.last_message}` : ''}</p>
            </div>
            <div className="shrink-0">
              {th.status === 'agreed' && <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-[#dcfce7] text-[#166534]"><CheckCircle2 size={10} /> {t('vp.agreedStatusLabel')}</span>}
              {th.status === 'open' && <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-[#fef3c7] text-[#92400e]"><Clock size={10} /> {t('vp.openStatusLabel')}</span>}
              {(th.status === 'declined' || th.status === 'cancelled') && <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-[#f1f5f9] text-[#64748b]"><XCircle size={10} /> {t('vp.closedStatusLabel')}</span>}
            </div>
          </Link>
        )
      })}
    </div>
  )
}
