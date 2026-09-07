'use client'

// A real, specific complaint: product names/labels in narrow cards
// (My Stock grid, the catalog tick-list, the counter-sale bill) were
// getting cut off with an ellipsis, with no way to read the rest short
// of widening the whole layout. Rather than truncate, text that doesn't
// fit its box scrolls fully into view on a loop — direction matched to
// how each script is actually read (see globals.css's own keyframes
// comment): English flows right-to-left like a news ticker, Urdu
// mirrors that. Text that already fits its box never animates at all —
// this only ever kicks in once it's genuinely too long to read otherwise.
import { useEffect, useRef, useState } from 'react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function MarqueeText({ text, className }: { text: string; className?: string }) {
  const { isUrdu } = useLocale()
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [duration, setDuration] = useState(8)

  useEffect(() => {
    const measure = () => {
      if (!containerRef.current || !textRef.current) return
      const over = textRef.current.scrollWidth > containerRef.current.clientWidth + 1
      setOverflowing(over)
      // Roughly constant reading speed regardless of how long the text
      // is — a one-word label and a long brand+flavor name shouldn't
      // both take the same 8s to scroll past.
      if (over) setDuration(Math.max(4, textRef.current.scrollWidth / 35))
    }
    measure()
    if (!containerRef.current) return
    const ro = new ResizeObserver(measure)
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [text])

  return (
    <div ref={containerRef} className={`overflow-hidden whitespace-nowrap ${className ?? ''}`}>
      <span
        ref={textRef}
        className={`inline-block ${overflowing ? '' : 'truncate max-w-full align-bottom'} marquee-text-scroll`}
        style={overflowing ? { animation: `${isUrdu ? 'marquee-ltr' : 'marquee-rtl'} ${duration}s linear infinite` } : undefined}
      >
        {text}
      </span>
    </div>
  )
}
