'use client'

import { X } from 'lucide-react'

/**
 * A bottom-sheet filter panel — slides up from the bottom on a phone,
 * centers as a small modal on a wider screen. Replaces the old always-open
 * inline filter bar (a wall of labeled fields that wrapped badly under
 * ~640px) with the pattern already familiar from other finance apps: a
 * compact trigger on the main screen, the actual filtering done in one
 * focused sheet.
 *
 * Every field inside is the site's own component (SearchableField for any
 * dropdown, plain date inputs, DateRangePillGroup below) — never a native
 * <select>, which on a phone renders as the OS's own dark/black picker
 * regardless of the page's own white theme.
 */
export function FilterSheet({ open, title, onClose, onApply, applyLabel, children }: {
  open: boolean
  title: string
  onClose: () => void
  onApply: () => void
  applyLabel: string
  children: React.ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 bg-black/50 z-[130] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[88vh] flex flex-col animate-[slideUp_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-center relative px-4 py-4 border-b border-dp-outline-variant shrink-0">
          <h2 className="font-sans text-[16px] font-bold text-dp-on-surface">{title}</h2>
          <button onClick={onClose} className="absolute end-4 top-1/2 -translate-y-1/2 p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {children}
        </div>
        <div className="p-4 border-t border-dp-outline-variant shrink-0">
          <button
            onClick={onApply}
            className="w-full py-3 bg-dp-secondary text-white rounded-lg font-sans text-[15px] font-bold hover:bg-dp-primary transition-all cursor-pointer"
          >
            {applyLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A labeled section inside the sheet — consistent spacing/typography for
 *  whatever field(s) it wraps (a pill row, a SearchableField, a date pair). */
export function FilterSheetSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant mb-2">{label}</p>
      {children}
    </div>
  )
}

/** The Today / This Week / This Month / ... row of pills. */
export function DateRangePillGroup({ options, active, onSelect }: {
  options: { key: string; label: string }[]
  active: string
  onSelect: (key: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onSelect(o.key)}
          className={`px-4 py-2 rounded-full font-sans text-[13.5px] font-semibold transition-all cursor-pointer border ${
            active === o.key
              ? 'bg-dp-secondary-container border-dp-secondary text-dp-primary'
              : 'bg-dp-surface-container-low border-transparent text-dp-on-surface-variant hover:bg-dp-surface-container'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
