'use client'

// Step 2 of the Add Stock wizard: every ticked item in one dense,
// editable list — buying price / selling price / stock / expiry — instead
// of the old modal-per-item cycle. Bulk-apply tools handle the common
// case (same markup, same starting stock, same delivery's expiry date
// across a whole category) so typing 279 numbers by hand is the fallback,
// not the only way through.

import { useMemo, useRef, useState } from 'react'
import { Trash2, Wand2, ChevronDown, ChevronUp } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree, getCategoryLabel } from '@/lib/shopTypes'
import type { CatalogSelection } from '@/hooks/useCatalogSelection'

interface BulkPriceReviewProps {
  primaryType: string
  selection: CatalogSelection
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function BulkPriceReview({ primaryType, selection }: BulkPriceReviewProps) {
  const { t, isUrdu } = useLocale()
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const catOrder = useMemo(() => tree.flatMap((d) => d.categories.map((c) => c.slug)), [tree])

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [markupPct, setMarkupPct] = useState('20')
  const [markupRound, setMarkupRound] = useState('5')
  const [stockValue, setStockValue] = useState('')
  const [expiryValue, setExpiryValue] = useState('')
  const [scope, setScope] = useState<'all' | string>('all')
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map())

  const rowList = selection.rowList
  const grouped = useMemo(() => {
    const byCat: Record<string, typeof rowList> = {}
    for (const r of rowList) (byCat[r.category] ??= []).push(r)
    const orderedSlugs = [...catOrder.filter((s) => byCat[s]), ...Object.keys(byCat).filter((s) => !catOrder.includes(s))]
    return orderedSlugs.map((slug) => ({ slug, rows: byCat[slug].sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [rowList, catOrder])

  const allKeysInScope = scope === 'all' ? rowList.map((r) => r.key) : rowList.filter((r) => r.category === scope).map((r) => r.key)

  const missing = selection.rowsMissingPrice.length

  const totalCost = selection.rowList.reduce((s, r) => s + (Number(r.cost_price_pkr) || 0) * (Number(r.quantity_on_hand) || 0), 0)
  const totalRetail = selection.rowList.reduce((s, r) => s + (Number(r.unit_price_pkr) || 0) * (Number(r.quantity_on_hand) || 0), 0)

  const focusKey = (key: string, field: string) => `${key}:${field}`
  const moveNext = (rowsFlat: { key: string }[], key: string, field: string) => {
    const idx = rowsFlat.findIndex((r) => r.key === key)
    const next = rowsFlat[idx + 1]
    if (next) inputRefs.current.get(focusKey(next.key, field))?.focus()
  }

  const allRowsFlat = useMemo(() => grouped.flatMap((g) => g.rows), [grouped])

  const label = (r: (typeof selection.rowList)[number]) => {
    const name = isUrdu && r.name_ur ? r.name_ur : r.name
    const flavor = isUrdu ? (r.flavor_ur || r.flavor) : r.flavor
    return flavor ? `${name} — ${flavor}` : name
  }

  return (
    <div>
      {selection.count === 0 ? (
        <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('bs.nothingSelectedHint')}</p>
      ) : (
        <>
          <div className="bg-dp-surface-container rounded-xl p-3.5 mb-4">
            <div className="flex items-center gap-1.5 mb-2.5 font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]"><Wand2 size={13} /> {t('bs.bulkApplyHeading')}</div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <select value={scope} onChange={(e) => setScope(e.target.value)} className="input-field !w-auto text-[12.5px] py-1.5">
                <option value="all">{t('bs.scopeAll').replace('{n}', String(selection.count))}</option>
                {grouped.map((g) => (
                  <option key={g.slug} value={g.slug}>{getCategoryLabel(g.slug, isUrdu)} ({g.rows.length})</option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('bs.markupLabel')}</span>
              <input type="number" value={markupPct} onChange={(e) => setMarkupPct(e.target.value)} className="input-field !w-16 text-[12.5px] py-1.5" />
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant">% · {t('bs.roundToLabel')}</span>
              <select value={markupRound} onChange={(e) => setMarkupRound(e.target.value)} className="input-field !w-auto text-[12.5px] py-1.5">
                <option value="1">1</option><option value="5">5</option><option value="10">10</option>
              </select>
              <button onClick={() => selection.applyMarkup(allKeysInScope, Number(markupPct) || 0, Number(markupRound) || 1, false)}
                className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-primary">{t('bs.applyBtn')}</button>
              <span className="font-sans text-[11px] text-dp-on-surface-variant">{t('bs.markupHint')}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('bs.setStockLabel')}</span>
              <input type="number" value={stockValue} onChange={(e) => setStockValue(e.target.value)} className="input-field !w-20 text-[12.5px] py-1.5" placeholder="0" />
              <button onClick={() => stockValue !== '' && selection.bulkSetField(allKeysInScope, 'quantity_on_hand', Number(stockValue), false)}
                className="px-3 py-1.5 bg-white border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-surface-container">{t('bs.applyBtn')}</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('bs.setExpiryLabel')}</span>
              <input type="date" value={expiryValue} onChange={(e) => setExpiryValue(e.target.value)} className="input-field !w-auto text-[12.5px] py-1.5" />
              <button onClick={() => expiryValue !== '' && selection.bulkSetField(allKeysInScope, 'expiry_date', expiryValue, false)}
                className="px-3 py-1.5 bg-white border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-surface-container">{t('bs.applyBtn')}</button>
            </div>
          </div>

          {missing > 0 && (
            <p className="font-sans text-[12.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
              {t('bs.missingPriceWarning').replace('{n}', String(missing))}
            </p>
          )}

          <div className="space-y-4">
            {grouped.map((g) => (
              <div key={g.slug}>
                <button onClick={() => setCollapsed((c) => ({ ...c, [g.slug]: !c[g.slug] }))}
                  className="w-full flex items-center justify-between gap-2 mb-2 cursor-pointer">
                  <span className="font-sans text-[12.5px] font-bold text-dp-on-surface uppercase tracking-[0.03em]">{getCategoryLabel(g.slug, isUrdu)} <span className="font-normal text-dp-on-surface-variant normal-case">({g.rows.length})</span></span>
                  {collapsed[g.slug] ? <ChevronUp size={16} className="text-dp-on-surface-variant" /> : <ChevronDown size={16} className="text-dp-on-surface-variant" />}
                </button>
                {!collapsed[g.slug] && (
                  <div className="space-y-1.5">
                    {g.rows.map((r) => (
                      <div key={r.key} className="bg-white border border-dp-outline-variant rounded-lg p-2.5">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          {r.custom ? (
                            <div className="flex-1 grid grid-cols-2 gap-2">
                              <input value={r.name} onChange={(e) => selection.setField(r.key, 'name', e.target.value)} placeholder={t('mk.productNamePlaceholder')} className="input-field text-[13px] py-1.5" />
                              <input value={r.brandName} onChange={(e) => selection.setField(r.key, 'brandName', e.target.value)} placeholder={t('sk.companyPlaceholder')} className="input-field text-[13px] py-1.5" />
                            </div>
                          ) : (
                            <div className="min-w-0">
                              <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{label(r)}</p>
                              <p className="font-sans text-[11px] text-dp-on-surface-variant truncate">{isUrdu ? r.brandName_ur || r.brandName : r.brandName}</p>
                            </div>
                          )}
                          <button onClick={() => selection.removeRow(r.key)} className="shrink-0 p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <div>
                            <label className="block font-sans text-[10.5px] font-semibold text-dp-on-surface-variant mb-0.5">{t('sk.costPriceLabel')}</label>
                            <input ref={(el) => { if (el) inputRefs.current.set(focusKey(r.key, 'cost'), el) }}
                              type="number" inputMode="decimal" value={r.cost_price_pkr} placeholder="0"
                              onChange={(e) => selection.setField(r.key, 'cost_price_pkr', e.target.value === '' ? '' : Number(e.target.value))}
                              onKeyDown={(e) => e.key === 'Enter' && moveNext(allRowsFlat, r.key, 'cost')}
                              className="input-field text-[13px] py-1.5" />
                          </div>
                          <div>
                            <label className="block font-sans text-[10.5px] font-semibold text-dp-on-surface-variant mb-0.5">{t('mk.unitPriceLabel')} *</label>
                            <input ref={(el) => { if (el) inputRefs.current.set(focusKey(r.key, 'sell'), el) }}
                              type="number" inputMode="decimal" value={r.unit_price_pkr} placeholder={r.suggestedPrice ? String(r.suggestedPrice) : '0'}
                              onChange={(e) => selection.setField(r.key, 'unit_price_pkr', e.target.value === '' ? '' : Number(e.target.value))}
                              onKeyDown={(e) => e.key === 'Enter' && moveNext(allRowsFlat, r.key, 'sell')}
                              className={`input-field text-[13px] py-1.5 ${r.unit_price_pkr === '' ? 'border-amber-300' : ''}`} />
                          </div>
                          <div>
                            <label className="block font-sans text-[10.5px] font-semibold text-dp-on-surface-variant mb-0.5">{t('mk.stockLabel')}</label>
                            <input ref={(el) => { if (el) inputRefs.current.set(focusKey(r.key, 'stock'), el) }}
                              type="number" inputMode="decimal" value={r.quantity_on_hand} placeholder="0"
                              onChange={(e) => selection.setField(r.key, 'quantity_on_hand', e.target.value === '' ? '' : Number(e.target.value))}
                              onKeyDown={(e) => e.key === 'Enter' && moveNext(allRowsFlat, r.key, 'stock')}
                              className="input-field text-[13px] py-1.5" />
                          </div>
                          <div>
                            <label className="block font-sans text-[10.5px] font-semibold text-dp-on-surface-variant mb-0.5">{t('mk.expiryDateLabel')}</label>
                            <input ref={(el) => { if (el) inputRefs.current.set(focusKey(r.key, 'expiry'), el) }}
                              type="date" value={r.expiry_date}
                              onChange={(e) => selection.setField(r.key, 'expiry_date', e.target.value)}
                              className="input-field text-[13px] py-1.5" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="sticky bottom-0 bg-white border-t-2 border-dp-outline-variant mt-4 pt-3 pb-1 -mx-1 px-1">
            <p className="font-sans text-[12px] text-dp-on-surface-variant">
              {t('bs.footerSummary').replace('{n}', String(selection.count)).replace('{cost}', fmt(totalCost)).replace('{retail}', fmt(totalRetail))}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
