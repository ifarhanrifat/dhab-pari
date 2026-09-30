'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { ShoppingBag, MapPin, Phone, MessageCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Listing {
  id: string; category: string; title: string; description: string | null; price_pkr: number | null; photo_url: string | null
  location_text: string | null; contact_name: string; contact_mobile: string; contact_whatsapp: string | null
}

const CATEGORIES = ['electronics', 'vehicles', 'animals', 'furniture', 'land', 'agriculture', 'household', 'other']

function fmt(n: number) { return Number(n).toLocaleString() }
function normalizePakPhone(raw: string) {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('0') ? `92${digits.slice(1)}` : digits.startsWith('92') ? digits : `92${digits}`
}

// Phase 2 of the "Village OS" feature set, 2026-09-30 — OLX-style, but
// only for this village and nearby area, same public/self-manage/staff-
// moderate shape as the Jobs board. Deliberately at /classifieds, not
// folded into the existing /marketplace (vehicles/shops/dispatch booking
// system) — a used phone or a cow for sale isn't a booking.
export default function ClassifiedsPage() {
  const { t, isUrdu } = useLocale()
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    createClient().from('classified_listings')
      .select('id, category, title, description, price_pkr, photo_url, location_text, contact_name, contact_mobile, contact_whatsapp')
      .eq('is_active', true).eq('status', 'active').order('created_at', { ascending: false })
      .then(({ data }) => { setListings(data ?? []); setLoading(false) })
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return listings.filter((l) =>
      (!category || l.category === category) &&
      (!q || l.title.toLowerCase().includes(q) || (l.description ?? '').toLowerCase().includes(q))
    )
  }, [listings, category, search])

  return (
    <div className="max-w-[1100px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3"><ShoppingBag size={28} className="text-dp-secondary" /> {t('cl.pageTitle')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2">
          {t('cl.pageIntro')}{' '}
          <Link href="/portal/classifieds" className="text-dp-secondary font-semibold hover:underline">{t('cl.postYourOwn')}</Link>.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 mb-8">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('cl.searchPlaceholder')} className="input-field flex-1 min-w-[200px]" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field w-auto">
          <option value="">{t('x.allCategories')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cl.cat.${c}`)}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant text-center py-16"><LoadingDots /></p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">{t('cl.noneFound')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((l) => (
            <div key={l.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
              <div className="relative w-full aspect-video bg-dp-surface-container">
                {l.photo_url ? (
                  <Image src={l.photo_url} alt="" fill sizes="360px" className="object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-dp-outline"><ShoppingBag size={32} /></div>
                )}
              </div>
              <div className="p-4">
                <span className="text-[10.5px] font-bold px-2.5 py-1 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`cl.cat.${l.category}`)}</span>
                <h3 className="font-sans text-[15.5px] font-semibold text-dp-on-surface mt-2 truncate">{l.title}</h3>
                {l.price_pkr != null && <p className="font-heading text-[17px] font-bold text-dp-primary mt-1 ltr-num">PKR {fmt(l.price_pkr)}</p>}
                {l.location_text && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5 flex items-center gap-1"><MapPin size={12} /> {l.location_text}</p>
                )}
                <div className="flex gap-2 mt-3">
                  <a href={`tel:${l.contact_mobile}`} className="flex-1 flex items-center justify-center gap-1.5 border-2 border-dp-primary text-dp-primary px-3 py-2 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary hover:text-white transition-all">
                    <Phone size={13} /> {t('x.call')}
                  </a>
                  {l.contact_whatsapp && (
                    <a href={`https://wa.me/${normalizePakPhone(l.contact_whatsapp)}`} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-1.5 bg-dp-secondary text-white px-3 py-2 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all">
                      <MessageCircle size={13} /> {t('w.whatsapp')}
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
