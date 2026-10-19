import type { ReactNode } from 'react'

// Mechanical extraction, not a new design decision: negotiations/chat/
// trips/shadi/results already hand-roll this exact pill recipe with these
// exact hex pairs scattered per-screen — this just gives the 7 recurring
// tones names (dp2-status-* tokens, globals.css) so new screens reuse one
// component instead of a ninth copy of the same inline style object.
// Each screen's own status vocabulary (open/collecting/withdrawn/etc.)
// still lives — and gets translated — at the call site; this component
// only owns the visual tone + layout, picked by whichever tone fits.
export type StatusTone = 'requested' | 'quoted' | 'countered' | 'accepted' | 'progress' | 'completed' | 'cancelled'

const TONE_CLASS: Record<StatusTone, string> = {
  requested: 'bg-dp2-status-requested-bg text-dp2-status-requested-fg',
  quoted: 'bg-dp2-status-quoted-bg text-dp2-status-quoted-fg',
  countered: 'bg-dp2-status-countered-bg text-dp2-status-countered-fg',
  accepted: 'bg-dp2-status-accepted-bg text-dp2-status-accepted-fg',
  progress: 'bg-dp2-status-progress-bg text-dp2-status-progress-fg',
  completed: 'bg-dp2-status-completed-bg text-dp2-status-completed-fg',
  cancelled: 'bg-dp2-status-cancelled-bg text-dp2-status-cancelled-fg',
}

interface StatusPillProps {
  tone: StatusTone
  label: string
  icon?: ReactNode
  className?: string
}

export function StatusPill({ tone, label, icon, className = '' }: StatusPillProps) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full ${TONE_CLASS[tone]} ${className}`}>
      {icon}{label}
    </span>
  )
}
