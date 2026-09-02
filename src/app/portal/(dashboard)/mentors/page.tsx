'use client'

// Phase C/D hub: become a mentor, browse the mentor directory, and see your
// open conversations. One page rather than three — a portal user is almost
// always going to want to see "my status" and "who can I talk to" together.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Users, MessageCircle, GraduationCap, Briefcase, Clock, CheckCircle2, XCircle, ChevronRight, School, CalendarClock, Sparkles } from 'lucide-react'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface MentorRow {
  id: string; full_name: string; avatar_url: string | null; mentor_type: string
  mentor_bio: string | null; mentor_expertise: string | null; mentor_available: boolean
}
interface ConversationRow {
  id: string; student_portal_user_id: string; mentor_portal_user_id: string
  last_message_at: string; status: string
  student_name: string; mentor_name: string
}

export default function MentorsHubPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading, refresh: refreshUser } = usePortalUser()
  const supabase = createClient()

  const [mentors, setMentors] = useState<MentorRow[]>([])
  const [conversations, setConversations] = useState<ConversationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState<string | null>(null)

  const [mentorType, setMentorType] = useState<'freelancer' | 'professional'>('freelancer')
  const [bio, setBio] = useState('')
  const [expertise, setExpertise] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [available, setAvailable] = useState(true)

  const load = async () => {
    const [{ data: mentorData }, { data: convData }] = await Promise.all([
      supabase.from('mentor_directory').select('*').order('full_name'),
      supabase.from('mentor_conversations_with_names').select('*').order('last_message_at', { ascending: false }),
    ])
    setMentors((mentorData ?? []) as MentorRow[])
    setConversations((convData ?? []) as ConversationRow[])
    setLoading(false)
  }

  useEffect(() => { if (!userLoading) load() }, [userLoading]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (user) setAvailable(user.mentor_available ?? true) }, [user])

  const startChat = async (mentorId: string) => {
    setStarting(mentorId)
    const { data, error } = await supabase.rpc('start_mentor_conversation', { p_mentor_portal_user_id: mentorId })
    setStarting(null)
    if (error) { toast.error(friendlyError(error)); return }
    window.location.href = `/portal/mentors/chat/${data}`
  }

  const requestMentor = async () => {
    if (!bio.trim() || !expertise.trim()) { toast.error(t('mn.fillBioExpertise')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('request_mentor_status', { p_mentor_type: mentorType, p_bio: bio.trim(), p_expertise: expertise.trim() })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mn.requestSubmitted'))
    refreshUser()
    load()
  }

  const toggleAvailable = async (next: boolean) => {
    setAvailable(next)
    const { error } = await supabase.from('portal_users').update({ mentor_available: next }).eq('id', user!.id)
    if (error) { toast.error(friendlyError(error)); setAvailable(!next); return }
  }

  if (userLoading || !user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Users size={22} className="text-dp-secondary" /> {t('mn.title')} <PortalHelp pageKey="mentors" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('mn.subtitle')}</p>
      </div>

      {/* ── The rest of the registration-note promise ────────────────────
          Course videos, institutes, training programs — the mentor
          directory above is only one piece of what was promised at
          signup. */}
      <div className="grid sm:grid-cols-3 gap-3 mb-6">
        <Link href="/portal/institutes" className="bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all flex items-center gap-3">
          <School size={20} className="text-dp-secondary shrink-0" />
          <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('portal.institutes')}</span>
        </Link>
        <Link href="/portal/training-programs" className="bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all flex items-center gap-3">
          <CalendarClock size={20} className="text-dp-secondary shrink-0" />
          <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('portal.trainingPrograms')}</span>
        </Link>
        <Link href="/portal/talent-showcase" className="bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all flex items-center gap-3">
          <Sparkles size={20} className="text-dp-secondary shrink-0" />
          <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('portal.talentShowcase')}</span>
        </Link>
      </div>

      {/* ── Mentor status card ─────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-6">
        <h2 className="font-heading text-[16px] font-bold text-dp-primary mb-3 flex items-center gap-2"><GraduationCap size={17} className="text-dp-secondary" /> {t('mn.becomeMentor')}</h2>

        {user.mentor_status === 'approved' ? (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 text-emerald-700 font-sans text-[13.5px] font-semibold"><CheckCircle2 size={16} /> {t('mn.youAreMentor')}</div>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="font-sans text-[13px] text-dp-on-surface-variant">{t('mn.availableForChat')}</span>
              <input type="checkbox" checked={available} onChange={(e) => toggleAvailable(e.target.checked)} className="w-4 h-4 accent-dp-secondary" />
            </label>
          </div>
        ) : user.mentor_status === 'pending' ? (
          <div className="flex items-center gap-2 text-amber-700 font-sans text-[13.5px] font-semibold"><Clock size={16} /> {t('mn.underReview')}</div>
        ) : (
          <div className="space-y-3 max-w-md">
            {user.mentor_status === 'rejected' && (
              <div className="flex items-center gap-2 text-dp-error font-sans text-[13px] font-semibold mb-2"><XCircle size={15} /> {t('mn.wasRejected')}</div>
            )}
            <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">{t('mn.becomeMentorBlurb')}</p>
            <select value={mentorType} onChange={(e) => setMentorType(e.target.value as 'freelancer' | 'professional')} className="input-field">
              <option value="freelancer">{t('mn.typeFreelancer')}</option>
              <option value="professional">{t('mn.typeProfessional')}</option>
            </select>
            <input value={expertise} onChange={(e) => setExpertise(e.target.value)} placeholder={t('mn.expertisePlaceholder')} className="input-field" />
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder={t('mn.bioPlaceholder')} rows={3} className="input-field resize-none" />
            <button onClick={requestMentor} disabled={submitting} className="bg-dp-secondary text-white px-4 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {submitting ? t('action.saving') : t('mn.submitRequest')}
            </button>
          </div>
        )}
      </div>

      {/* ── My conversations ──────────────────────────────────────────── */}
      {conversations.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-6">
          <h2 className="font-heading text-[16px] font-bold text-dp-primary mb-3 flex items-center gap-2"><MessageCircle size={17} className="text-dp-secondary" /> {t('mn.myConversations')}</h2>
          <div className="space-y-2">
            {conversations.map((c) => (
              <Link key={c.id} href={`/portal/mentors/chat/${c.id}`} className="flex items-center justify-between px-4 py-3 border border-dp-outline-variant rounded-lg hover:border-dp-secondary transition-all">
                <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{(c.student_portal_user_id === user.id ? c.mentor_name : c.student_name) ?? '—'}</span>
                <ChevronRight size={16} className="text-dp-on-surface-variant" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Directory ──────────────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
        <h2 className="font-heading text-[16px] font-bold text-dp-primary mb-3 flex items-center gap-2"><Briefcase size={17} className="text-dp-secondary" /> {t('mn.directory')}</h2>
        {loading ? (
          <p className="font-sans text-[13px] text-dp-on-surface-variant"><LoadingDots /></p>
        ) : mentors.filter((m) => m.id !== user.id).length === 0 ? (
          <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('mn.noMentorsYet')}</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {mentors.filter((m) => m.id !== user.id).map((m) => (
              <div key={m.id} className="border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{m.full_name}</p>
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${m.mentor_type === 'professional' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'}`}>
                    {m.mentor_type === 'professional' ? t('mn.typeProfessional') : t('mn.typeFreelancer')}
                  </span>
                </div>
                {m.mentor_expertise && <p className="font-sans text-[12px] text-dp-secondary font-semibold mb-1">{m.mentor_expertise}</p>}
                {m.mentor_bio && <p className="font-sans text-[12px] text-dp-on-surface-variant leading-relaxed mb-3">{m.mentor_bio}</p>}
                <button
                  onClick={() => startChat(m.id)}
                  disabled={!m.mentor_available || starting === m.id}
                  className="w-full bg-dp-secondary text-white py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  <MessageCircle size={13} /> {m.mentor_available ? t('mn.startChat') : t('mn.notAvailable')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
