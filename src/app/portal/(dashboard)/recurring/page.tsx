'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { PlusCircle, X, Pause, Play, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface Schedule {
  id: string; amount_pkr: number; frequency: string; next_run_date: string; is_active: boolean
  project_id: string | null; payment_method: string | null; particular: string | null
}
interface Project { id: string; title: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
const empty = { amount_pkr: 0, frequency: 'monthly', next_run_date: new Date().toISOString().split('T')[0], project_id: '', payment_method: 'jazzcash', particular: '' }

export default function PortalRecurringPage() {
  const { user, loading: userLoading } = usePortalUser()
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const [{ data: sched }, { data: proj }] = await Promise.all([
      supabase.from('recurring_schedules').select('id, amount_pkr, frequency, next_run_date, is_active, project_id, payment_method, particular')
        .eq('created_by_portal_user_id', user.id).order('next_run_date', { ascending: true }),
      supabase.from('projects').select('id, title').neq('status', 'upcoming').order('title'),
    ])
    setSchedules(sched ?? [])
    setProjects(proj ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const save = async () => {
    if (!user || !form.amount_pkr || form.amount_pkr <= 0) { toast.error('Enter a valid amount'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('recurring_schedules').insert({
      system: 'donors_projects', schedule_type: 'donation', created_by_portal_user_id: user.id,
      donor_name: user.full_name, donor_name_ur: user.name_ur, donor_phone: user.mobile, donor_type: 'villager',
      amount_pkr: form.amount_pkr, frequency: form.frequency, next_run_date: form.next_run_date,
      project_id: form.project_id || null, payment_method: form.payment_method,
      particular: form.particular || 'Recurring donation', is_active: true,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Recurring donation set up')
    setShowForm(false)
    setForm(empty)
    load()
  }

  const togglePause = async (s: Schedule) => {
    const supabase = createClient()
    const { error } = await supabase.from('recurring_schedules').update({ is_active: !s.is_active }).eq('id', s.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(s.is_active ? 'Paused' : 'Resumed')
    load()
  }

  const cancel = async () => {
    if (!confirmCancel) return
    const supabase = createClient()
    const { error } = await supabase.from('recurring_schedules').delete().eq('id', confirmCancel)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Cancelled')
    setConfirmCancel(null)
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary">Recurring Donations</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Set up automatic giving to a project or the general fund.</p>
        </div>
        <button onClick={() => { setForm(empty); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
          <PlusCircle size={16} /> New Schedule
        </button>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        {schedules.length === 0 ? (
          <p className="px-5 py-8 text-center font-sans text-[14px] text-dp-on-surface-variant">No recurring donations set up yet.</p>
        ) : (
          schedules.map((s) => (
            <div key={s.id} className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">Rs. {fmt(s.amount_pkr)} · <span className="capitalize">{s.frequency}</span></p>
                <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">
                  {projects.find((p) => p.id === s.project_id)?.title ?? 'General Fund'} · Next: {new Date(s.next_run_date).toLocaleDateString('en-GB')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${s.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>{s.is_active ? 'Active' : 'Paused'}</span>
                <button onClick={() => togglePause(s)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer" title={s.is_active ? 'Pause' : 'Resume'}>
                  {s.is_active ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button onClick={() => setConfirmCancel(s.id)} className="p-2 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title="Cancel"><Trash2 size={16} /></button>
              </div>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog open={!!confirmCancel} title="Cancel Recurring Donation" message="Are you sure you want to cancel this recurring donation? This cannot be undone." onConfirm={cancel} onCancel={() => setConfirmCancel(null)} />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">New Recurring Donation</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Amount (PKR)</label>
                <input type="number" min={1} value={form.amount_pkr || ''} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Frequency</label>
                <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className="input-field">
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="semi_annual">Every 6 Months</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Starting</label>
                <input type="date" value={form.next_run_date} onChange={(e) => setForm({ ...form, next_run_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Project</label>
                <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className="input-field">
                  <option value="">General Fund</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Payment Method</label>
                <select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className="input-field">
                  <option value="jazzcash">JazzCash</option>
                  <option value="easypaisa">Easypaisa</option>
                  <option value="bank">Bank Transfer</option>
                </select>
              </div>
              <button disabled={saving} onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? 'Saving...' : 'Set Up Recurring Donation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
