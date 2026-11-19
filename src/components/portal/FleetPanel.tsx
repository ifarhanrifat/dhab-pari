// 2026-11-16: shared presentational shells for the Fleet admin screens —
// the SAFAR-reference "panel / panel-head / panel-body", "stat", and
// "status pill" patterns, in dhab-pari's own green/cream theme. Purely
// visual: no data, no RPCs, no state. Every fleet page wraps its
// existing content in these so the section head (icon chip + title +
// one-line muted description + optional action), the divider and the
// body padding look identical across Dashboard, Counters, Staff,
// Drivers, Vehicles, Bookings, Chalan, Expenses, Cash, Reports, Routes.

import type { ReactNode } from 'react'
import { Search } from 'lucide-react'

type Tone = 'default' | 'danger' | 'warning'

const PANEL_BORDER: Record<Tone, string> = {
  default: 'border-[#e5e2d0]',
  danger: 'border-[#fecaca]',
  warning: 'border-[#fde68a]',
}

export function FleetPanel({ children, className = '', tone = 'default' }: { children: ReactNode; className?: string; tone?: Tone }) {
  return <div className={`bg-white border ${PANEL_BORDER[tone]} rounded-2xl overflow-hidden ${className}`}>{children}</div>
}

const HEAD_ICON: Record<Tone, string> = {
  default: 'bg-[#F0FDF4] text-[#166534]',
  danger: 'bg-[#FEF2F2] text-[#b91c1c]',
  warning: 'bg-[#FFFBEB] text-[#b45309]',
}
const HEAD_TITLE: Record<Tone, string> = {
  default: 'text-[#1e293b]',
  danger: 'text-[#b91c1c]',
  warning: 'text-[#92400e]',
}

export function FleetPanelHead({ icon, title, description, action, tone = 'default' }: {
  icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; tone?: Tone
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-[#f1f5f9]">
      <div className="min-w-0 flex items-center gap-2">
        {icon && <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${HEAD_ICON[tone]}`}>{icon}</span>}
        <div className="min-w-0">
          <p className={`font-sans text-[12.5px] font-bold leading-tight ${HEAD_TITLE[tone]}`}>{title}</p>
          {description && <p className="font-sans text-[10.5px] text-[#64748b] leading-snug mt-0.5">{description}</p>}
        </div>
      </div>
      {action && <div className="shrink-0 flex items-center gap-1.5">{action}</div>}
    </div>
  )
}

/** `className` replaces the default `p-3.5` padding entirely when given. */
export function FleetPanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ?? 'p-3.5'}>{children}</div>
}

/** Thin uppercase column-label strip for card lists that read as a table. */
export function FleetColumnLabels({ labels, className = '' }: { labels: ReactNode[]; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-2 px-3.5 py-1.5 bg-[#F9F9F6] border-b border-[#f1f5f9] ${className}`}>
      {labels.map((l, i) => (
        <span key={i} className={`font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] ${i === 0 ? 'min-w-0 truncate' : 'shrink-0 text-end'}`}>{l}</span>
      ))}
    </div>
  )
}

/** Stat tile: label top-start, icon chip top-end, big value, muted footnote. */
export function FleetStat({ label, value, icon, foot, valueClassName = 'text-[#166534]', className = '' }: {
  label: ReactNode; value: ReactNode; icon?: ReactNode; foot?: ReactNode; valueClassName?: string; className?: string
}) {
  return (
    <div className={`bg-white border border-[#e5e2d0] rounded-xl p-3 min-w-0 ${className}`}>
      <div className="flex items-center justify-between gap-1">
        <span className="font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#64748b] truncate">{label}</span>
        {icon && <span className="w-6 h-6 rounded-lg bg-[#F0FDF4] flex items-center justify-center text-[#166534] font-bold text-[11px] shrink-0">{icon}</span>}
      </div>
      <p className={`font-sans text-[18px] font-extrabold mt-1.5 ltr-num ${valueClassName}`}>{value}</p>
      {foot && <p className="font-sans text-[10px] text-[#94a3b8] mt-0.5 ltr-num">{foot}</p>}
    </div>
  )
}

/** 2-column field grid for create/add/record forms (SAFAR-reference `.form-grid`). */
export function FleetFormGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-2 gap-2.5 ${className}`}>{children}</div>
}

/** One stacked label + control cell inside `FleetFormGrid`; `full` spans both columns. */
export function FleetFormField({ label, full = false, children, className = '' }: {
  label: ReactNode; full?: boolean; children: ReactNode; className?: string
}) {
  return (
    <div className={`min-w-0 ${full ? 'col-span-2' : ''} ${className}`}>
      <label className="block font-sans text-[11px] font-bold text-[#64748b] mb-1">{label}</label>
      {children}
    </div>
  )
}

/** 2026-11-19: KPI grid wrapper — extracted from the identical raw
 * `grid grid-cols-2 gap-2.5` markup already copy-pasted on Vehicles/
 * Counters, so a new screen doesn't re-invent it a third time. */
export function FleetKpiRow({ children, cols = 2, className = '' }: { children: ReactNode; cols?: 2 | 3 | 4; className?: string }) {
  const colsClass = cols === 4 ? 'grid-cols-4' : cols === 3 ? 'grid-cols-3' : 'grid-cols-2'
  return <div className={`grid ${colsClass} gap-2.5 ${className}`}>{children}</div>
}

/** 2026-11-19: search(+filter) toolbar row — extracted from the
 * identical raw markup already copy-pasted on Vehicles/Counters
 * (absolutely-positioned search icon + input, optional trailing
 * filter control such as a `<select>`). */
export function FleetToolbar({ searchValue, onSearchChange, searchPlaceholder, filter, className = '' }: {
  searchValue: string; onSearchChange: (value: string) => void; searchPlaceholder: string; filter?: ReactNode; className?: string
}) {
  return (
    <div className={`flex gap-1.5 p-3 pb-0 ${className}`}>
      <div className="relative flex-1">
        <Search size={13} className="absolute top-1/2 -translate-y-1/2 start-2.5 text-[#94a3b8]" />
        <input value={searchValue} onChange={(e) => onSearchChange(e.target.value)} placeholder={searchPlaceholder}
          className="w-full ps-8 pe-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
      </div>
      {filter}
    </div>
  )
}

const PILL: Record<'green' | 'amber' | 'red' | 'blue' | 'gray', { bg: string; fg: string }> = {
  green: { bg: '#F0FDF4', fg: '#166534' },
  amber: { bg: '#FFFBEB', fg: '#b45309' },
  red: { bg: '#FEF2F2', fg: '#b91c1c' },
  blue: { bg: '#EFF6FF', fg: '#1d4ed8' },
  gray: { bg: '#F1F5F9', fg: '#64748b' },
}

export function FleetStatusPill({ tone, children, className = '' }: { tone: keyof typeof PILL; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-sans text-[10px] font-bold whitespace-nowrap ${className}`}
      style={{ background: PILL[tone].bg, color: PILL[tone].fg }}>
      <i className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />{children}
    </span>
  )
}
