'use client'

import { useEffect, useState } from 'react'
import { Droplet, Landmark, HeartHandshake, ShoppingBag, AlertTriangle, CalendarDays, type LucideIcon } from 'lucide-react'
import { T } from '@/components/i18n/T'

// Real ask, 2026-10-05: the hero card's bottom text was just a static
// "Official portal for..." line — dead space advertising nothing. Rotates
// through what the app actually does instead, so a first-time visitor
// sees the breadth of real features rather than one static sentence.
//
// Rewritten same day: the first pass rendered translated text with plain
// {t(key)}, which showed every Urdu slide truncated at its own start —
// the real cause is bidi, not layout: with no dir="rtl" on the text node,
// the browser lays out the line under the page's inherited ltr direction
// while the script itself is RTL, so an overflowing/clipped line keeps
// the wrong end. <T> is this codebase's existing fix for exactly this
// (see its own comment — "flip the data, not the screen"); every piece of
// rotating text goes through it now instead of a raw t() call. Also added
// min-w-0 on the text flex-child, a real but secondary issue (flex items
// default to min-width:auto, which stops wrapping before the container
// edge regardless of bidi).
const SLIDES: { icon: LucideIcon; titleKey: string; descKey: string }[] = [
  { icon: Droplet, titleKey: 'home.payWaterBill', descKey: 'home.featureWaterDesc' },
  { icon: Landmark, titleKey: 'ch.pageTitle', descKey: 'home.featureChandaDesc' },
  { icon: HeartHandshake, titleKey: 'home.requestBlood', descKey: 'home.featureBloodDesc' },
  { icon: ShoppingBag, titleKey: 'cl.pageTitle', descKey: 'home.featureClassifiedsDesc' },
  { icon: AlertTriangle, titleKey: 'cr.pageTitle', descKey: 'home.featureCivicDesc' },
  { icon: CalendarDays, titleKey: 've.pageTitle', descKey: 'home.featureEventsDesc' },
]

export function HomeFeatureCarousel() {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), 4000)
    return () => clearInterval(id)
  }, [])

  const slide = SLIDES[index]
  const Icon = slide.icon

  return (
    <div className="min-w-0">
      <span className="inline-block bg-dp-secondary-fixed text-dp-on-secondary-fixed font-bold text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full mb-3">
        <T k="home.featureBadge" />
      </span>

      <div key={index} className="flex items-start gap-3 min-h-[56px] animate-in fade-in duration-300">
        <span className="shrink-0 w-11 h-11 rounded-xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center text-white">
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          {/* rtl-text: <T>'s own dir fixes how the characters within the
              text read, not where the text sits in its box — text-align is
              the ancestor's property, per globals.css's own note on this
              exact gap. Without it this line hugs the left edge and
              overflows past the card instead of wrapping flush right. */}
          <h3 className="font-heading text-[16px] font-bold leading-snug text-white break-words rtl-text"><T k={slide.titleKey} /></h3>
          <p className="text-[13px] font-sans text-white/80 leading-[19px] mt-1 break-words rtl-text"><T k={slide.descKey} /></p>
        </div>
      </div>

      <div className="flex gap-1.5 justify-center mt-4">
        {SLIDES.map((_, i) => (
          <button
            key={i}
            onClick={() => setIndex(i)}
            aria-label={`Slide ${i + 1}`}
            className={`h-1.5 rounded-full transition-all cursor-pointer ${i === index ? 'w-5 bg-dp-secondary-fixed' : 'w-1.5 bg-white/35'}`}
          />
        ))}
      </div>
    </div>
  )
}
