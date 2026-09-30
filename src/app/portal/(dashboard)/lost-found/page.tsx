'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Search, PlusCircle, X, Pencil, CheckCircle2, RotateCcw } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'

interface Post {
  id: string; type: string; item_name: string; description: string | null; photo_url: string | null
  location_text: string | null; contact_name: string; contact_mobile: string; contact_whatsapp: string | null
  status: string; is_active: boolean; moderation_status: string
}

const empty = { type: 'lost', item_name: '', description: '', photo_url: '', location_text: '', contact_name: '', contact_mobile: '', contact_whatsapp: '' }

// Same "deliberately public once posted" stance as post-job (migration
// 145): a Lost & Found post's whole purpose is to be seen by whoever has
// the item or is missing it, unlike everything else identity-linked in
// this portal.
export default function PortalLostFoundPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const { data } = await supabase.from('lost_found_posts').select('*').eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setPosts(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const openAdd = () => {
    setEditId(null)
    setForm({ ...empty, contact_name: user?.full_name ?? '', contact_mobile: user?.mobile ?? '', contact_whatsapp: user?.whatsapp_number ?? '' })
    setShowForm(true)
  }
  const openEdit = (p: Post) => {
    setEditId(p.id)
    setForm({ type: p.type, item_name: p.item_name, description: p.description ?? '', photo_url: p.photo_url ?? '', location_text: p.location_text ?? '', contact_name: p.contact_name, contact_mobile: p.contact_mobile, contact_whatsapp: p.contact_whatsapp ?? '' })
    setShowForm(true)
  }

  const save = async () => {
    if (!user) return
    if (!form.item_name.trim() || !form.contact_name.trim() || !form.contact_mobile.trim()) {
      toast.error(t('lf.fillRequired')); return
    }
    setSaving(true)
    const supabase = createClient()
    const payload = {
      type: form.type, item_name: form.item_name.trim(), description: form.description.trim() || null,
      photo_url: form.photo_url || null, location_text: form.location_text.trim() || null,
      contact_name: form.contact_name.trim(), contact_mobile: form.contact_mobile.trim(),
      contact_whatsapp: form.contact_whatsapp.trim() || null, updated_at: new Date().toISOString(),
    }
    const { error } = editId
      ? await supabase.from('lost_found_posts').update(payload).eq('id', editId)
      : await supabase.from('lost_found_posts').insert({ ...payload, portal_user_id: user.id })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editId ? t('lf.postUpdated') : t('lf.postCreated'))
    setShowForm(false)
    load()
  }

  const toggleStatus = async (p: Post) => {
    const supabase = createClient()
    const nextStatus = p.status === 'open' ? 'resolved' : 'open'
    const { error } = await supabase.from('lost_found_posts').update({ status: nextStatus }).eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(nextStatus === 'resolved' ? t('lf.markedResolved') : t('lf.markedOpen'))
    load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Search size={22} className="text-dp-secondary" /> {t('lf.myPosts')} <PortalHelp pageKey="lostFound" /></h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('lf.blurb')}</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {t('lf.newPost')}
        </button>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : posts.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('lf.noPosts')}</p>
        </div>
      ) : (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="space-y-3 max-w-xl">
          {posts.map((p) => (
            <div key={p.id} className={`bg-white border border-dp-outline-variant rounded-lg p-4 ${p.status === 'resolved' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full uppercase ${p.type === 'lost' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    {p.type === 'lost' ? t('lf.lost') : t('lf.found')}
                  </span>
                  {p.moderation_status === 'pending' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 uppercase ms-1.5">{t('mod.pendingReview')}</span>}
                  {p.moderation_status === 'rejected' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 uppercase ms-1.5">{t('mod.rejectedBadge')}</span>}
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{p.item_name}</p>
                  {p.location_text && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{p.location_text}</p>}
                  {p.status === 'resolved' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-low text-dp-on-surface-variant mt-1.5 inline-block">{t('lf.resolved')}</span>}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => openEdit(p)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
                  <button onClick={() => toggleStatus(p)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                    {p.status === 'open' ? <CheckCircle2 size={15} /> : <RotateCcw size={15} />}
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
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editId ? t('lf.editPost') : t('lf.newPost')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div className="flex gap-2">
                {(['lost', 'found'] as const).map((tp) => (
                  <button key={tp} onClick={() => setForm({ ...form, type: tp })}
                    className={`flex-1 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${form.type === tp ? (tp === 'lost' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white') : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                    {tp === 'lost' ? t('lf.lost') : t('lf.found')}
                  </button>
                ))}
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('lf.itemName')}</label>
                <input value={form.item_name} onChange={(e) => setForm({ ...form, item_name: e.target.value })} placeholder={t('lf.itemNamePlaceholder')} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.descriptionOptional')}</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" />
              </div>
              <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('lf.photoOptional')} />
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('lf.location')}</label>
                <input value={form.location_text} onChange={(e) => setForm({ ...form, location_text: e.target.value })} placeholder={t('lf.locationPlaceholder')} className="input-field" />
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
                {saving ? t('p.saving') : editId ? t('p.saveChanges') : t('lf.newPost')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
