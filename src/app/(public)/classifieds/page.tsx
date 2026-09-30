'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { ShoppingBag, MapPin, Phone, MessageCircle, ShieldAlert, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ClassifiedsDisclaimer } from '@/components/public/ClassifiedsDisclaimer'

interface Listing {
  id: string; category: string; title: string; description: string | null; price_pkr: number | null; photo_url: string | null
  location_text: string | null; contact_name: string; contact_mobile: string; contact_whatsapp: string | null
  animal_type: string | null; animal_age_stage: string | null; animal_weight_kg: number | null
  brand: string | null; model: string | null; item_condition: string | null; specifications: string | null
  vehicle_year: number | null; vehicle_mileage_km: number | null
  land_size: number | null; land_size_unit: string | null
}

const CATEGORIES = ['electronics', 'vehicles', 'animals', 'furniture', 'land', 'agriculture', 'household', 'other']
const CONTACT_ACK_KEY = 'dp-classifieds-contact-ack'

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
//
// Category-specific detail line + a contact-confirmation gate added
// 2026-09-30, real ask: the committee is only hosting the listing, not a
// party to the sale — this has to be seen before a call is actually
// placed, not just written somewhere on the page.
export default function ClassifiedsPage() {
  const { t, isUrdu } = useLocale()
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [pendingContact, setPendingContact] = useState<string | null>(null)

  useEffect(() => {
    createClient().from('classified_listings')
      .select(`id, category, title, description, price_pkr, photo_url, location_text, contact_name, contact_mobile, contact_whatsapp,
        animal_type, animal_age_stage, animal_weight_kg, brand, model, item_condition, specifications, vehicle_year, vehicle_mileage_km, land_size, land_size_unit`)
      .eq('is_active', true).eq('status', 'active').order('created_at', { ascending: false })
      .then(({ data }) => { setListings((data ?? []) as Listing[]); setLoading(false) })
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return listings.filter((l) =>
      (!category || l.category === category) &&
      (!q || l.title.toLowerCase().includes(q) || (l.description ?? '').toLowerCase().includes(q))
    )
  }, [listings, category, search])

  const detailLine = (l: Listing): string | null => {
    if (l.category === 'animals') {
      const parts = [l.animal_type && t(`cl.animal.${l.animal_type}`), l.animal_age_stage && t(`cl.ageStage.${l.animal_age_stage}`), l.animal_weight_kg != null && `${fmt(l.animal_weight_kg)} kg`]
      return parts.filter(Boolean).join(' · ') || null
    }
    if (l.category === 'electronics' || l.category === 'vehicles') {
      const parts = [l.brand, l.model, l.vehicle_year, l.item_condition && t(`cl.condition.${l.item_condition}`), l.vehicle_mileage_km != null && `${fmt(l.vehicle_mileage_km)} km`]
      return parts.filter(Boolean).join(' · ') || null
    }
    if (l.category === 'land' && l.land_size != null) {
      return `${fmt(l.land_size)} ${t(`cl.unit.${l.land_size_unit}`)}`
    }
    return null
  }

  // Real ask: seen once before the first call/WhatsApp tap this session,
  // not on every single one after — that would just get reflexively
  // dismissed and stop meaning anything.
  const requestContact = (e: React.MouseEvent, url: string) => {
    if (typeof window !== 'undefined' && sessionStorage.getItem(CONTACT_ACK_KEY)) return
    e.preventDefault()
    setPendingContact(url)
  }
  const confirmContact = () => {
    if (pendingContact) {
      sessionStorage.setItem(CONTACT_ACK_KEY, '1')
      window.open(pendingContact, pendingContact.startsWith('tel:') ? '_self' : '_blank')
    }
    setPendingContact(null)
  }

  const renderCard = (l: Listing) => {
    const detail = detailLine(l)
    return (
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
          {detail && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1 ltr-num">{detail}</p>}
          {l.specifications && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 line-clamp-2">{l.specifications}</p>}
          {l.price_pkr != null && <p className="font-heading text-[17px] font-bold text-dp-primary mt-1 ltr-num">PKR {fmt(l.price_pkr)}</p>}
          {l.location_text && (
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5 flex items-center gap-1"><MapPin size={12} /> {l.location_text}</p>
          )}
          <div className="flex gap-2 mt-3">
            <a href={`tel:${l.contact_mobile}`} onClick={(e) => requestContact(e, `tel:${l.contact_mobile}`)} className="flex-1 flex items-center justify-center gap-1.5 border-2 border-dp-primary text-dp-primary px-3 py-2 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary hover:text-white transition-all">
              <Phone size={13} /> {t('x.call')}
            </a>
            {l.contact_whatsapp && (
              <a href={`https://wa.me/${normalizePakPhone(l.contact_whatsapp)}`} onClick={(e) => requestContact(e, `https://wa.me/${normalizePakPhone(l.contact_whatsapp!)}`)} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-1.5 bg-dp-secondary text-white px-3 py-2 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all">
                <MessageCircle size={13} /> {t('w.whatsapp')}
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[1100px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3"><ShoppingBag size={28} className="text-dp-secondary" /> {t('cl.pageTitle')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2">
          {t('cl.pageIntro')}{' '}
          <Link href="/portal/classifieds" className="text-dp-secondary font-semibold hover:underline">{t('cl.postYourOwn')}</Link>.
        </p>
      </div>

      <ClassifiedsDisclaimer />

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
      ) : category ? (
        // A specific category is already chosen via the filter — a
        // repeated section heading above a single grid would be noise.
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((l) => renderCard(l))}
        </div>
      ) : (
        // "All categories" — real ask, 2026-09-30: grouped into a
        // section per category instead of one undifferentiated grid.
        CATEGORIES.filter((c) => filtered.some((l) => l.category === c)).map((c) => (
          <div key={c} className="mb-8">
            <h2 className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-3">{t(`cl.cat.${c}`)}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.filter((l) => l.category === c).map((l) => renderCard(l))}
            </div>
          </div>
        ))
      )}

      {pendingContact && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPendingContact(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()} dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
            <div className="flex items-start justify-between mb-3">
              <ShieldAlert size={24} className="text-amber-600" />
              <button onClick={() => setPendingContact(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed mb-5">{t('cl.disclaimer')}</p>
            <div className="flex gap-2">
              <button onClick={() => setPendingContact(null)} className="flex-1 border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container-low">{t('cl.cancelBtn')}</button>
              <button onClick={confirmContact} className="flex-1 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary">{t('cl.continueBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
