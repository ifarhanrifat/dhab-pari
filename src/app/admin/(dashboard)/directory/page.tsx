'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, BookOpen } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'

const LeafletSinglePinPicker = dynamic(() => import('@/components/shared/LeafletSinglePinPicker'), { ssr: false })

interface Entry {
  id: string; category: string; subcategory: string | null; name: string; name_ur: string | null
  description: string | null; description_ur: string | null; location_text: string | null
  phone: string | null; whatsapp_number: string | null; hours_text: string | null; photo_url: string | null
  display_order: number; is_active: boolean; lat: number | null; lng: number | null
  admission_status: string | null; fee_per_month: number | null; current_students_count: number | null; teacher_qualifications: string | null
  fajr_time: string | null; zuhr_time: string | null; asr_time: string | null; maghrib_time: string | null; isha_time: string | null; jumma_time: string | null
}

const CATEGORIES = ['business', 'health', 'mosque', 'school', 'machinery']
// Real correction, 2026-10-01: "when we already have the business in
// [marketplace] why are we adding karobar in the directory feature?" --
// 'general_store' dropped here on purpose. Marketplace (388) already has
// a full public Shops section (browsable with no login, real product
// catalog, search, ordering) -- a Directory entry for the same shop
// would just be a worse duplicate of data staff already maintain there.
// Every other business subcategory (restaurant, tailor, barber, etc.)
// has no Marketplace equivalent at all, so those stay here.
const SUBCATEGORIES: Record<string, string[]> = {
  business: ['restaurant', 'tailor', 'barber', 'electronics_shop', 'internet_provider', 'mechanic_shop', 'other'],
  // The 20 specialty values after 'other' came from a real, 99-record
  // Chakwal city doctors directory, 2026-10-02 -- consolidated from the
  // source's 56 raw near-duplicate specialty strings (e.g. "Child
  // Specialist" / "Paediatrician" / "General Physician / General
  // Pediatrician" were all the same thing worded three ways) down to one
  // clean, filterable set.
  health: ['doctor', 'clinic', 'hospital', 'medical_store', 'ambulance_service', 'other',
    'general_physician', 'child_specialist', 'gynaecologist', 'dermatologist', 'ent_specialist',
    'eye_specialist', 'dental_surgeon', 'orthopedic_surgeon', 'general_surgeon', 'cardiologist',
    'neurologist', 'neurosurgeon', 'gastroenterologist', 'nephrologist', 'urologist',
    'internal_medicine', 'psychologist', 'physiotherapist', 'anesthesiologist', 'aesthetic_physician'],
  mosque: ['mosque'],
  school: ['primary_school', 'secondary_school', 'college', 'madrassa', 'other'],
  // Real ask, 2026-10-02: "village tractors directory and phone numbers
  // along with there machinery what they have" -- the 'veterinary'
  // category it replaces had zero real entries (animal health now lives
  // under the Agriculture hub instead). description/description_ur
  // already free-text, used here to list exactly what equipment an
  // owner has (e.g. "50HP tractor + rotavator + trolley") rather than
  // adding new columns for it.
  machinery: ['tractor', 'rotavator', 'thresher', 'laser_leveler', 'combine_harvester', 'sprayer', 'other'],
}
const empty = {
  category: 'business', subcategory: 'restaurant', name: '', name_ur: '', description: '', description_ur: '',
  location_text: '', phone: '', whatsapp_number: '', hours_text: '', photo_url: '', display_order: 0, is_active: true,
  lat: null as number | null, lng: null as number | null,
  admission_status: '', fee_per_month: '', current_students_count: '', teacher_qualifications: '',
  fajr_time: '', zuhr_time: '', asr_time: '', maghrib_time: '', isha_time: '', jumma_time: '',
}

export default function AdminDirectoryPage() {
  const { t, isUrdu } = useLocale()
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('business')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('directory_entries').select('*').order('display_order').order('name')
    setEntries((data ?? []) as Entry[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.name.trim()) { toast.error(t('dir.nameRequired')); return }
    const cat = form.category
    const payload = {
      ...form,
      subcategory: form.subcategory || null,
      // Category-scoped, same convention as Events (539) -- switching a
      // school entry's category away from "school" shouldn't leave a
      // stale fee/admission value behind on, say, a mosque.
      admission_status: cat === 'school' ? (form.admission_status || null) : null,
      fee_per_month: cat === 'school' && form.fee_per_month ? parseFloat(form.fee_per_month) : null,
      current_students_count: cat === 'school' && form.current_students_count ? parseInt(form.current_students_count, 10) : null,
      teacher_qualifications: cat === 'school' ? (form.teacher_qualifications.trim() || null) : null,
      fajr_time: cat === 'mosque' ? (form.fajr_time || null) : null,
      zuhr_time: cat === 'mosque' ? (form.zuhr_time || null) : null,
      asr_time: cat === 'mosque' ? (form.asr_time || null) : null,
      maghrib_time: cat === 'mosque' ? (form.maghrib_time || null) : null,
      isha_time: cat === 'mosque' ? (form.isha_time || null) : null,
      jumma_time: cat === 'mosque' ? (form.jumma_time || null) : null,
    }
    if (editing) { const { error } = await supabase.from('directory_entries').update(payload).eq('id', editing); if (error) { toast.error(friendlyError(error)); return }; toast.success(t('dir.updated')) }
    else { const { error } = await supabase.from('directory_entries').insert(payload); if (error) { toast.error(friendlyError(error)); return }; toast.success(t('dir.added')) }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }
  const edit = (e: Entry) => {
    setForm({
      category: e.category, subcategory: e.subcategory ?? SUBCATEGORIES[e.category][0], name: e.name, name_ur: e.name_ur ?? '',
      description: e.description ?? '', description_ur: e.description_ur ?? '', location_text: e.location_text ?? '',
      phone: e.phone ?? '', whatsapp_number: e.whatsapp_number ?? '', hours_text: e.hours_text ?? '',
      photo_url: e.photo_url ?? '', display_order: e.display_order, is_active: e.is_active,
      lat: e.lat, lng: e.lng,
      admission_status: e.admission_status ?? '', fee_per_month: e.fee_per_month != null ? String(e.fee_per_month) : '',
      current_students_count: e.current_students_count != null ? String(e.current_students_count) : '', teacher_qualifications: e.teacher_qualifications ?? '',
      fajr_time: e.fajr_time ?? '', zuhr_time: e.zuhr_time ?? '', asr_time: e.asr_time ?? '',
      maghrib_time: e.maghrib_time ?? '', isha_time: e.isha_time ?? '', jumma_time: e.jumma_time ?? '',
    })
    setEditing(e.id); setShowForm(true)
  }
  const remove = async (id: string) => { if (!confirm(t('dir.confirmDelete'))) return; await supabase.from('directory_entries').delete().eq('id', id); toast.success(t('dir.deleted')); load() }

  const shown = entries.filter((e) => e.category === tab)

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><BookOpen size={26} /> {t('dir.title')}</h1>
        <button onClick={() => { setForm({ ...empty, category: tab, subcategory: SUBCATEGORIES[tab][0] }); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('dir.add')}</button>
      </div>
      <div className="flex gap-2 mb-5 flex-wrap">
        {CATEGORIES.map((c) => (
          <button key={c} onClick={() => setTab(c)} className={`px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${tab === c ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t(`dir.cat.${c}`)}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && shown.map((e) => (
          <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {e.subcategory && <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{t(`dir.sub.${e.subcategory}`)}</span>}
                {!e.is_active && <span className="text-[10px] font-bold font-sans text-dp-on-surface-variant">{t('ic.inactive')}</span>}
              </div>
              <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{e.name}</h3>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{e.phone ?? '—'}{e.location_text ? ` · ${e.location_text}` : ''}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => edit(e)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(e.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {!loading && shown.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('dir.empty')}</p>}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? t('dir.editTitle') : t('dir.addTitle')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.category')}</label>
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value, subcategory: SUBCATEGORIES[e.target.value][0] })} className="input-field">
                    {CATEGORIES.map((c) => <option key={c} value={c}>{t(`dir.cat.${c}`)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.subcategory')}</label>
                  <select value={form.subcategory} onChange={(e) => setForm({ ...form, subcategory: e.target.value })} className="input-field">
                    {SUBCATEGORIES[form.category].map((s) => <option key={s} value={s}>{t(`dir.sub.${s}`)}</option>)}
                  </select>
                </div>
              </div>
              {form.category === 'business' && (
                <p className="font-sans text-[12px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg p-2.5">{t('dir.generalStoreNote')}</p>
              )}
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.nameEn')}</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.nameUr')}</label><input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.phone')}</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.whatsapp')}</label><input value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('lf.location')}</label><input value={form.location_text} onChange={(e) => setForm({ ...form, location_text: e.target.value })} className="input-field" /></div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.mapLocation')}</label>
                <LeafletSinglePinPicker lat={form.lat} lng={form.lng} onChange={(pin) => setForm({ ...form, lat: pin?.lat ?? null, lng: pin?.lng ?? null })} />
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.hours')}</label><input value={form.hours_text} onChange={(e) => setForm({ ...form, hours_text: e.target.value })} placeholder={t('dir.hoursPlaceholder')} className="input-field" /></div>

              {/* Real ask, 2026-10-01: category-specific fields for
                  School (admission status/fee/enrollment/teachers) and
                  Mosque (the five daily prayers + Jumma), same shape as
                  Events' category fields (539). */}
              {form.category === 'school' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3.5 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('dir.admissionStatus')}</label>
                      <select value={form.admission_status} onChange={(e) => setForm({ ...form, admission_status: e.target.value })} className="input-field">
                        <option value="">—</option>
                        <option value="open">{t('dir.admissionOpen')}</option>
                        <option value="closed">{t('dir.admissionClosed')}</option>
                      </select>
                    </div>
                    <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('dir.feePerMonth')}</label><input type="number" value={form.fee_per_month} onChange={(e) => setForm({ ...form, fee_per_month: e.target.value })} className="input-field" /></div>
                  </div>
                  <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('dir.currentStudents')}</label><input type="number" value={form.current_students_count} onChange={(e) => setForm({ ...form, current_students_count: e.target.value })} className="input-field" /></div>
                  <div><label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('dir.teacherQualifications')}</label><textarea value={form.teacher_qualifications} onChange={(e) => setForm({ ...form, teacher_qualifications: e.target.value })} rows={2} className="input-field resize-none" /></div>
                </div>
              )}
              {form.category === 'mosque' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3.5 space-y-3">
                  <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide">{t('dir.namazTimings')}</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('dir.fajr')}</label><input type="time" value={form.fajr_time} onChange={(e) => setForm({ ...form, fajr_time: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('dir.zuhr')}</label><input type="time" value={form.zuhr_time} onChange={(e) => setForm({ ...form, zuhr_time: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('dir.asr')}</label><input type="time" value={form.asr_time} onChange={(e) => setForm({ ...form, asr_time: e.target.value })} className="input-field" /></div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('dir.maghrib')}</label><input type="time" value={form.maghrib_time} onChange={(e) => setForm({ ...form, maghrib_time: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('dir.isha')}</label><input type="time" value={form.isha_time} onChange={(e) => setForm({ ...form, isha_time: e.target.value })} className="input-field" /></div>
                    <div><label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('dir.jumma')}</label><input type="time" value={form.jumma_time} onChange={(e) => setForm({ ...form, jumma_time: e.target.value })} className="input-field" /></div>
                  </div>
                </div>
              )}
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.descriptionOptional')}</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="input-field resize-none" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.descriptionUr')}</label><textarea value={form.description_ur} onChange={(e) => setForm({ ...form, description_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} /></div>
              <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('lf.photoOptional')} />
              <div className="grid grid-cols-2 gap-4 items-end">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.order')}</label><input type="number" value={form.display_order} onChange={(e) => setForm({ ...form, display_order: +e.target.value })} className="input-field" /></div>
                <label className="flex items-center gap-2 cursor-pointer pb-2.5"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('ic.active')}</span></label>
              </div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('ic.updateBtn') : t('dir.addBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
