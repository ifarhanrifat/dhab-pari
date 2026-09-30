'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { AlertTriangle, PlusCircle, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'

interface Report {
  id: string; category: string; title: string; description: string | null; photo_url: string | null
  location_text: string | null; status: string; admin_notes: string | null; created_at: string
}

const CATEGORIES = ['street_light', 'garbage', 'water', 'road', 'drainage', 'electricity', 'stray_animals', 'other']
const empty = { category: 'street_light', title: '', description: '', photo_url: '', location_text: '' }

const STATUS_TONE: Record<string, string> = {
  reported: 'bg-amber-100 text-amber-700', assigned: 'bg-sky-100 text-sky-700',
  in_progress: 'bg-blue-100 text-blue-700', fixed: 'bg-emerald-100 text-emerald-700',
}

// Real gap, 2026-09-30 (Phase 1 of the "Village OS" feature set): the
// existing `complaints` table only ever covered billing/donation disputes
// -- there was nowhere to report a broken street light or a garbage
// problem. Deliberately public once submitted (civic_reports_public_read
// has no owner filter) -- the whole point is the village can watch its
// own reported problems get fixed, same transparency stance as the
// Development Tracker.
export default function ReportProblemPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const { data } = await supabase.from('civic_reports').select('*').eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setReports(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const save = async () => {
    if (!user) return
    if (!form.title.trim()) { toast.error(t('cr.titleRequired')); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('civic_reports').insert({
      portal_user_id: user.id, category: form.category, title: form.title.trim(),
      description: form.description.trim() || null, photo_url: form.photo_url || null,
      location_text: form.location_text.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cr.reportSubmitted'))
    setShowForm(false); setForm(empty); load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><AlertTriangle size={22} className="text-dp-secondary" /> {t('cr.myReports')} <PortalHelp pageKey="reportProblem" /></h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('cr.blurb')}</p>
        </div>
        <button onClick={() => { setForm(empty); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {t('cr.newReport')}
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : reports.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('cr.noReports')}</p>
        </div>
      ) : (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="space-y-3 max-w-xl">
          {reports.map((r) => (
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`cr.cat.${r.category}`)}</span>
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{r.title}</p>
                  {r.location_text && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{r.location_text}</p>}
                  {r.admin_notes && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5 bg-dp-surface-container-low rounded p-2">{r.admin_notes}</p>}
                </div>
                <span className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full uppercase shrink-0 ${STATUS_TONE[r.status]}`}>{t(`cr.status.${r.status}`)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('cr.newReport')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.category')}</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cr.cat.${c}`)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cr.problemTitle')}</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('cr.problemTitlePlaceholder')} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.descriptionOptional')}</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" />
              </div>
              <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('lf.photoOptional')} />
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('lf.location')}</label>
                <input value={form.location_text} onChange={(e) => setForm({ ...form, location_text: e.target.value })} placeholder={t('cr.locationPlaceholder')} className="input-field" />
              </div>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? t('p.saving') : t('cr.submitReport')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
