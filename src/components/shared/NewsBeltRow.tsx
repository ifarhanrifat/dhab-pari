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
//
// Dragging is handled entirely by hand via Pointer Events (mouse, touch,
// and pen all fire the same events) rather than leaning on the browser's
// native touch-scroll — two real bugs that shipped otherwise: (1) a
// mouse has no native "click and drag to pan" gesture at all, so hiding
// the scrollbar (for the belt look) left a desktop user with no way to
// move it manually whatsoever; (2) at the first call site this sits next
// to a pinned "All" chip in a flex row with nothing telling this element
// it's allowed to be narrower than its own (doubled) content — a flex
// item's default min-width is its content size, so it just grew to fit
// everything instead of ever overflowing, which is also exactly why the
// auto-scroll never did anything: half > clientWidth was never true.
// flex-1 min-w-0 at that call site fixes that half of it.
//
// A third, deeper bug shipped even after both of those were fixed: the
// step below used to read el.scrollLeft back and increment THAT every
// frame. Most browsers round scrollLeft to a whole pixel on write —
// writing 0.5 reads back as 0 — so accumulating 0.5px/frame off the
// DOM's own rounded value never went anywhere; every frame started over
// from the same truncated 0 and the belt visibly never moved at all.
// posRef now tracks the true (fractional) position entirely in JS and
// only ever writes it out to scrollLeft — the DOM can round the display
// however it likes, the accumulation itself never round-trips through
// it, so real pixel-by-pixel movement shows up once posRef has actually
// advanced far enough, same as it would in a canvas or CSS transform.
//
// Auto-scroll pauses the instant a drag starts and does NOT resume until
// the user interacts somewhere else on the page — a plain tap moves the
// pointer less than the click threshold below, so its own trailing click
// still fires and un-pauses immediately with no visible effect, but a
// real drag suppresses that click entirely (see onClickCapture), so the
// pause sticks until the next distinct tap or vertical page scroll.
import { useEffect, useRef } from 'react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const SPEED_PX_PER_FRAME = 0.8
const DRAG_THRESHOLD_PX = 6

export function NewsBeltRow({ children, className }: { children: React.ReactNode; className?: string }) {
  const { isUrdu } = useLocale()
  const trackRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  const initedRef = useRef(false)
  const posRef = useRef(0)

  const draggingRef = useRef(false)
  const draggedRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartScrollRef = useRef(0)

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
          posRef.current = isUrdu ? half : 0
          el.scrollLeft = posRef.current
          initedRef.current = true
        }
        // A manual drag (see onPointerMove) moves scrollLeft directly —
        // resync our own tracked position to it so auto-scroll picks up
        // exactly where the drag left off instead of snapping back.
        if (draggingRef.current) {
          posRef.current = el.scrollLeft
        } else if (!pausedRef.current) {
          const dir = isUrdu ? -1 : 1
          let next = posRef.current + dir * SPEED_PX_PER_FRAME
          if (next >= half) next -= half
          if (next < 0) next += half
          posRef.current = next
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
      onPointerDown={(e) => {
        pausedRef.current = true
        draggingRef.current = true
        draggedRef.current = false
        dragStartXRef.current = e.clientX
        dragStartScrollRef.current = trackRef.current?.scrollLeft ?? 0
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current || !trackRef.current) return
        const dx = e.clientX - dragStartXRef.current
        if (Math.abs(dx) > DRAG_THRESHOLD_PX) draggedRef.current = true
        // Content follows the pointer, same as a native touch-scroll.
        trackRef.current.scrollLeft = dragStartScrollRef.current - dx
      }}
      onPointerUp={() => { draggingRef.current = false }}
      onPointerCancel={() => { draggingRef.current = false }}
      onClickCapture={(e) => {
        // A real drag's own trailing click is swallowed here — before it
        // can either select a chip it was never meant to select, or
        // bubble to the window listener above and immediately cancel the
        // pause this same drag just earned.
        if (draggedRef.current) { e.preventDefault(); e.stopPropagation() }
      }}
      className={`flex items-center overflow-x-auto cursor-grab active:cursor-grabbing select-none ${className ?? ''}`}
      style={{ scrollbarWidth: 'none', touchAction: 'none' }}
    >
      {/* Both copies are fully live buttons, not decoration — aria-hidden
          would be a lie here, since either one is clickable at any given
          scroll position. */}
      <div className="flex items-center gap-1.5 shrink-0 pe-1.5">{children}</div>
      <div className="flex items-center gap-1.5 shrink-0">{children}</div>
    </div>
  )
}
