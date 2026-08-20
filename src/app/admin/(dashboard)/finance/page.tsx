'use client'

import Link from 'next/link'
import { Droplets, Heart, ChevronRight } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export default function TransactionsPickerPage() {
  const { t, isUrdu } = useLocale()
  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('nav.finance')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('y.chooseSystem')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-3xl">
        <Link
          href="/admin/finance/water_supply"
          className="group flex items-center justify-between gap-4 bg-white border border-dp-outline-variant rounded-lg p-6 hover:border-dp-primary hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-dp-primary-container flex items-center justify-center shrink-0">
              <Droplets size={22} className="text-dp-on-primary-container" />
            </div>
            <div>
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('a.waterSupplySystem')}</h2>
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('y.waterVouchers')}</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-dp-on-surface-variant group-hover:text-dp-primary transition-colors shrink-0" />
        </Link>

        <Link
          href="/admin/finance/donors_projects"
          className="group flex items-center justify-between gap-4 bg-white border border-dp-outline-variant rounded-lg p-6 hover:border-dp-primary hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-dp-primary-container flex items-center justify-center shrink-0">
              <Heart size={22} className="text-dp-on-primary-container" />
            </div>
            <div>
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('a.donorsProjects')}</h2>
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('y.donorVouchers')}</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-dp-on-surface-variant group-hover:text-dp-primary transition-colors shrink-0" />
        </Link>
      </div>
    </div>
  )
}
