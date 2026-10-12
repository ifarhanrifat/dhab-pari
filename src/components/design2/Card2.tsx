import type { ReactNode, HTMLAttributes } from 'react'

// Phase 1 of the card-based redesign, 2026-10-12. The plain white
// rounded-16px bordered card shell used throughout the new design --
// most sections still need their own internal layout, so this only
// standardizes the shell every one of them shares.
export function Card2({ children, className = '', ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`bg-white border border-dp2-card-border rounded-2xl shadow-[0_1px_2px_rgba(0,0,0,.04)] ${className}`} {...rest}>
      {children}
    </div>
  )
}
