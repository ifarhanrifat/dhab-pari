'use client'

// Third way to add a product, alongside typing one in by hand and the AI
// camera scan: pick a real brand, then the exact item/flavor, from a
// curated catalog of major Pakistani FMCG brands (src/lib/productCatalog.ts)
// — two taps and the Add Product form opens pre-filled with name, company,
// flavor and category. No dropdown, no typing the brand name correctly,
// nothing an unfamiliar keeper could get wrong. Price/stock/photo are
// always left to the keeper, exactly like every other add path here.

import { useMemo, useState } from 'react'
import { ChevronRight, Search, Package } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PRODUCT_CATALOG, type CatalogItem } from '@/lib/productCatalog'
import { getCategoryLabel } from '@/lib/shopTypes'
import { DynamicIcon } from './DynamicIcon'
import { TILE_COLORS } from './CategoryBrowser'

interface Props {
  onPick: (brandName: string, item: CatalogItem) => void
}

export function ProductCatalogPicker({ onPick }: Props) {
  const { t, isUrdu } = useLocale()
  const [brandSlug, setBrandSlug] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const brand = PRODUCT_CATALOG.find((b) => b.slug === brandSlug)

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const hits: { brand: string; item: CatalogItem }[] = []
    for (const b of PRODUCT_CATALOG) {
      for (const it of b.items) {
        const label = `${it.name} ${it.flavor ?? ''} ${b.name}`.toLowerCase()
        if (label.includes(q)) hits.push({ brand: b.name, item: it })
      }
    }
    return hits
  }, [query])

  return (
    <div>
      <div className="relative mb-3">
        <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant/60 pointer-events-none" />
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pc.searchPlaceholder')}
          className="w-full ps-9 pe-3 py-2.5 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[13.5px] font-sans text-dp-on-surface"
        />
      </div>

      {searchResults ? (
        searchResults.length === 0 ? (
          <p className="text-center py-6 text-dp-on-surface-variant font-sans text-[13px]">{t('cb.noMatches')}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
            {searchResults.map((r, i) => (
              <button key={i} type="button" onClick={() => onPick(r.brand, r.item)}
                className="flex flex-col items-start gap-1 bg-white border border-dp-outline-variant rounded-lg p-2.5 text-start hover:border-dp-secondary cursor-pointer">
                <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface leading-tight">{r.item.name}{r.item.flavor && ` — ${r.item.flavor}`}</span>
                <span className="font-sans text-[10.5px] text-dp-on-surface-variant">{r.brand}</span>
              </button>
            ))}
          </div>
        )
      ) : !brand ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
          {PRODUCT_CATALOG.map((b, i) => {
            const color = TILE_COLORS[i % TILE_COLORS.length]
            return (
              <button key={b.slug} type="button" onClick={() => setBrandSlug(b.slug)}
                className="flex flex-col items-center gap-1.5 bg-white border border-dp-outline-variant rounded-lg p-2.5 text-center hover:border-dp-secondary cursor-pointer">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center ${color.bg} ${color.text}`}><DynamicIcon name={b.icon} size={17} /></div>
                <span className="font-sans text-[11.5px] font-semibold text-dp-on-surface leading-tight">{isUrdu ? b.name_ur : b.name}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <div>
          <button type="button" onClick={() => setBrandSlug(null)} className="inline-flex items-center gap-1 font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer mb-2">
            <ChevronRight size={13} className="rtl:rotate-180" /> {t('pc.allBrandsBtn')}
          </button>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em] mb-2">{isUrdu ? brand.name_ur : brand.name}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
            {brand.items.map((it, i) => (
              <button key={i} type="button" onClick={() => onPick(brand.name, it)}
                className="flex flex-col items-start gap-1 bg-white border border-dp-outline-variant rounded-lg p-2.5 text-start hover:border-dp-secondary cursor-pointer">
                <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface leading-tight">{it.name}{it.flavor && ` — ${it.flavor}`}</span>
                <span className="font-sans text-[10px] text-dp-on-surface-variant flex items-center gap-1"><Package size={9} /> {getCategoryLabel(it.category, isUrdu)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
