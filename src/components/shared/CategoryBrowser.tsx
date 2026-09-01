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
import { ChevronRight, Search, PlusCircle, LayoutGrid, CircleCheck, Package } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree, type CategoryDepartment } from '@/lib/shopTypes'
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
}

export function CategoryBrowser<P extends { name: string; name_ur?: string | null; company?: string | null; flavor?: string | null; category: string | null }>({
  primaryType, products, renderProduct, onAddItem, onPickCatalogItem,
}: CategoryBrowserProps<P>) {
  const { t, isUrdu } = useLocale()
  const tree = useMemo(() => getShopTypeTree(primaryType), [primaryType])
  const [activeDeptKey, setActiveDeptKey] = useState<string | null>(null)
  const [activeCatSlug, setActiveCatSlug] = useState<string | null>(null)
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

  // Which catalog items belong in the category currently open, and which
  // of those the shop already stocks (matched on name+flavor — good
  // enough to tell "Sunsilk Black Shine" from "Sunsilk Lively Clean"
  // without needing an exact id link back to the catalog) — those render
  // as already-added instead of a pick target, so this doubles as a
  // "here's what you're missing from this range" checklist.
  const catalogSuggestions = useMemo(() => {
    if (!activeCat) return []
    const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
    const owned = new Set(products.filter((p) => p.category === activeCat.slug).map((p) => `${norm(p.name)}|${norm(p.flavor)}`))
    const hits: { brand: string; item: CatalogItem; owned: boolean }[] = []
    for (const b of PRODUCT_CATALOG) {
      for (const it of b.items) {
        if (it.category !== activeCat.slug) continue
        hits.push({ brand: b.name, item: it, owned: owned.has(`${norm(it.name)}|${norm(it.flavor)}`) })
      }
    }
    return hits
  }, [activeCat, products])

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.name_ur ?? '').includes(q))
  }, [query, products])

  const goDepartments = () => { setActiveDeptKey(null); setActiveCatSlug(null) }
  const goCategories = (deptKey: string) => { setActiveDeptKey(deptKey); setActiveCatSlug(null) }

  return (
    <div>
      <div className="relative mb-4">
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
                <button key={c.slug} onClick={() => setActiveCatSlug(c.slug)}
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
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <div className="flex items-center gap-1.5 font-sans text-[13px] flex-wrap">
              <button onClick={goDepartments} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{t('cb.departmentsHeading')}</button>
              <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
              <button onClick={() => setActiveCatSlug(null)} className="font-semibold text-dp-secondary hover:underline cursor-pointer">{isUrdu ? activeDept.label_ur : activeDept.label}</button>
              <ChevronRight size={14} className="text-dp-on-surface-variant rtl:rotate-180" />
              <span className="font-semibold text-dp-on-surface">{isUrdu ? activeCat.label_ur : activeCat.label}</span>
            </div>
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

          {onPickCatalogItem && catalogSuggestions.length > 0 && (
            <div className="mt-6">
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Package size={13} /> {t('cb.brandSuggestionsHeading')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {catalogSuggestions.map((s, i) => (
                  <button key={i} type="button" disabled={s.owned}
                    onClick={() => !s.owned && onPickCatalogItem(s.brand, s.item)}
                    className={`flex flex-col items-start gap-0.5 rounded-lg p-2.5 text-start border ${s.owned ? 'bg-dp-secondary-container/30 border-dp-secondary-container cursor-default' : 'bg-white border-dp-outline-variant hover:border-dp-secondary cursor-pointer'}`}
                  >
                    <span className="font-sans text-[12px] font-semibold text-dp-on-surface leading-tight">{s.item.name}{s.item.flavor && ` — ${s.item.flavor}`}</span>
                    <span className="font-sans text-[10px] text-dp-on-surface-variant">{s.brand}</span>
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
