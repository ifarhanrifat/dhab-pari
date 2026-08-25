'use client'

// Training programs (migration 332) — in-village sessions students
// register for. Roster/attendance lives inline per program rather than a
// separate page, since "who's coming" is the whole reason to open one.
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { CalendarClock, Plus, Pencil, Trash2, X, Users } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface Program {
  id: string; title: string; title_ur: string | null; description: string | null; description_ur: string | null
  location: string | null; start_date: string | null; end_date: string | null
  capacity: number | null; category: string; status: string
  eligibility: string | null; eligibility_ur: string | null; requirements: string | null; requirements_ur: string | null
}
interface Registration { id: string; portal_user_id: string; status: string; full_name?: string }

const empty = { title: '', title_ur: '', description: '', description_ur: '', location: '', start_date: '', end_date: '', capacity: '', category: 'freelancing', status: 'upcoming', eligibility: '', eligibility_ur: '', requirements: '', requirements_ur: '' }
const CATEGORIES = ['freelancing', 'vocational', 'academic', 'other']
const STATUSES = ['upcoming', 'ongoing', 'completed', 'cancelled']

export default function TrainingProgramsPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [rows, setRows] = useState<Program[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [rosterFor, setRosterFor] = useState<string | null>(null)
  const [roster, setRoster] = useState<Registration[]>([])

  const load = async () => {
    const { data } = await supabase.from('training_programs').select('*').order('start_date', { ascending: true, nullsFirst: false })
    setRows((data ?? []) as Program[])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (r: Program) => {
    setForm({
      title: r.title, title_ur: r.title_ur ?? '', description: r.description ?? '', description_ur: r.description_ur ?? '',
      location: r.location ?? '', start_date: r.start_date ?? '', end_date: r.end_date ?? '', capacity: r.capacity?.toString() ?? '',
      category: r.category, status: r.status, eligibility: r.eligibility ?? '', eligibility_ur: r.eligibility_ur ?? '',
      requirements: r.requirements ?? '', requirements_ur: r.requirements_ur ?? '',
    })
    setEditing(r.id)
    setShowForm(true)
  }

  const save = async () => {
    if (!form.title.trim()) { toast.error(t('tp.titleRequired')); return }
    setSaving(true)
    const payload = {
      title: form.title.trim(), title_ur: form.title_ur.trim() || null,
      description: form.description.trim() || null, description_ur: form.description_ur.trim() || null,
      location: form.location.trim() || null, start_date: form.start_date || null, end_date: form.end_date || null,
      capacity: form.capacity ? parseInt(form.capacity, 10) : null, category: form.category, status: form.status,
      eligibility: form.eligibility.trim() || null, eligibility_ur: form.eligibility_ur.trim() || null,
      requirements: form.requirements.trim() || null, requirements_ur: form.requirements_ur.trim() || null,
    }
    const { error } = editing
      ? await supabase.from('training_programs').update(payload).eq('id', editing)
      : await supabase.from('training_programs').insert(payload)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tp.saved'))
    setForm(empty); setEditing(null); setShowForm(false)
    load()
  }

  const remove = async () => {
    if (!confirmDeleteId) return
    const { error } = await supabase.from('training_programs').delete().eq('id', confirmDeleteId)
    setConfirmDeleteId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tp.deleted'))
    load()
  }

  const openRoster = async (programId: string) => {
    setRosterFor(programId)
    const { data } = await supabase.from('training_program_registrations').select('id, portal_user_id, status').eq('training_program_id', programId).order('registered_at')
    const regs = (data ?? []) as Registration[]
    if (regs.length) {
      const { data: names } = await supabase.from('portal_users').select('id, full_name').in('id', regs.map((r) => r.portal_user_id))
      const nameMap = Object.fromEntries((names ?? []).map((n) => [n.id, n.full_name]))
      regs.forEach((r) => { r.full_name = nameMap[r.portal_user_id] })
    }
    setRoster(regs)
  }

  const markAttendance = async (regId: string, status: string) => {
    const { error } = await supabase.from('training_program_registrations').update({ status }).eq('id', regId)
    if (error) { toast.error(friendlyError(error)); return }
    setRoster((prev) => prev.map((r) => (r.id === regId ? { ...r, status } : r)))
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <CalendarClock size={26} className="text-dp-secondary" /> {t('tp.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('tp.blurb')}</p>
        </div>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-1.5 bg-dp-secondary text-white px-4 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
          <Plus size={15} /> {t('tp.newProgram')}
        </button>
      </div>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant">{t('action.loading')}</div>}
      {!loading && rows.length === 0 && <div className="text-center py-12 text-dp-on-surface-variant">{t('tp.none')}</div>}

      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{r.title}</p>
                  <span className="text-[10px] font-bold uppercase text-dp-secondary bg-dp-secondary/10 rounded-full px-2 py-0.5">{r.category}</span>
                  <span className={`text-[10px] font-bold uppercase rounded-full px-2 py-0.5 ${r.status === 'cancelled' ? 'text-dp-error bg-dp-error/10' : 'text-emerald-700 bg-emerald-50'}`}>{r.status}</span>
                </div>
                {r.description && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{isUrdu && r.description_ur ? r.description_ur : r.description}</p>}
                {r.eligibility && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1"><strong>{t('tp.eligibilityLabel')}:</strong> {isUrdu && r.eligibility_ur ? r.eligibility_ur : r.eligibility}</p>}
                {r.requirements && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5"><strong>{t('tp.requirementsLabel')}:</strong> {isUrdu && r.requirements_ur ? r.requirements_ur : r.requirements}</p>}
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{[r.location, r.start_date, r.capacity ? `${t('tp.capacityLabel')}: ${r.capacity}` : null].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => openRoster(r.id)} className="flex items-center gap-1 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold text-dp-on-surface-variant hover:border-dp-secondary transition-all cursor-pointer"><Users size={13} /> {t('tp.roster')}</button>
                <button onClick={() => edit(r)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
                <button onClick={() => setConfirmDeleteId(r.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={15} /></button>
              </div>
            </div>

            {rosterFor === r.id && (
              <div className="mt-3 pt-3 border-t border-dp-outline-variant">
                {roster.length === 0 ? (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('tp.noRegistrations')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {roster.map((reg) => (
                      <div key={reg.id} className="flex items-center justify-between gap-2 text-[13px] font-sans">
                        <span className="text-dp-on-surface">{reg.full_name}</span>
                        <select value={reg.status} onChange={(e) => markAttendance(reg.id, e.target.value)} className="text-[11.5px] border border-dp-outline-variant rounded px-2 py-1">
                          <option value="registered">{t('tp.registered')}</option>
                          <option value="attended">{t('tp.attended')}</option>
                          <option value="no_show">{t('tp.noShow')}</option>
                          <option value="cancelled">{t('tp.cancelled')}</option>
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{editing ? t('tp.editProgram') : t('tp.newProgram')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('tp.programTitle')} className="input-field" />
              <input value={form.title_ur} onChange={(e) => setForm({ ...form, title_ur: e.target.value })} placeholder={t('w.nameUrdu')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t('in.description')} rows={2} className="input-field resize-none" />
              <textarea value={form.description_ur} onChange={(e) => setForm({ ...form, description_ur: e.target.value })} placeholder={t('in.descriptionUr')} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              <textarea value={form.eligibility} onChange={(e) => setForm({ ...form, eligibility: e.target.value })} placeholder={t('tp.eligibilityPlaceholder')} rows={2} className="input-field resize-none" />
              <textarea value={form.eligibility_ur} onChange={(e) => setForm({ ...form, eligibility_ur: e.target.value })} placeholder={t('tp.eligibilityPlaceholderUr')} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              <textarea value={form.requirements} onChange={(e) => setForm({ ...form, requirements: e.target.value })} placeholder={t('tp.requirementsPlaceholder')} rows={2} className="input-field resize-none" />
              <textarea value={form.requirements_ur} onChange={(e) => setForm({ ...form, requirements_ur: e.target.value })} placeholder={t('tp.requirementsPlaceholderUr')} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder={t('tp.location')} className="input-field" />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('tp.startDate')}</label>
                  <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('tp.endDate')}</label>
                  <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} className="input-field" />
                </div>
              </div>
              <input type="number" min="0" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} placeholder={t('tp.capacity')} className="input-field" />
              <div className="grid grid-cols-2 gap-3">
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input-field">
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? t('action.saving') : t('action.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog open={!!confirmDeleteId} title={t('tp.deleteProgram')} message={t('tp.deleteConfirm')} onConfirm={remove} onCancel={() => setConfirmDeleteId(null)} />
    </div>
  )
}
