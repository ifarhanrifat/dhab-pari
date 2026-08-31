'use client'

// Marketplace phase 2 — admin catalog CRUD for shops + their products. A
// shop is staff-listed (an owner asks the committee to be listed, same
// pattern as a donor being entered by an accountant) — this page only
// manages the catalog itself; orders/checkout land in phase 3 once
// place_shop_order()/confirm_shop_order() exist. Follows the exact
// two-level pattern academy-fees/page.tsx already established: a parent
// grid, one `selected` piece of state switching between grid and detail
// panel (no separate route), everything else lives in modals.

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Store, PlusCircle, X, Pencil, Trash2, Truck, PackageX, CheckCircle2, XCircle, Clock, PauseCircle, PlayCircle, ListPlus } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { SHOP_TYPES, getCategoryLabel } from '@/lib/shopTypes'
import { DynamicIcon } from '@/components/shared/DynamicIcon'
import { OrderFulfillmentPanel } from '@/components/shared/OrderFulfillmentPanel'
import { CategoryBrowser, CategoryPicker } from '@/components/shared/CategoryBrowser'
import { ProductCatalogPicker } from '@/components/shared/ProductCatalogPicker'
import type { CatalogItem } from '@/lib/productCatalog'

interface Shop {
  id: string; name: string; name_ur: string | null; description: string | null; description_ur: string | null
  owner_name: string | null; owner_mobile: string | null; owner_whatsapp: string | null
  location: string | null; location_ur: string | null; delivery_enabled: boolean; status: string; portal_user_id: string | null
  commission_mode: string; lumpsum_fee_pkr: number | null; primary_type: string
}
interface LumpsumCharge { id: string; period: string; amount_pkr: number; created_at: string }
interface WalletTopup { id: string; amount_pkr: number; status: string; announced_method: string; announced_at: string; rejected_reason: string | null }
interface Product {
  id: string; shop_id: string; name: string; name_ur: string | null; description: string | null; description_ur: string | null
  company: string | null; category: string | null; flavor: string | null; flavor_ur: string | null; cost_price_pkr: number
  unit_price_pkr: number; quantity_on_hand: number; expiry_date: string | null; is_active: boolean
}

interface Order {
  id: string; status: string; total_amount_pkr: number; announced_method: string | null; announced_at: string | null; rejected_reason: string | null
  fulfillment_status: string; delivery_address: string | null; buyer_mobile: string | null
  shop_order_items: { quantity: number; shop_products: { name: string; name_ur: string | null; flavor: string | null; flavor_ur: string | null } | null }[]
}

const emptyShop = {
  name: '', name_ur: '', description: '', description_ur: '', owner_name: '', owner_mobile: '', owner_whatsapp: '',
  location: '', location_ur: '', delivery_enabled: false, status: 'active', portal_user_id: null as string | null,
  commission_mode: 'per_order' as string, lumpsum_fee_pkr: 0, primary_type: 'general_store' as string,
}
const emptyProduct = {
  name: '', name_ur: '', description: '', description_ur: '', company: '', category: 'other' as string, flavor: '', flavor_ur: '',
  cost_price_pkr: 0, unit_price_pkr: 0, quantity_on_hand: 0, expiry_date: '', is_active: true,
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// Within 7 days matches the reminder cron's own window (phase 6) — the
// same threshold shown here so what an accountant sees lines up with what
// eventually pings them.
function expiryTone(dateStr: string | null): 'ok' | 'soon' | 'expired' | null {
  if (!dateStr) return null
  const days = (new Date(dateStr).getTime() - Date.now()) / 86400000
  if (days < 0) return 'expired'
  if (days <= 7) return 'soon'
  return 'ok'
}

export default function AdminShopsPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <AdminShopsInner />
    </Suspense>
  )
}

function AdminShopsInner() {
  const { t, isUrdu } = useLocale()
  const searchParams = useSearchParams()
  const access = useSystemAccess()
  const supabase = createClient()

  const [shops, setShops] = useState<Shop[]>([])
  const [productCountByShop, setProductCountByShop] = useState<Record<string, number>>({})
  const [expiringCountByShop, setExpiringCountByShop] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Shop | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [coverByProduct, setCoverByProduct] = useState<Record<string, string>>({})
  const [orders, setOrders] = useState<Order[]>([])
  const [orderActionId, setOrderActionId] = useState<string | null>(null)
  const [charges, setCharges] = useState<LumpsumCharge[]>([])
  const [topups, setTopups] = useState<WalletTopup[]>([])
  const [topupActionId, setTopupActionId] = useState<string | null>(null)

  const [showShopForm, setShowShopForm] = useState(false)
  const [editingShop, setEditingShop] = useState<Shop | null>(null)
  const [shopForm, setShopForm] = useState(emptyShop)

  const [showProductForm, setShowProductForm] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [productForm, setProductForm] = useState(emptyProduct)
  const [productCoverUrl, setProductCoverUrl] = useState('')

  const [saving, setSaving] = useState(false)
  const [changingCategory, setChangingCategory] = useState(false)
  const [showCatalogPicker, setShowCatalogPicker] = useState(false)
  const [keeperMobile, setKeeperMobile] = useState('')
  const [keeperName, setKeeperName] = useState<string | null>(null)
  const [linkingKeeper, setLinkingKeeper] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data } = await supabase.from('shops').select('*').order('name')
    setShops(data ?? [])
    if (data && data.length > 0) {
      const { data: allProducts } = await supabase.from('shop_products').select('id, shop_id, expiry_date').in('shop_id', data.map((s) => s.id))
      const counts: Record<string, number> = {}
      const expiring: Record<string, number> = {}
      for (const p of allProducts ?? []) {
        counts[p.shop_id] = (counts[p.shop_id] ?? 0) + 1
        if (expiryTone(p.expiry_date) === 'soon' || expiryTone(p.expiry_date) === 'expired') {
          expiring[p.shop_id] = (expiring[p.shop_id] ?? 0) + 1
        }
      }
      setProductCountByShop(counts)
      setExpiringCountByShop(expiring)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    const shopParam = searchParams.get('shop')
    if (!shopParam || shops.length === 0) return
    const s = shops.find((x) => x.id === shopParam)
    if (s) openShop(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops.length, searchParams])

  const loadProducts = async (shopId: string) => {
    const { data } = await supabase.from('shop_products').select('*').eq('shop_id', shopId).order('name')
    setProducts(data ?? [])
    if (data && data.length > 0) {
      const { data: media } = await supabase.from('product_media').select('product_id, url').eq('is_cover', true).in('product_id', data.map((p) => p.id))
      setCoverByProduct(Object.fromEntries((media ?? []).map((m) => [m.product_id, m.url])))
    } else {
      setCoverByProduct({})
    }
  }

  const loadOrders = async (shopId: string) => {
    const { data } = await supabase.from('shop_orders')
      .select('id, status, total_amount_pkr, announced_method, announced_at, rejected_reason, fulfillment_status, delivery_address, buyer_mobile, shop_order_items(quantity, shop_products(name, name_ur, flavor, flavor_ur))')
      .eq('shop_id', shopId).order('created_at', { ascending: false })
    setOrders((data ?? []) as unknown as Order[])
  }

  const loadCharges = async (shopId: string) => {
    const { data } = await supabase.from('shop_lumpsum_charges').select('id, period, amount_pkr, created_at').eq('shop_id', shopId).order('period', { ascending: false })
    setCharges(data ?? [])
  }
  const loadTopups = async (shopId: string) => {
    const { data } = await supabase.from('shop_wallet_topups').select('id, amount_pkr, status, announced_method, announced_at, rejected_reason').eq('shop_id', shopId).order('announced_at', { ascending: false })
    setTopups(data ?? [])
  }

  const openShop = (s: Shop) => { setSelected(s); loadProducts(s.id); loadOrders(s.id); loadCharges(s.id); loadTopups(s.id) }

  const confirmTopup = async (id: string) => {
    setTopupActionId(id)
    const { error } = await supabase.rpc('confirm_shop_wallet_topup', { p_topup_id: id })
    setTopupActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.topupConfirmedToast'))
    if (selected) loadTopups(selected.id)
  }
  const rejectTopup = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setTopupActionId(id)
    const { error } = await supabase.rpc('reject_shop_wallet_topup', { p_topup_id: id, p_reason: reason || null })
    setTopupActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.topupRejectedToast'))
    if (selected) loadTopups(selected.id)
  }

  const confirmOrder = async (o: Order) => {
    setOrderActionId(o.id)
    const { error } = await supabase.rpc('confirm_shop_order', { p_order_id: o.id })
    setOrderActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.orderConfirmedToast'))
    if (selected) { loadOrders(selected.id); loadProducts(selected.id) }
  }

  const rejectOrder = async (o: Order) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setOrderActionId(o.id)
    const { error } = await supabase.rpc('reject_shop_order', { p_order_id: o.id, p_reason: reason || null })
    setOrderActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.orderRejectedToast'))
    if (selected) { loadOrders(selected.id); loadProducts(selected.id) }
  }

  const openNewShop = () => { setEditingShop(null); setShopForm(emptyShop); setKeeperMobile(''); setKeeperName(null); setShowShopForm(true) }
  const openEditShop = (s: Shop) => {
    setEditingShop(s)
    setShopForm({
      name: s.name, name_ur: s.name_ur ?? '', description: s.description ?? '', description_ur: s.description_ur ?? '',
      owner_name: s.owner_name ?? '', owner_mobile: s.owner_mobile ?? '', owner_whatsapp: s.owner_whatsapp ?? '',
      location: s.location ?? '', location_ur: s.location_ur ?? '', delivery_enabled: s.delivery_enabled, status: s.status,
      portal_user_id: s.portal_user_id, commission_mode: s.commission_mode, lumpsum_fee_pkr: s.lumpsum_fee_pkr ?? 0,
      primary_type: s.primary_type ?? 'general_store',
    })
    setKeeperMobile('')
    if (s.portal_user_id) {
      supabase.from('portal_users').select('full_name, mobile').eq('id', s.portal_user_id).maybeSingle()
        .then(({ data }) => setKeeperName(data ? `${data.full_name} (${data.mobile})` : null))
    } else setKeeperName(null)
    setShowShopForm(true)
  }

  // Finds a portal account by mobile and links it as this shop's
  // self-service keeper (shops.portal_user_id, migration 391). Persists
  // immediately for a shop that already exists — this used to only touch
  // local form state, so a "found" keeper looked linked in the UI but
  // silently never made it to the database unless the whole shop form
  // was separately saved afterward. A portal account can only manage one
  // shop at a time (unique index, migration 406) — checked here first so
  // the error names the other shop instead of a raw constraint failure.
  const findKeeper = async () => {
    const mobile = keeperMobile.trim()
    if (!mobile) return
    setLinkingKeeper(true)
    const { data } = await supabase.from('portal_users').select('id, full_name, mobile').eq('mobile', mobile).eq('is_active', true).maybeSingle()
    if (!data) { setLinkingKeeper(false); toast.error(t('sk.keeperNotFound')); return }

    const { data: existingLink } = await supabase.from('shops').select('id, name').eq('portal_user_id', data.id).maybeSingle()
    if (existingLink && existingLink.id !== editingShop?.id) {
      setLinkingKeeper(false)
      toast.error(t('sk.keeperAlreadyLinkedElsewhere').replace('{shop}', existingLink.name))
      return
    }

    if (editingShop) {
      const { error } = await supabase.from('shops').update({ portal_user_id: data.id }).eq('id', editingShop.id)
      setLinkingKeeper(false)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('sk.keeperLinkedToast'))
      load()
    } else {
      setLinkingKeeper(false)
    }
    setShopForm({ ...shopForm, portal_user_id: data.id })
    setKeeperName(`${data.full_name} (${data.mobile})`)
    setKeeperMobile('')
  }
  const unlinkKeeper = async () => {
    setShopForm({ ...shopForm, portal_user_id: null }); setKeeperName(null)
    if (!editingShop) return
    const { error } = await supabase.from('shops').update({ portal_user_id: null }).eq('id', editingShop.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.keeperUnlinkedToast'))
    load()
  }

  const saveShop = async () => {
    if (!shopForm.name.trim()) { toast.error(t('mk.nameRequired')); return }
    setSaving(true)
    const payload = {
      ...shopForm, name_ur: shopForm.name_ur || null, description: shopForm.description || null, description_ur: shopForm.description_ur || null,
      owner_name: shopForm.owner_name || null, owner_mobile: shopForm.owner_mobile || null, owner_whatsapp: shopForm.owner_whatsapp || null,
      location: shopForm.location || null, location_ur: shopForm.location_ur || null,
      lumpsum_fee_pkr: shopForm.commission_mode === 'monthly_lumpsum' ? shopForm.lumpsum_fee_pkr : null,
    }
    const { error } = editingShop
      ? await supabase.from('shops').update(payload).eq('id', editingShop.id)
      : await supabase.from('shops').insert(payload)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.shopSaved'))
    setShowShopForm(false)
    load()
    if (selected && editingShop) setSelected({ ...selected, ...payload })
  }

  const deleteShop = async (s: Shop) => {
    // The shop's clearing account (accounts.shop_id) cascades ON DELETE to
    // ledger_entries (migrations 007/388) — hard-deleting a shop that has
    // ever posted real ledger legs would blow a hole in the double-entry
    // ledger (the matching leg on cash/bank etc. would be left dangling,
    // out of balance). Any shop with ledger history can only be paused;
    // only a shop that never posted anything can actually be deleted.
    const { data: acct } = await supabase.from('accounts').select('id').eq('shop_id', s.id).maybeSingle()
    if (acct) {
      const { count } = await supabase.from('ledger_entries').select('id', { count: 'exact', head: true }).eq('account_id', acct.id)
      if ((count ?? 0) > 0) { toast.error(t('cm.cannotDeleteShopHasHistory')); return }
    }
    if (!confirm(t('mk.confirmDeleteShop'))) return
    const { error } = await supabase.from('shops').delete().eq('id', s.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.shopDeleted'))
    if (selected?.id === s.id) setSelected(null)
    load()
  }

  // One-tap pause/reactivate — same status field the edit form already
  // has, just without needing to open the whole form for it. A paused
  // shop stops showing up in customer search/browse (public read policy
  // is unaffected either way — status='active' is what every browse
  // query already filters on) but its history/products stay intact.
  const toggleShopStatus = async (s: Shop) => {
    const newStatus = s.status === 'active' ? 'inactive' : 'active'
    const { error } = await supabase.from('shops').update({ status: newStatus }).eq('id', s.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(newStatus === 'active' ? t('cm.shopReactivatedToast') : t('cm.shopPausedToast'))
    if (selected?.id === s.id) setSelected({ ...selected, status: newStatus })
    load()
  }

  const openNewProduct = (categorySlug: string) => { setEditingProduct(null); setProductForm({ ...emptyProduct, category: categorySlug }); setProductCoverUrl(''); setChangingCategory(false); setShowProductForm(true) }
  const openEditProduct = (p: Product) => {
    setEditingProduct(p)
    setProductForm({
      name: p.name, name_ur: p.name_ur ?? '', description: p.description ?? '', description_ur: p.description_ur ?? '',
      company: p.company ?? '', category: p.category ?? 'other', flavor: p.flavor ?? '', flavor_ur: p.flavor_ur ?? '',
      cost_price_pkr: p.cost_price_pkr,
      unit_price_pkr: p.unit_price_pkr, quantity_on_hand: p.quantity_on_hand, expiry_date: p.expiry_date ?? '', is_active: p.is_active,
    })
    setProductCoverUrl(coverByProduct[p.id] ?? '')
    setChangingCategory(false)
    setShowProductForm(true)
  }

  // Third add path, same as portal/my-shop: pick a real brand + item from
  // the catalog instead of typing it in — pre-fills name/company/flavor/
  // category, price/stock/photo still left to whoever's entering it.
  const openProductFromCatalog = (brandName: string, item: CatalogItem) => {
    setEditingProduct(null)
    setProductForm({ ...emptyProduct, name: item.name, company: brandName, flavor: item.flavor ?? '', category: item.category })
    setProductCoverUrl('')
    setChangingCategory(false)
    setShowCatalogPicker(false)
    setShowProductForm(true)
  }

  const saveProduct = async () => {
    if (!selected || !productForm.name.trim()) { toast.error(t('mk.nameRequired')); return }
    setSaving(true)
    const payload = {
      shop_id: selected.id, name: productForm.name, name_ur: productForm.name_ur || null,
      description: productForm.description || null, description_ur: productForm.description_ur || null,
      company: productForm.company || null, category: productForm.category || null,
      flavor: productForm.flavor || null, flavor_ur: productForm.flavor_ur || null,
      cost_price_pkr: productForm.cost_price_pkr, unit_price_pkr: productForm.unit_price_pkr, quantity_on_hand: productForm.quantity_on_hand,
      expiry_date: productForm.expiry_date || null, is_active: productForm.is_active,
    }
    let productId = editingProduct?.id
    const { data, error } = editingProduct
      ? await supabase.from('shop_products').update(payload).eq('id', editingProduct.id).select('id').single()
      : await supabase.from('shop_products').insert(payload).select('id').single()
    if (error) { toast.error(friendlyError(error)); setSaving(false); return }
    productId = data.id

    if (productCoverUrl) {
      await supabase.from('product_media').update({ is_cover: false }).eq('product_id', productId).eq('is_cover', true)
      const { data: existing } = await supabase.from('product_media').select('id').eq('product_id', productId).eq('url', productCoverUrl).maybeSingle()
      if (existing) await supabase.from('product_media').update({ is_cover: true }).eq('id', existing.id)
      else await supabase.from('product_media').insert({ product_id: productId, url: productCoverUrl, is_cover: true })
    }

    setSaving(false)
    toast.success(t('mk.productSaved'))
    setShowProductForm(false)
    loadProducts(selected.id)
    load()
  }

  const deleteProduct = async (p: Product) => {
    if (!confirm(t('mk.confirmDeleteProduct'))) return
    const { error } = await supabase.from('shop_products').delete().eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.productDeleted'))
    if (selected) loadProducts(selected.id)
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('dn.noAccessMessage')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      {!selected ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
            <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2"><Store size={24} /> {t('mk.shopsTitle')}</h1>
            <button onClick={openNewShop} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('mk.newShopBtn')}</button>
          </div>

          {loading && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('action.loading')}</p>}
          {!loading && shops.length === 0 && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('mk.noShopsYet')}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {shops.map((s) => (
              <button key={s.id} onClick={() => openShop(s)} className="text-start bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-colors cursor-pointer">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex items-start gap-2">
                    <div className="shrink-0 w-8 h-8 rounded-lg bg-dp-secondary-container/50 text-dp-secondary flex items-center justify-center mt-0.5">
                      <DynamicIcon name={SHOP_TYPES.find((st) => st.slug === s.primary_type)?.icon ?? 'Store'} size={16} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-sans text-[15px] font-bold text-dp-on-surface truncate">{isUrdu && s.name_ur ? s.name_ur : s.name}</p>
                      {s.location && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{isUrdu ? (s.location_ur || s.location) : s.location}</p>}
                    </div>
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${s.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                    {s.status === 'active' ? t('mk.active') : t('mk.inactive')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-3">
                  {s.delivery_enabled ? (
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700"><Truck size={11} /> {t('mk.deliveryEnabled')}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('mk.pickupOnly')}</span>
                  )}
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{productCountByShop[s.id] ?? 0} {t('mk.productsCount')}</span>
                  {s.commission_mode === 'monthly_lumpsum' && (
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">{t('cm.lumpsumBadge')}</span>
                  )}
                  {(expiringCountByShop[s.id] ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800"><PackageX size={11} /> {expiringCountByShop[s.id]} {t('mk.expiringSoon')}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
            <div>
              <button onClick={() => setSelected(null)} className="font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer mb-1">{t('mk.backToShops')}</button>
              <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary">{isUrdu && selected.name_ur ? selected.name_ur : selected.name}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => openEditShop(selected)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container"><Pencil size={14} /> {t('mk.editShopBtn')}</button>
              <button
                onClick={() => toggleShopStatus(selected)}
                className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container"
              >
                {selected.status === 'active' ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                {selected.status === 'active' ? t('cm.pauseShopBtn') : t('cm.reactivateShopBtn')}
              </button>
              <button onClick={() => deleteShop(selected)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-error cursor-pointer hover:bg-red-50"><Trash2 size={14} /> {t('cm.deleteShopBtn')}</button>
              <button onClick={() => setShowCatalogPicker(true)} className="flex items-center gap-1.5 px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><ListPlus size={14} /> {t('pc.pickFromCatalogBtn')}</button>
            </div>
          </div>

          <CategoryBrowser
            primaryType={selected.primary_type}
            products={products}
            onAddItem={openNewProduct}
            renderProduct={(p) => {
              const tone = expiryTone(p.expiry_date)
              return (
                <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                  <div className="h-32 bg-dp-surface-container relative">
                    {coverByProduct[p.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={coverByProduct[p.id]} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-dp-on-surface-variant/40"><Store size={28} /></div>
                    )}
                  </div>
                  <div className="p-3">
                    <p className="font-sans text-[14px] font-semibold text-dp-on-surface truncate">
                      {isUrdu && p.name_ur ? p.name_ur : p.name}
                      {(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && <span className="font-normal text-dp-on-surface-variant"> ({isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})</span>}
                    </p>
                    <p className="font-sans text-[15px] font-bold text-dp-secondary mt-0.5">{fmt(p.unit_price_pkr)}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('mk.stockLabel')} {fmt(p.quantity_on_hand)}</p>
                    {tone && (
                      <span className={`inline-block mt-1.5 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tone === 'expired' ? 'bg-red-100 text-red-700' : tone === 'soon' ? 'bg-amber-100 text-amber-800' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                        {tone === 'expired' ? t('mk.expiredBadge') : tone === 'soon' ? t('mk.expiringSoonBadge') : t('mk.expiryLabel')} {new Date(p.expiry_date!).toLocaleDateString('en-GB')}
                      </span>
                    )}
                    {!p.is_active && <span className="inline-block mt-1.5 ms-1.5 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('mk.inactive')}</span>}
                    <div className="flex items-center gap-1 mt-2 pt-2 border-t border-dp-outline-variant/60">
                      <button onClick={() => openEditProduct(p)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={14} /></button>
                      <button onClick={() => deleteProduct(p)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                    </div>
                  </div>
                </div>
              )
            }}
          />

          {orders.length > 0 && (
            <div className="mt-8">
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.ordersHeading')}</p>
              <div className="space-y-2">
                {orders.map((o) => (
                  <div key={o.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {o.shop_order_items.map((it, i) => {
                          const pName = isUrdu && it.shop_products?.name_ur ? it.shop_products.name_ur : it.shop_products?.name ?? '—'
                          const pFlavor = isUrdu ? (it.shop_products?.flavor_ur || it.shop_products?.flavor) : it.shop_products?.flavor
                          return (
                            <p key={i} className="font-sans text-[13px] text-dp-on-surface truncate">
                              {pName}{pFlavor && ` (${pFlavor})`} × <span className="ltr-num">{it.quantity}</span>
                            </p>
                          )
                        })}
                      </div>
                      <p className="font-sans text-[14px] font-bold text-dp-secondary shrink-0">{fmt(o.total_amount_pkr)}</p>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                      {o.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={12} /> {t('mp.confirmedStatus')}</span>}
                      {o.status === 'rejected' && <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold" title={o.rejected_reason ?? undefined}><XCircle size={12} /> {t('mp.rejectedStatus')}</span>}
                      {o.status === 'announced' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={12} /> {t('mp.awaitingStatus')}</span>}
                      {o.status === 'announced' && (
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => rejectOrder(o)} disabled={orderActionId === o.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                          <button onClick={() => confirmOrder(o)} disabled={orderActionId === o.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('mp.confirmBtn')}</button>
                        </div>
                      )}
                    </div>
                    <OrderFulfillmentPanel order={o} onChanged={() => loadOrders(selected.id)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {topups.filter((tp) => tp.status === 'announced').length > 0 && (
            <div className="mt-8">
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.topupsHeading')}</p>
              <div className="space-y-2">
                {topups.filter((tp) => tp.status === 'announced').map((tp) => (
                  <div key={tp.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5">
                    <p className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(tp.amount_pkr)}</p>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => rejectTopup(tp.id)} disabled={topupActionId === tp.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                      <button onClick={() => confirmTopup(tp.id)} disabled={topupActionId === tp.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('mp.confirmBtn')}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selected.commission_mode === 'monthly_lumpsum' && (
            <div className="mt-8">
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.chargeHistoryHeading')}</p>
              {charges.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('cm.noChargesYet')}</p>}
              <div className="space-y-1.5">
                {charges.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg px-3.5 py-2.5">
                    <p className="font-sans text-[13px] text-dp-on-surface">{c.period}</p>
                    <p className="font-sans text-[13.5px] font-bold text-dp-secondary">{fmt(c.amount_pkr)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {showShopForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowShopForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingShop ? t('mk.editShopBtn') : t('mk.newShopBtn')}</h2>
              <button onClick={() => setShowShopForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('cm.shopTypeLabel')}</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {SHOP_TYPES.map((st) => (
                    <button key={st.slug} type="button" onClick={() => setShopForm({ ...shopForm, primary_type: st.slug })}
                      className={`flex flex-col items-center gap-1 py-2.5 px-1 rounded-lg text-[11px] font-sans font-semibold cursor-pointer transition-all text-center ${shopForm.primary_type === st.slug ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant hover:bg-dp-surface-container-high'}`}>
                      <DynamicIcon name={st.icon} size={18} />
                      <span className="leading-tight">{isUrdu ? st.label_ur : st.label}</span>
                    </button>
                  ))}
                </div>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('cm.shopTypeHint')}</p>
              </div>
              <input value={shopForm.name} onChange={(e) => setShopForm({ ...shopForm, name: e.target.value })} placeholder={t('mk.shopNamePlaceholder')} className="input-field" />
              <input value={shopForm.name_ur} onChange={(e) => setShopForm({ ...shopForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <textarea value={shopForm.description} onChange={(e) => setShopForm({ ...shopForm, description: e.target.value })} rows={2} placeholder={t('a.notesOptional')} className="input-field resize-none" />
              <textarea value={shopForm.description_ur} onChange={(e) => setShopForm({ ...shopForm, description_ur: e.target.value })} rows={2} placeholder={t('mk.descriptionUrPlaceholder')} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <div className="grid grid-cols-2 gap-3">
                <input value={shopForm.owner_name} onChange={(e) => setShopForm({ ...shopForm, owner_name: e.target.value })} placeholder={t('mk.ownerNamePlaceholder')} className="input-field" />
                <input value={shopForm.owner_mobile} onChange={(e) => setShopForm({ ...shopForm, owner_mobile: e.target.value })} placeholder={t('a.phone')} className="input-field" />
              </div>
              <input value={shopForm.owner_whatsapp} onChange={(e) => setShopForm({ ...shopForm, owner_whatsapp: e.target.value })} placeholder={t('w.whatsapp')} className="input-field" />
              <div className="grid grid-cols-2 gap-3">
                <input value={shopForm.location} onChange={(e) => setShopForm({ ...shopForm, location: e.target.value })} placeholder={t('z.location')} className="input-field" />
                <input value={shopForm.location_ur} onChange={(e) => setShopForm({ ...shopForm, location_ur: e.target.value })} placeholder={t('pj.locationUr')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              </div>
              <select value={shopForm.status} onChange={(e) => setShopForm({ ...shopForm, status: e.target.value })} className="input-field">
                <option value="active">{t('mk.active')}</option>
                <option value="inactive">{t('mk.inactive')}</option>
              </select>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={shopForm.delivery_enabled} onChange={(e) => setShopForm({ ...shopForm, delivery_enabled: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('mk.deliveryEnabledLabel')}</span></label>
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('mk.deliveryHint')}</p>

              <div className="pt-2 border-t border-dp-outline-variant/60">
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.modeLabel')}</label>
                <select value={shopForm.commission_mode} onChange={(e) => setShopForm({ ...shopForm, commission_mode: e.target.value })} className="input-field">
                  <option value="per_order">{t('cm.perOrderOption')}</option>
                  <option value="monthly_lumpsum">{t('cm.lumpsumOption')}</option>
                </select>
                {shopForm.commission_mode === 'per_order' ? (
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('cm.perOrderHint')}</p>
                ) : (
                  <>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('cm.lumpsumHint')}</p>
                    <div className="mt-2">
                      <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.lumpsumFeeLabel')}</label>
                      <input type="number" value={shopForm.lumpsum_fee_pkr || ''} onChange={(e) => setShopForm({ ...shopForm, lumpsum_fee_pkr: +e.target.value })} className="input-field" placeholder="0" />
                    </div>
                  </>
                )}
              </div>

              <div className="pt-2 border-t border-dp-outline-variant/60">
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('sk.keeperLinkLabel')}</label>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2">{t('sk.keeperLinkHint')}</p>
                {keeperName ? (
                  <div className="flex items-center justify-between gap-2 bg-dp-secondary-container/40 rounded-lg px-3 py-2">
                    <span className="font-sans text-[13px] text-dp-on-surface truncate">{keeperName}</span>
                    <button onClick={unlinkKeeper} className="font-sans text-[12px] font-semibold text-dp-error cursor-pointer shrink-0">{t('g.remove')}</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input value={keeperMobile} onChange={(e) => setKeeperMobile(e.target.value)} placeholder={t('sk.keeperMobilePlaceholder')} className="input-field" dir="ltr" />
                    <button onClick={findKeeper} disabled={linkingKeeper} className="shrink-0 px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container disabled:opacity-50">{t('sk.linkBtn')}</button>
                  </div>
                )}
              </div>

              <button onClick={saveShop} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

      {showProductForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowProductForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingProduct ? t('mk.editProductBtn') : t('mk.newProductBtn')}</h2>
              <button onClick={() => setShowProductForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <ImageUpload bucket="images" label={t('mk.productPhoto')} currentUrl={productCoverUrl} onUpload={setProductCoverUrl} />
              <input value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} placeholder={t('mk.productNamePlaceholder')} className="input-field" />
              <input value={productForm.name_ur} onChange={(e) => setProductForm({ ...productForm, name_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <textarea value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} rows={2} placeholder={t('a.notesOptional')} className="input-field resize-none" />
              <div className="grid grid-cols-2 gap-3">
                <input value={productForm.company} onChange={(e) => setProductForm({ ...productForm, company: e.target.value })} placeholder={t('sk.companyPlaceholder')} className="input-field" />
                <div className="grid grid-cols-2 gap-3">
                  <input value={productForm.flavor} onChange={(e) => setProductForm({ ...productForm, flavor: e.target.value })} placeholder={t('sk.flavorPlaceholder')} className="input-field" />
                  <input value={productForm.flavor_ur} onChange={(e) => setProductForm({ ...productForm, flavor_ur: e.target.value })} placeholder={t('sk.flavorUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.categoryLabel')}</label>
                {!changingCategory ? (
                  <div className="flex items-center justify-between gap-2 bg-dp-secondary-container/40 rounded-lg px-3 py-2.5">
                    <span className="font-sans text-[13.5px] font-semibold text-dp-secondary">{getCategoryLabel(productForm.category, isUrdu)}</span>
                    <button type="button" onClick={() => setChangingCategory(true)} className="font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer shrink-0">{t('sk.changeCategoryBtn')}</button>
                  </div>
                ) : (
                  <CategoryPicker primaryType={selected?.primary_type ?? 'general_store'} value={productForm.category}
                    onPick={(slug) => { setProductForm({ ...productForm, category: slug }); setChangingCategory(false) }} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('sk.costPriceLabel')}</label><input type="number" value={productForm.cost_price_pkr || ''} onChange={(e) => setProductForm({ ...productForm, cost_price_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.unitPriceLabel')}</label><input type="number" value={productForm.unit_price_pkr || ''} onChange={(e) => setProductForm({ ...productForm, unit_price_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
              </div>
              <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.stockLabel')}</label><input type="number" value={productForm.quantity_on_hand || ''} onChange={(e) => setProductForm({ ...productForm, quantity_on_hand: +e.target.value })} className="input-field" placeholder="0" /></div>
              <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.expiryDateLabel')}</label><input type="date" value={productForm.expiry_date} onChange={(e) => setProductForm({ ...productForm, expiry_date: e.target.value })} className="input-field" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={productForm.is_active} onChange={(e) => setProductForm({ ...productForm, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('mk.productActiveLabel')}</span></label>
              <button onClick={saveProduct} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

      {showCatalogPicker && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowCatalogPicker(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary flex items-center gap-2"><ListPlus size={18} /> {t('pc.pickFromCatalogBtn')}</h2>
              <button onClick={() => setShowCatalogPicker(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('pc.pickerHint')}</p>
            <ProductCatalogPicker onPick={openProductFromCatalog} />
          </div>
        </div>
      )}
    </div>
  )
}
