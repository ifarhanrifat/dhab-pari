'use client'

// Step 1 of the Add Stock wizard: tick many catalog items at once instead
// of the old one-tap-per-item flow. Lands on a pre-ticked "starter set" by
// default (per-catalog "add most things, then remove what you don't
// carry" — the actual ask), with a department/category tree as the
// escape hatch for anything outside it, plus catalog-wide search.
//
// Deliberately no brand-first navigation level (see the design note in
// AddStockWizard.tsx for why) — brand only ever appears as a group
// header + filter chip inside a category's own item list.

import { useMemo, useState } from 'react'
import { ChevronRight, LayoutGrid, Search, Check, PackageCheck, Sparkles } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree } from '@/lib/shopTypes'
import {
  getCatalogForShopType, starterSetEntries, groupByCategory, groupByBrand, countByDept, searchCatalogEntries,
  ownedKey, type CatalogEntry,
} from '@/lib/catalogSelection'
import { TILE_COLORS } from './CategoryBrowser'
import { DynamicIcon } from './DynamicIcon'
import type { CatalogSelection } from '@/hooks/useCatalogSelection'

interface OwnedProduct { name: string; flavor?: string | null }

interface StockPickerProps {
  primaryType: string
  ownedProducts: OwnedProduct[]
  selection: CatalogSelection
}

export function StockPicker({ primaryType, ownedProducts, selection }: StockPickerProps) {
  const { t, isUrdu } = useLocale()
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const catalog = useMemo(() => getCatalogForShopType(primaryType), [primaryType])
  const starterSet = useMemo(() => starterSetEntries(primaryType), [primaryType])
  const ownedKeys = useMemo(() => new Set(ownedProducts.map((p) => ownedKey(p.name, p.flavor))), [ownedProducts])

  const [screen, setScreen] = useState<'start' | 'departments' | 'categories' | 'items'>(catalog.length === 0 ? 'departments' : 'start')
  const [activeDeptKey, setActiveDeptKey] = useState<string | null>(null)
  const [activeCatSlug, setActiveCatSlug] = useState<string | null>(null)
  const [activeBrandFilter, setActiveBrandFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const activeDept = tree.find((d) => d.key === activeDeptKey)
  const activeCat = activeDept?.categories.find((c) => c.slug === activeCatSlug)

  const deptCounts = useMemo(() => countByDept(tree, catalog), [tree, catalog])
  const catalogByCategory = useMemo(() => groupByCategory(catalog), [catalog])
  const itemsInCat = activeCat ? (catalogByCategory[activeCat.slug] ?? []) : []
  const availableForPick = (e: CatalogEntry) => !ownedKeys.has(ownedKey(e.item.name, e.item.flavor))
  const brandsInCat = groupByBrand(itemsInCat)
  const visibleInCat = activeBrandFilter ? itemsInCat.filter((e) => e.brandSlug === activeBrandFilter) : itemsInCat

  const searchResults = useMemo(() => (query.trim() ? searchCatalogEntries(catalog, query) : []), [catalog, query])

  const takeStarterSet = () => { selection.selectMany(starterSet.filter(availableForPick)); setScreen('categories'); setActiveDeptKey(tree[0]?.key ?? null) }
  const takeEverything = () => selection.selectMany(catalog.filter(availableForPick))
  const goDepartments = () => { setActiveDeptKey(null); setActiveCatSlug(null); setActiveBrandFilter(null); setScreen('departments') }
  const goCategories = (deptKey: string) => { setActiveDeptKey(deptKey); setActiveCatSlug(null); setActiveBrandFilter(null); setScreen('categories') }
  const openCategory = (slug: string) => { setActiveCatSlug(slug); setActiveBrandFilter(null); setScreen('items') }

  const catKeysAvailable = (slug: string) => (catalogByCategory[slug] ?? []).filter(availableForPick).map((e) => e.key)
  const catSelectedCount = (slug: string) => (catalogByCategory[slug] ?? []).filter((e) => selection.rows[e.key]).length
  const toggleWholeCategory = (slug: string) => {
    const entries = (catalogByCategory[slug] ?? []).filter(availableForPick)
    const allSelected = entries.length > 0 && entries.every((e) => selection.rows[e.key])
    if (allSelected) selection.deselectMany(entries.map((e) => e.key))
    else selection.selectMany(entries)
  }

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
          <span className="block font-sans text-[11px] text-dp-on-surface-variant truncate">{isUrdu ? e.brandName_ur : e.brandName}</span>
        </span>
        {owned ? (
          <span className="shrink-0 font-sans text-[10px] font-bold text-dp-on-surface-variant">{t('bs.alreadyStocked')}</span>
        ) : e.item.price ? (
          <span className="shrink-0 font-sans text-[11.5px] font-bold text-dp-secondary">~{e.item.price}</span>
        ) : null}
      </button>
    )
  }

  return (
    <div>
      <div className="relative mb-3">
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant/60 pointer-events-none" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('bs.searchCatalogPlaceholder')}
          className="w-full ps-9 pe-3 py-2.5 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[14px] font-sans text-dp-on-surface" />
      </div>

      {query.trim() ? (
        <div className="space-y-1.5">
          {searchResults.length === 0 ? (
            <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.noMatches')}</p>
          ) : searchResults.map((e) => <ItemRow key={e.key} e={e} />)}
        </div>
      ) : screen === 'start' ? (
        <div className="bg-dp-secondary-container/30 border-2 border-dp-secondary/40 rounded-xl p-5 text-center">
          <Sparkles size={26} className="mx-auto text-dp-secondary mb-2" />
          <h3 className="font-heading text-[17px] font-bold text-dp-primary mb-1">{t('bs.starterSetTitle').replace('{n}', String(starterSet.length))}</h3>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('bs.starterSetHint')}</p>
          <button onClick={takeStarterSet} className="w-full sm:w-auto px-6 py-3 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all mb-2">
            {t('bs.useStarterSetBtn')}
          </button>
          <div className="flex items-center justify-center gap-4 mt-2">
            <button onClick={() => setScreen('departments')} className="font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">{t('bs.browseByDeptBtn')}</button>
            <span className="text-dp-on-surface-variant">·</span>
            <button onClick={takeEverything} className="font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">{t('bs.selectEverythingBtn').replace('{n}', String(catalog.length))}</button>
          </div>
        </div>
      ) : screen === 'departments' ? (
        <>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><LayoutGrid size={13} /> {t('cb.departmentsHeading')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {tree.map((d, i) => {
              const color = TILE_COLORS[i % TILE_COLORS.length]
              const total = deptCounts[d.key] ?? 0
              const selectedHere = catalog.filter((e) => d.categories.some((c) => c.slug === e.item.category) && selection.rows[e.key]).length
              return (
                <button key={d.key} onClick={() => goCategories(d.key)}
                  className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}><DynamicIcon name={d.icon} size={22} /></div>
                  <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? d.label_ur : d.label}</span>
                  <span className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant">{total === 0 ? t('bs.noCatalogItems') : `${selectedHere} / ${total}`}</span>
                </button>
              )
            })}
          </div>
        </>
      ) : screen === 'categories' && activeDept ? (
        <>
          <div className="flex items-center gap-1.5 mb-3 font-sans text-[13px]">
            <button onClick={goDepartments} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
            <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
            <span className="font-semibold text-dp-on-surface">{isUrdu ? activeDept.label_ur : activeDept.label}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {activeDept.categories.map((c, i) => {
              const color = TILE_COLORS[i % TILE_COLORS.length]
              const total = (catalogByCategory[c.slug] ?? []).length
              const selectedHere = catSelectedCount(c.slug)
              const availableHere = catKeysAvailable(c.slug)
              return (
                <div key={c.slug} className="relative">
                  <button onClick={() => openCategory(c.slug)}
                    className="w-full flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                    <div className={`w-11 h-11 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}><DynamicIcon name={activeDept.icon} size={20} /></div>
                    <span className="font-sans text-[12px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? c.label_ur : c.label}</span>
                    <span className="font-sans text-[10px] font-bold text-dp-on-surface-variant">{total === 0 ? t('bs.noCatalogItems') : `${selectedHere} / ${total}`}</span>
                  </button>
                  {total > 0 && availableHere.length > 0 && (
                    <button type="button" onClick={(ev) => { ev.stopPropagation(); toggleWholeCategory(c.slug) }}
                      title={t('bs.selectWholeCategory')}
                      className={`absolute top-1.5 end-1.5 w-6 h-6 rounded flex items-center justify-center border-2 cursor-pointer ${selectedHere === total ? 'bg-dp-secondary border-dp-secondary' : 'bg-white border-dp-outline-variant'}`}>
                      {selectedHere === total && <Check size={13} className="text-white" strokeWidth={3} />}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      ) : screen === 'items' && activeCat ? (
        <>
          <div className="flex items-center gap-1.5 mb-3 font-sans text-[13px] flex-wrap">
            <button onClick={goDepartments} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
            <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
            <button onClick={() => activeDeptKey && goCategories(activeDeptKey)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu ? activeDept?.label_ur : activeDept?.label}</button>
            <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
            <span className="font-semibold text-dp-on-surface">{isUrdu ? activeCat.label_ur : activeCat.label}</span>
          </div>

          {itemsInCat.length === 0 ? (
            <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('bs.noCatalogItemsHint')}</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 mb-3">
                <button onClick={() => toggleWholeCategory(activeCat.slug)} className="flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">
                  <PackageCheck size={14} /> {catSelectedCount(activeCat.slug) === itemsInCat.length ? t('bs.deselectAllHere') : t('bs.selectAllHere')}
                </button>
                <span className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant">{catSelectedCount(activeCat.slug)} / {itemsInCat.length}</span>
              </div>
              {brandsInCat.length > 1 && (
                <div className="flex items-center gap-1.5 mb-3 overflow-x-auto pb-1">
                  <button onClick={() => setActiveBrandFilter(null)} className={`shrink-0 px-2.5 py-1 rounded-full text-[11.5px] font-sans font-semibold cursor-pointer border ${!activeBrandFilter ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{t('cb.allTab')}</button>
                  {brandsInCat.map((b) => (
                    <button key={b.brandSlug} onClick={() => setActiveBrandFilter(b.brandSlug)} className={`shrink-0 px-2.5 py-1 rounded-full text-[11.5px] font-sans font-semibold cursor-pointer border ${activeBrandFilter === b.brandSlug ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                      {isUrdu ? b.brandName_ur : b.brandName}
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-1.5">
                {visibleInCat.map((e) => <ItemRow key={e.key} e={e} />)}
              </div>
            </>
          )}

          <button onClick={() => selection.addCustomRow(activeCat.slug)}
            className="w-full mt-4 flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-dp-secondary/50 bg-dp-secondary-container/20 text-dp-secondary rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-secondary-container/40">
            {t('bs.addYourOwnItemBtn')}
          </button>
        </>
      ) : null}
    </div>
  )
}
