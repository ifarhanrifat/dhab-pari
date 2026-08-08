'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Briefcase, PlusCircle, X, Pencil, Pause, Play, Megaphone } from 'lucide-react'

const CATEGORIES = ['plumber', 'electrician', 'mason', 'carpenter', 'painter', 'laborer', 'driver', 'tailor', 'cook', 'tutor', 'mechanic', 'other']

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
      toast.error('Fill in the headline and your contact name/mobile'); return
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
    toast.success(editId ? 'Listing updated' : 'Listing posted — visible on the public Jobs page now')
    setShowForm(false)
    load()
  }

  const toggleActive = async (l: Listing) => {
    const supabase = createClient()
    const { error } = await supabase.from('job_listings').update({ is_active: !l.is_active }).eq('id', l.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(l.is_active ? 'Listing paused' : 'Listing reactivated')
    load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>

  return (
    <>
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Briefcase size={22} className="text-dp-secondary" /> My Job Listings</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Offer a trade or service — plumber, mason, electrician, laborer, and more. Anyone can see and contact you directly.</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> Post a Listing
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 max-w-xl flex gap-3">
        <Megaphone size={18} className="text-amber-700 shrink-0 mt-0.5" />
        <p className="font-sans text-[13px] text-amber-900 leading-[20px]">
          Your headline, description, and contact details below are shown publicly on the Jobs page — anyone in the village can call or WhatsApp you directly. Only post the number you want inquiries on.
        </p>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Loading...</p>
      ) : listings.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">You haven&apos;t posted any listings yet.</p>
        </div>
      ) : (
        <div className="space-y-3 max-w-xl">
          {listings.map((l) => (
            <div key={l.id} className={`bg-white border border-dp-outline-variant rounded-lg p-4 ${!l.is_active ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{l.category}</span>
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{l.headline}</p>
                  {l.description && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{l.description}</p>}
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5">{l.contact_name} · {l.contact_mobile}{l.sector ? ` · ${l.sector}` : ''}</p>
                  {!l.is_active && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-low text-dp-on-surface-variant mt-1.5 inline-block">Paused</span>}
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
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editId ? 'Edit Listing' : 'Post a Listing'}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Category</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Headline *</label>
                <input value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} placeholder="e.g. Experienced plumber, all repairs" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Description (optional)</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" placeholder="Experience, availability, rates..." />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Sector / Area (optional)</label>
                <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} className="input-field" />
              </div>
              <div className="border-t border-dp-outline-variant pt-4">
                <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-3">Public Contact Info</p>
                <div className="space-y-3">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Contact Name *</label>
                    <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Mobile *</label>
                    <input value={form.contact_mobile} onChange={(e) => setForm({ ...form, contact_mobile: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">WhatsApp (optional)</label>
                    <input value={form.contact_whatsapp} onChange={(e) => setForm({ ...form, contact_whatsapp: e.target.value })} className="input-field" />
                  </div>
                </div>
              </div>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? 'Saving...' : editId ? 'Save Changes' : 'Post Listing'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
