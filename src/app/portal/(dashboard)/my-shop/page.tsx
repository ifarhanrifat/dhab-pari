'use client'

// Shop keeper self-service: catalog management for whichever shop is
// linked to this portal account (shops.portal_user_id, set by staff — see
// migration 391). Mirrors admin/shops' product form fields exactly, plus
// the AI camera step: point the phone at a product, Gemini (using this
// shop's OWN key, entered once below) drafts name/company/category/
// description from the packaging, the keeper reviews everything and still
// sets the buying/selling price themselves before saving. The exact same
// photo becomes the product's cover, so there's only one photo to take.

import { useEffect, useRef, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Capacitor } from '@capacitor/core'
import { createClient } from '@/lib/supabase/client'
import { Store, X, Pencil, Trash2, Camera, Loader2, KeyRound, ShoppingCart, PackageX, PackagePlus, Wallet, UtensilsCrossed, PlusCircle, Tag, AlertTriangle, LayoutGrid, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { takeNativePhoto, openCameraAppSettings, CameraPermissionDeniedError, isCameraCancel } from '@/lib/nativeCamera'
import { WalletTopupModal } from '@/components/portal/WalletTopupModal'
import { ShopBottomNav } from '@/components/portal/ShopBottomNav'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { getCategoryLabel } from '@/lib/shopTypes'
import { UNIT_OPTIONS } from '@/lib/catalogSelection'
import { CategoryPicker } from '@/components/shared/CategoryBrowser'
import { ShopCatalogSection } from '@/components/shared/ShopCatalogSection'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop { id: string; name: string; name_ur: string | null; delivery_enabled: boolean; commission_mode: string; primary_type: string }
interface Product {
  id: string; name: string; name_ur: string | null; description: string | null
  company: string | null; category: string | null; flavor: string | null; flavor_ur: string | null
  unit_price_pkr: number; cost_price_pkr: number; quantity_on_hand: number; expiry_date: string | null; is_active: boolean
  unit: string; is_quick_food: boolean
}

// کھلا سامان unit choices (migration 444) — the same 13-value list the
// design spec lists, in the same order, so a shopkeeper's own mental
// model of "which units exist" never drifts between what's typed here
// and what a buyer sees on the price. Shared from catalogSelection.ts so
// the catalog screen's own unit <select>s (BrandItemPicker) use the
// exact same list, not a second copy.

const emptyProduct = {
  name: '', name_ur: '', description: '', company: '', category: 'other' as string, flavor: '', flavor_ur: '',
  unit_price_pkr: 0, cost_price_pkr: 0, quantity_on_hand: 0, expiry_date: '', is_active: true,
  unit: 'عدد', is_quick_food: false,
}

interface Kit {
  id: string; name: string; name_ur: string | null; sub: string | null; sub_ur: string | null
  tint: 'accent' | 'ink' | 'photo'; photo_url: string | null
  shop_kit_items: { product_id: string; quantity: number }[]
}
const emptyKitForm = { name: '', name_ur: '', sub: '', sub_ur: '', tint: 'ink' as 'accent' | 'ink' | 'photo', photo_url: '' }

// Deals & Offers (Shop Portal v3 "S · deals" / "B · deal") — same object
// shape as a kit (a named list of the shop's own products at a fixed
// quantity each), plus a discount applied to the live-computed total
// three possible ways, running for a fixed number of days from the
// moment it's saved.
interface Deal {
  id: string; name: string; name_ur: string | null; sub: string | null; sub_ur: string | null
  tint: 'accent' | 'ink' | 'photo'; photo_url: string | null
  discount_kind: 'percent' | 'amount' | 'fixed_price'; discount_value: number
  is_active: boolean; expires_at: string
  shop_deal_items: { product_id: string; quantity: number }[]
}
const emptyDealForm = { name: '', name_ur: '', sub: '', sub_ur: '', tint: 'accent' as 'accent' | 'ink' | 'photo', photo_url: '', discount_kind: 'percent' as 'percent' | 'amount' | 'fixed_price', discount_value: '' as number | '', valid_days: 7 }
function dealFinalPrice(baseTotal: number, kind: Deal['discount_kind'] | typeof emptyDealForm.discount_kind, value: number) {
  if (kind === 'percent') return Math.max(0, Math.round(baseTotal * (1 - value / 100)))
  if (kind === 'amount') return Math.max(0, Math.round(baseTotal - value))
  return Math.max(0, Math.round(value))
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// The kit/deal builder's own item picker showed bare product names —
// several flavours of the same brand (e.g. five different Slanty bags)
// all rendered as the identical string "Slanty" with no way to tell
// which row was which, reading as duplicates rather than real variants.
// Same "name (flavor)" shape displayName() uses on purchase/page.tsx.
function productDisplayName(p: { name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null }, isUrdu: boolean) {
  const name = isUrdu && p.name_ur ? p.name_ur : p.name
  const flavor = isUrdu ? (p.flavor_ur || p.flavor) : p.flavor
  return flavor ? `${name} (${flavor})` : name
}

// Ink/accent two-tone from the "Village Portal Marketplace" design spec
// (2026-09-05) — same palette as the buyer-facing shop pages. Only the
// chrome this file itself renders (header, action row, scan button,
// product cards, modals) is restyled here; ShopCatalogSection is a
// shared component reused elsewhere in the portal, so its own internal
// styling is left as a separate, deliberately scoped-out follow-up.
const INK = '#201e1d'
const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// AI-scan duplicate check (Shop Portal v3.2 §L), scoped to what this app
// actually has: there is no separate shared Brand→Item→Variant catalog
// service to match against (the "Add Stock" tab's own catalog is a
// static seed file, browsed by hand — scanning has always deliberately
// read straight off the packaging instead, see this file's own header
// comment). What a scan CAN and should check is the one thing a stray
// duplicate would actually break: this shop's OWN existing listings.
// Three real verdicts fall out of that, matching the spec's first three
// (its fourth, "in the shared catalog but not this shop", has no
// counterpart here — scanning never reads that catalog to begin with):
//   'listed'  — same name+company+flavor already a row here -> edit it,
//               never insert a second row for the same physical product.
//   'variant' — same name+company, different flavor -> a new row is
//               correct (each flavor is its own row in this schema), just
//               say so plainly rather than silently treating it as new.
//   'new'     — no match at all -> today's existing behaviour, unchanged.
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
type ScanVerdict = 'listed' | 'variant' | 'new'
function matchScannedProduct(draft: { name: string; company: string; flavor: string }, existing: Product[]): { verdict: ScanVerdict; match: Product | null } {
  const dName = norm(draft.name), dCompany = norm(draft.company), dFlavor = norm(draft.flavor)
  if (!dName) return { verdict: 'new', match: null }
  const sameItem = existing.filter((p) => norm(p.name) === dName && norm(p.company) === dCompany)
  if (sameItem.length === 0) return { verdict: 'new', match: null }
  const exact = sameItem.find((p) => norm(p.flavor) === dFlavor)
  if (exact) return { verdict: 'listed', match: exact }
  return { verdict: 'variant', match: sameItem[0] }
}

export default function MyShopPage() {
  return (
    <Suspense fallback={null}>
      <MyShopPageInner />
    </Suspense>
  )
}

interface DashSummary {
  today_earnings_pkr: number; today_profit_pkr: number; today_purchase_pkr: number; stock_value_pkr: number
  today_bills_count: number; low_stock_count: number
}
interface TodayBill { id: string; total_amount_pkr: number; created_at: string; shop_sale_items: { product_name_snapshot: string; quantity: number }[] }

function MyShopPageInner() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const searchParams = useSearchParams()
  const view = searchParams.get('view') // null = dashboard, 'stock' | 'catalog' = ShopCatalogSection

  const [dashSummary, setDashSummary] = useState<DashSummary | null>(null)
  const [todayBills, setTodayBills] = useState<TodayBill[]>([])

  const [shop, setShop] = useState<Shop | null>(null)
  const [shopLoading, setShopLoading] = useState(true)
  const [products, setProducts] = useState<Product[]>([])
  const [coverByProduct, setCoverByProduct] = useState<Record<string, string>>({})

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState(emptyProduct)
  const [coverUrl, setCoverUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanBanner, setScanBanner] = useState<{ verdict: ScanVerdict; confidence: number } | null>(null)
  const scanInputRef = useRef<HTMLInputElement>(null)

  const [showTopup, setShowTopup] = useState(false)
  const [showAiSettings, setShowAiSettings] = useState(false)
  const [changingCategory, setChangingCategory] = useState(false)
  const [geminiKey, setGeminiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [savingKey, setSavingKey] = useState(false)

  // Recipe kits (Shop Portal v3 §E / v3.2 §J) — kits list for the
  // "ڈیش بورڈ → پکوان کے سیٹ" panel, plus the builder's own draft state.
  const [showKits, setShowKits] = useState(false)
  const [kits, setKits] = useState<Kit[]>([])
  const [showKitBuilder, setShowKitBuilder] = useState(false)
  const [editingKit, setEditingKit] = useState<Kit | null>(null)
  const [kitForm, setKitForm] = useState(emptyKitForm)
  const [kitItems, setKitItems] = useState<{ product_id: string; quantity: number }[]>([])
  const [kitItemSearch, setKitItemSearch] = useState('')
  const [savingKit, setSavingKit] = useState(false)
  const [deletingKitId, setDeletingKitId] = useState<string | null>(null)

  // Deals & Offers — same shape as the kits state block above.
  // A fixed "now" from mount, not a live Date.now()/new Date() call
  // during render — React's purity check (rightly) disallows the latter;
  // same pattern this app already uses for anything time-based (see
  // marketplace/adda, my-vehicle).
  const [now] = useState(() => Date.now())
  const [showDeals, setShowDeals] = useState(false)
  const [deals, setDeals] = useState<Deal[]>([])
  const [showDealBuilder, setShowDealBuilder] = useState(false)
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null)
  const [dealForm, setDealForm] = useState(emptyDealForm)
  const [dealItems, setDealItems] = useState<{ product_id: string; quantity: number }[]>([])
  const [dealItemSearch, setDealItemSearch] = useState('')
  const [savingDeal, setSavingDeal] = useState(false)
  const [deletingDealId, setDeletingDealId] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    supabase.from('shops').select('id, name, name_ur, delivery_enabled, commission_mode, primary_type').eq('portal_user_id', user.id).maybeSingle()
      .then(({ data }) => { setShop(data); setShopLoading(false) })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadKits = async (shopId: string) => {
    const { data } = await supabase.from('shop_kits').select('*, shop_kit_items(product_id, quantity)').eq('shop_id', shopId).order('display_order')
    setKits((data ?? []) as unknown as Kit[])
  }
  useEffect(() => { if (shop) loadKits(shop.id) }, [shop]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDeals = async (shopId: string) => {
    const { data } = await supabase.from('shop_deals').select('*, shop_deal_items(product_id, quantity)').eq('shop_id', shopId).order('display_order')
    setDeals((data ?? []) as unknown as Deal[])
  }
  useEffect(() => { if (shop) loadDeals(shop.id) }, [shop]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadProducts = async (shopId: string) => {
    const { data } = await supabase.from('shop_products').select('*').eq('shop_id', shopId).order('name')
    setProducts(data ?? [])
    if (data && data.length > 0) {
      const { data: media } = await supabase.from('product_media').select('product_id, url').eq('is_cover', true).in('product_id', data.map((p) => p.id))
      setCoverByProduct(Object.fromEntries((media ?? []).map((m) => [m.product_id, m.url])))
    }
  }
  useEffect(() => { if (shop) loadProducts(shop.id) }, [shop]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDashboard = async (shopId: string) => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const [{ data: s }, { data: bills }] = await Promise.all([
      supabase.rpc('shop_dashboard_summary', { p_shop_id: shopId }),
      supabase.from('shop_sales').select('id, total_amount_pkr, created_at, shop_sale_items(product_name_snapshot, quantity)')
        .eq('shop_id', shopId).gte('created_at', startOfToday.toISOString()).order('created_at', { ascending: false }).limit(8),
    ])
    setDashSummary(s as unknown as DashSummary)
    setTodayBills((bills ?? []) as unknown as TodayBill[])
  }
  useEffect(() => { if (shop) loadDashboard(shop.id) }, [shop]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!shop) return
    supabase.from('shop_ai_settings').select('gemini_api_key').eq('shop_id', shop.id).maybeSingle()
      .then(({ data }) => { setKeySaved(!!data?.gemini_api_key); setGeminiKey(data?.gemini_api_key ?? '') })
  }, [shop]) // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = (categorySlug: string, presetCompany?: string) => {
    setEditing(null)
    setForm({ ...emptyProduct, category: categorySlug, company: presetCompany ?? '' })
    setCoverUrl('')
    setChangingCategory(false)
    setScanBanner(null)
    setShowForm(true)
  }
  const openEdit = (p: Product) => {
    setEditing(p)
    setForm({
      name: p.name, name_ur: p.name_ur ?? '', description: p.description ?? '', company: p.company ?? '',
      category: p.category ?? 'other', flavor: p.flavor ?? '', flavor_ur: p.flavor_ur ?? '',
      unit_price_pkr: p.unit_price_pkr, cost_price_pkr: p.cost_price_pkr,
      quantity_on_hand: p.quantity_on_hand, expiry_date: p.expiry_date ?? '', is_active: p.is_active,
      unit: p.unit || 'عدد', is_quick_food: p.is_quick_food ?? false,
    })
    setCoverUrl(coverByProduct[p.id] ?? '')
    setChangingCategory(false)
    setShowForm(true)
  }

  // Native shell: launch the real device camera directly (the OS
  // WebView's <input capture> doesn't reliably do this — see
  // src/lib/nativeCamera.ts). Plain mobile browser: unchanged, falls
  // through to the hidden file input, which already works there.
  const openScanner = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const file = await takeNativePhoto()
        if (file) runScan(file)
      } catch (err) {
        if (err instanceof CameraPermissionDeniedError) {
          toast.error(t('sk.cameraPermissionDeniedToast'), { action: { label: t('af.openSettingsBtn'), onClick: () => openCameraAppSettings() } })
        } else if (!isCameraCancel(err)) {
          // A real failure the permission fix alone didn't cover — surface
          // it instead of leaving the tap looking like it did nothing.
          toast.error(err instanceof Error ? err.message : String(err))
        }
      }
      return
    }
    scanInputRef.current?.click()
  }

  const runScan = async (file: File) => {
    if (!shop) return
    if (!keySaved) { toast.error(t('sk.needKeyFirst')); setShowAiSettings(true); return }
    setScanning(true)
    try {
      const imageBase64 = await fileToBase64(file)
      const res = await fetch('/api/portal/shops/scan-product', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.id, imageBase64, mimeType: file.type }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? t('sk.scanFailed')); setScanning(false); return }

      // Upload the same photo as the product's cover — one photo does
      // both jobs, matching how this was described: point, scan, done.
      const path = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`
      const { data: uploaded } = await supabase.storage.from('images').upload(path, file)
      const publicUrl = uploaded ? supabase.storage.from('images').getPublicUrl(uploaded.path).data.publicUrl : ''

      const { verdict, match } = matchScannedProduct({ name: json.name || '', company: json.company || '', flavor: json.flavor || '' }, products)
      setScanBanner({ verdict, confidence: typeof json.confidence === 'number' ? json.confidence : 0 })

      if (verdict === 'listed' && match) {
        // Already a row for this exact item — open ITS edit form so
        // saving updates cost/sale/qty in place, never inserts a second
        // row for the same physical product. The scan's own photo still
        // becomes the cover if the listing doesn't already have one.
        openEdit(match)
        if (!coverByProduct[match.id]) setCoverUrl(publicUrl)
      } else {
        setEditing(null)
        setForm({
          ...emptyProduct, name: json.name || '', name_ur: json.name_ur || '', company: json.company || '',
          category: json.category || 'other', flavor: json.flavor || '', flavor_ur: json.flavor_ur || '',
          description: json.description || '',
        })
        setCoverUrl(publicUrl)
        setChangingCategory(false)
        setShowForm(true)
      }
      toast.success(t('sk.scanDraftedToast'))
    } catch {
      toast.error(t('sk.scanFailed'))
    } finally {
      setScanning(false)
      if (scanInputRef.current) scanInputRef.current.value = ''
    }
  }

  const save = async () => {
    if (!shop || !form.name.trim()) { toast.error(t('mk.nameRequired')); return }
    setSaving(true)
    const payload = {
      shop_id: shop.id, name: form.name, name_ur: form.name_ur || null, description: form.description || null,
      company: form.company || null, category: form.category || null, flavor: form.flavor || null, flavor_ur: form.flavor_ur || null,
      unit_price_pkr: form.unit_price_pkr, cost_price_pkr: form.cost_price_pkr, quantity_on_hand: form.quantity_on_hand,
      expiry_date: form.expiry_date || null, is_active: form.is_active,
      unit: form.unit, is_quick_food: form.is_quick_food,
    }
    const { data, error } = editing
      ? await supabase.from('shop_products').update(payload).eq('id', editing.id).select('id').single()
      : await supabase.from('shop_products').insert(payload).select('id').single()
    if (error) { toast.error(friendlyError(error)); setSaving(false); return }
    const productId = data.id

    if (coverUrl) {
      await supabase.from('product_media').update({ is_cover: false }).eq('product_id', productId).eq('is_cover', true)
      const { data: existing } = await supabase.from('product_media').select('id').eq('product_id', productId).eq('url', coverUrl).maybeSingle()
      if (existing) await supabase.from('product_media').update({ is_cover: true }).eq('id', existing.id)
      else await supabase.from('product_media').insert({ product_id: productId, url: coverUrl, is_cover: true })
    }
    setSaving(false)
    toast.success(t('mk.productSaved'))
    setShowForm(false)
    loadProducts(shop.id)
  }

  const inlineUpdate = (productId: string, field: 'cost_price_pkr' | 'unit_price_pkr' | 'quantity_on_hand', value: number) => {
    if (!shop) return
    setProducts((rows) => rows.map((p) => (p.id === productId ? { ...p, [field]: value } : p)))
    supabase.from('shop_products').update({ [field]: value }).eq('id', productId).then(({ error }) => {
      if (error) { toast.error(friendlyError(error)); loadProducts(shop.id) }
    })
  }

  const remove = async (p: Product) => {
    if (!confirm(t('mk.confirmDeleteProduct'))) return
    const { error } = await supabase.from('shop_products').delete().eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.productDeleted'))
    if (shop) loadProducts(shop.id)
  }

  const saveKey = async () => {
    if (!shop) return
    setSavingKey(true)
    const { error } = await supabase.from('shop_ai_settings').upsert({ shop_id: shop.id, gemini_api_key: geminiKey.trim() || null, updated_at: new Date().toISOString() })
    setSavingKey(false)
    if (error) { toast.error(friendlyError(error)); return }
    setKeySaved(!!geminiKey.trim())
    toast.success(t('sk.keySaved'))
    setShowAiSettings(false)
  }

  const openNewKit = () => {
    setEditingKit(null)
    setKitForm(emptyKitForm)
    setKitItems([])
    setKitItemSearch('')
    setShowKitBuilder(true)
  }
  const openEditKit = (k: Kit) => {
    setEditingKit(k)
    setKitForm({ name: k.name, name_ur: k.name_ur ?? '', sub: k.sub ?? '', sub_ur: k.sub_ur ?? '', tint: k.tint, photo_url: k.photo_url ?? '' })
    setKitItems(k.shop_kit_items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })))
    setKitItemSearch('')
    setShowKitBuilder(true)
  }
  const toggleKitItem = (productId: string) => {
    setKitItems((rows) => rows.find((r) => r.product_id === productId)
      ? rows.filter((r) => r.product_id !== productId)
      : [...rows, { product_id: productId, quantity: 1 }])
  }
  const setKitItemQty = (productId: string, qty: number) => {
    setKitItems((rows) => rows.map((r) => r.product_id === productId ? { ...r, quantity: Math.max(1, qty) } : r))
  }
  const kitTotal = kitItems.reduce((s, r) => {
    const p = products.find((x) => x.id === r.product_id)
    return s + (p ? p.unit_price_pkr * r.quantity : 0)
  }, 0)
  const saveKit = async () => {
    if (!shop) return
    if (!kitForm.name.trim()) { toast.error(t('sk.kitNameRequired')); return }
    if (kitItems.length === 0) { toast.error(t('sk.kitNeedsItemsToast')); return }
    setSavingKit(true)
    const { error } = await supabase.rpc('save_shop_kit', {
      p_kit_id: editingKit?.id ?? null, p_shop_id: shop.id,
      p_name: kitForm.name.trim(), p_name_ur: kitForm.name_ur.trim() || null,
      p_sub: kitForm.sub.trim() || null, p_sub_ur: kitForm.sub_ur.trim() || null,
      p_tint: kitForm.tint, p_photo_url: kitForm.tint === 'photo' ? (kitForm.photo_url || null) : null,
      p_items: kitItems,
    })
    setSavingKit(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.kitSavedToast'))
    setShowKitBuilder(false)
    loadKits(shop.id)
  }
  const removeKit = async (k: Kit) => {
    if (!confirm(t('sk.confirmDeleteKit'))) return
    setDeletingKitId(k.id)
    const { error } = await supabase.rpc('delete_shop_kit', { p_kit_id: k.id })
    setDeletingKitId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.kitDeletedToast'))
    if (shop) loadKits(shop.id)
  }
  const kitItemResults = kitItemSearch.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(kitItemSearch.toLowerCase()) || (p.name_ur ?? '').includes(kitItemSearch))
    : products

  const openNewDeal = () => {
    setEditingDeal(null)
    setDealForm(emptyDealForm)
    setDealItems([])
    setDealItemSearch('')
    setShowDealBuilder(true)
  }
  const openEditDeal = (d: Deal) => {
    setEditingDeal(d)
    const daysLeft = Math.max(1, Math.ceil((new Date(d.expires_at).getTime() - now) / 86400000))
    setDealForm({ name: d.name, name_ur: d.name_ur ?? '', sub: d.sub ?? '', sub_ur: d.sub_ur ?? '', tint: d.tint, photo_url: d.photo_url ?? '', discount_kind: d.discount_kind, discount_value: d.discount_value, valid_days: daysLeft })
    setDealItems(d.shop_deal_items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })))
    setDealItemSearch('')
    setShowDealBuilder(true)
  }
  const toggleDealItem = (productId: string) => {
    setDealItems((rows) => rows.find((r) => r.product_id === productId)
      ? rows.filter((r) => r.product_id !== productId)
      : [...rows, { product_id: productId, quantity: 1 }])
  }
  const setDealItemQty = (productId: string, qty: number) => {
    setDealItems((rows) => rows.map((r) => r.product_id === productId ? { ...r, quantity: Math.max(1, qty) } : r))
  }
  const dealBaseTotal = dealItems.reduce((s, r) => {
    const p = products.find((x) => x.id === r.product_id)
    return s + (p ? p.unit_price_pkr * r.quantity : 0)
  }, 0)
  const dealFinalTotal = dealFinalPrice(dealBaseTotal, dealForm.discount_kind, Number(dealForm.discount_value) || 0)
  const saveDeal = async () => {
    if (!shop) return
    if (!dealForm.name.trim()) { toast.error(t('sk.dealNameRequired')); return }
    if (dealItems.length === 0) { toast.error(t('sk.dealNeedsItemsToast')); return }
    setSavingDeal(true)
    const { error } = await supabase.rpc('save_shop_deal', {
      p_deal_id: editingDeal?.id ?? null, p_shop_id: shop.id,
      p_name: dealForm.name.trim(), p_name_ur: dealForm.name_ur.trim() || null,
      p_sub: dealForm.sub.trim() || null, p_sub_ur: dealForm.sub_ur.trim() || null,
      p_tint: dealForm.tint, p_photo_url: dealForm.tint === 'photo' ? (dealForm.photo_url || null) : null,
      p_discount_kind: dealForm.discount_kind, p_discount_value: Number(dealForm.discount_value) || 0,
      p_valid_days: dealForm.valid_days, p_items: dealItems,
    })
    setSavingDeal(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.dealSavedToast'))
    setShowDealBuilder(false)
    loadDeals(shop.id)
  }
  const removeDeal = async (d: Deal) => {
    if (!confirm(t('sk.confirmDeleteDeal'))) return
    setDeletingDealId(d.id)
    const { error } = await supabase.rpc('delete_shop_deal', { p_deal_id: d.id })
    setDeletingDealId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.dealDeletedToast'))
    if (shop) loadDeals(shop.id)
  }
  const toggleDealActive = async (d: Deal) => {
    const { error } = await supabase.rpc('toggle_shop_deal', { p_deal_id: d.id, p_is_active: !d.is_active })
    if (error) { toast.error(friendlyError(error)); return }
    if (shop) loadDeals(shop.id)
  }
  const dealItemResults = dealItemSearch.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(dealItemSearch.toLowerCase()) || (p.name_ur ?? '').includes(dealItemSearch))
    : products

  if (userLoading || shopLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!shop) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <Store size={28} className="mx-auto text-dp-on-surface-variant/50 mb-3" />
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('sk.noShopLinked')}</p>
      </div>
    )
  }

  const dashLowStock = dashSummary?.low_stock_count ?? 0

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      {view ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <h1 className="font-heading text-[26px] font-bold leading-[34px] flex items-center gap-2" style={{ color: INK }}><Store size={22} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</h1>
            <div className="flex items-center gap-1.5 flex-wrap">
              {shop.commission_mode === 'per_order' && (
                <button onClick={() => setShowTopup(true)} className="flex items-center gap-1 px-2.5 py-1.5 border border-[#dcd8d4] font-sans text-[11px] whitespace-nowrap font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
                  <Wallet size={12} /> {t('cm.topupWalletBtn')}
                </button>
              )}
              <button onClick={() => setShowAiSettings(true)} className="flex items-center gap-1 px-2.5 py-1.5 border border-[#dcd8d4] font-sans text-[11px] whitespace-nowrap font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
                <KeyRound size={12} /> {keySaved ? t('sk.aiSettingsBtn') : t('sk.setUpAiBtn')}
              </button>
              <Link href="/portal/my-shop/purchase" className="flex items-center gap-1 px-2.5 py-1.5 border border-[#dcd8d4] font-sans text-[11px] whitespace-nowrap font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
                <PackagePlus size={12} /> {t('sk.purchaseEntryBtn')}
              </Link>
              <button onClick={() => setShowDeals(true)} className="flex items-center gap-1 px-2.5 py-1.5 border border-[#dcd8d4] font-sans text-[11px] whitespace-nowrap font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
                <Tag size={12} /> {t('sk.dealsBtn')}
              </button>
              <button onClick={() => setShowKits(true)} className="flex items-center gap-1 px-2.5 py-1.5 border border-[#dcd8d4] font-sans text-[11px] whitespace-nowrap font-semibold cursor-pointer hover:border-[#201e1d] transition-colors" style={{ color: INK }}>
                <UtensilsCrossed size={12} /> {t('sk.kitsBtn')}
              </button>
            </div>
          </div>
          <p className="font-sans text-[13px] text-[#7a736d] mb-5">{t('sk.pageSubtitle')}</p>

          <div className="flex items-center gap-2 flex-wrap mb-4">
            <input ref={scanInputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) runScan(f) }} />
            <button onClick={openScanner} disabled={scanning}
              className="flex items-center gap-2 px-4 py-2.5 text-white font-sans text-[14px] font-semibold cursor-pointer transition-all disabled:opacity-60" style={{ background: ACCENT }} onMouseEnter={(e) => !scanning && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>
              {scanning ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />} {scanning ? t('sk.scanningLabel') : t('sk.scanProductBtn')}
            </button>
          </div>

          <ShopCatalogSection
            shopId={shop.id}
            primaryType={shop.primary_type}
            products={products}
            forceTab={view === 'catalog' ? 'addstock' : 'mystock'}
            onAddItem={openNew}
            onCommitted={() => loadProducts(shop.id)}
            onInlineUpdate={inlineUpdate}
            onScanClick={openScanner}
            renderProduct={(p) => (
          <div key={p.id} className="bg-white border border-[#dcd8d4] overflow-hidden">
            <div className="h-28 bg-[#eeece9] relative">
              {coverByProduct[p.id] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coverByProduct[p.id]} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[#c3bdb7]"><Store size={24} /></div>
              )}
              {p.quantity_on_hand <= 0 && <span className="absolute top-1.5 end-1.5 inline-flex items-center gap-1 text-[9.5px] font-bold uppercase px-2 py-0.5 border" style={{ background: '#fce3dc', borderColor: '#f4a68f', color: ACCENT_DARK }}><PackageX size={10} /> {t('sk.outOfStock')}</span>}
            </div>
            <div className="p-3">
              <p className="font-sans text-[13.5px] font-semibold truncate" style={{ color: INK }}>
                {isUrdu && p.name_ur ? p.name_ur : p.name}
                {(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && <span className="font-normal text-[#7a736d]"> ({isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})</span>}
              </p>
              {p.company && <p className="font-sans text-[11px] text-[#7a736d] truncate">{p.company}</p>}
              <div className="flex items-baseline gap-2 mt-1">
                <p className="font-sans text-[14px] font-bold" style={{ color: INK }}>{fmt(p.unit_price_pkr)}{p.unit && p.unit !== 'عدد' && <span className="font-normal text-[11px] text-[#7a736d]"> {t('mp.perUnitPrefix')} {p.unit}</span>}</p>
                {p.cost_price_pkr > 0 && <p className="font-sans text-[11px] text-[#7a736d]">{t('sk.costLabel')} {fmt(p.cost_price_pkr)}</p>}
              </div>
              <p className="font-sans text-[11.5px] text-[#7a736d] mt-0.5">{t('mk.stockLabel')} {fmt(p.quantity_on_hand)}</p>
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-[#e2ded9]">
                <button onClick={() => { setScanBanner(null); openEdit(p) }} className="p-1.5 text-[#7a736d] hover:opacity-70 cursor-pointer" style={{ color: INK }}><Pencil size={14} /></button>
                <button onClick={() => remove(p)} className="p-1.5 cursor-pointer" style={{ color: ACCENT }}><Trash2 size={14} /></button>
              </div>
            </div>
          </div>
        )}
          />
        </>
      ) : (
        // ── S · dashboard ──────────────────────────────────────────────
        <>
          <div className="bg-white border border-[#dcd8d4] p-3.5">
            <div className="flex items-start gap-2.5">
              <div className="shrink-0 w-10 h-10 bg-[#eeece9] border border-[#c3bdb7] flex items-center justify-center font-sans text-[13px] font-extrabold" style={{ color: INK }}>
                {(isUrdu && shop.name_ur ? shop.name_ur : shop.name).trim().charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="font-heading text-[18px] font-bold leading-[1.9]" style={{ color: INK }}>{isUrdu && shop.name_ur ? shop.name_ur : shop.name}</h1>
              </div>
              <span className="shrink-0 font-sans text-[10.5px] font-bold px-2 py-1 text-white" style={{ background: ACCENT }}>{t('sk.shopOpenBadge')}</span>
            </div>
            <div className="flex items-center gap-2 mt-3">
              {shop.commission_mode === 'per_order' && (
                <button onClick={() => setShowTopup(true)} className="flex items-center gap-1 font-sans text-[11px] font-semibold cursor-pointer" style={{ color: ACCENT }}><Wallet size={12} /> {t('cm.topupWalletBtn')}</button>
              )}
              <button onClick={() => setShowAiSettings(true)} className="flex items-center gap-1 font-sans text-[11px] font-semibold cursor-pointer" style={{ color: ACCENT }}><KeyRound size={12} /> {keySaved ? t('sk.aiSettingsBtn') : t('sk.setUpAiBtn')}</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-2">
            <div className="p-3" style={{ background: INK }}>
              <p className="font-sans text-[9px] font-bold uppercase tracking-[0.12em] text-white/60">{t('sk.todaySaleLabel')}</p>
              <p className="font-heading text-[20px] font-bold text-white mt-0.5 ltr-num">{fmt(dashSummary?.today_earnings_pkr ?? 0)}</p>
              <p className="font-sans text-[10px] text-white/75 mt-0.5 ltr-num">{dashSummary?.today_bills_count ?? 0} {t('sk.billsSuffix')}</p>
            </div>
            <div className="p-3" style={{ background: ACCENT }}>
              <p className="font-sans text-[9px] font-bold uppercase tracking-[0.12em] text-white/80">{t('sk.todayProfitLabel')}</p>
              <p className="font-heading text-[20px] font-bold text-white mt-0.5 ltr-num">{fmt(dashSummary?.today_profit_pkr ?? 0)}</p>
            </div>
            <div className="p-3 bg-white border border-[#dcd8d4]">
              <p className="font-sans text-[9px] font-bold uppercase tracking-[0.12em] text-[#7a736d]">{t('sk.todayPurchaseLabel2')}</p>
              <p className="font-heading text-[17px] font-bold mt-0.5 ltr-num" style={{ color: INK }}>{fmt(dashSummary?.today_purchase_pkr ?? 0)}</p>
            </div>
            <div className="p-3 bg-white border border-[#dcd8d4]">
              <p className="font-sans text-[9px] font-bold uppercase tracking-[0.12em] text-[#7a736d]">{t('sk.stockValueLabel')}</p>
              <p className="font-heading text-[17px] font-bold mt-0.5 ltr-num" style={{ color: INK }}>{fmt(dashSummary?.stock_value_pkr ?? 0)}</p>
            </div>
          </div>

          <Link href="/portal/my-shop/sell" className="w-full mt-2 flex items-center gap-2.5 px-3.5 py-4 text-white cursor-pointer" style={{ background: ACCENT }}>
            <ShoppingCart size={20} />
            <span className="flex-1">
              <span className="block font-heading text-[16px] font-bold leading-[1.9]">{t('sk.dashCounterBtn')}</span>
              <span className="block font-sans text-[10.5px] opacity-90">{t('sk.dashCounterSub')}</span>
            </span>
            <ArrowRight size={16} className="rotate-180 rtl:rotate-0" />
          </Link>

          <div className="grid grid-cols-2 gap-2 mt-2">
            <Link href="/portal/my-shop/purchase" className="text-start text-white p-3 cursor-pointer" style={{ background: ACCENT }}>
              <PlusCircle size={16} />
              <span className="block font-sans text-[12px] font-semibold mt-1.5">{t('sk.dashAddStockHeading')}</span>
              <span className="block font-sans text-[10px] opacity-90 mt-0.5">{t('sk.dashAddStockSub')}</span>
            </Link>
            <Link href="/portal/my-shop?view=catalog" className="text-start bg-white border border-[#dcd8d4] p-3 cursor-pointer" style={{ borderInlineStart: `3px solid ${INK}` }}>
              <LayoutGrid size={16} style={{ color: INK }} />
              <span className="block font-sans text-[12px] font-semibold mt-1.5" style={{ color: INK }}>{t('sk.navCatalog')}</span>
              <span className="block font-sans text-[10px] text-[#7a736d] mt-0.5 ltr-num">{t('sk.dashCatalogSub').replace('{n}', String(new Set(products.map((p) => p.company).filter(Boolean)).size))}</span>
            </Link>
          </div>

          <button onClick={() => setShowDeals(true)} className="w-full mt-2 flex items-center gap-2.5 px-3.5 py-3.5 text-white cursor-pointer text-start" style={{ background: INK }}>
            <Tag size={18} />
            <span className="flex-1">
              <span className="block font-sans text-[13px]">{t('sk.dealsBtn')}</span>
              <span className="block font-sans text-[10.5px] opacity-75 mt-0.5">{t('sk.dashDealsSub')}</span>
            </span>
            <ArrowRight size={15} className="rotate-180 rtl:rotate-0" />
          </button>

          <button onClick={() => setShowKits(true)} className="w-full mt-2 flex items-center gap-2.5 px-3.5 py-3.5 bg-white border border-[#dcd8d4] cursor-pointer text-start" style={{ borderInlineStart: `3px solid ${INK}` }}>
            <UtensilsCrossed size={18} style={{ color: INK }} />
            <span className="flex-1">
              <span className="block font-sans text-[13px]" style={{ color: INK }}>{t('sk.kitsBtn')}</span>
              <span className="block font-sans text-[10.5px] text-[#7a736d] mt-0.5">{t('sk.dashKitsSub')}</span>
            </span>
            <ArrowRight size={15} className="rotate-180 rtl:rotate-0 text-[#7a736d]" />
          </button>

          {dashLowStock > 0 && (
            <div className="border-2 p-3 mt-3 flex items-center gap-2" style={{ borderColor: ACCENT, background: '#fce3dc' }}>
              <AlertTriangle size={16} style={{ color: ACCENT_DARK }} />
              <span className="flex-1 font-sans text-[13px]" style={{ color: ACCENT_DARK }}>{t('sk.dashLowStockPrefix').replace('{n}', String(dashLowStock))}</span>
              <Link href="/portal/my-shop?view=stock" className="font-sans text-[11.5px] font-semibold underline cursor-pointer" style={{ color: ACCENT_DARK }}>{t('sk.dashViewBtn')}</Link>
            </div>
          )}

          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a736d] mt-5 mb-2">{t('sk.dashTodaysBillsHeading')}</p>
          {todayBills.length === 0 ? (
            <p className="font-sans text-[13px] text-[#7a736d] text-center py-4">{t('sk.dashNoBillsToday')}</p>
          ) : (
            <div className="space-y-1.5">
              {todayBills.map((b) => (
                <div key={b.id} className="bg-white border border-[#dcd8d4] p-2.5 flex items-center gap-2.5">
                  <span className="min-w-0 flex-1 font-sans text-[12px] text-[#7a736d] truncate">
                    {b.shop_sale_items.map((it) => it.product_name_snapshot).join('، ')}
                  </span>
                  <span className="shrink-0 font-sans text-[13px] font-bold ltr-num" style={{ color: INK }}>{fmt(b.total_amount_pkr)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ShopBottomNav />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold" style={{ color: INK }}>{editing ? t('mk.editProductBtn') : t('mk.newProductBtn')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            {scanBanner && (
              <p className="font-sans text-[12px] px-3 py-2 mb-3 border" style={{ background: '#fce3dc', borderColor: '#f4a68f', color: ACCENT_DARK }}>
                {scanBanner.verdict === 'listed' ? t('sk.scanVerdictListed')
                  : scanBanner.verdict === 'variant' ? t('sk.scanVerdictVariant')
                  : t('sk.reviewDraftHint')}
                {scanBanner.confidence > 0 && scanBanner.confidence < 0.75 && <span className="block mt-1 font-semibold">{t('sk.scanLowConfidence')}</span>}
              </p>
            )}
            <div className="space-y-3">
              <ImageUpload bucket="images" label={t('mk.productPhoto')} currentUrl={coverUrl} onUpload={setCoverUrl} />
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('mk.productNamePlaceholder')} className="input-field" />
              <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder={t('sk.companyPlaceholder')} className="input-field" />
              <div className="grid grid-cols-2 gap-3">
                <input value={form.flavor} onChange={(e) => setForm({ ...form, flavor: e.target.value })} placeholder={t('sk.flavorPlaceholder')} className="input-field" />
                <input value={form.flavor_ur} onChange={(e) => setForm({ ...form, flavor_ur: e.target.value })} placeholder={t('sk.flavorUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1">{t('cm.categoryLabel')}</label>
                {!changingCategory ? (
                  <div className="flex items-center justify-between gap-2 px-3 py-2.5 border" style={{ background: '#fce3dc', borderColor: '#f4a68f' }}>
                    <span className="font-sans text-[13.5px] font-semibold" style={{ color: ACCENT_DARK }}>{getCategoryLabel(form.category, isUrdu)}</span>
                    <button type="button" onClick={() => setChangingCategory(true)} className="font-sans text-[12px] font-semibold hover:underline cursor-pointer shrink-0" style={{ color: ACCENT_DARK }}>{t('sk.changeCategoryBtn')}</button>
                  </div>
                ) : (
                  <CategoryPicker primaryType={shop?.primary_type ?? 'general_store'} value={form.category}
                    onPick={(slug) => { setForm({ ...form, category: slug }); setChangingCategory(false) }} />
                )}
              </div>
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder={t('a.notesOptional')} className="input-field resize-none" />
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1">{t('sk.costPriceLabel')}</label><input type="number" value={form.cost_price_pkr || ''} onChange={(e) => setForm({ ...form, cost_price_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1">{t('mk.unitPriceLabel')}</label><input type="number" value={form.unit_price_pkr || ''} onChange={(e) => setForm({ ...form, unit_price_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1">{t('mk.stockLabel')}</label><input type="number" value={form.quantity_on_hand || ''} onChange={(e) => setForm({ ...form, quantity_on_hand: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1">{t('sk.unitLabel')}</label>
                  <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className="input-field" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>
                    {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div><label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1">{t('mk.expiryDateLabel')}</label><input type="date" value={form.expiry_date} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} className="input-field" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} style={{ accentColor: ACCENT }} /><span className="font-sans text-[14px]">{t('mk.productActiveLabel')}</span></label>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_quick_food} onChange={(e) => setForm({ ...form, is_quick_food: e.target.checked })} style={{ accentColor: ACCENT }} /><span className="font-sans text-[14px]">{t('sk.quickFoodLabel')}</span></label>
              <button onClick={save} disabled={saving} className="w-full text-white py-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: ACCENT }} onMouseEnter={(e) => !saving && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

      {showTopup && (
        <WalletTopupModal kind="shop" sellerId={shop.id} onClose={() => setShowTopup(false)} onSubmitted={() => setShowTopup(false)} />
      )}

      {showAiSettings && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowAiSettings(false)}>
          <div className="bg-white p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-[20px] font-bold flex items-center gap-2" style={{ color: INK }}><KeyRound size={18} /> {t('sk.aiSettingsBtn')}</h2>
              <button onClick={() => setShowAiSettings(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-[#7a736d] mb-3">{t('sk.aiSettingsHint')}</p>
            <input type="password" value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} placeholder={t('sk.apiKeyPlaceholder')} className="input-field mb-3" dir="ltr" />
            <button onClick={saveKey} disabled={savingKey} className="w-full text-white py-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: ACCENT }} onMouseEnter={(e) => !savingKey && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>{savingKey ? t('action.saving') : t('g.saveChanges')}</button>
          </div>
        </div>
      )}

      {/* Recipe kits list — "ڈیش بورڈ → پکوان کے سیٹ" (v3.2 §J). Each
          card mirrors the buyer-facing kit card's own fields (name, sub,
          live count/total) so the shopkeeper sees exactly what a
          villager would see. */}
      {showKits && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowKits(false)}>
          <div className="bg-white p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold flex items-center gap-2" style={{ color: INK }}><UtensilsCrossed size={18} /> {t('sk.kitsBtn')}</h2>
              <button onClick={() => setShowKits(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <button onClick={() => { setShowKits(false); openNewKit() }} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-2 border-dashed font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-[#f7f6f5] transition-all mb-4" style={{ borderColor: '#dcd8d4', color: ACCENT }}>
              <PlusCircle size={16} /> {t('sk.newKitBtn')}
            </button>
            {kits.length === 0 ? (
              <p className="text-center py-8 text-[#7a736d] font-sans text-[13.5px]">{t('sk.noKitsYet')}</p>
            ) : (
              <div className="space-y-2">
                {kits.map((k) => {
                  const stocked = k.shop_kit_items.filter((i) => products.find((p) => p.id === i.product_id)).length
                  const total = k.shop_kit_items.reduce((s, i) => { const p = products.find((x) => x.id === i.product_id); return s + (p ? p.unit_price_pkr * i.quantity : 0) }, 0)
                  return (
                    <div key={k.id} className="bg-white border border-[#dcd8d4] p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-sans text-[14px] font-semibold truncate" style={{ color: INK }}>{isUrdu && k.name_ur ? k.name_ur : k.name}</p>
                        <p className="font-sans text-[11.5px] text-[#7a736d] mt-0.5"><span className="ltr-num">{stocked} / {k.shop_kit_items.length}</span> {t('sk.kitItemsStockedSuffix')} · {fmt(total)}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => { setShowKits(false); openEditKit(k) }} className="p-1.5 cursor-pointer" style={{ color: INK }}><Pencil size={14} /></button>
                        <button onClick={() => removeKit(k)} disabled={deletingKitId === k.id} className="p-1.5 cursor-pointer disabled:opacity-50" style={{ color: ACCENT }}><Trash2 size={14} /></button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Kit builder — name/description/card-look, then an item picker
          mirroring the same tick+search pattern the catalog Add Stock
          tab already uses, over the shop's OWN products (a kit is only
          ever built from what this shop already carries). */}
      {showKitBuilder && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowKitBuilder(false)}>
          <div className="bg-white p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold" style={{ color: INK }}>{editingKit ? t('sk.editKitTitle') : t('sk.newKitBtn')}</h2>
              <button onClick={() => setShowKitBuilder(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input value={kitForm.name} onChange={(e) => setKitForm({ ...kitForm, name: e.target.value })} placeholder={t('sk.kitNamePlaceholder')} className="input-field" />
              <input value={kitForm.name_ur} onChange={(e) => setKitForm({ ...kitForm, name_ur: e.target.value })} placeholder={t('sk.kitNameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <input value={kitForm.sub} onChange={(e) => setKitForm({ ...kitForm, sub: e.target.value })} placeholder={t('sk.kitSubPlaceholder')} className="input-field" />
              <input value={kitForm.sub_ur} onChange={(e) => setKitForm({ ...kitForm, sub_ur: e.target.value })} placeholder={t('sk.kitSubUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1.5">{t('sk.kitCardLookLabel')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['accent', 'ink', 'photo'] as const).map((tint) => (
                    <button key={tint} type="button" onClick={() => setKitForm({ ...kitForm, tint })}
                      className="px-3 py-2 border font-sans text-[12.5px] font-semibold cursor-pointer transition-colors"
                      style={kitForm.tint === tint ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: INK }}>
                      {tint === 'accent' ? t('sk.kitTintAccent') : tint === 'ink' ? t('sk.kitTintInk') : t('sk.kitTintPhoto')}
                    </button>
                  ))}
                </div>
              </div>
              {kitForm.tint === 'photo' && (
                <ImageUpload bucket="images" label={t('sk.kitPhotoLabel')} currentUrl={kitForm.photo_url} onUpload={(url) => setKitForm({ ...kitForm, photo_url: url })} />
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f]">{t('sk.kitItemsLabel')}</label>
                  <span className="font-sans text-[11.5px] text-[#7a736d]">{t('sk.kitLiveTotalLabel')} <span className="font-bold ltr-num" style={{ color: INK }}>{fmt(kitTotal)}</span></span>
                </div>
                <input value={kitItemSearch} onChange={(e) => setKitItemSearch(e.target.value)} placeholder={t('sk.searchOwnCatalogPlaceholder')} className="input-field mb-2" />
                <div className="border border-[#dcd8d4] max-h-64 overflow-y-auto">
                  {kitItemResults.map((p) => {
                    const picked = kitItems.find((r) => r.product_id === p.id)
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[#e2ded9] last:border-b-0">
                        <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                          <input type="checkbox" checked={!!picked} onChange={() => toggleKitItem(p.id)} style={{ accentColor: ACCENT }} />
                          <span className="font-sans text-[13px] truncate" style={{ color: INK }}>{productDisplayName(p, isUrdu)}</span>
                        </label>
                        {picked && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => setKitItemQty(p.id, picked.quantity - 1)} className="w-6 h-6 border border-[#dcd8d4] flex items-center justify-center cursor-pointer text-[12px]">−</button>
                            <span className="w-5 text-center font-sans text-[12.5px] font-bold ltr-num" style={{ color: INK }}>{picked.quantity}</span>
                            <button onClick={() => setKitItemQty(p.id, picked.quantity + 1)} className="w-6 h-6 border border-[#dcd8d4] flex items-center justify-center cursor-pointer text-[12px]">+</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {kitItemResults.length === 0 && <p className="text-center py-6 text-[#7a736d] font-sans text-[13px]">{t('mp.noResults')}</p>}
                </div>
              </div>

              <button onClick={saveKit} disabled={savingKit} className="w-full text-white py-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: ACCENT }} onMouseEnter={(e) => !savingKit && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>{savingKit ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

      {showDeals && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowDeals(false)}>
          <div className="bg-white p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold flex items-center gap-2" style={{ color: INK }}><Tag size={18} /> {t('sk.dealsBtn')}</h2>
              <button onClick={() => setShowDeals(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <button onClick={() => { setShowDeals(false); openNewDeal() }} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-2 border-dashed font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-[#f7f6f5] transition-all mb-4" style={{ borderColor: '#dcd8d4', color: ACCENT }}>
              <PlusCircle size={16} /> {t('sk.newDealBtn')}
            </button>
            {deals.length === 0 ? (
              <p className="text-center py-8 text-[#7a736d] font-sans text-[13.5px]">{t('sk.noDealsYet')}</p>
            ) : (
              <div className="space-y-2">
                {deals.map((d) => {
                  const base = d.shop_deal_items.reduce((s, i) => { const p = products.find((x) => x.id === i.product_id); return s + (p ? p.unit_price_pkr * i.quantity : 0) }, 0)
                  const final = dealFinalPrice(base, d.discount_kind, d.discount_value)
                  const expired = new Date(d.expires_at).getTime() < now
                  return (
                    <div key={d.id} className="bg-white border border-[#dcd8d4] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-sans text-[14px] font-semibold truncate" style={{ color: INK }}>{isUrdu && d.name_ur ? d.name_ur : d.name}</p>
                          <p className="font-sans text-[11.5px] text-[#7a736d] mt-0.5"><span className="line-through">{fmt(base)}</span> → <span className="font-bold ltr-num" style={{ color: ACCENT_DARK }}>{fmt(final)}</span> {expired && `· ${t('sk.dealExpiredTag')}`}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => { setShowDeals(false); openEditDeal(d) }} className="p-1.5 cursor-pointer" style={{ color: INK }}><Pencil size={14} /></button>
                          <button onClick={() => removeDeal(d)} disabled={deletingDealId === d.id} className="p-1.5 cursor-pointer disabled:opacity-50" style={{ color: ACCENT }}><Trash2 size={14} /></button>
                        </div>
                      </div>
                      <button onClick={() => toggleDealActive(d)} className="mt-2 px-2.5 py-1 border font-sans text-[11px] font-semibold cursor-pointer" style={d.is_active ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: '#7a736d' }}>
                        {d.is_active ? t('sk.dealOnLabel') : t('sk.dealOffLabel')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Deal builder — same shape as the kit builder, plus a discount
          type/value and a "valid for N days" picker (Shop Portal v3's own
          "S · deals" NEW DEAL card). */}
      {showDealBuilder && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowDealBuilder(false)}>
          <div className="bg-white p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold" style={{ color: INK }}>{editingDeal ? t('sk.editDealTitle') : t('sk.newDealBtn')}</h2>
              <button onClick={() => setShowDealBuilder(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input value={dealForm.name} onChange={(e) => setDealForm({ ...dealForm, name: e.target.value })} placeholder={t('sk.dealNamePlaceholder')} className="input-field" />
              <input value={dealForm.name_ur} onChange={(e) => setDealForm({ ...dealForm, name_ur: e.target.value })} placeholder={t('sk.dealNameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <input value={dealForm.sub} onChange={(e) => setDealForm({ ...dealForm, sub: e.target.value })} placeholder={t('sk.dealSubPlaceholder')} className="input-field" />
              <input value={dealForm.sub_ur} onChange={(e) => setDealForm({ ...dealForm, sub_ur: e.target.value })} placeholder={t('sk.dealSubUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1.5">{t('sk.kitCardLookLabel')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['accent', 'ink', 'photo'] as const).map((tint) => (
                    <button key={tint} type="button" onClick={() => setDealForm({ ...dealForm, tint })}
                      className="px-3 py-2 border font-sans text-[12.5px] font-semibold cursor-pointer transition-colors"
                      style={dealForm.tint === tint ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: INK }}>
                      {tint === 'accent' ? t('sk.kitTintAccent') : tint === 'ink' ? t('sk.kitTintInk') : t('sk.kitTintPhoto')}
                    </button>
                  ))}
                </div>
              </div>
              {dealForm.tint === 'photo' && (
                <ImageUpload bucket="images" label={t('sk.kitPhotoLabel')} currentUrl={dealForm.photo_url} onUpload={(url) => setDealForm({ ...dealForm, photo_url: url })} />
              )}

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1.5">{t('sk.discountTypeLabel')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['percent', 'amount', 'fixed_price'] as const).map((kind) => (
                    <button key={kind} type="button" onClick={() => setDealForm({ ...dealForm, discount_kind: kind })}
                      className="px-2 py-2 border font-sans text-[11.5px] font-semibold cursor-pointer transition-colors"
                      style={dealForm.discount_kind === kind ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: INK }}>
                      {kind === 'percent' ? t('sk.discountPercent') : kind === 'amount' ? t('sk.discountAmount') : t('sk.discountFixedPrice')}
                    </button>
                  ))}
                </div>
                <input type="number" inputMode="decimal" value={dealForm.discount_value}
                  onChange={(e) => setDealForm({ ...dealForm, discount_value: e.target.value === '' ? '' : Number(e.target.value) })}
                  placeholder={dealForm.discount_kind === 'percent' ? '%' : 'Rs'} className="input-field mt-2" />
              </div>

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f] mb-1.5">{t('sk.dealValidForLabel')}</label>
                <div className="flex items-center gap-2 flex-wrap">
                  {[3, 7, 15, 30].map((d) => (
                    <button key={d} type="button" onClick={() => setDealForm({ ...dealForm, valid_days: d })}
                      className="px-3 py-1.5 border font-sans text-[12px] font-semibold cursor-pointer ltr-num"
                      style={dealForm.valid_days === d ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : { borderColor: '#dcd8d4', color: INK }}>
                      {d} {t('sk.daysSuffix')}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block font-sans text-[12.5px] font-semibold text-[#5b544f]">{t('sk.kitItemsLabel')}</label>
                  <span className="font-sans text-[11.5px] text-[#7a736d]">
                    <span className="line-through">{fmt(dealBaseTotal)}</span> → <span className="font-bold ltr-num" style={{ color: ACCENT_DARK }}>{fmt(dealFinalTotal)}</span>
                  </span>
                </div>
                <input value={dealItemSearch} onChange={(e) => setDealItemSearch(e.target.value)} placeholder={t('sk.searchOwnCatalogPlaceholder')} className="input-field mb-2" />
                <div className="border border-[#dcd8d4] max-h-64 overflow-y-auto">
                  {dealItemResults.map((p) => {
                    const picked = dealItems.find((r) => r.product_id === p.id)
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[#e2ded9] last:border-b-0">
                        <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                          <input type="checkbox" checked={!!picked} onChange={() => toggleDealItem(p.id)} style={{ accentColor: ACCENT }} />
                          <span className="font-sans text-[13px] truncate" style={{ color: INK }}>{productDisplayName(p, isUrdu)}</span>
                        </label>
                        {picked && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => setDealItemQty(p.id, picked.quantity - 1)} className="w-6 h-6 border border-[#dcd8d4] flex items-center justify-center cursor-pointer text-[12px]">−</button>
                            <span className="w-5 text-center font-sans text-[12.5px] font-bold ltr-num" style={{ color: INK }}>{picked.quantity}</span>
                            <button onClick={() => setDealItemQty(p.id, picked.quantity + 1)} className="w-6 h-6 border border-[#dcd8d4] flex items-center justify-center cursor-pointer text-[12px]">+</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {dealItemResults.length === 0 && <p className="text-center py-6 text-[#7a736d] font-sans text-[13px]">{t('mp.noResults')}</p>}
                </div>
              </div>

              <button onClick={saveDeal} disabled={savingDeal} className="w-full text-white py-3 font-sans font-semibold cursor-pointer transition-all disabled:opacity-50" style={{ background: ACCENT }} onMouseEnter={(e) => !savingDeal && (e.currentTarget.style.background = ACCENT_DARK)} onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}>{savingDeal ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
