'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Image from 'next/image'
import Link from 'next/link'
import { BookOpen, Phone, MessageCircle, MapPin, Clock, Search, Store, ArrowRight, Navigation, Info } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Entry {
  id: string; category: string; subcategory: string | null; name: string; name_ur: string | null
  description: string | null; description_ur: string | null; location_text: string | null
  phone: string | null; whatsapp_number: string | null; hours_text: string | null; photo_url: string | null
  admission_status: string | null; fee_per_month: number | null; current_students_count: number | null; teacher_qualifications: string | null
  fajr_time: string | null; zuhr_time: string | null; asr_time: string | null; maghrib_time: string | null; isha_time: string | null; jumma_time: string | null
}

const CATEGORIES = ['business', 'health', 'mosque', 'school', 'machinery']
const fmtTime = (t: string | null) => {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}
function normalizePakPhone(raw: string) {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('0') ? `92${digits.slice(1)}` : digits.startsWith('92') ? digits : `92${digits}`
}
// Same technique as the source doctors-directory file this data came
// from: a plain Google Maps *search* URL, not an embedded map -- no API
// key, no billing, works for any public web page.
function mapsSearchUrl(name: string, location: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${location}`)}`
}

// Phase 3 of the "Village OS" feature set, 2026-09-30. One page, one
// schema, four sections (Business/Health/Mosques/Schools) — the same
// underlying shape (name/location/contact/hours) instead of four bespoke
// directories. Admin-curated (directory_entries, migration 535), not
// user-submitted — a "find a doctor" listing needs to actually be a real
// doctor, not a self-declared one.
export default function DirectoryPage() {
  const { t, isUrdu } = useLocale()
  const searchParams = useSearchParams()
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  // Lets the Agriculture hub deep-link straight into the machinery tab
  // (/directory?category=machinery) instead of landing on "business" and
  // making someone click again.
  const initialCategory = searchParams.get('category')
  const [tab, setTab] = useState(initialCategory && CATEGORIES.includes(initialCategory) ? initialCategory : 'business')
  const [search, setSearch] = useState('')
  // Independent of search -- e.g. "all Health entries" vs "just
  // gynaecologists within Health". Resets whenever the main category tab
  // changes, same as the Agriculture/Projects pages' own filter pattern.
  const [subFilter, setSubFilter] = useState<string | null>(null)
  const changeTab = (c: string) => { setTab(c); setSubFilter(null) }

  useEffect(() => {
    createClient().from('directory_entries')
      .select('id, category, subcategory, name, name_ur, description, description_ur, location_text, phone, whatsapp_number, hours_text, photo_url, admission_status, fee_per_month, current_students_count, teacher_qualifications, fajr_time, zuhr_time, asr_time, maghrib_time, isha_time, jumma_time')
      .eq('is_active', true).order('display_order').order('name')
      .then(({ data }) => { setEntries((data ?? []) as Entry[]); setLoading(false) })
  }, [])

  const inTab = useMemo(() => entries.filter((e) => e.category === tab), [entries, tab])
  // Only worth showing a subcategory row when the category actually has
  // more than one in use -- Mosques, for instance, never will.
  const subcategoriesPresent = useMemo(
    () => Array.from(new Set(inTab.map((e) => e.subcategory).filter((s): s is string => !!s))),
    [inTab]
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inTab.filter((e) =>
      (!subFilter || e.subcategory === subFilter)
      && (!q || e.name.toLowerCase().includes(q) || (e.name_ur ?? '').includes(search.trim()) || (e.description ?? '').toLowerCase().includes(q))
    )
  }, [inTab, subFilter, search])

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3"><BookOpen size={28} className="text-dp-secondary" /> {t('dir.pageTitle')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2">{t('dir.pageIntro')}</p>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {CATEGORIES.map((c) => (
          <button key={c} onClick={() => changeTab(c)} className={`px-5 py-2 rounded-full font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === c ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>
            {t(`dir.cat.${c}`)}
          </button>
        ))}
      </div>

      {subcategoriesPresent.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-6 -mt-3">
          <button onClick={() => setSubFilter(null)} className={`px-3.5 py-1.5 rounded-full font-sans text-[12.5px] font-semibold cursor-pointer transition-all ${!subFilter ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container-low text-dp-on-surface-variant hover:bg-dp-surface-container'}`}>
            {t('dir.allSubcategories')}
          </button>
          {subcategoriesPresent.map((s) => (
            <button key={s} onClick={() => setSubFilter(s)} className={`px-3.5 py-1.5 rounded-full font-sans text-[12.5px] font-semibold cursor-pointer transition-all ${subFilter === s ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container-low text-dp-on-surface-variant hover:bg-dp-surface-container'}`}>
              {t(`dir.sub.${s}`)}
            </button>
          ))}
        </div>
      )}

      {tab === 'health' && (
        <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-6 max-w-2xl">
          <Info size={15} className="text-dp-on-surface-variant shrink-0 mt-0.5" />
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('dir.healthDisclaimer')}</p>
        </div>
      )}

      <div className="relative mb-6 max-w-md">
        <Search size={16} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('dir.searchPlaceholder')}
          className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-dp-outline-variant font-sans text-[14px] focus:outline-none focus:border-dp-secondary" />
      </div>

      {/* Real correction, 2026-10-01: general/kiryana stores already have
          a full public section in Marketplace (real product catalog,
          search, online ordering) -- pointing there instead of trying to
          list the same shops here a second time with less detail. */}
      {tab === 'business' && (
        <Link href="/marketplace" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-secondary/30 rounded-lg p-4 mb-6 hover:border-dp-secondary transition-all max-w-2xl">
          <div className="flex items-center gap-3">
            <Store size={20} className="text-dp-secondary" />
            <span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('dir.generalStorePointer')}</span>
          </div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
      )}

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
                {e.category === 'school' && (
                  <div className="mt-1.5 space-y-0.5">
                    {e.admission_status && (
                      <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${e.admission_status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {t(e.admission_status === 'open' ? 'dir.admissionOpen' : 'dir.admissionClosed')}
                      </span>
                    )}
                    {e.fee_per_month != null && <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('dir.feePerMonth')}: <span className="ltr-num">Rs {e.fee_per_month.toLocaleString()}</span></p>}
                    {e.current_students_count != null && <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('dir.currentStudents')}: <span className="ltr-num">{e.current_students_count}</span></p>}
                    {e.teacher_qualifications && <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('dir.teacherQualifications')}: {e.teacher_qualifications}</p>}
                  </div>
                )}
                {e.category === 'mosque' && (e.fajr_time || e.zuhr_time || e.asr_time || e.maghrib_time || e.isha_time || e.jumma_time) && (
                  <div className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-0.5 font-sans text-[11px] text-dp-on-surface-variant ltr-num">
                    {e.fajr_time && <span>{t('dir.fajr')}: {fmtTime(e.fajr_time)}</span>}
                    {e.zuhr_time && <span>{t('dir.zuhr')}: {fmtTime(e.zuhr_time)}</span>}
                    {e.asr_time && <span>{t('dir.asr')}: {fmtTime(e.asr_time)}</span>}
                    {e.maghrib_time && <span>{t('dir.maghrib')}: {fmtTime(e.maghrib_time)}</span>}
                    {e.isha_time && <span>{t('dir.isha')}: {fmtTime(e.isha_time)}</span>}
                    {e.jumma_time && <span>{t('dir.jumma')}: {fmtTime(e.jumma_time)}</span>}
                  </div>
                )}
                {(e.phone || e.whatsapp_number || e.location_text) && (
                  <div className="flex gap-2 mt-2 flex-wrap">
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
                    {e.location_text && (
                      <a href={mapsSearchUrl(e.name, e.location_text)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2.5 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[11.5px] font-semibold hover:border-dp-secondary hover:text-dp-secondary transition-all">
                        <Navigation size={11} /> {t('dir.viewOnMap')}
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
