'use client'

// Department → category tile browser for a shop's catalog. Replaces the old
// "one flat product grid + a category <select> inside the add/edit form"
// pattern: a shop keeper now taps a department tile (icon), then a category
// tile inside it (also icon-based), and lands on that category's own product
// grid with "Add Item" already scoped to it — no dropdown anywhere. Shared
// between admin/shops (staff-managed catalog) and portal/my-shop (keeper
// self-service) since both need the exact same browse shape, just with their
// own product-card look and add/edit/delete wiring passed in as props.
//
// Departments/categories always render from the shop's full type tree, even
// ones with zero products yet — that's the whole point: a fresh "general
// store" shows its ~6 departments and ~24 categories immediately, ready to
// fill in, instead of starting from an empty list with nothing to click.

import { useMemo, useState } from 'react'
import { ChevronRight, Search, PlusCircle, LayoutGrid, CircleCheck, Package, Store, Tags } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree, getCategoryLabel, type CategoryDepartment } from '@/lib/shopTypes'
import { PRODUCT_CATALOG, type CatalogItem } from '@/lib/productCatalog'
import { DynamicIcon } from './DynamicIcon'

export const TILE_COLORS = [
  { bg: 'bg-sky-100', text: 'text-sky-700' },
  { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  { bg: 'bg-amber-100', text: 'text-amber-800' },
  { bg: 'bg-violet-100', text: 'text-violet-700' },
  { bg: 'bg-rose-100', text: 'text-rose-700' },
  { bg: 'bg-cyan-100', text: 'text-cyan-700' },
  { bg: 'bg-lime-100', text: 'text-lime-700' },
  { bg: 'bg-fuchsia-100', text: 'text-fuchsia-700' },
]

interface CategoryBrowserProps<P extends { name: string; name_ur?: string | null; company?: string | null; flavor?: string | null; category: string | null }> {
  primaryType: string
  products: P[]
  renderProduct: (p: P) => React.ReactNode
  onAddItem: (categorySlug: string) => void
  // Brand catalog suggestions now live inside each category's own card
  // instead of a separate top-level "pick from catalog" button+modal —
  // one tap and the same pre-filled-form flow onAddItem already used
  // fires, just with the brand/item's data attached. Optional: a page
  // that only wants manual/scan add-paths (none currently) can omit it.
  onPickCatalogItem?: (brandName: string, item: CatalogItem) => void
  // Adding an item from inside a brand's own category (Brand-wise browse
  // mode below) needs the company pre-filled alongside the category —
  // separate from onAddItem since that one only ever carries a category.
  onAddItemForBrand?: (categorySlug: string, brandName: string) => void
  // "Add New Brand" tile at the end of the brand grid — there's no
  // brands table; a brand is just whatever's typed into a product's
  // company field, so "adding" one is really "hand the keeper straight
  // to the add-product form with this company name and the category they
  // were browsing already filled in." Next time this browser renders,
  // that company shows up as a real brand tile on its own.
  onAddNewBrand?: (brandName: string, categorySlug?: string) => void
}

export function CategoryBrowser<P extends { name: string; name_ur?: string | null; company?: string | null; flavor?: string | null; category: string | null }>({
  primaryType, products, renderProduct, onAddItem, onPickCatalogItem, onAddItemForBrand, onAddNewBrand,
}: CategoryBrowserProps<P>) {
  const { t, isUrdu } = useLocale()
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const [activeDeptKey, setActiveDeptKey] = useState<string | null>(null)
  const [activeCatSlug, setActiveCatSlug] = useState<string | null>(null)
  // "Brands" lives inside a category, as a second tab next to the normal
  // product grid — not a top-level alternative to Departments. Picking a
  // brand there then shows that brand's own full category range (it may
  // well have items outside the category you entered from, e.g. a
  // biscuit brand that also makes cakes), so activeBrand/activeBrandCatSlug
  // are their own nested step, independent of activeCatSlug.
  const [catTab, setCatTab] = useState<'items' | 'brands'>('items')
  const [activeBrand, setActiveBrand] = useState<string | null>(null)
  const [activeBrandCatSlug, setActiveBrandCatSlug] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const countByCategory = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of products) if (p.category) counts[p.category] = (counts[p.category] ?? 0) + 1
    return counts
  }, [products])

  const countByDept = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const d of tree) counts[d.key] = d.categories.reduce((sum, c) => sum + (countByCategory[c.slug] ?? 0), 0)
    return counts
  }, [tree, countByCategory])

  const activeDept: CategoryDepartment | undefined = tree.find((d) => d.key === activeDeptKey)
  const activeCat = activeDept?.categories.find((c) => c.slug === activeCatSlug)

  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

  // Brands tab, scoped to the category you're standing in: every catalog
  // brand that stocks something in *this* category, plus every distinct
  // company name already typed onto one of this shop's own products in
  // this category that isn't already a catalog brand — that second part
  // is the whole "user can add new brands" mechanism (see onAddNewBrand
  // above), no separate brands table needed. Once you pick a brand its
  // own full range opens up (see categoriesInBrand below) — this list is
  // just "who's relevant to start from here."
  const brandsInCategory = useMemo(() => {
    if (!activeCat) return []
    const catalogHere = PRODUCT_CATALOG.filter((b) => b.items.some((it) => it.category === activeCat.slug))
    const catalogNames = new Set(catalogHere.map((b) => norm(b.name)))
    const custom = new Set<string>()
    for (const p of products) {
      if (p.category !== activeCat.slug) continue
      const c = (p.company ?? '').trim()
      if (c && !catalogNames.has(norm(c))) custom.add(c)
    }
    const catalogBrands = catalogHere.map((b) => ({ name: b.name, name_ur: b.name_ur, icon: b.icon, custom: false }))
    const customBrands = [...custom].sort().map((name) => ({ name, name_ur: name, icon: 'Store', custom: true }))
    return [...catalogBrands, ...customBrands]
  }, [activeCat, products])

  const countByBrandInCategory = useMemo(() => {
    const counts: Record<string, number> = {}
    if (!activeCat) return counts
    for (const p of products) {
      if (p.category !== activeCat.slug) continue
      const c = (p.company ?? '').trim()
      if (c) counts[norm(c)] = (counts[norm(c)] ?? 0) + 1
    }
    return counts
  }, [activeCat, products])

  const activeBrandCatalog = PRODUCT_CATALOG.find((b) => norm(b.name) === norm(activeBrand ?? ''))
  // Not looked up from brandsInCategory — once a brand's picked, its own
  // range can lead you into a category you didn't start from, so this
  // has to stay resolvable on its own rather than depending on the
  // entry category's brand list still containing it.
  const activeBrandInfo = activeBrand
    ? { name: activeBrandCatalog?.name ?? activeBrand, name_ur: activeBrandCatalog?.name_ur ?? activeBrand, icon: activeBrandCatalog?.icon ?? 'Store', custom: !activeBrandCatalog }
    : null

  // Categories present within the active brand — union of what the
  // catalog lists for it (if it's a catalog brand) and whatever category
  // the keeper has actually filed this brand's own products under
  // (covers a custom brand entirely, and covers a keeper filing a
  // catalog brand's product somewhere the catalog didn't expect).
  const categoriesInBrand = useMemo(() => {
    if (!activeBrand) return []
    const slugs = new Set<string>()
    if (activeBrandCatalog) for (const it of activeBrandCatalog.items) slugs.add(it.category)
    for (const p of products) if (norm(p.company) === norm(activeBrand) && p.category) slugs.add(p.category)
    return [...slugs]
  }, [activeBrand, activeBrandCatalog, products])

  const countByBrandCategory = useMemo(() => {
    const counts: Record<string, number> = {}
    if (!activeBrand) return counts
    for (const p of products) {
      if (norm(p.company) !== norm(activeBrand) || !p.category) continue
      counts[p.category] = (counts[p.category] ?? 0) + 1
    }
    return counts
  }, [activeBrand, products])

  // Items inside the active brand + active brand-category: this shop's
  // own products under that brand (rendered via renderProduct, same as
  // everywhere else) plus that specific brand's catalog suggestions for
  // that specific category — narrower than category-wise browse's
  // suggestions, which pool every brand together.
  const brandCatalogSuggestions = useMemo(() => {
    if (!activeBrandCatalog || !activeBrandCatSlug) return []
    const owned = new Set(
      products.filter((p) => norm(p.company) === norm(activeBrand) && p.category === activeBrandCatSlug)
        .map((p) => `${norm(p.name)}|${norm(p.flavor)}`)
    )
    return activeBrandCatalog.items
      .filter((it) => it.category === activeBrandCatSlug)
      .map((it) => ({ item: it, owned: owned.has(`${norm(it.name)}|${norm(it.flavor)}`) }))
  }, [activeBrandCatalog, activeBrandCatSlug, activeBrand, products])

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.name_ur ?? '').includes(q))
  }, [query, products])

  const goDepartments = () => { setActiveDeptKey(null); setActiveCatSlug(null); setCatTab('items'); setActiveBrand(null); setActiveBrandCatSlug(null) }
  const goCategories = (deptKey: string) => { setActiveDeptKey(deptKey); setActiveCatSlug(null); setCatTab('items'); setActiveBrand(null); setActiveBrandCatSlug(null) }
  const openCategory = (slug: string) => { setActiveCatSlug(slug); setCatTab('items'); setActiveBrand(null); setActiveBrandCatSlug(null) }
  const goItemsTab = () => { setCatTab('items'); setActiveBrand(null); setActiveBrandCatSlug(null) }
  const goBrandsTab = () => { setCatTab('brands'); setActiveBrand(null); setActiveBrandCatSlug(null) }
  const goBrands = () => { setActiveBrand(null); setActiveBrandCatSlug(null) }
  const goBrandCategories = (brandName: string) => { setActiveBrand(brandName); setActiveBrandCatSlug(null) }

  const addNewBrand = () => {
    const name = window.prompt(t('cb.newBrandPrompt'))
    if (name && name.trim() && onAddNewBrand) onAddNewBrand(name.trim(), activeCat?.slug)
  }

  return (
    <div>
      <div className="relative mb-3">
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant/60 pointer-events-none" />
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t('cb.searchPlaceholder')}
          className="w-full ps-9 pe-3 py-2.5 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[14px] font-sans text-dp-on-surface"
        />
      </div>

      {searchResults ? (
        <>
          <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">{t('cb.searchResultsCount').replace('{n}', String(searchResults.length))}</p>
          {searchResults.length === 0 ? (
            <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.noMatches')}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">{searchResults.map(renderProduct)}</div>
          )}
        </>
      ) : !activeDept ? (
        <>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><LayoutGrid size={13} /> {t('cb.departmentsHeading')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {tree.map((d, i) => {
              const color = TILE_COLORS[i % TILE_COLORS.length]
              const count = countByDept[d.key] ?? 0
              return (
                <button key={d.key} onClick={() => goCategories(d.key)}
                  className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}>
                    <DynamicIcon name={d.icon} size={22} />
                  </div>
                  <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? d.label_ur : d.label}</span>
                  {count > 0 && <span className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant">{count} {t('mk.productsCount')}</span>}
                </button>
              )
            })}
          </div>
        </>
      ) : !activeCat ? (
        <>
          <div className="flex items-center gap-1.5 mb-3 font-sans text-[13px]">
            <button onClick={goDepartments} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
            <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
            <span className="font-semibold text-dp-on-surface">{isUrdu ? activeDept.label_ur : activeDept.label}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {activeDept.categories.map((c, i) => {
              const color = TILE_COLORS[i % TILE_COLORS.length]
              const count = countByCategory[c.slug] ?? 0
              return (
                <button key={c.slug} onClick={() => openCategory(c.slug)}
                  className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                  <div className={`w-11 h-11 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}>
                    <DynamicIcon name={activeDept.icon} size={20} />
                  </div>
                  <span className="font-sans text-[12px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? c.label_ur : c.label}</span>
                  {count > 0 && <span className="font-sans text-[10px] font-bold text-dp-on-surface-variant">{count}</span>}
                </button>
              )
            })}
          </div>
        </>
      ) : (
        // Inside a category: breadcrumb reads Departments > Dept > Category
        // and then extends further only once you've stepped into Brands
        // (> Brands > BrandName > BrandCategory) — the tab pills below let
        // you switch between "All Items" (your own stock, as before) and
        // "Brands" (browse by brand, scoped to start from this category
        // but opening into that brand's full range once picked).
        <>
          <div className="flex items-center gap-1.5 mb-3 font-sans text-[13px] flex-wrap">
            <button onClick={goDepartments} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
            <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
            <button onClick={() => goCategories(activeDeptKey!)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu ? activeDept.label_ur : activeDept.label}</button>
            <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
            {catTab === 'items' || !activeBrandInfo ? (
              <span className="font-semibold text-dp-on-surface">{isUrdu ? activeCat.label_ur : activeCat.label}</span>
            ) : (
              <button onClick={goItemsTab} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu ? activeCat.label_ur : activeCat.label}</button>
            )}
            {catTab === 'brands' && (
              <>
                <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
                {!activeBrandInfo ? (
                  <span className="font-semibold text-dp-on-surface">{t('cb.brandsHeading')}</span>
                ) : (
                  <button onClick={goBrands} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.brandsHeading')}</button>
                )}
              </>
            )}
            {activeBrandInfo && (
              <>
                <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
                {!activeBrandCatSlug ? (
                  <span className="font-semibold text-dp-on-surface">{isUrdu && !activeBrandInfo.custom ? activeBrandInfo.name_ur : activeBrandInfo.name}</span>
                ) : (
                  <button onClick={() => setActiveBrandCatSlug(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu && !activeBrandInfo.custom ? activeBrandInfo.name_ur : activeBrandInfo.name}</button>
                )}
              </>
            )}
            {activeBrandCatSlug && (
              <>
                <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
                <span className="font-semibold text-dp-on-surface">{getCategoryLabel(activeBrandCatSlug, isUrdu)}</span>
              </>
            )}
          </div>

          {!activeBrandInfo && (
            <div className="flex items-center gap-1.5 mb-4">
              <button onClick={goItemsTab} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-sans font-semibold cursor-pointer border ${catTab === 'items' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                <LayoutGrid size={13} /> {t('cb.allItemsTab')}
              </button>
              <button onClick={goBrandsTab} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-sans font-semibold cursor-pointer border ${catTab === 'brands' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>
                <Tags size={13} /> {t('cb.brandsHeading')}
              </button>
            </div>
          )}

          {catTab === 'items' ? (
            <>
              <div className="flex justify-end mb-4">
                <button onClick={() => onAddItem(activeCat.slug)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                  <PlusCircle size={15} /> {t('cb.addItemBtn')}
                </button>
              </div>
              {(countByCategory[activeCat.slug] ?? 0) === 0 ? (
                <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.categoryEmpty')}</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {products.filter((p) => p.category === activeCat.slug).map(renderProduct)}
                </div>
              )}
            </>
          ) : !activeBrandInfo ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {brandsInCategory.map((b, i) => {
                const color = TILE_COLORS[i % TILE_COLORS.length]
                const count = countByBrandInCategory[norm(b.name)] ?? 0
                return (
                  <button key={b.name} onClick={() => goBrandCategories(b.name)}
                    className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}>
                      <DynamicIcon name={b.icon} size={22} />
                    </div>
                    <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface leading-tight">{isUrdu && !b.custom ? b.name_ur : b.name}</span>
                    {count > 0 && <span className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant">{count} {t('mk.productsCount')}</span>}
                  </button>
                )
              })}
              {onAddNewBrand && (
                <button onClick={addNewBrand}
                  className="flex flex-col items-center justify-center gap-2 bg-dp-secondary-container/30 border-2 border-dashed border-dp-secondary/50 rounded-xl p-4 text-center hover:bg-dp-secondary-container/50 transition-all cursor-pointer">
                  <div className="w-12 h-12 rounded-full flex items-center justify-center bg-white text-dp-secondary"><PlusCircle size={22} /></div>
                  <span className="font-sans text-[12.5px] font-semibold text-dp-secondary leading-tight">{t('cb.addNewBrandBtn')}</span>
                </button>
              )}
              {brandsInCategory.length === 0 && !onAddNewBrand && (
                <p className="col-span-full text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.categoryEmpty')}</p>
              )}
            </div>
          ) : !activeBrandCatSlug ? (
            categoriesInBrand.length === 0 ? (
              <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.categoryEmpty')}</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {categoriesInBrand.map((slug, i) => {
                  const color = TILE_COLORS[i % TILE_COLORS.length]
                  const count = countByBrandCategory[slug] ?? 0
                  const parentDept = tree.find((d) => d.categories.some((c) => c.slug === slug))
                  return (
                    <button key={slug} onClick={() => setActiveBrandCatSlug(slug)}
                      className="flex flex-col items-center gap-2 bg-white border border-dp-outline-variant rounded-xl p-4 text-center hover:border-dp-secondary hover:shadow-sm transition-all cursor-pointer">
                      <div className={`w-11 h-11 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}>
                        <DynamicIcon name={parentDept?.icon ?? 'Package'} size={20} />
                      </div>
                      <span className="font-sans text-[12px] font-semibold text-dp-on-surface leading-tight">{getCategoryLabel(slug, isUrdu)}</span>
                      {count > 0 && <span className="font-sans text-[10px] font-bold text-dp-on-surface-variant">{count}</span>}
                    </button>
                  )
                })}
              </div>
            )
          ) : (
            <>
              <div className="flex justify-end mb-4">
                {onAddItemForBrand && (
                  <button onClick={() => onAddItemForBrand(activeBrandCatSlug, activeBrandInfo.name)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                    <PlusCircle size={15} /> {t('cb.addItemBtn')}
                  </button>
                )}
              </div>
              {(countByBrandCategory[activeBrandCatSlug] ?? 0) === 0 ? (
                <p className="text-center py-6 text-dp-on-surface-variant font-sans text-[14px]">{t('cb.categoryEmpty')}</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {products.filter((p) => norm(p.company) === norm(activeBrandInfo.name) && p.category === activeBrandCatSlug).map(renderProduct)}
                </div>
              )}
              {onPickCatalogItem && brandCatalogSuggestions.length > 0 && (
                <div className="mt-6">
                  <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Package size={13} /> {t('cb.brandRangeHeading')}</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {brandCatalogSuggestions.map((s, i) => (
                      <button key={i} type="button" disabled={s.owned}
                        onClick={() => !s.owned && onPickCatalogItem(activeBrandInfo.name, s.item)}
                        className={`flex flex-col items-start gap-0.5 rounded-lg p-2.5 text-start border ${s.owned ? 'bg-dp-secondary-container/30 border-dp-secondary-container cursor-default' : 'bg-white border-dp-outline-variant hover:border-dp-secondary cursor-pointer'}`}
                      >
                        <span className="font-sans text-[12px] font-semibold text-dp-on-surface leading-tight">{s.item.name}{s.item.flavor && ` — ${s.item.flavor}`}</span>
                        {s.owned ? (
                          <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-bold text-dp-secondary"><CircleCheck size={11} /> {t('cb.alreadyAddedBadge')}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-bold text-dp-primary"><PlusCircle size={11} /> {t('cb.addSuggestionBtn')}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// Compact department → category picker, no products/search/add-item — used
// wherever a form needs to let someone re-file an item into a different
// category (e.g. fixing an AI scan's guess) without bringing back a
// dropdown: same tile language as the main browser, just a picker.
export function CategoryPicker({ primaryType, value, onPick }: { primaryType: string; value: string; onPick: (slug: string) => void }) {
  const { t, isUrdu } = useLocale()
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const [deptKey, setDeptKey] = useState<string | null>(() => tree.find((d) => d.categories.some((c) => c.slug === value))?.key ?? null)
  const dept = tree.find((d) => d.key === deptKey)

  if (!dept) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 bg-dp-surface-container rounded-lg p-2.5 max-h-64 overflow-y-auto">
        {tree.map((d, i) => {
          const color = TILE_COLORS[i % TILE_COLORS.length]
          return (
            <button key={d.key} type="button" onClick={() => setDeptKey(d.key)}
              className="flex flex-col items-center gap-1.5 bg-white border border-dp-outline-variant rounded-lg p-2.5 hover:border-dp-secondary cursor-pointer">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}><DynamicIcon name={d.icon} size={16} /></div>
              <span className="font-sans text-[10.5px] font-semibold text-dp-on-surface text-center leading-tight">{isUrdu ? d.label_ur : d.label}</span>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="bg-dp-surface-container rounded-lg p-2.5 max-h-64 overflow-y-auto">
      <button type="button" onClick={() => setDeptKey(null)} className="font-sans text-[11.5px] font-semibold text-dp-secondary hover:underline cursor-pointer mb-2">{t('cb.departmentsHeading')}</button>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {dept.categories.map((c, i) => {
          const color = TILE_COLORS[i % TILE_COLORS.length]
          return (
            <button key={c.slug} type="button" onClick={() => onPick(c.slug)}
              className={`flex flex-col items-center gap-1.5 bg-white border rounded-lg p-2.5 hover:border-dp-secondary cursor-pointer ${c.slug === value ? 'border-dp-secondary ring-1 ring-dp-secondary' : 'border-dp-outline-variant'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}><DynamicIcon name={dept.icon} size={16} /></div>
              <span className="font-sans text-[10.5px] font-semibold text-dp-on-surface text-center leading-tight">{isUrdu ? c.label_ur : c.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
