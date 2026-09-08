'use client'

// Brand-first catalog browsing for the shop's "Add Stock" tab — a literal
// port of the "Village Portal Marketplace" design handoff's own catalog
// screens (Shop Portal v3.dc.html: "S · catalog · brands" and "S · brand
// catalog"), not a reinterpretation. Departments stays a secondary lens
// (toggle at the top, not in the handoff file at all) for the handful of
// categories with no brand coverage.
//
// Ticking commits immediately — there is no separate "Save" step here at
// all. A tap on an un-owned row inserts it into shop_products right then
// at cost=0/sale=0 and a default unit; a tap on an already-owned row
// opens that product's own edit form instead of un-ticking (removing)
// it — un-ticking one row at a time to delete stopped being the point
// once there was nothing left to edit inline (uncommitEntries is still
// real and still used, just from the whole-brand/whole-category/
// select-everything toggles, where "everything here is already owned,
// tapping again means remove all of it" is still the right call).
// Pricing was originally settable right here too (an editable cost/
// sale/unit per row, both before and after the tick), but that meant
// three different places could set a product's price (here, again
// after ticking, and the actual product edit form) with no clear answer
// for which one was "the real one" — a real, confirmed complaint. The
// pencil button on the product edit form (my-shop/page.tsx's openEdit)
// is now the ONLY place price/sale/unit/expiry get set; an owned row
// here shows those values read-only.
//
// ItemRow is hoisted to module scope on purpose — defining it inside
// BrandItemPicker's own function body (an earlier version of this file
// did, back when rows had their own price inputs) gives every row a
// brand-new component identity on every re-render, and React remounts a
// function component whose identity changed since the last render.
// Hoisted here, only its *props* change between renders.

import { useMemo, useRef, useState } from 'react'
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
import { MarqueeText } from './MarqueeText'
import type { CatalogSelection } from '@/hooks/useCatalogSelection'

interface OwnedProduct {
  id: string; name: string; flavor?: string | null
  cost_price_pkr?: number; unit_price_pkr?: number; unit?: string; quantity_on_hand?: number
}

interface BrandItemPickerProps {
  shopId: string
  primaryType: string
  ownedProducts: OwnedProduct[]
  selection: CatalogSelection
  onBrandSubmitted: () => void
  onScanClick?: () => void
  // A row that's already owned shows its real cost/sale/margin/stock
  // (read-only — see ItemRow's own comment) and tapping it comes here
  // instead of un-ticking it, wired to the same pencil-button edit form
  // as everywhere else. Optional only so a caller that hasn't wired it
  // yet still falls back to the old toggle-to-remove behavior.
  onEditOwned?: (productId: string) => void
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

// Pricing is deliberately NOT settable anywhere in this file — a real
// complaint, confirmed as a real inconsistency: a shopkeeper could set
// cost/sale/unit right here at tick-time (VariantRow/LooseRow's own
// inline fields, now removed), again after ticking (owned-row inline
// editing, also removed), or via the actual product edit form's pencil
// button — three different places doing the same job, easy to lose
// track of which one you last touched. The pencil button (my-shop/
// page.tsx's openEdit) is now the ONLY place price/sale/unit/expiry get
// set. An unowned row is purely tick-to-add-at-default-price, exactly
// like before; an OWNED row shows its real cost/sale/margin/stock
// read-only and tapping it opens that same edit form instead of
// un-ticking (removing) it — un-ticking to delete stopped making sense
// as the only interaction once there was nothing left to edit inline.
// VariantRow and LooseRow used to be separate, wider components
// specifically to fit those now-removed inputs; with nothing left to
// fit, they're gone and every row in this file (plain items, brand
// variants, loose goods) renders through this one shared component.
interface ItemRowProps {
  e: CatalogEntry; isUrdu: boolean; label: string; owned: boolean; busy: boolean; onToggle: () => void
  ownedInfo?: OwnedProduct; onEdit?: () => void; t: (k: string) => string
}
function ItemRow({ e, isUrdu, label, owned, busy, onToggle, ownedInfo, onEdit, t }: ItemRowProps) {
  const cost = ownedInfo?.cost_price_pkr ?? 0
  const sale = ownedInfo?.unit_price_pkr ?? 0
  const margin = sale > 0 ? Math.round(((sale - cost) / sale) * 100) : null
  const handleClick = owned && onEdit ? onEdit : onToggle
  return (
    <button type="button" disabled={!owned && busy} onClick={handleClick}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg border text-start transition-all ${owned ? 'bg-dp-secondary-container/40 border-dp-secondary' : 'bg-white border-dp-outline-variant hover:border-dp-secondary'} ${!owned && busy ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}>
      <span className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border-2 ${owned ? 'bg-dp-secondary border-dp-secondary' : 'border-dp-outline-variant'}`}>
        {busy ? <Loader2 size={12} className="text-dp-secondary animate-spin" /> : owned && <Check size={13} className="text-white" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <MarqueeText text={label} className="font-sans text-[13px] font-semibold text-dp-on-surface" />
        {owned && ownedInfo ? (
          // Same boxed/tinted look VariantRow's own cost+sale inputs used
          // to have (amber box for cost, secondary-bordered box for
          // sale) — read-only now, but sized and styled like real
          // values worth reading at a glance, not a small caption line.
          <span className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <span className="px-2 py-1 rounded-lg border border-dp-outline-variant bg-dp-surface-container font-sans text-[11px] text-dp-on-surface ltr-num">{t('sl.costCol')} {cost}</span>
            <span className="px-2 py-1 rounded-lg border border-dp-secondary bg-white font-sans text-[11px] font-bold text-dp-secondary ltr-num">{t('sl.saleCol')} {sale}</span>
            {margin !== null && <span className={`px-2 py-1 rounded-lg font-sans text-[11px] font-bold ltr-num ${margin < 0 ? 'text-dp-error bg-dp-error-container' : 'text-emerald-700 bg-emerald-50'}`}>{margin}%</span>}
            <span className="px-2 py-1 rounded-lg border border-dp-outline-variant bg-white font-sans text-[11px] text-dp-on-surface-variant ltr-num">{t('mk.stockLabel')} {ownedInfo.quantity_on_hand ?? 0} {ownedInfo.unit}</span>
          </span>
        ) : (
          <span className="block font-sans text-[9.5px] text-dp-on-surface-variant truncate mt-0.5">{getCategoryLabel(e.item.category, isUrdu)}</span>
        )}
      </span>
      {!owned && e.item.price ? <span className="shrink-0 font-sans text-[10px] font-bold text-dp-secondary">~{e.item.price}</span> : null}
    </button>
  )
}

export function BrandItemPicker({ shopId, primaryType, ownedProducts, selection, onBrandSubmitted, onScanClick, onEditOwned }: BrandItemPickerProps) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [committingKeys, setCommittingKeys] = useState<Set<string>>(new Set())
  // Real duplicate-row bug found live (migration 448's own header has the
  // full story): a double-tap on "tick whole brand" fired commitEntries
  // twice before the first insert's React state update had landed, so
  // both calls computed "not yet owned" from the same stale `products`
  // snapshot and inserted the exact same batch twice. `committingKeys`
  // (state) can't close that race — state updates aren't synchronous, so
  // a second synchronous call in the same tick still reads the old set.
  // A plain ref IS synchronous, so it actually blocks the second call.
  const pendingKeysRef = useRef<Set<string>>(new Set())
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const looseEntries = useMemo(() => looseGoodsAsCatalogEntries(primaryType), [primaryType])
  const catalog = useMemo(() => [...getCatalogForShopType(primaryType), ...looseEntries], [primaryType, looseEntries])
  const realBrands = useMemo(() => brandsForShopType(primaryType), [primaryType])
  const starterSet = useMemo(() => starterSetEntries(primaryType), [primaryType])
  const ownedKeys = useMemo(() => new Set(ownedProducts.map((p) => ownedKey(p.name, p.flavor))), [ownedProducts])
  // Real bug found live: a loose good's catalog entry carries its default
  // UNIT in item.flavor (e.g. 'کلو') for display purposes only —
  // buildInsertPayload below deliberately saves that as flavor: null,
  // since a loose good has no real flavor. Comparing ownership with the
  // raw unit-hint instead of that same null meant a loose good, once
  // added, could never be recognized as owned — its row never showed
  // ticked, and tapping it again just tried (and silently failed, on a
  // dedupe conflict) to insert the same item a second time. Mirrors
  // buildInsertPayload's own `e.brandSlug === 'loose' ? null : ...` check
  // exactly, so "is this owned" and "what got saved" always agree.
  const catalogFlavorForOwnership = (e: CatalogEntry) => (e.brandSlug === 'loose' ? null : e.item.flavor)
  const availableForPick = (e: CatalogEntry) => !ownedKeys.has(ownedKey(e.item.name, catalogFlavorForOwnership(e)))
  const findOwned = (e: CatalogEntry) => ownedProducts.find((p) => ownedKey(p.name, p.flavor) === ownedKey(e.item.name, catalogFlavorForOwnership(e)))

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
  // file — never behind a "show form" toggle. No price/sale/unit fields
  // here (or anywhere in this file) — every new row lands at cost=0/
  // sale=0/default unit and gets its real numbers set exactly once, via
  // the product edit form's pencil button. See this file's own top
  // comment on ItemRow for why.
  const [nlName, setNlName] = useState('')
  const [nlCat, setNlCat] = useState<string | null>(null)

  const [aiName, setAiName] = useState('')
  const [aiFlavor, setAiFlavor] = useState('')

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
      // A real bug found live: for a loose good, item.flavor/flavor_ur is
      // NOT a real flavor at all — it's catalogSelection.ts's own reused
      // storage for "this loose good's default unit" (e.g. 'kg'/'کلو',
      // 'dozen'/'درجن'), the exact same fields the `unit:` line below
      // deliberately reads from for that reason. Falling through to
      // e.item.flavor here for a loose good was writing that unit hint
      // into the real flavor column — every single loose good ever
      // ticked ended up with a flavor of "kg"/"dozen"/"piece"/etc.,
      // never a real flavor, since loose goods don't have one. Confirmed
      // live: 43 rows in one shop alone, all with this exact pollution.
      flavor: e.brandSlug === 'loose' ? null : (draft?.flavor ?? e.item.flavor ?? '').trim() || null,
      flavor_ur: e.brandSlug === 'loose' ? null : (draft?.flavor_ur ?? e.item.flavor_ur ?? '').trim() || null,
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
    // pendingKeysRef, not just availableForPick (which reads the `products`
    // prop — only updated once onBrandSubmitted's reload actually lands),
    // is what stops a double-tap from re-submitting the same batch before
    // that reload catches up. See the ref's own comment above.
    const todo = entries.filter(availableForPick).filter((e) => !pendingKeysRef.current.has(e.key))
    if (todo.length === 0) return
    const rows = todo.map((e) => ({ e, payload: buildInsertPayload(e) })).filter((r): r is { e: CatalogEntry; payload: NonNullable<ReturnType<typeof buildInsertPayload>> } => !!r.payload)
    if (rows.length === 0) return
    rows.forEach((r) => pendingKeysRef.current.add(r.e.key))
    setCommittingKeys((s) => new Set([...s, ...rows.map((r) => r.e.key)]))
    try {
      for (let i = 0; i < rows.length; i += COMMIT_CHUNK) {
        const chunk = rows.slice(i, i + COMMIT_CHUNK)
        const { error } = await supabase.from('shop_products').insert(chunk.map((r) => r.payload))
        if (error) {
          // shop_products_dedupe_idx (migration 448): something in this
          // chunk already exists for this shop — a second tab, a retried
          // request, or the exact race the ref-guard above exists to
          // close. Retry the chunk one row at a time so only the actual
          // collision(s) get skipped instead of silently dropping every
          // other genuinely-new item that happened to share this chunk.
          if (error.code === '23505') {
            for (const r of chunk) {
              const { error: rowError } = await supabase.from('shop_products').insert(r.payload)
              if (rowError && rowError.code !== '23505') toast.error(friendlyError(rowError))
            }
            continue
          }
          toast.error(friendlyError(error))
          return
        }
      }
      selection.deselectMany(rows.map((r) => r.e.key))
    } finally {
      setCommittingKeys((s) => { const n = new Set(s); rows.forEach((r) => n.delete(r.e.key)); return n })
      rows.forEach((r) => pendingKeysRef.current.delete(r.e.key))
      onBrandSubmitted()
    }
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
    // No cost/sale/unit here — lands at cost=0/sale=0/کلو (the overwhelming
    // common case for a loose good) and gets its real numbers set via the
    // pencil button, same as every other row in this file.
    const { error } = await supabase.from('shop_products').insert({
      shop_id: shopId, name: nlName.trim(), category: nlCat, unit: 'کلو',
      cost_price_pkr: 0, unit_price_pkr: 0,
      quantity_on_hand: 0, is_active: true,
    })
    setAddingLoose(false)
    if (error) { toast.error(friendlyError(error)); return }
    setNlName('')
    onBrandSubmitted()
  }

  const [addingBrandItem, setAddingBrandItem] = useState(false)
  const submitBrandItem = async (brandName: string, brandName_ur: string, catSlug: string) => {
    if (!aiName.trim()) return
    setAddingBrandItem(true)
    const { error } = await supabase.from('shop_products').insert({
      shop_id: shopId, name: aiName.trim(), flavor: aiFlavor.trim() || null, unit: UNIT_OPTIONS[0],
      company: brandName || null, company_ur: brandName_ur || null, category: catSlug,
      cost_price_pkr: 0, unit_price_pkr: 0,
      quantity_on_hand: 0, is_active: true,
    })
    setAddingBrandItem(false)
    if (error) { toast.error(friendlyError(error)); return }
    setAiName(''); setAiFlavor('')
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
            return <ItemRow key={e.key} e={e} isUrdu={isUrdu} label={rowLabel(e)} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} t={t} ownedInfo={owned ? findOwned(e) : undefined} onEdit={owned ? () => { const op = findOwned(e); if (op) onEditOwned?.(op.id) } : undefined} />
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
                {/* Disabled while anything is mid-commit — these two act on
                    hundreds of rows at once, so a double-tap here was the
                    worst-case version of the race migration 448 fixes at
                    the DB level; this is the belt to that braces. */}
                <button onClick={takeStarterSet} disabled={committingKeys.size > 0} className="flex items-center gap-1 font-sans text-[10px] font-semibold text-dp-secondary hover:underline cursor-pointer disabled:opacity-60 disabled:cursor-wait disabled:no-underline"><Sparkles size={12} /> {t('bs.tickStandardStockBtn').replace('{n}', String(starterSet.length))}</button>
                <button onClick={takeEverything} disabled={committingKeys.size > 0} className="font-sans text-[10px] font-semibold text-dp-secondary hover:underline cursor-pointer disabled:opacity-60 disabled:cursor-wait disabled:no-underline">{t('bs.selectEverythingBtn').replace('{n}', String(catalog.length))}</button>
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
                              {/* eslint-disable-next-line react-hooks/refs -- toggleWholeCategory -> commitEntries only reads pendingKeysRef.current inside the click handler body, never during render */}
                              <button type="button" onClick={() => toggleWholeCategory(slug)} className="font-sans text-[9px] font-bold text-dp-secondary cursor-pointer">
                                {groupSelected === entries.length ? t('bs.tickedBtn') : t('bs.groupAllBtn')}
                              </button>
                            </div>
                            {entries.map((e) => {
                              const owned = !availableForPick(e)
                              // eslint-disable-next-line react-hooks/refs -- toggleOwned -> commitEntries only reads pendingKeysRef.current inside the click handler body, never during render
                              return <ItemRow key={e.key} e={e} isUrdu={isUrdu} label={rowLabel(e)} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} t={t} ownedInfo={owned ? findOwned(e) : undefined} onEdit={owned ? () => { const op = findOwned(e); if (op) onEditOwned?.(op.id) } : undefined} />
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
                        <input value={aiName} onChange={(e) => setAiName(e.target.value)} placeholder={t('bs.itemNamePlaceholder')} className="input-field flex-1 min-w-0 text-[12px] py-2.5" />
                        <input value={aiFlavor} onChange={(e) => setAiFlavor(e.target.value)} placeholder={t('bs.flavorOrSizePlaceholder')} className="input-field flex-1 min-w-0 text-[12px] py-2.5" />
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
                      const brandBusy = b.entries.some((e) => committingKeys.has(e.key))
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
                            <button type="button" disabled={brandBusy} onClick={() => toggleWholeBrand(b.entries)}
                              className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg font-sans text-[9px] font-bold cursor-pointer border disabled:opacity-60 disabled:cursor-wait ${fullySelected ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                              {brandBusy ? <Loader2 size={12} className="animate-spin" /> : fullySelected && <Check size={12} strokeWidth={3} />} {fullySelected ? t('bs.tickedBtn') : t('bs.tickBtn')}
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
                                return <ItemRow key={e.key} e={e} isUrdu={isUrdu} label={name} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} t={t} ownedInfo={owned ? findOwned(e) : undefined} onEdit={owned ? () => { const op = findOwned(e); if (op) onEditOwned?.(op.id) } : undefined} />
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
                      <div className="flex items-center gap-1.5 mt-3">
                        <input value={nlName} onChange={(e) => setNlName(e.target.value)} placeholder={t('bs.looseGoodNamePlaceholder')} className="input-field flex-1 min-w-0 text-[12px] py-2.5" />
                        <span className="shrink-0 font-sans text-[10px] text-dp-on-surface-variant">{t('bs.categoryPrefixLabel').replace('{name}', nlCat ? getCategoryLabel(nlCat, isUrdu) : '—')}</span>
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
                      return <ItemRow key={e.key} e={e} isUrdu={isUrdu} label={rowLabel(e)} owned={owned} busy={committingKeys.has(e.key)} onToggle={() => toggleOwned(e)} t={t} ownedInfo={owned ? findOwned(e) : undefined} onEdit={owned ? () => { const op = findOwned(e); if (op) onEditOwned?.(op.id) } : undefined} />
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
