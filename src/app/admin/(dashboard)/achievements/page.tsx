'use client'

// Staff view of everything feeding the public Achievements page
// (migration 346/347) — meeting tasks, completed projects, and fulfilled
// Talent Showcase needs all land here automatically; this page's only
// actual write surface is manual_achievements, for anything real that
// doesn't come from an automated status change (a feature launched, a
// one-off achievement worth announcing).
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Trophy, Plus, Trash2, Lock, CheckCircle } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Achievement { id: string; done_at: string; is_private: boolean; text_ur: string | null; done_by_name: string | null; source: string }

export default function AdminAchievementsPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [items, setItems] = useState<Achievement[]>([])
  const [loading, setLoading] = useState(true)
  const [newText, setNewText] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const load = async () => {
    const { data } = await supabase.from('achievements_public').select('*')
    setItems((data ?? []) as Achievement[])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!newText.trim()) { toast.error(t('ach.textRequired')); return }
    setAdding(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: admin } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const { error } = await supabase.from('manual_achievements').insert({ text_ur: newText.trim(), added_by: admin!.id })
    setAdding(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('ach.added'))
    setNewText('')
    load()
  }

  const remove = async () => {
    if (!confirmDeleteId) return
    const { error } = await supabase.from('manual_achievements').delete().eq('id', confirmDeleteId)
    setConfirmDeleteId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('ach.deleted'))
    load()
  }

  const sourceLabel = (s: string) => (
    s === 'meeting' ? t('ach.sourceMeeting') : s === 'project' ? t('ach.sourceProject') : s === 'talent' ? t('ach.sourceTalent') : t('ach.sourceManual')
  )

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><Trophy size={26} className="text-dp-secondary" /> {t('ach.title')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed max-w-2xl">{t('ach.blurb')}</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-6 flex items-start gap-2.5">
        <textarea value={newText} onChange={(e) => setNewText(e.target.value)} rows={2} placeholder={t('ach.addPlaceholder')} className="input-field resize-none flex-1" dir="rtl" />
        <button onClick={add} disabled={adding} className="flex items-center gap-1.5 bg-dp-secondary text-white px-4 py-2.5 rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 shrink-0">
          <Plus size={15} /> {t('ach.add')}
        </button>
      </div>

      {loading ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[13px]"><LoadingDots /></p>
      ) : items.length === 0 ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[13px]">{t('x.nothingCompletedYet')}</p>
      ) : (
        <div className="space-y-2.5">
          {items.map((a) => (
            <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-start gap-3">
              {a.is_private ? <Lock size={16} className="text-dp-on-surface-variant shrink-0 mt-0.5" /> : <CheckCircle size={16} className="text-dp-secondary shrink-0 mt-0.5" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold text-dp-on-surface-variant bg-dp-surface-container-low rounded-full px-2 py-0.5">{sourceLabel(a.source)}</span>
                  <span className="font-sans text-[11px] text-dp-on-surface-variant">{new Date(a.done_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
                </div>
                {a.is_private ? (
                  <p className="font-sans text-[13.5px] text-dp-on-surface-variant italic mt-1">{t('x.privateCompletedBy')} <span className="font-semibold not-italic">{a.done_by_name ?? '—'}</span></p>
                ) : (
                  <>
                    <p className="font-sans text-[14px] text-dp-on-surface mt-1" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{a.text_ur}</p>
                    {a.done_by_name && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('x.completedBy')} <span className="font-semibold">{a.done_by_name}</span></p>}
                  </>
                )}
              </div>
              {a.source === 'manual' && (
                <button onClick={() => setConfirmDeleteId(a.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer shrink-0"><Trash2 size={15} /></button>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog open={!!confirmDeleteId} title={t('ts.deleteEntry')} message={t('ach.deleteConfirm')} onConfirm={remove} onCancel={() => setConfirmDeleteId(null)} />
    </div>
  )
}
