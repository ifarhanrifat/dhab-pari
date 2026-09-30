'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HandHeart, PlusCircle, X, CheckCircle2, RotateCcw, Droplet } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Req {
  id: string; category: string; description: string; location_text: string | null
  contact_name: string; contact_mobile: string; status: string
}

const CATEGORIES = ['medical', 'transport', 'elderly', 'missing_person', 'fire', 'accident', 'other']
const empty = { category: 'medical', description: '', location_text: '', contact_name: '', contact_mobile: '' }

// Phase 2 of the "Village OS" feature set, 2026-09-30. Public once
// submitted (help_requests_public_read has no owner filter) -- the whole
// point is any villager who can help sees it, not just staff. Blood is
// deliberately not a category here -- it already has a real, dedicated
// system (/blood) with its own donor-matching flow.
export default function AskForHelpPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [requests, setRequests] = useState<Req[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const { data } = await supabase.from('help_requests').select('*').eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setRequests(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const openAdd = () => {
    setForm({ ...empty, contact_name: user?.full_name ?? '', contact_mobile: user?.mobile ?? '' })
    setShowForm(true)
  }

  const save = async () => {
    if (!user) return
    if (!form.description.trim() || !form.contact_name.trim() || !form.contact_mobile.trim()) {
      toast.error(t('hr.fillRequired')); return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('help_requests').insert({
      portal_user_id: user.id, category: form.category, description: form.description.trim(),
      location_text: form.location_text.trim() || null, contact_name: form.contact_name.trim(), contact_mobile: form.contact_mobile.trim(),
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('hr.requestPosted'))
    setShowForm(false); load()
  }

  const toggleStatus = async (r: Req) => {
    const supabase = createClient()
    const nextStatus = r.status === 'open' ? 'resolved' : 'open'
    const { error } = await supabase.from('help_requests').update({ status: nextStatus }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(nextStatus === 'resolved' ? t('hr.markedResolved') : t('hr.markedOpen'))
    load()
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HandHeart size={22} className="text-dp-secondary" /> {t('hr.myRequests')} <PortalHelp pageKey="askForHelp" /></h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('hr.blurb')}</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {t('hr.newRequest')}
        </button>
      </div>

      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 max-w-xl flex items-center justify-between gap-3">
        <p className="font-sans text-[13px] text-red-900"><Droplet size={14} className="inline me-1" /> {t('hr.bloodRedirect')}</p>
        <Link href="/blood" className="text-red-700 font-semibold text-[13px] shrink-0 hover:underline">{t('hr.goToBlood')}</Link>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : requests.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('hr.noRequests')}</p>
        </div>
      ) : (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="space-y-3 max-w-xl">
          {requests.map((r) => (
            <div key={r.id} className={`bg-white border border-dp-outline-variant rounded-lg p-4 ${r.status === 'resolved' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`hr.cat.${r.category}`)}</span>
                  <p className="font-sans text-[14px] text-dp-on-surface mt-1.5">{r.description}</p>
                  {r.location_text && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{r.location_text}</p>}
                  {r.status === 'resolved' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-low text-dp-on-surface-variant mt-1.5 inline-block">{t('hr.resolved')}</span>}
                </div>
                <button onClick={() => toggleStatus(r)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer shrink-0">
                  {r.status === 'open' ? <CheckCircle2 size={16} /> : <RotateCcw size={16} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('hr.newRequest')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.category')}</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(`hr.cat.${c}`)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('hr.description')}</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" placeholder={t('hr.descriptionPlaceholder')} />
              </div>
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
                </div>
              </div>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? t('p.saving') : t('hr.submitRequest')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
