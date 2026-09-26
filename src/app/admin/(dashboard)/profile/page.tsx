'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { UserCog, KeyRound, Mail, Eye, EyeOff } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

// Real ask, 2026-09-25: there was no way for an admin to change their own
// login email at all -- admin_users.email was set once at invite/create
// time and never touched again. Password change existed nowhere either
// (only the logged-out "forgot password" flow at /admin/forgot-password).
// Both use Supabase Auth directly: updateUser({ email }) triggers
// Supabase's own "confirm your new email" flow (now deliverable, SMTP is
// configured) -- admin_users.email only catches up once that's actually
// confirmed, via the auth.users trigger in migration 512, not immediately
// here, so the mirror column never claims a change that hasn't happened
// yet. Password change re-verifies the current password first (same
// reasoning as the portal profile page's own copy of this) -- Supabase's
// updateUser() alone doesn't require it.
export default function AdminProfilePage() {
  const { t, isUrdu } = useLocale()
  const [loading, setLoading] = useState(true)
  const [currentEmail, setCurrentEmail] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [sendingEmailChange, setSendingEmailChange] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)

  useEffect(() => {
    createClient().auth.getUser().then(({ data: { user } }) => {
      setCurrentEmail(user?.email ?? '')
      setLoading(false)
    })
  }, [])

  const changeEmail = async () => {
    const trimmed = newEmail.trim()
    if (!trimmed) { toast.error(t('ap.enterNewEmail')); return }
    if (trimmed.toLowerCase() === currentEmail.toLowerCase()) { toast.error(t('ap.sameAsCurrentEmail')); return }
    setSendingEmailChange(true)
    const { error } = await createClient().auth.updateUser({ email: trimmed })
    setSendingEmailChange(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('ap.emailChangeSent'))
    setNewEmail('')
  }

  const changePassword = async () => {
    if (!currentPassword || !newPassword) { toast.error(t('p.enterCurrentNewPassword')); return }
    if (newPassword.length < 8) { toast.error(t('p.passwordMinLength')); return }
    if (newPassword !== confirmNewPassword) { toast.error(t('p.passwordsDontMatch')); return }
    setChangingPassword(true)
    const supabase = createClient()
    const { error: verifyErr } = await supabase.auth.signInWithPassword({ email: currentEmail, password: currentPassword })
    if (verifyErr) { toast.error(t('p.currentPasswordIncorrect')); setChangingPassword(false); return }
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setChangingPassword(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.passwordChanged'))
    setCurrentPassword('')
    setNewPassword('')
    setConfirmNewPassword('')
    fetch('/api/admin/notify-password-changed', { method: 'POST' }).catch(() => {})
  }

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><UserCog size={22} className="text-dp-secondary" /> {t('ap.myAccount')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('ap.myAccountSubtitle')}</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md space-y-4">
        <h2 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2"><Mail size={18} className="text-dp-secondary" /> {t('ap.changeEmail')}</h2>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ap.currentEmail')}</label>
          <input value={currentEmail} disabled className="input-field opacity-60" dir="ltr" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ap.newEmail')}</label>
          <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="input-field" dir="ltr" />
        </div>
        <button onClick={changeEmail} disabled={sendingEmailChange} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          {sendingEmailChange ? t('ap.sending') : t('ap.sendConfirmation')}
        </button>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md mt-6 space-y-4">
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
