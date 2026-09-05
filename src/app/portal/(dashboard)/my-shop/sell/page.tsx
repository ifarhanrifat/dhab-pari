'use client'

// Walk-in point of sale: a customer is standing at the counter, the
// keeper scans each item (same camera step as the catalog page, but
// matching AGAINST the existing catalog instead of drafting a new
// product), confirms the match, types the quantity, repeats for more
// items, then completes the sale — record_shop_sale() decrements stock
// and logs it for the shop's own records. Deliberately never touches the
// committee's ledger (see migration 391's note) — no confirmation step,
// no payment method, no receipt upload: the keeper already has the cash.
//
// Fast-add rail, cash-received chips and the live change-due readout
// (2026-09-06) match the "Counter Sale / کاؤنٹر پرچی" section of the
// Village Portal Marketplace design spec — one hand, no typing, per its
// own framing. Ink (#201e1d) / accent (#ec3013) two-tone throughout,
// matching the rest of the shop portal's restyle.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Capacitor } from '@capacitor/core'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Camera, Loader2, Minus, Plus, Trash2, Search, ShoppingCart, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { takeNativePhoto } from '@/lib/nativeCamera'

const INK = '#201e1d'
const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'

interface Shop { id: string; name: string; name_ur: string | null }
interface Product { id: string; name: string; name_ur: string | null; company: string | null; flavor: string | null; flavor_ur: string | null; unit_price_pkr: number; cost_price_pkr: number; quantity_on_hand: number }

function displayName(p: { name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null }, isUrdu: boolean) {
  const name = isUrdu && p.name_ur ? p.name_ur : p.name
  const flavor = isUrdu ? (p.flavor_ur || p.flavor) : p.flavor
  return flavor ? `${name} (${flavor})` : name
}
interface BillRow { product_id: string; name: string; unit_price_pkr: number; cost_price_pkr: number; quantity: number; max: number }

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

const CASH_CHIPS = [500, 1000, 2000, 5000]

export default function SellPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [fastAddIds, setFastAddIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [bill, setBill] = useState<BillRow[]>([])
  const [scanning, setScanning] = useState(false)
  const [noMatch, setNoMatch] = useState(false)
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [cashReceived, setCashReceived] = useState('')
  const scanInputRef = useRef<HTMLInputElement>(null)

  const loadProducts = (shopId: string) =>
    supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, unit_price_pkr, cost_price_pkr, quantity_on_hand')
      .eq('shop_id', shopId).eq('is_active', true).order('name')
      .then(({ data }) => setProducts(data ?? []))

  useEffect(() => {
    if (!user) return
    supabase.from('shops').select('id, name, name_ur').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      setShop(data)
      if (data) {
        loadProducts(data.id).then(() => setLoading(false))
        // Same real-sales-derived ranking the buyer's shop front already
        // uses (shop_popular_products, migration 433) — the fast-add rail
        // is "what this shopkeeper actually sells most", not a guess.
        supabase.rpc('shop_popular_products', { p_shop_id: data.id }).then(({ data: ids, error }) => {
          if (!error && Array.isArray(ids)) setFastAddIds(ids)
        })
      } else setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const addToBill = (p: Product) => {
    if (p.quantity_on_hand <= 0) { toast.error(t('sk.outOfStock')); return }
    setBill((rows) => {
      const existing = rows.find((r) => r.product_id === p.id)
      if (existing) {
        if (existing.quantity >= existing.max) { toast.error(t('sk.noMoreStock')); return rows }
        return rows.map((r) => r.product_id === p.id ? { ...r, quantity: r.quantity + 1 } : r)
      }
      return [...rows, { product_id: p.id, name: displayName(p, isUrdu), unit_price_pkr: p.unit_price_pkr, cost_price_pkr: p.cost_price_pkr, quantity: 1, max: p.quantity_on_hand }]
    })
    setShowSearch(false)
    setSearch('')
  }

  const setQty = (productId: string, qty: number) => {
    setBill((rows) => rows.map((r) => r.product_id === productId ? { ...r, quantity: Math.max(1, Math.min(qty, r.max)) } : r))
  }
  const removeRow = (productId: string) => setBill((rows) => rows.filter((r) => r.product_id !== productId))

  // Same native-camera-first split as my-shop's own scan button — see
  // src/lib/nativeCamera.ts for why the plain <input capture> path isn't
  // trustworthy inside the native Android shell.
  const openScanner = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const file = await takeNativePhoto()
        if (file) runScan(file)
      } catch {
        // user backed out of the camera sheet — nothing to report
      }
      return
    }
    scanInputRef.current?.click()
  }

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
  // Shopkeeper's own margin on this bill — never shown to a buyer, same
  // privacy rule cost_price_pkr already carries everywhere else in this
  // portal (see the "tinted — private" convention in the handoff spec).
  const profit = bill.reduce((s, r) => s + (r.unit_price_pkr - r.cost_price_pkr) * r.quantity, 0)
  const cashNum = Number(cashReceived) || 0
  const changeDue = cashNum - total

  const complete = async () => {
    if (bill.length === 0) return
    setCompleting(true)
    const items = bill.map((r) => ({ product_id: r.product_id, quantity: r.quantity }))
    const { error } = await supabase.rpc('record_shop_sale', { p_shop_id: shop!.id, p_items: items })
    setCompleting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.saleCompletedToast'))
    setBill([])
    setCashReceived('')
    loadProducts(shop!.id)
  }

  const filtered = search.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || (p.name_ur ?? '').includes(search)
        || (p.company ?? '').toLowerCase().includes(search.toLowerCase()) || (p.flavor ?? '').toLowerCase().includes(search.toLowerCase()) || (p.flavor_ur ?? '').includes(search))
    : products

  const fastAddProducts = fastAddIds.map((id) => products.find((p) => p.id === id)).filter((p): p is Product => !!p && p.quantity_on_hand > 0)

  if (userLoading || loading) return <div className="text-center py-12 text-[#7a736d] font-sans"><LoadingDots /></div>
  if (!shop) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('sk.noShopLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline mb-3" style={{ color: ACCENT }}><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] mb-1 flex items-center gap-2" style={{ color: INK }}><ShoppingCart size={22} /> {t('sk.sellBtn')}</h1>
      <p className="font-sans text-[13px] text-[#7a736d] mb-5">{t('sk.sellSubtitle')}</p>

      <div className="flex items-center gap-2 mb-4">
        <input ref={scanInputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runScan(f) }} />
        <button onClick={openScanner} disabled={scanning}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-white font-sans text-[14px] font-semibold cursor-pointer transition-all disabled:opacity-60" style={{ background: ACCENT }} onMouseEnter={(e) => !scanning && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>
          {scanning ? <Loader2 size={17} className="animate-spin" /> : <Camera size={17} />} {scanning ? t('sk.scanningLabel') : t('sk.scanItemBtn')}
        </button>
        <button onClick={() => setShowSearch(true)} className="flex items-center gap-1.5 px-3 py-3 border border-[#dcd8d4] font-sans text-[13px] font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
          <Search size={16} />
        </button>
      </div>

      {noMatch && <p className="font-sans text-[12.5px] px-3 py-2 mb-4 border" style={{ background: '#fce3dc', borderColor: '#f4a68f', color: ACCENT_DARK }}>{t('sk.noMatchHint')}</p>}

      {/* Fast-add rail — most-sold items as one-tap cards, per the spec's
          own framing ("built for one hand and no typing"). Hidden until
          the shop has real sales history to rank by (same guard the
          buyer-facing popular rail already uses). */}
      {fastAddProducts.length > 0 && (
        <div className="mb-5">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mb-2">{t('sk.fastAddHeading')}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {fastAddProducts.map((p) => {
              const inBill = bill.find((r) => r.product_id === p.id)
              return (
                <button key={p.id} onClick={() => addToBill(p)} className="shrink-0 w-24 text-start bg-white border p-2.5 cursor-pointer transition-colors"
                  style={inBill ? { borderColor: ACCENT, borderWidth: 2 } : { borderColor: '#dcd8d4' }}>
                  <p className="font-sans text-[11.5px] font-semibold leading-[1.4] truncate" style={{ color: INK }}>{displayName(p, isUrdu)}</p>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="font-sans text-[12px] font-bold" style={{ color: INK }}>{fmt(p.unit_price_pkr)}</span>
                    {inBill && <span className="font-sans text-[11px] font-bold text-white rounded-full w-4.5 h-4.5 flex items-center justify-center px-1" style={{ background: ACCENT }}>{inBill.quantity}</span>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {bill.length === 0 ? (
        <p className="text-center py-8 text-[#7a736d] font-sans text-[14px]">{t('sk.billEmpty')}</p>
      ) : (
        <div className="space-y-2 mb-5">
          {bill.map((r) => (
            <div key={r.product_id} className="bg-white border border-[#dcd8d4] p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-sans text-[13.5px] font-semibold truncate" style={{ color: INK }}>{r.name}</p>
                <p className="font-sans text-[12px] text-[#7a736d]">{fmt(r.unit_price_pkr)} × <span className="ltr-num">{r.quantity}</span> = <span className="font-bold" style={{ color: INK }}>{fmt(r.unit_price_pkr * r.quantity)}</span></p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => setQty(r.product_id, r.quantity - 1)} className="w-8 h-8 border border-[#dcd8d4] flex items-center justify-center cursor-pointer hover:border-[#201e1d] transition-colors"><Minus size={14} /></button>
                <span className="w-6 text-center font-sans text-[14px] font-bold ltr-num" style={{ color: INK }}>{r.quantity}</span>
                <button onClick={() => setQty(r.product_id, r.quantity + 1)} className="w-8 h-8 border border-[#dcd8d4] flex items-center justify-center cursor-pointer hover:border-[#201e1d] transition-colors"><Plus size={14} /></button>
                <button onClick={() => removeRow(r.product_id)} className="p-1.5 cursor-pointer" style={{ color: ACCENT }}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {bill.length > 0 && (
        <div className="bg-white border border-[#dcd8d4] sticky bottom-4">
          <div className="px-4 pt-4">
            <div className="flex items-center justify-between">
              <p className="font-sans text-[14px] font-bold" style={{ color: INK }}>{t('sk.totalLabel')}</p>
              <p className="font-sans text-[26px] font-bold" style={{ color: INK }}>{fmt(total)}</p>
            </div>
            {/* Profit is the shopkeeper's own — never shown to a buyer,
                private the same way cost price is everywhere else. */}
            <p className="font-sans text-[11.5px] text-[#7a736d] text-end mt-0.5">{t('sk.billProfitLabel')} <span className="font-semibold" style={{ color: ACCENT_DARK }}>{fmt(profit)}</span></p>
          </div>

          <div className="px-4 mt-3">
            <p className="font-sans text-[11px] font-semibold text-[#7a736d] mb-1.5">{t('sk.cashReceivedLabel')}</p>
            <div className="flex items-center gap-1.5 flex-wrap mb-2">
              <button onClick={() => setCashReceived(String(total))} className="px-2.5 py-1.5 border font-sans text-[12px] font-semibold cursor-pointer transition-colors" style={cashNum === total && cashReceived !== '' ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: INK }}>{t('sk.exactAmountChip')}</button>
              {CASH_CHIPS.map((c) => (
                <button key={c} onClick={() => setCashReceived(String(c))} className="px-2.5 py-1.5 border font-sans text-[12px] font-semibold cursor-pointer transition-colors" style={Number(cashReceived) === c ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: INK }}>{fmt(c)}</button>
              ))}
              <input type="number" value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} placeholder={t('sk.typedAmountPlaceholder')}
                className="w-24 px-2 py-1.5 border font-sans text-[13px] text-center ltr-num focus:ring-0" style={{ borderColor: '#dcd8d4', color: INK }} />
            </div>
            {cashReceived !== '' && (
              <div className="flex items-center justify-between py-1.5 border-t border-[#e2ded9]">
                <span className="font-sans text-[12.5px] font-semibold text-[#7a736d]">{changeDue < 0 ? t('sk.shortLabel') : t('sk.changeDueLabel')}</span>
                <span className="font-sans text-[16px] font-bold" style={{ color: changeDue < 0 ? ACCENT_DARK : ACCENT }}>{fmt(Math.abs(changeDue))}</span>
              </div>
            )}
          </div>

          <button onClick={complete} disabled={completing} className="w-full flex items-center justify-center gap-2 text-white py-3 mt-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: INK }}>
            {completing ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {completing ? t('action.saving') : t('sk.completeSaleBtn')}
          </button>
        </div>
      )}

      {showSearch && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-start justify-center p-4 pt-16" onClick={() => setShowSearch(false)}>
          <div className="bg-white p-4 w-full max-w-md max-h-[75vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sk.searchOwnCatalogPlaceholder')} className="input-field mb-3" />
            <div className="space-y-1">
              {filtered.map((p) => (
                <button key={p.id} onClick={() => addToBill(p)} className="w-full text-start flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-[#f7f6f5] cursor-pointer">
                  <span className="min-w-0 truncate font-sans text-[13.5px]" style={{ color: INK }}>{displayName(p, isUrdu)}</span>
                  <span className="shrink-0 font-sans text-[12.5px] font-bold" style={{ color: INK }}>{fmt(p.unit_price_pkr)}</span>
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
