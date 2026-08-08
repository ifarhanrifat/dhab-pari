'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HeartHandshake, PlusCircle, X, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface Signup { id: string; project_id: string | null; message: string | null; status: string; created_at: string }
interface ProjectOption { id: string; title: string }

const STATUS_LABEL: Record<string, string> = { offered: 'Offered', assigned: 'Assigned', completed: 'Completed' }

export default function PortalMyVolunteeringPage() {
  const { user, loading: userLoading } = usePortalUser()
  const [signups, setSignups] = useState<Signup[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const [{ data: s }, { data: p }] = await Promise.all([
      supabase.from('volunteers').select('id, project_id, message, status, created_at').eq('portal_user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('projects').select('id, title').in('status', ['ongoing', 'reviewing']).order('title'),
    ])
    setSignups(s ?? [])
    setProjects(p ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const projectTitle = (id: string | null) => id ? (projects.find((p) => p.id === id)?.title ?? 'A Project') : 'General — Any Project'

  const submit = async () => {
    if (!user) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('volunteers').insert({ portal_user_id: user.id, project_id: projectId || null, message: message.trim() || null })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Signed up — thank you!')
    setShowForm(false)
    setProjectId('')
    setMessage('')
    load()
  }

  const remove = async (id: string) => {
    const supabase = createClient()
    const { error } = await supabase.from('volunteers').delete().eq('id', id)
    setConfirmDelete(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Removed')
    load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>

  return (
    <>
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HeartHandshake size={22} className="text-dp-secondary" /> My Volunteering</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Your volunteer signups — visible publicly on the Volunteer page.</p>
        </div>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> New Signup
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Loading...</p>
      ) : signups.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">You haven&apos;t signed up to volunteer yet.</p>
        </div>
      ) : (
        <div className="space-y-3 max-w-xl">
          {signups.map((s) => (
            <div key={s.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{STATUS_LABEL[s.status] ?? s.status}</span>
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{projectTitle(s.project_id)}</p>
                  {s.message && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{s.message}</p>}
                </div>
                <button onClick={() => setConfirmDelete(s.id)} className="p-2 text-dp-on-surface-variant hover:text-dp-error cursor-pointer shrink-0"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">New Signup</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Project (optional)</label>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input-field">
                  <option value="">General — any project the committee needs</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Message (optional)</label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Your skills, availability, etc." className="input-field resize-none" />
              </div>
              <button onClick={submit} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Remove this volunteer signup?"
        message="You can always sign up again later."
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  )
}
