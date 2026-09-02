'use client'

// Shown once, right after signup — the mentorship/career profile fields
// used to be bundled into the signup form itself, which made an already
// long form (name, mobile, WhatsApp, username, email, password...) worse.
// Splitting this out means: (1) signup itself is fast, (2) this step gets
// to actually explain *why* filling it in is worth the extra minute,
// which a form field buried among a dozen others never could, and (3) a
// villager who's only here to donate or pay a water bill can skip it
// entirely instead of wading through fields meant for students.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { GraduationCap, HeartHandshake, UserCircle2 } from 'lucide-react'
import { MentorshipProfileFields, type MentorshipFieldsValue } from '@/components/portal/MentorshipProfileFields'
import { DonorLinkVerification } from '@/components/portal/DonorLinkVerification'
import { LoadingDots } from '@/components/shared/LoadingDots'

export default function PortalWelcomePage() {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const { user, loading: userLoading, refresh } = usePortalUser()
  const supabase = createClient()

  const [displayName, setDisplayName] = useState('')
  const [mentorship, setMentorship] = useState<MentorshipFieldsValue>({
    gender: '', profession: '', profession_other: '', education_level: '', education_details: '',
    is_currently_studying: true, seeking_mentorship: false, is_minor: false,
    guardian_name: '', guardian_mobile: '', phone_private: false,
  })
  const [saving, setSaving] = useState(false)

  const finish = () => { router.push('/portal'); router.refresh() }

  const save = async () => {
    if (!user) return
    if (mentorship.seeking_mentorship && mentorship.is_minor && (!mentorship.guardian_name.trim() || !mentorship.guardian_mobile.trim())) {
      toast.error(t('m.guardianRequiredError'))
      return
    }
    setSaving(true)
    const { error } = await supabase.from('portal_users').update({
      display_name: displayName.trim() || null,
      gender: mentorship.gender || null, profession: mentorship.profession || null,
      profession_other: mentorship.profession === 'other' ? (mentorship.profession_other.trim() || null) : null,
      education_level: mentorship.education_level || null, education_details: mentorship.education_details.trim() || null,
      is_currently_studying: mentorship.is_currently_studying, seeking_mentorship: mentorship.seeking_mentorship,
      is_minor: mentorship.seeking_mentorship && mentorship.is_minor,
      guardian_name: mentorship.seeking_mentorship && mentorship.is_minor ? (mentorship.guardian_name.trim() || null) : null,
      guardian_mobile: mentorship.seeking_mentorship && mentorship.is_minor ? (mentorship.guardian_mobile.trim() || null) : null,
      phone_private: mentorship.phone_private,
    }).eq('id', user.id)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.profileUpdated'))
    finish()
  }

  if (userLoading || !user) return <div className="min-h-screen bg-[#E1F5EE] flex items-center justify-center font-sans text-dp-on-surface-variant"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-h-screen bg-[#E1F5EE] flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-dp-primary flex items-center justify-center text-white mb-4">
          <HeartHandshake size={26} />
        </div>
        <h1 className="font-heading text-[24px] font-bold text-dp-primary">{t('p.welcomeTitle').replace('{name}', user.full_name)}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1 max-w-sm">{t('p.welcomeSubtitle')}</p>
      </div>

      <DonorLinkVerification user={user} onLinked={refresh} />

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 md:p-8 w-full max-w-md">
        <h2 className="font-sans text-[13px] font-bold text-dp-primary uppercase tracking-wide mb-3 flex items-center gap-1.5"><UserCircle2 size={15} /> {t('p.displayName')}</h2>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={user.username ?? user.full_name} className="input-field" />
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('p.displayNameHint')}</p>

        <h2 className="font-sans text-[13px] font-bold text-dp-primary uppercase tracking-wide mb-4 mt-6 flex items-center gap-1.5"><GraduationCap size={15} /> {t('p.welcomeSectionTitle')}</h2>
        <MentorshipProfileFields value={mentorship} onChange={(patch) => setMentorship({ ...mentorship, ...patch })} />

        <div className="flex flex-col gap-2 mt-5">
          <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[15px] cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {saving ? t('action.saving') : t('p.saveAndContinue')}
          </button>
          <button onClick={finish} className="w-full text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-surface-container-low transition-all">
            {t('p.skipForNow')}
          </button>
        </div>
      </div>
    </div>
  )
}
