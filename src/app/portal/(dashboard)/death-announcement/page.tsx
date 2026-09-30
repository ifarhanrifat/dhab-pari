'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HeartCrack, PlusCircle, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Announcement {
  id: string; deceased_name: string; age: number | null; gender: string | null
  funeral_datetime: string | null; burial_location: string | null
  family_contact_name: string; family_contact_mobile: string
  moderation_status: string; created_at: string
}

const empty = {
  deceased_name: '', deceased_name_ur: '', age: '', gender: 'male',
  location_text: '', death_datetime: '', funeral_datetime: '', burial_location: '',
  family_contact_name: '', family_contact_mobile: '', message: '',
}

// Phase 3 of the "Village OS" feature set, 2026-09-30. Same approval gate
// as help_requests (migration 533) -- a committee member approves before
// it reaches the village, and approving is what broadcasts it.
export default function DeathAnnouncementPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const { data } = await supabase.from('death_announcements').select('*').eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setItems(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const openAdd = () => {
    setForm({ ...empty, family_contact_name: user?.full_name ?? '', family_contact_mobile: user?.mobile ?? '' })
    setShowForm(true)
  }

  const save = async () => {
    if (!user) return
    if (!form.deceased_name.trim() || !form.family_contact_name.trim() || !form.family_contact_mobile.trim()) {
      toast.error(t('da.fillRequired')); return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('death_announcements').insert({
      portal_user_id: user.id,
      deceased_name: form.deceased_name.trim(),
      deceased_name_ur: form.deceased_name_ur.trim() || null,
      age: form.age ? parseInt(form.age, 10) : null,
      gender: form.gender || null,
      location_text: form.location_text.trim() || null,
      death_datetime: form.death_datetime || null,
      funeral_datetime: form.funeral_datetime || null,
      burial_location: form.burial_location.trim() || null,
      family_contact_name: form.family_contact_name.trim(),
      family_contact_mobile: form.family_contact_mobile.trim(),
      message: form.message.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('da.announcementPosted'))
    setShowForm(false); load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HeartCrack size={22} className="text-dp-secondary" /> {t('da.myAnnouncements')}</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('da.pageIntro')}</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {t('da.newAnnouncement')}
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : items.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('da.noAnnouncements')}</p>
        </div>
      ) : (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="space-y-3 max-w-xl">
          {items.map((a) => (
            <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  {a.moderation_status === 'pending' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 uppercase">{t('mod.pendingReview')}</span>}
                  {a.moderation_status === 'approved' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 uppercase">{t('mod.approved')}</span>}
                  {a.moderation_status === 'rejected' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 uppercase">{t('mod.rejectedBadge')}</span>}
                  <p className="font-sans text-[15px] font-bold text-dp-on-surface mt-1.5">{a.deceased_name}{a.age ? ` (${a.age})` : ''}</p>
                  {a.funeral_datetime && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{t('da.funeralAt')}: {new Date(a.funeral_datetime).toLocaleString()}</p>}
                  {a.burial_location && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('da.burialAt')}: {a.burial_location}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('da.newAnnouncement')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.deceasedName')}</label>
                <input value={form.deceased_name} onChange={(e) => setForm({ ...form, deceased_name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.deceasedNameUr')}</label>
                <input value={form.deceased_name_ur} onChange={(e) => setForm({ ...form, deceased_name_ur: e.target.value })} className="input-field" dir="rtl" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.age')}</label>
                  <input type="number" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.gender')}</label>
                  <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input-field">
                    <option value="male">{t('da.male')}</option>
                    <option value="female">{t('da.female')}</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.locationText')}</label>
                <input value={form.location_text} onChange={(e) => setForm({ ...form, location_text: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.deathDatetime')}</label>
                <input type="datetime-local" value={form.death_datetime} onChange={(e) => setForm({ ...form, death_datetime: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.funeralDatetime')}</label>
                <input type="datetime-local" value={form.funeral_datetime} onChange={(e) => setForm({ ...form, funeral_datetime: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.burialLocation')}</label>
                <input value={form.burial_location} onChange={(e) => setForm({ ...form, burial_location: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('da.message')}</label>
                <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} rows={2} className="input-field resize-none" placeholder={t('da.messagePlaceholder')} />
              </div>
              <div className="border-t border-dp-outline-variant pt-4">
                <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-3">{t('p.publicContactInfo')}</p>
                <div className="space-y-3">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.contactName')}</label>
                    <input value={form.family_contact_name} onChange={(e) => setForm({ ...form, family_contact_name: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.mobileReq')}</label>
                    <input value={form.family_contact_mobile} onChange={(e) => setForm({ ...form, family_contact_mobile: e.target.value })} className="input-field" />
                  </div>
                </div>
              </div>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? t('p.saving') : t('da.submitAnnouncement')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
