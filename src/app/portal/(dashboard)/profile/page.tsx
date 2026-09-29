'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { UserCog, KeyRound, Droplets, CheckCircle2, Copy, Eye, EyeOff } from 'lucide-react'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SITE } from '@/lib/constants'
import { MentorshipProfileFields, type MentorshipFieldsValue } from '@/components/portal/MentorshipProfileFields'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'
import { PasswordChecklist } from '@/components/shared/PasswordChecklist'
import { SectorSelect } from '@/components/portal/SectorSelect'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'

function syntheticEmail(mobile: string) {
  return `${mobile.replace(/[^0-9]/g, '')}@portal.dhabpari.local`
}

export default function PortalProfilePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [sectors, setSectors] = useState<string[]>([])
  const [form, setForm] = useState({
    full_name: '', name_ur: '', father_husband_name: '', whatsapp_number: '',
    donor_type: 'villager', country: '', sector: '', avatar_url: '', username: '', email: '', display_name: '',
  })
  const [mentorship, setMentorship] = useState<MentorshipFieldsValue>({
    gender: '', profession: '', profession_other: '', education_level: '', education_details: '',
    is_currently_studying: true, seeking_mentorship: false, is_minor: false,
    guardian_name: '', guardian_mobile: '', phone_private: false,
  })
  const [saving, setSaving] = useState(false)

  // Real ask, 2026-09-29: mobile is locked (it's the login identity), but
  // whatsapp_number -- where donation notifications and committee messages
  // actually go -- was plain free text saved with the rest of the profile
  // form, no confirmation at all. Gated behind an emailed code (migration
  // 521), same shape as portal password reset: request a code for a new
  // number, type it back to actually commit it. currentWhatsapp tracks
  // what's live (separate from form.whatsapp_number, which no longer
  // round-trips through the general Save button at all) so a successful
  // confirm can update the displayed number without a full page reload.
  const [currentWhatsapp, setCurrentWhatsapp] = useState('')
  const [showWhatsappChange, setShowWhatsappChange] = useState(false)
  const [whatsappStep, setWhatsappStep] = useState<'new' | 'code'>('new')
  const [newWhatsappNumber, setNewWhatsappNumber] = useState('')
  const [whatsappCode, setWhatsappCode] = useState('')
  const [whatsappBusy, setWhatsappBusy] = useState(false)

  // Same shape as the WhatsApp change above (migration 523) — email is now
  // compulsory and is the account's trusted identity anchor, so it's gated
  // the same way rather than round-tripping through the general Save
  // button. The code goes to the NEW address (proving control of it),
  // not the current one.
  const [currentEmail, setCurrentEmail] = useState('')
  const [showEmailChange, setShowEmailChange] = useState(false)
  const [emailStep, setEmailStep] = useState<'new' | 'code'>('new')
  const [newEmail, setNewEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  // Real ask, 2026-09-25: no way to see what you're typing into either
  // password field -- both were plain type="password" with no toggle at
  // all. What's actually stored server-side (a Supabase Auth hash) can
  // never be shown back, by design, no matter what -- this fixes the real,
  // buildable half of the ask: seeing your own keystrokes before you
  // submit, so a typo in "current password" doesn't read as "wrong
  // password" with no way to check what was actually typed.
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)

  useEffect(() => {
    createClient().from('sectors').select('name').order('display_order').order('name').then(({ data }) => setSectors((data ?? []).map((s) => s.name)))
  }, [])

  useEffect(() => {
    if (!user) return
    setForm({
      full_name: user.full_name, name_ur: user.name_ur ?? '', father_husband_name: user.father_husband_name ?? '',
      whatsapp_number: user.whatsapp_number ?? '', donor_type: user.donor_type ?? 'villager',
      country: user.country ?? '', sector: user.sector ?? '', avatar_url: user.avatar_url ?? '',
      username: user.username ?? '', email: user.email ?? '', display_name: user.display_name ?? '',
    })
    setCurrentWhatsapp(user.whatsapp_number ?? '')
    setCurrentEmail(user.email ?? '')
    setMentorship({
      gender: user.gender ?? '', profession: user.profession ?? '', profession_other: user.profession_other ?? '',
      education_level: user.education_level ?? '', education_details: user.education_details ?? '',
      is_currently_studying: user.is_currently_studying ?? true, seeking_mentorship: user.seeking_mentorship,
      is_minor: user.is_minor, guardian_name: user.guardian_name ?? '', guardian_mobile: user.guardian_mobile ?? '',
      phone_private: user.phone_private,
    })
  }, [user])

  const save = async () => {
    if (!user) return
    if (!form.full_name.trim() || !form.father_husband_name.trim() || !currentWhatsapp.trim() || !currentEmail.trim()) {
      toast.error(t('p.profileRequiredFields'))
      return
    }
    if (form.donor_type === 'overseas' && !form.country.trim()) { toast.error(t('p.enterCountry')); return }
    if (mentorship.seeking_mentorship && mentorship.is_minor && (!mentorship.guardian_name.trim() || !mentorship.guardian_mobile.trim())) {
      toast.error(t('m.guardianRequiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('portal_users').update({
      full_name: form.full_name.trim(), name_ur: form.name_ur.trim() || null,
      father_husband_name: form.father_husband_name.trim(),
      // whatsapp_number and email deliberately excluded -- both only ever
      // change through their own emailed-code flows below, never through
      // this general save.
      donor_type: form.donor_type, country: form.donor_type === 'overseas' ? (form.country.trim() || null) : null,
      sector: form.sector.trim() || null, avatar_url: form.avatar_url || null,
      display_name: form.display_name.trim() || null,
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
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(t('p.profileUpdated'))
  }

  const requestWhatsappCode = async () => {
    if (!newWhatsappNumber.trim()) { toast.error(t('p.enterNewWhatsapp')); return }
    setWhatsappBusy(true)
    try {
      const res = await fetch('/api/portal/profile/request-whatsapp-change-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newWhatsappNumber: newWhatsappNumber.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('p.networkErrorRetry')); setWhatsappBusy(false); return }
      toast.success(t('p.whatsappCodeSent'))
      setWhatsappStep('code')
    } catch {
      toast.error(t('p.networkErrorRetry'))
    }
    setWhatsappBusy(false)
  }

  const confirmWhatsappChange = async () => {
    if (!whatsappCode.trim()) { toast.error(t('p.enterResetCode')); return }
    setWhatsappBusy(true)
    try {
      const res = await fetch('/api/portal/profile/confirm-whatsapp-change', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: whatsappCode.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('p.networkErrorRetry')); setWhatsappBusy(false); return }
      toast.success(t('p.whatsappChanged'))
      setCurrentWhatsapp(data.whatsappNumber)
      setForm((f) => ({ ...f, whatsapp_number: data.whatsappNumber }))
      setShowWhatsappChange(false)
      setWhatsappStep('new')
      setNewWhatsappNumber('')
      setWhatsappCode('')
    } catch {
      toast.error(t('p.networkErrorRetry'))
    }
    setWhatsappBusy(false)
  }

  const requestEmailCode = async () => {
    if (!newEmail.trim()) { toast.error(t('p.enterNewEmail')); return }
    setEmailBusy(true)
    try {
      const res = await fetch('/api/portal/profile/request-email-change-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newEmail: newEmail.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('p.networkErrorRetry')); setEmailBusy(false); return }
      toast.success(t('p.emailCodeSent'))
      setEmailStep('code')
    } catch {
      toast.error(t('p.networkErrorRetry'))
    }
    setEmailBusy(false)
  }

  const confirmEmailChange = async () => {
    if (!emailCode.trim()) { toast.error(t('p.enterResetCode')); return }
    setEmailBusy(true)
    try {
      const res = await fetch('/api/portal/profile/confirm-email-change', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: emailCode.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('p.networkErrorRetry')); setEmailBusy(false); return }
      toast.success(t('p.emailChanged'))
      setCurrentEmail(data.email)
      setForm((f) => ({ ...f, email: data.email }))
      setShowEmailChange(false)
      setEmailStep('new')
      setNewEmail('')
      setEmailCode('')
    } catch {
      toast.error(t('p.networkErrorRetry'))
    }
    setEmailBusy(false)
  }

  const changePassword = async () => {
    if (!user || !currentPassword || !newPassword) { toast.error(t('p.enterCurrentNewPassword')); return }
    if (!passwordMeetsPolicy(newPassword)) { toast.error(t('p.passwordPolicyNotMet')); return }
    if (newPassword !== confirmNewPassword) { toast.error(t('p.passwordsDontMatch')); return }
    setChangingPassword(true)
    const supabase = createClient()
    // Re-verify the current password before allowing a change — protects
    // against someone changing the password on a device the real user left
    // logged in, since Supabase's updateUser() alone doesn't require it.
    const { error: verifyErr } = await supabase.auth.signInWithPassword({ email: syntheticEmail(user.mobile), password: currentPassword })
    if (verifyErr) { toast.error(t('p.currentPasswordIncorrect')); setChangingPassword(false); return }
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setChangingPassword(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.passwordChanged'))
    setCurrentPassword('')
    setNewPassword('')
    setConfirmNewPassword('')
    // Real ask, 2026-09-27: "no email was sent, like a professional site
    // would do" — best-effort security notice, never blocks or reports
    // failure back to the user (the password change already succeeded).
    fetch('/api/portal/notify-password-changed', { method: 'POST' }).catch(() => {})
  }

  if (userLoading || !user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><UserCog size={22} className="text-dp-secondary" /> {t('p.myProfile')} <PortalHelp pageKey="profile" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">
          {t('p.mobileCannotChange').split('{mobile}').map((part, i, arr) => (
            <span key={i}>{part}{i < arr.length - 1 && <span className="ltr-num">{user.mobile}</span>}</span>
          ))}
        </p>
      </div>

      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md space-y-4">
        <ImageUpload bucket="images" label={t('p.profilePhoto')} currentUrl={form.avatar_url} onUpload={(url) => setForm({ ...form, avatar_url: url })} />

        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.usernameReq').replace(' *', '')}</label>
          <input value={form.username} disabled className="input-field opacity-60" dir="ltr" />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 leading-relaxed">{t('p.usernameCannotChange')}</p>
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.emailReq')}</label>
          {/* Real ask, 2026-09-29: "same as changing WhatsApp" -- email is
              now compulsory and is the account's own trusted identity
              anchor, so changing it is gated the same emailed-code way
              (migration 523), not folded into the general Save button. */}
          <div className="flex items-center gap-2">
            <input value={currentEmail} disabled className="input-field opacity-60" dir="ltr" />
            <button type="button" onClick={() => { setShowEmailChange((v) => !v); setEmailStep('new'); setNewEmail(''); setEmailCode('') }}
              className="shrink-0 px-3 py-3 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-secondary hover:bg-dp-surface-container-low transition-all cursor-pointer whitespace-nowrap">
              {t('p.change')}
            </button>
          </div>
          {showEmailChange && (
            <div className="mt-2.5 bg-dp-surface-container-low rounded-lg p-3.5 space-y-2.5">
              {emailStep === 'new' ? (
                <>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant">{t('p.newEmail')}</label>
                  <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="input-field" dir="ltr" autoFocus />
                  <button disabled={emailBusy} onClick={requestEmailCode}
                    className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    {emailBusy ? t('ap.sending') : t('p.sendConfirmationCode')}
                  </button>
                </>
              ) : (
                <>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant">{t('p.enterCodeSentToNewEmail')}</label>
                  <input value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" maxLength={6}
                    className="input-field font-mono tracking-[0.3em] text-center" placeholder="000000" dir="ltr" autoFocus />
                  <button disabled={emailBusy} onClick={confirmEmailChange}
                    className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    {emailBusy ? t('ap.sending') : t('p.confirmNewEmail')}
                  </button>
                  <button type="button" onClick={() => setEmailStep('new')} className="w-full text-center font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">
                    {t('p.resendCode')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.fullNameReq')}</label>
          <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 leading-relaxed">{t('p.fullNamePrivateHint')}</p>
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.nameUrdu')}</label>
          <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.displayName')}</label>
          <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder={form.username || form.full_name} className="input-field" />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 leading-relaxed">{t('p.displayNameHint')}</p>
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.fatherReq')}</label>
          <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.whatsappReq')}</label>
          {/* Real ask, 2026-09-29: this was a plain free-text input saved
              with the rest of the form, no confirmation at all — the one
              number donation notifications and committee messages actually
              go to. Now read-only + a "Change" button that opens the
              emailed-code flow below (request-whatsapp-change-code /
              confirm-whatsapp-change), same shape as password reset. */}
          <div className="flex items-center gap-2">
            <input value={currentWhatsapp || t('p.noneOnFile')} disabled className="input-field opacity-60" dir="ltr" />
            <button type="button" onClick={() => { setShowWhatsappChange((v) => !v); setWhatsappStep('new'); setNewWhatsappNumber(''); setWhatsappCode('') }}
              className="shrink-0 px-3 py-3 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-secondary hover:bg-dp-surface-container-low transition-all cursor-pointer whitespace-nowrap">
              {t('p.change')}
            </button>
          </div>
          {showWhatsappChange && (
            <div className="mt-2.5 bg-dp-surface-container-low rounded-lg p-3.5 space-y-2.5">
              {whatsappStep === 'new' ? (
                <>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant">{t('p.newWhatsappNumber')}</label>
                  <input type="tel" value={newWhatsappNumber} onChange={(e) => setNewWhatsappNumber(e.target.value)} className="input-field" dir="ltr" autoFocus />
                  <button disabled={whatsappBusy} onClick={requestWhatsappCode}
                    className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    {whatsappBusy ? t('ap.sending') : t('p.sendConfirmationCode')}
                  </button>
                </>
              ) : (
                <>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant">{t('p.enterCodeSentToEmail')}</label>
                  <input value={whatsappCode} onChange={(e) => setWhatsappCode(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" maxLength={6}
                    className="input-field font-mono tracking-[0.3em] text-center" placeholder="000000" dir="ltr" autoFocus />
                  <button disabled={whatsappBusy} onClick={confirmWhatsappChange}
                    className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    {whatsappBusy ? t('ap.sending') : t('p.confirmNewNumber')}
                  </button>
                  <button type="button" onClick={() => setWhatsappStep('new')} className="w-full text-center font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">
                    {t('p.resendCode')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.youAre')}</label>
            <select value={form.donor_type} onChange={(e) => setForm({ ...form, donor_type: e.target.value, country: '' })} className="input-field">
              <option value="villager">{t('w.villageResident')}</option>
              <option value="overseas">{t('w.overseas')}</option>
            </select>
          </div>
          {form.donor_type === 'overseas' ? (
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.country')}</label>
              <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className="input-field" />
            </div>
          ) : (
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.sector')}</label>
              <SectorSelect sectors={sectors} value={form.sector} onChange={(v) => setForm({ ...form, sector: v })} />
            </div>
          )}
        </div>
        <div className="border-t border-dp-outline-variant pt-4">
          <MentorshipProfileFields value={mentorship} onChange={(patch) => setMentorship({ ...mentorship, ...patch })} />
        </div>

        <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          {saving ? t('p.saving') : t('p.saveChanges')}
        </button>
      </div>

      {/* ── Water connection ─────────────────────────────────────────────
          Signup already tries to auto-match a new account to an existing
          consumer record by mobile/WhatsApp number — this is the fallback
          for when that fails (the connection is registered under a
          different, older, or a family member's number, which is common).
          The number here is read-only, pulled straight from this account —
          never a box to retype it into — so nobody can accidentally attach
          themselves to somebody else's real water usage history. */}
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md mt-6">
        <h2 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2 mb-1">
          <Droplets size={18} className="text-dp-secondary" /> {t('p.waterConnection')}
        </h2>
        {user.consumer_id ? (
          <div className="flex items-start gap-2.5 mt-3 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
            <CheckCircle2 size={17} className="text-emerald-600 shrink-0 mt-0.5" />
            <p className="font-sans text-[13.5px] text-emerald-900">
              {t('p.waterLinked')} <span className="font-mono font-bold">{user.consumer_id}</span>
            </p>
          </div>
        ) : (
          <div className="mt-3">
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant leading-relaxed mb-3">{t('p.waterNotLinked')}</p>
            <div className="bg-dp-surface-container-low rounded-lg px-4 py-3 mb-3">
              <p className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-1">{t('p.yourRegisteredNumber')}</p>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[16px] font-bold text-dp-on-surface">{user.mobile}</span>
                <button
                  onClick={async () => { await navigator.clipboard.writeText(user.mobile); toast.success(t('p.copied')) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold text-dp-on-surface hover:border-dp-secondary transition-all cursor-pointer"
                >
                  <Copy size={13} /> {t('p.copy')}
                </button>
              </div>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">
              {t('p.waterLinkInstructions')} <a href={SITE.whatsappLink} target="_blank" rel="noreferrer" className="font-semibold text-dp-secondary hover:underline">{SITE.whatsapp}</a>
              {' · '}{SITE.location} ({SITE.officeHours})
            </p>
          </div>
        )}
      </div>

      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md mt-6 space-y-4">
        <h2 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2"><KeyRound size={18} className="text-dp-secondary" /> {t('p.changePassword')}</h2>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.currentPassword')}</label>
          <div className="relative">
            <input type={showCurrentPassword ? 'text' : 'password'} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" className="input-field pe-10" />
            <button type="button" onClick={() => setShowCurrentPassword((v) => !v)} className="absolute inset-y-0 end-0 flex items-center px-3 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer" aria-label={showCurrentPassword ? t('p.hidePassword') : t('p.showPassword')}>
              {showCurrentPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.newPassword')}</label>
          <div className="relative">
            <input type={showNewPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" className="input-field pe-10" />
            <button type="button" onClick={() => setShowNewPassword((v) => !v)} className="absolute inset-y-0 end-0 flex items-center px-3 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer" aria-label={showNewPassword ? t('p.hidePassword') : t('p.showPassword')}>
              {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <PasswordChecklist password={newPassword} />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.confirmNewPassword')}</label>
          <input type={showNewPassword ? 'text' : 'password'} value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} autoComplete="new-password" className="input-field" />
        </div>
        <button onClick={changePassword} disabled={changingPassword} className="w-full border border-dp-outline-variant text-dp-on-surface rounded-lg py-3 font-sans font-semibold cursor-pointer hover:bg-dp-surface-container transition-all disabled:opacity-50">
          {changingPassword ? t('p.changing') : t('p.changePassword')}
        </button>
      </div>
    </div>
  )
}
