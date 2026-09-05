'use client'

// Marketplace phase 4 — shop detail + cart checkout. Only a
// delivery_enabled shop gets the buy flow (the RPC would reject it
// server-side anyway — this just doesn't offer what would fail); a
// non-delivery shop still shows its full catalog, just with a "visit this
// store" note instead of quantity pickers, so price comparison from the
// search page still works either way.
//
// Visual language matches the "Village Portal Marketplace" design spec
// (2026-09-05 handoff zip): ink (#201e1d) / accent (#ec3013) two-tone,
// square-cornered cards, uppercase tracked micro-labels. All data/logic
// below is unchanged from before the restyle — this is a pure visual
// pass over the same department→category→product drill-down, cart, and
// checkout flow. Font stack deliberately stays this app's own (Nastaliq
// for Urdu headings via --font-urdu, the existing font-sans for body) —
// the mockup's Archivo/Noto Naskh Arabic pairing would need new webfonts
// wired through layout.tsx, and this app has already fought (and
// documented, see globals.css) a real Nastaliq-hijacks-Latin-glyphs bug
// from exactly that kind of font-stack change; not worth reopening for a
// visual-parity pass.
const INK = '#201e1d'
const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, MapPin, Minus, Plus, ShoppingCart, ChevronRight, LayoutGrid, Search, Flame, MapPinned, UtensilsCrossed, X } from 'lucide-react'
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
  unit: string; is_quick_food: boolean
}
interface Kit {
  id: string; name: string; name_ur: string | null; sub: string | null; sub_ur: string | null
  tint: 'accent' | 'ink' | 'photo'; photo_url: string | null
  shop_kit_items: { product_id: string; quantity: number }[]
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
    <div className="bg-white border border-[#dcd8d4] overflow-hidden">
      <div className="h-24 bg-[#eeece9]">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="w-full h-full object-cover" />
        )}
      </div>
      <div className="p-2.5">
        <p className="font-sans text-[12.5px] font-semibold truncate" style={{ color: INK }}>
          {isUrdu && p.name_ur ? p.name_ur : p.name}
          {(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && <span className="font-normal text-[#7a736d]"> ({isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})</span>}
        </p>
        {p.company && <p className="font-sans text-[10.5px] text-[#7a736d] truncate">{p.company}</p>}
        <p className="font-sans text-[13.5px] font-bold mt-0.5" style={{ color: INK }}>{fmt(p.unit_price_pkr)}{p.unit && p.unit !== 'عدد' && <span className="font-normal text-[10.5px] text-[#7a736d]"> {t('mp.perUnitPrefix')} {p.unit}</span>}</p>
        {canBuy && (
          p.quantity_on_hand <= 0 ? (
            <p className="font-sans text-[11px] mt-1.5" style={{ color: ACCENT_DARK }}>{t('mp.outOfStock')}</p>
          ) : (
            <div className="flex items-center justify-between gap-1 mt-1.5">
              <button onClick={() => onQty(p.id, qty - 1, max)} className="w-6 h-6 border border-[#dcd8d4] flex items-center justify-center cursor-pointer hover:border-[#201e1d] transition-colors"><Minus size={12} /></button>
              <span className="font-sans text-[13px] font-bold ltr-num" style={{ color: INK }}>{qty}</span>
              <button onClick={() => onQty(p.id, qty + 1, max)} className="w-6 h-6 text-white flex items-center justify-center cursor-pointer transition-colors" style={{ background: ACCENT }} onMouseEnter={(e) => (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}><Plus size={12} /></button>
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
  const [kits, setKits] = useState<Kit[]>([])
  const [openKit, setOpenKit] = useState<Kit | null>(null)
  const [kitBasket, setKitBasket] = useState<Record<string, number>>({})

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
    supabase.from('shop_kits').select('*, shop_kit_items(product_id, quantity)').eq('shop_id', shopId).order('display_order')
      .then(({ data }) => setKits((data ?? []) as unknown as Kit[]))
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

  // Quick Food rail (Shop Portal v3.2, §K) — a curated, shopkeeper-flagged
  // subset (is_quick_food, migration 444), not a category: bread, frozen
  // snacks, instant noodles and the like span several real categories, so
  // this reads them straight off the flag instead of filtering by any one
  // category slug.
  const quickFoodProducts = useMemo(() => products.filter((p) => p.is_quick_food), [products])

  // Recipe kits (Shop Portal v3 §E) — a kit's own "N / total items"
  // count and live total are always computed against this SHOP's current
  // products/prices, never stored, so two shops (or a shop that repriced
  // an ingredient) show different, always-current numbers for the same
  // kit definition.
  const kitCards = useMemo(() => kits.map((k) => {
    const lines = k.shop_kit_items.map((i) => ({ ...i, product: products.find((p) => p.id === i.product_id) }))
    const stockedCount = lines.filter((l) => l.product).length
    const total = lines.reduce((s, l) => s + (l.product ? l.product.unit_price_pkr * l.quantity : 0), 0)
    return { kit: k, lines, stockedCount, total }
  }), [kits, products])

  const openKitDetail = (k: Kit) => {
    setOpenKit(k)
    const preset: Record<string, number> = {}
    for (const i of k.shop_kit_items) {
      const p = products.find((x) => x.id === i.product_id)
      if (p) preset[i.product_id] = Math.min(i.quantity, p.quantity_on_hand)
    }
    setKitBasket(preset)
  }
  const addKitToCart = () => {
    setCart((c) => {
      const next = { ...c }
      for (const [productId, qty] of Object.entries(kitBasket)) {
        if (qty <= 0) continue
        const p = products.find((x) => x.id === productId)
        if (!p) continue
        next[productId] = Math.min((next[productId] ?? 0) + qty, p.quantity_on_hand)
      }
      return next
    })
    setOpenKit(null)
    toast.success(t('mp.kitAddedToCartToast'))
  }

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

  if (userLoading || loading) return <div className="text-center py-12 text-[#7a736d] font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('p.couldNotLoad')}</div>
  if (!shop) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('mp.shopNotFound')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className={`shop-ink-theme ${cartItems.length > 0 ? 'pb-16' : ''}`}>
      <button onClick={() => router.push('/portal/marketplace')} className="inline-flex items-center gap-1.5 font-sans text-[13.5px] font-semibold hover:underline cursor-pointer mb-4" style={{ color: ACCENT }}>
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}
      </button>

      {/* Shop info card — ink/accent badges instead of the amber "visit
          store" tone, square corners, uppercase tracked micro-labels. */}
      <div className="bg-white border border-[#dcd8d4] p-4">
        <div className="flex items-center gap-3">
          <div className="shrink-0 w-10 h-10 bg-[#eeece9] border border-[#c3bdb7] flex items-center justify-center font-sans text-[13px] font-extrabold" style={{ color: INK }}>
            {(isUrdu && shop.name_ur ? shop.name_ur : shop.name).trim().charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-[19px] font-bold leading-[2.1]" style={{ color: INK }}>{isUrdu && shop.name_ur ? shop.name_ur : shop.name}</h1>
            {shop.location && <p className="font-sans text-[11px] text-[#7a736d] flex items-center gap-1"><MapPin size={12} /> {isUrdu ? (shop.location_ur || shop.location) : shop.location}</p>}
          </div>
        </div>
        {shop.description && <p className="font-sans text-[13px] text-[#5b544f] mt-2.5">{isUrdu && shop.description_ur ? shop.description_ur : shop.description}</p>}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {shop.delivery_enabled && <span className="font-sans text-[10.5px] font-semibold px-2 py-1 border" style={{ background: '#fce3dc', borderColor: '#f4a68f', color: ACCENT_DARK }}>{t('mp.deliveryFee')} {fmt(deliveryFeePkr)}</span>}
          <span className="font-sans text-[10.5px] font-semibold px-2 py-1 bg-[#eeece9] border border-[#dcd8d4]" style={{ color: INK }}>{t('w.cash')}</span>
        </div>
      </div>

      {!shop.delivery_enabled && (
        <div className="bg-white border-2 p-3.5 mt-3" style={{ borderColor: ACCENT }}>
          <p className="font-sans text-[13px]" style={{ color: INK }}>{t('mp.visitStoreExplain')}</p>
          {shop.owner_mobile && <p className="font-sans text-[13px] font-semibold mt-1 ltr-num" style={{ color: ACCENT_DARK }}>{shop.owner_mobile}</p>}
        </div>
      )}
      {shop.delivery_enabled && !bookable && (
        <div className="bg-white border-2 p-3.5 mt-3" style={{ borderColor: ACCENT }}>
          <p className="font-sans text-[13px]" style={{ color: INK }}>{t('cm.notBookableExplain')}</p>
          {shop.owner_mobile && <p className="font-sans text-[13px] font-semibold mt-1 ltr-num" style={{ color: ACCENT_DARK }}>{shop.owner_mobile}</p>}
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
            <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#7a736d]/70 pointer-events-none" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('mp.searchInShopPlaceholder')}
              className="w-full ps-9 pe-3 py-2.5 bg-white border transition-all text-[14px] font-sans focus:ring-0"
              style={{ borderColor: INK, color: INK }} />
          </div>
          {brandsInShop.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              <button onClick={() => setBrandFilter(null)} className="shrink-0 px-3 py-1.5 text-[12px] font-sans font-semibold cursor-pointer border" style={!brandFilter ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { background: '#fff', color: '#7a736d', borderColor: '#dcd8d4' }}>{t('cb.allTab')}</button>
              {brandsInShop.map((b) => (
                <button key={b} onClick={() => setBrandFilter(b)} className="shrink-0 px-3 py-1.5 text-[12px] font-sans font-semibold cursor-pointer border" style={brandFilter === b ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { background: '#fff', color: '#7a736d', borderColor: '#dcd8d4' }}>{b}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recipe kits — one tap opens a pre-filled basket (§E). Rendered
          only for kits this shop actually has SOME line for; a kit with
          zero stocked lines has nothing useful to open. */}
      {!activeDept && !searchActive && kitCards.filter((k) => k.stockedCount > 0).length > 0 && (
        <div className="mt-5">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mb-2.5 flex items-center gap-1.5"><UtensilsCrossed size={13} /> {t('mp.kitsHeading')}</p>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {kitCards.filter((k) => k.stockedCount > 0).map(({ kit: k, lines, stockedCount, total }) => (
              <button key={k.id} onClick={() => openKitDetail(k)} className="shrink-0 w-40 text-start bg-white border cursor-pointer transition-colors" style={{ borderColor: '#dcd8d4' }}>
                <div className="h-16 flex items-end p-2.5 relative overflow-hidden" style={k.tint === 'photo' && k.photo_url ? { backgroundImage: `url(${k.photo_url})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { background: k.tint === 'accent' ? ACCENT : INK }}>
                  {k.tint === 'photo' && k.photo_url && <span className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(32,30,29,.72), rgba(32,30,29,.08))' }} />}
                  <span className="relative font-heading text-[15px] font-bold text-white leading-[1.9]">{isUrdu && k.name_ur ? k.name_ur : k.name}</span>
                </div>
                <div className="p-2.5">
                  <p className="font-sans text-[10.5px] text-[#7a736d] ltr-num">{stockedCount} / {lines.length} {t('mp.itemsSuffix')}</p>
                  <p className="font-sans text-[13.5px] font-bold mt-0.5" style={{ color: INK }}>{fmt(total)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick Food — shopkeeper-flagged rail (§K, migration 444). Same
          shelf position as the design's own مقبول اشیاء rail, one step
          before it. */}
      {!activeDept && !searchActive && quickFoodProducts.length > 0 && (
        <div className="mt-5">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mb-2.5">{t('mp.quickFoodHeading')}</p>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {quickFoodProducts.map((p) => (
              <div key={p.id} className="w-32 shrink-0">
                <ProductCard p={p} isUrdu={isUrdu} cover={coverByProduct[p.id]} qty={cart[p.id] ?? 0} max={p.quantity_on_hand}
                  canBuy={shop.delivery_enabled && bookable} onQty={setQty} t={t} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Popular — real sales data (shop_popular_products, migration 433),
          not a guess; hides itself entirely once that RPC isn't live yet
          or the shop has no sales history. */}
      {!activeDept && !searchActive && popularProducts.length > 0 && (
        <div className="mt-5">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mb-2.5 flex items-center gap-1.5"><Flame size={13} /> {t('mp.popularHeading')}</p>
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
            <p className="font-sans text-[13px] text-[#7a736d]">{t('mp.resultsCount').replace('{n}', String(searchResults.length))}</p>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="px-2.5 py-1.5 bg-white border border-[#dcd8d4] font-sans text-[12.5px]" style={{ color: INK }}>
              <option value="name">{t('mp.sortByName')}</option>
              <option value="cheap">{t('mp.sortCheapFirst')}</option>
              <option value="expensive">{t('mp.sortExpensiveFirst')}</option>
            </select>
          </div>
          {searchResults.length === 0 ? (
            <div className="text-center py-8 bg-white border border-[#dcd8d4]">
              <p className="font-sans text-[13.5px] text-[#7a736d] mb-3">{t('mp.noResultsInShop')}</p>
              <Link href="/portal/marketplace/order-city" className="inline-flex items-center gap-1.5 px-4 py-2 text-white font-sans text-[13px] font-semibold transition-all" style={{ background: ACCENT }}>
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
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mb-2.5 flex items-center gap-1.5"><LayoutGrid size={13} /> {t('cm.browseByDept')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {departmentsPresent.map((d) => {
              const count = d.categories.reduce((s, c) => s + (countByCategory[c.slug] ?? 0), 0)
              return (
                <button key={d.key} onClick={() => setActiveDept(d.key)} className="text-start bg-white border border-[#dcd8d4] p-3 hover:border-[#201e1d] transition-colors cursor-pointer">
                  <DynamicIcon name={d.icon} size={18} color={ACCENT} />
                  <p className="font-sans text-[11.5px] mt-1.5 leading-[1.5]" style={{ color: INK }}>{isUrdu ? d.label_ur : d.label}</p>
                  <p className="font-sans text-[9.5px] text-[#7a736d] mt-0.5">{count} {t('mk.productsCount')}</p>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {activeDept && !activeCategory && (
        <div className="mt-5">
          <button onClick={() => setActiveDept(null)} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline cursor-pointer mb-3" style={{ color: ACCENT }}>
            <ArrowLeft size={13} className={isUrdu ? 'rotate-180' : ''} /> {t('cm.browseByDept')}
          </button>
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mb-2.5">{(() => { const d = shopTree.find((d) => d.key === activeDept); return d ? (isUrdu ? d.label_ur : d.label) : '' })()}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {categoriesPresent(activeDept).map((c) => (
              <button key={c.slug} onClick={() => setActiveCategory(c.slug)} className="text-start bg-white border border-[#dcd8d4] p-3 hover:border-[#201e1d] transition-colors cursor-pointer flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold" style={{ color: INK }}>{isUrdu ? c.label_ur : c.label}</p>
                  <p className="font-sans text-[10.5px] text-[#7a736d] mt-0.5">{countByCategory[c.slug] ?? 0} {t('mk.productsCount')}</p>
                </div>
                <ChevronRight size={15} className={`shrink-0 text-[#7a736d] ${isUrdu ? 'rotate-180' : ''}`} />
              </button>
            ))}
          </div>
        </div>
      )}

      {activeCategory && (
        <div className="mt-5">
          <button onClick={() => setActiveCategory(null)} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline cursor-pointer mb-3" style={{ color: ACCENT }}>
            <ArrowLeft size={13} className={isUrdu ? 'rotate-180' : ''} /> {(() => { const d = shopTree.find((d) => d.key === activeDept); return d ? (isUrdu ? d.label_ur : d.label) : '' })()}
          </button>
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mb-2.5">{(() => { const c = shopTree.flatMap((d) => d.categories).find((c) => c.slug === activeCategory); return c ? (isUrdu ? c.label_ur : c.label) : '' })()}</p>
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

      {/* Pinned mini-cart (spec §4: "cart subtotal pinned at the bottom")
          — the full checkout form below is an ordinary block in normal
          flow, so on a shop with a long product list it sits far past
          the fold; a shopper who's added items while browsing near the
          top would never see any sign of the cart without scrolling all
          the way down first. This floats above everything and jumps to
          the real form on tap — same cart state, just always reachable. */}
      {shop.delivery_enabled && bookable && cartItems.length > 0 && (
        <button onClick={() => document.getElementById('shop-cart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className="fixed bottom-4 inset-x-4 z-40 mx-auto max-w-md flex items-center justify-between gap-3 px-4 py-3 text-white cursor-pointer shadow-lg"
          style={{ background: INK }}>
          <span className="flex items-center gap-2 font-sans text-[13px] font-semibold">
            <ShoppingCart size={16} /> {t('mp.cartHeading')} · <span className="ltr-num">{cartItems.reduce((s, p) => s + cart[p.id], 0)}</span>
          </span>
          <span className="font-sans text-[15px] font-bold ltr-num" style={{ color: ACCENT }}>{fmt(cartTotal + deliveryFeePkr)}</span>
        </button>
      )}

      {shop.delivery_enabled && bookable && cartItems.length > 0 && (
        <div id="shop-cart-panel" className="bg-white border border-[#dcd8d4] mt-5">
          <div className="px-4 py-3 text-white flex items-center gap-1.5" style={{ background: INK }}>
            <ShoppingCart size={14} />
            <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em]">{t('mp.cartHeading')}</p>
          </div>
          <div className="p-4">
          {cartItems.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 py-1">
              <p className="font-sans text-[13px] truncate" style={{ color: INK }}>{isUrdu && p.name_ur ? p.name_ur : p.name}{(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && ` (${isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})`} × <span className="ltr-num">{cart[p.id]}</span></p>
              <p className="font-sans text-[13px] font-semibold shrink-0" style={{ color: INK }}>{fmt(p.unit_price_pkr * cart[p.id])}</p>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 mt-2 border-t border-[#e2ded9]">
            <p className="font-sans text-[13px] text-[#7a736d]">{t('mp.goodsSubtotal')}</p>
            <p className="font-sans text-[13px] text-[#7a736d]">{fmt(cartTotal)}</p>
          </div>
          {deliveryFeePkr > 0 && (
            <div className="flex items-center justify-between py-1">
              <p className="font-sans text-[13px] text-[#7a736d]">{t('mp.deliveryFee')}</p>
              <p className="font-sans text-[13px] text-[#7a736d]">{fmt(deliveryFeePkr)}</p>
            </div>
          )}
          <div className="flex items-center justify-between pt-2 mt-1 border-t border-[#e2ded9]">
            <p className="font-sans text-[14px] font-bold" style={{ color: INK }}>{t('mp.cartTotal')}</p>
            <p className="font-heading text-[19px] font-bold" style={{ color: ACCENT }}>{fmt(cartTotal + deliveryFeePkr)}</p>
          </div>

          <div className="mt-4">
            <label className="block font-sans text-[13px] font-semibold text-[#5b544f] mb-1.5">{t('mp.deliveryAddressLabel')}</label>
            <textarea value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} rows={2}
              placeholder={t('mp.deliveryAddressPlaceholder')} className="w-full border border-[#dcd8d4] p-2.5 font-sans text-[13.5px] resize-none focus:ring-0" style={{ borderColor: '#dcd8d4' }} onFocus={(e) => (e.currentTarget.style.borderColor = INK)} onBlur={(e) => (e.currentTarget.style.borderColor = '#dcd8d4')} />
            {user?.mobile && <p className="font-sans text-[11.5px] text-[#7a736d] mt-1.5">{t('mp.deliveryContactNote')} <span className="font-semibold ltr-num">{user.mobile}</span></p>}
          </div>

          {isPerOrder ? (
            <p className="font-sans text-[12.5px] px-3 py-2.5 mt-4 border" style={{ background: '#fce3dc', borderColor: '#f4a68f', color: ACCENT_DARK }}>{t('cm.payDirectlyNote')}</p>
          ) : (
            <>
              <div className="mt-4">
                <label className="block font-sans text-[13px] font-semibold text-[#5b544f] mb-1.5">{t('w.paymentMethod')}</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full border border-[#dcd8d4] p-2.5 font-sans text-[13.5px]" style={{ color: INK }}>
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
          <button onClick={submit} disabled={submitting} className="w-full mt-4 text-white py-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: ACCENT }} onMouseEnter={(e) => !submitting && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>
            {submitting ? t('mp.placingOrder') : t('mp.placeOrderBtn')}
          </button>
          </div>
        </div>
      )}

      {/* Kit detail — pre-filled basket (§E). A line the shop doesn't
          stock renders dimmed and priced "—", never blocks the kit; only
          the lines this shop actually carries can be adjusted or dropped
          before merging into the real cart. */}
      {openKit && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setOpenKit(null)}>
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white p-5 w-full max-w-md max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-1">
              <h3 className="font-heading text-[18px] font-bold" style={{ color: INK }}>{isUrdu && openKit.name_ur ? openKit.name_ur : openKit.name}</h3>
              <button onClick={() => setOpenKit(null)} className="cursor-pointer" style={{ color: INK }}><X size={18} /></button>
            </div>
            {(isUrdu && openKit.sub_ur ? openKit.sub_ur : openKit.sub) && <p className="font-sans text-[12.5px] text-[#7a736d] mb-3">{isUrdu && openKit.sub_ur ? openKit.sub_ur : openKit.sub}</p>}
            <div className="border border-[#dcd8d4] divide-y divide-[#e2ded9]">
              {openKit.shop_kit_items.map((i) => {
                const p = products.find((x) => x.id === i.product_id)
                const inBasket = kitBasket[i.product_id] ?? 0
                if (!p) {
                  return (
                    <div key={i.product_id} className="flex items-center justify-between gap-2 px-3 py-2.5 opacity-45">
                      <span className="font-sans text-[13px]" style={{ color: INK }}>{t('mp.kitLineUnavailable')}</span>
                      <span className="font-sans text-[13px] font-bold" style={{ color: INK }}>—</span>
                    </div>
                  )
                }
                return (
                  <div key={i.product_id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-sans text-[13px] truncate" style={{ color: INK }}>{isUrdu && p.name_ur ? p.name_ur : p.name}</p>
                      <p className="font-sans text-[11px] text-[#7a736d]">{fmt(p.unit_price_pkr)}</p>
                    </div>
                    {inBasket > 0 ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button onClick={() => setKitBasket((b) => ({ ...b, [i.product_id]: Math.max(0, (b[i.product_id] ?? 0) - 1) }))} className="w-7 h-7 border border-[#dcd8d4] flex items-center justify-center cursor-pointer"><Minus size={13} /></button>
                        <span className="w-5 text-center font-sans text-[13px] font-bold ltr-num" style={{ color: INK }}>{inBasket}</span>
                        <button onClick={() => setKitBasket((b) => ({ ...b, [i.product_id]: Math.min((b[i.product_id] ?? 0) + 1, p.quantity_on_hand) }))} className="w-7 h-7 border border-[#dcd8d4] flex items-center justify-center cursor-pointer"><Plus size={13} /></button>
                      </div>
                    ) : (
                      <button onClick={() => setKitBasket((b) => ({ ...b, [i.product_id]: 1 }))} className="px-2.5 py-1 border font-sans text-[11.5px] font-semibold cursor-pointer shrink-0" style={{ borderColor: ACCENT, color: ACCENT }}>{t('mp.addBtn')}</button>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="flex items-center justify-between mt-3 mb-4">
              <span className="font-sans text-[13px] font-semibold text-[#7a736d]">{t('mp.kitTotalLabel')}</span>
              <span className="font-heading text-[19px] font-bold" style={{ color: INK }}>{fmt(Object.entries(kitBasket).reduce((s, [pid, qty]) => { const p = products.find((x) => x.id === pid); return s + (p ? p.unit_price_pkr * qty : 0) }, 0))}</span>
            </div>
            <button onClick={addKitToCart} disabled={Object.values(kitBasket).every((q) => q <= 0)} className="w-full text-white py-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: ACCENT }} onMouseEnter={(e) => (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>
              {t('mp.addKitToCartBtn')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
