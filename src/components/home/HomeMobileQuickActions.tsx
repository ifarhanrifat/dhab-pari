'use client'

import Link from 'next/link'
import { CreditCard, Newspaper, Droplet } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function HomeMobileQuickActions() {
  const { t } = useLocale()
  return (
    <section className="md:hidden mx-4 mt-6 bg-dp-secondary-container/30 border border-dp-secondary p-6 rounded-lg">
      <h3 className="font-heading text-[20px] font-bold leading-[28px] text-dp-primary mb-4">
        {t('home.quickActions')}
      </h3>
      <div className="flex flex-col gap-3">
        <Link
          href="/water"
          className="w-full bg-dp-primary text-white py-4 px-6 rounded-lg font-sans font-semibold text-[18px] flex items-center justify-between active:scale-[0.98] transition-transform"
        >
          <span>{t('home.payWaterBill')}</span>
          <CreditCard size={20} />
        </Link>
        {/* On a phone the blood card sits far below the fold, under the whole
            main column. Anyone reaching for it is in a hurry, so it goes here. */}
        <Link
          href="/blood"
          className="w-full bg-dp-error text-white py-4 px-6 rounded-lg font-sans font-semibold text-[18px] flex items-center justify-between active:scale-[0.98] transition-transform"
        >
          <span>{t('home.requestBlood')}</span>
          <Droplet size={20} />
        </Link>
        <Link
          href="/news"
          className="w-full bg-white border-2 border-dp-primary text-dp-primary py-4 px-6 rounded-lg font-sans font-semibold text-[18px] flex items-center justify-between active:scale-[0.98] transition-transform"
        >
          <span>{t('home.villageNews')}</span>
          <Newspaper size={20} />
        </Link>
      </div>
    </section>
  )
}
