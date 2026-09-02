'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Briefcase, PlusCircle, X, Pencil, Pause, Play, Megaphone } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'

const CATEGORIES = ['plumber', 'electrician', 'mason', 'carpenter', 'painter', 'laborer', 'driver', 'tailor', 'cook', 'tutor', 'mechanic', 'other']
const CATEGORY_KEY: Record<string, string> = {
  plumber: 'p.catPlumber', electrician: 'p.catElectrician', mason: 'p.catMason', carpenter: 'p.catCarpenter',
  painter: 'p.catPainter', laborer: 'p.catLaborer', driver: 'p.catDriver', tailor: 'p.catTailor',
  cook: 'p.catCook', tutor: 'p.catTutor', mechanic: 'p.catMechanic', other: 'p.catOther',
}

interface Listing {
  id: string; category: string; headline: string; description: string | null; sector: string | null
  contact_name: string; contact_mobile: string; contact_whatsapp: string | null; is_active: boolean
}

const empty = { category: 'plumber', headline: '', description: '', sector: '', contact_name: '', contact_mobile: '', contact_whatsapp: '' }

// Deliberately public once posted — unlike everything else identity-linked
// in this portal (donations, votes, complaints stay tied to a private
// profile), a job listing's entire purpose is to be found and contacted by
// anyone. Contact fields are entered/confirmed here rather than silently
// reused from the profile, so a poster can point inquiries at a different
// number without touching their private account details.
export default function PostJobPage() {
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
    const { data } = await supabase.from('job_listings').select('*').eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setListings(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const openAdd = () => {
    setEditId(null)
    setForm({ ...empty, contact_name: user?.full_name ?? '', contact_mobile: user?.mobile ?? '', contact_whatsapp: user?.whatsapp_number ?? '', sector: user?.sector ?? '' })
    setShowForm(true)
  }
  const openEdit = (l: Listing) => {
    setEditId(l.id)
    setForm({ category: l.category, headline: l.headline, description: l.description ?? '', sector: l.sector ?? '', contact_name: l.contact_name, contact_mobile: l.contact_mobile, contact_whatsapp: l.contact_whatsapp ?? '' })
    setShowForm(true)
  }

  const save = async () => {
    if (!user) return
    if (!form.headline.trim() || !form.contact_name.trim() || !form.contact_mobile.trim()) {
      toast.error(t('p.fillHeadlineContact')); return
    }
    setSaving(true)
    const supabase = createClient()
    const payload = {
      category: form.category, headline: form.headline.trim(), description: form.description.trim() || null,
      sector: form.sector.trim() || null, contact_name: form.contact_name.trim(), contact_mobile: form.contact_mobile.trim(),
      contact_whatsapp: form.contact_whatsapp.trim() || null, updated_at: new Date().toISOString(),
    }
    const { error } = editId
      ? await supabase.from('job_listings').update(payload).eq('id', editId)
      : await supabase.from('job_listings').insert({ ...payload, portal_user_id: user.id })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editId ? t('p.listingUpdated') : t('p.listingPosted'))
    setShowForm(false)
    load()
  }

  const toggleActive = async (l: Listing) => {
    const supabase = createClient()
    const { error } = await supabase.from('job_listings').update({ is_active: !l.is_active }).eq('id', l.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(l.is_active ? t('p.listingPaused') : t('p.listingReactivated'))
    load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Briefcase size={22} className="text-dp-secondary" /> {t('p.myJobListings')} <PortalHelp pageKey="postJob" /></h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.jobsBlurb')}</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {t('p.postListing')}
        </button>
      </div>

      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 max-w-xl flex gap-3">
        <Megaphone size={18} className="text-amber-700 shrink-0 mt-0.5" />
        <p className="font-sans text-[13px] text-amber-900 leading-[20px]">
          {t('p.jobsPublicWarning')}
        </p>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : listings.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('p.noListings')}</p>
        </div>
      ) : (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="space-y-3 max-w-xl">
          {listings.map((l) => (
            <div key={l.id} className={`bg-white border border-dp-outline-variant rounded-lg p-4 ${!l.is_active ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(CATEGORY_KEY[l.category] ?? '') || l.category}</span>
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{l.headline}</p>
                  {l.description && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{l.description}</p>}
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5">{l.contact_name} · {l.contact_mobile}{l.sector ? ` · ${l.sector}` : ''}</p>
                  {!l.is_active && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-low text-dp-on-surface-variant mt-1.5 inline-block">{t('w.paused')}</span>}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => openEdit(l)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
                  <button onClick={() => toggleActive(l)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                    {l.is_active ? <Pause size={15} /> : <Play size={15} />}
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
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editId ? t('p.editListing') : t('p.postListing')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.category')}</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(CATEGORY_KEY[c])}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.headline')}</label>
                <input value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} placeholder={t('p.headlinePlaceholder')} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.descriptionOptional')}</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" placeholder={t('p.descriptionPlaceholder')} />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.sectorOptional')}</label>
                <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} className="input-field" />
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
                {saving ? t('p.saving') : editId ? t('p.saveChanges') : t('p.postListing')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
