'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { UserCog, KeyRound } from 'lucide-react'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'

function syntheticEmail(mobile: string) {
  return `${mobile.replace(/[^0-9]/g, '')}@portal.dhabpari.local`
}

export default function PortalProfilePage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [sectors, setSectors] = useState<string[]>([])
  const [form, setForm] = useState({
    full_name: '', name_ur: '', father_husband_name: '', whatsapp_number: '',
    donor_type: 'villager', country: '', sector: '', avatar_url: '', username: '', email: '',
  })
  const [saving, setSaving] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  useEffect(() => {
    createClient().from('sectors').select('name').order('display_order').order('name').then(({ data }) => setSectors((data ?? []).map((s) => s.name)))
  }, [])

  useEffect(() => {
    if (!user) return
    setForm({
      full_name: user.full_name, name_ur: user.name_ur ?? '', father_husband_name: user.father_husband_name ?? '',
      whatsapp_number: user.whatsapp_number ?? '', donor_type: user.donor_type ?? 'villager',
      country: user.country ?? '', sector: user.sector ?? '', avatar_url: user.avatar_url ?? '',
      username: user.username ?? '', email: user.email ?? '',
    })
  }, [user])

  const save = async () => {
    if (!user) return
    if (!form.full_name.trim() || !form.father_husband_name.trim() || !form.whatsapp_number.trim() || !form.username.trim()) {
      toast.error("Name, father's/husband's name, WhatsApp number, and username are required")
      return
    }
    if (!/^[a-zA-Z0-9_]{6,30}$/.test(form.username.trim())) {
      toast.error('Username must be 6-30 characters: letters, numbers, and underscores only')
      return
    }
    if (form.donor_type === 'overseas' && !form.country.trim()) { toast.error('Please enter your country'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('portal_users').update({
      full_name: form.full_name.trim(), name_ur: form.name_ur.trim() || null,
      father_husband_name: form.father_husband_name.trim(), whatsapp_number: form.whatsapp_number.trim(),
      donor_type: form.donor_type, country: form.donor_type === 'overseas' ? (form.country.trim() || null) : null,
      sector: form.sector.trim() || null, avatar_url: form.avatar_url || null,
      username: form.username.trim(), email: form.email.trim() || null,
    }).eq('id', user.id)
    setSaving(false)
    if (error) {
      toast.error(error.message.includes('duplicate') || error.code === '23505' ? 'That username is already taken' : error.message)
      return
    }
    toast.success('Profile updated')
  }

  const changePassword = async () => {
    if (!user || !currentPassword || !newPassword) { toast.error('Enter your current and new password'); return }
    if (newPassword.length < 8) { toast.error('New password must be at least 8 characters'); return }
    setChangingPassword(true)
    const supabase = createClient()
    // Re-verify the current password before allowing a change — protects
    // against someone changing the password on a device the real user left
    // logged in, since Supabase's updateUser() alone doesn't require it.
    const { error: verifyErr } = await supabase.auth.signInWithPassword({ email: syntheticEmail(user.mobile), password: currentPassword })
    if (verifyErr) { toast.error('Current password is incorrect'); setChangingPassword(false); return }
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setChangingPassword(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Password changed')
    setCurrentPassword('')
    setNewPassword('')
  }

  if (userLoading || !user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><UserCog size={22} className="text-dp-secondary" /> {t('p.myProfile')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Mobile number ({user.mobile}) cannot be changed — it's your login ID.</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md space-y-4">
        <ImageUpload bucket="images" label="Profile Photo" currentUrl={form.avatar_url} onUpload={(url) => setForm({ ...form, avatar_url: url })} />

        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.usernameReq')}</label>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.emailOptional')}</label>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.fullNameReq')}</label>
          <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.nameUrdu')}</label>
          <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.fatherReq')}</label>
          <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.whatsappReq')}</label>
          <input type="tel" value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} className="input-field" />
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
              <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} list="sector-options" className="input-field" />
              <datalist id="sector-options">{sectors.map((s) => <option key={s} value={s} />)}</datalist>
            </div>
          )}
        </div>
        <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md mt-6 space-y-4">
        <h2 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2"><KeyRound size={18} className="text-dp-secondary" /> {t('p.changePassword')}</h2>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.currentPassword')}</label>
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.newPassword')}</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" className="input-field" />
        </div>
        <button onClick={changePassword} disabled={changingPassword} className="w-full border border-dp-outline-variant text-dp-on-surface rounded-lg py-3 font-sans font-semibold cursor-pointer hover:bg-dp-surface-container transition-all disabled:opacity-50">
          {changingPassword ? 'Changing...' : 'Change Password'}
        </button>
      </div>
    </>
  )
}
