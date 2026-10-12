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
import { LoadingDots } from '@/components/shared/LoadingDots'

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
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="mt-10 pt-8 border-t border-dp2-card-border">
      <h3 className="font-heading text-[19px] font-bold text-dp2-primary flex items-center gap-2 mb-4">
        <MessageCircle size={18} className="text-dp2-primary-dark" /> {t('nc.comments')} {comments.length > 0 && `(${comments.length})`}
      </h3>

      <div className="mb-6">
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={2}
          placeholder={staffUser ? t('nc.commentingAs').replace('{name}', staffUser.full_name).replace('{role}', STAFF_ROLE_LABEL[staffUser.role] ?? staffUser.role) : portalUser ? t('nc.shareThoughts') : t('nc.logInToComment')}
          className="w-full px-4 py-3 border border-dp2-card-border rounded-xl font-sans text-[15px] resize-none focus:border-dp2-primary-dark transition-all"
        />
        <button onClick={post} disabled={posting || !text.trim()} className="mt-2 flex items-center gap-1.5 bg-dp2-primary-dark text-white px-4 py-2 rounded-xl font-sans text-[14px] font-semibold cursor-pointer hover:brightness-110 transition-all disabled:opacity-50">
          <Send size={13} className={isUrdu ? 'rotate-180' : ''} /> {t('nc.post')}
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-slate-500"><LoadingDots /></p>
      ) : comments.length === 0 ? (
        <p className="font-sans text-[14px] text-slate-500">{t('nc.noComments')}</p>
      ) : (
        <div className="space-y-4">
          {comments.map((c) => (
            <div key={c.id} className="flex items-start gap-3">
              {c.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-dp2-surface flex items-center justify-center shrink-0 font-sans text-[13px] font-bold text-dp2-primary">
                  {(c.username ?? '?').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-sans text-[14px] font-bold text-slate-800">{c.username}</span>
                  {c.comment_type === 'staff' ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold font-sans px-1.5 py-0.5 rounded-full bg-dp2-primary/10 text-dp2-primary whitespace-nowrap">
                      <ShieldCheck size={10} /> {c.staff_role ? (STAFF_ROLE_LABEL[c.staff_role] ?? c.staff_role) : 'Staff'}
                    </span>
                  ) : (
                    <DonorBadge tier={c.badge_tier} isUrdu={isUrdu} size="xs" iconOnly />
                  )}
                  <span className="font-sans text-[12px] text-slate-500">{new Date(c.created_at).toLocaleDateString()}</span>
                </div>
                <p className="font-sans text-[14.5px] text-slate-800 mt-0.5 leading-relaxed">{c.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
