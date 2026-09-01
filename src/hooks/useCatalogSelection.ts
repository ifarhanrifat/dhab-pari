// Selection + pricing state for the "Add Stock" wizard (StockPicker step,
// BulkPriceReview step). One basket, mounted once by AddStockWizard, so
// picks survive navigating between department/category screens and the
// step-1 <-> step-2 hop for free — this hook is just the state, no
// screens live here.
//
// A plain object keyed by catalogKey (or a generated key for a hand-added
// item not in the reference catalog) — O(1) lookup for "is this ticked"
// without re-scanning an array on every tile render, same reasoning
// CategoryBrowser's countByCategory/countByBrand memos already use, just
// as the primary state shape here instead of a derived one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogEntry } from '@/lib/catalogSelection'
import { roundTo } from '@/lib/catalogSelection'

export interface BasketRow {
  key: string
  custom: boolean // true = "add your own item" row, not from the reference catalog
  brandName: string
  brandName_ur: string
  name: string
  name_ur: string
  flavor: string
  flavor_ur: string
  category: string
  suggestedPrice: number | null
  cost_price_pkr: number | ''
  unit_price_pkr: number | ''
  quantity_on_hand: number | ''
  expiry_date: string
}

function rowFromEntry(e: CatalogEntry): BasketRow {
  return {
    key: e.key, custom: false, brandName: e.brandName, brandName_ur: e.brandName_ur,
    name: e.item.name, name_ur: e.item.name_ur ?? '', flavor: e.item.flavor ?? '', flavor_ur: e.item.flavor_ur ?? '',
    category: e.item.category, suggestedPrice: e.item.price ?? null,
    cost_price_pkr: '', unit_price_pkr: e.item.price ?? '', quantity_on_hand: '', expiry_date: '',
  }
}

const DRAFT_PREFIX = 'dp.stockDraft.'

export function useCatalogSelection(shopId: string | null) {
  const [rows, setRows] = useState<Record<string, BasketRow>>({})
  const [draftAvailable, setDraftAvailable] = useState(false)
  const hydrated = useRef(false)

  // A draft from an earlier, interrupted session is offered back, never
  // restored silently — losing 100+ typed prices to a dropped connection
  // is the exact failure this exists to prevent, but silently reviving a
  // stale session would be its own kind of surprise.
  useEffect(() => {
    if (!shopId || hydrated.current) return
    hydrated.current = true
    try {
      const raw = sessionStorage.getItem(DRAFT_PREFIX + shopId)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, BasketRow>
        if (Object.keys(parsed).length > 0) setDraftAvailable(true)
      }
    } catch { /* corrupt/unavailable storage — just start empty */ }
  }, [shopId])

  useEffect(() => {
    if (!shopId) return
    const t = setTimeout(() => {
      try {
        if (Object.keys(rows).length > 0) sessionStorage.setItem(DRAFT_PREFIX + shopId, JSON.stringify(rows))
        else sessionStorage.removeItem(DRAFT_PREFIX + shopId)
      } catch { /* storage full/unavailable — draft safety is best-effort */ }
    }, 400)
    return () => clearTimeout(t)
  }, [rows, shopId])

  const restoreDraft = useCallback(() => {
    if (!shopId) return
    try {
      const raw = sessionStorage.getItem(DRAFT_PREFIX + shopId)
      if (raw) setRows(JSON.parse(raw))
    } catch { /* ignore */ }
    setDraftAvailable(false)
  }, [shopId])
  const dismissDraft = useCallback(() => {
    if (shopId) { try { sessionStorage.removeItem(DRAFT_PREFIX + shopId) } catch { /* ignore */ } }
    setDraftAvailable(false)
  }, [shopId])

  const toggle = useCallback((entry: CatalogEntry) => {
    setRows((r) => {
      if (r[entry.key]) { const next = { ...r }; delete next[entry.key]; return next }
      return { ...r, [entry.key]: rowFromEntry(entry) }
    })
  }, [])

  const selectMany = useCallback((entries: CatalogEntry[]) => {
    setRows((r) => {
      const next = { ...r }
      for (const e of entries) if (!next[e.key]) next[e.key] = rowFromEntry(e)
      return next
    })
  }, [])

  const deselectMany = useCallback((keys: string[]) => {
    setRows((r) => {
      const next = { ...r }
      for (const k of keys) delete next[k]
      return next
    })
  }, [])

  const clear = useCallback(() => setRows({}), [])

  const setField = useCallback(<K extends keyof BasketRow>(key: string, field: K, value: BasketRow[K]) => {
    setRows((r) => (r[key] ? { ...r, [key]: { ...r[key], [field]: value } } : r))
  }, [])

  const removeRow = useCallback((key: string) => {
    setRows((r) => { const next = { ...r }; delete next[key]; return next })
  }, [])

  const addCustomRow = useCallback((category: string) => {
    const key = `custom::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`
    setRows((r) => ({
      ...r,
      [key]: {
        key, custom: true, brandName: '', brandName_ur: '', name: '', name_ur: '', flavor: '', flavor_ur: '',
        category, suggestedPrice: null, cost_price_pkr: '', unit_price_pkr: '', quantity_on_hand: '', expiry_date: '',
      },
    }))
    return key
  }, [])

  // Bulk-apply helpers scoped to a set of keys (either "all" or "this
  // category") — fill blanks by default so typed work never gets
  // silently clobbered; overwriteTyped opts into replacing everything.
  const bulkSetField = useCallback((keys: string[], field: 'unit_price_pkr' | 'cost_price_pkr' | 'quantity_on_hand' | 'expiry_date', value: number | string, overwriteTyped: boolean) => {
    setRows((r) => {
      const next = { ...r }
      for (const k of keys) {
        const row = next[k]
        if (!row) continue
        const blank = field === 'expiry_date' ? row.expiry_date === '' : row[field] === ''
        if (overwriteTyped || blank) next[k] = { ...row, [field]: value }
      }
      return next
    })
  }, [])

  const applyMarkup = useCallback((keys: string[], percent: number, roundNearest: number, overwriteTyped: boolean) => {
    setRows((r) => {
      const next = { ...r }
      for (const k of keys) {
        const row = next[k]
        if (!row) continue
        const cost = typeof row.cost_price_pkr === 'number' ? row.cost_price_pkr : 0
        if (cost <= 0) continue
        const blank = row.unit_price_pkr === ''
        if (!overwriteTyped && !blank) continue
        next[k] = { ...row, unit_price_pkr: roundTo(cost * (1 + percent / 100), roundNearest) }
      }
      return next
    })
  }, [])

  const rowList = useMemo(() => Object.values(rows), [rows])
  const count = rowList.length
  const rowsMissingPrice = useMemo(() => rowList.filter((r) => r.unit_price_pkr === '' || Number(r.unit_price_pkr) <= 0), [rowList])

  return {
    rows, rowList, count, rowsMissingPrice,
    draftAvailable, restoreDraft, dismissDraft,
    toggle, selectMany, deselectMany, clear, setField, removeRow, addCustomRow, bulkSetField, applyMarkup,
  }
}

export type CatalogSelection = ReturnType<typeof useCatalogSelection>
