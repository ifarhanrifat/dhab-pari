'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ClipboardList, UserPlus2, PlayCircle, CheckCircle2, Phone, Pencil, RefreshCw } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface ConnectionTask {
  id: string; request_number: string | null
  consumer_name: string; consumer_phone: string; sector: string | null
  task_status: 'unassigned' | 'assigned' | 'in_progress' | 'done'
  incharge_user_id: string | null
  assignee_name: string | null; assignee_phone: string | null; assignee_employee_id: string | null
  task_notes: string | null; task_due_date: string | null
  task_assigned_at: string | null; task_started_at: string | null; task_done_at: string | null
}
interface InchargeOpt { id: string; full_name: string }
interface PlumberEmployee { id: string; name: string; phone: string | null }

const emptyAssignForm = { incharge_user_id: '', assignee_employee_id: '', assignee_name: '', assignee_phone: '', task_due_date: '', task_notes: '' }

const stageLabels: Record<ConnectionTask['task_status'], string> = {
  unassigned: 'Unassigned', assigned: 'Assigned', in_progress: 'In Progress', done: 'Done',
}
const stageStyles: Record<ConnectionTask['task_status'], string> = {
  unassigned: 'bg-gray-100 text-gray-700',
  assigned: 'bg-amber-100 text-amber-800',
  in_progress: 'bg-blue-100 text-blue-800',
  done: 'bg-emerald-100 text-emerald-700',
}

export default function TasksPage() {
  const { t: tr } = useLocale()
  const supabase = createClient()
  const [tasks, setTasks] = useState<ConnectionTask[]>([])
  const [inchargeOptions, setInchargeOptions] = useState<InchargeOpt[]>([])
  const [plumbers, setPlumbers] = useState<PlumberEmployee[]>([])
  const [loading, setLoading] = useState(true)

  const [assignTarget, setAssignTarget] = useState<ConnectionTask | null>(null)
  const [assignForm, setAssignForm] = useState(emptyAssignForm)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const [tasksRes, inchargeRes, plumbersRes] = await Promise.all([
      supabase.from('connection_requests')
        .select('id, request_number, consumer_name, consumer_phone, sector, task_status, incharge_user_id, assignee_name, assignee_phone, assignee_employee_id, task_notes, task_due_date, task_assigned_at, task_started_at, task_done_at')
        .eq('status', 'processing')
        .order('created_at', { ascending: true }),
      // Plumbers are payroll staff who don't use this software — a task is
      // assigned to a viewer-role "incharge" instead, who contacts the
      // plumbers manually and updates status on their behalf. A direct
      // admin_users query would return nothing for a non-admin-tier caller
      // (RLS only lets admin-tier users read rows other than their own) —
      // this RPC is scoped narrowly to just the candidate list instead.
      supabase.rpc('list_incharge_candidates'),
      // Employees roster (migration 101) — optional structured link to which
      // staff plumber actually did the job, alongside the free-text fields.
      supabase.from('employees').select('id, name, phone').eq('is_active', true)
        .or('primary_role.eq.plumber,secondary_role.eq.plumber').order('name'),
    ])
    setTasks(tasksRes.data ?? [])
    setInchargeOptions(inchargeRes.data ?? [])
    setPlumbers(plumbersRes.data ?? [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const inchargeName = (id: string | null) => inchargeOptions.find((o) => o.id === id)?.full_name ?? null

  const openAssign = (t: ConnectionTask) => {
    setAssignTarget(t)
    setAssignForm({
      incharge_user_id: t.incharge_user_id || '', assignee_employee_id: t.assignee_employee_id || '',
      assignee_name: t.assignee_name || '', assignee_phone: t.assignee_phone || '',
      task_due_date: t.task_due_date || '', task_notes: t.task_notes || '',
    })
  }

  const saveAssign = async () => {
    if (!assignTarget) return
    if (!assignForm.incharge_user_id) { toast.error('Choose an incharge to assign this to'); return }
    setSaving(true)
    const isReassign = assignTarget.task_status !== 'unassigned'
    const { error } = await supabase.from('connection_requests').update({
      incharge_user_id: assignForm.incharge_user_id,
      assignee_employee_id: assignForm.assignee_employee_id || null,
      assignee_name: assignForm.assignee_name || null, assignee_phone: assignForm.assignee_phone || null,
      task_due_date: assignForm.task_due_date || null, task_notes: assignForm.task_notes || null,
      ...(isReassign ? {} : { task_status: 'assigned', task_assigned_at: new Date().toISOString() }),
    }).eq('id', assignTarget.id)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(isReassign ? 'Assignment updated' : 'Task assigned')
    setAssignTarget(null)
    load()
  }

  const markInProgress = async (t: ConnectionTask) => {
    const { error } = await supabase.from('connection_requests').update({
      task_status: 'in_progress', task_started_at: new Date().toISOString(),
    }).eq('id', t.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Marked in progress')
    load()
  }

  const markDone = async (t: ConnectionTask) => {
    const { error } = await supabase.from('connection_requests').update({
      task_status: 'done', task_done_at: new Date().toISOString(),
    }).eq('id', t.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Marked done — ready to activate from New Connections')
    load()
  }

  const active = tasks.filter((t) => t.task_status !== 'done')
  const done = tasks.filter((t) => t.task_status === 'done')

  const renderRow = (t: ConnectionTask) => (
    <div key={t.id} className="p-4 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{t.consumer_name}</p>
          <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${stageStyles[t.task_status]}`}>{stageLabels[t.task_status]}</span>
        </div>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
          {t.request_number} · {t.consumer_phone}{t.sector ? ` · ${t.sector}` : ''}
        </p>
        {t.incharge_user_id && (
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
            {tr('a.incharge')} <span className="font-semibold text-dp-on-surface">{inchargeName(t.incharge_user_id) ?? 'Unknown'}</span>
            {t.assignee_name && ` · Plumber: ${t.assignee_name}`}
            {t.assignee_phone && ` (${t.assignee_phone})`}
            {t.task_due_date && ` · Due ${new Date(t.task_due_date).toLocaleDateString('en-GB')}`}
          </p>
        )}
        {t.task_notes && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 italic">{t.task_notes}</p>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {t.task_status === 'unassigned' && (
          <button onClick={() => openAssign(t)} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <UserPlus2 size={13} /> Assign Incharge
          </button>
        )}
        {t.task_status === 'assigned' && (
          <>
            <button onClick={() => openAssign(t)} title="Edit assignment" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
            <button onClick={() => markInProgress(t)} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <PlayCircle size={13} /> Mark In Progress
            </button>
          </>
        )}
        {t.task_status === 'in_progress' && (
          <>
            <button onClick={() => openAssign(t)} title="Edit assignment" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
            <button onClick={() => markDone(t)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
              <CheckCircle2 size={13} /> {tr('mt.markDone')}
            </button>
          </>
        )}
        {t.task_status === 'done' && (
          <span className="font-sans text-[12px] font-semibold text-emerald-700">Ready to activate — see New Connections</span>
        )}
      </div>
    </div>
  )

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="font-heading text-[26px] sm:text-[32px] font-bold text-dp-primary flex items-center gap-2.5">
          <ClipboardList size={28} /> Task Todo
        </h1>
        <button onClick={load} title="Refresh" className="p-2.5 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer transition-all">
          <RefreshCw size={16} />
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-dp-on-surface-variant py-8 text-center">{tr('action.loading')}</p>
      ) : active.length === 0 && done.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">No installation jobs waiting. New ones appear here after Cash Receive on a connection request.</p>
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden divide-y divide-dp-outline-variant mb-6">
              {active.map(renderRow)}
            </div>
          )}
          {done.length > 0 && (
            <>
              <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">Done</p>
              <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden divide-y divide-dp-outline-variant opacity-70">
                {done.map(renderRow)}
              </div>
            </>
          )}
        </>
      )}

      {assignTarget && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setAssignTarget(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-5 py-4 border-b border-dp-outline-variant">
              <UserPlus2 size={20} className="text-dp-secondary" />
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">Assign Incharge</h2>
            </div>
            <div className="p-5 space-y-4">
              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3">
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{assignTarget.consumer_name}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{assignTarget.request_number}</p>
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Incharge</label>
                <select autoFocus value={assignForm.incharge_user_id} onChange={(e) => setAssignForm({ ...assignForm, incharge_user_id: e.target.value })} className="input-field">
                  <option value="">Select incharge...</option>
                  {inchargeOptions.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
                </select>
                {inchargeOptions.length === 0 && (
                  <p className="font-sans text-[11.5px] text-dp-error mt-1">No viewer-role users found — add one on the Users page first.</p>
                )}
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">This person contacts the plumber directly and updates progress here.</p>
              </div>
              {plumbers.length > 0 && (
                <div>
                  <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Staff Plumber (optional)</label>
                  <select
                    value={assignForm.assignee_employee_id}
                    onChange={(e) => {
                      const emp = plumbers.find((p) => p.id === e.target.value)
                      setAssignForm({
                        ...assignForm, assignee_employee_id: e.target.value,
                        ...(emp ? { assignee_name: emp.name, assignee_phone: emp.phone || '' } : {}),
                      })
                    }}
                    className="input-field"
                  >
                    <option value="">Not on staff / choose manually below...</option>
                    {plumbers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">Picking one fills the name/phone below and links this job to them on the Employees page.</p>
                </div>
              )}
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Plumber Name (optional, for your reference)</label>
                <input value={assignForm.assignee_name} onChange={(e) => setAssignForm({ ...assignForm, assignee_name: e.target.value, assignee_employee_id: '' })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Plumber Phone (optional)</label>
                <div className="relative">
                  <Phone size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
                  <input value={assignForm.assignee_phone} onChange={(e) => setAssignForm({ ...assignForm, assignee_phone: e.target.value })} className="input-field !ps-10" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Target Completion Date (optional)</label>
                <input type="date" value={assignForm.task_due_date} onChange={(e) => setAssignForm({ ...assignForm, task_due_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">{tr('a.notesOptional')}</label>
                <input value={assignForm.task_notes} onChange={(e) => setAssignForm({ ...assignForm, task_notes: e.target.value })} className="input-field" />
              </div>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setAssignTarget(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">{tr('action.cancel')}</button>
              <button disabled={saving} onClick={saveAssign} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
