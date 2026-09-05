'use client'

// The whole shop-catalog section on both admin/shops and portal/my-shop —
// two tabs, "My Stock" (CategoryBrowser, unchanged: browse/manage what's
// already listed) and "Add Stock" (BrandItemPicker: every brand visible
// immediately, tick many at once, brand-first with Departments as a
// second lens). No launcher button, no full-screen overlay — this is the
// direct correction for a real complaint: hiding brand/item browsing
// behind one "Add Stock" button + a multi-step wizard read as features
// having been deleted. Picking now happens inline, on the page.
//
// There is no "review & set prices" screen, and no "Save" step of any
// kind — the design handoff never has either. A tap on a catalog row
// commits straight to shop_products right then (BrandItemPicker owns
// that insert/delete itself now); tapping an already-stocked row deletes
// it just as immediately. useCatalogSelection still lives here (not
// inside BrandItemPicker) purely so a few keystrokes of cost/sale typed
// into a not-yet-ticked row survive switching over to peek at "My Stock"
// and back — it is never itself "the basket that gets saved" anymore.

import { useEffect, useRef, useState } from 'react'
import { Package, PackagePlus, LayoutGrid, List } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useCatalogSelection } from '@/hooks/useCatalogSelection'
import { CategoryBrowser } from './CategoryBrowser'
import { BrandItemPicker } from './BrandItemPicker'
import { StockListView, type StockListProduct } from './StockListView'

interface ShopCatalogSectionProps<P extends StockListProduct> {
  shopId: string
  primaryType: string
  products: P[]
  renderProduct: (p: P) => React.ReactNode
  onAddItem: (categorySlug: string) => void
  onCommitted: () => void
  // Powers the List view's inline qty/cost/sale editing — a direct
  // shop_products field update, not a full re-open-the-modal edit. Kept
  // as a prop (not done inside this component) so both callers' own
  // toast/refresh conventions stay in charge, same as onCommitted above.
  onInlineUpdate: (productId: string, field: 'cost_price_pkr' | 'unit_price_pkr' | 'quantity_on_hand', value: number) => void
  // Add Stock's own camera button (Shop Portal v3.dc.html's catalog
  // screen) reuses the exact same scan pipeline my-shop's page-level scan
  // button already wires up — not a second AI call, just a second place
  // to trigger the one that exists. Optional: admin/shops doesn't scan.
  onScanClick?: () => void
}

export function ShopCatalogSection<P extends StockListProduct>({
  shopId, primaryType, products, renderProduct, onAddItem, onCommitted, onInlineUpdate, onScanClick,
}: ShopCatalogSectionProps<P>) {
  const { t } = useLocale()
  const selection = useCatalogSelection(shopId)
  const [tab, setTab] = useState<'mystock' | 'addstock'>(() => (products.length > 0 ? 'mystock' : 'addstock'))
  const [stockView, setStockView] = useState<'tiles' | 'list'>('list')
  const userPickedTab = useRef(false)
  const setTabByUser = (t: 'mystock' | 'addstock') => { userPickedTab.current = true; setTab(t) }

  // products starts as [] on every mount (the parent fetches it async,
  // after this component has already rendered once) — the useState
  // initializer above only ever sees that empty array, so a shop that
  // genuinely HAS stock still opened on the Add Stock tab every time,
  // simply because the real product list hadn't arrived yet at the
  // instant the initial tab choice was made. Correct that exactly once,
  // the first time real products actually show up — never once the
  // keeper has clicked a tab themselves, so browsing Add Stock for more
  // items after already having stock doesn't get yanked back.
  useEffect(() => {
    if (userPickedTab.current) return
    if (products.length > 0) setTab('mystock')
  }, [products.length])

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-4 border-b border-dp-outline-variant">
        <button onClick={() => setTabByUser('mystock')}
          className={`flex items-center gap-1.5 px-3.5 py-2.5 font-sans text-[13.5px] font-semibold cursor-pointer border-b-2 -mb-px ${tab === 'mystock' ? 'border-dp-secondary text-dp-secondary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}>
          <Package size={15} className="inline -mt-0.5 me-1.5" /> {t('bs.myStockTab')}{products.length > 0 && ` (${products.length})`}
        </button>
        <button onClick={() => setTabByUser('addstock')}
          className={`flex items-center gap-1.5 px-3.5 py-2.5 font-sans text-[13.5px] font-semibold cursor-pointer border-b-2 -mb-px ${tab === 'addstock' ? 'border-dp-secondary text-dp-secondary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}>
          <PackagePlus size={15} className="inline -mt-0.5 me-1.5" /> {t('bs.addStockTab')}
        </button>
      </div>

      {tab === 'mystock' ? (
        <>
          {products.length > 0 && (
            <div className="flex items-center gap-1.5 mb-3">
              <button onClick={() => setStockView('list')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer border ${stockView === 'list' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant hover:bg-dp-surface-container'}`}>
                <List size={13} /> {t('sl.listViewTab')}
              </button>
              <button onClick={() => setStockView('tiles')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer border ${stockView === 'tiles' ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant hover:bg-dp-surface-container'}`}>
                <LayoutGrid size={13} /> {t('sl.tilesViewTab')}
              </button>
            </div>
          )}
          {stockView === 'list' && products.length > 0
            ? <StockListView products={products} onFieldSave={onInlineUpdate} />
            : <CategoryBrowser primaryType={primaryType} products={products} onAddItem={onAddItem} renderProduct={renderProduct} />}
        </>
      ) : (
        <>
          {selection.draftAvailable && (
            <div className="flex items-center justify-between gap-3 px-3.5 py-2 bg-dp-secondary-container/40 rounded-lg mb-3">
              <span className="font-sans text-[12px] text-dp-on-surface">{t('bs.draftFoundHint')}</span>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={selection.restoreDraft} className="font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer">{t('bs.restoreDraftBtn')}</button>
                <button onClick={selection.dismissDraft} className="font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer">{t('bs.discardDraftBtn')}</button>
              </div>
            </div>
          )}

          <BrandItemPicker shopId={shopId} primaryType={primaryType} ownedProducts={products} selection={selection} onBrandSubmitted={onCommitted} onScanClick={onScanClick} />
        </>
      )}
    </div>
  )
}
