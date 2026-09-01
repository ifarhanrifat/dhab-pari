'use client'

// Shop keeper self-service: catalog management for whichever shop is
// linked to this portal account (shops.portal_user_id, set by staff — see
// migration 391). Mirrors admin/shops' product form fields exactly, plus
// the AI camera step: point the phone at a product, Gemini (using this
// shop's OWN key, entered once below) drafts name/company/category/
// description from the packaging, the keeper reviews everything and still
// sets the buying/selling price themselves before saving. The exact same
// photo becomes the product's cover, so there's only one photo to take.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Store, X, Pencil, Trash2, Camera, Loader2, KeyRound, ShoppingCart, PackageX, BarChart3, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { WalletTopupModal } from '@/components/portal/WalletTopupModal'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { getCategoryLabel } from '@/lib/shopTypes'
import { CategoryBrowser, CategoryPicker } from '@/components/shared/CategoryBrowser'
import type { CatalogItem } from '@/lib/productCatalog'

interface Shop { id: string; name: string; name_ur: string | null; delivery_enabled: boolean; commission_mode: string; primary_type: string }
interface Product {
  id: string; name: string; name_ur: string | null; description: string | null
  company: string | null; category: string | null; flavor: string | null; flavor_ur: string | null
  unit_price_pkr: number; cost_price_pkr: number; quantity_on_hand: number; expiry_date: string | null; is_active: boolean
}

const emptyProduct = {
  name: '', name_ur: '', description: '', company: '', category: 'other' as string, flavor: '', flavor_ur: '',
  unit_price_pkr: 0, cost_price_pkr: 0, quantity_on_hand: 0, expiry_date: '', is_active: true,
}

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

export default function MyShopPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

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
  const scanInputRef = useRef<HTMLInputElement>(null)

  const [showTopup, setShowTopup] = useState(false)
  const [showAiSettings, setShowAiSettings] = useState(false)
  const [changingCategory, setChangingCategory] = useState(false)
  const [geminiKey, setGeminiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.from('shops').select('id, name, name_ur, delivery_enabled, commission_mode, primary_type').eq('portal_user_id', user.id).maybeSingle()
      .then(({ data }) => { setShop(data); setShopLoading(false) })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadProducts = async (shopId: string) => {
    const { data } = await supabase.from('shop_products').select('*').eq('shop_id', shopId).order('name')
    setProducts(data ?? [])
    if (data && data.length > 0) {
      const { data: media } = await supabase.from('product_media').select('product_id, url').eq('is_cover', true).in('product_id', data.map((p) => p.id))
      setCoverByProduct(Object.fromEntries((media ?? []).map((m) => [m.product_id, m.url])))
    }
  }
  useEffect(() => { if (shop) loadProducts(shop.id) }, [shop]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!shop) return
    supabase.from('shop_ai_settings').select('gemini_api_key').eq('shop_id', shop.id).maybeSingle()
      .then(({ data }) => { setKeySaved(!!data?.gemini_api_key); setGeminiKey(data?.gemini_api_key ?? '') })
  }, [shop]) // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = (categorySlug: string) => { setEditing(null); setForm({ ...emptyProduct, category: categorySlug }); setCoverUrl(''); setChangingCategory(false); setShowForm(true) }
  const openEdit = (p: Product) => {
    setEditing(p)
    setForm({
      name: p.name, name_ur: p.name_ur ?? '', description: p.description ?? '', company: p.company ?? '',
      category: p.category ?? 'other', flavor: p.flavor ?? '', flavor_ur: p.flavor_ur ?? '',
      unit_price_pkr: p.unit_price_pkr, cost_price_pkr: p.cost_price_pkr,
      quantity_on_hand: p.quantity_on_hand, expiry_date: p.expiry_date ?? '', is_active: p.is_active,
    })
    setCoverUrl(coverByProduct[p.id] ?? '')
    setChangingCategory(false)
    setShowForm(true)
  }

  // Third add path: pick a real brand + item from the catalog instead of
  // typing or scanning — pre-fills name/company/flavor/category exactly
  // like a scan draft does, price/stock/photo still left to the keeper.
  const openFromCatalog = (brandName: string, item: CatalogItem) => {
    setEditing(null)
    setForm({
      ...emptyProduct, name: item.name, name_ur: item.name_ur ?? '', company: brandName,
      flavor: item.flavor ?? '', flavor_ur: item.flavor_ur ?? '', category: item.category,
      unit_price_pkr: item.price ?? 0,
    })
    setCoverUrl('')
    setChangingCategory(false)
    setShowForm(true)
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

      setEditing(null)
      setForm({
        ...emptyProduct, name: json.name || '', name_ur: json.name_ur || '', company: json.company || '',
        category: json.category || 'other', flavor: json.flavor || '', flavor_ur: json.flavor_ur || '',
        description: json.description || '',
      })
      setCoverUrl(publicUrl)
      setChangingCategory(false)
      setShowForm(true)
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

  if (userLoading || shopLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!shop) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <Store size={28} className="mx-auto text-dp-on-surface-variant/50 mb-3" />
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('sk.noShopLinked')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <h1 className="font-heading text-[26px] font-bold leading-[34px] text-dp-primary flex items-center gap-2"><Store size={22} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</h1>
        <div className="flex items-center gap-2">
          {shop.commission_mode === 'per_order' && (
            <button onClick={() => setShowTopup(true)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container">
              <Wallet size={14} /> {t('cm.topupWalletBtn')}
            </button>
          )}
          <button onClick={() => setShowAiSettings(true)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container">
            <KeyRound size={14} /> {keySaved ? t('sk.aiSettingsBtn') : t('sk.setUpAiBtn')}
          </button>
          <Link href="/portal/my-shop/reports" className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container">
            <BarChart3 size={14} /> {t('cm.reportsBtn')}
          </Link>
          <Link href="/portal/my-shop/sell" className="flex items-center gap-1.5 px-3 py-2 bg-dp-primary text-white rounded-lg font-sans text-[13px] font-semibold hover:opacity-90">
            <ShoppingCart size={14} /> {t('sk.sellBtn')}
          </Link>
        </div>
      </div>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('sk.pageSubtitle')}</p>

      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <input ref={scanInputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runScan(f) }} />
        <button onClick={() => scanInputRef.current?.click()} disabled={scanning}
          className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-60">
          {scanning ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />} {scanning ? t('sk.scanningLabel') : t('sk.scanProductBtn')}
        </button>
        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('sk.orBrowseCategoryHint')}</p>
      </div>

      <CategoryBrowser
        primaryType={shop.primary_type}
        products={products}
        onAddItem={openNew}
        onPickCatalogItem={openFromCatalog}
        renderProduct={(p) => (
          <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
            <div className="h-28 bg-dp-surface-container relative">
              {coverByProduct[p.id] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coverByProduct[p.id]} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-dp-on-surface-variant/40"><Store size={24} /></div>
              )}
              {p.quantity_on_hand <= 0 && <span className="absolute top-1.5 end-1.5 inline-flex items-center gap-1 text-[9.5px] font-bold uppercase px-2 py-0.5 rounded-full bg-red-100 text-red-700"><PackageX size={10} /> {t('sk.outOfStock')}</span>}
            </div>
            <div className="p-3">
              <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">
                {isUrdu && p.name_ur ? p.name_ur : p.name}
                {(isUrdu ? (p.flavor_ur || p.flavor) : p.flavor) && <span className="font-normal text-dp-on-surface-variant"> ({isUrdu ? (p.flavor_ur || p.flavor) : p.flavor})</span>}
              </p>
              {p.company && <p className="font-sans text-[11px] text-dp-on-surface-variant truncate">{p.company}</p>}
              <div className="flex items-baseline gap-2 mt-1">
                <p className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(p.unit_price_pkr)}</p>
                {p.cost_price_pkr > 0 && <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('sk.costLabel')} {fmt(p.cost_price_pkr)}</p>}
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('mk.stockLabel')} {fmt(p.quantity_on_hand)}</p>
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-dp-outline-variant/60">
                <button onClick={() => openEdit(p)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={14} /></button>
                <button onClick={() => remove(p)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
              </div>
            </div>
          </div>
        )}
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editing ? t('mk.editProductBtn') : t('mk.newProductBtn')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            {!editing && form.name && <p className="font-sans text-[12px] text-dp-secondary bg-dp-secondary-container/40 rounded-lg px-3 py-2 mb-3">{t('sk.reviewDraftHint')}</p>}
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
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.categoryLabel')}</label>
                {!changingCategory ? (
                  <div className="flex items-center justify-between gap-2 bg-dp-secondary-container/40 rounded-lg px-3 py-2.5">
                    <span className="font-sans text-[13.5px] font-semibold text-dp-secondary">{getCategoryLabel(form.category, isUrdu)}</span>
                    <button type="button" onClick={() => setChangingCategory(true)} className="font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer shrink-0">{t('sk.changeCategoryBtn')}</button>
                  </div>
                ) : (
                  <CategoryPicker primaryType={shop?.primary_type ?? 'general_store'} value={form.category}
                    onPick={(slug) => { setForm({ ...form, category: slug }); setChangingCategory(false) }} />
                )}
              </div>
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder={t('a.notesOptional')} className="input-field resize-none" />
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('sk.costPriceLabel')}</label><input type="number" value={form.cost_price_pkr || ''} onChange={(e) => setForm({ ...form, cost_price_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.unitPriceLabel')}</label><input type="number" value={form.unit_price_pkr || ''} onChange={(e) => setForm({ ...form, unit_price_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
              </div>
              <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.stockLabel')}</label><input type="number" value={form.quantity_on_hand || ''} onChange={(e) => setForm({ ...form, quantity_on_hand: +e.target.value })} className="input-field" placeholder="0" /></div>
              <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.expiryDateLabel')}</label><input type="date" value={form.expiry_date} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} className="input-field" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('mk.productActiveLabel')}</span></label>
              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

      {showTopup && (
        <WalletTopupModal kind="shop" sellerId={shop.id} onClose={() => setShowTopup(false)} onSubmitted={() => setShowTopup(false)} />
      )}

      {showAiSettings && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowAiSettings(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary flex items-center gap-2"><KeyRound size={18} /> {t('sk.aiSettingsBtn')}</h2>
              <button onClick={() => setShowAiSettings(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-3">{t('sk.aiSettingsHint')}</p>
            <input type="password" value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} placeholder={t('sk.apiKeyPlaceholder')} className="input-field mb-3" dir="ltr" />
            <button onClick={saveKey} disabled={savingKey} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{savingKey ? t('action.saving') : t('g.saveChanges')}</button>
          </div>
        </div>
      )}

    </div>
  )
}
