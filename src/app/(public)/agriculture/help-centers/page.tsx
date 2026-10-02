'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Building2, ArrowLeft, Phone, MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Center {
  id: string; name: string; name_ur: string; what_they_offer: string | null; what_they_offer_ur: string | null
  phone: string | null; address: string | null; address_ur: string | null
}

// Phase 3 of the "Village OS" feature set, 2026-10-02. Agriculture
// Extension, OFWM, BARI, Soil & Water Testing Lab -- plain-language "what
// they actually do" cards, not department jargon, with real contact info
// (verified against the live government source at data-entry time, not
// assumed).
export default function AgricultureHelpCentersPage() {
  const { t, isUrdu } = useLocale()
  const [centers, setCenters] = useState<Center[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    createClient().from('ag_help_centers').select('*').order('display_order').order('name')
      .then(({ data }) => { setCenters((data ?? []) as Center[]); setLoading(false) })
  }, [])

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <Link href="/agriculture" className="inline-flex items-center gap-1.5 font-sans text-[13px] text-dp-secondary hover:underline mb-4"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('ag.pageTitle')}</Link>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Building2 size={26} className="text-dp-primary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('agh.centersTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('agh.centersIntro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : centers.length === 0 ? (
        <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('agh.noneFound')}</p>
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
    </div>
  )
}
