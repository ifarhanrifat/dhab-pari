'use client'

// Not a Publisher area — writing one is current_admin_role() IN
// (super_admin, admin) at the RLS layer (migration 303), same as this page's
// own AdminSidebar gate (adminAndAbove). This is the committee speaking in
// its own voice on the homepage, not another article category.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Eye, EyeOff, FolderKanban, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SITE_FEATURE_LINKS } from '@/lib/siteFeatureLinks'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Note {
  id: string; body_en: string; body_ur: string; release_date: string; is_published: boolean; created_at: string
  linked_project_id: string | null; link_url: string | null; link_label_en: string | null; link_label_ur: string | null
}
interface ProjectOpt { id: string; title: string; title_ur: string | null }
type LinkType = 'none' | 'project' | 'feature' | 'custom'

const today = () => new Date().toISOString().slice(0, 10)
const empty = {
  body_en: '', body_ur: '', release_date: today(), is_published: true,
  linkType: 'none' as LinkType, linked_project_id: '', feature_key: '',
  custom_url: '', custom_label_en: '', custom_label_ur: '',
}

export default function CommitteeNotesPage() {
  const { t, isUrdu } = useLocale()
  const [notes, setNotes] = useState<Note[]>([])
  const [projects, setProjects] = useState<ProjectOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const [{ data }, { data: projs }] = await Promise.all([
      // Ordered by when it was actually posted, not release_date (an
      // easy-to-mistype admin field) — matches the public site's identical
      // ordering, so what shows as "most recent" here agrees with what's
      // actually featured on the homepage.
      supabase.from('committee_notes').select('*').order('created_at', { ascending: false }),
      supabase.from('projects').select('id, title, title_ur').order('title'),
    ])
    setNotes(data ?? [])
    setProjects(projs ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const projectName = (id: string | null) => {
    if (!id) return null
    const p = projects.find((p) => p.id === id)
    return p ? (isUrdu && p.title_ur ? p.title_ur : p.title) : null
  }

  // Whichever of the three sources is set, one line to show it in the list —
  // the reader of this list never needs to know which of the three it came
  // from, only that the note has a link.
  const linkChip = (n: Note) => {
    const proj = projectName(n.linked_project_id)
    if (proj) return proj
    if (n.link_url) return (isUrdu ? n.link_label_ur : n.link_label_en) || n.link_label_en || n.link_label_ur
    return null
  }

  const save = async () => {
    if (!form.body_en.trim() && !form.body_ur.trim()) { toast.error(t('cmn.bodyRequired')); return }
    setSaving(true)
    const feature = form.linkType === 'feature' ? SITE_FEATURE_LINKS.find((f) => f.key === form.feature_key) : undefined
    const payload = {
      body_en: form.body_en, body_ur: form.body_ur, release_date: form.release_date, is_published: form.is_published,
      linked_project_id: form.linkType === 'project' ? (form.linked_project_id || null) : null,
      link_url: form.linkType === 'feature' ? (feature?.path ?? null) : form.linkType === 'custom' ? (form.custom_url.trim() || null) : null,
      link_label_en: form.linkType === 'feature' ? (feature?.labelEn ?? null) : form.linkType === 'custom' ? (form.custom_label_en.trim() || null) : null,
      link_label_ur: form.linkType === 'feature' ? (feature?.labelUr ?? null) : form.linkType === 'custom' ? (form.custom_label_ur.trim() || null) : null,
    }
    if (editing) {
      const { error } = await supabase.from('committee_notes').update(payload).eq('id', editing)
      setSaving(false)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('cmn.noteUpdated'))
    } else {
      const { error } = await supabase.from('committee_notes').insert(payload)
      setSaving(false)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('cmn.noteCreated'))
    }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }

  const togglePublish = async (n: Note) => {
    await supabase.from('committee_notes').update({ is_published: !n.is_published }).eq('id', n.id)
    load()
  }

  const edit = (n: Note) => {
    let linkType: LinkType = 'none'
    let feature_key = ''
    if (n.linked_project_id) linkType = 'project'
    else if (n.link_url) {
      const matched = SITE_FEATURE_LINKS.find((f) => f.path === n.link_url)
      if (matched) { linkType = 'feature'; feature_key = matched.key } else linkType = 'custom'
    }
    setForm({
      body_en: n.body_en, body_ur: n.body_ur, release_date: n.release_date, is_published: n.is_published,
      linkType, linked_project_id: n.linked_project_id ?? '', feature_key,
      custom_url: linkType === 'custom' ? (n.link_url ?? '') : '',
      custom_label_en: linkType === 'custom' ? (n.link_label_en ?? '') : '',
      custom_label_ur: linkType === 'custom' ? (n.link_label_ur ?? '') : '',
    })
    setEditing(n.id); setShowForm(true)
  }

  const remove = async () => {
    if (!confirmDeleteId) return
    await supabase.from('committee_notes').delete().eq('id', confirmDeleteId)
    toast.success(t('cmn.deletedToast'))
    setConfirmDeleteId(null)
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('cmn.title')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('cmn.newNote')}</button>
      </div>

      <div className="space-y-4">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && notes.length === 0 && <div className="text-center py-12 text-dp-on-surface-variant">{t('cmn.noNotes')}</div>}
        {!loading && notes.map((n) => (
          <div key={n.id} className="bg-white border border-dp-outline-variant rounded-lg p-5 flex flex-col md:flex-row md:items-start justify-between gap-4 hover:border-dp-secondary transition-all">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-sans text-[12px] font-bold text-dp-on-surface-variant">{new Date(n.release_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                {n.is_published ? <span className="text-dp-secondary text-[10px] font-bold font-sans flex items-center gap-1"><Eye size={12} />{t('g.published')}</span> : <span className="text-dp-on-surface-variant text-[10px] font-bold font-sans flex items-center gap-1"><EyeOff size={12} />{t('y.draft')}</span>}
              </div>
              {n.body_en && <p className="font-sans text-[14px] text-dp-on-surface mb-1">{n.body_en}</p>}
              {n.body_ur && <p className="font-sans text-[14px] text-dp-on-surface" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{n.body_ur}</p>}
              {linkChip(n) && (
                <p className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary mt-1.5">
                  {n.linked_project_id ? <FolderKanban size={12} /> : <Link2 size={12} />} {linkChip(n)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => togglePublish(n)} className={`px-3 py-1 rounded text-[14px] font-sans font-semibold cursor-pointer transition-all ${n.is_published ? 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container' : 'bg-dp-secondary text-white hover:bg-dp-primary'}`}>{n.is_published ? t('nw.unpublishBtn') : t('nw.publishBtn')}</button>
              <button onClick={() => edit(n)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => setConfirmDeleteId(n.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!confirmDeleteId}
        title={t('cmn.title')}
        message={t('cmn.confirmDelete')}
        onConfirm={remove}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? t('cmn.editNote') : t('cmn.newNote')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('cmn.releaseDate')}</label><input type="date" value={form.release_date} onChange={(e) => setForm({ ...form, release_date: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('cmn.bodyEn')}</label><textarea value={form.body_en} onChange={(e) => setForm({ ...form, body_en: e.target.value })} rows={5} className="input-field resize-none" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('cmn.bodyUr')}</label><textarea value={form.body_ur} onChange={(e) => setForm({ ...form, body_ur: e.target.value })} rows={5} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('cmn.linkedProject')}</label>
                <select value={form.linkType} onChange={(e) => setForm({ ...form, linkType: e.target.value as LinkType })} className="input-field">
                  <option value="none">{t('cmn.linkNone')}</option>
                  <option value="project">{t('cmn.linkTypeProject')}</option>
                  <option value="feature">{t('cmn.linkTypeFeature')}</option>
                  <option value="custom">{t('cmn.linkTypeCustom')}</option>
                </select>

                {form.linkType === 'project' && (
                  <select value={form.linked_project_id} onChange={(e) => setForm({ ...form, linked_project_id: e.target.value })} className="input-field mt-2">
                    <option value="">{t('a.select')}</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.title}{p.title_ur ? ` — ${p.title_ur}` : ''}</option>)}
                  </select>
                )}

                {form.linkType === 'feature' && (
                  <select value={form.feature_key} onChange={(e) => setForm({ ...form, feature_key: e.target.value })} className="input-field mt-2">
                    <option value="">{t('a.select')}</option>
                    {SITE_FEATURE_LINKS.map((f) => <option key={f.key} value={f.key}>{f.labelEn} — {f.labelUr}</option>)}
                  </select>
                )}

                {form.linkType === 'custom' && (
                  <div className="space-y-2 mt-2">
                    <input value={form.custom_url} onChange={(e) => setForm({ ...form, custom_url: e.target.value })} placeholder={t('cmn.customUrlPlaceholder')} className="input-field" />
                    <input value={form.custom_label_en} onChange={(e) => setForm({ ...form, custom_label_en: e.target.value })} placeholder={t('cmn.customLabelEnPlaceholder')} className="input-field" />
                    <input value={form.custom_label_ur} onChange={(e) => setForm({ ...form, custom_label_ur: e.target.value })} placeholder={t('cmn.customLabelUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                  </div>
                )}

                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{t('cmn.linkedProjectHint')}</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('cmn.publishToHomepage')}</span></label>
              <button disabled={saving} onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{editing ? t('cmn.updateNote') : t('cmn.createNote')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
