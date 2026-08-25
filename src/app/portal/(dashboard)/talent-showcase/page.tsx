'use client'

// A student submits their own talent showcase entry — always lands
// pending (migration 333's trigger enforces this regardless of what's
// sent), and if the submitter is a minor, the trigger also refuses the
// insert unless a guardian contact is already on their profile.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Sparkles, Clock, CheckCircle2, XCircle, ShieldAlert } from 'lucide-react'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { VideoUpload } from '@/components/admin/VideoUpload'

interface Entry {
  id: string; display_name: string; talent_description: string; moderation_status: string; created_at: string
}

const empty = { display_name: '', talent_description: '', needs: '', needs_amount_pkr: '', aspiration: '', photo_url: '', video_url: '' }

export default function PortalTalentShowcasePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const [mine, setMine] = useState<Entry[]>([])
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const { data } = await supabase.from('talent_showcases').select('id, display_name, talent_description, moderation_status, created_at').eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setMine((data ?? []) as Entry[])
  }
  useEffect(() => { load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!user || !form.display_name.trim() || !form.talent_description.trim()) { toast.error(t('ts.nameDescRequired')); return }
    setSaving(true)
    const { error } = await supabase.from('talent_showcases').insert({
      portal_user_id: user.id, display_name: form.display_name.trim(), talent_description: form.talent_description.trim(),
      needs: form.needs.trim() || null, needs_amount_pkr: form.needs_amount_pkr ? parseFloat(form.needs_amount_pkr) : null, aspiration: form.aspiration.trim() || null,
      photo_url: form.photo_url || null, video_url: form.video_url || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('ts.submitted'))
    setForm(empty)
    load()
  }

  if (userLoading || !user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  const needsGuardianInfo = user.is_minor && (!user.guardian_name || !user.guardian_mobile)

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-xl">
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Sparkles size={22} className="text-dp-secondary" /> {t('ts.title')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('ts.portalBlurb')}</p>
      </div>

      {mine.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-6">
          <h2 className="font-sans text-[13.5px] font-bold text-dp-primary mb-2.5">{t('ts.mySubmissions')}</h2>
          <div className="space-y-2">
            {mine.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 text-[13px] font-sans">
                <span className="text-dp-on-surface truncate">{s.display_name}</span>
                {s.moderation_status === 'approved' ? (
                  <span className="inline-flex items-center gap-1 text-dp-secondary font-semibold shrink-0"><CheckCircle2 size={13} /> {t('sb.statusApproved')}</span>
                ) : s.moderation_status === 'rejected' ? (
                  <span className="inline-flex items-center gap-1 text-dp-error font-semibold shrink-0"><XCircle size={13} /> {t('sb.statusRejected')}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-700 font-semibold shrink-0"><Clock size={13} /> {t('sb.statusPending')}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {needsGuardianInfo ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-2.5">
          <ShieldAlert size={17} className="text-amber-700 shrink-0 mt-0.5" />
          <p className="font-sans text-[13.5px] text-amber-900 leading-relaxed">
            {t('ts.needGuardianInfo')} <Link href="/portal/profile" className="font-semibold underline">{t('ts.goToProfile')}</Link>
          </p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 space-y-3">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.displayName')}</label>
            <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} className="input-field" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.talentDescription')}</label>
            <textarea value={form.talent_description} onChange={(e) => setForm({ ...form, talent_description: e.target.value })} rows={2} className="input-field resize-none" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.needs')}</label>
            <textarea value={form.needs} onChange={(e) => setForm({ ...form, needs: e.target.value })} placeholder={t('ts.needsPlaceholder')} rows={2} className="input-field resize-none" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.needsAmount')}</label>
            <input type="number" min="0" value={form.needs_amount_pkr} onChange={(e) => setForm({ ...form, needs_amount_pkr: e.target.value })} placeholder={t('ts.needsAmountPlaceholder')} className="input-field" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.aspiration')}</label>
            <input value={form.aspiration} onChange={(e) => setForm({ ...form, aspiration: e.target.value })} placeholder={t('ts.aspirationPlaceholder')} className="input-field" />
          </div>
          <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('ts.photo')} />
          <VideoUpload currentUrl={form.video_url} onUpload={(url) => setForm({ ...form, video_url: url })} />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-relaxed">{t('ts.reviewNotice')}</p>
          <button onClick={submit} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {saving ? t('action.saving') : t('ts.submitForReview')}
          </button>
        </div>
      )}
    </div>
  )
}
