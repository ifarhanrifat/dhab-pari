'use client'

// The mockup's real wedding-fleet picking mechanism (`.design_ref`'s own
// `wcats`/`d.wcat` state, confirmed against the literal source — category
// cards, each collapsed by default showing "{available} available /
// {total} · from Rs{min}" and a ▼/▲ toggle; tapping one expands it
// in-place into that category's own vehicle grid, collapsing whichever
// other category was open). Shadi and Car Rental both need exactly this
// same mechanism, just with different vehicle-tile content — this
// component owns only the category-card chrome + single-open-at-a-time
// accordion state; each category's actual vehicle grid is handed in as
// `children`, rendered by the page that already knows how to draw its
// own vehicle tiles.
import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

export interface CategoryDef {
  key: string
  emoji: string
  name: string
  vehicleCount: number
  fromPricePkr: number | null
  selectedCount: number
  children: ReactNode
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function CategoryVehiclePicker({ categories, availableLabel, fromLabel }: { categories: CategoryDef[]; availableLabel: string; fromLabel: string }) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-2">
      {categories.map((c) => {
        const isOpen = open === c.key
        return (
          <div key={c.key} className="rounded-2xl border-2 overflow-hidden transition-colors" style={{ borderColor: isOpen ? '#f9a8d4' : '#e5e2d0', background: isOpen ? '#fdf2f8' : '#fff' }}>
            <button type="button" onClick={() => setOpen(isOpen ? null : c.key)}
              className="w-full flex items-center gap-2.5 p-3 cursor-pointer text-start" disabled={c.vehicleCount === 0}>
              <span className="text-[22px] shrink-0">{c.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[13.5px] font-bold text-[#1e293b]">{c.name}</p>
                <p className="text-[11.5px] text-[#64748b] ltr-num">
                  {c.vehicleCount} {availableLabel}{c.fromPricePkr != null ? ` · ${fromLabel} ₨${fmt(c.fromPricePkr)}` : ''}
                </p>
              </div>
              {c.selectedCount > 0 && (
                <span className="shrink-0 min-w-[20px] h-[20px] px-1.5 rounded-full bg-[#166534] text-white text-[11px] font-bold flex items-center justify-center">{c.selectedCount}</span>
              )}
              {c.vehicleCount > 0 && (isOpen ? <ChevronUp size={16} className="text-[#64748b] shrink-0" /> : <ChevronDown size={16} className="text-[#64748b] shrink-0" />)}
            </button>
            {isOpen && c.vehicleCount > 0 && (
              <div className="px-3 pb-3 grid grid-cols-2 gap-2.5">{c.children}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
