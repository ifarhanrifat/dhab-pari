'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface QuickTile {
  emoji: LucideIcon
  label: string
  tint: string
  href?: string
  action?: () => void
}

// Phase 1 correction, 2026-10-12 -- real gap found live on device, twice
// over: (1) these were a static 5-column grid, not the template's single
// continuously auto-scrolling belt; (2) the first fix (reusing the
// shared .ticker-track/-50% CSS class) visibly jumped at the seam every
// loop -- that class is built for plain inline TEXT (AnnouncementBar),
// where the two duplicated halves are trivially identical width. A row
// of 20 flex items, each with its own margin, has no such guarantee --
// any sub-pixel rounding across 40 doubled tiles throws the -50% mark
// off from the true halfway point, and the jump lands exactly there.
// Fixed properly: measure the real rendered pixel width of ONE set via
// a ref, animate with that exact value in a per-instance @keyframes
// rule (not a shared class), so the loop point is always exact
// regardless of how the tiles happen to wrap or round.
export function QuickTilesBelt({ tiles }: { tiles: QuickTile[] }) {
  const { isUrdu } = useLocale()
  const setRef = useRef<HTMLDivElement>(null)
  const [setWidth, setSetWidth] = useState(0)

  useEffect(() => {
    const measure = () => { if (setRef.current) setSetWidth(setRef.current.scrollWidth) }
    measure()
    const ro = new ResizeObserver(measure)
    if (setRef.current) ro.observe(setRef.current)
    return () => ro.disconnect()
  }, [tiles])

  const PX_PER_SEC = 32
  const duration = setWidth > 0 ? setWidth / PX_PER_SEC : 30

  const renderSet = (hidden: boolean) => (
    <div ref={hidden ? undefined : setRef} aria-hidden={hidden || undefined} className="flex" style={{ flex: 'none' }}>
      {tiles.map((tile, i) => {
        const inner = (
          <>
            <span className={`w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 ${tile.tint}`}><tile.emoji size={17} /></span>
            <span className="text-[10.5px] font-semibold text-center leading-tight whitespace-nowrap">{tile.label}</span>
          </>
        )
        const cls = "flex-none w-[84px] mx-1 bg-white border border-dp2-card-border rounded-2xl py-2.5 px-1.5 flex flex-col items-center gap-1.5"
        const key = `${hidden ? 'b' : 'a'}-${i}`
        return tile.href ? (
          <Link key={key} href={tile.href} className={cls} tabIndex={hidden ? -1 : undefined}>{inner}</Link>
        ) : (
          <button key={key} onClick={tile.action} className={`${cls} cursor-pointer`} tabIndex={hidden ? -1 : undefined}>{inner}</button>
        )
      })}
    </div>
  )

  const target = isUrdu ? setWidth : -setWidth

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="-mx-3.5 overflow-hidden">
      {setWidth > 0 && (
        <style>{`@keyframes qtb-scroll { from { transform: translateX(0); } to { transform: translateX(${target}px); } }`}</style>
      )}
      <div
        className="flex"
        style={setWidth > 0 ? { width: 'max-content', animation: `qtb-scroll ${duration}s linear infinite` } : undefined}
      >
        {renderSet(false)}
        {renderSet(true)}
      </div>
    </div>
  )
}
