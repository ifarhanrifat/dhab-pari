'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, X, Check } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Report {
  id: string; category: string; title: string; description: string | null; photo_url: string | null
  location_text: string | null; status: string; admin_notes: string | null; created_at: string
  moderation_status: string; is_active: boolean
  portal_users: { full_name: string; mobile: string | null } | { full_name: string; mobile: string | null }[] | null
}

const STATUSES = ['reported', 'assigned', 'in_progress', 'fixed']
const STATUS_TONE: Record<string, string> = {
  reported: 'bg-amber-100 text-amber-700', assigned: 'bg-sky-100 text-sky-700',
  in_progress: 'bg-blue-100 text-blue-700', fixed: 'bg-emerald-100 text-emerald-700',
}

// Real direction, 2026-09-30: nothing posts to the public board
// automatically -- a Pending tab gate before the existing
// Reported->Assigned->In Progress->Fixed workflow even starts.
export default function AdminCivicReportsPage() {
  const { t, isUrdu } = useLocale()
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const [statusFilter, setStatusFilter] = useState('')
  const [editing, setEditing] = useState<Report | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [statusDraft, setStatusDraft] = useState('')
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('civic_reports').select('*, portal_users(full_name, mobile)').order('created_at', { ascending: false })
    setReports((data ?? []) as Report[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const reviewer = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    return me?.id
  }

  const approve = async (r: Report) => {
    const reviewedBy = await reviewer()
    const { error } = await supabase.from('civic_reports').update({ moderation_status: 'approved', is_active: true, reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.approved')); load()
  }
  const reject = async (r: Report) => {
    const reviewedBy = await reviewer()
    const { error } = await supabase.from('civic_reports').update({ moderation_status: 'rejected', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.rejected')); load()
  }

  const openEdit = (r: Report) => { setEditing(r); setStatusDraft(r.status); setNotesDraft(r.admin_notes ?? '') }
  const save = async () => {
    if (!editing) return
    const { error } = await supabase.from('civic_reports').update({ status: statusDraft, admin_notes: notesDraft.trim() || null, updated_at: new Date().toISOString() }).eq('id', editing.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cr.updated')); setEditing(null); load()
  }

  const pending = reports.filter((r) => r.moderation_status === 'pending')
  const approved = reports.filter((r) => r.moderation_status === 'approved')
  const shown = (tab === 'pending' ? pending : approved).filter((r) => tab === 'pending' || !statusFilter || r.status === statusFilter)
  const reporterOf = (r: Report) => Array.isArray(r.portal_users) ? r.portal_users[0] : r.portal_users

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><AlertTriangle size={26} /> {t('cr.pageTitle')}</h1>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTab('pending')} className={`px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${tab === 'pending' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t('mod.pending')} {pending.length > 0 && `(${pending.length})`}
          </button>
          <button onClick={() => setTab('approved')} className={`px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${tab === 'approved' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t('mod.approved')}
          </button>
          {tab === 'approved' && (
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input-field w-auto">
              <option value="">{t('cr.allStatuses')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`cr.status.${s}`)}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && shown.map((r) => {
          const reporter = reporterOf(r)
          return (
            <div key={r.id} className={`bg-white border rounded-lg p-4 flex items-center justify-between gap-4 ${tab === 'pending' ? 'border-amber-300' : 'border-dp-outline-variant'}`}>
              <button onClick={() => tab === 'approved' && openEdit(r)} className="min-w-0 text-start flex-1 cursor-pointer">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high uppercase font-sans">{t(`cr.cat.${r.category}`)}</span>
                  {tab === 'approved' && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${STATUS_TONE[r.status]}`}>{t(`cr.status.${r.status}`)}</span>}
                </div>
                <p className="font-sans text-[15px] font-bold text-dp-on-surface mt-1 truncate">{r.title}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{reporter?.full_name ?? '—'}{reporter?.mobile ? ` · ${reporter.mobile}` : ''}{r.location_text ? ` · ${r.location_text}` : ''}</p>
              </button>
              {tab === 'pending' && (
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => approve(r)} title={t('mod.approve')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700"><Check size={15} /></button>
                  <button onClick={() => reject(r)} title={t('mod.reject')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><X size={15} /></button>
                </div>
              )}
            </div>
          )
        })}
        {!loading && shown.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{tab === 'pending' ? t('mod.nothingPending') : t('cr.noneFound')}</p>}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editing.title}</h2>
              <button onClick={() => setEditing(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            {editing.photo_url && <img src={editing.photo_url} alt="" className="w-full rounded-lg mb-4 max-h-64 object-cover" />}
            {editing.description && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-4">{editing.description}</p>}
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cr.status.label')}</label>
                <select value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)} className="input-field">
                  {STATUSES.map((s) => <option key={s} value={s}>{t(`cr.status.${s}`)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cr.adminNotes')}</label>
                <textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={3} className="input-field resize-none" placeholder={t('cr.adminNotesPlaceholder')} />
              </div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{t('ic.updateBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
