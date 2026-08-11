'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HeartHandshake, PlusCircle, X, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Signup { id: string; project_id: string | null; message: string | null; status: string; created_at: string }
interface ProjectOption { id: string; title: string }
interface MyTask {
  id: string; project_id: string; title: string; title_ur: string | null
  detail: string | null; due_date: string | null; status: string
}

const STATUS_LABEL: Record<string, string> = { offered: 'Offered', assigned: 'Assigned', completed: 'Completed' }

// Bilingual because this form is answered by residents, not staff — and the
// answers are what let the committee hand out work without a phone call first.
const HELP_TYPES: { id: string; en: string; ur: string }[] = [
  { id: 'physical', en: 'Physical work at the site', ur: 'سائٹ پر جسمانی کام' },
  { id: 'skilled', en: 'Skilled trade (mason, plumber, electrician, carpenter)', ur: 'ہنر مند کام (مستری، پلمبر، الیکٹریشن، بڑھئی)' },
  { id: 'professional', en: 'Professional help (accounts, IT, teaching, medical)', ur: 'پیشہ ورانہ مدد (حسابات، آئی ٹی، تدریس، طبی)' },
  { id: 'transport', en: 'Transport — I have a vehicle', ur: 'ٹرانسپورٹ — میرے پاس گاڑی ہے' },
  { id: 'purchasing', en: 'Purchasing and errands outside the village', ur: 'خریداری اور گاؤں سے باہر کے کام' },
  { id: 'financial', en: 'Financial support', ur: 'مالی تعاون' },
  { id: 'moral', en: 'Moral support and advice', ur: 'اخلاقی مدد اور مشورہ' },
]
const AVAILABILITY: { id: string; en: string; ur: string }[] = [
  { id: 'anytime', en: 'Any time', ur: 'کسی بھی وقت' },
  { id: 'weekdays', en: 'Weekdays', ur: 'کام کے دن' },
  { id: 'weekends', en: 'Weekends', ur: 'ہفتہ اتوار' },
  { id: 'evenings', en: 'Evenings only', ur: 'صرف شام کو' },
  { id: 'emergency_only', en: 'Emergencies only', ur: 'صرف ہنگامی حالات میں' },
]

export default function PortalMyVolunteeringPage() {
  const { t } = useLocale()
  const { t: tr } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [signups, setSignups] = useState<Signup[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [message, setMessage] = useState('')
  const [helpTypes, setHelpTypes] = useState<string[]>([])
  const [availability, setAvailability] = useState('anytime')
  const [canTravel, setCanTravel] = useState(false)
  const [skills, setSkills] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [myTasks, setMyTasks] = useState<MyTask[]>([])

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const [{ data: s }, { data: p }] = await Promise.all([
      supabase.from('volunteers').select('id, project_id, message, status, created_at').eq('portal_user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('projects').select('id, title').in('status', ['ongoing', 'reviewing']).order('title'),
    ])
    // project_tasks RLS only returns tasks on projects this person is an
    // *assigned* volunteer of, so the list opens when they are accepted and
    // empties on its own when the project closes them out. No filter here.
    const { data: t } = await supabase.from('project_tasks')
      .select('id, project_id, title, title_ur, detail, due_date, status')
      .eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setSignups(s ?? [])
    setProjects(p ?? [])
    setMyTasks((t ?? []) as MyTask[])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const projectTitle = (id: string | null) => id ? (projects.find((p) => p.id === id)?.title ?? 'A Project') : 'General — Any Project'

  const toggleHelp = (id: string) =>
    setHelpTypes((prev) => prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id])

  const submit = async () => {
    if (!user) return
    if (helpTypes.length === 0) { toast.error('Please choose at least one way you can help'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('volunteers').insert({
      portal_user_id: user.id, project_id: projectId || null, message: message.trim() || null,
      help_types: helpTypes, availability, can_travel: canTravel, skills: skills.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Signed up — thank you!')
    setShowForm(false)
    setProjectId('')
    setMessage('')
    setHelpTypes([])
    setAvailability('anytime')
    setCanTravel(false)
    setSkills('')
    load()
  }

  const setTaskStatus = async (id: string, status: string) => {
    const supabase = createClient()
    const { error } = await supabase.from('project_tasks').update({ status }).eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(status === 'done' ? 'Marked done — thank you' : 'Updated')
    load()
  }

  const remove = async (id: string) => {
    const supabase = createClient()
    const { error } = await supabase.from('volunteers').delete().eq('id', id)
    setConfirmDelete(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Removed')
    load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{tr('action.loading')}</div>

  return (
    <>
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HeartHandshake size={22} className="text-dp-secondary" /> {tr('p.myVolunteering')}</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{tr('p.signupsBlurb')}</p>
        </div>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {tr('p.newSignup')}
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{tr('action.loading')}</p>
      ) : signups.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('p.noSignups')}</p>
        </div>
      ) : (
        <div className="space-y-3 max-w-xl">
          {signups.map((s) => (
            <div key={s.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{STATUS_LABEL[s.status] ?? s.status}</span>
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{projectTitle(s.project_id)}</p>
                  {s.message && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{s.message}</p>}
                </div>
                <button onClick={() => setConfirmDelete(s.id)} className="p-2 text-dp-on-surface-variant hover:text-dp-error cursor-pointer shrink-0"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {myTasks.filter((t) => t.status !== 'cancelled').length > 0 && (
        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low">
            <span className="font-sans text-[14px] font-bold text-dp-on-surface">{tr('p.myTasks')}</span>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{tr('p.tasksBlurb')}</p>
          </div>
          {myTasks.filter((t) => t.status !== 'cancelled').map((t) => (
            <div key={t.id} className="px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[14.5px] font-semibold text-dp-on-surface">{t.title}</p>
                  {t.title_ur && <p className="font-sans text-[13px] text-dp-on-surface-variant" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{t.title_ur}</p>}
                  {t.detail && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{t.detail}</p>}
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                    {projectTitle(t.project_id)}
                    {t.due_date && ` · due ${new Date(t.due_date).toLocaleDateString('en-GB')}`}
                  </p>
                </div>
                <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full font-sans uppercase shrink-0 bg-dp-secondary-container text-dp-on-secondary-container">{t.status.replace('_', ' ')}</span>
              </div>
              {t.status !== 'done' && (
                <div className="flex gap-2 mt-2.5">
                  {t.status === 'pending' && (
                    <button onClick={() => setTaskStatus(t.id, 'in_progress')} className="px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[12.5px] font-semibold text-dp-on-surface cursor-pointer hover:bg-dp-surface-container-low transition-all">{tr('p.start')}</button>
                  )}
                  <button onClick={() => setTaskStatus(t.id, 'done')} className="px-3 py-1.5 rounded-lg bg-dp-secondary text-white font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">{tr('p.markDone')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{tr('p.newSignup')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('p.projectOptional')}</label>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input-field">
                  <option value="">{tr('p.generalAnyProject')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
                  {tr('p.howCanYouHelp')} <span className="text-dp-error">*</span>
                  <span className="block font-normal text-[12px] text-dp-on-surface-variant" dir="rtl">آپ کس طرح مدد کر سکتے ہیں؟</span>
                </label>
                <div className="space-y-1.5">
                  {HELP_TYPES.map((h) => (
                    <label key={h.id} className="flex items-start gap-2.5 p-2 rounded-lg border border-dp-outline-variant cursor-pointer hover:bg-dp-surface-container-low transition-all">
                      <input type="checkbox" checked={helpTypes.includes(h.id)} onChange={() => toggleHelp(h.id)} className="accent-dp-secondary mt-0.5 cursor-pointer" />
                      <span className="min-w-0">
                        <span className="block font-sans text-[13px] text-dp-on-surface">{h.en}</span>
                        <span className="block font-sans text-[12px] text-dp-on-surface-variant" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{h.ur}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
                  {tr('p.whenFree')}
                  <span className="block font-normal text-[12px]" dir="rtl">آپ عام طور پر کب فارغ ہوتے ہیں؟</span>
                </label>
                <select value={availability} onChange={(e) => setAvailability(e.target.value)} className="input-field">
                  {AVAILABILITY.map((a) => <option key={a.id} value={a.id}>{a.en} — {a.ur}</option>)}
                </select>
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={canTravel} onChange={(e) => setCanTravel(e.target.checked)} className="accent-dp-secondary mt-0.5 cursor-pointer" />
                <span className="min-w-0">
                  <span className="block font-sans text-[13px] text-dp-on-surface">I can travel outside the village if needed</span>
                  <span className="block font-sans text-[12px] text-dp-on-surface-variant" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>ضرورت پڑنے پر میں گاؤں سے باہر جا سکتا ہوں</span>
                </span>
              </label>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
                  {tr('p.specialSkill')}
                  <span className="block font-normal text-[12px]" dir="rtl">کوئی خاص ہنر جو ہمیں معلوم ہونا چاہیے؟</span>
                </label>
                <input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="e.g. welder, tractor driver, first aid" className="input-field" />
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('p.anythingElse')}</label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} className="input-field resize-none" />
              </div>
              <button onClick={submit} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Remove this volunteer signup?"
        message="You can always sign up again later."
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  )
}
