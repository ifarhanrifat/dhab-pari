'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Briefcase, MapPin, Phone, MessageCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Listing {
  id: string; category: string; headline: string; description: string | null; sector: string | null
  contact_name: string; contact_mobile: string; contact_whatsapp: string | null
}

const CATEGORIES = ['plumber', 'electrician', 'mason', 'carpenter', 'painter', 'laborer', 'driver', 'tailor', 'cook', 'tutor', 'mechanic', 'other']

function normalizePakPhone(raw: string) {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('0') ? `92${digits.slice(1)}` : digits.startsWith('92') ? digits : `92${digits}`
}

export default function JobsPage() {
  const { t, isUrdu } = useLocale()
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    createClient().from('job_listings').select('id, category, headline, description, sector, contact_name, contact_mobile, contact_whatsapp')
      .eq('is_active', true).order('created_at', { ascending: false })
      .then(({ data }) => { setListings(data ?? []); setLoading(false) })
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return listings.filter((l) =>
      (!category || l.category === category) &&
      (!q || l.headline.toLowerCase().includes(q) || (l.description ?? '').toLowerCase().includes(q) || (l.sector ?? '').toLowerCase().includes(q))
    )
  }, [listings, category, search])

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="mb-8">
        <h1 className={`font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3 ${isUrdu ? 'flex-row-reverse' : ''}`}><Briefcase size={28} className="text-dp-secondary" /> {t('home.jobBoard')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2" dir={isUrdu ? 'rtl' : 'ltr'}>
          {t('x.jobBoardIntro')}{' '}
          <Link href="/portal/post-job" className="text-dp-secondary font-semibold hover:underline">{t('x.postOwnListing')}</Link>.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 mb-8">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('x.searchListings')} className="input-field flex-1 min-w-[200px]" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field w-auto">
          <option value="">{t('x.allCategories')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant text-center py-16"><LoadingDots /></p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">{t('x.noListingsFound')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((l) => (
            <div key={l.id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
              <span className="text-[10.5px] font-bold px-2.5 py-1 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{l.category}</span>
              <h3 className="font-sans text-[17px] font-semibold text-dp-on-surface mt-2">{l.headline}</h3>
              {l.description && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-[20px]">{l.description}</p>}
              <p className="font-sans text-[13px] text-dp-on-surface-variant mt-2">{l.contact_name}{l.sector && (
                <span className="inline-flex items-center gap-1 ms-2"><MapPin size={12} /> {l.sector}</span>
              )}</p>
              <div className="flex gap-2 mt-4">
                <a href={`tel:${l.contact_mobile}`} className="flex-1 flex items-center justify-center gap-2 border-2 border-dp-primary text-dp-primary px-4 py-2 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary hover:text-white transition-all">
                  <Phone size={14} /> {t('x.call')}
                </a>
                {l.contact_whatsapp && (
                  <a href={`https://wa.me/${normalizePakPhone(l.contact_whatsapp)}`} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-2 bg-dp-secondary text-white px-4 py-2 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">
                    <MessageCircle size={14} /> {t('w.whatsapp')}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
