'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Trophy, Lock, CheckCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Achievement { id: string; done_at: string; is_private: boolean; text_ur: string | null; done_by_name: string | null }

// Public progress record — "show the committee and committee members'
// progress to the village people and overseas village people." Private
// items still appear (so the total volume of work is honest and visible)
// but with the detail withheld, only who completed it — matches the
// stated privacy direction exactly.
export default function AchievementsPage() {
  const { t } = useLocale()
  const [items, setItems] = useState<Achievement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    createClient().from('achievements_public').select('*').then(({ data }) => { setItems(data ?? []); setLoading(false) })
  }, [])

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="mb-10">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3"><Trophy size={28} className="text-dp-secondary" /> {t('x.ourAchievements')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2">
          Completed work by the committee and its members — a running record for the village, and for everyone watching from overseas.
        </p>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant text-center py-16">{t('action.loading')}</p>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">{t('x.nothingCompletedYet')}</div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-start gap-3">
              {a.is_private ? <Lock size={18} className="text-dp-on-surface-variant shrink-0 mt-0.5" /> : <CheckCircle size={18} className="text-dp-secondary shrink-0 mt-0.5" />}
              <div className="min-w-0 flex-1">
                {a.is_private ? (
                  <p className="font-sans text-[14.5px] text-dp-on-surface-variant italic">{t('x.privateCompletedBy')} <span className="font-semibold not-italic">{a.done_by_name ?? 'a committee member'}</span></p>
                ) : (
                  <>
                    <p className="font-sans text-[15px] text-dp-on-surface" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{a.text_ur}</p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{t('x.completedBy')} <span className="font-semibold">{a.done_by_name ?? 'a committee member'}</span></p>
                  </>
                )}
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{new Date(a.done_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
