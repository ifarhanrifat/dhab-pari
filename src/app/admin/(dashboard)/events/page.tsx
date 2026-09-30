'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, CalendarDays } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'

interface Ev {
  id: string; title: string; title_ur: string | null; description: string | null; description_ur: string | null
  category: string; start_datetime: string; end_datetime: string | null; location_text: string | null
  organizer_name: string | null; organizer_contact: string | null; photo_url: string | null; is_active: boolean
  groom_name: string | null; bride_name: string | null; wedding_function: string | null
  venue_men: string | null; venue_women: string | null
  deceased_name: string | null; gathering_type: string | null
  speaker_name: string | null
  tournament_name: string | null; entry_fee: number | null; registration_contact: string | null
  agenda: string | null
}

const CATEGORIES = ['religious', 'wedding', 'sports', 'meeting', 'education', 'condolence', 'other']

const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const empty = {
  title: '', title_ur: '', description: '', description_ur: '', category: 'other',
  start_datetime: '', end_datetime: '', location_text: '', organizer_name: '', organizer_contact: '',
  photo_url: '', is_active: true,
  groom_name: '', bride_name: '', wedding_function: 'mehndi', venue_men: '', venue_women: '',
  deceased_name: '', gathering_type: 'soyem',
  speaker_name: '',
  tournament_name: '', entry_fee: '', registration_contact: '',
  agenda: '',
}

// Phase 3 of the "Village OS" feature set, 2026-09-30. Admin-curated, same
// trust model as /admin/directory -- committee announces events directly,
// no approval queue.
export default function AdminEventsPage() {
  const { t, isUrdu } = useLocale()
  const [events, setEvents] = useState<Ev[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('village_events').select('*').order('start_datetime', { ascending: false })
    setEvents((data ?? []) as Ev[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.title.trim() || !form.start_datetime) { toast.error(t('ve.titleRequired')); return }
    const cat = form.category
    const payload = {
      title: form.title.trim(),
      title_ur: form.title_ur.trim() || null,
      description: form.description.trim() || null,
      description_ur: form.description_ur.trim() || null,
      category: form.category,
      location_text: form.location_text.trim() || null,
      organizer_name: form.organizer_name.trim() || null,
      organizer_contact: form.organizer_contact.trim() || null,
      photo_url: form.photo_url || null,
      is_active: form.is_active,
      start_datetime: new Date(form.start_datetime).toISOString(),
      end_datetime: form.end_datetime ? new Date(form.end_datetime).toISOString() : null,
      // Only the selected category's fields are kept -- switching category
      // away from "wedding" after typing a groom_name shouldn't leave a
      // stale value behind on a religious/sports event.
      groom_name: cat === 'wedding' ? (form.groom_name.trim() || null) : null,
      bride_name: cat === 'wedding' ? (form.bride_name.trim() || null) : null,
      wedding_function: cat === 'wedding' ? form.wedding_function : null,
      venue_men: (cat === 'wedding' || cat === 'condolence') ? (form.venue_men.trim() || null) : null,
      venue_women: (cat === 'wedding' || cat === 'condolence') ? (form.venue_women.trim() || null) : null,
      deceased_name: cat === 'condolence' ? (form.deceased_name.trim() || null) : null,
      gathering_type: cat === 'condolence' ? form.gathering_type : null,
      speaker_name: cat === 'religious' ? (form.speaker_name.trim() || null) : null,
      tournament_name: cat === 'sports' ? (form.tournament_name.trim() || null) : null,
      entry_fee: cat === 'sports' && form.entry_fee ? parseFloat(form.entry_fee) : null,
      registration_contact: cat === 'sports' ? (form.registration_contact.trim() || null) : null,
      agenda: cat === 'meeting' ? (form.agenda.trim() || null) : null,
    }
    if (editing) {
      const { error } = await supabase.from('village_events').update(payload).eq('id', editing)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ve.updated'))
    } else {
      const { error } = await supabase.from('village_events').insert(payload)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ve.added'))
    }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }

  const edit = (e: Ev) => {
    setForm({
      title: e.title, title_ur: e.title_ur ?? '', description: e.description ?? '', description_ur: e.description_ur ?? '',
      category: e.category, start_datetime: toLocalInput(e.start_datetime), end_datetime: toLocalInput(e.end_datetime),
      location_text: e.location_text ?? '', organizer_name: e.organizer_name ?? '', organizer_contact: e.organizer_contact ?? '',
      photo_url: e.photo_url ?? '', is_active: e.is_active,
      groom_name: e.groom_name ?? '', bride_name: e.bride_name ?? '', wedding_function: e.wedding_function ?? 'mehndi',
      venue_men: e.venue_men ?? '', venue_women: e.venue_women ?? '',
      deceased_name: e.deceased_name ?? '', gathering_type: e.gathering_type ?? 'soyem',
      speaker_name: e.speaker_name ?? '',
      tournament_name: e.tournament_name ?? '', entry_fee: e.entry_fee != null ? String(e.entry_fee) : '', registration_contact: e.registration_contact ?? '',
      agenda: e.agenda ?? '',
    })
    setEditing(e.id); setShowForm(true)
  }
  const remove = async (id: string) => { if (!confirm(t('ve.confirmDelete'))) return; await supabase.from('village_events').delete().eq('id', id); toast.success(t('ve.deleted')); load() }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><CalendarDays size={26} /> {t('ve.pageTitle')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('ve.add')}</button>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && events.map((e) => (
          <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{t(`ve.cat.${e.category}`)}</span>
                {!e.is_active && <span className="text-[10px] font-bold font-sans text-dp-on-surface-variant">{t('ic.inactive')}</span>}
              </div>
              <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{e.title}</h3>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant ltr-num">{new Date(e.start_datetime).toLocaleString()}{e.location_text ? ` · ${e.location_text}` : ''}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => edit(e)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(e.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {!loading && events.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('ve.empty')}</p>}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? t('ve.editTitle') : t('ve.addTitle')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.category')}</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(`ve.cat.${c}`)}</option>)}
                </select>
              </div>
              {/* Category-specific fields -- real ask, 2026-09-30, Punjab
                  wedding/condolence culture: Mehndi/Nikkah/Baraat/Valima
                  are genuinely separate, separately-dated functions, and
                  separate men's/women's venues are standard for both a
                  wedding and a condolence gathering. */}
              {form.category === 'wedding' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3.5 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.groomName')}</label><input value={form.groom_name} onChange={(e) => setForm({ ...form, groom_name: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.brideName')}</label><input value={form.bride_name} onChange={(e) => setForm({ ...form, bride_name: e.target.value })} className="input-field" /></div>
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.weddingFunction')}</label>
                    <select value={form.wedding_function} onChange={(e) => setForm({ ...form, wedding_function: e.target.value })} className="input-field">
                      {['mehndi', 'nikkah', 'baraat', 'valima', 'other'].map((f) => <option key={f} value={f}>{t(`ve.fn.${f}`)}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.venueMen')}</label><input value={form.venue_men} onChange={(e) => setForm({ ...form, venue_men: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.venueWomen')}</label><input value={form.venue_women} onChange={(e) => setForm({ ...form, venue_women: e.target.value })} className="input-field" /></div>
                  </div>
                </div>
              )}
              {form.category === 'condolence' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3.5 space-y-3">
                  <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.deceasedName')}</label><input value={form.deceased_name} onChange={(e) => setForm({ ...form, deceased_name: e.target.value })} className="input-field" /></div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.gatheringType')}</label>
                    <select value={form.gathering_type} onChange={(e) => setForm({ ...form, gathering_type: e.target.value })} className="input-field">
                      {['soyem', 'chehlum', 'qul', 'other'].map((g) => <option key={g} value={g}>{t(`ve.gt.${g}`)}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.venueMen')}</label><input value={form.venue_men} onChange={(e) => setForm({ ...form, venue_men: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.venueWomen')}</label><input value={form.venue_women} onChange={(e) => setForm({ ...form, venue_women: e.target.value })} className="input-field" /></div>
                  </div>
                </div>
              )}
              {form.category === 'religious' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3.5">
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.speakerName')}</label>
                  <input value={form.speaker_name} onChange={(e) => setForm({ ...form, speaker_name: e.target.value })} className="input-field" />
                </div>
              )}
              {form.category === 'sports' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3.5 space-y-3">
                  <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.tournamentName')}</label><input value={form.tournament_name} onChange={(e) => setForm({ ...form, tournament_name: e.target.value })} className="input-field" /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.entryFee')}</label><input type="number" value={form.entry_fee} onChange={(e) => setForm({ ...form, entry_fee: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.registrationContact')}</label><input value={form.registration_contact} onChange={(e) => setForm({ ...form, registration_contact: e.target.value })} className="input-field" /></div>
                  </div>
                </div>
              )}
              {form.category === 'meeting' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3.5">
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ve.agenda')}</label>
                  <textarea value={form.agenda} onChange={(e) => setForm({ ...form, agenda: e.target.value })} rows={2} className="input-field resize-none" />
                </div>
              )}
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ve.titleEn')}</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ve.titleUr')}</label><input value={form.title_ur} onChange={(e) => setForm({ ...form, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ve.startDatetime')}</label><input type="datetime-local" value={form.start_datetime} onChange={(e) => setForm({ ...form, start_datetime: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ve.endDatetime')}</label><input type="datetime-local" value={form.end_datetime} onChange={(e) => setForm({ ...form, end_datetime: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('lf.location')}</label><input value={form.location_text} onChange={(e) => setForm({ ...form, location_text: e.target.value })} className="input-field" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ve.organizerName')}</label><input value={form.organizer_name} onChange={(e) => setForm({ ...form, organizer_name: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ve.organizerContact')}</label><input value={form.organizer_contact} onChange={(e) => setForm({ ...form, organizer_contact: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.descriptionOptional')}</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="input-field resize-none" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.descriptionUr')}</label><textarea value={form.description_ur} onChange={(e) => setForm({ ...form, description_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} /></div>
              <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('lf.photoOptional')} />
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('ic.active')}</span></label>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('ic.updateBtn') : t('ve.addBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
