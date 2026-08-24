'use client'

// Blog post comments (migration 328) — same author-resolution pattern as
// the project comments/staff-comments work: a portal user comments with
// their donor badge, staff comment tagged with their role, admin sees
// everything (RLS already grants that; nothing extra needed here).
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { MessageCircle, ShieldCheck, Send } from 'lucide-react'
import { DonorBadge } from '@/components/public/DonorBadge'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import type { DonorBadgeTier } from '@/lib/donorBadges'

const STAFF_ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin', admin: 'Admin', accountant: 'Accountant',
  water_accountant: 'Water Accountant', donor_accountant: 'Donor Accountant',
  publisher: 'Publisher', viewer: 'Viewer',
}

interface CommentRow {
  id: string; content: string; created_at: string; comment_type: string
  portal_user_id: string | null; admin_user_id: string | null
  username: string | null; avatar_url: string | null; badge_tier: DonorBadgeTier | null; staff_role: string | null
}

export function NewsComments({ newsPostId }: { newsPostId: string }) {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const supabase = createClient()
  const [comments, setComments] = useState<CommentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [portalUser, setPortalUser] = useState<{ id: string } | null>(null)
  const [staffUser, setStaffUser] = useState<{ id: string; full_name: string; role: string } | null>(null)
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)

  const load = async () => {
    const { data } = await supabase.from('news_comments_public').select('*').eq('news_post_id', newsPostId).order('created_at')
    setComments((data ?? []) as CommentRow[])
    setLoading(false)

    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return
    const { data: pu } = await supabase.from('portal_users').select('id').eq('auth_user_id', authUser.id).maybeSingle()
    setPortalUser(pu ?? null)
    if (!pu) {
      const { data: au } = await supabase.from('admin_users').select('id, full_name, role').eq('auth_user_id', authUser.id).eq('is_active', true).maybeSingle()
      setStaffUser(au ?? null)
    }
  }
  useEffect(() => { load() }, [newsPostId]) // eslint-disable-line react-hooks/exhaustive-deps

  const post = async () => {
    if (!portalUser && !staffUser) { router.push(`/portal/login?next=/news/${newsPostId}`); return }
    const content = text.trim()
    if (!content) return
    setPosting(true)
    const { error } = await supabase.from('news_comments').insert({
      news_post_id: newsPostId, content,
      admin_user_id: staffUser?.id ?? null, portal_user_id: staffUser ? null : (portalUser?.id ?? null),
      comment_type: staffUser ? 'staff' : 'user',
    })
    setPosting(false)
    if (!error) { setText(''); load() }
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="mt-10 pt-8 border-t border-dp-outline-variant">
      <h3 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2 mb-4">
        <MessageCircle size={18} className="text-dp-secondary" /> {t('nc.comments')} {comments.length > 0 && `(${comments.length})`}
      </h3>

      <div className="mb-6">
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={2}
          placeholder={staffUser ? t('nc.commentingAs').replace('{name}', staffUser.full_name).replace('{role}', STAFF_ROLE_LABEL[staffUser.role] ?? staffUser.role) : portalUser ? t('nc.shareThoughts') : t('nc.logInToComment')}
          className="w-full px-4 py-3 border border-dp-outline-variant rounded-lg font-sans text-[14px] resize-none focus:border-dp-secondary transition-all"
        />
        <button onClick={post} disabled={posting || !text.trim()} className="mt-2 flex items-center gap-1.5 bg-dp-secondary text-white px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          <Send size={13} className={isUrdu ? 'rotate-180' : ''} /> {t('nc.post')}
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('action.loading')}</p>
      ) : comments.length === 0 ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('nc.noComments')}</p>
      ) : (
        <div className="space-y-4">
          {comments.map((c) => (
            <div key={c.id} className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-dp-surface-container-low flex items-center justify-center shrink-0 font-sans text-[12px] font-bold text-dp-primary">
                {(c.username ?? '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-sans text-[13px] font-bold text-dp-on-surface">{c.username}</span>
                  {c.comment_type === 'staff' ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-bold font-sans px-1.5 py-0.5 rounded-full bg-dp-primary/10 text-dp-primary whitespace-nowrap">
                      <ShieldCheck size={10} /> {c.staff_role ? (STAFF_ROLE_LABEL[c.staff_role] ?? c.staff_role) : 'Staff'}
                    </span>
                  ) : (
                    <DonorBadge tier={c.badge_tier} isUrdu={isUrdu} size="xs" iconOnly />
                  )}
                  <span className="font-sans text-[11px] text-dp-on-surface-variant">{new Date(c.created_at).toLocaleDateString()}</span>
                </div>
                <p className="font-sans text-[13.5px] text-dp-on-surface mt-0.5 leading-relaxed">{c.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
