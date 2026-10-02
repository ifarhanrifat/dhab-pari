'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Wheat, ShoppingBag, CloudSun, ArrowRight, Bug, Landmark, Building2, Tractor, PawPrint } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Price { id: string; commodity: string; commodity_ur: string | null; price: number; unit: string; category: string }

const categoryLabel: Record<string, string> = { crop: 'ag.cat.crop', input: 'ag.cat.input', livestock_feed: 'ag.cat.livestock_feed' }

// Phase 3 of the "Village OS" feature set, 2026-10-01, expanded 2026-10-02
// into a real hub -- deliberately scoped down from a much bigger proposal
// to four things: crop disease/spray-timing awareness, government scheme
// info, local help-center contacts, and a village tractors/machinery
// directory (the last reusing the existing Directory feature, not a new
// system). No farmer forms, no personal records, no field tracking --
// explicit real ask ("we should not add my form etc").
export default function AgriculturePage() {
  const { t, isUrdu } = useLocale()
  const [prices, setPrices] = useState<Price[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    createClient().from('crop_prices').select('*').order('category').order('display_order').order('commodity')
      .then(({ data }) => { setPrices((data ?? []) as Price[]); setLoading(false) })
  }, [])

  const grouped = prices.reduce<Record<string, Price[]>>((acc, p) => {
    (acc[p.category] ??= []).push(p)
    return acc
  }, {})

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Wheat size={26} className="text-amber-700" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('ag.pageTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('ag.pageIntro')}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
        <Link href="/agriculture/diseases" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all">
          <div className="flex items-center gap-3"><Bug size={20} className="text-amber-700" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('agh.diseasesTitle')}</span></div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
        <Link href="/agriculture/schemes" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all">
          <div className="flex items-center gap-3"><Landmark size={20} className="text-dp-secondary" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('agh.schemesTitle')}</span></div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
        <Link href="/agriculture/help-centers" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all">
          <div className="flex items-center gap-3"><Building2 size={20} className="text-dp-secondary" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('agh.centersTitle')}</span></div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
        <Link href="/agriculture/livestock" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all">
          <div className="flex items-center gap-3"><PawPrint size={20} className="text-amber-700" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('agh.livestockTitle')}</span></div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
        <Link href="/directory?category=machinery" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all">
          <div className="flex items-center gap-3"><Tractor size={20} className="text-dp-secondary" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('agh.machineryPointer')}</span></div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
        <Link href="/classifieds" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all">
          <div className="flex items-center gap-3"><ShoppingBag size={20} className="text-dp-secondary" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('ag.buySellPointer')}</span></div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
        <Link href="/weather" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-all">
          <div className="flex items-center gap-3"><CloudSun size={20} className="text-dp-secondary" /><span className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('ag.weatherPointer')}</span></div>
          <ArrowRight size={16} className="text-dp-secondary shrink-0" />
        </Link>
      </div>

      <h2 className="font-heading text-[20px] font-bold text-dp-on-surface mb-4">{t('ag.priceBoard')}</h2>
      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : prices.length === 0 ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('ag.noneFound')}</p>
      ) : (
        Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} className="mb-6">
            <h3 className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-2">{t(categoryLabel[cat] ?? 'ag.cat.crop')}</h3>
            <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant">
              {items.map((p) => (
                <div key={p.id} className="flex items-center justify-between p-3.5">
                  <span className="font-sans text-[14px] text-dp-on-surface">{isUrdu && p.commodity_ur ? p.commodity_ur : p.commodity}</span>
                  <span className="font-sans text-[14px] font-bold text-dp-on-surface ltr-num">Rs {p.price.toLocaleString()} <span className="font-normal text-dp-on-surface-variant text-[12px]">/ {t(`ag.unit.${p.unit}`)}</span></span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
