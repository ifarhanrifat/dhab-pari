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
import { ChevronRight, Search, PlusCircle, LayoutGrid } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getShopTypeTree, type CategoryDepartment } from '@/lib/shopTypes'
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

interface CategoryBrowserProps<P extends { name: string; name_ur?: string | null; category: string | null }> {
  primaryType: string
  products: P[]
  renderProduct: (p: P) => React.ReactNode
  onAddItem: (categorySlug: string) => void
}

export function CategoryBrowser<P extends { name: string; name_ur?: string | null; category: string | null }>({
  primaryType, products, renderProduct, onAddItem,
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
