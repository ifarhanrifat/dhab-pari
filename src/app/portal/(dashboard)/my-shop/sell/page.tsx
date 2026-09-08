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
import { resolveMyShop } from '@/lib/shop'
import { ArrowLeft, Camera, Loader2, Minus, Plus, Trash2, Search, ShoppingCart, CheckCircle2, ScanBarcode } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ShopBottomNav } from '@/components/portal/ShopBottomNav'
import { takeNativePhoto, openCameraAppSettings, CameraPermissionDeniedError, isCameraCancel } from '@/lib/nativeCamera'
import { compressImageToBase64 } from '@/lib/imageCompress'
import { BarcodeScannerModal } from '@/components/shared/BarcodeScannerModal'
import { WebCameraCaptureModal } from '@/components/shared/WebCameraCaptureModal'
import { MarqueeText } from '@/components/shared/MarqueeText'

const INK = '#201e1d'
const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'

interface Shop { id: string; name: string; name_ur: string | null }
interface Product { id: string; name: string; name_ur: string | null; company: string | null; flavor: string | null; flavor_ur: string | null; unit_price_pkr: number; cost_price_pkr: number; quantity_on_hand: number; barcode: string | null; unit: string }
// Bulk pack pricing (migration 450) — "Container (80 pcs)", "دھاڑی (5
// کلو)". pack_price_pkr is the TOTAL for the whole pack, not a per-unit
// rate — see shop_product_packs's own comment for why cost basis is
// deliberately just the product's own cost_price_pkr × pack_qty, no
// separate bulk-cost field.
interface Pack { id: string; label: string; label_ur: string | null; pack_qty: number; pack_price_pkr: number }

function displayName(p: { name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null }, isUrdu: boolean) {
  const name = isUrdu && p.name_ur ? p.name_ur : p.name
  const flavor = isUrdu ? (p.flavor_ur || p.flavor) : p.flavor
  return flavor ? `${name} (${flavor})` : name
}
// key, not just product_id, identifies a row — a product can appear
// TWICE in one bill, once sold per-unit and once as a bulk pack (or even
// as two different packs), and those need separate quantities/totals.
interface BillRow {
  key: string; product_id: string; pack_id: string | null; pack_step: number
  name: string; unit_price_pkr: number; cost_price_pkr: number; quantity: number; max: number
}
const rowKey = (productId: string, packId: string | null) => `${productId}::${packId ?? 'unit'}`

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
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
  // Credit sale (migration 452) — same counter-sale screen, just paying
  // with a registered customer's tab instead of cash, per the confirmed
  // design (2026-09-07). Nothing else about the flow changes.
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit'>('cash')
  const [customers, setCustomers] = useState<{ id: string; name: string; name_ur: string | null }[]>([])
  const [creditCustomerId, setCreditCustomerId] = useState<string | null>(null)
  const [showBarcodeScanner, setShowBarcodeScanner] = useState(false)
  const [showWebCamera, setShowWebCamera] = useState(false)
  const [packsByProduct, setPacksByProduct] = useState<Record<string, Pack[]>>({})
  const [chooserProduct, setChooserProduct] = useState<Product | null>(null)
  const scanInputRef = useRef<HTMLInputElement>(null)
  const scanChooserInputRef = useRef<HTMLInputElement>(null)

  const loadProducts = (shopId: string) =>
    supabase.from('shop_products').select('id, name, name_ur, company, flavor, flavor_ur, unit_price_pkr, cost_price_pkr, quantity_on_hand, barcode, unit')
      .eq('shop_id', shopId).eq('is_active', true).order('name')
      .then(({ data }) => setProducts(data ?? []))

  // Nested filter (shop_products!inner) so this doesn't need the product
  // id list up front — one query for every pack across the whole shop.
  const loadPacks = (shopId: string) =>
    supabase.from('shop_product_packs').select('id, shop_product_id, label, label_ur, pack_qty, pack_price_pkr, shop_products!inner(shop_id)')
      .eq('shop_products.shop_id', shopId).eq('is_active', true)
      .then(({ data }) => {
        const grouped: Record<string, Pack[]> = {}
        for (const row of (data ?? []) as unknown as (Pack & { shop_product_id: string })[]) {
          (grouped[row.shop_product_id] ??= []).push(row)
        }
        setPacksByProduct(grouped)
      })

  useEffect(() => {
    if (!user) return
    resolveMyShop<Shop>(supabase, user.id, 'id, name, name_ur').then(({ data }) => {
      setShop(data)
      if (data) {
        loadProducts(data.id).then(() => setLoading(false))
        loadPacks(data.id)
        supabase.from('shop_customers').select('id, name, name_ur').eq('shop_id', data.id).eq('is_active', true).order('name')
          .then(({ data: c }) => setCustomers(c ?? []))
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

  // Real report: a shopkeeper added a bulk pack to a product (my-shop's
  // own edit form), then tapped over to this already-open counter-sale
  // screen and the pack chooser never appeared — tapping the product
  // just silently added one plain unit instead. products/packsByProduct
  // only ever loaded once, on mount; a native app's WebView keeps this
  // page alive in the background rather than remounting it on every
  // visit, so switching away to edit a product and back never re-ran
  // that initial fetch. Refetching on visibility/focus closes that gap
  // without needing a real-time subscription for what's a rare event.
  useEffect(() => {
    if (!shop) return
    const refresh = () => { if (document.visibilityState === 'visible') { loadProducts(shop.id); loadPacks(shop.id) } }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop])

  // Adds one unit (or, for a pack, one whole pack) as its own bill row —
  // pack_id is part of the row key, so a per-unit line and a pack line
  // for the same product coexist instead of colliding.
  const addLine = (p: Product, pack: Pack | null) => {
    const step = pack ? pack.pack_qty : 1
    if (step > p.quantity_on_hand) { toast.error(t('sk.noMoreStock')); return }
    const key = rowKey(p.id, pack?.id ?? null)
    setBill((rows) => {
      const existing = rows.find((r) => r.key === key)
      if (existing) {
        if (existing.quantity + step > existing.max) { toast.error(t('sk.noMoreStock')); return rows }
        return rows.map((r) => r.key === key ? { ...r, quantity: r.quantity + step } : r)
      }
      const name = pack
        ? `${displayName(p, isUrdu)} — ${isUrdu && pack.label_ur ? pack.label_ur : pack.label}`
        : displayName(p, isUrdu)
      const unitPrice = pack ? pack.pack_price_pkr / pack.pack_qty : p.unit_price_pkr
      return [...rows, { key, product_id: p.id, pack_id: pack?.id ?? null, pack_step: step, name, unit_price_pkr: unitPrice, cost_price_pkr: p.cost_price_pkr, quantity: step, max: p.quantity_on_hand }]
    })
    setShowSearch(false)
    setSearch('')
    setChooserProduct(null)
  }

  // Only products with at least one bulk pack recorded (my-shop's own
  // product edit form is where those get added) show the chooser at
  // all — everything else keeps the exact one-tap-adds-one-unit
  // behavior this screen always had.
  const addToBill = (p: Product) => {
    if (p.quantity_on_hand <= 0) { toast.error(t('sk.outOfStock')); return }
    const packs = packsByProduct[p.id] ?? []
    if (packs.length > 0) { setChooserProduct(p); return }
    addLine(p, null)
  }

  // delta is in whole steps (±1), not raw units — a pack row's step is
  // its own pack_qty (e.g. a whole container of 80 at a time), never 1,
  // so tapping +/- on a pack line can't land on a partial pack.
  const setQty = (key: string, delta: number) => {
    setBill((rows) => rows.map((r) => {
      if (r.key !== key) return r
      const maxSteps = Math.floor(r.max / r.pack_step) * r.pack_step
      return { ...r, quantity: Math.max(r.pack_step, Math.min(r.quantity + delta * r.pack_step, maxSteps)) }
    }))
  }
  const removeRow = (key: string) => setBill((rows) => rows.filter((r) => r.key !== key))

  // Same native-camera-first split as my-shop's own scan button — see
  // src/lib/nativeCamera.ts for why the plain <input capture> path isn't
  // trustworthy inside the native Android shell.
  const openScanner = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const file = await takeNativePhoto()
        if (file) runScan(file)
      } catch (err) {
        if (err instanceof CameraPermissionDeniedError) {
          toast.error(t('sk.cameraPermissionDeniedToast'), { action: { label: t('af.openSettingsBtn'), onClick: () => openCameraAppSettings() } })
        } else if (!isCameraCancel(err)) {
          // A real failure, confirmed live on a rooted/custom-ROM device:
          // see my-shop/page.tsx's own openScanner for the full story —
          // getUserMedia (WebCameraCaptureModal) is a completely
          // different code path with no dependency on any native camera
          // app being registered, already proven working on this exact
          // device by the barcode scanner. Silent switch, no toast — see
          // my-shop/page.tsx's own openScanner for why.
          setShowWebCamera(true)
        }
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
      // Downscaled/re-encoded first — see src/lib/imageCompress.ts: a full-
      // resolution mobile camera/gallery photo sent straight as base64 was
      // the actual cause of "this image can't be read" on the counter scan
      // too (identical root cause as my-shop's Add Stock scan).
      const { base64: imageBase64, mimeType } = await compressImageToBase64(file)
      const res = await fetch('/api/portal/shops/scan-sale-item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.id, imageBase64, mimeType }),
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
      if (scanChooserInputRef.current) scanChooserInputRef.current.value = ''
    }
  }

  // Exact lookup against this shop's own shop_products.barcode (migration
  // 449) — no Gemini call, no guessing which flavor matched a numbered
  // list. This is the actual fix for the reliability problem the AI
  // photo-match (runScan above) has by nature: it replaces a confidence
  // guess with a deterministic read, whenever the product has a barcode
  // recorded (Add Stock's own "Scan" button next to the barcode field is
  // where that gets captured in the first place).
  const onBarcodeDetected = (code: string) => {
    setShowBarcodeScanner(false)
    const match = products.find((p) => p.barcode === code)
    if (!match) { toast.error(t('sk.barcodeNotFoundToast')); return }
    addToBill(match)
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
    if (paymentMethod === 'credit' && !creditCustomerId) { toast.error(t('sk.pickCustomerHint')); return }
    setCompleting(true)
    // A pack row's own quantity/price come from the pack itself
    // server-side (migration 450's record_shop_sale) — the client-sent
    // `quantity` is ignored whenever pack_id is set, so a merged row of
    // e.g. 2 containers is sent as two separate {product_id, pack_id}
    // entries rather than one entry with quantity=160.
    const items = bill.flatMap((r): { product_id: string; pack_id?: string; quantity?: number }[] => {
      if (r.pack_id) {
        const packCount = Math.round(r.quantity / r.pack_step)
        return Array.from({ length: packCount }, () => ({ product_id: r.product_id, pack_id: r.pack_id as string }))
      }
      return [{ product_id: r.product_id, quantity: r.quantity }]
    })
    const { error } = await supabase.rpc('record_shop_sale', {
      p_shop_id: shop!.id, p_items: items, p_customer_id: paymentMethod === 'credit' ? creditCustomerId : null,
    })
    setCompleting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(paymentMethod === 'credit' ? t('sk.creditSaleCompletedToast') : t('sk.saleCompletedToast'))
    setBill([])
    setCashReceived('')
    setPaymentMethod('cash')
    setCreditCustomerId(null)
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
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline mb-3" style={{ color: ACCENT }}><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] mb-1 flex items-center gap-2" style={{ color: INK }}><ShoppingCart size={22} /> {t('sk.sellBtn')}</h1>
      <p className="font-sans text-[13px] text-[#7a736d] mb-5">{t('sk.sellSubtitle')}</p>

      <div className="flex items-center gap-2 mb-4">
        <input ref={scanInputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runScan(f) }} />
        {/* No `capture` here — see my-shop/page.tsx's own scanChooserInputRef
            for why: it's the difference between Android jumping straight to
            one specific app (which is exactly what's failing natively on
            this device) and showing its real "open with" list instead. */}
        <input ref={scanChooserInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runScan(f) }} />
        <button onClick={openScanner} disabled={scanning}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-white font-sans text-[14px] font-semibold cursor-pointer transition-all disabled:opacity-60" style={{ background: ACCENT }} onMouseEnter={(e) => !scanning && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>
          {scanning ? <Loader2 size={17} className="animate-spin" /> : <Camera size={17} />} {scanning ? t('sk.scanningLabel') : t('sk.scanItemBtn')}
        </button>
        {/* Exact barcode lookup — see onBarcodeDetected's own comment for
            why this exists alongside the AI photo match above rather than
            replacing it: only products with a barcode recorded can use
            this path, everything else still needs the photo match. */}
        <button onClick={() => setShowBarcodeScanner(true)} className="flex items-center gap-1.5 px-3 py-3 border font-sans text-[13px] font-semibold cursor-pointer transition-colors" style={{ borderColor: ACCENT, color: ACCENT }}>
          <ScanBarcode size={17} />
        </button>
        <button onClick={() => setShowSearch(true)} className="flex items-center gap-1.5 px-3 py-3 border border-[#dcd8d4] font-sans text-[13px] font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
          <Search size={16} />
        </button>
      </div>
      {showBarcodeScanner && <BarcodeScannerModal onClose={() => setShowBarcodeScanner(false)} onDetected={onBarcodeDetected} />}
      {showWebCamera && (
        <WebCameraCaptureModal
          onClose={() => setShowWebCamera(false)}
          onCaptured={(file) => { setShowWebCamera(false); runScan(file) }}
          onUseGalleryInstead={() => { setShowWebCamera(false); scanChooserInputRef.current?.click() }}
        />
      )}

      {/* Only ever shown for a product that has bulk packs recorded
          (addToBill's own guard) — everything else skips straight to
          addLine with no interruption, same one-tap flow as always. */}
      {chooserProduct && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-4" onClick={() => setChooserProduct(null)}>
          <div className="bg-white w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <p className="font-heading text-[16px] font-bold mb-1" style={{ color: INK }}>{displayName(chooserProduct, isUrdu)}</p>
            <p className="font-sans text-[12.5px] text-[#7a736d] mb-3">{t('sk.chooseSaleTypeTitle')}</p>
            <div className="space-y-2">
              <button onClick={() => addLine(chooserProduct, null)} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 border border-[#dcd8d4] font-sans text-[13.5px] font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
                <span>{t('sk.perUnitOption').replace('{unit}', chooserProduct.unit || 'عدد')}</span>
                <span className="ltr-num">{fmt(chooserProduct.unit_price_pkr)}</span>
              </button>
              {(packsByProduct[chooserProduct.id] ?? []).map((pk) => (
                <button key={pk.id} onClick={() => addLine(chooserProduct, pk)} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 border font-sans text-[13.5px] font-semibold cursor-pointer transition-colors" style={{ borderColor: ACCENT, color: ACCENT }}>
                  <span>{isUrdu && pk.label_ur ? pk.label_ur : pk.label}</span>
                  <span className="ltr-num">{fmt(pk.pack_price_pkr)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
                  <MarqueeText text={displayName(p, isUrdu)} className="font-sans text-[11.5px] font-semibold leading-[1.4]" style={{ color: INK }} />
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
          {bill.map((r) => {
            // For a pack row the stepper counts whole packs (1, 2, 3…),
            // not raw units — r.name already spells out the pack size
            // ("Lays — Container (80 pcs)"), so showing "×80" here would
            // just be confusing next to that.
            const stepCount = r.quantity / r.pack_step
            return (
              <div key={r.key} className="bg-white border border-[#dcd8d4] p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <MarqueeText text={r.name} className="font-sans text-[13.5px] font-semibold" style={{ color: INK }} />
                  <p className="font-sans text-[12px] text-[#7a736d]">{fmt(r.unit_price_pkr * r.pack_step)} × <span className="ltr-num">{stepCount}</span> = <span className="font-bold" style={{ color: INK }}>{fmt(r.unit_price_pkr * r.quantity)}</span></p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => setQty(r.key, -1)} className="w-8 h-8 border border-[#dcd8d4] flex items-center justify-center cursor-pointer hover:border-[#201e1d] transition-colors"><Minus size={14} /></button>
                  <span className="w-6 text-center font-sans text-[14px] font-bold ltr-num" style={{ color: INK }}>{stepCount}</span>
                  <button onClick={() => setQty(r.key, 1)} className="w-8 h-8 border border-[#dcd8d4] flex items-center justify-center cursor-pointer hover:border-[#201e1d] transition-colors"><Plus size={14} /></button>
                  <button onClick={() => removeRow(r.key)} className="p-1.5 cursor-pointer" style={{ color: ACCENT }}><Trash2 size={14} /></button>
                </div>
              </div>
            )
          })}
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
            <div className="flex items-center gap-1.5 mb-2.5 bg-[#eeece9] rounded-lg p-1">
              <button onClick={() => setPaymentMethod('cash')} className="flex-1 py-1.5 rounded-md font-sans text-[12.5px] font-semibold cursor-pointer transition-all" style={paymentMethod === 'cash' ? { background: '#fff', color: INK } : { color: '#7a736d' }}>{t('sk.payWithCashBtn')}</button>
              <button onClick={() => setPaymentMethod('credit')} className="flex-1 py-1.5 rounded-md font-sans text-[12.5px] font-semibold cursor-pointer transition-all" style={paymentMethod === 'credit' ? { background: '#fff', color: ACCENT_DARK } : { color: '#7a736d' }}>{t('sk.payOnCreditBtn')}</button>
            </div>

            {paymentMethod === 'cash' ? (
              <>
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
              </>
            ) : (
              <div>
                <p className="font-sans text-[11px] font-semibold text-[#7a736d] mb-1.5">{t('sk.pickCustomerHint')}</p>
                {customers.length === 0 ? (
                  <p className="font-sans text-[12px] text-[#7a736d] border border-[#dcd8d4] p-3">{t('sk.noCustomersForCreditHint')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {customers.map((c) => (
                      <button key={c.id} onClick={() => setCreditCustomerId(c.id)}
                        className="px-2.5 py-1.5 border font-sans text-[12px] font-semibold cursor-pointer transition-colors"
                        style={creditCustomerId === c.id ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: INK }}>
                        {isUrdu && c.name_ur ? c.name_ur : c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <button onClick={complete} disabled={completing || (paymentMethod === 'credit' && !creditCustomerId)} className="w-full flex items-center justify-center gap-2 text-white py-3 mt-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: INK }}>
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
                  <MarqueeText text={displayName(p, isUrdu)} className="min-w-0 flex-1 font-sans text-[13.5px]" style={{ color: INK }} />
                  <span className="shrink-0 font-sans text-[12.5px] font-bold" style={{ color: INK }}>{fmt(p.unit_price_pkr)}</span>
                </button>
              ))}
              {filtered.length === 0 && <p className="text-center py-6 text-[#7a736d] font-sans text-[13px]">{t('mp.noResults')}</p>}
            </div>
          </div>
        </div>
      )}
      <ShopBottomNav />
    </div>
  )
}
