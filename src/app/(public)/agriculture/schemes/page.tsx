'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Landmark, ArrowLeft, ExternalLink, ShieldCheck } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Scheme {
  id: string; title: string; title_ur: string; description: string | null; description_ur: string | null
  department: string | null; eligibility: string | null; eligibility_ur: string | null; amount: string | null
  districts: string | null; status: string; deadline: string | null; official_url: string | null; last_verified_at: string
}

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-emerald-100 text-emerald-700',
  upcoming: 'bg-blue-100 text-blue-700',
  closed: 'bg-dp-surface-container-high text-dp-on-surface-variant',
}

// Phase 3 of the "Village OS" feature set, 2026-10-02. Admin-entered, not
// scraped -- see the real reasoning in this commit's migration: with a
// mandatory human-verification step either way, a scraper mainly saves
// typing a title, not judgment. "Last verified" is the field that matters
// most here, not an automated feed.
export default function AgricultureSchemesPage() {
  const { t, isUrdu } = useLocale()
  const [schemes, setSchemes] = useState<Scheme[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)

  useEffect(() => {
    createClient().from('ag_schemes').select('*').order('display_order').order('created_at', { ascending: false })
      .then(({ data }) => { setSchemes((data ?? []) as Scheme[]); setLoading(false) })
  }, [])

  const filtered = statusFilter ? schemes.filter((s) => s.status === statusFilter) : schemes

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <Link href="/agriculture" className="inline-flex items-center gap-1.5 font-sans text-[13px] text-dp-secondary hover:underline mb-4"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('ag.pageTitle')}</Link>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Landmark size={26} className="text-dp-primary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('agh.schemesTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('agh.schemesIntro')}</p>

      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={() => setStatusFilter(null)} className={`px-4 py-1.5 rounded-full font-sans text-[13px] font-semibold cursor-pointer transition-all ${!statusFilter ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>{t('agh.allCrops')}</button>
        {['open', 'upcoming', 'closed'].map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} className={`px-4 py-1.5 rounded-full font-sans text-[13px] font-semibold cursor-pointer transition-all ${statusFilter === s ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>{t(`agh.status.${s}`)}</button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : filtered.length === 0 ? (
        <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('agh.noneFound')}</p>
      ) : (
        <div className="space-y-4">
          {filtered.map((s) => (
            <div key={s.id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full uppercase ${STATUS_STYLE[s.status]}`}>{t(`agh.status.${s.status}`)}</span>
                {s.deadline && <span className="font-sans text-[12px] text-dp-on-surface-variant">{t('agh.deadline')}: <span className="ltr-num">{s.deadline}</span></span>}
              </div>
              <h3 className="font-heading text-[18px] font-bold text-dp-on-surface mb-1.5">{isUrdu ? s.title_ur : s.title}</h3>
              {(isUrdu ? s.description_ur : s.description) && <p className="font-sans text-[14px] text-dp-on-surface-variant leading-relaxed mb-3">{isUrdu ? s.description_ur : s.description}</p>}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 mb-3">
                {s.amount && (
                  <div>
                    <p className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide">{t('agh.amount')}</p>
                    <p className="font-sans text-[13.5px] text-dp-on-surface">{s.amount}</p>
                  </div>
                )}
                {s.districts && (
                  <div>
                    <p className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide">{t('agh.districts')}</p>
                    <p className="font-sans text-[13.5px] text-dp-on-surface">{s.districts}</p>
                  </div>
                )}
                {(isUrdu ? s.eligibility_ur : s.eligibility) && (
                  <div className="sm:col-span-2">
                    <p className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide">{isUrdu ? t('agh.eligibilityUr') : t('agh.eligibilityEn')}</p>
                    <p className="font-sans text-[13.5px] text-dp-on-surface">{isUrdu ? s.eligibility_ur : s.eligibility}</p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap pt-3 border-t border-dp-outline-variant">
                <span className="flex items-center gap-1.5 font-sans text-[11.5px] text-dp-on-surface-variant">
                  <ShieldCheck size={13} className="text-emerald-600" /> {t('agh.lastVerified')}: <span className="ltr-num">{s.last_verified_at}</span>
                </span>
                {s.official_url && (
                  <a href={s.official_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline">
                    {t('agh.officialSource')} <ExternalLink size={12} />
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
