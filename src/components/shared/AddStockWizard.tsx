'use client'

// "Add Stock" — the bulk catalog onboarding wizard: tick many reference-
// catalog items at once (StockPicker), set every price/stock/expiry in
// one dense pass (BulkPriceReview), then a single batched insert instead
// of the old one-modal-per-product cycle. Mounted once by both
// admin/shops and portal/my-shop with the same props — all the bulk-add
// Supabase writing lives here so neither page duplicates it.
//
// Brand is deliberately not a navigation level into the catalog here —
// see StockPicker's header comment. It survives only inside a category's
// item list as a group header + filter chip, and (unchanged) inside
// CategoryBrowser as a lens on a shop's own existing stock.

import { useEffect, useState } from 'react'
import { X, ChevronLeft, Loader2, PackagePlus, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useCatalogSelection } from '@/hooks/useCatalogSelection'
import { ownedKey } from '@/lib/catalogSelection'
import { StockPicker } from './StockPicker'
import { BulkPriceReview } from './BulkPriceReview'

interface OwnedProduct { name: string; flavor?: string | null }

interface AddStockWizardProps {
  shopId: string
  primaryType: string
  existingProducts: OwnedProduct[]
  onCommitted: () => void
  onClose: () => void
}

const CHUNK_SIZE = 200

export function AddStockWizard({ shopId, primaryType, existingProducts, onCommitted, onClose }: AddStockWizardProps) {
  const { t } = useLocale()
  const supabase = createClient()
  const selection = useCatalogSelection(shopId)
  const [step, setStep] = useState<'pick' | 'price'>('pick')
  const [committing, setCommitting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  // A body-scroll-lock for a full-screen overlay, same pattern as any
  // other fixed-inset modal in this app, just applied for as long as the
  // wizard (not just a single modal open/close) is up.
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const commit = async () => {
    if (selection.count === 0) return
    if (selection.rowsMissingPrice.length > 0) { toast.error(t('bs.missingPriceToast')); return }
    setCommitting(true)

    // The basket may be several minutes old — re-check what's actually in
    // the shop right now rather than trust the ownedProducts snapshot the
    // wizard opened with, so a keeper who ticks something, gets
    // interrupted, and comes back later doesn't create a duplicate.
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
        // Whatever already landed stays out of the basket on retry; only
        // the unsent tail remains ticked, so a retry never double-inserts.
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
    onCommitted()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[110] flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="bg-white sm:rounded-xl w-full sm:max-w-2xl h-full sm:h-auto sm:max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-dp-outline-variant shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {step === 'price' && (
              <button onClick={() => setStep('pick')} className="p-1 -ms-1 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer shrink-0"><ChevronLeft size={20} /></button>
            )}
            <div className="min-w-0">
              <h2 className="font-heading text-[17px] font-bold text-dp-primary flex items-center gap-2 truncate"><PackagePlus size={18} className="shrink-0" /> {t('bs.wizardTitle')}</h2>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{step === 'pick' ? t('bs.stepPickLabel') : t('bs.stepPriceLabel')}</p>
            </div>
          </div>
          <button onClick={onClose} className="cursor-pointer shrink-0"><X size={20} /></button>
        </div>

        {selection.draftAvailable && (
          <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-2 bg-dp-secondary-container/40 shrink-0">
            <span className="font-sans text-[12px] text-dp-on-surface">{t('bs.draftFoundHint')}</span>
            <div className="flex items-center gap-3 shrink-0">
              <button onClick={selection.restoreDraft} className="font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer">{t('bs.restoreDraftBtn')}</button>
              <button onClick={selection.dismissDraft} className="font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer">{t('bs.discardDraftBtn')}</button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4">
          {step === 'pick'
            ? <StockPicker primaryType={primaryType} ownedProducts={existingProducts} selection={selection} />
            : <BulkPriceReview primaryType={primaryType} selection={selection} />}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 border-t border-dp-outline-variant shrink-0">
          <span className="font-sans text-[13px] font-bold text-dp-on-surface-variant">{t('bs.selectedCount').replace('{n}', String(selection.count))}</span>
          {step === 'pick' ? (
            <button onClick={() => setStep('price')} disabled={selection.count === 0}
              className="px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              {t('bs.nextSetPricesBtn')}
            </button>
          ) : (
            <button onClick={commit} disabled={committing || selection.count === 0}
              className="flex items-center gap-2 px-5 py-2.5 bg-dp-primary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              {committing ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              {progress ? `${progress.done} / ${progress.total}` : committing ? t('action.saving') : t('bs.saveAllBtn')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
