import type { ReactNode } from 'react'

// The mockup's one consistent "nothing here" treatment: a dashed box,
// no illustration, one muted line. Every portal screen today hand-rolls
// its own version of this — this is that pattern, named once.
interface EmptyStateProps {
  emoji?: string
  message: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ emoji, message, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`dp2-empty-state p-5 text-center flex flex-col items-center gap-2 ${className}`}>
      {emoji && <span className="text-[22px]">{emoji}</span>}
      <p className="font-sans text-[12.5px] text-dp2-text-faint">{message}</p>
      {action}
    </div>
  )
}
