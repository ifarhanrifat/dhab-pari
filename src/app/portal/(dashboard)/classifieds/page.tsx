'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ShoppingBag, PlusCircle, X, Pencil, CheckCircle2, RotateCcw } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { ClassifiedsDisclaimer } from '@/components/public/ClassifiedsDisclaimer'

interface Listing {
  id: string; category: string; title: string; description: string | null; price_pkr: number | null; photo_url: string | null
  location_text: string | null; contact_name: string; contact_mobile: string; contact_whatsapp: string | null; status: string; is_active: boolean
  moderation_status: string
  animal_type: string | null; animal_age_stage: string | null; animal_weight_kg: number | null
  brand: string | null; model: string | null; item_condition: string | null; specifications: string | null
  vehicle_year: number | null; vehicle_mileage_km: number | null
  land_size: number | null; land_size_unit: string | null
}

const CATEGORIES = ['electronics', 'vehicles', 'animals', 'furniture', 'land', 'agriculture', 'household', 'other']
const ANIMAL_TYPES = ['cow', 'buffalo', 'goat', 'sheep', 'hen', 'other']
const ANIMAL_AGE_STAGES = ['young', 'do_dandi', 'chaugga', 'chhakka', 'full_mouth', 'other']
// Real ask, 2026-09-30: no free API reliably gives phone brand/model
// autocomplete without a key or fragile scraping -- a curated brand list
// (what's actually sold/resold in Pakistan) plus a free-text model field
// is the honest, robust version of that same idea.
const PHONE_BRANDS = ['Samsung', 'Apple', 'Xiaomi', 'Infinix', 'Tecno', 'Vivo', 'Oppo', 'Realme', 'itel', 'Nokia', 'Honor', 'OnePlus', 'Huawei', 'Google', 'Other']
const LAND_UNITS = ['marla', 'kanal', 'acre']

const empty = {
  category: 'electronics', title: '', description: '', price_pkr: '', photo_url: '', location_text: '',
  contact_name: '', contact_mobile: '', contact_whatsapp: '',
  animal_type: 'cow', animal_age_stage: 'young', animal_weight_kg: '',
  brand: '', model: '', item_condition: 'used', specifications: '',
  vehicle_year: '', vehicle_mileage_km: '',
  land_size: '', land_size_unit: 'marla',
}

function fmt(n: number) { return Number(n).toLocaleString() }

// Phase 2 of the "Village OS" feature set, 2026-09-30. Same "deliberately
// public once posted" stance as post-job/lost-found: the whole point is
// to be found and contacted by a buyer, unlike everything else identity-
// linked in this portal. Category-specific fields (migration 534) added
// 2026-09-30 -- a cattle sale needs weight/age, a phone needs brand/
// model/condition, a vehicle needs year/mileage, land needs marla/kanal.
export default function PortalClassifiedsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const { data } = await supabase.from('classified_listings').select('*').eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setListings((data ?? []) as Listing[])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const openAdd = () => {
    setEditId(null)
    setForm({ ...empty, contact_name: user?.full_name ?? '', contact_mobile: user?.mobile ?? '', contact_whatsapp: user?.whatsapp_number ?? '' })
    setShowForm(true)
  }
  const openEdit = (l: Listing) => {
    setEditId(l.id)
    setForm({
      category: l.category, title: l.title, description: l.description ?? '', price_pkr: l.price_pkr != null ? String(l.price_pkr) : '',
      photo_url: l.photo_url ?? '', location_text: l.location_text ?? '', contact_name: l.contact_name,
      contact_mobile: l.contact_mobile, contact_whatsapp: l.contact_whatsapp ?? '',
      animal_type: l.animal_type ?? 'cow', animal_age_stage: l.animal_age_stage ?? 'young',
      animal_weight_kg: l.animal_weight_kg != null ? String(l.animal_weight_kg) : '',
      brand: l.brand ?? '', model: l.model ?? '', item_condition: l.item_condition ?? 'used', specifications: l.specifications ?? '',
      vehicle_year: l.vehicle_year != null ? String(l.vehicle_year) : '', vehicle_mileage_km: l.vehicle_mileage_km != null ? String(l.vehicle_mileage_km) : '',
      land_size: l.land_size != null ? String(l.land_size) : '', land_size_unit: l.land_size_unit ?? 'marla',
    })
    setShowForm(true)
  }

  const save = async () => {
    if (!user) return
    if (!form.title.trim() || !form.contact_name.trim() || !form.contact_mobile.trim()) {
      toast.error(t('cl.fillRequired')); return
    }
    setSaving(true)
    const supabase = createClient()
    const payload = {
      category: form.category, title: form.title.trim(), description: form.description.trim() || null,
      price_pkr: form.price_pkr.trim() ? Number(form.price_pkr) : null, photo_url: form.photo_url || null,
      location_text: form.location_text.trim() || null, contact_name: form.contact_name.trim(),
      contact_mobile: form.contact_mobile.trim(), contact_whatsapp: form.contact_whatsapp.trim() || null,
      updated_at: new Date().toISOString(),
      animal_type: form.category === 'animals' ? form.animal_type : null,
      animal_age_stage: form.category === 'animals' ? form.animal_age_stage : null,
      animal_weight_kg: form.category === 'animals' && form.animal_weight_kg.trim() ? Number(form.animal_weight_kg) : null,
      brand: (form.category === 'electronics' || form.category === 'vehicles') ? (form.brand.trim() || null) : null,
      model: (form.category === 'electronics' || form.category === 'vehicles') ? (form.model.trim() || null) : null,
      item_condition: (form.category === 'electronics' || form.category === 'vehicles') ? form.item_condition : null,
      specifications: (form.category === 'electronics' || form.category === 'vehicles') ? (form.specifications.trim() || null) : null,
      vehicle_year: form.category === 'vehicles' && form.vehicle_year.trim() ? Number(form.vehicle_year) : null,
      vehicle_mileage_km: form.category === 'vehicles' && form.vehicle_mileage_km.trim() ? Number(form.vehicle_mileage_km) : null,
      land_size: form.category === 'land' && form.land_size.trim() ? Number(form.land_size) : null,
      land_size_unit: form.category === 'land' ? form.land_size_unit : null,
    }
    const { error } = editId
      ? await supabase.from('classified_listings').update(payload).eq('id', editId)
      : await supabase.from('classified_listings').insert({ ...payload, portal_user_id: user.id })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editId ? t('cl.listingUpdated') : t('cl.listingPosted'))
    setShowForm(false); load()
  }

  const toggleStatus = async (l: Listing) => {
    const supabase = createClient()
    const nextStatus = l.status === 'active' ? 'sold' : 'active'
    const { error } = await supabase.from('classified_listings').update({ status: nextStatus }).eq('id', l.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(nextStatus === 'sold' ? t('cl.markedSold') : t('cl.markedActive'))
    load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><ShoppingBag size={22} className="text-dp-secondary" /> {t('cl.myListings')} <PortalHelp pageKey="classifieds" /></h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('cl.blurb')}</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {t('cl.newListing')}
        </button>
      </div>

      <div className="max-w-xl"><ClassifiedsDisclaimer /></div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : listings.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('cl.noListings')}</p>
        </div>
      ) : (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="space-y-3 max-w-xl">
          {listings.map((l) => (
            <div key={l.id} className={`bg-white border border-dp-outline-variant rounded-lg p-4 ${l.status === 'sold' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`cl.cat.${l.category}`)}</span>
                  {l.moderation_status === 'pending' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 uppercase ms-1.5">{t('mod.pendingReview')}</span>}
                  {l.moderation_status === 'rejected' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 uppercase ms-1.5">{t('mod.rejectedBadge')}</span>}
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{l.title}</p>
                  {l.price_pkr != null && <p className="font-sans text-[14px] font-bold text-dp-primary mt-0.5 ltr-num">PKR {fmt(l.price_pkr)}</p>}
                  {l.status === 'sold' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-low text-dp-on-surface-variant mt-1.5 inline-block">{t('cl.sold')}</span>}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => openEdit(l)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
                  <button onClick={() => toggleStatus(l)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                    {l.status === 'active' ? <CheckCircle2 size={15} /> : <RotateCcw size={15} />}
                  </button>
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
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editId ? t('cl.editListing') : t('cl.newListing')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.category')}</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cl.cat.${c}`)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.itemTitle')}</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('cl.itemTitlePlaceholder')} className="input-field" />
              </div>

              {/* Category-specific fields — migration 534 */}
              {form.category === 'animals' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-3">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.animalType')}</label>
                    <select value={form.animal_type} onChange={(e) => setForm({ ...form, animal_type: e.target.value })} className="input-field">
                      {ANIMAL_TYPES.map((a) => <option key={a} value={a}>{t(`cl.animal.${a}`)}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.animalAge')}</label>
                      <select value={form.animal_age_stage} onChange={(e) => setForm({ ...form, animal_age_stage: e.target.value })} className="input-field">
                        {ANIMAL_AGE_STAGES.map((a) => <option key={a} value={a}>{t(`cl.ageStage.${a}`)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.weightKg')}</label>
                      <input type="number" value={form.animal_weight_kg} onChange={(e) => setForm({ ...form, animal_weight_kg: e.target.value })} className="input-field" placeholder="250" />
                    </div>
                  </div>
                </div>
              )}

              {(form.category === 'electronics' || form.category === 'vehicles') && (
                <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.brand')}</label>
                      {form.category === 'electronics' ? (
                        <select value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} className="input-field">
                          <option value="">{t('cl.selectBrand')}</option>
                          {PHONE_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      ) : (
                        <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder={t('cl.brandPlaceholderVehicle')} className="input-field" />
                      )}
                    </div>
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.model')}</label>
                      <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={form.category === 'electronics' ? t('cl.modelPlaceholderPhone') : t('cl.modelPlaceholderVehicle')} className="input-field" />
                    </div>
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.condition')}</label>
                    <div className="flex gap-2">
                      {(['new', 'used'] as const).map((c) => (
                        <button key={c} type="button" onClick={() => setForm({ ...form, item_condition: c })}
                          className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${form.item_condition === c ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                          {t(`cl.condition.${c}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {form.category === 'vehicles' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.vehicleYear')}</label>
                        <input type="number" value={form.vehicle_year} onChange={(e) => setForm({ ...form, vehicle_year: e.target.value })} className="input-field" placeholder="2018" />
                      </div>
                      <div>
                        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.mileageKm')}</label>
                        <input type="number" value={form.vehicle_mileage_km} onChange={(e) => setForm({ ...form, vehicle_mileage_km: e.target.value })} className="input-field" placeholder="45000" />
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.specifications')}</label>
                    <textarea value={form.specifications} onChange={(e) => setForm({ ...form, specifications: e.target.value })} rows={2} className="input-field resize-none" placeholder={form.category === 'electronics' ? t('cl.specsPlaceholderPhone') : t('cl.specsPlaceholderVehicle')} />
                  </div>
                </div>
              )}

              {form.category === 'land' && (
                <div className="bg-dp-surface-container-low rounded-lg p-3">
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.landSize')}</label>
                  <div className="flex gap-2">
                    <input type="number" value={form.land_size} onChange={(e) => setForm({ ...form, land_size: e.target.value })} className="input-field" placeholder="5" />
                    <select value={form.land_size_unit} onChange={(e) => setForm({ ...form, land_size_unit: e.target.value })} className="input-field w-auto">
                      {LAND_UNITS.map((u) => <option key={u} value={u}>{t(`cl.unit.${u}`)}</option>)}
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cl.priceOptional')}</label>
                <input type="number" value={form.price_pkr} onChange={(e) => setForm({ ...form, price_pkr: e.target.value })} placeholder="180000" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.descriptionOptional')}</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" />
              </div>
              <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('lf.photoOptional')} />
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('lf.location')}</label>
                <input value={form.location_text} onChange={(e) => setForm({ ...form, location_text: e.target.value })} className="input-field" />
              </div>
              <div className="border-t border-dp-outline-variant pt-4">
                <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-3">{t('p.publicContactInfo')}</p>
                <div className="space-y-3">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.contactName')}</label>
                    <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.mobileReq')}</label>
                    <input value={form.contact_mobile} onChange={(e) => setForm({ ...form, contact_mobile: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.whatsapp')}</label>
                    <input value={form.contact_whatsapp} onChange={(e) => setForm({ ...form, contact_whatsapp: e.target.value })} className="input-field" />
                  </div>
                </div>
              </div>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? t('p.saving') : editId ? t('p.saveChanges') : t('cl.postListing')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
