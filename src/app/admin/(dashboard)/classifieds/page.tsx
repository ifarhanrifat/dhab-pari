'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ShoppingBag, Power } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Listing {
  id: string; category: string; title: string; price_pkr: number | null
  contact_name: string; contact_mobile: string; status: string; is_active: boolean; created_at: string
}

const CATEGORIES = ['electronics', 'vehicles', 'animals', 'furniture', 'land', 'agriculture', 'household', 'other']
function fmt(n: number) { return Number(n).toLocaleString() }

// Committee-wide moderation lever, same shape as /admin/jobs: listings go
// live the moment a portal user posts them (no pre-approval queue, low
// friction by design), this is how staff take one down if needed.
export default function AdminClassifiedsPage() {
  const { t, isUrdu } = useLocale()
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('classified_listings').select('*').order('created_at', { ascending: false })
    setListings(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => listings.filter((l) => (!category || l.category === category) && (!activeOnly || l.is_active)), [listings, category, activeOnly])

  const toggleActive = async (l: Listing) => {
    const { error } = await supabase.from('classified_listings').update({ is_active: !l.is_active }).eq('id', l.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(l.is_active ? t('jb.deactivated') : t('jb.reactivated'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><ShoppingBag size={26} className="text-dp-secondary" /> {t('cl.pageTitle')}</h1>
      </div>

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
              {!loading && filtered.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">{t('y.noMatchingListings')}</td></tr>}
              {!loading && filtered.map((l, i) => (
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
    </div>
  )
}
