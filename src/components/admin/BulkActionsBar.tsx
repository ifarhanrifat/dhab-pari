'use client'

import { X } from 'lucide-react'

interface BulkAction {
  label: string
  onClick: () => void
  variant?: 'primary' | 'danger' | 'outline'
}

interface BulkActionsBarProps {
  count: number
  onClear: () => void
  actions: BulkAction[]
}

const variantClasses: Record<string, string> = {
  primary: 'bg-dp-secondary text-white hover:bg-dp-primary',
  danger: 'bg-dp-error text-white hover:opacity-90',
  outline: 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container',
}

export function BulkActionsBar({ count, onClear, actions }: BulkActionsBarProps) {
  if (count === 0) return null

  return (
    <div className="sticky top-0 z-30 mb-4 bg-dp-primary text-white rounded-lg px-4 py-3 flex items-center gap-4 shadow-md">
      <span className="font-sans text-[14px] font-semibold">{count} selected</span>
      <div className="flex items-center gap-2 ms-auto">
        {actions.map((action) => (
          <button
            key={action.label}
            onClick={action.onClick}
            className={`px-3 py-1.5 rounded-lg text-[14px] font-sans font-semibold cursor-pointer transition-all ${variantClasses[action.variant ?? 'primary']}`}
          >
            {action.label}
          </button>
        ))}
        <button
          onClick={onClear}
          className="p-1.5 text-white/80 hover:text-white cursor-pointer"
          aria-label="Clear selection"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  )
}
