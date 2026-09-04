'use client'

// Brand-first catalog browsing for the shop's "Add Stock" tab — every
// brand valid for this shop type is visible immediately (an accordion,
// several can be open at once), so a keeper restocking "what do I carry
// from LU, from Tapal, from Wall's" sees real brand names and items with
// zero taps beyond the tab itself. Departments is a secondary lens
// (toggle at the top) for the opposite mental model ("fill my spice
// shelf") and for the handful of general_store categories with no brand
// coverage yet. No starter-set intro screen, no forced department drill
// before a real item appears on screen — see the correction note this
// replaced in AddStockWizard's git history for why that mattered.

import { useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, ChevronUp, Check, LayoutGrid, Tags, Sparkles, PackageCheck, PackagePlus } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree, getCategoryLabel } from '@/lib/shopTypes'
import {
  getCatalogForShopType, brandsForShopType, selectedCountByBrand, starterSetEntries,
  groupByCategory, countByDept, searchCatalogEntries, ownedKey, looseGoodsAsCatalogEntries, type CatalogEntry,
} from '@/lib/catalogSelection'
import { TILE_COLORS, CategoryPicker } from './CategoryBrowser'
import { DynamicIcon } from './DynamicIcon'
import { BrandBuilderModal } from './BrandBuilderModal'
import type { CatalogSelection } from '@/hooks/useCatalogSelection'

interface OwnedProduct { name: string; flavor?: string | null }

interface BrandItemPickerProps {
  shopId: string
  primaryType: string
  ownedProducts: OwnedProduct[]
  selection: CatalogSelection
  onBrandSubmitted: () => void
}

export function BrandItemPicker({ shopId, primaryType, ownedProducts, selection, onBrandSubmitted }: BrandItemPickerProps) {
  const { t, isUrdu } = useLocale()
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const looseEntries = useMemo(() => looseGoodsAsCatalogEntries(primaryType), [primaryType])
  // Loose goods join the flat catalog (search, "select everything", the
  // Departments lens all read off this) — a shopkeeper searching "آٹا"
  // should find the loose one same as a branded item would. They also get
  // appended as one more brand-style group in the Brands lens below,
  // rather than getting scattered across whichever category each one
  // belongs to — "بغیر برانڈ / کھلا سامان" is meant to read as its own
  // section, per the design handoff's own framing.
  const catalog = useMemo(() => [...getCatalogForShopType(primaryType), ...looseEntries], [primaryType, looseEntries])
  const brands = useMemo(() => {
    const real = brandsForShopType(primaryType)
    return looseEntries.length > 0
      ? [...real, { brandSlug: 'loose', brandName: 'Unbranded / Loose Goods', brandName_ur: 'بغیر برانڈ / کھلا سامان', brandIcon: 'Scale', entries: looseEntries }]
      : real
  }, [primaryType, looseEntries])
  const starterSet = useMemo(() => starterSetEntries(primaryType), [primaryType])
  const ownedKeys = useMemo(() => new Set(ownedProducts.map((p) => ownedKey(p.name, p.flavor))), [ownedProducts])
  const availableForPick = (e: CatalogEntry) => !ownedKeys.has(ownedKey(e.item.name, e.item.flavor))

  const [lens, setLens] = useState<'brands' | 'departments'>(brands.length > 0 ? 'brands' : 'departments')
  const [openBrands, setOpenBrands] = useState<Set<string>>(new Set())
  const [showAddCustom, setShowAddCustom] = useState(false)
  const [showBrandBuilder, setShowBrandBuilder] = useState(false)

  const [activeDeptKey, setActiveDeptKey] = useState<string | null>(null)
  const [activeCatSlug, setActiveCatSlug] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const activeDept = tree.find((d) => d.key === activeDeptKey)
  const activeCat = activeDept?.categories.find((c) => c.slug === activeCatSlug)
  const deptCounts = useMemo(() => countByDept(tree, catalog), [tree, catalog])
  const catalogByCategory = useMemo(() => groupByCategory(catalog), [catalog])
  const itemsInCat = activeCat ? (catalogByCategory[activeCat.slug] ?? []) : []

  const selCountByBrand = useMemo(() => selectedCountByBrand(selection.rowList), [selection.rowList])

  const searchResults = useMemo(() => (query.trim() ? searchCatalogEntries(catalog, query) : []), [catalog, query])

  const toggleBrandOpen = (slug: string) => setOpenBrands((s) => {
    const n = new Set(s)
    if (n.has(slug)) n.delete(slug); else n.add(slug)
    return n
  })
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
              {brands.length > 0 && (
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
            brands.length === 0 ? (
              <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('bs.noBrandsForShopType')}</p>
            ) : (
              <div className="space-y-2">
                {brands.map((b) => {
                  const open = openBrands.has(b.brandSlug)
                  const selHere = selCountByBrand[b.brandSlug] ?? 0
                  const byCat = groupByCategory(b.entries)
                  return (
                    <div key={b.brandSlug} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                      <div className="w-full flex items-center gap-3 px-3 py-2.5">
                        <button type="button" onClick={() => toggleWholeBrand(b.entries)}
                          title={t('bs.selectWholeBrand')}
                          className={`shrink-0 w-6 h-6 rounded flex items-center justify-center border-2 cursor-pointer ${selHere === b.entries.length ? 'bg-dp-secondary border-dp-secondary' : 'border-dp-outline-variant'}`}>
                          {selHere === b.entries.length && <Check size={14} className="text-white" strokeWidth={3} />}
                        </button>
                        <button type="button" onClick={() => toggleBrandOpen(b.brandSlug)} className="flex-1 flex items-center gap-2.5 min-w-0 cursor-pointer text-start">
                          <div className="w-8 h-8 rounded-full bg-dp-secondary-container/40 text-dp-secondary flex items-center justify-center shrink-0"><DynamicIcon name={b.brandIcon} size={16} /></div>
                          <span className="min-w-0 flex-1">
                            <span className="block font-sans text-[13.5px] font-bold text-dp-on-surface truncate">{isUrdu ? b.brandName_ur : b.brandName}</span>
                            <span className="block font-sans text-[11px] text-dp-on-surface-variant">{b.entries.length} {t('mk.productsCount')}{selHere > 0 && ` · ${selHere} ${t('bs.tickedSuffix')}`}</span>
                          </span>
                          {open ? <ChevronUp size={16} className="text-dp-on-surface-variant shrink-0" /> : <ChevronDown size={16} className="text-dp-on-surface-variant shrink-0" />}
                        </button>
                      </div>
                      {open && (
                        <div className="px-3 pb-3 space-y-3">
                          {Object.entries(byCat).map(([slug, entries]) => (
                            <div key={slug}>
                              <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em] mb-1.5">{getCategoryLabel(slug, isUrdu)}</p>
                              <div className="space-y-1.5">{entries.map((e) => <ItemRow key={e.key} e={e} />)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          ) : !activeDept ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {tree.map((d, i) => {
                const color = TILE_COLORS[i % TILE_COLORS.length]
                const total = deptCounts[d.key] ?? 0
                const selHere = catalog.filter((e) => d.categories.some((c) => c.slug === e.item.category) && selection.rows[e.key]).length
                return (
                  <button key={d.key} onClick={() => { setActiveDeptKey(d.key); setActiveCatSlug(null) }}
                    className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}><DynamicIcon name={d.icon} size={22} /></div>
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
                <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
                <span className="font-semibold text-dp-on-surface">{isUrdu ? activeDept.label_ur : activeDept.label}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {activeDept.categories.map((c, i) => {
                  const color = TILE_COLORS[i % TILE_COLORS.length]
                  const total = (catalogByCategory[c.slug] ?? []).length
                  const selHere = catSelectedCount(c.slug)
                  const availableHere = catKeysAvailable(c.slug)
                  return (
                    <div key={c.slug} className="relative">
                      <button onClick={() => setActiveCatSlug(c.slug)}
                        className="w-full flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                        <div className={`w-11 h-11 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}><DynamicIcon name={activeDept.icon} size={20} /></div>
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
                <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
                <button onClick={() => setActiveCatSlug(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu ? activeDept.label_ur : activeDept.label}</button>
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
                  <div className="space-y-1.5">{itemsInCat.map((e) => <ItemRow key={e.key} e={e} />)}</div>
                </>
              )}
              <button onClick={() => selection.addCustomRow(activeCat.slug)}
                className="w-full mt-4 flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-dp-secondary/50 bg-dp-secondary-container/20 text-dp-secondary rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-secondary-container/40">
                {t('bs.addYourOwnItemBtn')}
              </button>
            </>
          )}

          {lens === 'brands' && (
            <>
              {showAddCustom ? (
                <div className="mt-4 bg-dp-surface-container rounded-lg p-3">
                  <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface mb-2">{t('bs.pickCategoryForItemHint')}</p>
                  <CategoryPicker primaryType={primaryType} value="" onPick={(slug) => { selection.addCustomRow(slug); setShowAddCustom(false) }} />
                  <button onClick={() => setShowAddCustom(false)} className="mt-2 font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer">{t('action.cancel')}</button>
                </div>
              ) : (
                <button onClick={() => setShowAddCustom(true)}
                  className="w-full mt-4 flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-dp-secondary/50 bg-dp-secondary-container/20 text-dp-secondary rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-secondary-container/40">
                  {t('bs.addYourOwnItemBtn')}
                </button>
              )}
              {/* Distinct from "add your own item" above: that's a quick
                  one-off row straight into this basket, no brand name, no
                  review. This is for a whole BRAND missing from the shared
                  catalog — goes into this shop instantly too, but also
                  queues a real submission for the committee (§3, migration
                  435), so the next shop that needs it isn't starting from
                  zero either. */}
              <button onClick={() => setShowBrandBuilder(true)}
                className="w-full mt-2 flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface-variant cursor-pointer hover:bg-dp-surface-container">
                <PackagePlus size={15} /> {t('bb.openBuilderBtn')}
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
