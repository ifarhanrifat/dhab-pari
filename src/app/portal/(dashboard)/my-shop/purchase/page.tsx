'use client'

// Purchase entry — "سٹاک شامل کریں" in the design spec (§3), distinct from
// my-shop's own "Add Stock" tab (which is about ticking NEW items into the
// catalog for the first time). This is a RESTOCK of items already carried:
// supplier, a search over the shop's own existing products, ± steppers,
// an editable unit-cost field per line (prices from the supplier drift),
// and a running total at cost. Committing calls record_shop_purchase
// (migration 434, weighted-average costing added in 451), which
// increments quantity_on_hand and blends this purchase's cost into the
// existing stock's own average cost — buying 3 more dozen bananas at a
// different price than the 2 dozen already on the shelf doesn't just
// discard the old batch's cost, it weights both together. Sale price is
// never touched here, repricing to the customer stays a separate
// decision. Each line shows that resulting average live, before
// committing, so it's never a surprise.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, PackagePlus, Loader2, Minus, Plus, Trash2, Search, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarqueeText } from '@/components/shared/MarqueeText'

const INK = '#201e1d'
const ACCENT = '#ec3013'

interface Shop { id: string; name: string; name_ur: string | null }
interface Product { id: string; name: string; name_ur: string | null; company: string | null; flavor: string | null; flavor_ur: string | null; cost_price_pkr: number; quantity_on_hand: number; unit: string }

function displayName(p: { name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null }, isUrdu: boolean) {
  const name = isUrdu && p.name_ur ? p.name_ur : p.name
  const flavor = isUrdu ? (p.flavor_ur || p.flavor) : p.flavor
  return flavor ? `${name} (${flavor})` : name
}
// existingQty/existingCost snapshot what's already on the shelf at the
// moment this line was added — used only to preview the resulting
// weighted-average cost live; the actual average is always recomputed
// server-side by record_shop_purchase itself, this is purely a preview.
interface Line { product_id: string; name: string; unit: string; unit_cost_pkr: number; quantity: number; existingQty: number; existingCost: number }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// Module-level, not defined inside PurchaseEntryPage's own render body —
// same reasoning as every other hoisted row component in this codebase
// (BrandItemPicker's ItemRow, StockListView's Row): a component declared
// inside a parent's function body gets a fresh identity every render,
// which remounts its <input>s and loses focus/local state on every
// keystroke elsewhere on the page.
//
// "calculate from total" here is the direct fix for a real live mistake:
// a shopkeeper bought bananas by the dozen (3 دوزن) but the product's
// own price is tracked per-unit, whatever that unit is — if they typed
// "3" as the quantity meaning "3 dozen" while the cost field expected a
// per-unit rate, the purchase silently priced it as 3 pieces, not 3
// dozen. Same qty+total-paid -> per-unit divide LooseRow/the product
// edit form already have, so "36 pieces for Rs 900 total" divides out
// correctly regardless of what unit the product actually tracks in.
interface PurchaseLineCardProps {
  r: Line; t: (k: string) => string
  onRemove: () => void; onSetQty: (qty: number) => void; onSetCost: (cost: number) => void
  previewAvgCost: number
}
function PurchaseLineCard({ r, t, onRemove, onSetQty, onSetCost, previewAvgCost }: PurchaseLineCardProps) {
  const [showCalc, setShowCalc] = useState(false)
  const [calcQty, setCalcQty] = useState('')
  const [calcTotal, setCalcTotal] = useState('')
  const calcQtyNum = Number(calcQty)
  const calcTotalNum = Number(calcTotal)
  const computedCost = calcQtyNum > 0 && calcTotalNum >= 0 ? Math.round((calcTotalNum / calcQtyNum) * 100) / 100 : null
  const applyCalc = () => {
    if (computedCost === null || calcQtyNum <= 0) return
    onSetCost(computedCost)
    onSetQty(calcQtyNum)
    setShowCalc(false); setCalcQty(''); setCalcTotal('')
  }
  return (
    <div className="bg-white border border-[#dcd8d4] p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <MarqueeText text={r.name} className="font-sans text-[13.5px] font-semibold" style={{ color: INK }} />
        <button onClick={onRemove} className="p-1 cursor-pointer shrink-0" style={{ color: ACCENT }}><Trash2 size={14} /></button>
      </div>
      {/* The unit shown here is whatever's set on the product's own edit
          form (pencil button) — this screen only ever adds quantity +
          cost IN that unit, it never changes what the unit itself is. */}
      <p className="font-sans text-[10.5px] text-[#7a736d] mb-1.5">
        {t('sk.buyingInUnitHint').replace('{unit}', r.unit)}
        {r.existingQty > 0 && ' · ' + t('sk.currentlyOnHandLabel').replace('{qty}', fmt(r.existingQty)).replace('{cost}', fmt(r.existingCost))}
      </p>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col items-start gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="font-sans text-[11.5px] text-[#7a736d]">{t('sk.costPriceLabel')} <span className="ltr-num">({r.unit})</span></span>
            <input type="number" value={r.unit_cost_pkr || ''} onChange={(e) => onSetCost(+e.target.value)}
              className="w-20 px-2 py-1 border text-[13px] font-sans text-center ltr-num" style={{ borderColor: '#f4a68f', background: '#fce3dc', color: '#ae1800' }} />
          </div>
          <button type="button" onClick={() => setShowCalc((s) => !s)} className="font-sans text-[10px] underline cursor-pointer" style={{ color: ACCENT }}>{t('sk.calcFromTotalBtn')}</button>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => onSetQty(r.quantity - 1)} className="w-8 h-8 border border-[#dcd8d4] flex items-center justify-center cursor-pointer hover:border-[#201e1d] transition-colors"><Minus size={14} /></button>
          <span className="text-center font-sans text-[14px] font-bold ltr-num whitespace-nowrap px-1" style={{ color: INK }}>{r.quantity} {r.unit}</span>
          <button onClick={() => onSetQty(r.quantity + 1)} className="w-8 h-8 border border-[#dcd8d4] flex items-center justify-center cursor-pointer hover:border-[#201e1d] transition-colors"><Plus size={14} /></button>
        </div>
      </div>
      {showCalc && (
        <div className="flex items-center gap-1.5 mt-2 p-2 border border-dashed" style={{ borderColor: '#dcd8d4' }}>
          <input inputMode="decimal" value={calcQty} onChange={(e) => setCalcQty(e.target.value)} placeholder={t('sk.calcQtyInUnitPlaceholder').replace('{unit}', r.unit)}
            className="w-20 px-1.5 py-1.5 text-center border font-sans text-[11px]" style={{ borderColor: '#dcd8d4' }} />
          <span className="font-sans text-[10px] text-[#7a736d] shrink-0">{t('sk.calcForPlaceholder')}</span>
          <input inputMode="decimal" value={calcTotal} onChange={(e) => setCalcTotal(e.target.value)} placeholder={t('sk.calcTotalPlaceholder')}
            className="w-20 px-1.5 py-1.5 text-center border font-sans text-[11px]" style={{ borderColor: '#dcd8d4' }} />
          <button type="button" onClick={applyCalc} disabled={computedCost === null}
            className="flex-1 py-1.5 text-white font-sans text-[10.5px] font-bold cursor-pointer disabled:opacity-40" style={{ background: ACCENT }}>
            {computedCost !== null ? t('sk.calcUseValueBtn').replace('{v}', String(computedCost)) : t('sk.calcUseBtn')}
          </button>
        </div>
      )}
      <div className="flex items-center justify-between mt-1.5">
        <p className="font-sans text-[11px] text-[#7a736d]">{t('sk.newAvgCostLabel')} <span className="font-bold ltr-num" style={{ color: INK }}>{fmt(previewAvgCost)}</span></p>
        <p className="font-sans text-[12px] text-[#7a736d]">{t('sk.lineTotalLabel')} <span className="font-bold ltr-num" style={{ color: INK }}>{fmt(r.unit_cost_pkr * r.quantity)}</span></p>
      </div>
    </div>
  )
}

export default function PurchaseEntryPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [supplier, setSupplier] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [completing, setCompleting] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.from('shops').select('id, name, name_ur').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      setShop(data)
      if (data) {
        supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, cost_price_pkr, quantity_on_hand, unit')
          .eq('shop_id', data.id).eq('is_active', true).order('name')
          .then(({ data: p }) => { setProducts(p ?? []); setLoading(false) })
      } else setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const addLine = (p: Product) => {
    setLines((rows) => {
      const existing = rows.find((r) => r.product_id === p.id)
      if (existing) return rows.map((r) => r.product_id === p.id ? { ...r, quantity: r.quantity + 1 } : r)
      return [...rows, { product_id: p.id, name: displayName(p, isUrdu), unit: p.unit, unit_cost_pkr: p.cost_price_pkr, quantity: 1, existingQty: p.quantity_on_hand, existingCost: p.cost_price_pkr }]
    })
    setShowSearch(false)
    setSearch('')
  }
  // Preview only — record_shop_purchase (451) computes the real average
  // itself, server-side, from whatever quantity_on_hand/cost_price_pkr
  // actually are at commit time.
  const previewAvgCost = (r: Line) => {
    const oldQty = Math.max(r.existingQty, 0)
    const denom = oldQty + r.quantity
    if (denom <= 0) return r.unit_cost_pkr
    return Math.round(((oldQty * r.existingCost + r.quantity * r.unit_cost_pkr) / denom) * 100) / 100
  }
  const setQty = (productId: string, qty: number) => {
    setLines((rows) => rows.map((r) => r.product_id === productId ? { ...r, quantity: Math.max(1, qty) } : r))
  }
  const setCost = (productId: string, cost: number) => {
    setLines((rows) => rows.map((r) => r.product_id === productId ? { ...r, unit_cost_pkr: Math.max(0, cost) } : r))
  }
  const removeLine = (productId: string) => setLines((rows) => rows.filter((r) => r.product_id !== productId))

  const total = lines.reduce((s, r) => s + r.unit_cost_pkr * r.quantity, 0)

  const complete = async () => {
    if (lines.length === 0) return
    setCompleting(true)
    const items = lines.map((r) => ({ product_id: r.product_id, quantity: r.quantity, unit_cost_pkr: r.unit_cost_pkr }))
    const { error } = await supabase.rpc('record_shop_purchase', { p_shop_id: shop!.id, p_supplier: supplier.trim() || null, p_items: items })
    setCompleting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.purchaseCompletedToast'))
    setLines([])
    setSupplier('')
    supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, cost_price_pkr, quantity_on_hand, unit')
      .eq('shop_id', shop!.id).eq('is_active', true).order('name').then(({ data }) => setProducts(data ?? []))
  }

  const filtered = search.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || (p.name_ur ?? '').includes(search)
        || (p.company ?? '').toLowerCase().includes(search.toLowerCase()) || (p.flavor ?? '').toLowerCase().includes(search.toLowerCase()) || (p.flavor_ur ?? '').includes(search))
    : products

  if (userLoading || loading) return <div className="text-center py-12 text-[#7a736d] font-sans"><LoadingDots /></div>
  if (!shop) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('sk.noShopLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline mb-3" style={{ color: ACCENT }}><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] mb-1 flex items-center gap-2" style={{ color: INK }}><PackagePlus size={22} /> {t('sk.purchaseEntryBtn')}</h1>
      <p className="font-sans text-[13px] text-[#7a736d] mb-5">{t('sk.purchaseEntrySubtitle')}</p>

      <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={t('sk.supplierPlaceholder')} className="input-field mb-4" />

      <button onClick={() => setShowSearch(true)} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed font-sans text-[14px] font-semibold cursor-pointer hover:bg-[#f7f6f5] transition-all mb-4" style={{ borderColor: '#dcd8d4', color: ACCENT }}>
        <Search size={16} /> {t('sk.addItemToPurchaseBtn')}
      </button>

      {lines.length === 0 ? (
        <p className="text-center py-8 text-[#7a736d] font-sans text-[14px]">{t('sk.purchaseEmpty')}</p>
      ) : (
        <div className="space-y-2 mb-5">
          {lines.map((r) => (
            <PurchaseLineCard key={r.product_id} r={r} t={t}
              onRemove={() => removeLine(r.product_id)}
              onSetQty={(qty) => setQty(r.product_id, qty)}
              onSetCost={(cost) => setCost(r.product_id, cost)}
              previewAvgCost={previewAvgCost(r)} />
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <div className="bg-white border border-[#dcd8d4] p-4 sticky bottom-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-sans text-[14px] font-bold" style={{ color: INK }}>{t('sk.purchaseTotalLabel')}</p>
            <p className="font-sans text-[20px] font-bold" style={{ color: INK }}>{fmt(total)}</p>
          </div>
          <button onClick={complete} disabled={completing} className="w-full flex items-center justify-center gap-2 text-white py-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: INK }}>
            {completing ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {completing ? t('action.saving') : t('sk.completePurchaseBtn')}
          </button>
        </div>
      )}

      {showSearch && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-start justify-center p-4 pt-16" onClick={() => setShowSearch(false)}>
          <div className="bg-white p-4 w-full max-w-md max-h-[75vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sk.searchOwnCatalogPlaceholder')} className="input-field mb-3" />
            <div className="space-y-1">
              {filtered.map((p) => (
                <button key={p.id} onClick={() => addLine(p)} className="w-full text-start flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-[#f7f6f5] cursor-pointer">
                  <MarqueeText text={displayName(p, isUrdu)} className="min-w-0 flex-1 font-sans text-[13.5px]" style={{ color: INK }} />
                  <span className="shrink-0 font-sans text-[12.5px] font-bold" style={{ color: '#ae1800' }}>{fmt(p.cost_price_pkr)}</span>
                </button>
              ))}
              {filtered.length === 0 && <p className="text-center py-6 text-[#7a736d] font-sans text-[13px]">{t('mp.noResults')}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
