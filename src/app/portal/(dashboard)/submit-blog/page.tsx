'use client'

// A donor at Platinum (river) or above can submit their own blog post here —
// migration 312. It lands as an ordinary pending news_posts row; once
// staff approves it on the admin Blog page, it's a real published post
// with this donor's own badge next to the byline, same as any other post.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { NotebookPen, Lock, Clock, CheckCircle2, XCircle, Send } from 'lucide-react'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonorBadge } from '@/components/public/DonorBadge'
import { canFastTrack, type DonorBadgeTier } from '@/lib/donorBadges'

interface Submission {
  id: string; title: string; title_ur: string | null; is_published: boolean
  moderation_status: 'pending' | 'approved' | 'rejected'; created_at: string
}

const empty = { title: '', title_ur: '', content: '', content_ur: '', cover_image_url: '' }

export default function SubmitBlogPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [tier, setTier] = useState<DonorBadgeTier | null | undefined>(undefined)
  const [mine, setMine] = useState<Submission[]>([])
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)
  const supabase = createClient()

  const load = async () => {
    if (!user) return
    const { data: t2 } = await supabase.rpc('donor_badge_tier', { p_portal_user_id: user.id })
    setTier((t2 ?? null) as DonorBadgeTier | null)
    const { data } = await supabase.from('news_posts')
      .select('id, title, title_ur, is_published, moderation_status, created_at')
      .eq('submitted_by_portal_user_id', user.id).order('created_at', { ascending: false })
    setMine((data ?? []) as Submission[])
  }
  useEffect(() => { load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!user || !form.title.trim() || !form.content.trim()) { toast.error(t('sb.required')); return }
    setSaving(true)
    const { error } = await supabase.from('news_posts').insert({
      title: form.title.trim(), title_ur: form.title_ur.trim() || null,
      content: form.content.trim(), content_ur: form.content_ur.trim() || null,
      cover_image_url: form.cover_image_url || null,
      category: 'blog', submitted_by_portal_user_id: user.id,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sb.submittedToast'))
    setForm(empty)
    load()
  }

  if (userLoading || tier === undefined) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  // Two independent doors to the same form (migration 325): a high-tier
  // donor, or an admin-approved mentor — a volunteering doctor/freelancer
  // has no donation history to check, so gating on badge tier alone would
  // lock out exactly the people this door was built for.
  const isApprovedMentor = user?.mentor_status === 'approved'
  if (!canFastTrack(tier) && !isApprovedMentor) {
    return (
      <div className="max-w-lg" dir={isUrdu ? 'rtl' : 'ltr'}>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <Lock size={28} className="text-dp-on-surface-variant mx-auto mb-3" />
          <h1 className="font-heading text-[20px] font-bold text-dp-primary mb-2">{t('sb.badgeRequiredTitle')}</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant leading-relaxed">{t('sb.badgeRequiredBody')}</p>
        </div>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-2xl">
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><NotebookPen size={22} className="text-dp-secondary" /> {t('sb.heading')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('sb.subtitle')}</p>
        <div className="mt-2"><DonorBadge tier={tier} isUrdu={isUrdu} /></div>
      </div>

      {mine.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-6">
          <h2 className="font-sans text-[13.5px] font-bold text-dp-primary mb-2.5">{t('sb.mySubmissions')}</h2>
          <div className="space-y-2">
            {mine.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 text-[13px] font-sans">
                <span className="text-dp-on-surface truncate">{s.title}</span>
                {s.moderation_status === 'approved' ? (
                  <span className="inline-flex items-center gap-1 text-dp-secondary font-semibold shrink-0"><CheckCircle2 size={13} /> {t('sb.statusApproved')}</span>
                ) : s.moderation_status === 'rejected' ? (
                  <span className="inline-flex items-center gap-1 text-dp-error font-semibold shrink-0"><XCircle size={13} /> {t('sb.statusRejected')}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-700 font-semibold shrink-0"><Clock size={13} /> {t('sb.statusPending')}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 space-y-4">
        <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sb.titleEn')}</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="input-field" /></div>
        <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sb.titleUr')}</label><input value={form.title_ur} onChange={(e) => setForm({ ...form, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
        <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sb.contentEn')}</label><textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={6} className="input-field resize-none" /></div>
        <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sb.contentUr')}</label><textarea value={form.content_ur} onChange={(e) => setForm({ ...form, content_ur: e.target.value })} rows={6} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
        <div>
          <ImageUpload bucket="images" currentUrl={form.cover_image_url} onUpload={(url) => setForm({ ...form, cover_image_url: url })} label={t('sb.coverImage')} />
        </div>
        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('sb.moderationNote')}</p>
        <button disabled={saving} onClick={submit} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          <Send size={16} /> {saving ? t('action.saving') : t('sb.submit')}
        </button>
      </div>
    </div>
  )
}
