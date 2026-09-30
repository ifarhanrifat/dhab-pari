'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'

const LeafletSinglePinPicker = dynamic(() => import('@/components/shared/LeafletSinglePinPicker'), { ssr: false })

interface Landmark {
  id: string; category: string; name: string; name_ur: string | null
  description: string | null; description_ur: string | null; lat: number; lng: number
  photo_url: string | null; is_active: boolean
}
const CATEGORIES = ['graveyard', 'park', 'government_office', 'committee_office', 'water_supply', 'eid_gah', 'entrance', 'other']
const empty = { category: 'other', name: '', name_ur: '', description: '', description_ur: '', lat: null as number | null, lng: null as number | null, photo_url: '', is_active: true }

// Phase 3 of the "Village OS" feature set, 2026-10-01. For places
// Directory has no category for at all (a graveyard, the committee
// office, a water supply point) -- anything Directory already covers
// (mosque/school/health/business) gets its coordinates added directly on
// its own Directory entry instead, not duplicated here.
export default function AdminVillageMapPage() {
  const { t, isUrdu } = useLocale()
  const [items, setItems] = useState<Landmark[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('village_landmarks').select('*').order('display_order').order('name')
    setItems((data ?? []) as Landmark[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.name.trim() || form.lat == null || form.lng == null) { toast.error(t('vm.locationRequired')); return }
    const payload = {
      category: form.category, name: form.name.trim(), name_ur: form.name_ur.trim() || null,
      description: form.description.trim() || null, description_ur: form.description_ur.trim() || null,
      lat: form.lat, lng: form.lng, photo_url: form.photo_url || null, is_active: form.is_active,
    }
    if (editing) {
      const { error } = await supabase.from('village_landmarks').update(payload).eq('id', editing)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('vm.updated'))
    } else {
      const { error } = await supabase.from('village_landmarks').insert(payload)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('vm.added'))
    }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }

  const edit = (l: Landmark) => {
    setForm({
      category: l.category, name: l.name, name_ur: l.name_ur ?? '', description: l.description ?? '', description_ur: l.description_ur ?? '',
      lat: l.lat, lng: l.lng, photo_url: l.photo_url ?? '', is_active: l.is_active,
    })
    setEditing(l.id); setShowForm(true)
  }
  const remove = async (id: string) => { if (!confirm(t('vm.confirmDelete'))) return; await supabase.from('village_landmarks').delete().eq('id', id); toast.success(t('vm.deleted')); load() }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><MapPin size={26} /> {t('vm.title')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('vm.add')}</button>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && items.map((l) => (
          <div key={l.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{t(`vm.cat.${l.category}`)}</span>
              {!l.is_active && <span className="text-[10px] font-bold font-sans text-dp-on-surface-variant ms-1.5">{t('ic.inactive')}</span>}
              <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{l.name}</h3>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => edit(l)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(l.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {!loading && items.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('vm.empty')}</p>}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? t('vm.editTitle') : t('vm.addTitle')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.category')}</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(`vm.cat.${c}`)}</option>)}
                </select>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('vm.nameEn')}</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('vm.nameUr')}</label><input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} /></div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('vm.location')}</label>
                <LeafletSinglePinPicker lat={form.lat} lng={form.lng} onChange={(pin) => setForm({ ...form, lat: pin?.lat ?? null, lng: pin?.lng ?? null })} />
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.descriptionOptional')}</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="input-field resize-none" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dir.descriptionUr')}</label><textarea value={form.description_ur} onChange={(e) => setForm({ ...form, description_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} /></div>
              <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('lf.photoOptional')} />
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('ic.active')}</span></label>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('ic.updateBtn') : t('vm.addBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
