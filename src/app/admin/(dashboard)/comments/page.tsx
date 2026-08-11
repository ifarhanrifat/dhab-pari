'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { MessageSquare, EyeOff, Eye } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Comment {
  id: string; project_id: string; content: string; is_hidden: boolean; created_at: string
  portal_users: { username: string | null } | null
  projects: { title: string } | null
}

// Staff-side moderation for project discussion (migration 138). Portal
// users only ever get a "Flag" action (routes to Complaints) — hiding a
// comment is a staff-only decision, made here.
export default function AdminCommentsPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('project_comments')
      .select('id, project_id, content, is_hidden, created_at, portal_users(username), projects(title)')
      .order('created_at', { ascending: false }).limit(100)
    setComments((data ?? []) as unknown as Comment[])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const setHidden = async (id: string, hidden: boolean) => {
    const { error } = await supabase.rpc('set_project_comment_hidden', { p_comment_id: id, p_hidden: hidden })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(hidden ? 'Comment hidden' : 'Comment restored')
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Comments belongs to the Donors &amp; Projects system — your account doesn&apos;t have access to it.</p>
      </div>
    )
  }

  const visible = comments.filter((c) => showHidden || !c.is_hidden)

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><MessageSquare size={26} /> Project Comments</h1>
        <label className="flex items-center gap-2 cursor-pointer font-sans text-[14px]">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-dp-secondary" />
          Show hidden
        </label>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        {loading ? (
          <p className="p-8 text-center font-sans text-[14px] text-dp-on-surface-variant">{t('action.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="p-8 text-center font-sans text-[14px] text-dp-on-surface-variant">No comments yet.</p>
        ) : (
          visible.map((c) => (
            <div key={c.id} className={`flex items-start justify-between gap-4 px-5 py-4 border-b border-dp-outline-variant last:border-b-0 ${c.is_hidden ? 'bg-dp-surface-container-low/60' : ''}`}>
              <div className="flex-1 min-w-0">
                <p className="font-sans text-[12px] font-semibold text-dp-secondary">{c.portal_users?.username ?? 'Unknown'} on {c.projects?.title ?? 'a project'}</p>
                <p className="font-sans text-[14px] text-dp-on-surface mt-1">{c.content}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{new Date(c.created_at).toLocaleString('en-GB')}</p>
              </div>
              <button onClick={() => setHidden(c.id, !c.is_hidden)} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all shrink-0">
                {c.is_hidden ? <><Eye size={13} /> Restore</> : <><EyeOff size={13} /> Hide</>}
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}
