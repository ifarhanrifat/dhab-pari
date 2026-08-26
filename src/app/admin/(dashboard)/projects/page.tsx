'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Eye, EyeOff, Zap, Lock, LockOpen } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Project { id: string; title: string; title_ur: string | null; description: string | null; description_ur: string | null; status: string; progress_percent: number; budget_pkr: number | null; spent_pkr: number | null; category: string | null; location: string | null; sector: string | null; is_featured: boolean; before_image_url: string | null; after_image_url: string | null; start_date: string | null; end_date: string | null; beneficiaries_count: number | null; funding_model: string | null; monthly_operating_cost_pkr: number | null
  // Migration 311 — a donor-proposed project, its badge-tier fast-track
  // flag (skips community voting), and the staff-only visibility switch.
  admin_hidden: boolean; skip_voting: boolean; proposed_by_portal_user_id: string | null
  // Migration 359 — fully invisible to the public (not admin_hidden, which
  // means "draft/rejected proposal", a different concept from "this is a
  // real, live project that must never be individually identifiable").
  is_private: boolean }

const statuses = ['ongoing', 'completed', 'upcoming']
const categories = ['infrastructure', 'water', 'health', 'education', 'environment', 'welfare', 'sports', 'other']
// Values are i18n keys (module scope has no useLocale()) — resolved via
// t() at render time.
const statusLabelKey: Record<string, string> = {
  ongoing: 'pj.statusOngoing', completed: 'pj.statusCompleted', upcoming: 'pj.statusUpcoming',
  announced: 'pj.statusAnnounced', reviewing: 'pj.statusReviewing', rejected: 'pj.statusRejected',
}
const categoryLabelKey: Record<string, string> = {
  infrastructure: 'pj.catInfrastructure', water: 'pj.catWater', health: 'pj.catHealth', education: 'pj.catEducation',
  environment: 'pj.catEnvironment', welfare: 'pj.catWelfare', sports: 'pj.catSports', other: 'pj.catOther',
}

const empty = { title: '', title_ur: '', description: '', description_ur: '', status: 'upcoming', progress_percent: 0, budget_pkr: 0, spent_pkr: 0, category: 'infrastructure', location: '', sector: '', is_featured: false, before_image_url: '', after_image_url: '', start_date: '', end_date: '', beneficiaries_count: 0, funding_model: 'one_time', monthly_operating_cost_pkr: 0, is_private: false }

export default function AdminProjectsPage() {
  const { t, isUrdu } = useLocale()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [filter, setFilter] = useState('all')
  const supabase = createClient()

  const load = async () => { const { data } = await supabase.from('projects').select('*').order('created_at', { ascending: false }); setProjects(data ?? []); setLoading(false) }
  useEffect(() => { load() }, [])

  const filtered = filter === 'all' ? projects : projects.filter((p) => p.status === filter)

  const save = async () => {
    if (!form.title.trim()) { toast.error(t('pj.titleRequired')); return }
    const payload = {
      ...form, budget_pkr: form.budget_pkr || null, spent_pkr: form.spent_pkr || null, start_date: form.start_date || null,
      end_date: form.end_date || null, beneficiaries_count: form.beneficiaries_count || null, sector: form.sector || null,
      description_ur: form.description_ur || null,
      monthly_operating_cost_pkr: form.funding_model === 'recurring_support' ? (form.monthly_operating_cost_pkr || null) : null,
    }
    if (editing) {
      const { error } = await supabase.from('projects').update(payload).eq('id', editing)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('pj.projectUpdated'))
    } else {
      const { error } = await supabase.from('projects').insert(payload)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('pj.projectCreated'))
    }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }

  const edit = (p: Project) => { setForm({ title: p.title, title_ur: p.title_ur ?? '', description: p.description ?? '', description_ur: p.description_ur ?? '', status: p.status, progress_percent: p.progress_percent, budget_pkr: p.budget_pkr ?? 0, spent_pkr: p.spent_pkr ?? 0, category: p.category ?? 'other', location: p.location ?? '', sector: p.sector ?? '', is_featured: p.is_featured, before_image_url: p.before_image_url ?? '', after_image_url: p.after_image_url ?? '', start_date: p.start_date ?? '', end_date: p.end_date ?? '', beneficiaries_count: p.beneficiaries_count ?? 0, funding_model: p.funding_model ?? 'one_time', monthly_operating_cost_pkr: p.monthly_operating_cost_pkr ?? 0, is_private: p.is_private }); setEditing(p.id); setShowForm(true) }

  const remove = async (id: string) => { if (!confirm(t('pj.confirmDelete'))) return; await supabase.from('projects').delete().eq('id', id); toast.success(t('pj.deleted')); load() }
  // Pulls a donor-submitted proposal out of public view without rejecting
  // it outright — independent of status, so it works on a fast-tracked
  // (skip_voting) proposal just as well as a normal one awaiting votes.
  const toggleHidden = async (p: Project) => {
    const { error } = await supabase.from('projects').update({ admin_hidden: !p.admin_hidden }).eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(p.admin_hidden ? t('pj.unhiddenToast') : t('pj.hiddenToast'))
    load()
  }

  // Fully invisible to the public (RLS blocks it, not a client-side filter
  // that could be forgotten on some page) — available on every project,
  // not just donor-proposed ones like toggleHidden above.
  const togglePrivate = async (p: Project) => {
    const { error } = await supabase.from('projects').update({ is_private: !p.is_private }).eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(p.is_private ? t('pj.madePublicToast') : t('pj.madePrivateToast'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="font-heading text-[26px] sm:text-[32px] font-bold leading-[34px] sm:leading-[40px] text-dp-primary">{t('z.projects')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('z.newProject')}</button>
      </div>
      <div className="flex flex-wrap gap-3 mb-6">
        {['all', ...statuses].map((s) => <button key={s} onClick={() => setFilter(s)} className={`px-4 py-1.5 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em] cursor-pointer transition-all ${filter === s ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>{s === 'all' ? t('pj.filterAll') : t(statusLabelKey[s] ?? s)}</button>)}
      </div>
      <div className="space-y-4">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant">{t('action.loading')}</div>}
        {!loading && filtered.map((p) => (
          <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-dp-secondary transition-all">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1 flex-wrap">
                <StatusPill status={p.status} />
                {p.is_featured && <span className="text-[10px] font-bold text-amber-600 font-sans">{t('pj.featuredBadge')}</span>}
                {p.proposed_by_portal_user_id && p.skip_voting && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-700 bg-indigo-50 rounded-full px-2 py-0.5 font-sans"><Zap size={11} /> {t('pj.fastTrackBadge')}</span>
                )}
                {p.admin_hidden && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-dp-error bg-dp-error/10 rounded-full px-2 py-0.5 font-sans"><EyeOff size={11} /> {t('pj.hiddenBadge')}</span>
                )}
                {p.is_private && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-700 bg-purple-50 rounded-full px-2 py-0.5 font-sans"><Lock size={11} /> {t('pj.privateBadge')}</span>
                )}
              </div>
              <h3 className="font-sans text-[18px] font-bold text-dp-on-surface truncate">{p.title}</h3>
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t(categoryLabelKey[p.category ?? ''] ?? p.category ?? '', p.category ?? '')} · {p.location} · {p.progress_percent}%</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-32 bg-dp-surface-container-high h-2 rounded-full overflow-hidden"><div className="h-full bg-dp-secondary" style={{ width: `${p.progress_percent}%` }} /></div>
              {p.proposed_by_portal_user_id && (
                <button onClick={() => toggleHidden(p)} title={t(p.admin_hidden ? 'pj.unhideAction' : 'pj.hideAction')}
                  className={`p-2 rounded-lg cursor-pointer ${p.admin_hidden ? 'text-dp-error hover:bg-dp-error/10' : 'text-dp-on-surface-variant hover:bg-dp-surface-container'}`}>
                  {p.admin_hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              )}
              <button onClick={() => togglePrivate(p)} title={t(p.is_private ? 'pj.makePublicAction' : 'pj.makePrivateAction')}
                className={`p-2 rounded-lg cursor-pointer ${p.is_private ? 'text-purple-700 hover:bg-purple-50' : 'text-dp-on-surface-variant hover:bg-dp-surface-container'}`}>
                {p.is_private ? <Lock size={16} /> : <LockOpen size={16} />}
              </button>
              <button onClick={() => edit(p)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(p.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {!loading && filtered.length === 0 && <div className="text-center py-12 text-dp-on-surface-variant">{t('z.noProjectsFound')}</div>}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary">{editing ? t('pj.editProjectTitle') : t('pj.newProjectTitle')}</h2>
              <button onClick={() => setShowForm(false)} className="text-dp-on-surface-variant cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.titleEn')}</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.titleUr')}</label><input value={form.title_ur} onChange={(e) => setForm({ ...form, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.description')}</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.descriptionUr')}</label><textarea value={form.description_ur} onChange={(e) => setForm({ ...form, description_ur: e.target.value })} rows={3} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.status')}</label><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input-field">{statuses.map((s) => <option key={s} value={s}>{t(statusLabelKey[s] ?? s)}</option>)}</select></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.category')}</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">{categories.map((c) => <option key={c} value={c}>{t(categoryLabelKey[c] ?? c)}</option>)}</select></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('pj.progressLabel')} {form.progress_percent}%</label><input type="range" min={0} max={100} value={form.progress_percent} onChange={(e) => setForm({ ...form, progress_percent: +e.target.value })} className="w-full accent-dp-secondary" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.budgetPkr')}</label><input type="number" value={form.budget_pkr || ''} onChange={(e) => setForm({ ...form, budget_pkr: +e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.spentPkr')}</label><input type="number" value={form.spent_pkr || ''} onChange={(e) => setForm({ ...form, spent_pkr: +e.target.value })} className="input-field" /></div>
              </div>
              <div className="border border-dp-outline-variant rounded-lg p-4">
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <input type="checkbox" checked={form.funding_model === 'recurring_support'} onChange={(e) => setForm({ ...form, funding_model: e.target.checked ? 'recurring_support' : 'one_time' })} className="accent-dp-secondary" />
                  <span className="font-sans text-[14px] font-semibold">{t('z.needsMonthly')}</span>
                </label>
                {form.funding_model === 'recurring_support' && (
                  <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.monthlyOperating')}</label><input type="number" value={form.monthly_operating_cost_pkr || ''} onChange={(e) => setForm({ ...form, monthly_operating_cost_pkr: +e.target.value })} className="input-field" /></div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('g.startDate')}</label><input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.endDate')}</label><input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} className="input-field" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.location')}</label><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.sector')}</label><input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} placeholder={t('pj.sectorPlaceholder')} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.beneficiaries')}</label><input type="number" value={form.beneficiaries_count || ''} onChange={(e) => setForm({ ...form, beneficiaries_count: +e.target.value })} className="input-field" /></div>
              <div className="grid grid-cols-2 gap-4">
                <ImageUpload bucket="images" currentUrl={form.before_image_url} onUpload={(url) => setForm({ ...form, before_image_url: url })} label={t('pj.beforePhoto')} />
                <ImageUpload bucket="images" currentUrl={form.after_image_url} onUpload={(url) => setForm({ ...form, after_image_url: url })} label={t('pj.afterPhoto')} />
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_featured} onChange={(e) => setForm({ ...form, is_featured: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('z.featuredProject')}</span></label>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_private} onChange={(e) => setForm({ ...form, is_private: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('pj.privateProject')}</span></label>
              {form.is_private && <p className="font-sans text-[12px] text-dp-on-surface-variant -mt-2">{t('pj.privateProjectHint')}</p>}
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">{editing ? t('pj.updateProjectBtn') : t('pj.createProjectBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const { t } = useLocale()
  const s: Record<string, string> = { ongoing: 'bg-amber-100 text-amber-800', completed: 'bg-dp-primary text-white', upcoming: 'bg-blue-100 text-blue-800', announced: 'bg-slate-200 text-slate-600', reviewing: 'bg-purple-100 text-purple-800', rejected: 'bg-red-100 text-red-700' }
  return <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full font-sans ${s[status] ?? ''}`}>{t(statusLabelKey[status] ?? status, status)}</span>
}
