'use client'

// Marketplace phase 4 — shop detail + cart checkout. Only a
// delivery_enabled shop gets the buy flow (the RPC would reject it
// server-side anyway — this just doesn't offer what would fail); a
// non-delivery shop still shows its full catalog, just with a "visit this
// store" note instead of quantity pickers, so price comparison from the
// search page still works either way.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, MapPin, Minus, Plus, ShoppingCart, ChevronRight, LayoutGrid, Search, Flame, MapPinned } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { getShopTypeTree } from '@/lib/shopTypes'
import { DynamicIcon } from '@/components/shared/DynamicIcon'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop {
  id: string; name: string; name_ur: string | null; description: string | null; description_ur: string | null
  owner_mobile: string | null; owner_whatsapp: string | null; location: string | null; location_ur: string | null
  delivery_enabled: boolean; commission_mode: string; primary_type: string
}
interface Product {
  id: string; name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null
  category: string | null; company: string | null; unit_price_pkr: number; quantity_on_hand: number; is_active: boolean
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// Module-level, not nested inside the page component — a component
// declared inside another component's render body gets a fresh function
// identity every render, which makes React remount it (and any input
// inside it) on every keystroke elsewhere on the page. Cost a real bug
// in StockListView.tsx tonight; not repeating it here.
function ProductCard({ p, isUrdu, cover, qty, max, canBuy, onQty, t }: {
  p: Product; isUrdu: boolean; cover?: string; qty: number; max: number; canBuy: boolean
  onQty: (productId: string, qty: number, max: number) => void; t: (k: string) => string
}) {
  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
      <div className="h-24 bg-dp-surface-container">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="w-full h-full object-cover" />
        )}
      </div>
      <div className="p-2.5">
        <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface truncate">
          {isUrdu && p.name_ur ? p.name_ur : p.name}
          {(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && <span className="font-normal text-dp-on-surface-variant"> ({isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})</span>}
        </p>
        {p.company && <p className="font-sans text-[10.5px] text-dp-on-surface-variant truncate">{p.company}</p>}
        <p className="font-sans text-[13.5px] font-bold text-dp-secondary mt-0.5">{fmt(p.unit_price_pkr)}</p>
        {canBuy && (
          p.quantity_on_hand <= 0 ? (
            <p className="font-sans text-[11px] text-dp-error mt-1.5">{t('mp.outOfStock')}</p>
          ) : (
            <div className="flex items-center justify-between gap-1 mt-1.5">
              <button onClick={() => onQty(p.id, qty - 1, max)} className="w-6 h-6 rounded-full bg-dp-surface-container-high flex items-center justify-center cursor-pointer"><Minus size={12} /></button>
              <span className="font-sans text-[13px] font-bold ltr-num">{qty}</span>
              <button onClick={() => onQty(p.id, qty + 1, max)} className="w-6 h-6 rounded-full bg-dp-secondary text-white flex items-center justify-center cursor-pointer"><Plus size={12} /></button>
            </div>
          )
        )}
      </div>
    </div>
  )
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
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [bookable, setBookable] = useState(true)
  const [activeDept, setActiveDept] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [deliveryFeePkr, setDeliveryFeePkr] = useState(0)
  const [search, setSearch] = useState('')
  const [brandFilter, setBrandFilter] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'name' | 'cheap' | 'expensive'>('name')
  const [popularIds, setPopularIds] = useState<string[]>([])

  useEffect(() => {
    const shopId = params.shopId
    Promise.all([
      supabase.from('shops').select('*').eq('id', shopId).single(),
      supabase.from('shop_products').select('*').eq('shop_id', shopId).eq('is_active', true).order('name'),
      supabase.rpc('shop_bookable', { p_shop_id: shopId }),
      supabase.from('site_settings').select('value').eq('key', 'village_delivery_flat_fee_pkr').maybeSingle(),
    ]).then(([{ data: s }, { data: p }, { data: bk }, { data: fee }]) => {
      setShop(s)
      setProducts(p ?? [])
      setBookable(bk !== false)
      setDeliveryFeePkr(fee?.value ? Number(fee.value) : 0)
      setLoading(false)
      if (p && p.length > 0) {
        supabase.from('product_media').select('product_id, url').eq('is_cover', true).in('product_id', p.map((x) => x.id))
          .then(({ data }) => setCoverByProduct(Object.fromEntries((data ?? []).map((m) => [m.product_id, m.url]))))
      }
    })
    // shop_popular_products (migration 433) may not exist live yet on
    // every deploy the instant this ships — fail silently into "no
    // popular row" rather than an error toast the buyer can't do
    // anything about; the row just doesn't appear until it's live.
    supabase.rpc('shop_popular_products', { p_shop_id: shopId }).then(({ data, error }) => {
      if (!error && Array.isArray(data)) setPopularIds(data)
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

  const isPerOrder = shop?.commission_mode === 'per_order'

  const categoryOf = (p: Product) => p.category ?? 'other'
  const countByCategory = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of products) counts[categoryOf(p)] = (counts[categoryOf(p)] ?? 0) + 1
    return counts
  }, [products]) // eslint-disable-line react-hooks/exhaustive-deps
  const shopTree = useMemo(() => getShopTypeTree(shop?.primary_type), [shop?.primary_type])
  const departmentsPresent = shopTree.filter((d) => d.categories.some((c) => (countByCategory[c.slug] ?? 0) > 0))
  const categoriesPresent = (deptKey: string) => (shopTree.find((d) => d.key === deptKey)?.categories ?? []).filter((c) => (countByCategory[c.slug] ?? 0) > 0)
  const visibleProducts = activeCategory ? products.filter((p) => categoryOf(p) === activeCategory) : []

  // Brand rail (shop front) / brand chips (browse) — only brands this
  // shop actually carries, real names only (no "—" placeholder chip;
  // an unbranded/loose item still shows up via search/category, it just
  // doesn't get its own brand chip since the design's کھلا سامان chip
  // concept maps to "no brand filter selected, still findable by name").
  const brandsInShop = useMemo(() => {
    const names = new Set<string>()
    for (const p of products) if (p.company?.trim()) names.add(p.company.trim())
    return [...names].sort()
  }, [products])

  const searchActive = search.trim().length > 0 || brandFilter !== null
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = products
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || (p.name_ur ?? '').includes(q) || (p.company ?? '').toLowerCase().includes(q) || (p.flavor ?? '').toLowerCase().includes(q))
    if (brandFilter) rows = rows.filter((p) => (p.company ?? '').trim() === brandFilter)
    const sorted = [...rows]
    if (sortBy === 'cheap') sorted.sort((a, b) => a.unit_price_pkr - b.unit_price_pkr)
    else if (sortBy === 'expensive') sorted.sort((a, b) => b.unit_price_pkr - a.unit_price_pkr)
    else sorted.sort((a, b) => a.name.localeCompare(b.name))
    return sorted
  }, [products, search, brandFilter, sortBy])

  const popularProducts = useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p]))
    return popularIds.map((id) => byId.get(id)).filter((p): p is Product => !!p)
  }, [products, popularIds])

  const submit = async () => {
    if (cartItems.length === 0) { toast.error(t('mp.cartEmpty')); return }
    if (!deliveryAddress.trim()) { toast.error(t('mp.deliveryAddressRequired')); return }
    if (!isPerOrder && !proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setSubmitting(true)
    const items = cartItems.map((p) => ({ product_id: p.id, quantity: cart[p.id] }))
    const { error } = await supabase.rpc('place_shop_order', {
      p_shop_id: shop!.id, p_items: items, p_method: isPerOrder ? 'direct' : method, p_proof_url: isPerOrder ? null : proofPath,
      p_delivery_address: deliveryAddress.trim(),
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(isPerOrder ? t('cm.orderPlacedDirectToast') : t('mp.orderPlacedToast'))
    router.push('/portal/marketplace')
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
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
      {shop.delivery_enabled && !bookable && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 mt-4">
          <p className="font-sans text-[13px] text-amber-900">{t('cm.notBookableExplain')}</p>
          {shop.owner_mobile && <p className="font-sans text-[13px] font-semibold text-amber-900 mt-1 ltr-num">{shop.owner_mobile}</p>}
        </div>
      )}

      {/* Search + brand rail — shown on the shop front regardless of
          department/category drill state, so "just find the thing" always
          works without navigating tiles first. Typing a query or tapping a
          brand switches the page into flat search-results mode below,
          bypassing the department drill entirely (see searchActive). */}
      {!activeDept && (
        <div className="mt-5">
          <div className="relative mb-3">
            <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant/60 pointer-events-none" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('mp.searchInShopPlaceholder')}
              className="w-full ps-9 pe-3 py-2.5 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[14px] font-sans text-dp-on-surface" />
          </div>
          {brandsInShop.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              <button onClick={() => setBrandFilter(null)} className={`shrink-0 px-3 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer border ${!brandFilter ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{t('cb.allTab')}</button>
              {brandsInShop.map((b) => (
                <button key={b} onClick={() => setBrandFilter(b)} className={`shrink-0 px-3 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer border ${brandFilter === b ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant'}`}>{b}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Popular — real sales data (shop_popular_products, migration 433),
          not a guess; hides itself entirely once that RPC isn't live yet
          or the shop has no sales history. */}
      {!activeDept && !searchActive && popularProducts.length > 0 && (
        <div className="mt-5">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Flame size={13} /> {t('mp.popularHeading')}</p>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {popularProducts.map((p) => (
              <div key={p.id} className="w-32 shrink-0">
                <ProductCard p={p} isUrdu={isUrdu} cover={coverByProduct[p.id]} qty={cart[p.id] ?? 0} max={p.quantity_on_hand}
                  canBuy={shop.delivery_enabled && bookable} onQty={setQty} t={t} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Flat search/brand results — combinable, sortable, with a live
          count and (on zero results) a hand-off into the city-fetch flow
          rather than a dead end. */}
      {searchActive ? (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('mp.resultsCount').replace('{n}', String(searchResults.length))}</p>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="px-2.5 py-1.5 bg-white border border-dp-outline-variant rounded-lg font-sans text-[12.5px] text-dp-on-surface">
              <option value="name">{t('mp.sortByName')}</option>
              <option value="cheap">{t('mp.sortCheapFirst')}</option>
              <option value="expensive">{t('mp.sortExpensiveFirst')}</option>
            </select>
          </div>
          {searchResults.length === 0 ? (
            <div className="text-center py-8 bg-white border border-dp-outline-variant rounded-lg">
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-3">{t('mp.noResultsInShop')}</p>
              <Link href="/portal/marketplace/order-city" className="inline-flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all">
                <MapPinned size={14} /> {t('mp.orderFromCityBtn')}
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {searchResults.map((p) => (
                <ProductCard key={p.id} p={p} isUrdu={isUrdu} cover={coverByProduct[p.id]} qty={cart[p.id] ?? 0} max={p.quantity_on_hand}
                  canBuy={shop.delivery_enabled && bookable} onQty={setQty} t={t} />
              ))}
            </div>
          )}
        </div>
      ) : (
      <>
      {/* Department → category → products, same drill-down shape a real
          department store's app would use — a shop with a handful of
          items still works fine (one department, one category, straight
          to the grid feels like nothing extra), it just stops being a
          wall of everything at once once a shop has real variety. */}
      {!activeDept && (
        <div className="mt-5">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><LayoutGrid size={13} /> {t('cm.browseByDept')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {departmentsPresent.map((d) => {
              const count = d.categories.reduce((s, c) => s + (countByCategory[c.slug] ?? 0), 0)
              return (
                <button key={d.key} onClick={() => setActiveDept(d.key)} className="text-start bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-colors cursor-pointer flex items-center gap-3">
                  <div className="shrink-0 w-9 h-9 rounded-lg bg-dp-secondary-container/50 text-dp-secondary flex items-center justify-center">
                    <DynamicIcon name={d.icon} size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">{isUrdu ? d.label_ur : d.label}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{count} {t('mk.productsCount')}</p>
                  </div>
                  <ChevronRight size={16} className={`shrink-0 text-dp-on-surface-variant ${isUrdu ? 'rotate-180' : ''}`} />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {activeDept && !activeCategory && (
        <div className="mt-5">
          <button onClick={() => setActiveDept(null)} className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer mb-3">
            <ArrowLeft size={13} className={isUrdu ? 'rotate-180' : ''} /> {t('cm.browseByDept')}
          </button>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{(() => { const d = shopTree.find((d) => d.key === activeDept); return d ? (isUrdu ? d.label_ur : d.label) : '' })()}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {categoriesPresent(activeDept).map((c) => (
              <button key={c.slug} onClick={() => setActiveCategory(c.slug)} className="text-start bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-colors cursor-pointer flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-sans text-[14px] font-bold text-dp-on-surface">{isUrdu ? c.label_ur : c.label}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{countByCategory[c.slug] ?? 0} {t('mk.productsCount')}</p>
                </div>
                <ChevronRight size={16} className={`shrink-0 text-dp-on-surface-variant ${isUrdu ? 'rotate-180' : ''}`} />
              </button>
            ))}
          </div>
        </div>
      )}

      {activeCategory && (
        <div className="mt-5">
          <button onClick={() => setActiveCategory(null)} className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer mb-3">
            <ArrowLeft size={13} className={isUrdu ? 'rotate-180' : ''} /> {(() => { const d = shopTree.find((d) => d.key === activeDept); return d ? (isUrdu ? d.label_ur : d.label) : '' })()}
          </button>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{(() => { const c = shopTree.flatMap((d) => d.categories).find((c) => c.slug === activeCategory); return c ? (isUrdu ? c.label_ur : c.label) : '' })()}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {visibleProducts.map((p) => (
              <ProductCard key={p.id} p={p} isUrdu={isUrdu} cover={coverByProduct[p.id]} qty={cart[p.id] ?? 0} max={p.quantity_on_hand}
                canBuy={shop.delivery_enabled && bookable} onQty={setQty} t={t} />
            ))}
          </div>
        </div>
      )}
      </>
      )}

      {shop.delivery_enabled && bookable && cartItems.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mt-5">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2 flex items-center gap-1.5"><ShoppingCart size={13} /> {t('mp.cartHeading')}</p>
          {cartItems.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 py-1">
              <p className="font-sans text-[13px] text-dp-on-surface truncate">{isUrdu && p.name_ur ? p.name_ur : p.name}{(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && ` (${isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})`} × <span className="ltr-num">{cart[p.id]}</span></p>
              <p className="font-sans text-[13px] font-semibold text-dp-on-surface shrink-0">{fmt(p.unit_price_pkr * cart[p.id])}</p>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 mt-2 border-t border-dp-outline-variant">
            <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('mp.goodsSubtotal')}</p>
            <p className="font-sans text-[13px] text-dp-on-surface-variant">{fmt(cartTotal)}</p>
          </div>
          {deliveryFeePkr > 0 && (
            <div className="flex items-center justify-between py-1">
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('mp.deliveryFee')}</p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{fmt(deliveryFeePkr)}</p>
            </div>
          )}
          <div className="flex items-center justify-between pt-2 mt-1 border-t border-dp-outline-variant">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('mp.cartTotal')}</p>
            <p className="font-heading text-[19px] font-bold text-dp-secondary">{fmt(cartTotal + deliveryFeePkr)}</p>
          </div>

          <div className="mt-4">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('mp.deliveryAddressLabel')}</label>
            <textarea value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} rows={2}
              placeholder={t('mp.deliveryAddressPlaceholder')} className="input-field resize-none" />
            {user?.mobile && <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('mp.deliveryContactNote')} <span className="font-semibold ltr-num">{user.mobile}</span></p>}
          </div>

          {isPerOrder ? (
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-secondary-container/40 rounded-lg px-3 py-2.5 mt-4">{t('cm.payDirectlyNote')}</p>
          ) : (
            <>
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
            </>
          )}
          <button onClick={submit} disabled={submitting} className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {submitting ? t('mp.placingOrder') : t('mp.placeOrderBtn')}
          </button>
        </div>
      )}
    </div>
  )
}
