'use client'

import { useEffect, useState } from 'react'
import { Droplet, Landmark, HeartHandshake, ShoppingBag, AlertTriangle, CalendarDays, type LucideIcon } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Real ask, 2026-10-05: the hero card's bottom text was just a static
// "Official portal for..." line — dead space advertising nothing. Modeled
// on a reference app design that auto-rotates an announcement card every
// few seconds; here it rotates through what the app actually does, so a
// first-time visitor sees the breadth of real features instead of one
// static sentence.
const SLIDES: { icon: LucideIcon; titleKey: string; descKey: string }[] = [
  { icon: Droplet, titleKey: 'home.payWaterBill', descKey: 'home.featureWaterDesc' },
  { icon: Landmark, titleKey: 'ch.pageTitle', descKey: 'home.featureChandaDesc' },
  { icon: HeartHandshake, titleKey: 'home.requestBlood', descKey: 'home.featureBloodDesc' },
  { icon: ShoppingBag, titleKey: 'cl.pageTitle', descKey: 'home.featureClassifiedsDesc' },
  { icon: AlertTriangle, titleKey: 'cr.pageTitle', descKey: 'home.featureCivicDesc' },
  { icon: CalendarDays, titleKey: 've.pageTitle', descKey: 'home.featureEventsDesc' },
]

export function HomeFeatureCarousel() {
  const { t } = useLocale()
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), 4000)
    return () => clearInterval(id)
  }, [])

  const slide = SLIDES[index]
  const Icon = slide.icon

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="bg-dp-secondary-fixed text-dp-on-secondary-fixed font-bold text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full">
          {t('home.featureBadge')}
        </span>
        <div className="flex gap-1.5">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              onClick={() => setIndex(i)}
              aria-label={`Slide ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-dp-secondary-fixed' : 'w-1.5 bg-white/40'}`}
            />
          ))}
        </div>
      </div>
      <div key={index} className="flex items-start gap-3 min-h-[60px] animate-in fade-in duration-300">
        <span className="shrink-0 w-9 h-9 rounded-lg bg-white/15 flex items-center justify-center text-white mt-0.5">
          <Icon size={18} />
        </span>
        <div>
          <h3 className="font-heading text-[17px] font-bold leading-tight text-white">{t(slide.titleKey)}</h3>
          <p className="text-[13.5px] font-sans text-white/85 leading-[19px] mt-1">{t(slide.descKey)}</p>
        </div>
      </div>
    </div>
  )
}
