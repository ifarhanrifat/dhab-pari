'use client'

// The design spec's "سٹاک" (stock & pricing) tab: a flat, spreadsheet-like
// list with three views via a segmented control — سب آئٹم (everything),
// برانڈ وائز (grouped under brand headers, each showing item count + stock
// value at cost, loose goods getting their own group at the end), کھلا سامان
// (loose-only).
//
// Read-only now, tap-through to edit — this used to be directly
// inline-editable (qty/cost/sale typed right in the cell, saved on
// blur), but that was one of at least three different places a
// shopkeeper could set a price (here, BrandItemPicker's own inline
// fields, and the actual product edit form), a real, confirmed
// complaint. The pencil button on the product edit form (my-shop/
// page.tsx's openEdit, wired in here as onRowClick) is now the ONLY
// place price/sale/unit/quantity get set — this view is purely an
// at-a-glance overview, tap a row to go edit it.
//
// Deliberately separate from CategoryBrowser rather than replacing it —
// that component's department-tile drill is a genuinely different, still
// useful lens (visual browsing, scoped "add item" per category) shared
// with admin/shops; this is the OTHER lens the design actually specified
// for day-to-day price/stock upkeep. ShopCatalogSection's "My Stock" tab
// offers both, toggled at the top.
//
// Row/Header are real module-level components, NOT defined inside
// StockListView's own body — a component declared inside another
// component's render function gets a fresh function identity every
// render, which React treats as a brand-new component type and
// unmounts/remounts on every render — see this file's own git history
// for the onBlur-losing-focus bug that cost, back when this was editable.

import { useMemo, useState } from 'react'
import { Search, Package, Layers } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MarqueeText } from './MarqueeText'

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

interface StockListViewProps<P extends StockListProduct> {
  products: P[]
  onRowClick: (p: P) => void
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function Header({ t }: { t: (k: string) => string }) {
  return (
    <div className="grid grid-cols-[1fr_60px_72px_72px_56px] sm:grid-cols-[1fr_72px_84px_84px_64px] items-center gap-2 px-2.5 py-1.5 border-b-2 border-dp-outline-variant">
      <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em]">{t('sl.itemCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em] text-center">{t('sl.qtyCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-amber-800 uppercase tracking-[0.04em] text-center">{t('sl.costCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-dp-secondary uppercase tracking-[0.04em] text-center">{t('sl.saleCol')}</p>
      <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em] text-center">{t('sl.marginCol')}</p>
    </div>
  )
}

interface RowProps<P extends StockListProduct> { p: P; isUrdu: boolean; showCompany: boolean; onClick: () => void }
function Row<P extends StockListProduct>({ p, isUrdu, showCompany, onClick }: RowProps<P>) {
  const cost = p.cost_price_pkr || 0
  const sale = p.unit_price_pkr || 0
  const margin = sale > 0 ? Math.round(((sale - cost) / sale) * 100) : null
  const low = p.quantity_on_hand <= 4
  const name = isUrdu && p.name_ur ? p.name_ur : p.name
  const flavor = isUrdu ? (p.flavor_ur || p.flavor) : p.flavor
  return (
    <button type="button" onClick={onClick}
      className="w-full grid grid-cols-[1fr_60px_72px_72px_56px] sm:grid-cols-[1fr_72px_84px_84px_64px] items-center gap-2 px-2.5 py-2.5 border-b border-dp-outline-variant/60 last:border-b-0 text-start cursor-pointer hover:bg-dp-surface-container/50 transition-colors">
      <div className="min-w-0">
        <MarqueeText text={flavor ? `${name} (${flavor})` : name} className="font-sans text-[13.5px] font-semibold text-dp-on-surface" />
        {showCompany && p.company && <MarqueeText text={p.company} className="font-sans text-[10.5px] text-dp-on-surface-variant mt-0.5" />}
      </div>
      <p className={`font-sans text-[12.5px] font-bold text-center ltr-num ${low ? 'text-dp-error' : 'text-dp-on-surface'}`}>{fmt(p.quantity_on_hand)}</p>
      <p className="font-sans text-[12.5px] font-semibold text-center text-amber-900 ltr-num">{fmt(cost)}</p>
      <p className="font-sans text-[12.5px] font-bold text-center text-dp-secondary ltr-num">{fmt(sale)}</p>
      <p className={`font-sans text-[11.5px] font-bold text-center ltr-num ${margin === null ? 'text-dp-on-surface-variant/50' : margin < 0 ? 'text-dp-error' : 'text-emerald-700'}`}>
        {margin === null ? '—' : `${margin}%`}
      </p>
    </button>
  )
}

export function StockListView<P extends StockListProduct>({ products, onRowClick }: StockListViewProps<P>) {
  const { t, isUrdu } = useLocale()
  const [view, setView] = useState<'all' | 'brand' | 'loose'>('all')
  const [query, setQuery] = useState('')

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
                {g.rows.map((p) => <Row key={p.id} p={p} isUrdu={isUrdu} showCompany={false} onClick={() => onRowClick(p)} />)}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
          <Header t={t} />
          {(rowsToShow ?? []).map((p) => <Row key={p.id} p={p} isUrdu={isUrdu} showCompany={view === 'all'} onClick={() => onRowClick(p)} />)}
        </div>
      )}
    </div>
  )
}
