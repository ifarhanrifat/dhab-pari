'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { Gift } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Pledge {
  id: string; side: string; amount: number; status: string; created_at: string
  village_events: { title: string; title_ur: string | null; start_datetime: string } | null
}

// Phase 3, 2026-09-30. Real gap created by the salami privacy fix: once
// the public board stopped listing individual names/amounts, a giver had
// no way left to check whether their own announced pledge had been
// marked received -- this is that private view, scoped to their own
// pledges only (event_salami_pledges_self_read, migration 541).
export default function MySalamiPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [pledges, setPledges] = useState<Pledge[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    supabase.from('event_salami_pledges').select('id, side, amount, status, created_at, village_events(title, title_ur, start_datetime)')
      .eq('giver_portal_user_id', user.id).order('created_at', { ascending: false })
      .then(({ data }) => { setPledges((data ?? []) as unknown as Pledge[]); setLoading(false) })
  }, [user])

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2 mb-6"><Gift size={22} className="text-dp-secondary" /> {t('sl.myPledges')}</h1>
      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : pledges.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('sl.noPledgesYet')}</p>
          <Link href="/events" className="text-dp-secondary font-sans text-[13px] font-semibold mt-2 inline-block hover:underline">{t('ve.pageTitle')} →</Link>
        </div>
      ) : (
        <div className="space-y-3 max-w-xl">
          {pledges.map((p) => (
            <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface truncate">{p.village_events ? (isUrdu && p.village_events.title_ur ? p.village_events.title_ur : p.village_events.title) : '—'}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{t(`sl.side.${p.side}`)}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="font-sans text-[15px] font-bold text-dp-on-surface ltr-num">{Number(p.amount).toLocaleString()}</p>
                <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full uppercase ${p.status === 'received' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  {p.status === 'received' ? t('sl.confirmed') : t('sl.pending')}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
