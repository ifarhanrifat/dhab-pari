'use client'

// Purchase entry — "سٹاک شامل کریں" in the design spec (§3), distinct from
// my-shop's own "Add Stock" tab (which is about ticking NEW items into the
// catalog for the first time). This is a RESTOCK of items already carried:
// supplier, a search over the shop's own existing products, ± steppers,
// an editable unit-cost field per line (prices from the supplier drift),
// and a running total at cost. Committing calls record_shop_purchase
// (migration 434), which increments quantity_on_hand and rolls
// cost_price_pkr forward to the new buying price — sale price is never
// touched here, repricing to the customer stays a separate decision.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, PackagePlus, Loader2, Minus, Plus, Trash2, Search, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop { id: string; name: string; name_ur: string | null }
interface Product { id: string; name: string; name_ur: string | null; company: string | null; flavor: string | null; flavor_ur: string | null; cost_price_pkr: number }

function displayName(p: { name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null }, isUrdu: boolean) {
  const name = isUrdu && p.name_ur ? p.name_ur : p.name
  const flavor = isUrdu ? (p.flavor_ur || p.flavor) : p.flavor
  return flavor ? `${name} (${flavor})` : name
}
interface Line { product_id: string; name: string; unit_cost_pkr: number; quantity: number }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
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
        supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, cost_price_pkr')
          .eq('shop_id', data.id).eq('is_active', true).order('name')
          .then(({ data: p }) => { setProducts(p ?? []); setLoading(false) })
      } else setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const addLine = (p: Product) => {
    setLines((rows) => {
      const existing = rows.find((r) => r.product_id === p.id)
      if (existing) return rows.map((r) => r.product_id === p.id ? { ...r, quantity: r.quantity + 1 } : r)
      return [...rows, { product_id: p.id, name: displayName(p, isUrdu), unit_cost_pkr: p.cost_price_pkr, quantity: 1 }]
    })
    setShowSearch(false)
    setSearch('')
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
    supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, cost_price_pkr')
      .eq('shop_id', shop!.id).eq('is_active', true).order('name').then(({ data }) => setProducts(data ?? []))
  }

  const filtered = search.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || (p.name_ur ?? '').includes(search)
        || (p.company ?? '').toLowerCase().includes(search.toLowerCase()) || (p.flavor ?? '').toLowerCase().includes(search.toLowerCase()) || (p.flavor_ur ?? '').includes(search))
    : products

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!shop) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('sk.noShopLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3"><ArrowLeft size={14} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-1 flex items-center gap-2"><PackagePlus size={22} /> {t('sk.purchaseEntryBtn')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('sk.purchaseEntrySubtitle')}</p>

      <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={t('sk.supplierPlaceholder')} className="input-field mb-4" />

      <button onClick={() => setShowSearch(true)} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-secondary cursor-pointer hover:bg-dp-surface-container transition-all mb-4">
        <Search size={16} /> {t('sk.addItemToPurchaseBtn')}
      </button>

      {lines.length === 0 ? (
        <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('sk.purchaseEmpty')}</p>
      ) : (
        <div className="space-y-2 mb-5">
          {lines.map((r) => (
            <div key={r.product_id} className="bg-white border border-dp-outline-variant rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{r.name}</p>
                <button onClick={() => removeLine(r.product_id)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer shrink-0"><Trash2 size={14} /></button>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('sk.costPriceLabel')}</span>
                  <input type="number" value={r.unit_cost_pkr || ''} onChange={(e) => setCost(r.product_id, +e.target.value)}
                    className="w-20 px-2 py-1 rounded border border-amber-300 bg-amber-50 text-[13px] font-sans text-center text-amber-900 ltr-num" />
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setQty(r.product_id, r.quantity - 1)} className="w-7 h-7 rounded-full border border-dp-outline-variant flex items-center justify-center cursor-pointer hover:bg-dp-surface-container"><Minus size={13} /></button>
                  <span className="w-6 text-center font-sans text-[14px] font-bold ltr-num">{r.quantity}</span>
                  <button onClick={() => setQty(r.product_id, r.quantity + 1)} className="w-7 h-7 rounded-full border border-dp-outline-variant flex items-center justify-center cursor-pointer hover:bg-dp-surface-container"><Plus size={13} /></button>
                </div>
              </div>
              <p className="font-sans text-[12px] text-dp-on-surface-variant text-end mt-1.5">{t('sk.lineTotalLabel')} <span className="font-bold text-dp-secondary ltr-num">{fmt(r.unit_cost_pkr * r.quantity)}</span></p>
            </div>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 sticky bottom-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('sk.purchaseTotalLabel')}</p>
            <p className="font-sans text-[20px] font-bold text-dp-secondary">{fmt(total)}</p>
          </div>
          <button onClick={complete} disabled={completing} className="w-full flex items-center justify-center gap-2 bg-dp-primary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:opacity-90 transition-all disabled:opacity-50">
            {completing ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {completing ? t('action.saving') : t('sk.completePurchaseBtn')}
          </button>
        </div>
      )}

      {showSearch && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-start justify-center p-4 pt-16" onClick={() => setShowSearch(false)}>
          <div className="bg-white rounded-lg p-4 w-full max-w-md max-h-[75vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sk.searchOwnCatalogPlaceholder')} className="input-field mb-3" />
            <div className="space-y-1">
              {filtered.map((p) => (
                <button key={p.id} onClick={() => addLine(p)} className="w-full text-start flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-dp-surface-container cursor-pointer">
                  <span className="min-w-0 truncate font-sans text-[13.5px] text-dp-on-surface">{displayName(p, isUrdu)}</span>
                  <span className="shrink-0 font-sans text-[12.5px] font-bold text-amber-700">{fmt(p.cost_price_pkr)}</span>
                </button>
              ))}
              {filtered.length === 0 && <p className="text-center py-6 text-dp-on-surface-variant font-sans text-[13px]">{t('mp.noResults')}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
