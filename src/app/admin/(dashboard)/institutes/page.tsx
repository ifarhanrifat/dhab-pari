'use client'

// Institute directory (migration 331) — plain reference content for the
// mentorship registration note's "we'll help you find institutes" promise.
// No moderation queue: only staff write this, same trust level as sectors
// or service_items.
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { School, Plus, Pencil, Trash2, X } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Institute {
  id: string; name: string; name_ur: string | null; description: string | null; description_ur: string | null
  address: string | null; category: string; subjects: string | null; subjects_ur: string | null
  phone: string | null; website: string | null; is_active: boolean
}

const empty = { name: '', name_ur: '', description: '', description_ur: '', address: '', category: 'vocational', subjects: '', subjects_ur: '', phone: '', website: '', is_active: true }
const CATEGORIES = ['freelancing', 'vocational', 'academic', 'other']

export default function InstitutesPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [rows, setRows] = useState<Institute[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const load = async () => {
    const { data } = await supabase.from('institutes').select('*').order('name')
    setRows((data ?? []) as Institute[])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (r: Institute) => {
    setForm({
      name: r.name, name_ur: r.name_ur ?? '', description: r.description ?? '', description_ur: r.description_ur ?? '',
      address: r.address ?? '', category: r.category, subjects: r.subjects ?? '', subjects_ur: r.subjects_ur ?? '',
      phone: r.phone ?? '', website: r.website ?? '', is_active: r.is_active,
    })
    setEditing(r.id)
    setShowForm(true)
  }

  const save = async () => {
    if (!form.name.trim()) { toast.error(t('in.nameRequired')); return }
    setSaving(true)
    const payload = {
      name: form.name.trim(), name_ur: form.name_ur.trim() || null,
      description: form.description.trim() || null, description_ur: form.description_ur.trim() || null,
      address: form.address.trim() || null, category: form.category,
      subjects: form.subjects.trim() || null, subjects_ur: form.subjects_ur.trim() || null,
      phone: form.phone.trim() || null, website: form.website.trim() || null, is_active: form.is_active,
    }
    const { error } = editing
      ? await supabase.from('institutes').update(payload).eq('id', editing)
      : await supabase.from('institutes').insert(payload)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('in.saved'))
    setForm(empty); setEditing(null); setShowForm(false)
    load()
  }

  const remove = async () => {
    if (!confirmDeleteId) return
    const { error } = await supabase.from('institutes').delete().eq('id', confirmDeleteId)
    setConfirmDeleteId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('in.deleted'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <School size={26} className="text-dp-secondary" /> {t('in.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('in.blurb')}</p>
        </div>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-1.5 bg-dp-secondary text-white px-4 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
          <Plus size={15} /> {t('in.newInstitute')}
        </button>
      </div>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
      {!loading && rows.length === 0 && <div className="text-center py-12 text-dp-on-surface-variant">{t('in.none')}</div>}

      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{r.name}</p>
                <span className="text-[10px] font-bold uppercase text-dp-secondary bg-dp-secondary/10 rounded-full px-2 py-0.5">{r.category}</span>
                {!r.is_active && <span className="text-[10px] font-bold text-dp-error bg-dp-error/10 rounded-full px-2 py-0.5">{t('g.inactive')}</span>}
              </div>
              {r.subjects && <p className="font-sans text-[12.5px] text-dp-secondary font-semibold mt-1">{isUrdu && r.subjects_ur ? r.subjects_ur : r.subjects}</p>}
              {r.description && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{isUrdu && r.description_ur ? r.description_ur : r.description}</p>}
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{[r.address, r.phone, r.website].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => edit(r)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
              <button onClick={() => setConfirmDeleteId(r.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{editing ? t('in.editInstitute') : t('in.newInstitute')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('in.name')} className="input-field" />
              <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder={t('w.nameUrdu')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input value={form.subjects} onChange={(e) => setForm({ ...form, subjects: e.target.value })} placeholder={t('in.subjects')} className="input-field" />
              <input value={form.subjects_ur} onChange={(e) => setForm({ ...form, subjects_ur: e.target.value })} placeholder={t('in.subjectsUr')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t('in.description')} rows={2} className="input-field resize-none" />
              <textarea value={form.description_ur} onChange={(e) => setForm({ ...form, description_ur: e.target.value })} placeholder={t('in.descriptionUr')} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={t('in.address')} className="input-field" />
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t('in.phone')} className="input-field" />
              <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder={t('in.website')} className="input-field" />
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="w-4 h-4 accent-dp-secondary" />
                <span className="font-sans text-[13px] text-dp-on-surface">{t('g.active')}</span>
              </label>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? t('action.saving') : t('action.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog open={!!confirmDeleteId} title={t('in.deleteInstitute')} message={t('in.deleteConfirm')} onConfirm={remove} onCancel={() => setConfirmDeleteId(null)} />
    </div>
  )
}
