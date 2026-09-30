'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ShoppingBag, Power, Check, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Listing {
  id: string; category: string; title: string; price_pkr: number | null
  contact_name: string; contact_mobile: string; status: string; is_active: boolean; created_at: string
  moderation_status: string
}

const CATEGORIES = ['electronics', 'vehicles', 'animals', 'furniture', 'land', 'agriculture', 'household', 'other']
function fmt(n: number) { return Number(n).toLocaleString() }

// Real direction, 2026-09-30: nothing posts to the public board
// automatically -- a Pending tab gate before the existing "staff can
// deactivate after the fact" moderation lever even applies.
export default function AdminClassifiedsPage() {
  const { t, isUrdu } = useLocale()
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const [category, setCategory] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('classified_listings').select('*').order('created_at', { ascending: false })
    setListings((data ?? []) as Listing[])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const reviewer = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    return me?.id
  }

  const approve = async (l: Listing) => {
    const reviewedBy = await reviewer()
    const { error } = await supabase.from('classified_listings').update({ moderation_status: 'approved', is_active: true, reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() }).eq('id', l.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.approved')); load()
  }
  const reject = async (l: Listing) => {
    const reviewedBy = await reviewer()
    const { error } = await supabase.from('classified_listings').update({ moderation_status: 'rejected', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() }).eq('id', l.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.rejected')); load()
  }

  const pending = listings.filter((l) => l.moderation_status === 'pending')
  const approvedListings = useMemo(
    () => listings.filter((l) => l.moderation_status === 'approved').filter((l) => (!category || l.category === category) && (!activeOnly || l.is_active)),
    [listings, category, activeOnly]
  )

  const toggleActive = async (l: Listing) => {
    const { error } = await supabase.from('classified_listings').update({ is_active: !l.is_active }).eq('id', l.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(l.is_active ? t('jb.deactivated') : t('jb.reactivated'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><ShoppingBag size={26} className="text-dp-secondary" /> {t('cl.pageTitle')}</h1>
        <div className="flex gap-2">
          <button onClick={() => setTab('pending')} className={`px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${tab === 'pending' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t('mod.pending')} {pending.length > 0 && `(${pending.length})`}
          </button>
          <button onClick={() => setTab('approved')} className={`px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${tab === 'approved' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t('mod.approved')}
          </button>
        </div>
      </div>

      {tab === 'pending' ? (
        <div className="space-y-3">
          {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
          {!loading && pending.map((l) => (
            <div key={l.id} className="bg-white border border-amber-300 rounded-lg p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high uppercase font-sans">{t(`cl.cat.${l.category}`)}</span>
                <p className="font-sans text-[15px] font-bold text-dp-on-surface mt-1 truncate">{l.title}{l.price_pkr != null ? ` — PKR ${fmt(l.price_pkr)}` : ''}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{l.contact_name} · {l.contact_mobile}</p>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => approve(l)} title={t('mod.approve')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700"><Check size={15} /></button>
                <button onClick={() => reject(l)} title={t('mod.reject')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><X size={15} /></button>
              </div>
            </div>
          ))}
          {!loading && pending.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('mod.nothingPending')}</p>}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 mb-5">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field w-auto">
              <option value="">{t('x.allCategories')}</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cl.cat.${c}`)}</option>)}
            </select>
            <label className="flex items-center gap-2 cursor-pointer font-sans text-[14px]">
              <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-dp-secondary" />
              {t('y.activeOnly')}
            </label>
          </div>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
                  <th className="p-4">{t('cl.itemTitle')}</th><th className="p-4">{t('w.category')}</th><th className="p-4">{t('w.amount')}</th><th className="p-4">{t('y.contact')}</th><th className="p-4">{t('w.status')}</th><th className="p-4"></th>
                </tr></thead>
                <tbody className="font-sans text-[15px]">
                  {loading && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant"><LoadingDots /></td></tr>}
                  {!loading && approvedListings.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">{t('y.noMatchingListings')}</td></tr>}
                  {!loading && approvedListings.map((l, i) => (
                    <tr key={l.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${!l.is_active ? 'opacity-60' : ''}`}>
                      <td className="p-4 border-b border-dp-outline-variant font-semibold">{l.title}</td>
                      <td className="p-4 border-b border-dp-outline-variant"><span className="bg-dp-secondary-container text-dp-on-secondary-container px-2 py-0.5 rounded-full text-[12px] font-bold uppercase">{t(`cl.cat.${l.category}`)}</span></td>
                      <td className="p-4 border-b border-dp-outline-variant ltr-num">{l.price_pkr != null ? fmt(l.price_pkr) : '—'}</td>
                      <td className="p-4 border-b border-dp-outline-variant">{l.contact_name} · {l.contact_mobile}</td>
                      <td className="p-4 border-b border-dp-outline-variant">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${l.status === 'sold' ? 'bg-dp-surface-container-high text-dp-on-surface-variant' : 'bg-emerald-100 text-emerald-700'}`}>{l.status === 'sold' ? t('cl.sold') : t('g.active')}</span>
                      </td>
                      <td className="p-4 border-b border-dp-outline-variant">
                        <button onClick={() => toggleActive(l)} title={l.is_active ? t('jb.deactivateTitle') : t('jb.reactivateTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Power size={16} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
