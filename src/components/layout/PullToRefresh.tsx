'use client'

import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'

const PULL_THRESHOLD = 72
// Rubber-band damping — a 200px drag of the finger only pulls the indicator
// down ~100px, same "it's resisting, not 1:1 dragging" feel iOS/Android's
// own native pull-to-refresh has, instead of the indicator following the
// finger exactly and feeling like it's being torn off the page.
const DAMPING = 0.5
const MAX_PULL = 110

// Real ask: "make this app like when we pull down it should refresh all the
// portal, admin and website" — mounted once in the root layout so it covers
// every surface, not duplicated per layout. A real network reload
// (window.location.reload()), not router.refresh() — the whole point is a
// guaranteed fresh copy of the current page, the same guarantee a pull-to-
// refresh gives on any native app, now that the service worker caches
// nothing this is simply what "reload" already gets you for free.
//
// Only engages from a touchstart where the page is already scrolled to the
// very top (document.scrollingElement), so it never fights an ordinary
// scroll gesture lower on the page — this is a document-level listener, not
// per-layout, so it works the same whether the current page scrolls via the
// <body> (public/admin) or an inner container (nothing here currently uses
// one, but the scrollTop check is what makes that safe either way).
export function PullToRefresh() {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef<number | null>(null)
  const pulling = useRef(false)

  useEffect(() => {
    // No touch gestures to hook on desktop, and nothing to pull to refresh
    // in dev — Turbopack's own fast refresh already does this instantly.
    if (process.env.NODE_ENV !== 'production') return
    if (!('ontouchstart' in window)) return

    const scroller = () => document.scrollingElement || document.documentElement

    const onTouchStart = (e: TouchEvent) => {
      if (refreshing) return
      if (scroller().scrollTop > 0) { startY.current = null; return }
      startY.current = e.touches[0].clientY
      pulling.current = false
    }

    const onTouchMove = (e: TouchEvent) => {
      if (startY.current === null || refreshing) return
      const delta = e.touches[0].clientY - startY.current
      if (delta <= 0) { setPull(0); pulling.current = false; return }
      // Still at the top and actually pulling down, not just a stray touch.
      if (scroller().scrollTop > 0) { startY.current = null; setPull(0); return }
      pulling.current = true
      // Prevent the native overscroll bounce from fighting this gesture —
      // only once we're sure this is a pull (delta > 0), so a normal tap or
      // an upward scroll starting at the top is never hijacked.
      e.preventDefault()
      setPull(Math.min(MAX_PULL, delta * DAMPING))
    }

    const onTouchEnd = () => {
      if (!pulling.current) { startY.current = null; return }
      pulling.current = false
      startY.current = null
      if (pull >= PULL_THRESHOLD) {
        setRefreshing(true)
        // A real network reload — not router.refresh() — so this is a
        // genuine fresh copy of the current page, not whatever the client
        // router still has cached in memory.
        window.location.reload()
      } else {
        setPull(0)
      }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchEnd)
    }
    // pull is read inside onTouchEnd via closure — re-bind whenever it
    // changes so that read is never stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull, refreshing])

  if (pull === 0 && !refreshing) return null

  const progress = Math.min(1, pull / PULL_THRESHOLD)

  return (
    <div
      className="fixed inset-x-0 top-0 z-[90] flex justify-center pointer-events-none"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      aria-hidden="true"
    >
      <div
        className="mt-2 w-9 h-9 rounded-full bg-white shadow-lg flex items-center justify-center transition-transform"
        style={{
          transform: `translateY(${refreshing ? 8 : pull - 36}px)`,
          opacity: refreshing ? 1 : progress,
        }}
      >
        <RotateCw
          size={18}
          className={refreshing ? 'text-dp-secondary animate-spin' : 'text-dp-secondary'}
          style={!refreshing ? { transform: `rotate(${progress * 360}deg)` } : undefined}
        />
      </div>
    </div>
  )
}
