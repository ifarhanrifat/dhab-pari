'use client'

// Brand-first catalog browsing for the shop's "Add Stock" tab — a literal
// port of the "Village Portal Marketplace" design handoff's own catalog
// screens (Shop Portal v3.dc.html: "S · catalog · brands" and "S · brand
// catalog"), not a reinterpretation. Every button's copy, every hint
// paragraph, the exact fields on a row (unit <select>, cost, sale) and
// the exact two-button bottom bar on the brand-detail screen are taken
// straight from that file's own markup — nothing invented, nothing
// summarized into a shorter label of its own. Departments stays a
// secondary lens (toggle at the top, not in the handoff file at all) for
// the handful of categories with no brand coverage.
//
// Ticking commits immediately — there is no separate "Save" step here at
// all. A tap on an un-owned row inserts it into shop_products right then
// (using whatever cost/sale/unit is currently typed, or the catalog's
// own defaults if nothing was touched); a tap on an already-owned row
// deletes that real row. Cost/sale/unit stay visible AND editable after
// a row is owned too — typing there now updates the real product
// directly (onBlur), the same "type a rate, it saves" feel before and
// after the tick, instead of the fields vanishing the moment a row
// becomes stock.
//
// VariantRow/LooseRow/ItemRow are hoisted to module scope on purpose —
// defining them inside BrandItemPicker's own function body (an earlier
// version of this file did) gives every row a brand-new component
// identity on every re-render, and React remounts a function component
// whose identity changed since the last render. Since ANY keystroke in
// any price field triggers a state update and thus a re-render of
// BrandItemPicker, that meant every row's <input> was destroyed and
// recreated after every character — which reads as "can't type
// anything" or "the rate disappears" depending on timing. Hoisted here,
// only their *props* change between renders, so React just re-renders
// the existing DOM nodes and focus/typing works normally.

import { useMemo, useState } from 'react'
import { ArrowRight, Check, LayoutGrid, Tags, Sparkles, PackagePlus, Search, Camera, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree, getCategoryLabel } from '@/lib/shopTypes'
import {
  getCatalogForShopType, brandsForShopType, starterSetEntries,
  groupByCategory, countByDept, searchCatalogEntries, ownedKey, looseGoodsAsCatalogEntries, UNIT_OPTIONS, type CatalogEntry,
} from '@/lib/catalogSelection'
import { DynamicIcon } from './DynamicIcon'
import { BrandBuilderModal } from './BrandBuilderModal'
import type { CatalogSelection } from '@/hooks/useCatalogSelection'

interface OwnedProduct {
  id: string; name: string; flavor?: string | null
  cost_price_pkr?: number; unit_price_pkr?: number; unit?: string
}

interface BrandItemPickerProps {
  shopId: string
  primaryType: string
  ownedProducts: OwnedProduct[]
  selection: CatalogSelection
  onBrandSubmitted: () => void
  onScanClick?: () => void
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

// A field binding hides "is this row owned yet or still a pre-commit
// draft" from the row components entirely — they just get a value +
// onChange (+ optional onBlur to push an owned row's edit to the DB).
interface FieldBinding { value: string | number; onChange: (v: string) => void; onBlur?: () => void }

interface ItemRowProps { e: CatalogEntry; isUrdu: boolean; label: string; owned: boolean; busy: boolean; onToggle: () => void }
function ItemRow({ e, isUrdu, label, owned, busy, onToggle }: ItemRowProps) {
  return (
    <button type="button" disabled={busy} onClick={onToggle}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-start transition-all ${owned ? 'bg-dp-secondary-container/40 border-dp-secondary' : 'bg-white border-dp-outline-variant hover:border-dp-secondary'} ${busy ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}>
      <span className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border-2 ${owned ? 'bg-dp-secondary border-dp-secondary' : 'border-dp-outline-variant'}`}>
        {busy ? <Loader2 size={12} className="text-dp-secondary animate-spin" /> : owned && <Check size={13} className="text-white" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[11.5px] font-semibold text-dp-on-surface truncate">{label}</span>
        <span className="block font-sans text-[9px] text-dp-on-surface-variant truncate">{getCategoryLabel(e.item.category, isUrdu)}</span>
      </span>
      {!owned && e.item.price ? <span className="shrink-0 font-sans text-[9.5px] font-bold text-dp-secondary">~{e.item.price}</span> : null}
    </button>
  )
}

interface VariantRowProps { e: CatalogEntry; flavorLabel: string; owned: boolean; busy: boolean; onToggle: () => void; cost: FieldBinding; sale: FieldBinding; t: (k: string) => string }
function VariantRow({ e, flavorLabel, owned, busy, onToggle, cost, sale, t }: VariantRowProps) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2.5 border-t border-dp-outline-variant/60 first:border-t-0 ${owned ? 'bg-dp-secondary-container/20' : ''}`}>
      <button type="button" disabled={busy} onClick={onToggle}
        className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border-2 cursor-pointer ${owned ? 'bg-dp-secondary border-dp-secondary' : 'border-dp-outline-variant'} ${busy ? 'opacity-60' : ''}`}>
        {busy ? <Loader2 size={12} className="text-dp-secondary animate-spin" /> : owned && <Check size={13} className="text-white" strokeWidth={3} />}
      </button>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[11px] text-dp-on-surface truncate">{flavorLabel}</span>
        {e.item.price ? <span className="block font-sans text-[8.5px] text-dp-on-surface-variant">{t('bs.mrpLabel').replace('{v}', String(e.item.price))}</span> : null}
      </span>
      <input inputMode="decimal" placeholder={t('bs.costPlaceholder')} value={cost.value} onChange={(ev) => cost.onChange(ev.target.value)} onBlur={cost.onBlur}
        className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-outline-variant bg-dp-surface-container font-sans text-[10px] text-dp-on-surface" />
      <input inputMode="decimal" placeholder={t('bs.salePlaceholder')} value={sale.value} onChange={(ev) => sale.onChange(ev.target.value)} onBlur={sale.onBlur}
        className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-secondary bg-white font-sans text-[10px] font-bold text-dp-on-surface" />
    </div>
  )
}

interface LooseRowProps { name: string; owned: boolean; busy: boolean; onToggle: () => void; unit: FieldBinding; cost: FieldBinding; sale: FieldBinding; t: (k: string) => string }
function LooseRow({ name, owned, busy, onToggle, unit, cost, sale, t }: LooseRowProps) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${owned ? 'bg-dp-secondary-container/40 border-dp-secondary' : 'bg-white border-dp-outline-variant'}`}>
      <button type="button" disabled={busy} onClick={onToggle}
        className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border-2 cursor-pointer ${owned ? 'bg-dp-secondary border-dp-secondary' : 'border-dp-outline-variant'} ${busy ? 'opacity-60' : ''}`}>
        {busy ? <Loader2 size={12} className="text-dp-secondary animate-spin" /> : owned && <Check size={13} className="text-white" strokeWidth={3} />}
      </button>
      <span className="min-w-0 flex-1 font-sans text-[11px] text-dp-on-surface truncate">{name}</span>
      <select value={unit.value} onChange={(ev) => unit.onChange(ev.target.value)} onBlur={unit.onBlur}
        className="shrink-0 w-[74px] px-1 py-1.5 rounded-lg border border-dp-outline-variant bg-white font-sans text-[9px] text-dp-on-surface">
        {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
      <input inputMode="decimal" placeholder={t('bs.costPlaceholder')} value={cost.value} onChange={(ev) => cost.onChange(ev.target.value)} onBlur={cost.onBlur}
        className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-outline-variant bg-dp-surface-container font-sans text-[10px] text-dp-on-surface" />
      <input inputMode="decimal" placeholder={t('bs.salePlaceholder')} value={sale.value} onChange={(ev) => sale.onChange(ev.target.value)} onBlur={sale.onBlur}
        className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-secondary bg-white font-sans text-[10px] font-bold text-dp-on-surface" />
    </div>
  )
}

export function BrandItemPicker({ shopId, primaryType, ownedProducts, selection, onBrandSubmitted, onScanClick }: BrandItemPickerProps) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [committingKeys, setCommittingKeys] = useState<Set<string>>(new Set())
  // Pre-commit price/unit edits key off catalog key (selection.rows,
  // useCatalogSelection); once a row is owned, edits key off the real
  // product id instead — a totally different identity, so a separate map.
  const [ownedDrafts, setOwnedDrafts] = useState<Record<string, Partial<{ cost_price_pkr: string | number; unit_price_pkr: string | number; unit: string }>>>({})
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const looseEntries = useMemo(() => looseGoodsAsCatalogEntries(primaryType), [primaryType])
  const catalog = useMemo(() => [...getCatalogForShopType(primaryType), ...looseEntries], [primaryType, looseEntries])
  const realBrands = useMemo(() => brandsForShopType(primaryType), [primaryType])
  const starterSet = useMemo(() => starterSetEntries(primaryType), [primaryType])
  const ownedKeys = useMemo(() => new Set(ownedProducts.map((p) => ownedKey(p.name, p.flavor))), [ownedProducts])
  const availableForPick = (e: CatalogEntry) => !ownedKeys.has(ownedKey(e.item.name, e.item.flavor))
  const findOwned = (e: CatalogEntry) => ownedProducts.find((p) => ownedKey(p.name, p.flavor) === ownedKey(e.item.name, e.item.flavor))

  const [lens, setLens] = useState<'brands' | 'departments'>(realBrands.length > 0 ? 'brands' : 'departments')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  const [openBrandSlug, setOpenBrandSlug] = useState<string | null>(null)
  const [showBrandBuilder, setShowBrandBuilder] = useState(false)

  const [activeDeptKey, setActiveDeptKey] = useState<string | null>(null)
  const [activeCatSlug, setActiveCatSlug] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [looseQuery, setLooseQuery] = useState('')

  // The "add item to this brand" / "add a new loose good" mini-forms are
  // always-visible cards at the bottom of their section in the handoff
  // file — never behind a "show form" toggle.
  const [nlName, setNlName] = useState('')
  const [nlUnit, setNlUnit] = useState(UNIT_OPTIONS[0])
  const [nlCost, setNlCost] = useState('')
  const [nlSale, setNlSale] = useState('')
  const [nlCat, setNlCat] = useState<string | null>(null)

  const [aiName, setAiName] = useState('')
  const [aiUnit, setAiUnit] = useState(UNIT_OPTIONS[0])
  const [aiFlavor, setAiFlavor] = useState('')
  const [aiCost, setAiCost] = useState('')
  const [aiSale, setAiSale] = useState('')

  const activeDept = tree.find((d) => d.key === activeDeptKey)
  const activeCat = activeDept?.categories.find((c) => c.slug === activeCatSlug)
  const deptCounts = useMemo(() => countByDept(tree, catalog), [tree, catalog])
  const catalogByCategory = useMemo(() => groupByCategory(catalog), [catalog])
  const itemsInCat = activeCat ? (catalogByCategory[activeCat.slug] ?? []) : []

  // "Selected" now means "already in this shop's real stock" — ticked and
  // owned are the same thing since a tap commits immediately.
  const ownedCount = (entries: CatalogEntry[]) => entries.filter((e) => !availableForPick(e)).length

  const searchResults = useMemo(() => (query.trim() ? searchCatalogEntries(catalog, query) : []), [catalog, query])

  const brandCategories = useMemo(() => {
    const present = new Set<string>()
    for (const b of realBrands) for (const e of b.entries) present.add(e.item.category)
    return tree.flatMap((d) => d.categories).filter((c) => present.has(c.slug))
  }, [realBrands, tree])

  const visibleBrands = useMemo(() => {
    if (!catFilter) return realBrands
    return realBrands.filter((b) => b.entries.some((e) => e.item.category === catFilter))
  }, [realBrands, catFilter])

  const openBrand = realBrands.find((b) => b.brandSlug === openBrandSlug)

  const looseByCategory = useMemo(() => {
    const filtered = looseQuery.trim() ? searchCatalogEntries(looseEntries, looseQuery) : looseEntries
    const byCat = groupByCategory(filtered)
    return tree.flatMap((d) => d.categories).filter((c) => byCat[c.slug]?.length).map((c) => ({ slug: c.slug, entries: byCat[c.slug] }))
  }, [looseEntries, looseQuery, tree])
  const looseShownCount = looseByCategory.reduce((s, g) => s + g.entries.length, 0)
  const looseOnCount = looseEntries.filter((e) => !availableForPick(e)).length

  // Pre-commit field editing (row not owned yet) — a keystroke drops the
  // value into useCatalogSelection's basket, creating the draft row on
  // first touch if it doesn't exist yet. Nothing is saved until the tick.
  const ensureAndSet = <K extends 'cost_price_pkr' | 'unit_price_pkr' | 'unit'>(e: CatalogEntry, field: K, value: string) => {
    if (!selection.rows[e.key]) selection.selectMany([e])
    selection.setField(e.key, field, (field === 'unit' ? value : (value === '' ? '' : Number(value))) as never)
  }
  const draftValue = (e: CatalogEntry, field: 'cost_price_pkr' | 'unit_price_pkr' | 'unit', fallback: string | number) =>
    selection.rows[e.key] ? selection.rows[e.key][field] : fallback

  // Post-commit field editing (row already owned, a real shop_products
  // row) — a keystroke only ever touches local draft state; onBlur pushes
  // the real UPDATE. Never fights the input while the shopkeeper is still
  // typing the way an eager per-keystroke save would.
  const ownedFieldValue = (op: OwnedProduct, field: 'cost_price_pkr' | 'unit_price_pkr' | 'unit') => {
    const d = ownedDrafts[op.id]
    if (d && field in d) return d[field] as string | number
    return op[field] ?? ''
  }
  const setOwnedDraft = (opId: string, field: 'cost_price_pkr' | 'unit_price_pkr' | 'unit', value: string) => {
    setOwnedDrafts((d) => ({ ...d, [opId]: { ...d[opId], [field]: value } }))
  }
  const commitOwnedField = async (op: OwnedProduct, field: 'cost_price_pkr' | 'unit_price_pkr' | 'unit') => {
    const d = ownedDrafts[op.id]
    if (!d || !(field in d)) return
    const value: string | number = field === 'unit' ? String(d[field]) : (d[field] === '' ? 0 : Number(d[field]))
    const { error } = await supabase.from('shop_products').update({ [field]: value }).eq('id', op.id)
    if (error) { toast.error(friendlyError(error)); return }
    onBrandSubmitted()
  }

  // One binding per field, per row — hides the owned/not-owned branch
  // from every row component entirely.
  const bindCost = (e: CatalogEntry, owned: boolean): FieldBinding => {
    if (owned) { const op = findOwned(e)!; return { value: ownedFieldValue(op, 'cost_price_pkr'), onChange: (v) => setOwnedDraft(op.id, 'cost_price_pkr', v), onBlur: () => commitOwnedField(op, 'cost_price_pkr') } }
    return { value: draftValue(e, 'cost_price_pkr', ''), onChange: (v) => ensureAndSet(e, 'cost_price_pkr', v) }
  }
  const bindSale = (e: CatalogEntry, owned: boolean): FieldBinding => {
    if (owned) { const op = findOwned(e)!; return { value: ownedFieldValue(op, 'unit_price_pkr'), onChange: (v) => setOwnedDraft(op.id, 'unit_price_pkr', v), onBlur: () => commitOwnedField(op, 'unit_price_pkr') } }
    return { value: draftValue(e, 'unit_price_pkr', e.item.price ?? ''), onChange: (v) => ensureAndSet(e, 'unit_price_pkr', v) }
  }
  const bindUnit = (e: CatalogEntry, owned: boolean): FieldBinding => {
    if (owned) { const op = findOwned(e)!; return { value: ownedFieldValue(op, 'unit') || UNIT_OPTIONS[0], onChange: (v) => setOwnedDraft(op.id, 'unit', v), onBlur: () => commitOwnedField(op, 'unit') } }
    // A loose good's unit lives on item.flavor in ENGLISH ('kg') per
    // catalogSelection.ts, with the Urdu spelling ('کلو') on
    // item.flavor_ur — the <select>'s own <option>s (UNIT_OPTIONS) and
    // shop_products.unit's CHECK constraint are both Urdu-only, so the
    // Urdu spelling is the only one that's ever valid to default to
    // here, never the plain .flavor fallback the rest of this file uses
    // for actual product names/flavors.
    return { value: draftValue(e, 'unit', e.item.flavor_ur || UNIT_OPTIONS[0]), onChange: (v) => ensureAndSet(e, 'unit', v) }
  }

  // Builds the real shop_products insert row from whatever's currently
  // drafted for this entry (selection.rows, pre-commit scratch space) —
  // falling back to the catalog's own defaults for anything untouched.
  const buildInsertPayload = (e: CatalogEntry) => {
    const draft = selection.rows[e.key]
    const name = (draft?.name || e.item.name || '').trim()
    if (!name) return null
    return {
      shop_id: shopId,
      name, name_ur: (draft?.name_ur ?? e.item.name_ur ?? '').trim() || null,
      company: (draft?.brandName ?? e.brandName ?? '').trim() || null,
      company_ur: (draft?.brandName_ur ?? e.brandName_ur ?? '').trim() || null,
      category: e.item.category,
      flavor: (draft?.flavor ?? e.item.flavor ?? '').trim() || null,
      flavor_ur: (draft?.flavor_ur ?? e.item.flavor_ur ?? '').trim() || null,
      cost_price_pkr: draft && draft.cost_price_pkr !== '' ? Number(draft.cost_price_pkr) : 0,
      unit_price_pkr: draft && draft.unit_price_pkr !== '' ? Number(draft.unit_price_pkr) : (e.item.price ?? 0),
      quantity_on_hand: 0,
      // shop_products.unit is NOT NULL, CHECK-constrained to the 13 Urdu
      // values in UNIT_OPTIONS (migration 444) — a loose good's default
      // unit lives on item.flavor in ENGLISH ('kg'), with the Urdu
      // spelling on item.flavor_ur; using the English one here was
      // inserting a value the column's own CHECK constraint rejects
      // outright (this is what "select everything" was 400ing on — every
      // loose good in the batch failed the same way). An explicit null
      // would also be wrong: it overrides the column's own 'عدد' default
      // rather than falling back to it, so untouched branded items still
      // need the UNIT_OPTIONS[0] fallback at the end here.
      unit: (draft?.unit || (e.brandSlug === 'loose' ? e.item.flavor_ur : '') || '').trim() || UNIT_OPTIONS[0],
      is_active: true,
    }
  }

  // "Select everything"/"tick standard stock" can mean 100s of rows in
  // one go — chunked the same way ShopCatalogSection's old batch commit
  // used to, so a single insert never gets big enough to risk a
  // statement-size failure that would silently lose the whole batch.
  const COMMIT_CHUNK = 200
  const commitEntries = async (entries: CatalogEntry[]) => {
    const todo = entries.filter(availableForPick)
    if (todo.length === 0) return
    const rows = todo.map((e) => ({ e, payload: buildInsertPayload(e) })).filter((r): r is { e: CatalogEntry; payload: NonNullable<ReturnType<typeof buildInsertPayload>> } => !!r.payload)
    if (rows.length === 0) return
    setCommittingKeys((s) => new Set([...s, ...rows.map((r) => r.e.key)]))
    for (let i = 0; i < rows.length; i += COMMIT_CHUNK) {
      const chunk = rows.slice(i, i + COMMIT_CHUNK)
      const { error } = await supabase.from('shop_products').insert(chunk.map((r) => r.payload))
      if (error) {
        toast.error(friendlyError(error))
        setCommittingKeys((s) => { const n = new Set(s); rows.forEach((r) => n.delete(r.e.key)); return n })
        onBrandSubmitted()
        return
      }
    }
    setCommittingKeys((s) => { const n = new Set(s); rows.forEach((r) => n.delete(r.e.key)); return n })
    selection.deselectMany(rows.map((r) => r.e.key))
    onBrandSubmitted()
  }
  const uncommitEntries = async (entries: CatalogEntry[]) => {
    const todo = entries.filter((e) => !availableForPick(e))
    if (todo.length === 0) return
    const ids = todo.map(findOwned).filter((p): p is OwnedProduct => !!p).map((p) => p.id)
    if (ids.length === 0) return
    setCommittingKeys((s) => new Set([...s, ...todo.map((e) => e.key)]))
    const { error } = await supabase.from('shop_products').delete().in('id', ids)
    setCommittingKeys((s) => { const n = new Set(s); todo.forEach((e) => n.delete(e.key)); return n })
    if (error) { toast.error(friendlyError(error)); return }
    onBrandSubmitted()
  }
  const toggleOwned = (e: CatalogEntry) => { if (availableForPick(e)) commitEntries([e]); else uncommitEntries([e]) }

  const toggleWholeBrand = (entries: CatalogEntry[]) => {
    const allOwned = entries.length > 0 && entries.every((e) => !availableForPick(e))
    if (allOwned) uncommitEntries(entries)
    else commitEntries(entries)
  }
  const toggleWholeCategory = (slug: string) => {
    const entries = catalogByCategory[slug] ?? []
    const allOwned = entries.length > 0 && entries.every((e) => !availableForPick(e))
    if (allOwned) uncommitEntries(entries)
    else commitEntries(entries)
  }
  const catSelectedCount = (slug: string) => (catalogByCategory[slug] ?? []).filter((e) => !availableForPick(e)).length
  const catKeysAvailable = (slug: string) => (catalogByCategory[slug] ?? []).filter(availableForPick).map((e) => e.key)

  const takeStarterSet = () => commitEntries(starterSet)
  const takeEverything = () => commitEntries(catalog)

  const rowLabel = (e: CatalogEntry) => {
    const name = isUrdu && e.item.name_ur ? e.item.name_ur : e.item.name
    const flavor = isUrdu ? (e.item.flavor_ur || e.item.flavor) : e.item.flavor
    return flavor ? `${name} — ${flavor}` : name
  }

  const [addingLoose, setAddingLoose] = useState(false)
  const submitLooseGood = async () => {
    if (!nlName.trim() || !nlCat) return
    setAddingLoose(true)
    const { error } = await supabase.from('shop_products').insert({
      shop_id: shopId, name: nlName.trim(), category: nlCat, unit: nlUnit,
      cost_price_pkr: nlCost === '' ? 0 : Number(nlCost), unit_price_pkr: nlSale === '' ? 0 : Number(nlSale),
      quantity_on_hand: 0, is_active: true,
    })
    setAddingLoose(false)
    if (error) { toast.error(friendlyError(error)); return }
    setNlName(''); setNlCost(''); setNlSale('')
    onBrandSubmitted()
  }

  const [addingBrandItem, setAddingBrandItem] = useState(false)
  const submitBrandItem = async (brandName: string, brandName_ur: string, catSlug: string) => {
    if (!aiName.trim()) return
    setAddingBrandItem(true)
    const { error } = await supabase.from('shop_products').insert({
      shop_id: shopId, name: aiName.trim(), flavor: aiFlavor.trim() || null, unit: aiUnit,
      company: brandName || null, company_ur: brandName_ur || null, category: catSlug,
      cost_price_pkr: aiCost === '' ? 0 : Number(aiCost), unit_price_pkr: aiSale === '' ? 0 : Number(aiSale),
      quantity_on_hand: 0, is_active: true,
    })
    setAddingBrandItem(false)
    if (error) { toast.error(friendlyError(error)); return }
    setAiName(''); setAiFlavor(''); setAiCost(''); setAiSale('')
    onBrandSubmitted()
  }

  return (
    <div>
      <div className="relative mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('bs.searchCatalogPlaceholder')}
          className="w-full px-3 py-2.5 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[12px] font-sans text-dp-on-surface" />
      </div>

      {query.trim() ? (
        <div className="space-y-1.5">
          {searchResults.length === 0 ? (
            <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[12px]">{t('cb.noMatches')}</p>
          ) : searchResults.map((e) => {
            const owned = !availableForPick(e)
            return <ItemRow key={e.key} e={e} isUrdu={isUrdu} label={rowLabel(e)} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} />
          })}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <div className="flex items-center gap-1.5">
              {realBrands.length > 0 && (
                <>
                  <button onClick={() => setLens('brands')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10.5px] font-sans font-semibold cursor-pointer border ${lens === 'brands' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                    <Tags size={13} /> {t('bs.brandsLensTab')}
                  </button>
                  <button onClick={() => setLens('departments')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10.5px] font-sans font-semibold cursor-pointer border ${lens === 'departments' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                    <LayoutGrid size={13} /> {t('bs.deptLensTab')}
                  </button>
                </>
              )}
            </div>
            {catalog.length > 0 && (
              <div className="flex items-center gap-3">
                <button onClick={takeStarterSet} className="flex items-center gap-1 font-sans text-[10px] font-semibold text-dp-secondary hover:underline cursor-pointer"><Sparkles size={12} /> {t('bs.tickStandardStockBtn').replace('{n}', String(starterSet.length))}</button>
                <button onClick={takeEverything} className="font-sans text-[10px] font-semibold text-dp-secondary hover:underline cursor-pointer">{t('bs.selectEverythingBtn').replace('{n}', String(catalog.length))}</button>
              </div>
            )}
          </div>

          {lens === 'brands' ? (
            realBrands.length === 0 ? (
              <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[12px]">{t('bs.noBrandsForShopType')}</p>
            ) : openBrand ? (
              // ── S · brand catalog ────────────────────────────────────
              (() => {
                const byCat = groupByCategory(openBrand.entries)
                const selHere = ownedCount(openBrand.entries)
                const defaultCat = openBrand.entries[0]?.item.category ?? ''
                return (
                  <div>
                    <div className="flex items-center gap-3 bg-dp-primary text-white rounded-lg px-3.5 py-3 mb-3">
                      <div className="w-[42px] h-[42px] shrink-0 bg-white/15 rounded-lg flex items-center justify-center font-sans text-[9px] font-extrabold tracking-[0.02em]">{initials(openBrand.brandName)}</div>
                      <div className="min-w-0 flex-1">
                        <p className="font-sans text-[13px] font-bold truncate">{(isUrdu ? openBrand.brandName_ur : openBrand.brandName) || openBrand.brandName}</p>
                        <p className="font-sans text-[8.5px] tracking-[0.06em] opacity-70 truncate">{openBrand.brandName.toUpperCase()} · {t('bs.brandDefaultCatalogLabel')}</p>
                      </div>
                      <div className="shrink-0 text-end">
                        <p className="font-sans text-[8px] tracking-[0.08em] opacity-60">{t('bs.pickedLabel')}</p>
                        <p className="font-sans text-[15px] font-extrabold">{selHere}</p>
                      </div>
                    </div>
                    <p className="font-sans text-[10px] text-dp-on-surface-variant leading-6 mb-3">{t('bs.brandCatalogHint')}</p>

                    <div className="space-y-3 mb-4">
                      {Object.entries(byCat).map(([slug, entries]) => {
                        const groupSelected = ownedCount(entries)
                        return (
                          <div key={slug} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                            <div className="flex items-baseline gap-2 px-3 py-2.5 border-b-2 border-dp-outline-variant">
                              <span className="flex-1 font-sans text-[11.5px] font-semibold text-dp-on-surface">{getCategoryLabel(slug, isUrdu)}</span>
                              <button type="button" onClick={() => toggleWholeCategory(slug)} className="font-sans text-[9px] font-bold text-dp-secondary cursor-pointer">
                                {groupSelected === entries.length ? t('bs.tickedBtn') : t('bs.groupAllBtn')}
                              </button>
                            </div>
                            {entries.map((e) => {
                              const owned = !availableForPick(e)
                              const flavorLabel = (isUrdu ? (e.item.flavor_ur || e.item.flavor || e.item.name_ur) : (e.item.flavor || e.item.name)) || e.item.flavor || e.item.name
                              return <VariantRow key={e.key} e={e} t={t} flavorLabel={flavorLabel} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} cost={bindCost(e, owned)} sale={bindSale(e, owned)} />
                            })}
                          </div>
                        )
                      })}
                    </div>

                    <div className="bg-white border-2 border-dashed border-dp-secondary/60 rounded-lg p-3.5 mb-4">
                      <p className="font-sans text-[8px] font-bold tracking-[0.1em] text-dp-secondary">{t('bs.addItemToBrandKicker')}</p>
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface mt-0.5">{t('bs.addItemToBrandHeading')}</p>
                      <p className="font-sans text-[9.5px] text-dp-on-surface-variant leading-6 mt-1">{t('bs.addItemToBrandHint')}</p>
                      <div className="flex gap-1.5 mt-3">
                        <input value={aiName} onChange={(e) => setAiName(e.target.value)} placeholder={t('bs.itemNamePlaceholder')} className="input-field flex-1 min-w-0 text-[10.5px] py-2" />
                        <select value={aiUnit} onChange={(e) => setAiUnit(e.target.value)} className="shrink-0 w-24 px-2 rounded-lg border border-dp-outline-variant bg-white font-sans text-[10.5px] text-dp-on-surface">
                          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      <div className="flex gap-1.5 mt-1.5">
                        <input value={aiFlavor} onChange={(e) => setAiFlavor(e.target.value)} placeholder={t('bs.flavorOrSizePlaceholder')} className="input-field flex-1 min-w-0 text-[10.5px] py-2" />
                        <input value={aiCost} onChange={(e) => setAiCost(e.target.value)} inputMode="decimal" placeholder={t('bs.costPlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-outline-variant bg-dp-surface-container text-center font-sans text-[10.5px]" />
                        <input value={aiSale} onChange={(e) => setAiSale(e.target.value)} inputMode="decimal" placeholder={t('bs.salePlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-secondary bg-white text-center font-sans text-[10.5px] font-bold" />
                      </div>
                      <button onClick={() => submitBrandItem(openBrand.brandName, openBrand.brandName_ur, defaultCat)} disabled={addingBrandItem}
                        className="w-full mt-2.5 py-2.5 rounded-lg bg-dp-secondary text-white font-sans text-[10.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-60 flex items-center justify-center gap-1.5">
                        {addingBrandItem && <Loader2 size={13} className="animate-spin" />} {t('bs.addToCatalogBtn')}
                      </button>
                    </div>

                    <div className="flex gap-2">
                      <button onClick={() => setOpenBrandSlug(null)} className="flex-1 py-3 rounded-lg bg-dp-secondary text-white font-sans text-[11px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                        {t('bs.saveToShopBtn')}
                      </button>
                      <button onClick={() => setOpenBrandSlug(null)} className="shrink-0 px-4 py-3 rounded-lg border border-dp-outline-variant font-sans text-[11px] font-semibold text-dp-on-surface-variant cursor-pointer hover:bg-dp-surface-container">
                        {t('bs.moreBrandsBtn')}
                      </button>
                    </div>
                  </div>
                )
              })()
            ) : (
              // ── S · catalog · brands ─────────────────────────────────
              <>
                <p className="font-sans text-[10px] text-dp-on-surface-variant leading-6 mb-3">{t('bs.catalogIntroHint')}</p>

                {brandCategories.length > 0 && (
                  <div className="flex items-center gap-1.5 mb-3 overflow-x-auto pb-1">
                    <button onClick={() => setCatFilter(null)} className={`shrink-0 px-2.5 py-1 rounded-full text-[9.5px] font-sans font-semibold cursor-pointer border ${!catFilter ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{t('cb.allTab')}</button>
                    {brandCategories.map((c) => (
                      <button key={c.slug} onClick={() => setCatFilter(c.slug)} className={`shrink-0 px-2.5 py-1 rounded-full text-[9.5px] font-sans font-semibold cursor-pointer border ${catFilter === c.slug ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{isUrdu ? c.label_ur : c.label}</button>
                    ))}
                  </div>
                )}

                {onScanClick && (
                  <button onClick={onScanClick}
                    className="w-full flex items-center gap-2 px-3.5 py-3 rounded-lg bg-dp-primary text-white font-sans text-[10.5px] cursor-pointer hover:bg-dp-secondary transition-all mb-2">
                    <Camera size={16} /> <span className="flex-1 text-start">{t('bs.scanFromCatalogBtn')}</span>
                  </button>
                )}
                <button onClick={() => setShowBrandBuilder(true)}
                  className="w-full flex items-center gap-2 px-3.5 py-3 rounded-lg border-2 border-dashed border-dp-secondary/60 text-dp-secondary font-sans text-[10.5px] cursor-pointer hover:bg-dp-secondary-container/20 transition-all mb-3">
                  <PackagePlus size={16} /> <span className="flex-1 text-start">{t('bs.newBrandFromCatalogBtn')}</span>
                </button>

                {visibleBrands.length === 0 ? (
                  <p className="font-sans text-[10px] text-dp-on-surface-variant border border-dp-outline-variant rounded-lg bg-white p-3.5 leading-6">{t('bs.noBrandsInCategoryHint')}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2.5">
                    {visibleBrands.map((b) => {
                      const selHere = ownedCount(b.entries)
                      const fullySelected = selHere === b.entries.length
                      const catSlug = b.entries[0]?.item.category
                      return (
                        <div key={b.brandSlug} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex flex-col">
                          <div className="flex items-start gap-2">
                            <div className="w-[34px] h-[34px] shrink-0 bg-dp-surface-container border border-dp-outline-variant rounded-lg flex items-center justify-center font-sans text-[8px] font-extrabold tracking-[0.02em] text-center leading-tight p-0.5">{initials(b.brandName)}</div>
                            <div className="min-w-0 flex-1">
                              <p className="font-sans text-[10.5px] leading-tight text-dp-on-surface truncate">{(isUrdu ? b.brandName_ur : b.brandName) || b.brandName}</p>
                              <p className="font-sans text-[8px] tracking-[0.08em] text-dp-on-surface-variant truncate">{b.brandName.toUpperCase()}</p>
                            </div>
                          </div>
                          <p className="font-sans text-[8.5px] text-dp-on-surface-variant mt-1.5">
                            {catSlug ? getCategoryLabel(catSlug, isUrdu) : ''} · {b.entries.length} {t('mk.productsCount')}
                          </p>
                          <div className="flex items-center gap-1.5 mt-2">
                            <button type="button" onClick={() => toggleWholeBrand(b.entries)}
                              className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg font-sans text-[9px] font-bold cursor-pointer border ${fullySelected ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                              {fullySelected && <Check size={12} strokeWidth={3} />} {fullySelected ? t('bs.tickedBtn') : t('bs.tickBtn')}
                            </button>
                            <button type="button" onClick={() => setOpenBrandSlug(b.brandSlug)}
                              className="shrink-0 px-2.5 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[9px] font-semibold text-dp-on-surface-variant cursor-pointer hover:bg-dp-surface-container">
                              {t('bs.catalogBtn')}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Loose goods — its own visually distinct section, never a
                    fake "brand" card above. */}
                {looseEntries.length > 0 && (
                  <div className="mt-6">
                    <div className="flex items-end justify-between gap-3 border-b-2 border-dp-primary pb-2">
                      <div>
                        <p className="font-sans text-[8px] font-bold text-dp-secondary uppercase tracking-[0.14em]">{t('bs.nonBrandedKicker')}</p>
                        <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('bs.looseGoodsHeading')}</p>
                      </div>
                      <p className="font-sans text-[9px] text-dp-on-surface-variant pb-0.5">{t('bs.looseOnLabel').replace('{n}', String(looseOnCount))}</p>
                    </div>
                    <p className="font-sans text-[9.5px] text-dp-on-surface-variant mt-2 mb-3">{t('bs.looseGoodsHint')}</p>

                    <div className="flex items-center gap-2 border-2 border-dp-primary bg-white px-3 py-2 mb-3 rounded-lg">
                      <Search size={15} className="text-dp-on-surface-variant shrink-0" />
                      <input value={looseQuery} onChange={(e) => setLooseQuery(e.target.value)} placeholder={t('bs.searchLooseGoodsPlaceholder')}
                        className="flex-1 min-w-0 font-sans text-[11px] text-dp-on-surface outline-none bg-transparent" />
                      {looseQuery && <button onClick={() => setLooseQuery('')} className="shrink-0 font-sans text-[10px] font-semibold text-dp-secondary cursor-pointer">{t('bs.clearBtn')}</button>}
                      <span className="shrink-0 font-sans text-[9px] text-dp-on-surface-variant ltr-num">{looseShownCount}</span>
                    </div>

                    {looseByCategory.length === 0 ? (
                      <p className="font-sans text-[10px] text-dp-on-surface-variant border border-dp-outline-variant rounded-lg bg-white p-3.5 leading-6">{t('bs.noLooseHitsHint')}</p>
                    ) : (
                      <div className="space-y-3">
                        {looseByCategory.map((g) => (
                          <div key={g.slug}>
                            <div className="flex items-baseline gap-2 bg-dp-primary text-white px-3 py-2 rounded-lg">
                              <span className="flex-1 font-sans text-[10.5px] font-semibold">{getCategoryLabel(g.slug, isUrdu)}</span>
                              <span className="font-sans text-[9px] opacity-80 ltr-num">{g.entries.length}</span>
                            </div>
                            <div className="space-y-1.5 mt-1.5">
                              {g.entries.map((e) => {
                                const owned = !availableForPick(e)
                                const name = (isUrdu ? e.item.name_ur : e.item.name) || e.item.name
                                return <LooseRow key={e.key} t={t} name={name} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} unit={bindUnit(e, owned)} cost={bindCost(e, owned)} sale={bindSale(e, owned)} />
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="bg-white border-2 border-dashed border-dp-primary rounded-lg p-3.5 mt-3">
                      <p className="font-sans text-[8px] font-bold tracking-[0.1em] text-dp-on-surface-variant">{t('bs.addLooseGoodKicker')}</p>
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface mt-0.5">{t('bs.addLooseGoodBtn')}</p>
                      <p className="font-sans text-[9.5px] text-dp-on-surface-variant leading-6 mt-1">{t('bs.addLooseGoodFormHint')}</p>
                      <div className="flex gap-1.5 mt-3">
                        <input value={nlName} onChange={(e) => setNlName(e.target.value)} placeholder={t('bs.looseGoodNamePlaceholder')} className="input-field flex-1 min-w-0 text-[10.5px] py-2" />
                        <select value={nlUnit} onChange={(e) => setNlUnit(e.target.value)} className="shrink-0 w-24 px-2 rounded-lg border border-dp-outline-variant bg-white font-sans text-[10.5px] text-dp-on-surface">
                          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className="flex-1 min-w-0 font-sans text-[9.5px] text-dp-on-surface-variant truncate">{t('bs.categoryPrefixLabel').replace('{name}', nlCat ? getCategoryLabel(nlCat, isUrdu) : '—')}</span>
                        <input value={nlCost} onChange={(e) => setNlCost(e.target.value)} inputMode="decimal" placeholder={t('bs.costPlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-outline-variant bg-dp-surface-container text-center font-sans text-[10.5px]" />
                        <input value={nlSale} onChange={(e) => setNlSale(e.target.value)} inputMode="decimal" placeholder={t('bs.salePlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-secondary bg-white text-center font-sans text-[10.5px] font-bold" />
                      </div>
                      <div className="flex items-center gap-1.5 mt-2.5 overflow-x-auto pb-1">
                        {tree.flatMap((d) => d.categories).map((c) => (
                          <button key={c.slug} onClick={() => setNlCat(c.slug)} className={`shrink-0 px-2.5 py-1 rounded-full text-[9px] font-sans font-semibold cursor-pointer border ${nlCat === c.slug ? 'bg-dp-primary text-white border-dp-primary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{isUrdu ? c.label_ur : c.label}</button>
                        ))}
                      </div>
                      <button onClick={submitLooseGood} disabled={addingLoose}
                        className="w-full mt-2.5 py-2.5 rounded-lg bg-dp-primary text-white font-sans text-[10.5px] cursor-pointer hover:bg-dp-secondary transition-all disabled:opacity-60 flex items-center justify-center gap-1.5">
                        {addingLoose && <Loader2 size={13} className="animate-spin" />} {t('bs.addToLooseGoodsBtn')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )
          ) : !activeDept ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {tree.map((d) => {
                const total = deptCounts[d.key] ?? 0
                const selHere = ownedCount(catalog.filter((e) => d.categories.some((c) => c.slug === e.item.category)))
                return (
                  <button key={d.key} onClick={() => { setActiveDeptKey(d.key); setActiveCatSlug(null) }}
                    className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                    <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-dp-secondary-container/40 text-dp-secondary"><DynamicIcon name={d.icon} size={22} /></div>
                    <span className="font-sans text-[10.5px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? d.label_ur : d.label}</span>
                    <span className="font-sans text-[8.5px] font-bold text-dp-on-surface-variant">{total === 0 ? t('bs.noCatalogItems') : `${selHere} / ${total}`}</span>
                  </button>
                )
              })}
            </div>
          ) : !activeCat ? (
            <>
              <div className="flex items-center gap-1.5 mb-3 font-sans text-[11px]">
                <button onClick={() => setActiveDeptKey(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
                <ArrowRight size={14} className="text-dp-on-surface-variant rotate-180 rtl:rotate-0" />
                <span className="font-semibold text-dp-on-surface">{isUrdu ? activeDept.label_ur : activeDept.label}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {activeDept.categories.map((c) => {
                  const total = (catalogByCategory[c.slug] ?? []).length
                  const selHere = catSelectedCount(c.slug)
                  const availableHere = catKeysAvailable(c.slug)
                  return (
                    <div key={c.slug} className="relative">
                      <button onClick={() => setActiveCatSlug(c.slug)}
                        className="w-full flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                        <div className="w-11 h-11 rounded-lg flex items-center justify-center bg-dp-secondary-container/40 text-dp-secondary"><DynamicIcon name={activeDept.icon} size={20} /></div>
                        <span className="font-sans text-[10px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? c.label_ur : c.label}</span>
                        <span className="font-sans text-[8px] font-bold text-dp-on-surface-variant">{total === 0 ? t('bs.noCatalogItems') : `${selHere} / ${total}`}</span>
                      </button>
                      {total > 0 && availableHere.length > 0 && (
                        <button type="button" onClick={(ev) => { ev.stopPropagation(); toggleWholeCategory(c.slug) }} title={t('bs.selectWholeCategory')}
                          className={`absolute top-1.5 end-1.5 w-6 h-6 rounded flex items-center justify-center border-2 cursor-pointer ${selHere === total ? 'bg-dp-secondary border-dp-secondary' : 'bg-white border-dp-outline-variant'}`}>
                          {selHere === total && <Check size={13} className="text-white" strokeWidth={3} />}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mb-3 font-sans text-[11px] flex-wrap">
                <button onClick={() => setActiveDeptKey(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
                <ArrowRight size={14} className="text-dp-on-surface-variant rotate-180 rtl:rotate-0" />
                <button onClick={() => setActiveCatSlug(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu ? activeDept.label_ur : activeDept.label}</button>
                <ArrowRight size={14} className="text-dp-on-surface-variant rotate-180 rtl:rotate-0" />
                <span className="font-semibold text-dp-on-surface">{isUrdu ? activeCat.label_ur : activeCat.label}</span>
              </div>
              {itemsInCat.length === 0 ? (
                <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[12px]">{t('bs.noCatalogItemsHint')}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <button onClick={() => toggleWholeCategory(activeCat.slug)} className="flex items-center gap-1.5 font-sans text-[10.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">
                      {catSelectedCount(activeCat.slug) === itemsInCat.length ? t('bs.deselectAllHere') : t('bs.selectAllHere')}
                    </button>
                    <span className="font-sans text-[9.5px] font-bold text-dp-on-surface-variant">{catSelectedCount(activeCat.slug)} / {itemsInCat.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {itemsInCat.map((e) => {
                      const owned = !availableForPick(e)
                      return <ItemRow key={e.key} e={e} isUrdu={isUrdu} label={rowLabel(e)} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} />
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {showBrandBuilder && (
        <BrandBuilderModal shopId={shopId} primaryType={primaryType} onClose={() => setShowBrandBuilder(false)} onSubmitted={onBrandSubmitted} />
      )}
    </div>
  )
}
