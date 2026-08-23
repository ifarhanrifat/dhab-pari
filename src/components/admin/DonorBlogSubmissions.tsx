'use client'

// The moderation queue for donor-submitted blog posts (migration 312) — a
// small panel above the regular Blog list, not a new editing surface.
// Approving is exactly "publish"; the post then behaves like any other
// blog post everywhere else (including PostsManager's own list below).

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { CheckCircle2, XCircle, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonorBadge } from '@/components/public/DonorBadge'
import type { DonorBadgeTier } from '@/lib/donorBadges'

interface Submission {
  id: string; title: string; title_ur: string | null; content: string; author: string
  created_at: string; submitted_by_portal_user_id: string
}

export function DonorBlogSubmissions() {
  const { t, isUrdu } = useLocale()
  const [rows, setRows] = useState<Submission[]>([])
  const [tiers, setTiers] = useState<Record<string, DonorBadgeTier>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('news_posts')
      .select('id, title, title_ur, content, author, created_at, submitted_by_portal_user_id')
      .eq('category', 'blog').eq('moderation_status', 'pending').order('created_at', { ascending: true })
    const subs = (data ?? []) as Submission[]
    setRows(subs)
    const ids = subs.map((s) => s.submitted_by_portal_user_id)
    if (ids.length) {
      const { data: badges } = await supabase.from('donor_badges_admin').select('portal_user_id, badge_tier').in('portal_user_id', ids)
      const m: Record<string, DonorBadgeTier> = {}
      ;((badges ?? []) as { portal_user_id: string; badge_tier: DonorBadgeTier | null }[]).forEach((b) => { if (b.badge_tier) m[b.portal_user_id] = b.badge_tier })
      setTiers(m)
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async (id: string) => {
    setBusyId(id)
    const { error } = await supabase.from('news_posts')
      .update({ is_published: true, moderation_status: 'approved', published_at: new Date().toISOString() }).eq('id', id)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('db.blog.approvedToast'))
    load()
  }
  const reject = async (id: string) => {
    if (!confirm(t('db.blog.confirmReject'))) return
    setBusyId(id)
    const { error } = await supabase.from('news_posts').update({ moderation_status: 'rejected' }).eq('id', id)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('db.blog.rejectedToast'))
    load()
  }

  if (rows.length === 0) return null

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-5 mb-6">
      <h2 className="font-heading text-[16px] font-bold text-amber-900 flex items-center gap-2 mb-3">
        <Clock size={17} /> {t('db.blog.pendingTitle')} ({rows.length})
      </h2>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.id} className="bg-white border border-amber-200 rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <p className="font-sans text-[14px] font-bold text-dp-on-surface">{r.author}</p>
                  <DonorBadge tier={tiers[r.submitted_by_portal_user_id]} isUrdu={isUrdu} size="xs" />
                </div>
                <p className="font-sans text-[15px] font-bold text-dp-primary">{r.title}</p>
                {r.title_ur && <p className="font-sans text-[14px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>{r.title_ur}</p>}
                <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1.5 line-clamp-3">{r.content}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button disabled={busyId === r.id} onClick={() => approve(r.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                  <CheckCircle2 size={14} /> {t('db.blog.approve')}
                </button>
                <button disabled={busyId === r.id} onClick={() => reject(r.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-error rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-error/5 transition-all disabled:opacity-50">
                  <XCircle size={14} /> {t('db.blog.reject')}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
