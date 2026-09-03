'use client'

// "My conversations" — every negotiation_threads row I'm a party to,
// either as the requesting villager or as the vehicle owner being asked.
// One list for all three kinds (fetch/share/pro); each row deep-links
// into the shared chat screen.

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

export default function NegotiationsInboxPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const [threads, setThreads] = useState<ThreadRow[] | null>(null)

  useEffect(() => {
    if (!user) return
    supabase.rpc('my_negotiation_threads').then(({ data }) => setThreads((data ?? []) as ThreadRow[]))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || threads === null) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><MessageCircle size={22} className="text-dp-secondary" /> {t('vp.myConversationsTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vp.myConversationsSubtitle')}</p>
      </div>

      {threads.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('vp.noConversationsYet')}</p>}

      <div className="space-y-2">
        {threads.map((th) => {
          const KindIcon = kindIcon[th.kind as keyof typeof kindIcon] ?? Package
          return (
            <Link key={th.id} href={`/portal/marketplace/negotiations/${th.id}`} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
              <div className="flex items-start gap-2.5 min-w-0">
                <KindIcon size={16} className="text-dp-secondary shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{th.item}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 truncate">{th.as_role === 'user' ? th.vehicle_owner_name : t('vp.incomingRequestLabel')}{th.last_message ? ` · ${th.last_message}` : ''}</p>
                </div>
              </div>
              <div className="shrink-0">
                {th.status === 'agreed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('vp.agreedStatusLabel')}</span>}
                {th.status === 'open' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('vp.openStatusLabel')}</span>}
                {(th.status === 'declined' || th.status === 'cancelled') && <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[11px] font-bold"><XCircle size={11} /> {t('vp.closedStatusLabel')}</span>}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
