'use client'

// Shared shell for the pages rebuilt in the new "Dhab Pari Mobility"
// design (Home + Results so far) — a route group (adds no URL segment)
// so these pages get the new header/bottom-nav while every other
// marketplace page keeps its current chrome untouched until its own
// redesign pass.

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityHeader } from '@/components/mobility/MobilityHeader'
import { MobilityBottomNav } from '@/components/mobility/MobilityBottomNav'

export default function MobilityLayout({ children }: { children: React.ReactNode }) {
  const { isUrdu } = useLocale()
  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="-m-6 md:-m-10 bg-[#F9F9F6] min-h-[calc(100vh-1px)]">
      <MobilityHeader />
      <div className="p-3.5 pb-24">{children}</div>
      <MobilityBottomNav />
    </div>
  )
}
