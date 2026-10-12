'use client'
import { useRef, useState, type ReactNode } from 'react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Phase 1 of the card-based redesign, 2026-10-12. The swipe/dot carousel
// pattern the new design reuses for every card row (projects, welfare,
// mentors, news, videos, market). One generic wrapper instead of one
// bespoke carousel per section -- each caller just supplies its items
// and a render function; paging/touch/dots all live here once.
//
// Real correction, same day: `transform: translateX()` is a PHYSICAL
// property -- it does not flip under dir="rtl" the way flex ordering and
// margin-inline-start do. The original design template accounts for
// this explicitly (`sign = ur ? 1 : -1`, threaded into both the paging
// transform and the touch-direction check) -- reproduced here rather
// than left as a flex-only "mirror" that would have paged backwards
// under a right-swipe in Urdu.
export function Carousel2<T>({
  items, render, itemWidthClass = 'w-[calc(100%-28px)]',
}: {
  items: T[]
  render: (item: T, index: number) => ReactNode
  itemWidthClass?: string
}) {
  const { isUrdu } = useLocale()
  const sign = isUrdu ? 1 : -1
  const [index, setIndex] = useState(0)
  const touchX = useRef<number | null>(null)
  const len = items.length

  const go = (n: number) => setIndex(((n % len) + len) % len)

  if (len === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div
        dir={isUrdu ? 'rtl' : 'ltr'}
        className="-mx-3.5 overflow-hidden"
        onTouchStart={(e) => { touchX.current = e.touches[0].clientX }}
        onTouchEnd={(e) => {
          if (touchX.current == null) return
          const d = e.changedTouches[0].clientX - touchX.current
          if (Math.abs(d) > 40) go(index + ((d < 0) === (sign < 0) ? 1 : -1))
          touchX.current = null
        }}
      >
        <div
          className="flex items-stretch transition-transform duration-700"
          style={{ transform: `translateX(calc(${sign * index} * (100% - 14px)))`, transitionTimingFunction: 'cubic-bezier(.5,0,.2,1)' }}
        >
          {items.map((item, i) => (
            <div key={i} className={`flex-none ${itemWidthClass} ms-3.5`}>
              {render(item, i)}
            </div>
          ))}
        </div>
      </div>
      {len > 1 && (
        <div className="flex justify-center gap-1.5">
          {items.map((_, i) => (
            <button
              key={i}
              aria-label={`slide ${i + 1}`}
              onClick={() => go(i)}
              className="h-1.5 rounded-full border-[1.5px] border-dp2-primary transition-all cursor-pointer"
              style={{ width: i === index ? '18px' : '6px', background: i === index ? '#005A36' : 'transparent' }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
