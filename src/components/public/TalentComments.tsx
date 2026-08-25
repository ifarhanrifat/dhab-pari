'use client'

// Comment section for a public Talent Showcase card — post, like, flag.
// Deliberately not gated on support_status: a need being met is exactly
// when people are most likely to want to say something, so this keeps
// working after 'fulfilled' the same as before (migration 345's own
// comment explains why). Flat (no reply threads), unlike the project
// discussion this otherwise mirrors — villagers cheering someone on
// doesn't need nested threads the way project spending questions do.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MessageCircle, ThumbsUp, Flag } from 'lucide-react'
import { DonorBadge } from '@/components/public/DonorBadge'
import type { DonorBadgeTier } from '@/lib/donorBadges'

interface CommentRow {
  id: string; content: string; created_at: string; portal_user_id: string
  username: string | null; avatar_url: string | null; badge_tier: DonorBadgeTier | null; like_count: number
}

export function TalentComments({ talentShowcaseId }: { talentShowcaseId: string }) {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const [comments, setComments] = useState<CommentRow[]>([])
  const [myLikes, setMyLikes] = useState<Set<string>>(new Set())
  const [portalUserId, setPortalUserId] = useState<string | null>(null)
  const [newComment, setNewComment] = useState('')
  const [posting, setPosting] = useState(false)

  const load = async () => {
    const supabase = createClient()
    const { data } = await supabase.from('talent_showcase_comments_public').select('*').eq('talent_showcase_id', talentShowcaseId).order('created_at', { ascending: false })
    setComments((data ?? []) as CommentRow[])

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: pu } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).maybeSingle()
      setPortalUserId(pu?.id ?? null)
      if (pu && (data ?? []).length > 0) {
        const { data: likeRows } = await supabase.from('talent_showcase_comment_likes').select('comment_id').eq('portal_user_id', pu.id).in('comment_id', (data ?? []).map((c) => c.id))
        setMyLikes(new Set((likeRows ?? []).map((l) => l.comment_id)))
      }
    }
  }
  useEffect(() => { load() }, [talentShowcaseId]) // eslint-disable-line react-hooks/exhaustive-deps

  const requireLogin = () => {
    if (portalUserId) return true
    router.push('/portal/login?next=/talent')
    return false
  }

  const postComment = async () => {
    if (!requireLogin()) { toast.error(t('talent.loginToComment')); return }
    if (!newComment.trim()) return
    setPosting(true)
    const { error } = await createClient().from('talent_showcase_comments').insert({
      talent_showcase_id: talentShowcaseId, portal_user_id: portalUserId, content: newComment.trim(),
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setNewComment('')
    load()
  }

  const toggleLike = async (commentId: string) => {
    if (!requireLogin()) { toast.error(t('talent.loginToComment')); return }
    const supabase = createClient()
    if (myLikes.has(commentId)) {
      await supabase.from('talent_showcase_comment_likes').delete().eq('comment_id', commentId).eq('portal_user_id', portalUserId!)
    } else {
      await supabase.from('talent_showcase_comment_likes').insert({ comment_id: commentId, portal_user_id: portalUserId })
    }
    load()
  }

  const flagComment = async (commentId: string) => {
    if (!requireLogin()) { toast.error(t('talent.loginToComment')); return }
    const reason = window.prompt(t('talent.flagReasonPrompt'))
    if (reason === null) return
    const { error } = await createClient().rpc('flag_talent_showcase_comment', { p_comment_id: commentId, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('talent.flagged'))
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="mt-4 pt-4 border-t border-dp-outline-variant">
      <p className="flex items-center gap-1.5 font-sans text-[12.5px] font-bold text-dp-on-surface mb-2.5"><MessageCircle size={14} className="text-dp-secondary" /> {t('talent.comments')}</p>

      <div className="flex items-center gap-2 mb-3">
        <input
          value={newComment} onChange={(e) => setNewComment(e.target.value)}
          placeholder={portalUserId ? t('talent.commentPlaceholder') : t('talent.loginToComment')}
          className="input-field flex-1 text-[12.5px] py-2"
          onKeyDown={(e) => { if (e.key === 'Enter') postComment() }}
        />
        <button onClick={postComment} disabled={posting} className="bg-dp-secondary text-white px-3 py-2 rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 shrink-0">
          {t('talent.postComment')}
        </button>
      </div>

      {comments.length === 0 ? (
        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('talent.noComments')}</p>
      ) : (
        <div className="space-y-2.5">
          {comments.map((c) => (
            <div key={c.id} className="flex items-start gap-2.5">
              {c.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-7 h-7 rounded-full bg-dp-secondary-container flex items-center justify-center text-[11px] font-bold text-dp-on-secondary-container shrink-0">{(c.username ?? '?').charAt(0).toUpperCase()}</div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-sans text-[12.5px] font-bold text-dp-on-surface">{c.username}</span>
                  <DonorBadge tier={c.badge_tier} isUrdu={isUrdu} size="xs" iconOnly />
                  <span className="font-sans text-[10.5px] text-dp-on-surface-variant">{new Date(c.created_at).toLocaleDateString('en-GB')}</span>
                </div>
                <p className="font-sans text-[13px] text-dp-on-surface mt-0.5">{c.content}</p>
                <div className="flex items-center gap-3 mt-1">
                  <button onClick={() => toggleLike(c.id)} className={`flex items-center gap-1 text-[11px] font-sans font-semibold cursor-pointer ${myLikes.has(c.id) ? 'text-dp-secondary' : 'text-dp-on-surface-variant hover:text-dp-secondary'}`}>
                    <ThumbsUp size={11} /> {c.like_count > 0 ? c.like_count : ''}
                  </button>
                  <button onClick={() => flagComment(c.id)} className="flex items-center gap-1 text-[11px] font-sans font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
                    <Flag size={11} /> {t('talent.flag')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
