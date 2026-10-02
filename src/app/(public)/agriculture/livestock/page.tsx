'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { PawPrint, ArrowLeft, Clock, ShieldCheck, Phone, MapPin, ShoppingBag } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Guide {
  id: string; animal: string; animal_ur: string; topic_name: string; topic_name_ur: string
  details: string | null; details_ur: string | null; timing: string | null; timing_ur: string | null
  care_tips: string | null; care_tips_ur: string | null
}
interface Center {
  id: string; name: string; name_ur: string; what_they_offer: string | null; what_they_offer_ur: string | null
  phone: string | null; address: string | null; address_ur: string | null
}

// Phase 3 of the "Village OS" feature set, 2026-10-02. Same scope
// discipline as the rest of the hub: health/vaccination/feed awareness and
// real vet contacts, no livestock marketplace or buyer-matching -- buying
// and selling animals already has a real home (Classifieds' 'animals'
// category), linked below instead of duplicated here.
export default function LivestockPage() {
  const { t, isUrdu } = useLocale()
  const [guides, setGuides] = useState<Guide[]>([])
  const [centers, setCenters] = useState<Center[]>([])
  const [loading, setLoading] = useState(true)
  const [activeAnimal, setActiveAnimal] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.from('ag_livestock_guides').select('*').order('animal').order('display_order'),
      supabase.from('ag_help_centers').select('id, name, name_ur, what_they_offer, what_they_offer_ur, phone, address, address_ur').eq('category', 'livestock').order('display_order').order('name'),
    ]).then(([g, c]) => {
      setGuides((g.data ?? []) as Guide[]); setCenters((c.data ?? []) as Center[]); setLoading(false)
    })
  }, [])

  const animals = Array.from(new Set(guides.map((g) => g.animal)))
  const filtered = activeAnimal ? guides.filter((g) => g.animal === activeAnimal) : guides

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <Link href="/agriculture" className="inline-flex items-center gap-1.5 font-sans text-[13px] text-dp-secondary hover:underline mb-4"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('ag.pageTitle')}</Link>
      <div className="flex items-center gap-2.5 mb-1.5">
        <PawPrint size={26} className="text-amber-700" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('agh.livestockTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('agh.livestockIntro')}</p>

      <Link href="/classifieds" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-secondary/30 rounded-lg p-4 mb-6 hover:border-dp-secondary transition-all">
        <div className="flex items-center gap-3"><ShoppingBag size={20} className="text-dp-secondary" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('agh.buySellAnimalsPointer')}</span></div>
      </Link>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : (
        <>
          {animals.length > 1 && (
            <div className="flex flex-wrap gap-2 mb-6">
              <button onClick={() => setActiveAnimal(null)} className={`px-4 py-1.5 rounded-full font-sans text-[13px] font-semibold cursor-pointer transition-all ${!activeAnimal ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>{t('agh.allAnimals')}</button>
              {animals.map((a) => {
                const label = guides.find((g) => g.animal === a)
                return (
                  <button key={a} onClick={() => setActiveAnimal(a)} className={`px-4 py-1.5 rounded-full font-sans text-[13px] font-semibold cursor-pointer transition-all ${activeAnimal === a ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>
                    {isUrdu ? label?.animal_ur : a}
                  </button>
                )
              })}
            </div>
          )}

          {filtered.length === 0 ? (
            <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg mb-8">{t('agh.noneFound')}</p>
          ) : (
            <div className="space-y-4 mb-8">
              {filtered.map((g) => (
                <div key={g.id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{isUrdu ? g.animal_ur : g.animal}</span>
                  <h3 className="font-heading text-[18px] font-bold text-dp-on-surface mt-1.5 mb-3">{isUrdu ? g.topic_name_ur : g.topic_name}</h3>
                  {(isUrdu ? g.details_ur : g.details) && (
                    <div className="mb-3">
                      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-1">{t('agh.detailsLabel')}</p>
                      <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed">{isUrdu ? g.details_ur : g.details}</p>
                    </div>
                  )}
                  {(isUrdu ? g.timing_ur : g.timing) && (
                    <div className="flex gap-2.5 mb-3">
                      <Clock size={16} className="text-sky-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-1">{t('agh.timingLabel')}</p>
                        <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed">{isUrdu ? g.timing_ur : g.timing}</p>
                      </div>
                    </div>
                  )}
                  {(isUrdu ? g.care_tips_ur : g.care_tips) && (
                    <div className="flex gap-2.5">
                      <ShieldCheck size={16} className="text-emerald-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-1">{t('agh.careTipsLabel')}</p>
                        <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed">{isUrdu ? g.care_tips_ur : g.care_tips}</p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <h2 className="font-heading text-[20px] font-bold text-dp-on-surface mb-4">{t('agh.centersTitle')}</h2>
          {centers.length === 0 ? (
            <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('agh.noneFound')}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {centers.map((c) => (
                <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
                  <h3 className="font-heading text-[16px] font-bold text-dp-on-surface mb-1.5">{isUrdu ? c.name_ur : c.name}</h3>
                  {(isUrdu ? c.what_they_offer_ur : c.what_they_offer) && <p className="font-sans text-[13.5px] text-dp-on-surface-variant leading-relaxed mb-3">{isUrdu ? c.what_they_offer_ur : c.what_they_offer}</p>}
                  {c.address && <p className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-start gap-1.5 mb-1.5"><MapPin size={13} className="shrink-0 mt-0.5" /> {isUrdu && c.address_ur ? c.address_ur : c.address}</p>}
                  {c.phone && (
                    <a href={`tel:${c.phone.replace(/\s+/g, '')}`} className="inline-flex items-center gap-1.5 mt-1 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-primary transition-all">
                      <Phone size={12} /> <span className="ltr-num">{c.phone}</span>
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
