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
// Cost/sale/unit are editable on every row BEFORE it's ticked, matching
// the handoff exactly — ensureAndSet() below adds the row to the basket
// the moment any of its fields is touched (useCatalogSelection only ever
// tracks ticked rows), so typing a price doesn't require tapping the
// checkbox first. Colors/corners flow through the dp-* tokens (see
// .shop-ink-theme in globals.css) so this file stays shared with the
// admin shop screen's own green theme unchanged.

import { useMemo, useState } from 'react'
import { ArrowRight, Check, LayoutGrid, Tags, Sparkles, PackagePlus, Search, Camera } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree, getCategoryLabel } from '@/lib/shopTypes'
import {
  getCatalogForShopType, brandsForShopType, selectedCountByBrand, starterSetEntries,
  groupByCategory, countByDept, searchCatalogEntries, ownedKey, looseGoodsAsCatalogEntries, UNIT_OPTIONS, type CatalogEntry,
} from '@/lib/catalogSelection'
import { DynamicIcon } from './DynamicIcon'
import { BrandBuilderModal } from './BrandBuilderModal'
import type { CatalogSelection, BasketRow } from '@/hooks/useCatalogSelection'

interface OwnedProduct { name: string; flavor?: string | null }

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

export function BrandItemPicker({ shopId, primaryType, ownedProducts, selection, onBrandSubmitted, onScanClick }: BrandItemPickerProps) {
  const { t, isUrdu } = useLocale()
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const looseEntries = useMemo(() => looseGoodsAsCatalogEntries(primaryType), [primaryType])
  const catalog = useMemo(() => [...getCatalogForShopType(primaryType), ...looseEntries], [primaryType, looseEntries])
  const realBrands = useMemo(() => brandsForShopType(primaryType), [primaryType])
  const starterSet = useMemo(() => starterSetEntries(primaryType), [primaryType])
  const ownedKeys = useMemo(() => new Set(ownedProducts.map((p) => ownedKey(p.name, p.flavor))), [ownedProducts])
  const availableForPick = (e: CatalogEntry) => !ownedKeys.has(ownedKey(e.item.name, e.item.flavor))

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

  const selCountByBrand = useMemo(() => selectedCountByBrand(selection.rowList), [selection.rowList])

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
  const looseOnCount = looseEntries.filter((e) => selection.rows[e.key]).length

  // Every field on a row is editable before the row is even ticked (the
  // handoff's own cost/sale/unit inputs sit right on the row, no gate) —
  // useCatalogSelection only tracks ticked rows, so touching any field
  // adds it to the basket first if it isn't there yet.
  const ensureAndSet = <K extends keyof BasketRow>(e: CatalogEntry, field: K, value: BasketRow[K]) => {
    if (!selection.rows[e.key]) selection.selectMany([e])
    selection.setField(e.key, field, value)
  }
  const fieldValue = <K extends keyof BasketRow>(e: CatalogEntry, field: K, fallback: BasketRow[K]): BasketRow[K] =>
    selection.rows[e.key] ? selection.rows[e.key][field] : fallback

  const toggleWholeBrand = (entries: CatalogEntry[]) => {
    const pickable = entries.filter(availableForPick)
    const allSelected = pickable.length > 0 && pickable.every((e) => selection.rows[e.key])
    if (allSelected) selection.deselectMany(pickable.map((e) => e.key))
    else selection.selectMany(pickable)
  }
  const toggleWholeCategory = (slug: string) => {
    const entries = (catalogByCategory[slug] ?? []).filter(availableForPick)
    const allSelected = entries.length > 0 && entries.every((e) => selection.rows[e.key])
    if (allSelected) selection.deselectMany(entries.map((e) => e.key))
    else selection.selectMany(entries)
  }
  const catSelectedCount = (slug: string) => (catalogByCategory[slug] ?? []).filter((e) => selection.rows[e.key]).length
  const catKeysAvailable = (slug: string) => (catalogByCategory[slug] ?? []).filter(availableForPick).map((e) => e.key)

  const takeStarterSet = () => selection.selectMany(starterSet.filter(availableForPick))
  const takeEverything = () => selection.selectMany(catalog.filter(availableForPick))

  const rowLabel = (e: CatalogEntry) => {
    const name = isUrdu && e.item.name_ur ? e.item.name_ur : e.item.name
    const flavor = isUrdu ? (e.item.flavor_ur || e.item.flavor) : e.item.flavor
    return flavor ? `${name} — ${flavor}` : name
  }

  const ItemRow = ({ e }: { e: CatalogEntry }) => {
    const owned = !availableForPick(e)
    const checked = !!selection.rows[e.key]
    return (
      <button type="button" disabled={owned} onClick={() => selection.toggle(e)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-start transition-all ${owned ? 'bg-dp-surface-container/60 border-dp-outline-variant/60 cursor-default' : checked ? 'bg-dp-secondary-container/40 border-dp-secondary cursor-pointer' : 'bg-white border-dp-outline-variant hover:border-dp-secondary cursor-pointer'}`}>
        <span className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border-2 ${owned ? 'border-dp-outline-variant bg-dp-outline-variant/30' : checked ? 'bg-dp-secondary border-dp-secondary' : 'border-dp-outline-variant'}`}>
          {(checked || owned) && <Check size={13} className="text-white" strokeWidth={3} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{rowLabel(e)}</span>
          <span className="block font-sans text-[11px] text-dp-on-surface-variant truncate">{getCategoryLabel(e.item.category, isUrdu)}</span>
        </span>
        {owned ? (
          <span className="shrink-0 font-sans text-[10px] font-bold text-dp-on-surface-variant">{t('bs.alreadyStocked')}</span>
        ) : e.item.price ? (
          <span className="shrink-0 font-sans text-[11.5px] font-bold text-dp-secondary">~{e.item.price}</span>
        ) : null}
      </button>
    )
  }

  // A brand-catalog variant row (S · brand catalog): tick + flavor + MRP,
  // with real cost/sale inputs on the row itself, editable pre-tick.
  const VariantRow = ({ e }: { e: CatalogEntry }) => {
    const owned = !availableForPick(e)
    const checked = !!selection.rows[e.key]
    const flavorLabel = isUrdu ? (e.item.flavor_ur || e.item.flavor || e.item.name) : (e.item.flavor || e.item.name)
    return (
      <div className={`flex items-center gap-2 px-3 py-2.5 border-t border-dp-outline-variant/60 first:border-t-0 ${owned ? 'bg-dp-surface-container/60' : ''}`}>
        <button type="button" disabled={owned} onClick={() => selection.toggle(e)}
          className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border-2 ${owned ? 'border-dp-outline-variant bg-dp-outline-variant/30' : checked ? 'bg-dp-secondary border-dp-secondary cursor-pointer' : 'border-dp-outline-variant cursor-pointer'}`}>
          {(checked || owned) && <Check size={13} className="text-white" strokeWidth={3} />}
        </button>
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-[13px] text-dp-on-surface truncate">{flavorLabel}</span>
          {e.item.price ? <span className="block font-sans text-[10.5px] text-dp-on-surface-variant">{t('bs.mrpLabel').replace('{v}', String(e.item.price))}</span> : null}
        </span>
        <input disabled={owned} inputMode="decimal" placeholder={t('bs.costPlaceholder')}
          value={fieldValue(e, 'cost_price_pkr', '')} onChange={(ev) => ensureAndSet(e, 'cost_price_pkr', ev.target.value === '' ? '' : Number(ev.target.value))}
          className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-outline-variant bg-dp-surface-container font-sans text-[12px] text-dp-on-surface disabled:opacity-50" />
        <input disabled={owned} inputMode="decimal" placeholder={t('bs.salePlaceholder')}
          value={fieldValue(e, 'unit_price_pkr', e.item.price ?? '')} onChange={(ev) => ensureAndSet(e, 'unit_price_pkr', ev.target.value === '' ? '' : Number(ev.target.value))}
          className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-secondary bg-white font-sans text-[12px] font-bold text-dp-on-surface disabled:opacity-50" />
      </div>
    )
  }

  // A loose-good row: tick + name + a REAL unit <select> (overridable,
  // not just a read-only badge) + cost/sale inputs, all editable pre-tick.
  const LooseRow = ({ e }: { e: CatalogEntry }) => {
    const owned = !availableForPick(e)
    const checked = !!selection.rows[e.key]
    const name = isUrdu && e.item.name_ur ? e.item.name_ur : e.item.name
    return (
      <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${owned ? 'bg-dp-surface-container/60 border-dp-outline-variant/60' : checked ? 'bg-dp-secondary-container/40 border-dp-secondary' : 'bg-white border-dp-outline-variant'}`}>
        <button type="button" disabled={owned} onClick={() => selection.toggle(e)}
          className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border-2 ${owned ? 'border-dp-outline-variant bg-dp-outline-variant/30' : checked ? 'bg-dp-secondary border-dp-secondary cursor-pointer' : 'border-dp-outline-variant cursor-pointer'}`}>
          {(checked || owned) && <Check size={13} className="text-white" strokeWidth={3} />}
        </button>
        <span className="min-w-0 flex-1 font-sans text-[13px] text-dp-on-surface truncate">{name}</span>
        <select disabled={owned} value={fieldValue(e, 'unit', e.item.flavor ?? UNIT_OPTIONS[0])}
          onChange={(ev) => ensureAndSet(e, 'unit', ev.target.value)}
          className="shrink-0 w-[74px] px-1 py-1.5 rounded-lg border border-dp-outline-variant bg-white font-sans text-[11px] text-dp-on-surface disabled:opacity-50">
          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <input disabled={owned} inputMode="decimal" placeholder={t('bs.costPlaceholder')}
          value={fieldValue(e, 'cost_price_pkr', '')} onChange={(ev) => ensureAndSet(e, 'cost_price_pkr', ev.target.value === '' ? '' : Number(ev.target.value))}
          className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-outline-variant bg-dp-surface-container font-sans text-[12px] text-dp-on-surface disabled:opacity-50" />
        <input disabled={owned} inputMode="decimal" placeholder={t('bs.salePlaceholder')}
          value={fieldValue(e, 'unit_price_pkr', '')} onChange={(ev) => ensureAndSet(e, 'unit_price_pkr', ev.target.value === '' ? '' : Number(ev.target.value))}
          className="w-14 shrink-0 px-1.5 py-1.5 text-center rounded-lg border border-dp-secondary bg-white font-sans text-[12px] font-bold text-dp-on-surface disabled:opacity-50" />
      </div>
    )
  }

  const submitLooseGood = () => {
    if (!nlName.trim() || !nlCat) return
    const key = selection.addCustomRow(nlCat)
    selection.setField(key, 'name', nlName.trim())
    selection.setField(key, 'unit', nlUnit)
    if (nlCost !== '') selection.setField(key, 'cost_price_pkr', Number(nlCost))
    if (nlSale !== '') selection.setField(key, 'unit_price_pkr', Number(nlSale))
    setNlName(''); setNlCost(''); setNlSale('')
  }

  const submitBrandItem = (brandSlug: string, brandName: string, brandName_ur: string, catSlug: string) => {
    if (!aiName.trim()) return
    const key = selection.addCustomRow(catSlug)
    selection.setField(key, 'name', aiName.trim())
    selection.setField(key, 'flavor', aiFlavor.trim())
    selection.setField(key, 'unit', aiUnit)
    selection.setField(key, 'brandName', brandName)
    selection.setField(key, 'brandName_ur', brandName_ur)
    void brandSlug
    if (aiCost !== '') selection.setField(key, 'cost_price_pkr', Number(aiCost))
    if (aiSale !== '') selection.setField(key, 'unit_price_pkr', Number(aiSale))
    setAiName(''); setAiFlavor(''); setAiCost(''); setAiSale('')
  }

  return (
    <div>
      <div className="relative mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('bs.searchCatalogPlaceholder')}
          className="w-full px-3 py-2.5 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[14px] font-sans text-dp-on-surface" />
      </div>

      {query.trim() ? (
        <div className="space-y-1.5">
          {searchResults.length === 0 ? (
            <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.noMatches')}</p>
          ) : searchResults.map((e) => <ItemRow key={e.key} e={e} />)}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <div className="flex items-center gap-1.5">
              {realBrands.length > 0 && (
                <>
                  <button onClick={() => setLens('brands')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-sans font-semibold cursor-pointer border ${lens === 'brands' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                    <Tags size={13} /> {t('bs.brandsLensTab')}
                  </button>
                  <button onClick={() => setLens('departments')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-sans font-semibold cursor-pointer border ${lens === 'departments' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                    <LayoutGrid size={13} /> {t('bs.deptLensTab')}
                  </button>
                </>
              )}
            </div>
            {catalog.length > 0 && (
              <div className="flex items-center gap-3">
                <button onClick={takeStarterSet} className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer"><Sparkles size={12} /> {t('bs.tickStandardStockBtn').replace('{n}', String(starterSet.length))}</button>
                <button onClick={takeEverything} className="font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer">{t('bs.selectEverythingBtn').replace('{n}', String(catalog.length))}</button>
              </div>
            )}
          </div>

          {lens === 'brands' ? (
            realBrands.length === 0 ? (
              <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('bs.noBrandsForShopType')}</p>
            ) : openBrand ? (
              // ── S · brand catalog ────────────────────────────────────
              (() => {
                const byCat = groupByCategory(openBrand.entries)
                const selHere = selCountByBrand[openBrand.brandSlug] ?? 0
                const defaultCat = openBrand.entries[0]?.item.category ?? ''
                return (
                  <div>
                    <div className="flex items-center gap-3 bg-dp-primary text-white rounded-lg px-3.5 py-3 mb-3">
                      <div className="w-[42px] h-[42px] shrink-0 bg-white/15 rounded-lg flex items-center justify-center font-sans text-[11px] font-extrabold tracking-[0.02em]">{initials(openBrand.brandName)}</div>
                      <div className="min-w-0 flex-1">
                        <p className="font-sans text-[15px] font-bold truncate">{isUrdu ? openBrand.brandName_ur : openBrand.brandName}</p>
                        <p className="font-sans text-[10.5px] tracking-[0.06em] opacity-70 truncate">{openBrand.brandName.toUpperCase()} · {t('bs.brandDefaultCatalogLabel')}</p>
                      </div>
                      <div className="shrink-0 text-end">
                        <p className="font-sans text-[9.5px] tracking-[0.08em] opacity-60">{t('bs.pickedLabel')}</p>
                        <p className="font-sans text-[17px] font-extrabold">{selHere}</p>
                      </div>
                    </div>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant leading-6 mb-3">{t('bs.brandCatalogHint')}</p>

                    <div className="space-y-3 mb-4">
                      {Object.entries(byCat).map(([slug, entries]) => {
                        const groupSelected = entries.filter((e) => selection.rows[e.key]).length
                        return (
                          <div key={slug} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                            <div className="flex items-baseline gap-2 px-3 py-2.5 border-b-2 border-dp-outline-variant">
                              <span className="flex-1 font-sans text-[13.5px] font-semibold text-dp-on-surface">{getCategoryLabel(slug, isUrdu)}</span>
                              <button type="button" onClick={() => toggleWholeCategory(slug)} className="font-sans text-[11px] font-bold text-dp-secondary cursor-pointer">
                                {groupSelected === entries.length ? t('bs.tickedBtn') : t('bs.groupAllBtn')}
                              </button>
                            </div>
                            {entries.map((e) => <VariantRow key={e.key} e={e} />)}
                          </div>
                        )
                      })}
                    </div>

                    <div className="bg-white border-2 border-dashed border-dp-secondary/60 rounded-lg p-3.5 mb-4">
                      <p className="font-sans text-[9.5px] font-bold tracking-[0.1em] text-dp-secondary">{t('bs.addItemToBrandKicker')}</p>
                      <p className="font-sans text-[15px] font-bold text-dp-on-surface mt-0.5">{t('bs.addItemToBrandHeading')}</p>
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-6 mt-1">{t('bs.addItemToBrandHint')}</p>
                      <div className="flex gap-1.5 mt-3">
                        <input value={aiName} onChange={(e) => setAiName(e.target.value)} placeholder={t('bs.itemNamePlaceholder')} className="input-field flex-1 min-w-0 text-[12.5px] py-2" />
                        <select value={aiUnit} onChange={(e) => setAiUnit(e.target.value)} className="shrink-0 w-24 px-2 rounded-lg border border-dp-outline-variant bg-white font-sans text-[12.5px] text-dp-on-surface">
                          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      <div className="flex gap-1.5 mt-1.5">
                        <input value={aiFlavor} onChange={(e) => setAiFlavor(e.target.value)} placeholder={t('bs.flavorOrSizePlaceholder')} className="input-field flex-1 min-w-0 text-[12.5px] py-2" />
                        <input value={aiCost} onChange={(e) => setAiCost(e.target.value)} inputMode="decimal" placeholder={t('bs.costPlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-outline-variant bg-dp-surface-container text-center font-sans text-[12.5px]" />
                        <input value={aiSale} onChange={(e) => setAiSale(e.target.value)} inputMode="decimal" placeholder={t('bs.salePlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-secondary bg-white text-center font-sans text-[12.5px] font-bold" />
                      </div>
                      <button onClick={() => submitBrandItem(openBrand.brandSlug, openBrand.brandName, openBrand.brandName_ur, defaultCat)}
                        className="w-full mt-2.5 py-2.5 rounded-lg bg-dp-secondary text-white font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                        {t('bs.addToCatalogBtn')}
                      </button>
                    </div>

                    <div className="flex gap-2">
                      <button onClick={() => setOpenBrandSlug(null)} className="flex-1 py-3 rounded-lg bg-dp-secondary text-white font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                        {t('bs.saveToShopBtn')}
                      </button>
                      <button onClick={() => setOpenBrandSlug(null)} className="shrink-0 px-4 py-3 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-on-surface-variant cursor-pointer hover:bg-dp-surface-container">
                        {t('bs.moreBrandsBtn')}
                      </button>
                    </div>
                  </div>
                )
              })()
            ) : (
              // ── S · catalog · brands ─────────────────────────────────
              <>
                <p className="font-sans text-[12px] text-dp-on-surface-variant leading-6 mb-3">{t('bs.catalogIntroHint')}</p>

                {brandCategories.length > 0 && (
                  <div className="flex items-center gap-1.5 mb-3 overflow-x-auto pb-1">
                    <button onClick={() => setCatFilter(null)} className={`shrink-0 px-2.5 py-1 rounded-full text-[11.5px] font-sans font-semibold cursor-pointer border ${!catFilter ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{t('cb.allTab')}</button>
                    {brandCategories.map((c) => (
                      <button key={c.slug} onClick={() => setCatFilter(c.slug)} className={`shrink-0 px-2.5 py-1 rounded-full text-[11.5px] font-sans font-semibold cursor-pointer border ${catFilter === c.slug ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{isUrdu ? c.label_ur : c.label}</button>
                    ))}
                  </div>
                )}

                {onScanClick && (
                  <button onClick={onScanClick}
                    className="w-full flex items-center gap-2 px-3.5 py-3 rounded-lg bg-dp-primary text-white font-sans text-[12.5px] cursor-pointer hover:bg-dp-secondary transition-all mb-2">
                    <Camera size={16} /> <span className="flex-1 text-start">{t('bs.scanFromCatalogBtn')}</span>
                  </button>
                )}
                <button onClick={() => setShowBrandBuilder(true)}
                  className="w-full flex items-center gap-2 px-3.5 py-3 rounded-lg border-2 border-dashed border-dp-secondary/60 text-dp-secondary font-sans text-[12.5px] cursor-pointer hover:bg-dp-secondary-container/20 transition-all mb-3">
                  <PackagePlus size={16} /> <span className="flex-1 text-start">{t('bs.newBrandFromCatalogBtn')}</span>
                </button>

                {visibleBrands.length === 0 ? (
                  <p className="font-sans text-[12px] text-dp-on-surface-variant border border-dp-outline-variant rounded-lg bg-white p-3.5 leading-6">{t('bs.noBrandsInCategoryHint')}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2.5">
                    {visibleBrands.map((b) => {
                      const selHere = selCountByBrand[b.brandSlug] ?? 0
                      const fullySelected = selHere === b.entries.length
                      const catSlug = b.entries[0]?.item.category
                      return (
                        <div key={b.brandSlug} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex flex-col">
                          <div className="flex items-start gap-2">
                            <div className="w-[34px] h-[34px] shrink-0 bg-dp-surface-container border border-dp-outline-variant rounded-lg flex items-center justify-center font-sans text-[9px] font-extrabold tracking-[0.02em] text-center leading-tight p-0.5">{initials(b.brandName)}</div>
                            <div className="min-w-0 flex-1">
                              <p className="font-sans text-[12.5px] leading-tight text-dp-on-surface truncate">{isUrdu ? b.brandName_ur : b.brandName}</p>
                              <p className="font-sans text-[8.5px] tracking-[0.08em] text-dp-on-surface-variant truncate">{b.brandName.toUpperCase()}</p>
                            </div>
                          </div>
                          <p className="font-sans text-[10.5px] text-dp-on-surface-variant mt-1.5">
                            {catSlug ? getCategoryLabel(catSlug, isUrdu) : ''} · {b.entries.length} {t('mk.productsCount')}
                          </p>
                          <div className="flex items-center gap-1.5 mt-2">
                            <button type="button" onClick={() => toggleWholeBrand(b.entries)}
                              className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg font-sans text-[11px] font-bold cursor-pointer border ${fullySelected ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                              {fullySelected && <Check size={12} strokeWidth={3} />} {fullySelected ? t('bs.tickedBtn') : t('bs.tickBtn')}
                            </button>
                            <button type="button" onClick={() => setOpenBrandSlug(b.brandSlug)}
                              className="shrink-0 px-2.5 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[11px] font-semibold text-dp-on-surface-variant cursor-pointer hover:bg-dp-surface-container">
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
                        <p className="font-sans text-[10px] font-bold text-dp-secondary uppercase tracking-[0.14em]">{t('bs.nonBrandedKicker')}</p>
                        <p className="font-sans text-[16px] font-bold text-dp-on-surface">{t('bs.looseGoodsHeading')}</p>
                      </div>
                      <p className="font-sans text-[11px] text-dp-on-surface-variant pb-0.5">{t('bs.looseOnLabel').replace('{n}', String(looseOnCount))}</p>
                    </div>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2 mb-3">{t('bs.looseGoodsHint')}</p>

                    <div className="flex items-center gap-2 border-2 border-dp-primary bg-white px-3 py-2 mb-3 rounded-lg">
                      <Search size={15} className="text-dp-on-surface-variant shrink-0" />
                      <input value={looseQuery} onChange={(e) => setLooseQuery(e.target.value)} placeholder={t('bs.searchLooseGoodsPlaceholder')}
                        className="flex-1 min-w-0 font-sans text-[13px] text-dp-on-surface outline-none bg-transparent" />
                      {looseQuery && <button onClick={() => setLooseQuery('')} className="shrink-0 font-sans text-[12px] font-semibold text-dp-secondary cursor-pointer">{t('bs.clearBtn')}</button>}
                      <span className="shrink-0 font-sans text-[11px] text-dp-on-surface-variant ltr-num">{looseShownCount}</span>
                    </div>

                    {looseByCategory.length === 0 ? (
                      <p className="font-sans text-[12px] text-dp-on-surface-variant border border-dp-outline-variant rounded-lg bg-white p-3.5 leading-6">{t('bs.noLooseHitsHint')}</p>
                    ) : (
                      <div className="space-y-3">
                        {looseByCategory.map((g) => (
                          <div key={g.slug}>
                            <div className="flex items-baseline gap-2 bg-dp-primary text-white px-3 py-2 rounded-lg">
                              <span className="flex-1 font-sans text-[12.5px] font-semibold">{getCategoryLabel(g.slug, isUrdu)}</span>
                              <span className="font-sans text-[11px] opacity-80 ltr-num">{g.entries.length}</span>
                            </div>
                            <div className="space-y-1.5 mt-1.5">{g.entries.map((e) => <LooseRow key={e.key} e={e} />)}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="bg-white border-2 border-dashed border-dp-primary rounded-lg p-3.5 mt-3">
                      <p className="font-sans text-[9.5px] font-bold tracking-[0.1em] text-dp-on-surface-variant">{t('bs.addLooseGoodKicker')}</p>
                      <p className="font-sans text-[15px] font-bold text-dp-on-surface mt-0.5">{t('bs.addLooseGoodBtn')}</p>
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-6 mt-1">{t('bs.addLooseGoodFormHint')}</p>
                      <div className="flex gap-1.5 mt-3">
                        <input value={nlName} onChange={(e) => setNlName(e.target.value)} placeholder={t('bs.looseGoodNamePlaceholder')} className="input-field flex-1 min-w-0 text-[12.5px] py-2" />
                        <select value={nlUnit} onChange={(e) => setNlUnit(e.target.value)} className="shrink-0 w-24 px-2 rounded-lg border border-dp-outline-variant bg-white font-sans text-[12.5px] text-dp-on-surface">
                          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className="flex-1 min-w-0 font-sans text-[11.5px] text-dp-on-surface-variant truncate">{t('bs.categoryPrefixLabel').replace('{name}', nlCat ? getCategoryLabel(nlCat, isUrdu) : '—')}</span>
                        <input value={nlCost} onChange={(e) => setNlCost(e.target.value)} inputMode="decimal" placeholder={t('bs.costPlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-outline-variant bg-dp-surface-container text-center font-sans text-[12.5px]" />
                        <input value={nlSale} onChange={(e) => setNlSale(e.target.value)} inputMode="decimal" placeholder={t('bs.salePlaceholder')} className="w-14 shrink-0 px-1.5 rounded-lg border border-dp-secondary bg-white text-center font-sans text-[12.5px] font-bold" />
                      </div>
                      <div className="flex items-center gap-1.5 mt-2.5 overflow-x-auto pb-1">
                        {tree.flatMap((d) => d.categories).map((c) => (
                          <button key={c.slug} onClick={() => setNlCat(c.slug)} className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-sans font-semibold cursor-pointer border ${nlCat === c.slug ? 'bg-dp-primary text-white border-dp-primary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{isUrdu ? c.label_ur : c.label}</button>
                        ))}
                      </div>
                      <button onClick={submitLooseGood}
                        className="w-full mt-2.5 py-2.5 rounded-lg bg-dp-primary text-white font-sans text-[12.5px] cursor-pointer hover:bg-dp-secondary transition-all">
                        {t('bs.addToLooseGoodsBtn')}
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
                const selHere = catalog.filter((e) => d.categories.some((c) => c.slug === e.item.category) && selection.rows[e.key]).length
                return (
                  <button key={d.key} onClick={() => { setActiveDeptKey(d.key); setActiveCatSlug(null) }}
                    className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                    <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-dp-secondary-container/40 text-dp-secondary"><DynamicIcon name={d.icon} size={22} /></div>
                    <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? d.label_ur : d.label}</span>
                    <span className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant">{total === 0 ? t('bs.noCatalogItems') : `${selHere} / ${total}`}</span>
                  </button>
                )
              })}
            </div>
          ) : !activeCat ? (
            <>
              <div className="flex items-center gap-1.5 mb-3 font-sans text-[13px]">
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
                        <span className="font-sans text-[12px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? c.label_ur : c.label}</span>
                        <span className="font-sans text-[10px] font-bold text-dp-on-surface-variant">{total === 0 ? t('bs.noCatalogItems') : `${selHere} / ${total}`}</span>
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
              <div className="flex items-center gap-1.5 mb-3 font-sans text-[13px] flex-wrap">
                <button onClick={() => setActiveDeptKey(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
                <ArrowRight size={14} className="text-dp-on-surface-variant rotate-180 rtl:rotate-0" />
                <button onClick={() => setActiveCatSlug(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu ? activeDept.label_ur : activeDept.label}</button>
                <ArrowRight size={14} className="text-dp-on-surface-variant rotate-180 rtl:rotate-0" />
                <span className="font-semibold text-dp-on-surface">{isUrdu ? activeCat.label_ur : activeCat.label}</span>
              </div>
              {itemsInCat.length === 0 ? (
                <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('bs.noCatalogItemsHint')}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <button onClick={() => toggleWholeCategory(activeCat.slug)} className="flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">
                      {catSelectedCount(activeCat.slug) === itemsInCat.length ? t('bs.deselectAllHere') : t('bs.selectAllHere')}
                    </button>
                    <span className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant">{catSelectedCount(activeCat.slug)} / {itemsInCat.length}</span>
                  </div>
                  <div className="space-y-1.5">{itemsInCat.map((e) => <ItemRow key={e.key} e={e} />)}</div>
                </>
              )}
              <button onClick={() => selection.addCustomRow(activeCat.slug)}
                className="w-full mt-4 flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-dp-secondary/50 bg-dp-secondary-container/20 text-dp-secondary rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-secondary-container/40">
                {t('bs.addYourOwnItemBtn')}
              </button>
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
