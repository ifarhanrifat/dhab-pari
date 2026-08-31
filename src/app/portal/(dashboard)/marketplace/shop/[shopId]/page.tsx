'use client'

// Marketplace phase 4 — shop detail + cart checkout. Only a
// delivery_enabled shop gets the buy flow (the RPC would reject it
// server-side anyway — this just doesn't offer what would fail); a
// non-delivery shop still shows its full catalog, just with a "visit this
// store" note instead of quantity pickers, so price comparison from the
// search page still works either way.

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, MapPin, Minus, Plus, ShoppingCart } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface Shop {
  id: string; name: string; name_ur: string | null; description: string | null; description_ur: string | null
  owner_mobile: string | null; owner_whatsapp: string | null; location: string | null; location_ur: string | null; delivery_enabled: boolean
}
interface Product { id: string; name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null; unit_price_pkr: number; quantity_on_hand: number; is_active: boolean }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function ShopDetailPage() {
  const { t, isUrdu } = useLocale()
  const params = useParams<{ shopId: string }>()
  const router = useRouter()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [coverByProduct, setCoverByProduct] = useState<Record<string, string>>({})
  const [cart, setCart] = useState<Record<string, number>>({})
  const [method, setMethod] = useState('cash')
  const [proofPath, setProofPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const shopId = params.shopId
    Promise.all([
      supabase.from('shops').select('*').eq('id', shopId).single(),
      supabase.from('shop_products').select('*').eq('shop_id', shopId).eq('is_active', true).order('name'),
    ]).then(([{ data: s }, { data: p }]) => {
      setShop(s)
      setProducts(p ?? [])
      setLoading(false)
      if (p && p.length > 0) {
        supabase.from('product_media').select('product_id, url').eq('is_cover', true).in('product_id', p.map((x) => x.id))
          .then(({ data }) => setCoverByProduct(Object.fromEntries((data ?? []).map((m) => [m.product_id, m.url]))))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.shopId])

  const setQty = (productId: string, qty: number, max: number) => {
    setCart((c) => {
      const next = { ...c }
      if (qty <= 0) delete next[productId]
      else next[productId] = Math.min(qty, max)
      return next
    })
  }

  const cartItems = products.filter((p) => cart[p.id] > 0)
  const cartTotal = cartItems.reduce((s, p) => s + p.unit_price_pkr * cart[p.id], 0)

  const submit = async () => {
    if (cartItems.length === 0) { toast.error(t('mp.cartEmpty')); return }
    if (!proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setSubmitting(true)
    const items = cartItems.map((p) => ({ product_id: p.id, quantity: cart[p.id] }))
    const { error } = await supabase.rpc('place_shop_order', { p_shop_id: shop!.id, p_items: items, p_method: method, p_proof_url: proofPath })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.orderPlacedToast'))
    router.push('/portal/marketplace')
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>
  if (!shop) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('mp.shopNotFound')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <button onClick={() => router.push('/portal/marketplace')} className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13.5px] font-semibold hover:underline cursor-pointer mb-4">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}
      </button>

      <h1 className="font-heading text-[24px] font-bold text-dp-primary">{isUrdu && shop.name_ur ? shop.name_ur : shop.name}</h1>
      {shop.location && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><MapPin size={13} /> {isUrdu ? (shop.location_ur || shop.location) : shop.location}</p>}
      {shop.description && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-2">{isUrdu && shop.description_ur ? shop.description_ur : shop.description}</p>}

      {!shop.delivery_enabled && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 mt-4">
          <p className="font-sans text-[13px] text-amber-900">{t('mp.visitStoreExplain')}</p>
          {shop.owner_mobile && <p className="font-sans text-[13px] font-semibold text-amber-900 mt-1 ltr-num">{shop.owner_mobile}</p>}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-5">
        {products.map((p) => (
          <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
            <div className="h-24 bg-dp-surface-container">
              {coverByProduct[p.id] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coverByProduct[p.id]} alt="" className="w-full h-full object-cover" />
              )}
            </div>
            <div className="p-2.5">
              <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface truncate">
                {isUrdu && p.name_ur ? p.name_ur : p.name}
                {(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && <span className="font-normal text-dp-on-surface-variant"> ({isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})</span>}
              </p>
              <p className="font-sans text-[13.5px] font-bold text-dp-secondary mt-0.5">{fmt(p.unit_price_pkr)}</p>
              {shop.delivery_enabled && (
                p.quantity_on_hand <= 0 ? (
                  <p className="font-sans text-[11px] text-dp-error mt-1.5">{t('mp.outOfStock')}</p>
                ) : (
                  <div className="flex items-center justify-between gap-1 mt-1.5">
                    <button onClick={() => setQty(p.id, (cart[p.id] ?? 0) - 1, p.quantity_on_hand)} className="w-6 h-6 rounded-full bg-dp-surface-container-high flex items-center justify-center cursor-pointer"><Minus size={12} /></button>
                    <span className="font-sans text-[13px] font-bold ltr-num">{cart[p.id] ?? 0}</span>
                    <button onClick={() => setQty(p.id, (cart[p.id] ?? 0) + 1, p.quantity_on_hand)} className="w-6 h-6 rounded-full bg-dp-secondary text-white flex items-center justify-center cursor-pointer"><Plus size={12} /></button>
                  </div>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      {shop.delivery_enabled && cartItems.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mt-5">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2 flex items-center gap-1.5"><ShoppingCart size={13} /> {t('mp.cartHeading')}</p>
          {cartItems.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 py-1">
              <p className="font-sans text-[13px] text-dp-on-surface truncate">{isUrdu && p.name_ur ? p.name_ur : p.name}{(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && ` (${isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})`} × <span className="ltr-num">{cart[p.id]}</span></p>
              <p className="font-sans text-[13px] font-semibold text-dp-on-surface shrink-0">{fmt(p.unit_price_pkr * cart[p.id])}</p>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 mt-2 border-t border-dp-outline-variant">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('mp.cartTotal')}</p>
            <p className="font-heading text-[19px] font-bold text-dp-secondary">{fmt(cartTotal)}</p>
          </div>

          <div className="mt-4">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="input-field">
              <option value="cash">{t('w.cash')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
              <option value="bank">{t('a.bank')}</option>
            </select>
          </div>
          <div className="mt-3">
            <DonationReceiptUpload onUpload={setProofPath} />
          </div>
          <button onClick={submit} disabled={submitting} className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {submitting ? t('mp.placingOrder') : t('mp.placeOrderBtn')}
          </button>
        </div>
      )}
    </div>
  )
}
