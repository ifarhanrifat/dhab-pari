'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Gift, MapPin, CheckCircle2, Wrench } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

/**
 * The Sadqa-e-Jariya board.
 *
 * Thirty working objects with thirty family names on them is the most
 * persuasive page this site will ever have — far more than any appeal, because
 * every entry is a thing somebody can walk past and touch.
 *
 * The "still working" state is shown honestly, including when it isn't. A
 * board that only ever says everything is fine stops being read; one that
 * admits a cooler needs a repair is the reason the next person believes the
 * other twenty-nine.
 */

interface BoardItem {
  object_no: string; item_name: string; item_name_ur: string | null
  dedicated_to: string; dedicated_to_ur: string | null; relationship: string | null
  plaque_text: string | null; plaque_text_ur: string | null
  donor_name: string | null; donor_name_ur: string | null
  location: string | null; installed_on: string | null; status: string
  photo_url: string | null; plaque_photo_url: string | null
}

interface CatalogueItem {
  id: string; name: string; name_ur: string | null
  capital_cost_pkr: number; annual_running_cost_pkr: number
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function SadqaJariyaPage() {
  const { t, isUrdu } = useLocale()
  const [items, setItems] = useState<BoardItem[]>([])
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.rpc('public_sadqa_board'),
      supabase.from('sadqa_catalogue').select('id, name, name_ur, capital_cost_pkr, annual_running_cost_pkr')
        .eq('is_active', true).order('display_order'),
    ]).then(([{ data: board }, { data: cat }]) => {
      setItems((board ?? []) as BoardItem[])
      setCatalogue((cat ?? []) as CatalogueItem[])
      setLoading(false)
    })
  }, [])

  const working = items.filter((i) => ['installed', 'in_service'].includes(i.status)).length

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[44px] text-dp-primary flex items-center gap-3">
          <Gift size={30} className="text-dp-secondary" /> {t('sj.title')}
        </h1>
        <p className="font-sans text-[15px] text-dp-on-surface-variant mt-2 leading-relaxed max-w-2xl">{t('sj.blurb')}</p>
      </div>

      {!loading && items.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-8">
          <div className="bg-white border border-dp-outline-variant rounded-lg px-5 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant">{t('sj.installed')}</p>
            <p className="font-heading text-[26px] font-bold text-dp-primary">{items.length}</p>
          </div>
          <div className="bg-white border border-dp-outline-variant rounded-lg px-5 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant">{t('sj.working')}</p>
            <p className="font-heading text-[26px] font-bold text-emerald-700">{working}</p>
          </div>
        </div>
      )}

      {loading && <p className="font-sans text-dp-on-surface-variant"><LoadingDots /></p>}

      {!loading && items.length === 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center mb-10">
          <p className="font-sans text-[15px] text-dp-on-surface-variant">{t('sj.empty')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-12">
        {items.map((i) => (
          <div key={i.object_no} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
            {i.photo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={i.photo_url} alt="" className="w-full h-44 object-cover" />
            )}
            <div className="p-5">
              <div className="flex items-start justify-between gap-2 mb-2">
                <h2 className="font-heading text-[19px] font-bold text-dp-primary">
                  {isUrdu && i.item_name_ur ? i.item_name_ur : i.item_name}
                </h2>
                {['installed', 'in_service'].includes(i.status) ? (
                  <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold">
                    <CheckCircle2 size={11} /> {t('sj.inService')}
                  </span>
                ) : i.status === 'needs_repair' ? (
                  <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold">
                    <Wrench size={11} /> {t('sj.needsRepair')}
                  </span>
                ) : (
                  <span className="shrink-0 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-bold">{t('sj.retired')}</span>
                )}
              </div>

              {/* The plaque, rendered as a plaque. */}
              {(i.plaque_text || i.plaque_text_ur) && (
                <div className="inline-block px-4 py-2.5 rounded border-[3px] border-dp-outline bg-dp-surface-container-low mb-3">
                  <p className="font-sans text-[12.5px] font-bold tracking-[0.06em] text-center"
                    style={isUrdu && i.plaque_text_ur ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
                    {isUrdu && i.plaque_text_ur ? i.plaque_text_ur : i.plaque_text}
                  </p>
                </div>
              )}

              <p className="font-sans text-[14px] text-dp-on-surface">
                {t('es.inMemoryOf')}{' '}
                <strong style={isUrdu && i.dedicated_to_ur ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
                  {isUrdu && i.dedicated_to_ur ? i.dedicated_to_ur : i.dedicated_to}
                </strong>
              </p>

              {i.donor_name && (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">
                  {t('es.donatedBy')} {isUrdu && i.donor_name_ur ? i.donor_name_ur : i.donor_name}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2.5 font-sans text-[12px] text-dp-on-surface-variant">
                {i.location && <span className="inline-flex items-center gap-1"><MapPin size={12} /> {i.location}</span>}
                {i.installed_on && (
                  <span>{new Date(i.installed_on).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── What it costs to give one ───────────────────────────────────── */}
      {catalogue.length > 0 && (
        <div>
          <h2 className="font-heading text-[24px] font-bold text-dp-primary mb-2">{t('sj.giveOne')}</h2>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-5 max-w-2xl">{t('sj.giveOneHelp')}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {catalogue.map((c) => (
              <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3.5">
                <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">
                  {isUrdu && c.name_ur ? c.name_ur : c.name}
                </p>
                <p className="font-heading text-[20px] font-bold text-dp-primary mt-1">{fmt(c.capital_cost_pkr)}</p>
                {c.annual_running_cost_pkr > 0 && (
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
                    {t('pes.runningCost')} {fmt(c.annual_running_cost_pkr)}/{t('es.year')}
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-5 bg-dp-surface-container-low rounded-lg px-4 py-3.5 max-w-2xl leading-relaxed">
            {t('sj.howToOffer')}
          </p>
        </div>
      )}
    </div>
  )
}
