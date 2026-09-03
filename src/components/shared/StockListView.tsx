'use client'

// The design spec's "سٹاک" (stock & pricing) tab: a flat, spreadsheet-like
// list with three views via a segmented control — سب آئٹم (everything),
// برانڈ وائز (grouped under brand headers, each showing item count + stock
// value at cost, loose goods getting their own group at the end), کھلا سامان
// (loose-only). Every row is inline-editable — qty (red once low), cost
// (tinted, private), sale (bold, public) — with margin% computed live, so
// "the delivery driver just told me sugar went up 5 rupees" is a two-tap
// fix, not open-modal-change-one-field-save-close per item.
//
// Deliberately separate from CategoryBrowser rather than replacing it —
// that component's department-tile drill is a genuinely different, still
// useful lens (visual browsing, scoped "add item" per category) shared
// with admin/shops; this is the OTHER lens the design actually specified
// for day-to-day price/stock upkeep. ShopCatalogSection's "My Stock" tab
// offers both, toggled at the top.
//
// Saves on blur, not on every keystroke — a draft value lives in local
// state per (productId, field) while focused, committed to the parent's
// onFieldSave only once the keeper actually moves on, same reasoning
// BulkPriceReview's own inputs already use.
//
// Row/Header are real module-level components, NOT defined inside
// StockListView's own body — a component declared inside another
// component's render function gets a fresh function identity every
// render, which React treats as a brand-new component type and
// unmounts/remounts on every keystroke. That silently broke onBlur here
// during testing: the <input> DOM node was torn down and rebuilt on
// every character typed, so a save could get lost depending on exactly
// when blur landed relative to the remount. Hoisting them out is the
// real fix, not a workaround.

import { useMemo, useState } from 'react'
import { Search, Package, Layers } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Must match src/lib/catalogSelection.ts's LOOSE_BRAND_NAME — that's the
// `company` value ShopCatalogSection's commit() stamps on every loose-good
// row, which is the only signal available here to tell a loose item apart
// from a real branded one (shop_products has no separate "is_loose" flag).
const LOOSE_BRAND_NAME = 'Unbranded / Loose Goods'

export interface StockListProduct {
  id: string
  name: string
  name_ur?: string | null
  company?: string | null
  category: string | null
  flavor?: string | null
  flavor_ur?: string | null
  cost_price_pkr: number
  unit_price_pkr: number
  quantity_on_hand: number
  is_active?: boolean
}

type EditableField = 'cost_price_pkr' | 'unit_price_pkr' | 'quantity_on_hand'

interface StockListViewProps<P extends StockListProduct> {
  products: P[]
  onFieldSave: (productId: string, field: EditableField, value: number) => void
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const draftKey = (id: string, field: EditableField) => `${id}::${field}`

function Header({ t }: { t: (k: string) => string }) {
  return (
    <div className="grid grid-cols-[1fr_72px_84px_84px_56px] sm:grid-cols-[1fr_88px_100px_100px_64px] items-center gap-2 px-2.5 py-1.5 border-b-2 border-dp-outline-variant">
      <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em]">{t('sl.itemCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em] text-center">{t('sl.qtyCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-amber-800 uppercase tracking-[0.04em] text-center">{t('sl.costCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-dp-secondary uppercase tracking-[0.04em] text-center">{t('sl.saleCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em] text-center">{t('sl.marginCol')}</p>
    </div>
  )
}

interface RowProps<P extends StockListProduct> {
  p: P
  isUrdu: boolean
  showCompany: boolean
  getValue: (p: P, field: EditableField) => string
  onChange: (id: string, field: EditableField, value: string) => void
  onBlur: (p: P, field: EditableField) => void
}

function Row<P extends StockListProduct>({ p, isUrdu, showCompany, getValue, onChange, onBlur }: RowProps<P>) {
  const cost = Number(getValue(p, 'cost_price_pkr')) || 0
  const sale = Number(getValue(p, 'unit_price_pkr')) || 0
  const margin = sale > 0 ? Math.round(((sale - cost) / sale) * 100) : null
  const qtyNum = Number(getValue(p, 'quantity_on_hand')) || 0
  const low = qtyNum <= 4
  return (
    <div className="grid grid-cols-[1fr_72px_84px_84px_56px] sm:grid-cols-[1fr_88px_100px_100px_64px] items-center gap-2 px-2.5 py-2 border-b border-dp-outline-variant/60 last:border-b-0">
      <div className="min-w-0">
        <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">
          {isUrdu && p.name_ur ? p.name_ur : p.name}
          {(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && <span className="font-normal text-dp-on-surface-variant"> ({isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})</span>}
        </p>
        {showCompany && p.company && <p className="font-sans text-[10.5px] text-dp-on-surface-variant truncate">{p.company}</p>}
      </div>
      <input type="number" value={getValue(p, 'quantity_on_hand')} onChange={(e) => onChange(p.id, 'quantity_on_hand', e.target.value)} onBlur={() => onBlur(p, 'quantity_on_hand')}
        className={`w-full px-1.5 py-1 rounded border text-[12.5px] font-sans text-center font-bold ltr-num ${low ? 'border-dp-error/50 bg-red-50 text-dp-error' : 'border-dp-outline-variant bg-white text-dp-on-surface'}`} />
      <input type="number" value={getValue(p, 'cost_price_pkr')} onChange={(e) => onChange(p.id, 'cost_price_pkr', e.target.value)} onBlur={() => onBlur(p, 'cost_price_pkr')}
        className="w-full px-1.5 py-1 rounded border border-amber-300 bg-amber-50 text-[12.5px] font-sans text-center text-amber-900 ltr-num" />
      <input type="number" value={getValue(p, 'unit_price_pkr')} onChange={(e) => onChange(p.id, 'unit_price_pkr', e.target.value)} onBlur={() => onBlur(p, 'unit_price_pkr')}
        className="w-full px-1.5 py-1 rounded border border-dp-secondary/40 bg-dp-secondary-container/20 text-[12.5px] font-sans font-bold text-center text-dp-secondary ltr-num" />
      <p className={`font-sans text-[11.5px] font-bold text-center ltr-num ${margin === null ? 'text-dp-on-surface-variant/50' : margin < 0 ? 'text-dp-error' : 'text-emerald-700'}`}>
        {margin === null ? '—' : `${margin}%`}
      </p>
    </div>
  )
}

export function StockListView<P extends StockListProduct>({ products, onFieldSave }: StockListViewProps<P>) {
  const { t, isUrdu } = useLocale()
  const [view, setView] = useState<'all' | 'brand' | 'loose'>('all')
  const [query, setQuery] = useState('')
  // Draft text per "productId::field" while a cell is focused — lets the
  // input hold whatever's being typed (including a momentarily-invalid
  // "" or "12.") without fighting the parent's own re-render.
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return products
    return products.filter((p) =>
      p.name.toLowerCase().includes(q) || (p.name_ur ?? '').includes(q) || (p.company ?? '').toLowerCase().includes(q)
    )
  }, [products, q])

  const looseOnly = filtered.filter((p) => (p.company ?? '').trim() === LOOSE_BRAND_NAME)
  const brandedOnly = filtered.filter((p) => (p.company ?? '').trim() !== LOOSE_BRAND_NAME)

  const byBrand = useMemo(() => {
    const order: string[] = []
    const groups: Record<string, P[]> = {}
    for (const p of brandedOnly) {
      const key = (p.company ?? '').trim() || t('sl.noCompany')
      if (!groups[key]) { groups[key] = []; order.push(key) }
      groups[key].push(p)
    }
    const result = order.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, rows: groups[name] }))
    if (looseOnly.length > 0) result.push({ name: t('sl.looseGroupHeading'), rows: looseOnly })
    return result
  }, [brandedOnly, looseOnly, t])

  const rowsToShow = view === 'all' ? filtered : view === 'loose' ? looseOnly : null

  const getValue = (p: P, field: EditableField) => {
    const k = draftKey(p.id, field)
    return k in drafts ? drafts[k] : String(p[field] || '')
  }
  const onChange = (id: string, field: EditableField, value: string) => setDrafts((d) => ({ ...d, [draftKey(id, field)]: value }))
  const onBlur = (p: P, field: EditableField) => {
    const k = draftKey(p.id, field)
    const raw = drafts[k]
    setDrafts((d) => { const next = { ...d }; delete next[k]; return next })
    if (raw === undefined) return
    const num = Number(raw)
    if (!Number.isFinite(num) || num < 0 || num === p[field]) return
    onFieldSave(p.id, field, num)
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-3 bg-dp-surface-container rounded-lg p-1">
        {(['all', 'brand', 'loose'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`flex-1 px-2.5 py-1.5 rounded-md font-sans text-[12px] font-semibold cursor-pointer transition-all ${view === v ? 'bg-white text-dp-secondary shadow-sm' : 'text-dp-on-surface-variant hover:text-dp-on-surface'}`}>
            {v === 'all' ? t('sl.viewAll') : v === 'brand' ? t('sl.viewByBrand') : t('sl.viewLoose')}
          </button>
        ))}
      </div>

      <div className="relative mb-3">
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant/60 pointer-events-none" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('cb.searchPlaceholder')}
          className="w-full ps-9 pe-3 py-2.5 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[14px] font-sans text-dp-on-surface" />
      </div>

      {filtered.length === 0 ? (
        <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.noMatches')}</p>
      ) : view === 'brand' ? (
        <div className="space-y-4">
          {byBrand.map((g) => {
            const stockValue = g.rows.reduce((s, p) => s + p.cost_price_pkr * p.quantity_on_hand, 0)
            return (
              <div key={g.name} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-dp-surface-container">
                  <p className="font-sans text-[12.5px] font-bold text-dp-on-surface flex items-center gap-1.5">
                    {g.name === t('sl.looseGroupHeading') ? <Layers size={13} /> : <Package size={13} />} {g.name}
                  </p>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant shrink-0">{g.rows.length} {t('mk.productsCount')} · {t('sl.stockValueAtCost')} <span className="font-bold ltr-num">{fmt(stockValue)}</span></p>
                </div>
                <Header t={t} />
                {g.rows.map((p) => <Row key={p.id} p={p} isUrdu={isUrdu} showCompany={false} getValue={getValue} onChange={onChange} onBlur={onBlur} />)}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
          <Header t={t} />
          {(rowsToShow ?? []).map((p) => <Row key={p.id} p={p} isUrdu={isUrdu} showCompany={view === 'all'} getValue={getValue} onChange={onChange} onBlur={onBlur} />)}
        </div>
      )}
    </div>
  )
}
