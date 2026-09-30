'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Image from 'next/image'
import { BookOpen, Phone, MessageCircle, MapPin, Clock, Search } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Entry {
  id: string; category: string; subcategory: string | null; name: string; name_ur: string | null
  description: string | null; description_ur: string | null; location_text: string | null
  phone: string | null; whatsapp_number: string | null; hours_text: string | null; photo_url: string | null
}

const CATEGORIES = ['business', 'health', 'mosque', 'school']
function normalizePakPhone(raw: string) {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('0') ? `92${digits.slice(1)}` : digits.startsWith('92') ? digits : `92${digits}`
}

// Phase 3 of the "Village OS" feature set, 2026-09-30. One page, one
// schema, four sections (Business/Health/Mosques/Schools) — the same
// underlying shape (name/location/contact/hours) instead of four bespoke
// directories. Admin-curated (directory_entries, migration 535), not
// user-submitted — a "find a doctor" listing needs to actually be a real
// doctor, not a self-declared one.
export default function DirectoryPage() {
  const { t, isUrdu } = useLocale()
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('business')
  const [search, setSearch] = useState('')

  useEffect(() => {
    createClient().from('directory_entries')
      .select('id, category, subcategory, name, name_ur, description, description_ur, location_text, phone, whatsapp_number, hours_text, photo_url')
      .eq('is_active', true).order('display_order').order('name')
      .then(({ data }) => { setEntries((data ?? []) as Entry[]); setLoading(false) })
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => e.category === tab && (!q || e.name.toLowerCase().includes(q) || (e.name_ur ?? '').includes(search.trim())))
  }, [entries, tab, search])

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3"><BookOpen size={28} className="text-dp-secondary" /> {t('dir.pageTitle')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2">{t('dir.pageIntro')}</p>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {CATEGORIES.map((c) => (
          <button key={c} onClick={() => setTab(c)} className={`px-5 py-2 rounded-full font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === c ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>
            {t(`dir.cat.${c}`)}
          </button>
        ))}
      </div>

      <div className="relative mb-6 max-w-md">
        <Search size={16} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('dir.searchPlaceholder')}
          className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-dp-outline-variant font-sans text-[14px] focus:outline-none focus:border-dp-secondary" />
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant text-center py-16"><LoadingDots /></p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">{t('dir.noneFound')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {filtered.map((e) => (
            <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex gap-3">
              {e.photo_url ? (
                <div className="relative w-16 h-16 rounded-lg overflow-hidden shrink-0 bg-dp-surface-container">
                  <Image src={e.photo_url} alt="" fill sizes="64px" className="object-cover" />
                </div>
              ) : (
                <div className="w-16 h-16 rounded-lg shrink-0 bg-dp-surface-container flex items-center justify-center text-dp-outline"><BookOpen size={22} /></div>
              )}
              <div className="min-w-0 flex-1">
                {e.subcategory && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`dir.sub.${e.subcategory}`)}</span>}
                <h3 className="font-sans text-[15px] font-bold text-dp-on-surface mt-1 truncate">{isUrdu && e.name_ur ? e.name_ur : e.name}</h3>
                {(isUrdu ? e.description_ur : e.description) && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5 line-clamp-2">{isUrdu ? e.description_ur : e.description}</p>}
                {e.location_text && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><MapPin size={11} /> {e.location_text}</p>}
                {e.hours_text && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1"><Clock size={11} /> {e.hours_text}</p>}
                {(e.phone || e.whatsapp_number) && (
                  <div className="flex gap-2 mt-2">
                    {e.phone && (
                      <a href={`tel:${e.phone.replace(/\s+/g, '')}`} className="flex items-center gap-1 px-2.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-dp-primary transition-all">
                        <Phone size={11} /> {t('ic.call')}
                      </a>
                    )}
                    {e.whatsapp_number && (
                      <a href={`https://wa.me/${normalizePakPhone(e.whatsapp_number)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2.5 py-1.5 bg-[#25D366] text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-[#1ebe5a] transition-all">
                        <MessageCircle size={11} /> {t('ic.whatsappBtn')}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
