'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HeartHandshake, HandHeart, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface VolunteerRow {
  id: string; project_id: string | null; message: string | null; status: string; created_at: string
  full_name: string; avatar_url: string | null
}
interface ProjectOption { id: string; title: string; display_name: string | null }

const STATUS_LABEL: Record<string, string> = { offered: 'Offered', assigned: 'Assigned', completed: 'Completed' }

// Public directory, same reasoning as the Village Job Board — volunteering
// is meant to be seen ("this person joined as a volunteer"), not private.
export default function VolunteerPage() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const [volunteers, setVolunteers] = useState<VolunteerRow[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const supabase = createClient()
    const [{ data: v }, { data: p }] = await Promise.all([
      supabase.from('volunteers_public').select('*').order('created_at', { ascending: false }),
      supabase.from('projects').select('id, title, display_name').in('status', ['ongoing', 'reviewing']).eq('unlisted', false).order('title'),
    ])
    setVolunteers(v ?? [])
    setProjects(p ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const projectTitle = (id: string | null) => id ? (projects.find((p) => p.id === id)?.title ?? 'A Project') : 'General — Any Project'

  const submit = async () => {
    if (!user) { toast.error('Log in to sign up as a volunteer'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('volunteers').insert({
      portal_user_id: user.id, project_id: projectId || null, message: message.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Thank you for volunteering!')
    setShowForm(false)
    setProjectId('')
    setMessage('')
    load()
  }

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="mb-8 flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-heading text-[23px] font-bold leading-[28px] text-slate-800 flex items-center gap-3"><HeartHandshake size={28} className="text-dp2-primary-dark" /> {t('p.volunteer')}</h1>
          <p className="text-slate-500 font-sans text-[17px] leading-[26px] max-w-2xl mt-2">
            Offer your time for a specific project, or sign up generally and the committee will reach out when help is needed.
          </p>
        </div>
        <button onClick={() => (user ? setShowForm(true) : toast.error('Log in to sign up as a volunteer'))} className="shrink-0 flex items-center gap-2 px-5 py-2.5 bg-dp2-primary-dark text-white rounded-xl font-sans text-[15px] font-semibold hover:bg-dp2-primary transition-all cursor-pointer">
          <HandHeart size={16} /> {t('x.volunteerNow')}
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[15px] text-slate-500 text-center py-16"><LoadingDots /></p>
      ) : volunteers.length === 0 ? (
        <div className="text-center py-16 text-slate-500 font-sans text-[17px]">{t('x.noVolunteersYet')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {volunteers.map((v) => (
            <div key={v.id} className="bg-white border border-dp2-card-border rounded-2xl p-5 flex gap-3">
              {v.avatar_url ? <Image src={v.avatar_url} alt="" width={40} height={40} className="w-10 h-10 rounded-full object-cover shrink-0" /> : <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-[14px] font-bold text-emerald-700 shrink-0">{v.full_name.charAt(0).toUpperCase()}</div>}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-sans text-[16px] font-semibold text-slate-800 truncate">{v.full_name}</p>
                  <span className="text-[11.5px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 uppercase shrink-0">{STATUS_LABEL[v.status] ?? v.status}</span>
                </div>
                <p className="font-sans text-[14px] text-dp2-primary-dark font-semibold mt-0.5">{projectTitle(v.project_id)}</p>
                {v.message && <p className={`font-sans text-[14px] text-slate-500 mt-1.5 ${isUrdu ? 'leading-[22px]' : 'leading-[19px]'}`}>{v.message}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[21px] font-bold text-dp2-primary">{t('p.volunteer')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-slate-500"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[14px] font-semibold text-slate-500 mb-1.5">{t('p.projectOptional')}</label>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input-field">
                  <option value="">{t('p.generalAnyProject')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.display_name || p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold text-slate-500 mb-1.5">{t('x.messageOptional')}</label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Your skills, availability, etc." className="input-field resize-none" />
              </div>
              <button onClick={submit} disabled={saving} className="w-full bg-dp2-primary-dark text-white py-3 rounded-xl font-sans font-semibold cursor-pointer hover:bg-dp2-primary transition-all disabled:opacity-50">
                {saving ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {!user && (
        <p className="text-center font-sans text-[14px] text-slate-500 mt-8">
          <Link href="/portal/login?next=/volunteer" className="text-dp2-primary-dark font-semibold hover:underline">{t('p.logIn')}</Link> to volunteer.
        </p>
      )}
    </div>
  )
}
