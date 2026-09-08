'use client'

// A horizontally auto-scrolling "news belt" for a row of filter chips —
// a specific, explicit request: English content scrolls right-to-left,
// Urdu mirrors (left-to-right), matching MarqueeText's own direction
// convention for the same reason (this app deliberately keeps LTR
// layout under Urdu — see LocaleProvider's RTL_READY note — so direction
// has to be chosen explicitly here too, rather than trusted to native
// RTL scrollLeft semantics, which are notoriously inconsistent across
// browsers).
//
// Unlike MarqueeText (a CSS keyframe sliding one text node), these
// children are real, clickable chip buttons, so the same trick doesn't
// apply directly — the row's own content is rendered TWICE back-to-back
// and the scroll position silently wraps by exactly one copy's width
// once it's scrolled a full copy, the standard seamless-loop technique.
// Both copies carry the exact same onClick handlers, so tapping either
// one behaves identically; only one of the pair is ever visible at a
// given moment past the initial position anyway.
//
// Auto-scroll pauses the instant the user touches the row and does NOT
// resume until they interact somewhere else on the page — a plain tap
// on a chip fires pointerdown (pause) immediately followed by its own
// click (resume) with no visible effect, but an actual drag/scroll
// gesture never fires a click afterward, so the pause sticks until the
// next distinct tap or vertical page scroll — exactly "let me actually
// pick one, then start moving again" rather than fighting the user's
// own scroll mid-gesture.
import { useEffect, useRef } from 'react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const SPEED_PX_PER_FRAME = 0.5

export function NewsBeltRow({ children, className }: { children: React.ReactNode; className?: string }) {
  const { isUrdu } = useLocale()
  const trackRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  const initedRef = useRef(false)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    initedRef.current = false
    let raf: number

    const step = () => {
      const half = el.scrollWidth / 2
      if (half > el.clientWidth) {
        // Urdu starts mid-way through so it has room to move backward
        // immediately, mirroring English's forward start at 0 — set
        // once the real (post-layout) scrollWidth is known, not before.
        if (!initedRef.current) {
          if (isUrdu) el.scrollLeft = half
          initedRef.current = true
        }
        if (!pausedRef.current) {
          const dir = isUrdu ? -1 : 1
          let next = el.scrollLeft + dir * SPEED_PX_PER_FRAME
          if (next >= half) next -= half
          if (next < 0) next += half
          el.scrollLeft = next
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [isUrdu])

  useEffect(() => {
    const resume = () => { pausedRef.current = false }
    window.addEventListener('click', resume)
    window.addEventListener('scroll', resume, { passive: true })
    return () => {
      window.removeEventListener('click', resume)
      window.removeEventListener('scroll', resume)
    }
  }, [])

  return (
    <div
      ref={trackRef}
      onPointerDown={() => { pausedRef.current = true }}
      className={`flex items-center overflow-x-auto ${className ?? ''}`}
      style={{ scrollbarWidth: 'none' }}
    >
      {/* Both copies are fully live buttons, not decoration — aria-hidden
          would be a lie here, since either one is clickable at any given
          scroll position. */}
      <div className="flex items-center gap-1.5 shrink-0 pe-1.5">{children}</div>
      <div className="flex items-center gap-1.5 shrink-0">{children}</div>
    </div>
  )
}
