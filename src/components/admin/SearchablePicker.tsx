'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { Search, X, ChevronDown } from 'lucide-react'

export interface PickerItem { id: string; label: string; sublabel?: string; group?: string }

interface SearchablePickerProps {
  open: boolean
  title: string
  items: PickerItem[]
  onSelect: (id: string) => void
  onClose: () => void
  searchPlaceholder?: string
  emptyMessage?: string
  extraAction?: { label: string; onClick: () => void }
}

// A searchable, optionally-grouped modal list — the same reusable picker for
// picking a consumer, an account, or an "other charge" category, matching the
// reference app's single searchable-list pattern used for every such selection.
export function SearchablePicker({
  open, title, items, onSelect, onClose,
  searchPlaceholder = 'Search...', emptyMessage = 'No results', extraAction,
}: SearchablePickerProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.sublabel?.toLowerCase().includes(q))
  }, [items, query])

  const groups = useMemo(() => {
    const map = new Map<string, PickerItem[]>()
    for (const item of filtered) {
      const g = item.group ?? ''
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(item)
    }
    return Array.from(map.entries())
  }, [filtered])

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-dp-outline-variant shrink-0">
          <h2 className="font-sans text-[16px] font-bold text-dp-on-surface">{title}</h2>
          <button onClick={onClose} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={18} /></button>
        </div>
        <div className="p-3 border-b border-dp-outline-variant shrink-0">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
            <input
              ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full pl-9 pr-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:outline-none focus:border-dp-secondary"
            />
          </div>
          {extraAction && (
            <button
              onClick={extraAction.onClick}
              className="mt-2 w-full flex items-center justify-center px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer"
            >
              {extraAction.label}
            </button>
          )}
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 && <p className="px-4 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{emptyMessage}</p>}
          {groups.map(([group, groupItems]) => (
            <div key={group || '_'}>
              {group && <p className="px-4 py-1.5 bg-dp-surface-container-low text-[11px] font-sans font-bold tracking-[0.05em] text-dp-on-surface-variant sticky top-0">{group.toUpperCase()}</p>}
              {groupItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => { onSelect(item.id); onClose() }}
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-dp-surface-container-low transition-all cursor-pointer border-b border-dp-outline-variant/50 last:border-b-0"
                >
                  <span className="font-sans text-[14px] text-dp-on-surface truncate">{item.label}</span>
                  {item.sublabel && <span className="font-sans text-[12px] text-dp-on-surface-variant shrink-0">{item.sublabel}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

interface SearchableFieldProps {
  label?: string
  value: string
  items: PickerItem[]
  onChange: (id: string) => void
  placeholder?: string
  disabled?: boolean
  pickerTitle?: string
  searchPlaceholder?: string
  extraAction?: { label: string; onClick: () => void }
}

// Drop-in replacement for a plain <select> — renders like .input-field, opens
// the SearchablePicker on click. Scales to hundreds of consumers/accounts,
// where a native <select> becomes unusable without search.
export function SearchableField({
  label, value, items, onChange, placeholder = 'Select...', disabled,
  pickerTitle, searchPlaceholder, extraAction,
}: SearchableFieldProps) {
  const [open, setOpen] = useState(false)
  const selected = items.find((i) => i.id === value)
  return (
    <div>
      {label && <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{label}</label>}
      <button
        type="button" disabled={disabled}
        onClick={() => setOpen(true)}
        className="input-field flex items-center justify-between text-left disabled:bg-dp-surface-container-low disabled:text-dp-on-surface-variant disabled:cursor-not-allowed cursor-pointer"
      >
        <span className={`truncate ${selected ? 'text-dp-on-surface' : 'text-dp-on-surface-variant'}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={15} className="text-dp-on-surface-variant shrink-0 ml-2" />
      </button>
      <SearchablePicker
        open={open} title={pickerTitle ?? label ?? 'Select'} items={items}
        onSelect={onChange} onClose={() => setOpen(false)}
        searchPlaceholder={searchPlaceholder}
        extraAction={extraAction}
      />
    </div>
  )
}
