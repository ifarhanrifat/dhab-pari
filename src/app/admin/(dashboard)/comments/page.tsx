'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { MessageSquare, EyeOff, Eye } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Comment {
  id: string; content: string; is_hidden: boolean; created_at: string
  username: string | null; label: string; source: 'project' | 'talent'
}

// Staff-side moderation for project discussion (migration 138) and Talent
// Showcase discussion (migration 345) — merged into one feed since both
// route the same way (portal users only ever get "Flag", which lands in
// Complaints; hiding is a staff-only call, made here).
export default function AdminCommentsPage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const [{ data: projectRows }, { data: talentRows }] = await Promise.all([
      supabase.from('project_comments').select('id, content, is_hidden, created_at, portal_users(username), projects(title)').order('created_at', { ascending: false }).limit(100),
      supabase.from('talent_showcase_comments').select('id, content, is_hidden, created_at, portal_users(username), talent_showcases(display_name)').order('created_at', { ascending: false }).limit(100),
    ])
    type ProjectRow = { id: string; content: string; is_hidden: boolean; created_at: string; portal_users: { username: string | null } | null; projects: { title: string } | null }
    type TalentRow = { id: string; content: string; is_hidden: boolean; created_at: string; portal_users: { username: string | null } | null; talent_showcases: { display_name: string } | null }
    const fromProjects: Comment[] = ((projectRows ?? []) as unknown as ProjectRow[]).map((c) => ({
      id: c.id, content: c.content, is_hidden: c.is_hidden, created_at: c.created_at,
      username: c.portal_users?.username ?? null, label: c.projects?.title ?? t('cm.aProject'), source: 'project',
    }))
    const fromTalent: Comment[] = ((talentRows ?? []) as unknown as TalentRow[]).map((c) => ({
      id: c.id, content: c.content, is_hidden: c.is_hidden, created_at: c.created_at,
      username: c.portal_users?.username ?? null, label: c.talent_showcases?.display_name ?? t('ts.title'), source: 'talent',
    }))
    setComments([...fromProjects, ...fromTalent].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const setHidden = async (c: Comment, hidden: boolean) => {
    const rpc = c.source === 'talent' ? 'set_talent_showcase_comment_hidden' : 'set_project_comment_hidden'
    const { error } = await supabase.rpc(rpc, { p_comment_id: c.id, p_hidden: hidden })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(hidden ? t('cm.hidden') : t('cm.restored'))
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('cm.noAccessMessage')}</p>
      </div>
    )
  }

  const visible = comments.filter((c) => showHidden || !c.is_hidden)

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><MessageSquare size={26} /> {t('y.projectComments')}</h1>
        <label className="flex items-center gap-2 cursor-pointer font-sans text-[14px]">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-dp-secondary" />
          {t('y.showHidden')}
        </label>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        {loading ? (
          <p className="p-8 text-center font-sans text-[14px] text-dp-on-surface-variant">{t('action.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="p-8 text-center font-sans text-[14px] text-dp-on-surface-variant">{t('mt.noComments')}</p>
        ) : (
          visible.map((c) => (
            <div key={`${c.source}-${c.id}`} className={`flex items-start justify-between gap-4 px-5 py-4 border-b border-dp-outline-variant last:border-b-0 ${c.is_hidden ? 'bg-dp-surface-container-low/60' : ''}`}>
              <div className="flex-1 min-w-0">
                <p className="font-sans text-[12px] font-semibold text-dp-secondary">
                  {c.username ?? t('cm.unknown')} {t('cm.onPrefix')} {c.label}
                  {c.source === 'talent' && <span className="ms-1.5 text-[10px] font-bold text-dp-on-surface-variant bg-dp-surface-container-low rounded-full px-1.5 py-0.5 align-middle">{t('ts.title')}</span>}
                </p>
                <p className="font-sans text-[14px] text-dp-on-surface mt-1">{c.content}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{new Date(c.created_at).toLocaleString('en-GB')}</p>
              </div>
              <button onClick={() => setHidden(c, !c.is_hidden)} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all shrink-0">
                {c.is_hidden ? <><Eye size={13} /> {t('g.restore')}</> : <><EyeOff size={13} /> {t('y.hide')}</>}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
