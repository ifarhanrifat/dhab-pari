'use client'

// One pill in the design's horizontal "what can you do" services belt
// (D.svc in the source file) — emoji + name, tinted background per
// service. Exact shape: rounded-full, 1px border, small bold label.

import Link from 'next/link'

export function MobilityServiceTile({ href, emoji, name, tint }: { href: string; emoji: string; name: string; tint: string }) {
  return (
    <Link href={href} className="shrink-0 flex items-center gap-1 border border-[#e5e2d0] rounded-full px-2.5 py-1 text-[9.5px] font-bold text-[#1e293b] whitespace-nowrap cursor-pointer" style={{ background: tint }}>
      <span>{emoji}</span> {name}
    </Link>
  )
}
