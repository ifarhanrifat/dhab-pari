'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { HandHeart, Search, Plus, X, CheckCircle2, MessageCircle } from 'lucide-react'
import { friendlyError } from '@/lib/errors'
import { normalizePakPhone } from '@/lib/receiptExport'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Volunteer {
  id: string
  portal_user_id: string
  project_id: string | null
  message: string | null
  status: 'offered' | 'assigned' | 'completed'
  created_at: string
  help_types: string[] | null
  availability: string | null
  can_travel: boolean | null
  skills: string | null
  full_name: string | null
  mobile: string | null
  whatsapp_number: string | null
}
interface Project { id: string; title: string; status: string }
interface Task {
  id: string; project_id: string; portal_user_id: string | null
  title: string; detail: string | null; due_date: string | null
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'; created_at: string
}

const STATUS_STYLE: Record<string, string> = {
  offered: 'bg-amber-100 text-amber-800',
  assigned: 'bg-emerald-100 text-emerald-700',
  completed: 'bg-dp-surface-container-high text-dp-on-surface-variant',
}
// Same wording the volunteer saw on the form, so staff and resident are reading
// the same labels rather than raw column values.
const HELP_LABEL: Record<string, string> = {
  physical: 'Physical work',
  skilled: 'Skilled trade',
  professional: 'Professional',
  transport: 'Has vehicle',
  purchasing: 'Purchasing / errands',
  financial: 'Financial',
  moral: 'Moral support',
}
const AVAILABILITY_LABEL: Record<string, string> = {
  anytime: 'Any time', weekdays: 'Weekdays', weekends: 'Weekends',
  evenings: 'Evenings only', emergency_only: 'Emergencies only',
}

const TASK_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  in_progress: 'bg-blue-100 text-blue-700',
  done: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-dp-surface-container-high text-dp-on-surface-variant',
}

// The volunteers table, the portal sign-up form and the public volunteer list
// all existed already; staff had no screen at all, so an offer could be made
// but never accepted. This is that screen: accept an offer onto a project, give
// the person jobs, and close everyone out when the project finishes.
export default function AdminVolunteersPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()
  const [rows, setRows] = useState<Volunteer[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'offered' | 'assigned' | 'completed'>('all')
  const [taskFor, setTaskFor] = useState<Volunteer | null>(null)
  const [taskForm, setTaskForm] = useState({ title: '', title_ur: '', detail: '', due_date: '' })
  const [savingTask, setSavingTask] = useState(false)
  const [closeProjectId, setCloseProjectId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [vRes, pRes, tRes] = await Promise.all([
      supabase.from('volunteers').select('id, portal_user_id, project_id, message, status, created_at, help_types, availability, can_travel, skills, portal_users(full_name, mobile, whatsapp_number)').order('created_at', { ascending: false }),
      supabase.from('projects').select('id, title, status').order('title'),
      supabase.from('project_tasks').select('id, project_id, portal_user_id, title, detail, due_date, status, created_at').order('created_at', { ascending: false }),
    ])
    setRows((vRes.data ?? []).map((v) => {
      const pu = Array.isArray(v.portal_users) ? v.portal_users[0] : v.portal_users
      return { ...v, full_name: pu?.full_name ?? null, mobile: pu?.mobile ?? null, whatsapp_number: pu?.whatsapp_number ?? null } as Volunteer
    }))
    setProjects(pRes.data ?? [])
    setTasks((tRes.data ?? []) as Task[])
    setLoading(false)
  }, [supabase])
  useEffect(() => { load() }, [load])

  const projectTitle = (id: string | null) => projects.find((p) => p.id === id)?.title ?? null

  const setStatus = async (v: Volunteer, status: Volunteer['status']) => {
    if (status === 'assigned' && !v.project_id) {
      toast.error('Give this volunteer a project first — acceptance is per project')
      return
    }
    const { error } = await supabase.from('volunteers').update({ status }).eq('id', v.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(status === 'assigned' ? 'Accepted — they have been notified' : `Marked ${status}`)
    load()
  }

  const setProject = async (v: Volunteer, projectId: string) => {
    const { error } = await supabase.from('volunteers').update({ project_id: projectId || null }).eq('id', v.id)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const saveTask = async () => {
    if (!taskFor || !taskFor.project_id) return
    if (!taskForm.title.trim()) { toast.error('Give the task a title'); return }
    setSavingTask(true)
    const { error } = await supabase.from('project_tasks').insert({
      project_id: taskFor.project_id,
      portal_user_id: taskFor.portal_user_id,
      title: taskForm.title.trim(),
      title_ur: taskForm.title_ur.trim() || null,
      detail: taskForm.detail.trim() || null,
      due_date: taskForm.due_date || null,
    })
    setSavingTask(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Task sent — they have been notified')
    setTaskFor(null)
    setTaskForm({ title: '', title_ur: '', detail: '', due_date: '' })
    load()
  }

  // Closing a project marks every assigned volunteer complete (which is what
  // puts them on the public page under the committee's thanks) and cancels any
  // task still open against it.
  const closeOutProject = async () => {
    if (!closeProjectId) return
    const { data, error } = await supabase.rpc('complete_project_volunteers', { p_project_id: closeProjectId })
    setCloseProjectId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`${data ?? 0} volunteer(s) thanked and closed out`)
    load()
  }

  const whatsapp = (v: Volunteer) => {
    const intl = normalizePakPhone(v.whatsapp_number || v.mobile || '')
    if (!intl) { toast.error('No usable WhatsApp number on file'); return }
    window.open(`https://wa.me/${intl}`, '_blank')
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((v) => {
      if (statusFilter !== 'all' && v.status !== statusFilter) return false
      if (!q) return true
      return [v.full_name ?? '', v.mobile ?? '', v.message ?? '', v.skills ?? '',
        ...(v.help_types ?? []).map((h) => HELP_LABEL[h] ?? h),
        projectTitle(v.project_id) ?? ''].join(' ').toLowerCase().includes(q)
    })
  }, [rows, search, statusFilter, projects])

  const tasksFor = (v: Volunteer) => tasks.filter((t) => t.portal_user_id === v.portal_user_id && t.project_id === v.project_id && t.status !== 'cancelled')

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Volunteers belong to the Donors &amp; Projects system — your account doesn&apos;t have access to it.</p>
      </div>
    )
  }

  const offeredCount = rows.filter((v) => v.status === 'offered').length

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-heading text-[24px] sm:text-[32px] font-bold leading-[32px] sm:leading-[40px] text-dp-primary flex items-center gap-2">
            <HandHeart size={26} /> Volunteers
          </h1>
          {offeredCount > 0 && (
            <p className="font-sans text-[13px] text-amber-700 mt-1">{offeredCount} offer(s) waiting for a decision</p>
          )}
        </div>
        <select
          value={closeProjectId ?? ''}
          onChange={(e) => e.target.value && setCloseProjectId(e.target.value)}
          className="input-field max-w-[280px]"
        >
          <option value="">Close out a finished project…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, phone, project or message..." className="input-field !ps-9" />
        </div>
        {(['all', 'offered', 'assigned', 'completed'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-4 py-1.5 rounded-full font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${
              statusFilter === f ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'
            }`}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}
      {!loading && visible.length === 0 && (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{search || statusFilter !== 'all' ? 'No volunteers match that filter.' : 'Nobody has signed up to volunteer yet.'}</p>
        </div>
      )}

      <div className="space-y-3">
        {!loading && visible.map((v) => (
          <div key={v.id} className="bg-white rounded-lg border border-dp-outline-variant p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">{v.full_name ?? 'Unnamed'}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{v.mobile ?? 'No number'} · offered {new Date(v.created_at).toLocaleDateString('en-GB')}</p>
                {v.skills && <p className="font-sans text-[13px] text-dp-on-surface mt-1.5"><span className="text-dp-on-surface-variant">Skills:</span> <strong>{v.skills}</strong></p>}
                {v.message && <p className="font-sans text-[13.5px] text-dp-on-surface mt-1">{v.message}</p>}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(v.help_types ?? []).map((h) => (
                    <span key={h} className="text-[11px] font-semibold px-2 py-0.5 rounded-full font-sans bg-dp-secondary-container text-dp-on-secondary-container">{HELP_LABEL[h] ?? h}</span>
                  ))}
                  {v.availability && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full font-sans bg-dp-surface-container-high text-dp-on-surface-variant">{AVAILABILITY_LABEL[v.availability] ?? v.availability}</span>
                  )}
                  {v.can_travel && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full font-sans bg-blue-100 text-blue-700">Can travel</span>
                  )}
                </div>
              </div>
              <span className={`text-[11px] font-bold uppercase px-2.5 py-1 rounded-full font-sans shrink-0 ${STATUS_STYLE[v.status]}`}>{v.status}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-dp-outline-variant/60">
              <select
                value={v.project_id ?? ''}
                onChange={(e) => setProject(v, e.target.value)}
                disabled={v.status === 'completed'}
                className="input-field !py-1.5 !text-[13px] max-w-[240px] disabled:opacity-60"
              >
                <option value="">No project yet</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>

              {v.status === 'offered' && (
                <button onClick={() => setStatus(v, 'assigned')} className="px-3 py-1.5 rounded-lg bg-dp-secondary text-white font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">{t('g.accept')}</button>
              )}
              {v.status === 'assigned' && (
                <>
                  <button onClick={() => setTaskFor(v)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-on-surface cursor-pointer hover:bg-dp-surface-container-low transition-all"><Plus size={14} /> Give task</button>
                  <button onClick={() => setStatus(v, 'completed')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-on-surface cursor-pointer hover:bg-dp-surface-container-low transition-all"><CheckCircle2 size={14} /> Mark done</button>
                </>
              )}
              <button onClick={() => whatsapp(v)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-secondary cursor-pointer hover:bg-dp-surface-container-low transition-all"><MessageCircle size={14} /> {t('w.whatsapp')}</button>
            </div>

            {tasksFor(v).length > 0 && (
              <div className="mt-3 pt-3 border-t border-dp-outline-variant/60 space-y-1.5">
                {tasksFor(v).map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3">
                    <p className="font-sans text-[13px] text-dp-on-surface truncate">
                      {t.title}
                      {t.due_date && <span className="text-dp-on-surface-variant"> · due {new Date(t.due_date).toLocaleDateString('en-GB')}</span>}
                    </p>
                    <span className={`text-[10.5px] font-bold uppercase px-2 py-0.5 rounded-full font-sans shrink-0 ${TASK_STYLE[t.status]}`}>{t.status.replace('_', ' ')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {taskFor && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setTaskFor(null)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="font-heading text-[17px] font-bold text-dp-primary">Give a task</h2>
                <p className="font-sans text-[13px] text-dp-on-surface-variant">{taskFor.full_name} · {projectTitle(taskFor.project_id)}</p>
              </div>
              <button onClick={() => setTaskFor(null)} className="text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">What needs doing</label>
                <input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} placeholder="e.g. Collect pipe fittings from the market" className="input-field !py-2.5 text-[15px]" />
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">In Urdu (optional)</label>
                <input value={taskForm.title_ur} onChange={(e) => setTaskForm({ ...taskForm, title_ur: e.target.value })} dir="rtl" className="input-field !py-2.5 text-[15px]" />
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Details (optional)</label>
                <textarea value={taskForm.detail} onChange={(e) => setTaskForm({ ...taskForm, detail: e.target.value })} rows={3} className="input-field resize-none !py-2.5 text-[15px]" />
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Due date (optional)</label>
                <input type="date" value={taskForm.due_date} onChange={(e) => setTaskForm({ ...taskForm, due_date: e.target.value })} className="input-field !py-2.5 text-[15px]" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setTaskFor(null)} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">{t('action.cancel')}</button>
              <button disabled={savingTask} onClick={saveTask} className="flex-1 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">{savingTask ? 'Sending...' : 'Send task'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!closeProjectId}
        title="Close out this project's volunteers"
        message={`Everyone still assigned to ${projectTitle(closeProjectId) ?? 'this project'} will be marked completed and thanked on the public page, and any task still open against it will be cancelled.`}
        confirmLabel="Close out"
        onConfirm={closeOutProject}
        onCancel={() => setCloseProjectId(null)}
      />
    </>
  )
}
