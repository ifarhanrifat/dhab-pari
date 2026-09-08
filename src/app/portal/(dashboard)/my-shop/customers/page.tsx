'use client'

// Customer credit ("khata") — migrations 452/453. A shopkeeper registers
// a regular customer once here, then at the counter (sell/page.tsx) can
// bill them "on credit" instead of cash — the sale still goes through
// record_shop_sale exactly as before, just tagged with this customer's
// id. This screen is the other half: the customer list with running
// balances, and per-customer statements + recording payments against
// what they owe. Confirmed design (2026-09-07): a running tab paid down
// whenever, not a fixed monthly billing cycle; partial payments allowed.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { resolveMyShop } from '@/lib/shop'
import { ArrowLeft, Users, Search, X, Plus, Loader2, Wallet, ChevronDown, ChevronUp, Pencil, Trash2, FileText, MessageCircle, Receipt, Link2, Link2Off, Download } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { normalizePakPhone, nodeToPngBlob, shareReceipt, downloadBlob } from '@/lib/receiptExport'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarqueeText } from '@/components/shared/MarqueeText'
import { ShopBottomNav } from '@/components/portal/ShopBottomNav'
import { ShopInvoiceSlip } from '@/components/portal/ShopInvoiceSlip'

const INK = '#201e1d'
const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'

interface Shop { id: string; name: string; name_ur: string | null }
interface Customer { id: string; name: string; name_ur: string | null; phone: string | null; is_active: boolean; balance: number; linked_count: number }
// The shopkeeper's own view of who's linked — a label ("User 1"/"User 2")
// and nothing else. Migration 466's whole point: portal_user_id/name
// never reach this screen at all, not even in a field the UI ignores.
interface LinkedUser { link_id: string; label: string; linked_at: string }
const LINK_CAP = 6
// entry_type 'invoice' rows carry no debit/credit of their own (a real
// invoice is just a formal snapshot of sales already recorded, not a
// new charge) — they exist in the timeline purely so a shopkeeper can
// see what's already been billed without it double-counting the balance.
interface StatementRow { entry_id: string; entry_type: 'sale' | 'payment' | 'invoice'; entry_at: string; description: string; debit: number; credit: number; running_balance: number }
interface SaleItem { id: string; product_id: string; product_name_snapshot: string; quantity: number; unit_price_pkr: number; line_total_pkr: number; pack_id: string | null; pack_label_snapshot: string | null }
interface EditItem { product_id: string; product_name_snapshot: string; quantity: number; unit_price_pkr: number; pack_id: string | null; pack_label_snapshot: string | null; editable: boolean }
interface InvoiceSaleGroup { sale_id: string; created_at: string; total_amount_pkr: number; items: SaleItem[] }
interface InvoiceDetail { id: string; invoice_number: number; period_start: string | null; period_end: string; total_amount_pkr: number; sales: InvoiceSaleGroup[] }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function CustomersPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newNameUr, setNewNameUr] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [saving, setSaving] = useState(false)

  const [openCustomer, setOpenCustomer] = useState<Customer | null>(null)
  const [statement, setStatement] = useState<StatementRow[]>([])
  const [loadingStatement, setLoadingStatement] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentNote, setPaymentNote] = useState('')
  const [recordingPayment, setRecordingPayment] = useState(false)

  // A sale's own line items load lazily, on first expand — the statement
  // itself only ever needed the total, so fetching every sale's items
  // up front for a customer with a long history would be wasted work
  // most of the time.
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null)
  const [saleItemsCache, setSaleItemsCache] = useState<Record<string, SaleItem[]>>({})
  const [loadingSaleId, setLoadingSaleId] = useState<string | null>(null)

  // Editing is deliberately scoped to correcting what's already on a
  // sale (quantity/price per line, or dropping a line entered by
  // mistake) — not adding a brand-new item mid-edit. A forgotten item
  // is just a new sale; re-deriving the full product-search-and-add UI
  // inside this modal for that one case isn't worth the size it'd add
  // here. Pack lines show read-only (their price/qty come from the pack
  // definition itself, not this form).
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null)
  const [editItems, setEditItems] = useState<EditItem[]>([])
  const [savingEdit, setSavingEdit] = useState(false)

  const [generatingInvoice, setGeneratingInvoice] = useState(false)
  const [viewingInvoice, setViewingInvoice] = useState<InvoiceDetail | null>(null)
  const [loadingInvoice, setLoadingInvoice] = useState(false)
  // The bill is now shared as an actual small thermal-roll-style receipt
  // image (86mm) instead of plain WhatsApp text — slipRef points at the
  // ShopInvoiceSlip rendered live in the modal below, so what gets
  // captured is exactly what the shopkeeper already sees on screen.
  const slipRef = useRef<HTMLDivElement>(null)
  const [sendingSlip, setSendingSlip] = useState(false)

  // Linking a registered customer's own portal account so they can view
  // this same statement themselves — a one-time code, not an automatic
  // match on phone number (see migration 463's own header for why).
  // Several household members can link the same account (migration 466);
  // the shopkeeper only ever sees anonymized "User 1"/"User 2" labels for
  // them, never a real name.
  const [generatingCode, setGeneratingCode] = useState(false)
  const [linkCode, setLinkCode] = useState<string | null>(null)
  const [showLinkedList, setShowLinkedList] = useState(false)
  const [linkedUsers, setLinkedUsers] = useState<LinkedUser[]>([])
  const [loadingLinkedUsers, setLoadingLinkedUsers] = useState(false)
  const [removingLinkId, setRemovingLinkId] = useState<string | null>(null)

  const loadCustomers = (shopId: string) =>
    supabase.rpc('shop_customers_with_balance', { p_shop_id: shopId }).then(({ data }) => setCustomers((data ?? []) as Customer[]))

  useEffect(() => {
    if (!user) return
    resolveMyShop<Shop>(supabase, user.id, 'id, name, name_ur').then(({ data }) => {
      setShop(data)
      if (data) loadCustomers(data.id).then(() => setLoading(false))
      else setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const addCustomer = async () => {
    if (!shop || !newName.trim()) { toast.error(t('sk.customerNameRequired')); return }
    setSaving(true)
    const { error } = await supabase.from('shop_customers').insert({
      shop_id: shop.id, name: newName.trim(), name_ur: newNameUr.trim() || null, phone: newPhone.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    setNewName(''); setNewNameUr(''); setNewPhone(''); setShowNew(false)
    loadCustomers(shop.id)
  }

  const openStatement = async (c: Customer) => {
    setOpenCustomer(c)
    setPaymentAmount(''); setPaymentNote(''); setLinkCode(null)
    setShowLinkedList(false); setLinkedUsers([])
    setLoadingStatement(true)
    const { data, error } = await supabase.rpc('shop_customer_statement', { p_customer_id: c.id })
    setLoadingStatement(false)
    if (error) { toast.error(friendlyError(error)); return }
    setStatement((data ?? []) as StatementRow[])
  }

  const recordPayment = async () => {
    if (!openCustomer) return
    const amount = Number(paymentAmount)
    if (!(amount > 0)) { toast.error(t('sk.paymentAmountRequired')); return }
    setRecordingPayment(true)
    const { error } = await supabase.rpc('record_shop_credit_payment', {
      p_customer_id: openCustomer.id, p_amount_pkr: amount, p_note: paymentNote.trim() || null,
    })
    setRecordingPayment(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.paymentRecordedToast'))
    setPaymentAmount(''); setPaymentNote('')
    openStatement(openCustomer)
    if (shop) loadCustomers(shop.id)
  }

  const loadSaleItems = async (saleId: string): Promise<SaleItem[]> => {
    if (saleItemsCache[saleId]) return saleItemsCache[saleId]
    setLoadingSaleId(saleId)
    const { data } = await supabase.from('shop_sale_items')
      .select('id, product_id, product_name_snapshot, quantity, unit_price_pkr, line_total_pkr, pack_id, pack_label_snapshot')
      .eq('sale_id', saleId)
    setLoadingSaleId(null)
    const items = (data ?? []) as SaleItem[]
    setSaleItemsCache((c) => ({ ...c, [saleId]: items }))
    return items
  }

  const toggleSaleExpand = async (saleId: string) => {
    if (expandedSaleId === saleId) { setExpandedSaleId(null); return }
    setExpandedSaleId(saleId)
    await loadSaleItems(saleId)
  }

  const openEditSale = async (saleId: string) => {
    const items = await loadSaleItems(saleId)
    setEditItems(items.map((it) => ({
      product_id: it.product_id, product_name_snapshot: it.product_name_snapshot,
      quantity: it.quantity, unit_price_pkr: it.unit_price_pkr,
      pack_id: it.pack_id, pack_label_snapshot: it.pack_label_snapshot,
      editable: !it.pack_id,
    })))
    setEditingSaleId(saleId)
  }

  const saveEditSale = async () => {
    if (!editingSaleId) return
    if (editItems.length === 0) { toast.error(t('sk.editSaleNeedsItemHint')); return }
    setSavingEdit(true)
    const items = editItems.map((it) => it.pack_id
      ? { product_id: it.product_id, pack_id: it.pack_id }
      : { product_id: it.product_id, quantity: it.quantity })
    const { error } = await supabase.rpc('edit_shop_sale', { p_sale_id: editingSaleId, p_items: items })
    setSavingEdit(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.saleUpdatedToast'))
    setSaleItemsCache((c) => { const n = { ...c }; delete n[editingSaleId]; return n })
    setEditingSaleId(null)
    if (openCustomer) openStatement(openCustomer)
    if (shop) loadCustomers(shop.id)
  }

  const generateLinkCode = async () => {
    if (!openCustomer) return
    setGeneratingCode(true)
    const { data, error } = await supabase.rpc('generate_customer_link_code', { p_customer_id: openCustomer.id })
    setGeneratingCode(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.linkCodeGeneratedToast'))
    setLinkCode(data as string)
  }

  const sendCodeOnWhatsApp = () => {
    if (!openCustomer || !linkCode) return
    const intl = normalizePakPhone(openCustomer.phone ?? '')
    if (!intl) { toast.error(t('sk.noPhoneForWhatsappHint')); return }
    const name = openCustomer.name_ur || openCustomer.name
    const shopName = isUrdu && shop?.name_ur ? shop.name_ur : shop?.name
    const lines = [
      `السلام علیکم ${name}،`, '',
      `${shopName} پر اپنا کھاتہ خود دیکھنے کے لیے، اپنے پورٹل اکاؤنٹ میں "شاپ ادھار" میں یہ کوڈ درج کریں:`,
      '', linkCode, '', 'یہ کوڈ 30 منٹ کے لیے درست ہے۔',
    ]
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(lines.join('\n'))}`, '_blank')
  }

  const loadLinkedUsers = async (customerId: string) => {
    setLoadingLinkedUsers(true)
    const { data, error } = await supabase.rpc('list_customer_links', { p_customer_id: customerId })
    setLoadingLinkedUsers(false)
    if (error) { toast.error(friendlyError(error)); return }
    setLinkedUsers((data ?? []) as LinkedUser[])
  }

  const toggleLinkedList = () => {
    if (!openCustomer) return
    if (!showLinkedList) loadLinkedUsers(openCustomer.id)
    setShowLinkedList((v) => !v)
  }

  // Shopkeeper-side removal, by the anonymized link's own id — the
  // shopkeeper is never shown (and this call never needs) who a "User N"
  // actually is.
  const removeLinkedUser = async (row: LinkedUser) => {
    if (!openCustomer || !confirm(t('sk.confirmRemoveLink').replace('{label}', row.label))) return
    setRemovingLinkId(row.link_id)
    const { error } = await supabase.rpc('shop_remove_customer_link', { p_link_id: row.link_id })
    setRemovingLinkId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.linkRemovedToast'))
    setLinkedUsers((rows) => rows.filter((r) => r.link_id !== row.link_id))
    setOpenCustomer((c) => c ? { ...c, linked_count: Math.max(0, c.linked_count - 1) } : c)
    if (shop) loadCustomers(shop.id)
  }

  const generateInvoice = async () => {
    if (!openCustomer) return
    setGeneratingInvoice(true)
    const { data, error } = await supabase.rpc('generate_shop_customer_invoice', { p_customer_id: openCustomer.id })
    setGeneratingInvoice(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.invoiceGeneratedToast'))
    openStatement(openCustomer)
    if (typeof data === 'string') openInvoice(data)
  }

  const openInvoice = async (invoiceId: string) => {
    setLoadingInvoice(true)
    const [{ data: inv }, { data: links }] = await Promise.all([
      supabase.from('shop_customer_invoices').select('id, invoice_number, period_start, period_end, total_amount_pkr').eq('id', invoiceId).single(),
      supabase.from('shop_customer_invoice_sales')
        .select('sale_id, shop_sales(created_at, total_amount_pkr, shop_sale_items(id, product_id, product_name_snapshot, quantity, unit_price_pkr, line_total_pkr, pack_id, pack_label_snapshot))')
        .eq('invoice_id', invoiceId),
    ])
    setLoadingInvoice(false)
    if (!inv) { toast.error(t('sk.invoiceLoadFailedHint')); return }
    type LinkRow = { sale_id: string; shop_sales: { created_at: string; total_amount_pkr: number; shop_sale_items: SaleItem[] } | { created_at: string; total_amount_pkr: number; shop_sale_items: SaleItem[] }[] }
    const sales: InvoiceSaleGroup[] = ((links ?? []) as unknown as LinkRow[]).map((r) => {
      const sa = Array.isArray(r.shop_sales) ? r.shop_sales[0] : r.shop_sales
      return { sale_id: r.sale_id, created_at: sa?.created_at ?? '', total_amount_pkr: sa?.total_amount_pkr ?? 0, items: sa?.shop_sale_items ?? [] }
    }).sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    setViewingInvoice({ id: inv.id, invoice_number: inv.invoice_number, period_start: inv.period_start, period_end: inv.period_end, total_amount_pkr: inv.total_amount_pkr, sales })
  }

  const invoiceFilename = () => `bill-${viewingInvoice?.invoice_number ?? ''}.png`

  // Renders whatever ShopInvoiceSlip currently shows in the modal to a
  // PNG and puts it in front of the customer's WhatsApp chat — the same
  // clipboard-copy-then-open-chat flow every other receipt in this app
  // uses (shareReceipt's own header explains why: never a generic OS
  // share sheet, since a button labelled WhatsApp should only ever open
  // WhatsApp). Replaces the old plain-text message entirely; the
  // shopkeeper asked for something that reads like an actual receipt,
  // not chat text.
  const sendInvoiceOnWhatsApp = async () => {
    if (!viewingInvoice || !openCustomer || !slipRef.current) return
    const intl = normalizePakPhone(openCustomer.phone ?? '')
    if (!intl) { toast.error(t('sk.noPhoneForWhatsappHint')); return }
    setSendingSlip(true)
    try {
      const blob = await nodeToPngBlob(slipRef.current)
      const name = openCustomer.name_ur || openCustomer.name
      const result = await shareReceipt({
        blob, filename: invoiceFilename(), mime: 'image/png', phone: openCustomer.phone,
        clipboardBlob: blob,
        message: isUrdu ? `${name} کا بل نمبر ${viewingInvoice.invoice_number}` : `Bill #${viewingInvoice.invoice_number} for ${name}`,
      })
      toast.success(result === 'copied' ? t('sk.slipCopiedToast') : t('sk.slipDownloadedToast'))
    } catch {
      toast.error(t('sk.slipShareFailedHint'))
    } finally {
      setSendingSlip(false)
    }
  }

  const downloadInvoiceSlip = async () => {
    if (!slipRef.current) return
    setSendingSlip(true)
    try {
      const blob = await nodeToPngBlob(slipRef.current)
      downloadBlob(blob, invoiceFilename())
    } catch {
      toast.error(t('sk.slipShareFailedHint'))
    } finally {
      setSendingSlip(false)
    }
  }

  const filtered = search.trim()
    ? customers.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()) || (c.name_ur ?? '').includes(search) || (c.phone ?? '').includes(search))
    : customers
  // Whoever owes the most floats to the top — the actionable view for a
  // shopkeeper deciding who to remind.
  const sorted = [...filtered].sort((a, b) => b.balance - a.balance)
  const totalOwed = customers.reduce((s, c) => s + Math.max(c.balance, 0), 0)

  if (userLoading || loading) return <div className="text-center py-12 text-[#7a736d] font-sans"><LoadingDots /></div>
  if (!shop) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('sk.noShopLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline mb-3" style={{ color: ACCENT }}><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] mb-1 flex items-center gap-2" style={{ color: INK }}><Users size={22} /> {t('sk.customersHeading')}</h1>
      <p className="font-sans text-[13px] text-[#7a736d] mb-4">{t('sk.customersSubtitle')}</p>

      {customers.length > 0 && (
        <div className="border p-3 mb-4" style={{ borderColor: '#f4a68f', background: '#fce3dc' }}>
          <p className="font-sans text-[11px] font-semibold" style={{ color: ACCENT_DARK }}>{t('sk.totalOwedLabel')}</p>
          <p className="font-heading text-[22px] font-bold ltr-num" style={{ color: ACCENT_DARK }}>{fmt(totalOwed)}</p>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#7a736d] pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sk.searchCustomersPlaceholder')} className="input-field ps-9" />
        </div>
        <button onClick={() => setShowNew(true)} className="shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 text-white font-sans text-[13px] font-semibold cursor-pointer" style={{ background: ACCENT }}>
          <Plus size={15} /> {t('sk.newCustomerBtn')}
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-center py-10 text-[#7a736d] font-sans text-[14px]">{t('sk.noCustomersYetHint')}</p>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((c) => (
            <button key={c.id} onClick={() => openStatement(c)}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-3 bg-white border border-[#dcd8d4] text-start cursor-pointer hover:border-[#201e1d] transition-colors">
              <div className="min-w-0 flex-1">
                <MarqueeText text={isUrdu && c.name_ur ? c.name_ur : c.name} className="font-sans text-[14px] font-semibold" style={{ color: INK }} />
                {c.phone && <p className="font-sans text-[11px] text-[#7a736d] ltr-num">{c.phone}</p>}
              </div>
              <p className={`font-sans text-[15px] font-bold shrink-0 ltr-num ${c.balance > 0 ? '' : 'text-[#7a736d]'}`} style={c.balance > 0 ? { color: ACCENT_DARK } : undefined}>
                {c.balance === 0 ? t('sk.settledLabel') : fmt(c.balance)}
              </p>
            </button>
          ))}
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowNew(false)}>
          <div className="bg-white p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-[18px] font-bold" style={{ color: INK }}>{t('sk.newCustomerBtn')}</h2>
              <button onClick={() => setShowNew(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-2.5">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('sk.customerNamePlaceholder')} className="input-field" />
              <input value={newNameUr} onChange={(e) => setNewNameUr(e.target.value)} placeholder={t('sk.customerNameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder={t('sk.customerPhonePlaceholder')} className="input-field ltr-num" dir="ltr" />
              <button onClick={addCustomer} disabled={saving} className="w-full text-white py-3 font-sans font-semibold cursor-pointer disabled:opacity-50" style={{ background: ACCENT }}>
                {saving ? t('action.saving') : t('g.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {openCustomer && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setOpenCustomer(null)}>
          <div className="bg-white w-full sm:max-w-md max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: '#e2ded9' }}>
              <div className="min-w-0">
                <MarqueeText text={isUrdu && openCustomer.name_ur ? openCustomer.name_ur : openCustomer.name} className="font-heading text-[16px] font-bold" style={{ color: INK }} />
                {openCustomer.phone && <p className="font-sans text-[11px] text-[#7a736d] ltr-num">{openCustomer.phone}</p>}
              </div>
              <button onClick={() => setOpenCustomer(null)} className="cursor-pointer shrink-0"><X size={20} /></button>
            </div>

            <div className="px-4 pt-3 space-y-2">
              {/* Anonymized — this is the whole point. Several household
                  members (husband, wife, an aunt living together) can all
                  link the same account; the shopkeeper only ever sees how
                  MANY are linked and a bare "User N" label each, never a
                  real name or which portal account it is. */}
              {openCustomer.linked_count > 0 && (
                <div className="border" style={{ borderColor: '#bfe0c8', background: '#e9f7ec' }}>
                  <button onClick={toggleLinkedList} className="w-full flex items-center justify-between gap-2 px-2.5 py-2 cursor-pointer">
                    <span className="flex items-center gap-1.5 font-sans text-[11.5px] font-semibold" style={{ color: '#1a6b34' }}>
                      <Link2 size={13} className="shrink-0" /> {t('sk.linkedCountLabel').replace('{n}', String(openCustomer.linked_count))}
                    </span>
                    {showLinkedList ? <ChevronUp size={14} style={{ color: '#1a6b34' }} /> : <ChevronDown size={14} style={{ color: '#1a6b34' }} />}
                  </button>
                  {showLinkedList && (
                    <div className="px-2.5 pb-2.5 space-y-1">
                      {loadingLinkedUsers ? (
                        <div className="py-2 text-center"><LoadingDots /></div>
                      ) : linkedUsers.map((row) => (
                        <div key={row.link_id} className="flex items-center justify-between gap-2 px-2 py-1.5 bg-white border" style={{ borderColor: '#bfe0c8' }}>
                          <span className="font-sans text-[12px] font-semibold" style={{ color: INK }}>{row.label}</span>
                          <button onClick={() => removeLinkedUser(row)} disabled={removingLinkId === row.link_id} className="shrink-0 flex items-center gap-1 font-sans text-[10.5px] font-semibold underline cursor-pointer disabled:opacity-50" style={{ color: ACCENT_DARK }}>
                            {removingLinkId === row.link_id ? <Loader2 size={11} className="animate-spin" /> : <Link2Off size={11} />} {t('sk.unlinkBtn')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {linkCode ? (
                <div className="px-2.5 py-2.5 border" style={{ borderColor: '#f4a68f', background: '#fce3dc' }}>
                  <p className="font-sans text-[11px] mb-1.5" style={{ color: ACCENT_DARK }}>{t('sk.linkCodeHint').replace('{name}', openCustomer.name_ur || openCustomer.name)}</p>
                  <p className="font-heading text-[26px] font-bold text-center tracking-[0.15em] ltr-num mb-1" style={{ color: ACCENT_DARK }}>{linkCode}</p>
                  <p className="font-sans text-[10px] text-center text-[#7a736d] mb-2">{t('sk.linkCodeExpiresHint')}</p>
                  <button onClick={sendCodeOnWhatsApp} className="w-full flex items-center justify-center gap-1.5 py-2 text-white font-sans text-[12px] font-semibold cursor-pointer" style={{ background: '#25D366' }}>
                    <MessageCircle size={13} /> {t('sk.sendCodeWhatsappBtn')}
                  </button>
                </div>
              ) : openCustomer.linked_count >= LINK_CAP ? (
                <p className="font-sans text-[10.5px] text-center text-[#7a736d]">{t('sk.linkCapReachedHint')}</p>
              ) : (
                <button onClick={generateLinkCode} disabled={generatingCode} className="w-full flex items-center justify-center gap-1.5 py-2 border font-sans text-[12px] font-semibold cursor-pointer disabled:opacity-50" style={{ borderColor: ACCENT, color: ACCENT }}>
                  {generatingCode ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} {t(openCustomer.linked_count > 0 ? 'sk.linkAnotherBtn' : 'sk.linkToPortalBtn')}
                </button>
              )}
            </div>

            <div className="p-4 border-b" style={{ borderColor: '#e2ded9', background: '#f7f6f5' }}>
              <p className="font-sans text-[11px] font-semibold text-[#7a736d]">{t('sk.currentBalanceLabel')}</p>
              <p className="font-heading text-[24px] font-bold ltr-num" style={{ color: openCustomer.balance > 0 ? ACCENT_DARK : INK }}>{fmt(openCustomer.balance)}</p>
              <div className="flex items-center gap-2 mt-3">
                <input inputMode="decimal" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder={t('sk.paymentAmountPlaceholder')} className="input-field flex-1 ltr-num" />
                <button onClick={recordPayment} disabled={recordingPayment} className="shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 text-white font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50" style={{ background: INK }}>
                  {recordingPayment ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />} {t('sk.recordPaymentBtn')}
                </button>
              </div>
              <input value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} placeholder={t('sk.paymentNotePlaceholder')} className="input-field mt-2 text-[12px]" />
              <button onClick={generateInvoice} disabled={generatingInvoice} className="w-full mt-2 flex items-center justify-center gap-1.5 py-2.5 border font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50" style={{ borderColor: ACCENT, color: ACCENT }}>
                {generatingInvoice ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} {t('sk.generateBillBtn')}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-[#7a736d] mb-2">{t('sk.statementHeading')}</p>
              {loadingStatement ? (
                <div className="py-6 text-center"><LoadingDots /></div>
              ) : statement.length === 0 ? (
                <p className="text-center py-6 text-[#7a736d] font-sans text-[13px]">{t('sk.noTransactionsYetHint')}</p>
              ) : (
                <div className="space-y-1.5">
                  {statement.map((r) => {
                    if (r.entry_type === 'invoice') {
                      return (
                        <button key={r.entry_id} onClick={() => openInvoice(r.entry_id)}
                          className="w-full flex items-center gap-2 px-2.5 py-2 border-2 border-dashed cursor-pointer text-start" style={{ borderColor: ACCENT }}>
                          <Receipt size={15} style={{ color: ACCENT }} className="shrink-0" />
                          <span className="flex-1 min-w-0 font-sans text-[12.5px] font-semibold truncate" style={{ color: ACCENT_DARK }}>{r.description}</span>
                          <span className="shrink-0 font-sans text-[10.5px] text-[#7a736d] ltr-num">{fmtDate(r.entry_at)}</span>
                        </button>
                      )
                    }
                    const expanded = expandedSaleId === r.entry_id
                    return (
                      <div key={r.entry_id} className="border border-[#e2ded9]">
                        <button onClick={() => r.entry_type === 'sale' ? toggleSaleExpand(r.entry_id) : undefined}
                          className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-start ${r.entry_type === 'sale' ? 'cursor-pointer' : ''}`}>
                          <div className="min-w-0 flex-1 flex items-center gap-1.5">
                            {r.entry_type === 'sale' && (loadingSaleId === r.entry_id ? <Loader2 size={12} className="animate-spin shrink-0" /> : expanded ? <ChevronUp size={13} className="shrink-0 text-[#7a736d]" /> : <ChevronDown size={13} className="shrink-0 text-[#7a736d]" />)}
                            <div className="min-w-0">
                              <p className="font-sans text-[12.5px] font-semibold truncate" style={{ color: INK }}>{r.description}</p>
                              <p className="font-sans text-[10.5px] text-[#7a736d] ltr-num">
                                {new Date(r.entry_at).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                          </div>
                          <div className="text-end shrink-0">
                            <p className={`font-sans text-[13px] font-bold ltr-num ${r.entry_type === 'payment' ? 'text-emerald-700' : ''}`} style={r.entry_type === 'sale' ? { color: ACCENT_DARK } : undefined}>
                              {r.entry_type === 'payment' ? '−' : '+'}{fmt(r.debit || r.credit)}
                            </p>
                            <p className="font-sans text-[9.5px] text-[#7a736d] ltr-num">{t('sk.balanceAfterLabel')} {fmt(r.running_balance)}</p>
                          </div>
                        </button>
                        {expanded && (
                          <div className="border-t border-[#e2ded9] bg-[#f7f6f5] px-2.5 py-2">
                            {(saleItemsCache[r.entry_id] ?? []).map((it) => (
                              <div key={it.id} className="flex items-center justify-between gap-2 py-1">
                                <span className="min-w-0 flex-1 font-sans text-[11.5px] truncate" style={{ color: INK }}>
                                  {it.product_name_snapshot}{it.pack_label_snapshot && ` (${it.pack_label_snapshot})`}
                                </span>
                                <span className="shrink-0 font-sans text-[11px] text-[#7a736d] ltr-num">{fmt(it.quantity)} × {fmt(it.unit_price_pkr)} = <strong style={{ color: INK }}>{fmt(it.line_total_pkr)}</strong></span>
                              </div>
                            ))}
                            <button onClick={() => openEditSale(r.entry_id)} className="mt-1.5 flex items-center gap-1 font-sans text-[11px] font-semibold underline cursor-pointer" style={{ color: ACCENT }}>
                              <Pencil size={11} /> {t('sk.editSaleBtn')}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {editingSaleId && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setEditingSaleId(null)}>
          <div className="bg-white w-full sm:max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-[16px] font-bold flex items-center gap-1.5" style={{ color: INK }}><Pencil size={16} /> {t('sk.editSaleBtn')}</h2>
              <button onClick={() => setEditingSaleId(null)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <p className="font-sans text-[11px] text-[#7a736d] mb-3">{t('sk.editSaleHint')}</p>
            <div className="space-y-2 mb-3">
              {editItems.map((it, idx) => (
                <div key={idx} className="border border-[#dcd8d4] p-2.5">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="min-w-0 flex-1 font-sans text-[12.5px] font-semibold truncate" style={{ color: INK }}>
                      {it.product_name_snapshot}{it.pack_label_snapshot && ` (${it.pack_label_snapshot})`}
                    </span>
                    {it.editable && (
                      <button onClick={() => setEditItems((rows) => rows.filter((_, i) => i !== idx))} className="shrink-0 p-1 cursor-pointer" style={{ color: ACCENT }}><Trash2 size={13} /></button>
                    )}
                  </div>
                  {it.editable ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <label className="block font-sans text-[9.5px] text-[#7a736d] mb-0.5">{t('mk.stockLabel')}</label>
                        <input type="number" value={it.quantity || ''} onChange={(e) => setEditItems((rows) => rows.map((r, i) => i === idx ? { ...r, quantity: +e.target.value } : r))}
                          className="input-field text-[13px] py-1.5 ltr-num" />
                      </div>
                      <div className="flex-1">
                        <label className="block font-sans text-[9.5px] text-[#7a736d] mb-0.5">{t('mk.unitPriceLabel')}</label>
                        <input type="number" value={it.unit_price_pkr || ''} onChange={(e) => setEditItems((rows) => rows.map((r, i) => i === idx ? { ...r, unit_price_pkr: +e.target.value } : r))}
                          className="input-field text-[13px] py-1.5 ltr-num" />
                      </div>
                    </div>
                  ) : (
                    <p className="font-sans text-[10.5px] text-[#7a736d]">{t('sk.packLineNotEditableHint')}</p>
                  )}
                </div>
              ))}
            </div>
            <button onClick={saveEditSale} disabled={savingEdit} className="w-full text-white py-3 font-sans font-semibold cursor-pointer disabled:opacity-50" style={{ background: ACCENT }}>
              {savingEdit ? t('action.saving') : t('g.saveChanges')}
            </button>
          </div>
        </div>
      )}

      {(viewingInvoice || loadingInvoice) && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setViewingInvoice(null)}>
          <div className="bg-white w-full sm:max-w-md max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: '#e2ded9' }}>
              <h2 className="font-heading text-[16px] font-bold flex items-center gap-1.5" style={{ color: INK }}>
                <Receipt size={16} style={{ color: ACCENT }} /> {viewingInvoice ? t('sk.invoiceTitle').replace('{n}', String(viewingInvoice.invoice_number)) : ''}
              </h2>
              <button onClick={() => setViewingInvoice(null)} className="cursor-pointer"><X size={18} /></button>
            </div>
            {loadingInvoice || !viewingInvoice ? (
              <div className="py-10 text-center"><LoadingDots /></div>
            ) : (
              <>
                {/* Live preview of exactly what gets captured and shared —
                    an actual small thermal-roll-style receipt (86mm), not
                    a plain item list. Horizontally centred and scrollable
                    like the admin panel's own receipt preview: the node's
                    width is fixed (it IS the exported image's width), so a
                    narrow phone scrolls it rather than the layout
                    resizing it and changing what gets exported. */}
                <div className="flex-1 overflow-auto p-4 flex justify-center items-start bg-[#f7f6f5]">
                  <div style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.15)' }}>
                    <ShopInvoiceSlip
                      ref={slipRef}
                      shopName={shop.name} shopNameUr={shop.name_ur}
                      customerName={openCustomer?.name ?? ''} customerNameUr={openCustomer?.name_ur}
                      invoiceNumber={viewingInvoice.invoice_number}
                      periodStart={viewingInvoice.period_start ?? viewingInvoice.period_end}
                      periodEnd={viewingInvoice.period_end}
                      sales={viewingInvoice.sales}
                      totalAmount={viewingInvoice.total_amount_pkr}
                      outstandingBalance={openCustomer?.balance ?? 0}
                      isUrdu={isUrdu}
                    />
                  </div>
                </div>
                <div className="p-4 border-t flex items-center gap-2" style={{ borderColor: '#e2ded9' }}>
                  <button onClick={downloadInvoiceSlip} disabled={sendingSlip} title={t('sk.downloadSlipBtn')}
                    className="shrink-0 flex items-center justify-center p-3 border font-sans font-semibold cursor-pointer disabled:opacity-50" style={{ borderColor: '#dcd8d4', color: INK }}>
                    <Download size={16} />
                  </button>
                  <button onClick={sendInvoiceOnWhatsApp} disabled={sendingSlip} className="flex-1 flex items-center justify-center gap-2 py-3 text-white font-sans font-semibold cursor-pointer disabled:opacity-50" style={{ background: '#25D366' }}>
                    {sendingSlip ? <Loader2 size={16} className="animate-spin" /> : <MessageCircle size={16} />} {t('sk.sendWhatsappBtn')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <ShopBottomNav />
    </div>
  )
}
