'use client'

// Walk-in point of sale: a customer is standing at the counter, the
// keeper scans each item (same camera step as the catalog page, but
// matching AGAINST the existing catalog instead of drafting a new
// product), confirms the match, types the quantity, repeats for more
// items, then completes the sale — record_shop_sale() decrements stock
// and logs it for the shop's own records. Deliberately never touches the
// committee's ledger (see migration 391's note) — no confirmation step,
// no payment method, no receipt upload: the keeper already has the cash.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Camera, Loader2, Minus, Plus, Trash2, Search, ShoppingCart, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop { id: string; name: string; name_ur: string | null }
interface Product { id: string; name: string; name_ur: string | null; company: string | null; flavor: string | null; flavor_ur: string | null; unit_price_pkr: number; quantity_on_hand: number }

function displayName(p: { name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null }, isUrdu: boolean) {
  const name = isUrdu && p.name_ur ? p.name_ur : p.name
  const flavor = isUrdu ? (p.flavor_ur || p.flavor) : p.flavor
  return flavor ? `${name} (${flavor})` : name
}
interface BillRow { product_id: string; name: string; unit_price_pkr: number; quantity: number; max: number }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function SellPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [bill, setBill] = useState<BillRow[]>([])
  const [scanning, setScanning] = useState(false)
  const [noMatch, setNoMatch] = useState(false)
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [completing, setCompleting] = useState(false)
  const scanInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!user) return
    supabase.from('shops').select('id, name, name_ur').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      setShop(data)
      if (data) {
        supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, unit_price_pkr, quantity_on_hand')
          .eq('shop_id', data.id).eq('is_active', true).order('name')
          .then(({ data: p }) => { setProducts(p ?? []); setLoading(false) })
      } else setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const addToBill = (p: Product) => {
    if (p.quantity_on_hand <= 0) { toast.error(t('sk.outOfStock')); return }
    setBill((rows) => {
      const existing = rows.find((r) => r.product_id === p.id)
      if (existing) {
        if (existing.quantity >= existing.max) { toast.error(t('sk.noMoreStock')); return rows }
        return rows.map((r) => r.product_id === p.id ? { ...r, quantity: r.quantity + 1 } : r)
      }
      return [...rows, { product_id: p.id, name: displayName(p, isUrdu), unit_price_pkr: p.unit_price_pkr, quantity: 1, max: p.quantity_on_hand }]
    })
    setShowSearch(false)
    setSearch('')
  }

  const setQty = (productId: string, qty: number) => {
    setBill((rows) => rows.map((r) => r.product_id === productId ? { ...r, quantity: Math.max(1, Math.min(qty, r.max)) } : r))
  }
  const removeRow = (productId: string) => setBill((rows) => rows.filter((r) => r.product_id !== productId))

  const runScan = async (file: File) => {
    if (!shop) return
    setScanning(true)
    setNoMatch(false)
    try {
      const imageBase64 = await fileToBase64(file)
      const res = await fetch('/api/portal/shops/scan-sale-item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.id, imageBase64, mimeType: file.type }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? t('sk.scanFailed')); return }
      if (!json.product) { setNoMatch(true); return }
      const full = products.find((p) => p.id === json.product.id)
      if (full) addToBill(full)
    } catch {
      toast.error(t('sk.scanFailed'))
    } finally {
      setScanning(false)
      if (scanInputRef.current) scanInputRef.current.value = ''
    }
  }

  const total = bill.reduce((s, r) => s + r.unit_price_pkr * r.quantity, 0)

  const complete = async () => {
    if (bill.length === 0) return
    setCompleting(true)
    const items = bill.map((r) => ({ product_id: r.product_id, quantity: r.quantity }))
    const { error } = await supabase.rpc('record_shop_sale', { p_shop_id: shop!.id, p_items: items })
    setCompleting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.saleCompletedToast'))
    setBill([])
    supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, unit_price_pkr, quantity_on_hand')
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
      <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-1 flex items-center gap-2"><ShoppingCart size={22} /> {t('sk.sellBtn')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('sk.sellSubtitle')}</p>

      <div className="flex items-center gap-2 mb-4">
        <input ref={scanInputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runScan(f) }} />
        <button onClick={() => scanInputRef.current?.click()} disabled={scanning}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-60">
          {scanning ? <Loader2 size={17} className="animate-spin" /> : <Camera size={17} />} {scanning ? t('sk.scanningLabel') : t('sk.scanItemBtn')}
        </button>
        <button onClick={() => setShowSearch(true)} className="flex items-center gap-1.5 px-3 py-3 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container">
          <Search size={16} />
        </button>
      </div>

      {noMatch && <p className="font-sans text-[12.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">{t('sk.noMatchHint')}</p>}

      {bill.length === 0 ? (
        <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('sk.billEmpty')}</p>
      ) : (
        <div className="space-y-2 mb-5">
          {bill.map((r) => (
            <div key={r.product_id} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{r.name}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{fmt(r.unit_price_pkr)} × <span className="ltr-num">{r.quantity}</span> = <span className="font-bold text-dp-secondary">{fmt(r.unit_price_pkr * r.quantity)}</span></p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => setQty(r.product_id, r.quantity - 1)} className="w-7 h-7 rounded-full border border-dp-outline-variant flex items-center justify-center cursor-pointer hover:bg-dp-surface-container"><Minus size={13} /></button>
                <span className="w-6 text-center font-sans text-[14px] font-bold ltr-num">{r.quantity}</span>
                <button onClick={() => setQty(r.product_id, r.quantity + 1)} className="w-7 h-7 rounded-full border border-dp-outline-variant flex items-center justify-center cursor-pointer hover:bg-dp-surface-container"><Plus size={13} /></button>
                <button onClick={() => removeRow(r.product_id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {bill.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 sticky bottom-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('sk.totalLabel')}</p>
            <p className="font-sans text-[20px] font-bold text-dp-secondary">{fmt(total)}</p>
          </div>
          <button onClick={complete} disabled={completing} className="w-full flex items-center justify-center gap-2 bg-dp-primary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:opacity-90 transition-all disabled:opacity-50">
            {completing ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {completing ? t('action.saving') : t('sk.completeSaleBtn')}
          </button>
        </div>
      )}

      {showSearch && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-start justify-center p-4 pt-16" onClick={() => setShowSearch(false)}>
          <div className="bg-white rounded-lg p-4 w-full max-w-md max-h-[75vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sk.searchOwnCatalogPlaceholder')} className="input-field mb-3" />
            <div className="space-y-1">
              {filtered.map((p) => (
                <button key={p.id} onClick={() => addToBill(p)} className="w-full text-start flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-dp-surface-container cursor-pointer">
                  <span className="min-w-0 truncate font-sans text-[13.5px] text-dp-on-surface">{displayName(p, isUrdu)}</span>
                  <span className="shrink-0 font-sans text-[12.5px] font-bold text-dp-secondary">{fmt(p.unit_price_pkr)}</span>
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
