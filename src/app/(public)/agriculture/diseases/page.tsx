'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Bug, ArrowLeft, Droplets, ShieldCheck } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Guide {
  id: string; crop: string; crop_ur: string; disease_name: string; disease_name_ur: string
  symptoms: string | null; symptoms_ur: string | null; spray_timing: string | null; spray_timing_ur: string | null
  prevention: string | null; prevention_ur: string | null
}

// Phase 3 of the "Village OS" feature set, 2026-10-02. Pure awareness
// content -- symptoms, spray timing, prevention -- admin-curated, never a
// photo-upload diagnosis tool. A real crop problem still goes to an actual
// Agriculture Extension officer (see /agriculture/help-centers), the same
// restraint the original feature request itself asked for.
export default function CropDiseasesPage() {
  const { t, isUrdu } = useLocale()
  const [guides, setGuides] = useState<Guide[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCrop, setActiveCrop] = useState<string | null>(null)

  useEffect(() => {
    createClient().from('ag_disease_guides').select('*').order('crop').order('display_order')
      .then(({ data }) => { setGuides((data ?? []) as Guide[]); setLoading(false) })
  }, [])

  const crops = Array.from(new Set(guides.map((g) => g.crop)))
  const filtered = activeCrop ? guides.filter((g) => g.crop === activeCrop) : guides

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <Link href="/agriculture" className="inline-flex items-center gap-1.5 font-sans text-[13px] text-dp-secondary hover:underline mb-4"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('ag.pageTitle')}</Link>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Bug size={26} className="text-amber-700" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('agh.diseasesTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('agh.diseasesIntro')}</p>

      {crops.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-6">
          <button onClick={() => setActiveCrop(null)} className={`px-4 py-1.5 rounded-full font-sans text-[13px] font-semibold cursor-pointer transition-all ${!activeCrop ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>{t('agh.allCrops')}</button>
          {crops.map((c) => {
            const label = guides.find((g) => g.crop === c)
            return (
              <button key={c} onClick={() => setActiveCrop(c)} className={`px-4 py-1.5 rounded-full font-sans text-[13px] font-semibold cursor-pointer transition-all ${activeCrop === c ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>
                {isUrdu ? label?.crop_ur : c}
              </button>
            )
          })}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : filtered.length === 0 ? (
        <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('agh.noneFound')}</p>
      ) : (
        <div className="space-y-4">
          {filtered.map((g) => (
            <div key={g.id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
              <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{isUrdu ? g.crop_ur : g.crop}</span>
              <h3 className="font-heading text-[18px] font-bold text-dp-on-surface mt-1.5 mb-3">{isUrdu ? g.disease_name_ur : g.disease_name}</h3>
              {(isUrdu ? g.symptoms_ur : g.symptoms) && (
                <div className="mb-3">
                  <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-1">{t('agh.symptomsLabel')}</p>
                  <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed">{isUrdu ? g.symptoms_ur : g.symptoms}</p>
                </div>
              )}
              {(isUrdu ? g.spray_timing_ur : g.spray_timing) && (
                <div className="flex gap-2.5 mb-3">
                  <Droplets size={16} className="text-sky-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-1">{t('agh.sprayTimingLabel')}</p>
                    <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed">{isUrdu ? g.spray_timing_ur : g.spray_timing}</p>
                  </div>
                </div>
              )}
              {(isUrdu ? g.prevention_ur : g.prevention) && (
                <div className="flex gap-2.5">
                  <ShieldCheck size={16} className="text-emerald-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-1">{t('agh.preventionLabel')}</p>
                    <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed">{isUrdu ? g.prevention_ur : g.prevention}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
