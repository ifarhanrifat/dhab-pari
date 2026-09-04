'use client'

// "نیا برانڈ شامل کریں" — design spec §3's برانڈ builder, for a brand
// genuinely missing from PRODUCT_CATALOG. Brand name (Latin + Urdu) +
// category, then any number of items (name + optional flavor/variant +
// cost + sale). Submitting calls submit_catalog_brand (migration 435):
// real shop_products rows land in THIS shop immediately, plus a review
// record for the committee — see that migration's own header comment
// for what's deliberately NOT built yet (a live merge into every other
// shop's catalog).
//
// The AI camera step reuses the exact same Gemini endpoint the main
// catalog page's scan button already calls (/api/portal/shops/
// scan-product) — no new AI route needed. Its role here is specifically
// the gap the tick-a-known-brand flow can't fill: drafting fields for
// something the shared catalog doesn't know about yet. First scan (if
// the brand name is still blank) also seeds the brand name from the
// packaging's own company field.

import { useRef, useState } from 'react'
import { X, Plus, Trash2, Camera, Loader2, PackagePlus, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { CategoryPicker } from './CategoryBrowser'
import { getCategoryLabel } from '@/lib/shopTypes'

interface BrandItemDraft {
  key: string
  name: string; name_ur: string; flavor: string; flavor_ur: string
  cost_price_pkr: string; unit_price_pkr: string
}

function emptyItem(): BrandItemDraft {
  return { key: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: '', name_ur: '', flavor: '', flavor_ur: '', cost_price_pkr: '', unit_price_pkr: '' }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function BrandBuilderModal({ shopId, primaryType, onClose, onSubmitted }: {
  shopId: string; primaryType: string; onClose: () => void; onSubmitted: () => void
}) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const scanInputRef = useRef<HTMLInputElement>(null)

  const [brandName, setBrandName] = useState('')
  const [brandNameUr, setBrandNameUr] = useState('')
  const [category, setCategory] = useState('')
  const [items, setItems] = useState<BrandItemDraft[]>([emptyItem()])
  const [scanning, setScanning] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const setItemField = (key: string, field: keyof BrandItemDraft, value: string) =>
    setItems((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)))
  const addItem = () => setItems((rows) => [...rows, emptyItem()])
  const removeItem = (key: string) => setItems((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== key) : rows))

  const runScan = async (file: File) => {
    setScanning(true)
    try {
      const { data: aiSettings } = await supabase.from('shop_ai_settings').select('gemini_api_key').eq('shop_id', shopId).maybeSingle()
      if (!aiSettings?.gemini_api_key) { toast.error(t('sk.needKeyFirst')); setScanning(false); return }

      const imageBase64 = await fileToBase64(file)
      const res = await fetch('/api/portal/shops/scan-product', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId, imageBase64, mimeType: file.type }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? t('sk.scanFailed')); setScanning(false); return }

      if (!brandName.trim() && json.company) setBrandName(json.company)
      if (!category && json.category) setCategory(json.category)
      setItems((rows) => {
        const draft = { ...emptyItem(), name: json.name || '', name_ur: json.name_ur || '', flavor: json.flavor || '', flavor_ur: json.flavor_ur || '' }
        // Fill the first still-empty row rather than always appending —
        // scanning right after opening a fresh modal should land in row 1.
        const idx = rows.findIndex((r) => !r.name.trim())
        if (idx === -1) return [...rows, draft]
        const next = [...rows]; next[idx] = { ...draft, key: rows[idx].key }
        return next
      })
      toast.success(t('sk.scanDraftedToast'))
    } catch {
      toast.error(t('sk.scanFailed'))
    } finally {
      setScanning(false)
      if (scanInputRef.current) scanInputRef.current.value = ''
    }
  }

  const submit = async () => {
    if (!brandName.trim()) { toast.error(t('bb.brandNameRequired')); return }
    if (!category) { toast.error(t('bb.categoryRequired')); return }
    const validItems = items.filter((r) => r.name.trim())
    if (validItems.length === 0) { toast.error(t('bb.atLeastOneItem')); return }

    setSubmitting(true)
    const payload = validItems.map((r) => ({
      name: r.name.trim(), name_ur: r.name_ur.trim() || null, flavor: r.flavor.trim() || null, flavor_ur: r.flavor_ur.trim() || null,
      cost_price_pkr: r.cost_price_pkr === '' ? 0 : Number(r.cost_price_pkr), unit_price_pkr: r.unit_price_pkr === '' ? 0 : Number(r.unit_price_pkr),
    }))
    const { error } = await supabase.rpc('submit_catalog_brand', {
      p_shop_id: shopId, p_brand_name: brandName.trim(), p_brand_name_ur: brandNameUr.trim() || null, p_category: category, p_items: payload,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('bb.submittedToast'))
    onSubmitted()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary flex items-center gap-2"><PackagePlus size={18} /> {t('bb.title')}</h2>
          <button onClick={onClose} className="cursor-pointer"><X size={20} /></button>
        </div>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('bb.subtitle')}</p>

        <input ref={scanInputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runScan(f) }} />
        <button onClick={() => scanInputRef.current?.click()} disabled={scanning}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-60 mb-4">
          {scanning ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />} {scanning ? t('sk.scanningLabel') : t('bb.scanToDraftBtn')}
        </button>

        <div className="space-y-3 mb-4">
          <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder={t('bb.brandNamePlaceholder')} className="input-field" />
          <input value={brandNameUr} onChange={(e) => setBrandNameUr(e.target.value)} placeholder={t('bb.brandNameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
          <div>
            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.categoryLabel')}</label>
            {category ? (
              <div className="flex items-center justify-between gap-2 bg-dp-secondary-container/40 rounded-lg px-3 py-2.5">
                <span className="font-sans text-[13.5px] font-semibold text-dp-secondary">{getCategoryLabel(category, isUrdu)}</span>
                <button type="button" onClick={() => setCategory('')} className="font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer shrink-0">{t('sk.changeCategoryBtn')}</button>
              </div>
            ) : (
              <CategoryPicker primaryType={primaryType} value="" onPick={setCategory} />
            )}
          </div>
        </div>

        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{t('bb.itemsHeading')}</p>
        <div className="space-y-3 mb-3">
          {items.map((r, i) => (
            <div key={r.key} className="bg-dp-surface-container rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant">{t('bb.itemLabel')} {i + 1}</span>
                {items.length > 1 && <button onClick={() => removeItem(r.key)} className="text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>}
              </div>
              <input value={r.name} onChange={(e) => setItemField(r.key, 'name', e.target.value)} placeholder={t('mk.productNamePlaceholder')} className="input-field" />
              <input value={r.name_ur} onChange={(e) => setItemField(r.key, 'name_ur', e.target.value)} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <div className="grid grid-cols-2 gap-2">
                <input value={r.flavor} onChange={(e) => setItemField(r.key, 'flavor', e.target.value)} placeholder={t('sk.flavorPlaceholder')} className="input-field" />
                <input value={r.flavor_ur} onChange={(e) => setItemField(r.key, 'flavor_ur', e.target.value)} placeholder={t('sk.flavorUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" value={r.cost_price_pkr} onChange={(e) => setItemField(r.key, 'cost_price_pkr', e.target.value)} placeholder={t('sk.costPriceLabel')} className="input-field" />
                <input type="number" value={r.unit_price_pkr} onChange={(e) => setItemField(r.key, 'unit_price_pkr', e.target.value)} placeholder={t('mk.unitPriceLabel')} className="input-field" />
              </div>
            </div>
          ))}
        </div>
        <button onClick={addItem} className="w-full flex items-center justify-center gap-2 px-3 py-2 border-2 border-dashed border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface-variant cursor-pointer hover:bg-dp-surface-container mb-4">
          <Plus size={14} /> {t('bb.addAnotherItemBtn')}
        </button>

        <button onClick={submit} disabled={submitting} className="w-full flex items-center justify-center gap-2 bg-dp-primary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:opacity-90 transition-all disabled:opacity-50">
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {submitting ? t('action.saving') : t('bb.submitBtn')}
        </button>
      </div>
    </div>
  )
}
