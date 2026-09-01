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
// "Review & set prices" swaps the Add Stock tab's own content over to
// BulkPriceReview in place (no modal) — the selection basket lives here,
// not inside either child, so it survives switching tabs to peek at "My
// Stock" mid-pick and survives the browse/price swap for free.

import { useEffect, useRef, useState } from 'react'
import { Package, PackagePlus, Loader2, CheckCircle2, ChevronLeft } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useCatalogSelection } from '@/hooks/useCatalogSelection'
import { ownedKey } from '@/lib/catalogSelection'
import { CategoryBrowser } from './CategoryBrowser'
import { BrandItemPicker } from './BrandItemPicker'
import { BulkPriceReview } from './BulkPriceReview'

interface ShopCatalogSectionProps<P extends { name: string; name_ur?: string | null; company?: string | null; category: string | null; flavor?: string | null }> {
  shopId: string
  primaryType: string
  products: P[]
  renderProduct: (p: P) => React.ReactNode
  onAddItem: (categorySlug: string) => void
  onCommitted: () => void
}

const CHUNK_SIZE = 200

export function ShopCatalogSection<P extends { name: string; name_ur?: string | null; company?: string | null; category: string | null; flavor?: string | null }>({
  shopId, primaryType, products, renderProduct, onAddItem, onCommitted,
}: ShopCatalogSectionProps<P>) {
  const { t } = useLocale()
  const supabase = createClient()
  const selection = useCatalogSelection(shopId)
  const [tab, setTab] = useState<'mystock' | 'addstock'>(() => (products.length > 0 ? 'mystock' : 'addstock'))
  const [mode, setMode] = useState<'browse' | 'price'>('browse')
  const [committing, setCommitting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (tab !== 'addstock') setMode('browse') }, [tab])

  const commit = async () => {
    if (selection.count === 0) return
    if (selection.rowsMissingPrice.length > 0) { toast.error(t('bs.missingPriceToast')); return }
    setCommitting(true)

    const { data: freshProducts } = await supabase.from('shop_products').select('name, flavor').eq('shop_id', shopId)
    const freshOwned = new Set((freshProducts ?? []).map((p) => ownedKey(p.name, p.flavor)))

    const toInsert = selection.rowList.filter((r) => !freshOwned.has(ownedKey(r.name, r.flavor)))
    const skipped = selection.rowList.length - toInsert.length

    const payloads = toInsert.map((r) => ({
      shop_id: shopId,
      name: r.name.trim(), name_ur: r.name_ur.trim() || null,
      company: r.brandName.trim() || null, company_ur: r.brandName_ur.trim() || null,
      category: r.category, flavor: r.flavor.trim() || null, flavor_ur: r.flavor_ur.trim() || null,
      cost_price_pkr: r.cost_price_pkr === '' ? 0 : Number(r.cost_price_pkr),
      unit_price_pkr: Number(r.unit_price_pkr),
      quantity_on_hand: r.quantity_on_hand === '' ? 0 : Number(r.quantity_on_hand),
      expiry_date: r.expiry_date || null,
      is_active: true,
    })).filter((p) => p.name.length > 0)

    if (payloads.length === 0) {
      setCommitting(false)
      if (skipped > 0) toast.error(t('bs.allSkippedToast').replace('{n}', String(skipped)))
      return
    }

    setProgress({ done: 0, total: payloads.length })
    const sentKeys: string[] = []
    for (let i = 0; i < payloads.length; i += CHUNK_SIZE) {
      const chunk = payloads.slice(i, i + CHUNK_SIZE)
      const chunkRows = toInsert.slice(i, i + CHUNK_SIZE)
      const { error } = await supabase.from('shop_products').insert(chunk)
      if (error) {
        selection.deselectMany(sentKeys)
        setCommitting(false)
        setProgress(null)
        toast.error(friendlyError(error))
        return
      }
      sentKeys.push(...chunkRows.map((r) => r.key))
      setProgress({ done: Math.min(i + CHUNK_SIZE, payloads.length), total: payloads.length })
    }

    selection.clear()
    setCommitting(false)
    setProgress(null)
    toast.success(skipped > 0 ? t('bs.committedWithSkipsToast').replace('{n}', String(payloads.length)).replace('{s}', String(skipped)) : t('bs.committedToast').replace('{n}', String(payloads.length)))
    setMode('browse')
    setTab('mystock')
    onCommitted()
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-4 border-b border-dp-outline-variant">
        <button onClick={() => setTab('mystock')}
          className={`flex items-center gap-1.5 px-3.5 py-2.5 font-sans text-[13.5px] font-semibold cursor-pointer border-b-2 -mb-px ${tab === 'mystock' ? 'border-dp-secondary text-dp-secondary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}>
          <Package size={15} className="inline -mt-0.5 me-1.5" /> {t('bs.myStockTab')}{products.length > 0 && ` (${products.length})`}
        </button>
        <button onClick={() => setTab('addstock')}
          className={`flex items-center gap-1.5 px-3.5 py-2.5 font-sans text-[13.5px] font-semibold cursor-pointer border-b-2 -mb-px ${tab === 'addstock' ? 'border-dp-secondary text-dp-secondary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}>
          <PackagePlus size={15} className="inline -mt-0.5 me-1.5" /> {t('bs.addStockTab')}
        </button>
      </div>

      {tab === 'mystock' ? (
        <CategoryBrowser primaryType={primaryType} products={products} onAddItem={onAddItem} renderProduct={renderProduct} />
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

          {mode === 'price' && (
            <button onClick={() => setMode('browse')} className="flex items-center gap-1 font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer mb-3">
              <ChevronLeft size={15} /> {t('bs.backToBrowsingBtn')}
            </button>
          )}

          {mode === 'browse'
            ? <BrandItemPicker primaryType={primaryType} ownedProducts={products} selection={selection} />
            : <BulkPriceReview primaryType={primaryType} selection={selection} />}

          {selection.count > 0 && (
            <div ref={barRef} className="sticky bottom-0 mt-4 -mx-1 px-1 pb-1">
              <div className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-xl shadow-lg px-4 py-3">
                <span className="font-sans text-[13px] font-bold text-dp-on-surface-variant">{t('bs.selectedCount').replace('{n}', String(selection.count))}</span>
                {mode === 'browse' ? (
                  <button onClick={() => setMode('price')} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                    {t('bs.nextSetPricesBtn')}
                  </button>
                ) : (
                  <button onClick={commit} disabled={committing}
                    className="flex items-center gap-2 px-4 py-2 bg-dp-primary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:opacity-90 transition-all disabled:opacity-50">
                    {committing ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                    {progress ? `${progress.done} / ${progress.total}` : committing ? t('action.saving') : t('bs.saveAllBtn')}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
