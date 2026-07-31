'use client'

import { useEffect, useState, useMemo, useCallback, use as usePromise, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft, Save, Wallet, ArrowDownCircle, ArrowLeftRight, ArrowUpFromLine,
  ArrowDownToLine, Receipt, Heart, Trash2, Clock, X, BookOpen, Repeat, Plus, FileText, ShoppingCart, Banknote, ArrowUpDown, Pencil, AlertTriangle, Filter, ShieldCheck, ChevronDown,
} from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { SearchableField } from '@/components/admin/SearchablePicker'
import { FileAttachment } from '@/components/admin/FileAttachment'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { billBadge, billBadgeClass, type BillBadgeTone } from '@/lib/billStatus'

type SystemTab = 'water_supply' | 'donors_projects'
type VoucherType = 'expense' | 'income' | 'contra' | 'withdrawal' | 'deposit'
type ActiveType = VoucherType | 'bill' | 'donation' | 'purchase'
type Frequency = 'every_minute' | 'daily' | 'weekly' | 'monthly' | 'semi_annual' | 'yearly'

interface Account { id: string; name: string; name_ur: string | null; type: string; code: string; system: string }
interface Consumer { consumer_id: string; name: string; monthly_rate: number; connections: number }
interface Project { id: string; title: string }
interface TxnCard {
  id: string; kind: 'bill' | 'payment' | 'voucher' | 'donation' | 'purchase'
  borderColor: string; typeLabel: string | null; partyName: string; docLabel: string
  date: string; description: string; amount: number
  badge: { text: string; tone: BillBadgeTone } | null
  note: string | null; created_at: string
  billId?: string; paymentId?: string; voucherId?: string; donationId?: string; purchaseId?: string
  billOutstanding?: number; billConsumerId?: string
  paymentBillOutstandingNow?: number; paymentReceiptNo?: string | null
  paymentConsumerId?: string; paymentMethod?: string; paymentNote?: string | null
  purchaseLineItems?: { description: string; quantity: number; unitPrice: number }[]
  voucherType?: string
  autoPosted?: boolean
  fullyApproved?: boolean
}
interface PendingApproval { id: string; kind: string; particular: string; amount_pkr: number; created_at: string }
interface InventoryItemOpt { id: string; name: string; unit_price: number; unit_cost: number; unit: string }
interface ServiceItemOpt { id: string; name: string; charge_amount: number }
interface TemplateItemRow { item_type: 'inventory' | 'service'; inventory_item_id: string | null; service_item_id: string | null; quantity: number }
interface BillLine {
  item_type: 'inventory' | 'service' | 'custom' | 'other_charge'
  inventory_item_id: string | null; service_item_id: string | null; charge_account_id: string | null
  description: string; quantity: number; unit_price: number; is_recurring: boolean; discount_pct: number
}
interface PurchaseLine { inventory_item_id: string; description: string; quantity: number; unit_cost: number }

const systemLabels: Record<SystemTab, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects' }

const voucherConfig: Record<VoucherType, {
  label: string; icon: typeof Wallet
  fromLabel: string; fromFilter: (a: Account) => boolean
  toLabel: string; toFilter: (a: Account) => boolean
  partyLabel: string | null
}> = {
  expense: {
    label: 'Expense', icon: Wallet,
    fromLabel: 'Pay From', fromFilter: (a) => a.type === 'cash' || a.type === 'bank',
    toLabel: 'Expense Account', toFilter: (a) => a.type === 'expense',
    partyLabel: 'Paid To (optional)',
  },
  income: {
    label: 'Income', icon: ArrowDownCircle,
    fromLabel: 'Income Account', fromFilter: (a) => a.type === 'income',
    toLabel: 'Receive Into', toFilter: (a) => a.type === 'cash' || a.type === 'bank',
    partyLabel: 'Received From (optional)',
  },
  contra: {
    label: 'Bank Transfer', icon: ArrowLeftRight,
    fromLabel: 'From Account', fromFilter: (a) => a.type === 'cash' || a.type === 'bank',
    toLabel: 'To Account', toFilter: (a) => a.type === 'cash' || a.type === 'bank',
    partyLabel: null,
  },
  withdrawal: {
    label: 'Cash Withdrawal', icon: ArrowUpFromLine,
    fromLabel: 'From Bank Account', fromFilter: (a) => a.type === 'bank',
    toLabel: 'To Cash Account', toFilter: (a) => a.type === 'cash',
    partyLabel: null,
  },
  deposit: {
    label: 'Cash Deposit', icon: ArrowDownToLine,
    fromLabel: 'From Cash Account', fromFilter: (a) => a.type === 'cash',
    toLabel: 'To Bank Account', toFilter: (a) => a.type === 'bank',
    partyLabel: null,
  },
}

const today = () => new Date().toISOString().slice(0, 10)
const defaultDueDate = () => {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d.toISOString().slice(0, 10)
}
const emptyVoucherForm = { date: today(), fromId: '', toId: '', amount: 0, party: '', particular: '' }
const emptyBillForm = {
  consumer_id: '', month: new Date().getMonth() + 1, year: new Date().getFullYear(),
  due_date: defaultDueDate(), description: '', discount_amount: 0, security_deposit_amount: 0, deposit_account_id: '',
  attachment_url: '',
}
const emptyDonationForm = { name: '', name_ur: '', phone: '', donor_type: 'villager', amount_pkr: 0, date: today(), payment_method: 'cash', project_id: '', is_anonymous: false }
const frequencyLabels: Record<Frequency, string> = { every_minute: 'Every Minute (Testing)', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', semi_annual: 'Every 6 Months', yearly: 'Yearly' }
const emptyNewLine = { kind: 'custom' as 'inventory' | 'service' | 'custom', itemId: '', description: '', quantity: 1, unit_price: 0 }
const emptyPurchaseForm = { date: today(), vendor: '', method: 'cash' as 'cash' | 'bank', note: '', attachment_url: '' }
const emptyNewPurchaseLine = { itemId: '', quantity: 1, unit_cost: 0 }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function TransactionsWorkspace({ params }: { params: Promise<{ system: string }> }) {
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>}>
      <TransactionsWorkspaceInner params={params} />
    </Suspense>
  )
}

function TransactionsWorkspaceInner({ params }: { params: Promise<{ system: string }> }) {
  const { system: rawSystem } = usePromise(params)
  const system = (rawSystem === 'donors_projects' ? 'donors_projects' : 'water_supply') as SystemTab
  const searchParams = useSearchParams()
  const router = useRouter()

  const [accounts, setAccounts] = useState<Account[]>([])
  const [consumers, setConsumers] = useState<Consumer[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [txnCards, setTxnCards] = useState<TxnCard[]>([])
  const [logSortDir, setLogSortDir] = useState<'asc' | 'desc'>('desc')
  const [filterLogByType, setFilterLogByType] = useState(true)
  const [confirmDeletePaymentId, setConfirmDeletePaymentId] = useState<string | null>(null)
  const [receivePaymentTarget, setReceivePaymentTarget] = useState<{ billId: string; billNumber: string | null; consumerId: string; outstanding: number } | null>(null)
  const [viewReceipt, setViewReceipt] = useState<ReceiptData | null>(null)
  const [editPaymentTarget, setEditPaymentTarget] = useState<{ id: string; billId: string; consumerId: string; receiptNo: string | null } | null>(null)
  const [editPaymentForm, setEditPaymentForm] = useState({ amount: 0, method: 'cash' as 'cash' | 'jazzcash' | 'easypaisa' | 'bank', date: today(), note: '' })
  const [editPaymentSaving, setEditPaymentSaving] = useState(false)
  const [quickPayAmount, setQuickPayAmount] = useState(0)
  const [quickPayMethod, setQuickPayMethod] = useState<'cash' | 'jazzcash' | 'easypaisa' | 'bank'>('cash')
  const [quickPaySaving, setQuickPaySaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activeType, setActiveType] = useState<ActiveType>('expense')
  const [mobileTypeMenuOpen, setMobileTypeMenuOpen] = useState(false)
  const [voucherForm, setVoucherForm] = useState(emptyVoucherForm)
  const [billForm, setBillForm] = useState(emptyBillForm)
  const [editingBill, setEditingBill] = useState<{ id: string; bill_number: string | null; paid_amount: number; security_deposit_voucher_id: string | null; recurring_schedule_id: string | null } | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [lockedReceipts, setLockedReceipts] = useState<string[]>([])
  const [donationForm, setDonationForm] = useState(emptyDonationForm)
  const [confirmDeleteVoucherId, setConfirmDeleteVoucherId] = useState<string | null>(null)
  const [confirmDeleteBillId, setConfirmDeleteBillId] = useState<string | null>(null)
  const [billDeleteBlock, setBillDeleteBlock] = useState<{ billNumber: string | null; receipts: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])
  const [inventoryItems, setInventoryItems] = useState<InventoryItemOpt[]>([])
  const [serviceItems, setServiceItems] = useState<ServiceItemOpt[]>([])
  const [defaultTemplateItems, setDefaultTemplateItems] = useState<TemplateItemRow[]>([])
  const [billLines, setBillLines] = useState<BillLine[]>([])
  const [newLine, setNewLine] = useState(emptyNewLine)
  const [discountMode, setDiscountMode] = useState<'per_item' | 'on_total'>('per_item')
  const [showDiscountModePicker, setShowDiscountModePicker] = useState(false)
  const [showOtherCharge, setShowOtherCharge] = useState(false)
  const [otherChargeAccountId, setOtherChargeAccountId] = useState('')
  const [otherChargeDescription, setOtherChargeDescription] = useState('')
  const [otherChargeAmount, setOtherChargeAmount] = useState(0)
  const [showAddChargeAccount, setShowAddChargeAccount] = useState(false)
  const [newChargeAccountName, setNewChargeAccountName] = useState('')
  const [recurringEnabled, setRecurringEnabled] = useState(false)
  const [recurringFrequency, setRecurringFrequency] = useState<Frequency>('monthly')
  const [existingRecurring, setExistingRecurring] = useState<{ frequency: Frequency; amount_pkr: number } | null>(null)
  const [receivePaymentNow, setReceivePaymentNow] = useState(false)
  const [receiveDepositNow, setReceiveDepositNow] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState(0)
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'jazzcash' | 'easypaisa' | 'bank'>('cash')
  const [savedBill, setSavedBill] = useState<{ id: string; bill_number: string | null } | null>(null)
  const [purchaseForm, setPurchaseForm] = useState(emptyPurchaseForm)
  const [purchaseLines, setPurchaseLines] = useState<PurchaseLine[]>([])
  const [newPurchaseLine, setNewPurchaseLine] = useState(emptyNewPurchaseLine)
  const supabase = createClient()

  const load = useCallback(async () => {
    const [accountsRes, consumersRes, projectsRes, pendingRes, invRes, svcRes, tmplRes] = await Promise.all([
      // Not scoped to the current system tab — the account picker shows the whole
      // chart of accounts (Water Supply + Donors & Projects together), since a
      // committee's cash/bank accounts are often shared across both books.
      supabase.from('accounts').select('id, name, name_ur, type, code, system').eq('is_active', true).order('name'),
      system === 'water_supply' ? supabase.from('consumers').select('consumer_id, name, monthly_rate, connections').eq('status', 'active').order('name') : Promise.resolve({ data: [] }),
      system === 'donors_projects' ? supabase.from('projects').select('id, title').order('title') : Promise.resolve({ data: [] }),
      supabase.from('approval_requests').select('id, kind, particular, amount_pkr, created_at').eq('system', system).eq('status', 'pending').order('created_at', { ascending: false }),
      system === 'water_supply' ? supabase.from('inventory_items').select('id, name, unit_price, unit_cost, unit').eq('is_active', true).order('name') : Promise.resolve({ data: [] }),
      system === 'water_supply' ? supabase.from('service_items').select('id, name, charge_amount').eq('is_active', true).order('name') : Promise.resolve({ data: [] }),
      system === 'water_supply' ? supabase.from('connection_templates').select('id').eq('system', 'water_supply').eq('is_default', true).single() : Promise.resolve({ data: null }),
    ])
    const accts: Account[] = accountsRes.data ?? []
    setAccounts(accts)
    setConsumers(consumersRes.data ?? [])
    setProjects(projectsRes.data ?? [])
    setPendingApprovals(pendingRes.data ?? [])
    setInventoryItems(invRes.data ?? [])
    setServiceItems(svcRes.data ?? [])

    const tmplId = (tmplRes.data as { id: string } | null)?.id
    if (tmplId) {
      const { data: tmplItems } = await supabase.from('connection_template_items')
        .select('item_type, inventory_item_id, service_item_id, quantity').eq('template_id', tmplId)
      setDefaultTemplateItems(tmplItems ?? [])
    } else {
      setDefaultTemplateItems([])
    }

    // Recent Transactions shows one card per real-world document (a bill, a cash
    // receipt, a voucher, a donation) instead of the raw double-entry ledger legs
    // behind it — a bill with a discount and an inventory item still posts several
    // ledger rows internally, but the admin only needs to see "Bill WB-00056 — Rs 750
    // — Paid", the same way any ordinary invoicing app presents it. Sourced directly
    // from bills/payments/vouchers/donors rather than ledger_entries, so there's no
    // debit/credit leg-deduplication to get right — each table row is already exactly
    // one document.
    const consumersById = Object.fromEntries((consumersRes.data ?? []).map((c) => [c.consumer_id, c.name]))
    const ascending = logSortDir === 'asc'

    const [billsRes, paymentsRes, vouchersRes, donationsRes, purchasesRes, autoPostedRes] = await Promise.all([
      system === 'water_supply'
        ? supabase.from('bills').select('id, bill_number, consumer_id, month, year, amount_pkr, discount_amount, paid_amount, due_date, description, created_at').order('created_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [] as { id: string; bill_number: string | null; consumer_id: string; month: number; year: number; amount_pkr: number; discount_amount: number | null; paid_amount: number | null; due_date: string | null; description: string | null; created_at: string }[] }),
      system === 'water_supply'
        ? supabase.from('payments').select('id, bill_id, consumer_id, amount_pkr, method, paid_date, receipt_no, note, created_at').order('created_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [] as { id: string; bill_id: string; consumer_id: string; amount_pkr: number; method: string | null; paid_date: string; receipt_no: string | null; note: string | null; created_at: string }[] }),
      supabase.from('vouchers').select('id, voucher_type, voucher_no, receipt_no, voucher_date, particular, amount_pkr, party_name, created_at').eq('system', system).in('status', ['posted', 'approved']).order('created_at', { ascending: false }).limit(50),
      system === 'donors_projects'
        ? supabase.from('donors').select('id, name, amount_pkr, date, payment_method, notes, is_anonymous, created_at').order('created_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [] as { id: string; name: string; amount_pkr: number; date: string; payment_method: string | null; notes: string | null; is_anonymous: boolean; created_at: string }[] }),
      system === 'water_supply'
        ? supabase.from('purchases').select('id, vendor, purchase_date, method, note, attachment_url, created_at').eq('system', system).eq('status', 'posted').order('created_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [] as { id: string; vendor: string | null; purchase_date: string; method: string; note: string | null; attachment_url: string | null; created_at: string }[] }),
      supabase.from('approval_requests').select('reference_id, auto_posted').eq('system', system).eq('status', 'posted'),
    ])
    const autoPostedIds = new Set((autoPostedRes.data ?? []).filter((r) => r.auto_posted).map((r) => r.reference_id))
    // Genuinely gated AND fully confirmed by every approver (as opposed to
    // never having been gated at all, e.g. because no approvers were
    // configured for this system when it was created).
    const fullyApprovedIds = new Set((autoPostedRes.data ?? []).filter((r) => !r.auto_posted).map((r) => r.reference_id))

    const billsList = billsRes.data ?? []
    const billNumberById = Object.fromEntries(billsList.map((b) => [b.id, b.bill_number]))
    // The bill's CURRENT outstanding balance — used to stamp a payment's own
    // receipt PAID/PARTIAL, same logic as billOutstandingAfter elsewhere (a bill
    // fully settled today reads as "PAID" even on an older partial receipt).
    const billOutstandingById = Object.fromEntries(billsList.map((b) => [
      b.id, Math.max(Math.max(b.amount_pkr - (b.discount_amount ?? 0), 0) - (b.paid_amount ?? 0), 0),
    ]))
    const cards: TxnCard[] = []

    for (const b of billsList) {
      const net = Math.max(b.amount_pkr - (b.discount_amount ?? 0), 0)
      cards.push({
        id: `bill-${b.id}`, kind: 'bill', borderColor: 'border-emerald-500',
        typeLabel: null, partyName: consumersById[b.consumer_id] ?? b.consumer_id,
        docLabel: b.bill_number ? `Bill # ${b.bill_number}` : 'Bill',
        date: b.due_date ?? new Date(b.year, b.month - 1, 1).toISOString().slice(0, 10),
        description: b.description || `Water Bill — ${new Date(b.year, b.month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
        amount: net, badge: billBadge(b), note: null, created_at: b.created_at, billId: b.id,
        billOutstanding: Math.max(net - (b.paid_amount ?? 0), 0), billConsumerId: b.consumer_id,
      })
    }

    for (const p of paymentsRes.data ?? []) {
      const billNo = billNumberById[p.bill_id]
      cards.push({
        id: `payment-${p.id}`, kind: 'payment', borderColor: 'border-cyan-500',
        typeLabel: p.method ? p.method.charAt(0).toUpperCase() + p.method.slice(1) : 'Cash',
        partyName: consumersById[p.consumer_id] ?? p.consumer_id,
        docLabel: p.receipt_no ? `Receipt # ${p.receipt_no}` : 'Receipt',
        date: p.paid_date, description: billNo ? `Against Bill ${billNo}` : 'Payment received',
        amount: p.amount_pkr, badge: null, note: p.note, created_at: p.created_at,
        paymentId: p.id, billId: p.bill_id,
        paymentBillOutstandingNow: billOutstandingById[p.bill_id] ?? 0, paymentReceiptNo: p.receipt_no,
        paymentConsumerId: p.consumer_id, paymentMethod: p.method ?? 'cash', paymentNote: p.note,
      })
    }

    for (const v of vouchersRes.data ?? []) {
      // voucher_type also includes 'security_deposit' (posted from the bill form),
      // which isn't one of the 5 types in voucherConfig — fall back to a formatted
      // label instead of the raw snake_case value.
      const cfg = voucherConfig[v.voucher_type as VoucherType] as (typeof voucherConfig)[VoucherType] | undefined
      const fallbackLabel = v.voucher_type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
      // A security deposit is cash actually received — it should read as a Receipt
      // (same numbering as a bill payment), not its own separate internal voucher
      // series. The voucher_no still exists in the database for internal reference,
      // it just isn't the number shown to the user.
      const isSecurityDeposit = v.voucher_type === 'security_deposit'
      const docLabel = isSecurityDeposit
        ? (v.receipt_no ? `Receipt # ${v.receipt_no}` : 'Receipt')
        : (v.voucher_no ? `Voucher # ${v.voucher_no}` : 'Voucher')
      cards.push({
        id: `voucher-${v.id}`, kind: 'voucher', borderColor: isSecurityDeposit ? 'border-cyan-500' : 'border-slate-400',
        typeLabel: cfg?.label ?? fallbackLabel,
        partyName: v.party_name || cfg?.label || fallbackLabel,
        docLabel,
        date: v.voucher_date, description: v.particular, amount: v.amount_pkr,
        badge: null, note: null, created_at: v.created_at, voucherId: v.id,
        voucherType: v.voucher_type, autoPosted: autoPostedIds.has(v.id), fullyApproved: fullyApprovedIds.has(v.id),
      })
    }

    for (const d of donationsRes.data ?? []) {
      cards.push({
        id: `donation-${d.id}`, kind: 'donation', borderColor: 'border-violet-500',
        typeLabel: d.payment_method ? d.payment_method.charAt(0).toUpperCase() + d.payment_method.slice(1) : null,
        partyName: d.is_anonymous ? 'Anonymous Donor' : d.name,
        docLabel: 'Donation', date: d.date, description: d.notes || 'Donation received',
        amount: d.amount_pkr, badge: null, note: null, created_at: d.created_at, donationId: d.id,
      })
    }

    const purchasesList = purchasesRes.data ?? []
    let purchaseLinesByPurchase: Record<string, { description: string; quantity: number; unitPrice: number }[]> = {}
    if (purchasesList.length > 0) {
      const { data: purchaseLineRows } = await supabase
        .from('inventory_transactions')
        .select('purchase_id, quantity, unit_cost_at_time, inventory_items(name)')
        .in('purchase_id', purchasesList.map((p) => p.id))
      purchaseLinesByPurchase = {}
      for (const r of purchaseLineRows ?? []) {
        const pid = r.purchase_id as string
        if (!purchaseLinesByPurchase[pid]) purchaseLinesByPurchase[pid] = []
        purchaseLinesByPurchase[pid].push({
          description: (r.inventory_items as unknown as { name: string } | null)?.name ?? 'Item',
          quantity: r.quantity, unitPrice: r.unit_cost_at_time ?? 0,
        })
      }
    }

    for (const p of purchasesList) {
      const lines = purchaseLinesByPurchase[p.id] ?? []
      const total = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
      cards.push({
        id: `purchase-${p.id}`, kind: 'purchase', borderColor: 'border-amber-500',
        typeLabel: p.method.charAt(0).toUpperCase() + p.method.slice(1),
        partyName: p.vendor || 'Purchase',
        docLabel: 'Purchase Bill',
        date: p.purchase_date, description: lines.length > 0 ? `${lines.length} item${lines.length > 1 ? 's' : ''} purchased` : (p.note || 'Inventory purchase'),
        amount: total, badge: null, note: p.note, created_at: p.created_at, purchaseId: p.id,
        purchaseLineItems: lines, autoPosted: autoPostedIds.has(p.id), fullyApproved: fullyApprovedIds.has(p.id),
      })
    }

    cards.sort((a, b) => (ascending
      ? new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      : new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
    setTxnCards(cards.slice(0, 50))
    setLoading(false)
  }, [system, supabase, logSortDir])

  useEffect(() => { load() }, [load])

  // A consumer can only ever have one active recurring bill — checked here so the
  // Set Recurring checkbox can be disabled up front, instead of only failing at
  // save time (the DB has the same guard as a hard backstop either way).
  useEffect(() => {
    if (!billForm.consumer_id) { setExistingRecurring(null); return }
    supabase.from('recurring_schedules').select('frequency, amount_pkr')
      .eq('consumer_id', billForm.consumer_id).eq('schedule_type', 'bill').eq('is_active', true)
      .maybeSingle()
      .then(({ data }) => setExistingRecurring(data as { frequency: Frequency; amount_pkr: number } | null))
  }, [billForm.consumer_id, supabase])

  const applyDefaultTemplate = useCallback((consumerId: string) => {
    const c = consumers.find((x) => x.consumer_id === consumerId)
    const connections = c?.connections || 1
    const lines: BillLine[] = defaultTemplateItems.map((ti) => {
      if (ti.item_type === 'inventory') {
        const item = inventoryItems.find((i) => i.id === ti.inventory_item_id)
        return { item_type: 'inventory', inventory_item_id: ti.inventory_item_id, service_item_id: null, charge_account_id: null, description: item?.name ?? 'Inventory item', quantity: ti.quantity * connections, unit_price: item?.unit_price ?? 0, is_recurring: false, discount_pct: 0 }
      }
      const item = serviceItems.find((i) => i.id === ti.service_item_id)
      // Service items pulled from the default connection template represent the
      // monthly water/connection charge — recurring by default. A physical item
      // (a meter, pipe) is a one-off cost even when it comes from the same template.
      return { item_type: 'service', inventory_item_id: null, service_item_id: ti.service_item_id, charge_account_id: null, description: item?.name ?? 'Service', quantity: ti.quantity * connections, unit_price: item?.charge_amount ?? 0, is_recurring: true, discount_pct: 0 }
    })
    setBillLines(lines)
  }, [consumers, defaultTemplateItems, inventoryItems, serviceItems])

  useEffect(() => {
    if (system !== 'water_supply' || consumers.length === 0) return
    const action = searchParams.get('action')
    const consumerParam = searchParams.get('consumer')
    const billParam = searchParams.get('bill')
    if (action === 'generate_bill') {
      setActiveType('bill')
      // In edit mode the dedicated effect below loads the bill's actual saved line
      // items — applying the default template here would immediately overwrite them.
      if (!billParam && consumerParam && consumers.some((c) => c.consumer_id === consumerParam)) {
        setBillForm((f) => ({ ...f, consumer_id: consumerParam }))
        applyDefaultTemplate(consumerParam)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, consumers.length, defaultTemplateItems.length])

  useEffect(() => {
    const billParam = searchParams.get('bill')
    if (system !== 'water_supply' || !billParam) return
    setEditLoading(true)
    ;(async () => {
      const [{ data: bill }, { data: lines }] = await Promise.all([
        supabase.from('bills')
          .select('id, bill_number, consumer_id, month, year, discount_amount, security_deposit_amount, security_deposit_voucher_id, due_date, description, paid_amount, recurring_schedule_id, attachment_url')
          .eq('id', billParam).single(),
        supabase.from('bill_line_items')
          .select('item_type, inventory_item_id, service_item_id, charge_account_id, description, quantity, unit_price, is_recurring, discount_pct')
          .eq('bill_id', billParam).order('created_at'),
      ])
      if (!bill) { toast.error('Bill not found'); setEditLoading(false); return }
      setEditingBill({
        id: bill.id, bill_number: bill.bill_number, paid_amount: bill.paid_amount ?? 0,
        security_deposit_voucher_id: bill.security_deposit_voucher_id, recurring_schedule_id: bill.recurring_schedule_id,
      })
      if ((bill.paid_amount ?? 0) > 0) {
        const { data: pays } = await supabase.from('payments').select('receipt_no').eq('bill_id', billParam).order('created_at')
        setLockedReceipts((pays ?? []).map((p) => p.receipt_no).filter(Boolean) as string[])
      } else {
        setLockedReceipts([])
      }
      setBillForm({
        consumer_id: bill.consumer_id, month: bill.month, year: bill.year,
        due_date: bill.due_date ?? '', description: bill.description ?? '',
        discount_amount: bill.discount_amount ?? 0, security_deposit_amount: bill.security_deposit_amount ?? 0,
        deposit_account_id: '', attachment_url: bill.attachment_url ?? '',
      })
      const loadedLines = (lines ?? []).map((l) => ({
        item_type: l.item_type as BillLine['item_type'], inventory_item_id: l.inventory_item_id,
        service_item_id: l.service_item_id, charge_account_id: l.charge_account_id,
        description: l.description, quantity: l.quantity,
        unit_price: l.unit_price, is_recurring: l.is_recurring, discount_pct: l.discount_pct ?? 0,
      }))
      setBillLines(loadedLines)
      // Older bills (before per-item discount existed) only ever had the one manual
      // total-discount field — infer which mode this bill was actually built with.
      setDiscountMode(loadedLines.some((l) => l.discount_pct > 0) ? 'per_item' : (bill.discount_amount ?? 0) > 0 ? 'on_total' : 'per_item')
      setActiveType('bill')
      setEditLoading(false)
    })()
  }, [system, searchParams, supabase])

  const deletePayment = async () => {
    if (!confirmDeletePaymentId) return
    const { error } = await supabase.from('payments').delete().eq('id', confirmDeletePaymentId)
    if (error) { toast.error(error.message); setConfirmDeletePaymentId(null); return }
    toast.success('Payment deleted')
    setConfirmDeletePaymentId(null)
    load()
  }

  const openEditPayment = (card: TxnCard) => {
    if (!card.paymentId || !card.billId || !card.paymentConsumerId) return
    setEditPaymentTarget({ id: card.paymentId, billId: card.billId, consumerId: card.paymentConsumerId, receiptNo: card.paymentReceiptNo ?? null })
    setEditPaymentForm({
      amount: card.amount, method: (card.paymentMethod as typeof editPaymentForm.method) ?? 'cash',
      date: card.date, note: card.paymentNote ?? '',
    })
  }

  // A payment has no UPDATE trigger of its own — the proven, already-used pattern
  // (this same fix was made manually earlier for an overpayment) is delete-then-
  // reinsert, which correctly reverses and reapplies the ledger and bill status via
  // the existing delete/insert triggers. The old receipt_no is passed through
  // explicitly so the consumer's receipt number never changes just from an edit.
  const saveEditPayment = async () => {
    if (!editPaymentTarget) return
    if (!editPaymentForm.amount || editPaymentForm.amount <= 0) { toast.error('Enter a valid amount'); return }
    setEditPaymentSaving(true)
    const { error: delErr } = await supabase.from('payments').delete().eq('id', editPaymentTarget.id)
    if (delErr) { toast.error(delErr.message); setEditPaymentSaving(false); return }
    const { error: insErr } = await supabase.from('payments').insert({
      bill_id: editPaymentTarget.billId, consumer_id: editPaymentTarget.consumerId,
      amount_pkr: editPaymentForm.amount, method: editPaymentForm.method,
      paid_date: editPaymentForm.date, note: editPaymentForm.note || null,
      receipt_no: editPaymentTarget.receiptNo,
    })
    setEditPaymentSaving(false)
    if (insErr) { toast.error(`Could not save the correction: ${insErr.message}`); return }
    toast.success('Payment updated')
    setEditPaymentTarget(null)
    load()
  }

  // Lets an accountant receive payment against a still-outstanding bill directly
  // from its Recent Transactions card, instead of having to open Edit Bill first.
  // A payment's own View action must show its cash receipt, not the bill's
  // invoice document — the two are separate transactions/documents even though
  // they're related. billOutstandingAfter drives the receipt's PAID/PARTIAL stamp.
  const openPaymentReceipt = (card: TxnCard) => {
    if (!card.paymentId) return
    const outstanding = card.paymentBillOutstandingNow ?? 0
    setViewReceipt({
      kind: 'payment',
      receiptNo: card.paymentReceiptNo ?? card.paymentId.slice(0, 8).toUpperCase(),
      date: card.date,
      systemLabel: systemLabels[system],
      accountName: card.partyName,
      particular: card.description,
      amount: card.amount,
      balanceAfter: outstanding,
      billOutstandingAfter: outstanding,
    })
  }

  const openPurchaseReceipt = (card: TxnCard) => {
    if (!card.purchaseId) return
    setViewReceipt({
      kind: 'purchase_payment',
      receiptNo: card.purchaseId.slice(0, 8).toUpperCase(),
      date: card.date,
      systemLabel: systemLabels[system],
      accountName: card.partyName,
      particular: card.note || card.description,
      amount: card.amount,
      balanceAfter: 0,
      lineItems: card.purchaseLineItems,
    })
  }

  const openQuickReceivePayment = (card: TxnCard) => {
    if (!card.billId || !card.billConsumerId) return
    const outstanding = card.billOutstanding ?? 0
    setReceivePaymentTarget({ billId: card.billId, billNumber: card.docLabel, consumerId: card.billConsumerId, outstanding })
    setQuickPayAmount(outstanding)
    setQuickPayMethod('cash')
  }

  const saveQuickPayment = async () => {
    if (!receivePaymentTarget) return
    if (!quickPayAmount || quickPayAmount <= 0) { toast.error('Enter a valid amount'); return }
    setQuickPaySaving(true)
    const { error } = await supabase.from('payments').insert({
      bill_id: receivePaymentTarget.billId, consumer_id: receivePaymentTarget.consumerId,
      amount_pkr: quickPayAmount, method: quickPayMethod,
    })
    setQuickPaySaving(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Payment of Rs. ${fmtAmount(quickPayAmount)} recorded`)
    setReceivePaymentTarget(null)
    load()
  }

  const types: { key: ActiveType; label: string; icon: typeof Wallet }[] = useMemo(() => {
    const base: { key: ActiveType; label: string; icon: typeof Wallet }[] = [
      { key: 'expense', label: 'Expense', icon: voucherConfig.expense.icon },
      { key: 'income', label: 'Income', icon: voucherConfig.income.icon },
      { key: 'contra', label: 'Bank Transfer', icon: voucherConfig.contra.icon },
      { key: 'withdrawal', label: 'Cash Withdrawal', icon: voucherConfig.withdrawal.icon },
      { key: 'deposit', label: 'Cash Deposit', icon: voucherConfig.deposit.icon },
    ]
    if (system === 'water_supply') {
      base.push({ key: 'bill', label: 'Generate Bill', icon: Receipt })
      base.push({ key: 'purchase', label: 'Purchase Bill', icon: ShoppingCart })
    } else {
      base.push({ key: 'donation', label: 'Record Donation', icon: Heart })
    }
    return base
  }, [system])

  const activeTypeLabel = types.find((t) => t.key === activeType)?.label ?? activeType
  const visibleTxnCards = useMemo(() => {
    if (!filterLogByType) return txnCards
    return txnCards.filter((c) => {
      if (activeType === 'bill') return c.kind === 'bill'
      if (activeType === 'donation') return c.kind === 'donation'
      if (activeType === 'purchase') return c.kind === 'purchase'
      return c.kind === 'voucher' && c.voucherType === activeType
    })
  }, [txnCards, activeType, filterLogByType])

  const selectType = (t: ActiveType) => {
    setActiveType(t)
    setVoucherForm(emptyVoucherForm)
    setBillForm(emptyBillForm)
    setDonationForm(emptyDonationForm)
    setBillLines([])
    setNewLine(emptyNewLine)
    setRecurringEnabled(false)
    setRecurringFrequency('monthly')
    setSavedBill(null)
    setPurchaseForm(emptyPurchaseForm)
    setPurchaseLines([])
    setNewPurchaseLine(emptyNewPurchaseLine)
    setReceivePaymentNow(false)
    setPaymentAmount(0)
    setPaymentMethod('cash')
    setReceiveDepositNow(false)
    setDiscountMode('per_item')
    setShowOtherCharge(false)
    setOtherChargeAccountId('')
    setOtherChargeDescription('')
    setOtherChargeAmount(0)
    setEditingBill(null)
  }

  const billTotal = useMemo(() => billLines.reduce((s, l) => s + l.quantity * l.unit_price, 0), [billLines])
  // Per Item mode: each line's own % discount is summed into the bill's total
  // discount automatically — there's no separate manual field to keep in sync.
  // On Total mode: the one manual discount_amount field, exactly as before.
  const perItemDiscountTotal = useMemo(
    () => billLines.reduce((s, l) => s + (l.quantity * l.unit_price * (l.discount_pct || 0)) / 100, 0),
    [billLines]
  )
  const effectiveDiscountAmount = discountMode === 'per_item' ? perItemDiscountTotal : (billForm.discount_amount || 0)
  const billNet = Math.max(billTotal - effectiveDiscountAmount, 0)
  // What a recurring copy of this bill would actually charge next period — only the
  // lines marked recurring, never a one-off new-connection charge, meter, or the
  // security deposit (which isn't a line item at all).
  const recurringSubtotal = useMemo(() => billLines.filter((l) => l.is_recurring).reduce((s, l) => s + l.quantity * l.unit_price, 0), [billLines])
  const recurringNet = Math.max(recurringSubtotal - effectiveDiscountAmount, 0)

  // The two discount modes are mutually exclusive — switching clears whatever the
  // other mode had set, so a per-item discount and a total discount can never
  // silently combine into a wrong number.
  const switchDiscountMode = (mode: 'per_item' | 'on_total') => {
    if (mode !== discountMode) {
      if (mode === 'on_total') setBillLines(billLines.map((l) => ({ ...l, discount_pct: 0 })))
      else setBillForm({ ...billForm, discount_amount: 0 })
      setDiscountMode(mode)
    }
    setShowDiscountModePicker(false)
  }

  const addCatalogLine = () => {
    // Manually added items (a new connection charge, an extra meter, an ad-hoc
    // service) default to one-off — only the auto-populated monthly service charge
    // from the connection template defaults to recurring. The checkbox in the table
    // lets the accountant override either way.
    if (newLine.kind === 'custom') {
      if (!newLine.description.trim()) { toast.error('Enter a description'); return }
      if (billLines.some((l) => l.item_type === 'custom' && l.description.trim().toLowerCase() === newLine.description.trim().toLowerCase())) {
        toast.error(`"${newLine.description.trim()}" is already on this bill — edit that line's quantity instead of adding it twice`); return
      }
      setBillLines([...billLines, { item_type: 'custom', inventory_item_id: null, service_item_id: null, charge_account_id: null, description: newLine.description, quantity: newLine.quantity || 1, unit_price: newLine.unit_price || 0, is_recurring: false, discount_pct: 0 }])
    } else if (newLine.kind === 'inventory') {
      const item = inventoryItems.find((i) => i.id === newLine.itemId)
      if (!item) { toast.error('Choose an inventory item'); return }
      if (billLines.some((l) => l.item_type === 'inventory' && l.inventory_item_id === item.id)) {
        toast.error(`${item.name} is already on this bill — edit that line's quantity instead of adding it twice`); return
      }
      setBillLines([...billLines, { item_type: 'inventory', inventory_item_id: item.id, service_item_id: null, charge_account_id: null, description: item.name, quantity: newLine.quantity || 1, unit_price: item.unit_price, is_recurring: false, discount_pct: 0 }])
    } else {
      const item = serviceItems.find((i) => i.id === newLine.itemId)
      if (!item) { toast.error('Choose a service'); return }
      if (billLines.some((l) => l.item_type === 'service' && l.service_item_id === item.id)) {
        toast.error(`${item.name} is already on this bill — edit that line's quantity instead of adding it twice`); return
      }
      setBillLines([...billLines, { item_type: 'service', inventory_item_id: null, service_item_id: item.id, charge_account_id: null, description: item.name, quantity: newLine.quantity || 1, unit_price: item.charge_amount, is_recurring: false, discount_pct: 0 }])
    }
    setNewLine(emptyNewLine)
  }

  const removeLine = (idx: number) => setBillLines(billLines.filter((_, i) => i !== idx))
  const updateLine = (idx: number, patch: Partial<BillLine>) =>
    setBillLines(billLines.map((l, i) => (i === idx ? { ...l, ...patch } : l)))

  // Other charges (cartage, a new-connection fee, anything not a stocked/service
  // item) post to their own chosen account instead of the generic Water Bill
  // Income account — the consumer still owes the same gross total either way.
  const addOtherChargeLine = () => {
    if (!otherChargeAccountId) { toast.error('Choose an account for this charge'); return }
    if (!otherChargeAmount || otherChargeAmount <= 0) { toast.error('Enter a valid amount'); return }
    const account = accounts.find((a) => a.id === otherChargeAccountId)
    if (billLines.some((l) => l.item_type === 'other_charge' && l.charge_account_id === otherChargeAccountId)) {
      toast.error(`${account?.name ?? 'This account'} is already used for another charge on this bill — edit that line's amount instead of adding it twice`); return
    }
    setBillLines([...billLines, {
      item_type: 'other_charge', inventory_item_id: null, service_item_id: null, charge_account_id: otherChargeAccountId,
      description: otherChargeDescription.trim() || account?.name || 'Other Charge', quantity: 1, unit_price: otherChargeAmount,
      is_recurring: false, discount_pct: 0,
    }])
    setOtherChargeAccountId('')
    setOtherChargeDescription('')
    setOtherChargeAmount(0)
  }

  // Lets the accountant create a new charge category on the fly (e.g. "Late
  // Payment Surcharge") instead of being limited to whatever's already in the
  // chart of accounts — mirrors the reference flow's "+ Add New" in the charge picker.
  const createChargeAccount = async () => {
    if (!newChargeAccountName.trim()) { toast.error('Enter a name'); return }
    const code = `${system === 'water_supply' ? 'WS' : 'DP'}-OC-${Date.now().toString(36).toUpperCase()}`
    const { data, error } = await supabase.from('accounts')
      .insert({ code, name: newChargeAccountName.trim(), type: 'income', system })
      .select('id, name, type, code, system').single()
    if (error) { toast.error(error.message); return }
    setAccounts([...accounts, { id: data.id, name: data.name, name_ur: null, type: data.type, code: data.code, system: data.system }])
    setOtherChargeAccountId(data.id)
    setNewChargeAccountName('')
    setShowAddChargeAccount(false)
    toast.success('Charge account created')
  }

  const saveVoucher = async () => {
    const cfg = voucherConfig[activeType as VoucherType]
    if (!voucherForm.fromId || !voucherForm.toId) { toast.error(`Choose both ${cfg.fromLabel} and ${cfg.toLabel}`); return }
    if (voucherForm.fromId === voucherForm.toId) { toast.error('From and To accounts must be different'); return }
    if (!voucherForm.amount || voucherForm.amount <= 0) { toast.error('Enter a valid amount'); return }
    if (!voucherForm.particular.trim()) { toast.error('Description is required'); return }
    setSaving(true)
    // voucher_no/status are decided by a DB trigger — expense and withdrawal vouchers
    // come back 'pending' with no number until every configured approver for this
    // system confirms (or 24 hours pass), at which point it auto-posts. See migration 060.
    const { data: saved, error } = await supabase.from('vouchers').insert({
      system, voucher_type: activeType, voucher_date: voucherForm.date,
      particular: voucherForm.particular, amount_pkr: voucherForm.amount,
      from_account_id: voucherForm.fromId, to_account_id: voucherForm.toId,
      party_name: voucherForm.party || null,
    }).select('id, voucher_type, voucher_date, particular, amount_pkr, status, voucher_no').single()
    setSaving(false)
    if (error) { toast.error(error.message); return }
    if (saved.status === 'pending') {
      toast.success('Saved — awaiting approval before it posts')
    } else {
      toast.success(`Saved (${saved.voucher_no})`)
    }
    setVoucherForm({ ...emptyVoucherForm, date: voucherForm.date })
    load()
  }

  const saveBill = async () => {
    if (!billForm.consumer_id) { toast.error('Choose a consumer'); return }
    if (billLines.length === 0) { toast.error('Add at least one billing item — a connection charge, service, or custom charge'); return }
    if (billTotal <= 0) { toast.error('The bill total must be greater than zero'); return }
    if (effectiveDiscountAmount > billTotal) { toast.error('Discount cannot exceed the bill total'); return }
    if (receiveDepositNow && !billForm.deposit_account_id) { toast.error('Choose where the security deposit is received into'); return }
    if (recurringEnabled && recurringSubtotal <= 0) { toast.error('None of the current items are marked "Recurring" — nothing would be re-billed next period'); return }
    if (recurringEnabled && existingRecurring) { toast.error('This consumer already has an active recurring bill — manage it from Recurring Schedules instead of creating a second one'); return }
    if (receivePaymentNow && (!paymentAmount || paymentAmount <= 0)) { toast.error('Enter a valid payment amount'); return }
    setSaving(true)

    const { data: bill, error } = await supabase.from('bills').insert({
      consumer_id: billForm.consumer_id, month: billForm.month, year: billForm.year,
      amount_pkr: billTotal, due_date: billForm.due_date || null, description: billForm.description || null,
      discount_amount: effectiveDiscountAmount, security_deposit_amount: billForm.security_deposit_amount || 0,
      attachment_url: billForm.attachment_url || null,
    }).select('id, bill_number').single()

    if (error) {
      setSaving(false)
      toast.error(error.code === '23505' ? 'A bill for this consumer and month already exists — edit it from Billing Management instead.' : error.message)
      return
    }

    const lineErrors: string[] = []
    for (const l of billLines) {
      const { error: lineErr } = await supabase.from('bill_line_items').insert({
        bill_id: bill.id, item_type: l.item_type,
        inventory_item_id: l.item_type === 'inventory' ? l.inventory_item_id : null,
        service_item_id: l.item_type === 'service' ? l.service_item_id : null,
        charge_account_id: l.item_type === 'other_charge' ? l.charge_account_id : null,
        description: l.description, quantity: l.quantity, unit_price: l.unit_price, is_recurring: l.is_recurring,
        discount_pct: discountMode === 'per_item' ? l.discount_pct || 0 : 0,
        discount_value: discountMode === 'per_item' ? l.quantity * l.unit_price * (l.discount_pct || 0) / 100 : 0,
      })
      if (lineErr) lineErrors.push(`${l.description}: ${lineErr.message}`)
    }
    if (lineErrors.length > 0) toast.error(`Some items could not be billed — ${lineErrors.join('; ')}`)

    // Cash only moves when explicitly received (checkbox), never as a silent side
    // effect of generating the bill. Leaving it unchecked just records the promised
    // deposit amount on the bill (shown on the invoice) with no voucher/ledger
    // posting at all — the same way an unpaid bill amount just sits unpaid until
    // someone deliberately receives it. Editing the bill later offers this same
    // checkbox to receive it whenever it's actually collected.
    if (receiveDepositNow && billForm.security_deposit_amount > 0) {
      const consumerName = consumers.find((c) => c.consumer_id === billForm.consumer_id)?.name ?? billForm.consumer_id
      const depositAccountCode = system === 'water_supply' ? 'WS-5002' : 'DP-5003'
      const depositLiabilityId = accounts.find((a) => a.code === depositAccountCode)?.id
      const { data: depositVoucher, error: depErr } = await supabase.from('vouchers').insert({
        system, voucher_type: 'security_deposit', voucher_date: billForm.due_date || today(),
        particular: `Security deposit — ${consumerName} — Bill ${bill.bill_number}`,
        amount_pkr: billForm.security_deposit_amount, bill_id: bill.id,
        from_account_id: depositLiabilityId, to_account_id: billForm.deposit_account_id,
      }).select('id').single()
      if (depErr) toast.error(`Security deposit could not be recorded: ${depErr.message}`)
      else await supabase.from('bills').update({ security_deposit_voucher_id: depositVoucher.id }).eq('id', bill.id)
    }

    if (recurringEnabled) {
      // The testing frequency counts forward from right now (so it's actually
      // verifiable within a session) — every other frequency counts forward from
      // the billed period, same as before.
      const next = recurringFrequency === 'every_minute' ? new Date() : new Date(billForm.year, billForm.month - 1, 1)
      if (recurringFrequency === 'every_minute') next.setMinutes(next.getMinutes() + 1)
      else if (recurringFrequency === 'daily') next.setDate(next.getDate() + 1)
      else if (recurringFrequency === 'weekly') next.setDate(next.getDate() + 7)
      else if (recurringFrequency === 'monthly') next.setMonth(next.getMonth() + 1)
      else if (recurringFrequency === 'semi_annual') next.setMonth(next.getMonth() + 6)
      else next.setFullYear(next.getFullYear() + 1)
      const dueOffsetDays = billForm.due_date
        ? Math.round((new Date(billForm.due_date).getTime() - new Date(billForm.year, billForm.month - 1, 1).getTime()) / 86400000)
        : null
      // Only the recurring-flagged lines carry forward — never the security deposit,
      // and never a one-off charge like a new connection fee or a meter.
      const recurringAmount = recurringNet > 0 ? recurringNet : recurringSubtotal
      const { error: recErr } = await supabase.from('recurring_schedules').insert({
        system, schedule_type: 'bill', frequency: recurringFrequency,
        next_run_date: next.toISOString(), consumer_id: billForm.consumer_id,
        amount_pkr: recurringAmount, due_date_offset_days: dueOffsetDays, particular: billForm.description || null,
      })
      if (recErr) toast.error(recErr.code === '23505' ? 'This consumer already has an active recurring bill — manage it from Recurring Schedules instead' : `Recurring schedule could not be created: ${recErr.message}`)
      else toast.success(`Recurring ${frequencyLabels[recurringFrequency].toLowerCase()} bill scheduled — Rs. ${fmtAmount(recurringAmount)}/period`)
    }

    if (receivePaymentNow) {
      const { error: payErr } = await supabase.from('payments').insert({
        bill_id: bill.id, consumer_id: billForm.consumer_id, amount_pkr: paymentAmount, method: paymentMethod,
      })
      if (payErr) toast.error(`Payment could not be recorded: ${payErr.message}`)
      else toast.success(`Payment of Rs. ${fmtAmount(paymentAmount)} recorded`)
    }

    setSaving(false)
    toast.success(`Bill ${bill.bill_number} generated`)
    setSavedBill(bill)
    setBillForm(emptyBillForm)
    setBillLines([])
    setRecurringEnabled(false)
    setReceivePaymentNow(false)
    setPaymentAmount(0)
    setReceiveDepositNow(false)
    setDiscountMode('per_item')
    setShowOtherCharge(false)
    setOtherChargeAccountId('')
    setOtherChargeDescription('')
    setOtherChargeAmount(0)
    load()
  }

  const updateBill = async () => {
    if (!editingBill) return
    if (billLines.length === 0) { toast.error('Add at least one billing item — a connection charge, service, or custom charge'); return }
    if (billTotal <= 0) { toast.error('The bill total must be greater than zero'); return }
    if (effectiveDiscountAmount > billTotal) { toast.error('Discount cannot exceed the bill total'); return }
    if (!editingBill.security_deposit_voucher_id && receiveDepositNow && !billForm.deposit_account_id) {
      toast.error('Choose where the security deposit is received into'); return
    }
    if (receivePaymentNow && (!paymentAmount || paymentAmount <= 0)) { toast.error('Enter a valid payment amount'); return }
    setSaving(true)

    const { error } = await supabase.from('bills').update({
      month: billForm.month, year: billForm.year, due_date: billForm.due_date || null,
      description: billForm.description || null, discount_amount: effectiveDiscountAmount,
      attachment_url: billForm.attachment_url || null,
      // A deposit already recorded as its own voucher is locked here — changing it
      // is a separate transaction the accountant makes explicitly (delete the
      // voucher, then re-add the deposit), not a side effect of editing the bill.
      ...(editingBill.security_deposit_voucher_id ? {} : { security_deposit_amount: billForm.security_deposit_amount || 0 }),
    }).eq('id', editingBill.id)

    if (error) {
      setSaving(false)
      toast.error(error.code === '23505' ? 'A bill for this consumer and month already exists.' : error.message)
      return
    }

    // Delete-then-reinsert: the existing bill_line_items triggers reverse any
    // inventory usage on delete and reapply it on insert, and recompute amount_pkr
    // (which reposts the bill's own ledger entries), exactly like on create.
    await supabase.from('bill_line_items').delete().eq('bill_id', editingBill.id)
    const lineErrors: string[] = []
    for (const l of billLines) {
      const { error: lineErr } = await supabase.from('bill_line_items').insert({
        bill_id: editingBill.id, item_type: l.item_type,
        inventory_item_id: l.item_type === 'inventory' ? l.inventory_item_id : null,
        service_item_id: l.item_type === 'service' ? l.service_item_id : null,
        charge_account_id: l.item_type === 'other_charge' ? l.charge_account_id : null,
        description: l.description, quantity: l.quantity, unit_price: l.unit_price, is_recurring: l.is_recurring,
        discount_pct: discountMode === 'per_item' ? l.discount_pct || 0 : 0,
        discount_value: discountMode === 'per_item' ? l.quantity * l.unit_price * (l.discount_pct || 0) / 100 : 0,
      })
      if (lineErr) lineErrors.push(`${l.description}: ${lineErr.message}`)
    }
    if (lineErrors.length > 0) toast.error(`Some items could not be billed — ${lineErrors.join('; ')}`)

    if (!editingBill.security_deposit_voucher_id && receiveDepositNow && billForm.security_deposit_amount > 0) {
      const consumerName = consumers.find((c) => c.consumer_id === billForm.consumer_id)?.name ?? billForm.consumer_id
      const depositAccountCode = system === 'water_supply' ? 'WS-5002' : 'DP-5003'
      const depositLiabilityId = accounts.find((a) => a.code === depositAccountCode)?.id
      const { data: depositVoucher, error: depErr } = await supabase.from('vouchers').insert({
        system, voucher_type: 'security_deposit', voucher_date: billForm.due_date || today(),
        particular: `Security deposit — ${consumerName} — Bill ${editingBill.bill_number}`,
        amount_pkr: billForm.security_deposit_amount, bill_id: editingBill.id,
        from_account_id: depositLiabilityId, to_account_id: billForm.deposit_account_id,
      }).select('id').single()
      if (depErr) toast.error(`Security deposit could not be recorded: ${depErr.message}`)
      else await supabase.from('bills').update({ security_deposit_voucher_id: depositVoucher.id }).eq('id', editingBill.id)
    }

    if (receivePaymentNow) {
      const { error: payErr } = await supabase.from('payments').insert({
        bill_id: editingBill.id, consumer_id: billForm.consumer_id, amount_pkr: paymentAmount, method: paymentMethod,
      })
      if (payErr) toast.error(`Payment could not be recorded: ${payErr.message}`)
      else toast.success(`Payment of Rs. ${fmtAmount(paymentAmount)} recorded`)
    }

    setSaving(false)
    toast.success(`Bill ${editingBill.bill_number} updated`)
    router.push(`/admin/invoice/bill/${editingBill.id}`)
  }

  const purchaseTotal = useMemo(() => purchaseLines.reduce((s, l) => s + l.quantity * l.unit_cost, 0), [purchaseLines])

  const addPurchaseLine = () => {
    const item = inventoryItems.find((i) => i.id === newPurchaseLine.itemId)
    if (!item) { toast.error('Choose an inventory item'); return }
    if (!newPurchaseLine.quantity || newPurchaseLine.quantity <= 0) { toast.error('Enter a valid quantity'); return }
    if (purchaseLines.some((l) => l.inventory_item_id === item.id)) {
      toast.error(`${item.name} is already on this purchase — edit that line's quantity instead of adding it twice`); return
    }
    setPurchaseLines([...purchaseLines, { inventory_item_id: item.id, description: item.name, quantity: newPurchaseLine.quantity, unit_cost: newPurchaseLine.unit_cost || item.unit_cost }])
    setNewPurchaseLine(emptyNewPurchaseLine)
  }
  const removePurchaseLine = (idx: number) => setPurchaseLines(purchaseLines.filter((_, i) => i !== idx))
  const updatePurchaseLine = (idx: number, patch: Partial<PurchaseLine>) =>
    setPurchaseLines(purchaseLines.map((l, i) => (i === idx ? { ...l, ...patch } : l)))

  const savePurchaseBill = async () => {
    if (purchaseLines.length === 0) { toast.error('Add at least one item to the purchase bill'); return }
    setSaving(true)

    // A header row groups this purchase's line items into one document (so it can
    // carry a single attachment), the same way a bill groups its own line items.
    // Line items stage in purchase_line_items (not inventory_transactions directly
    // anymore) — they're only materialized into real stock/ledger movements once
    // every configured approver confirms (or 24 hours pass), via submit_purchase_for_approval.
    const { data: purchase, error: purchaseErr } = await supabase.from('purchases').insert({
      system, vendor: purchaseForm.vendor || null, purchase_date: purchaseForm.date,
      method: purchaseForm.method, note: purchaseForm.note || null, attachment_url: purchaseForm.attachment_url || null,
    }).select('id').single()
    if (purchaseErr) { toast.error(purchaseErr.message); setSaving(false); return }

    const errors: string[] = []
    for (const l of purchaseLines) {
      const { error } = await supabase.from('purchase_line_items').insert({
        purchase_id: purchase.id, inventory_item_id: l.inventory_item_id,
        description: l.description, quantity: l.quantity, unit_cost: l.unit_cost,
      })
      if (error) errors.push(`${l.description}: ${error.message}`)
    }
    if (errors.length > 0) toast.error(`Some items could not be recorded — ${errors.join('; ')}`)
    if (errors.length < purchaseLines.length) {
      const { error: submitErr } = await supabase.rpc('submit_purchase_for_approval', { p_purchase_id: purchase.id })
      if (submitErr) toast.error(submitErr.message)
      else toast.success(`Purchase bill Rs. ${fmtAmount(purchaseTotal)} saved — awaiting approval before it posts to stock`)
      setPurchaseForm(emptyPurchaseForm)
      setPurchaseLines([])
      load()
    }
    setSaving(false)
  }

  const saveDonation = async () => {
    if (!donationForm.name.trim()) { toast.error('Donor name is required'); return }
    if (!donationForm.amount_pkr || donationForm.amount_pkr <= 0) { toast.error('Enter a valid amount'); return }
    setSaving(true)
    const { error } = await supabase.from('donors').insert({
      name: donationForm.name, name_ur: donationForm.name_ur || null, phone: donationForm.phone || null,
      donor_type: donationForm.donor_type, amount_pkr: donationForm.amount_pkr, date: donationForm.date,
      payment_method: donationForm.payment_method, project_id: donationForm.project_id || null,
      is_anonymous: donationForm.is_anonymous, is_verified: true,
    })
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('Donation recorded')
    setDonationForm(emptyDonationForm)
    load()
  }

  const deleteVoucher = async () => {
    if (!confirmDeleteVoucherId) return
    const { error } = await supabase.from('vouchers').delete().eq('id', confirmDeleteVoucherId)
    if (error) { toast.error(error.message); return }
    toast.success('Voucher deleted')
    setConfirmDeleteVoucherId(null)
    load()
  }

  // Bills with cash already received can't be deleted (the DB itself refuses) — check
  // for payments up front and name every receipt blocking it, rather than surfacing a
  // generic "N payment(s) recorded" error after the fact.
  const attemptDeleteBill = async (billId: string) => {
    const { data: pays } = await supabase.from('payments').select('receipt_no').eq('bill_id', billId).order('created_at')
    if (pays && pays.length > 0) {
      const { data: billRow } = await supabase.from('bills').select('bill_number').eq('id', billId).single()
      setBillDeleteBlock({ billNumber: billRow?.bill_number ?? null, receipts: pays.map((p) => p.receipt_no).filter(Boolean) as string[] })
      return
    }
    setConfirmDeleteBillId(billId)
  }

  const deleteBill = async () => {
    if (!confirmDeleteBillId) return
    const { error } = await supabase.from('bills').delete().eq('id', confirmDeleteBillId)
    if (error) { toast.error(error.message); setConfirmDeleteBillId(null); return }
    toast.success('Bill deleted')
    setConfirmDeleteBillId(null)
    load()
  }

  const accountPickerItems = (filter: (a: Account) => boolean) =>
    accounts.filter(filter).map((a) => ({
      id: a.id, label: a.name, sublabel: a.code,
      group: `${systemLabels[a.system as SystemTab] ?? a.system} — ${a.type.charAt(0).toUpperCase() + a.type.slice(1)}`,
    }))

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/admin/finance" className="flex items-center gap-2 text-dp-on-surface-variant hover:text-dp-primary font-sans text-[14px] font-semibold mb-3">
            <ArrowLeft size={16} /> Back
          </Link>
          <h1 className="font-heading text-[22px] sm:text-[28px] font-bold leading-[28px] sm:leading-[36px] text-dp-primary">{systemLabels[system]} — Transactions</h1>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <Link href={`/admin/finance/${system}/recurring`} className="flex items-center gap-2 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all">
            <Repeat size={15} /> Recurring
          </Link>
          <Link href={`/admin/finance/${system}/register`} className="flex items-center gap-2 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all">
            <BookOpen size={15} /> Daily Register
          </Link>
        </div>
      </div>

      {/* Transaction type — mobile menu button (opens a dropdown of the same options
          shown as a sidebar on desktop; a full-width stacked button list here read
          as an ugly wall of buttons pushed above the form on a phone) */}
      <div className="md:hidden relative mb-4">
        <button
          onClick={() => setMobileTypeMenuOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2.5 px-4 py-3.5 bg-white rounded-lg border-2 border-dp-primary font-sans text-[15px] font-bold text-dp-primary cursor-pointer"
        >
          <span className="flex items-center gap-2.5">
            {(() => { const ActiveIcon = types.find((t) => t.key === activeType)?.icon ?? Wallet; return <ActiveIcon size={18} /> })()}
            {activeTypeLabel}
          </span>
          <ChevronDown size={18} className={`transition-transform ${mobileTypeMenuOpen ? 'rotate-180' : ''}`} />
        </button>
        {mobileTypeMenuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMobileTypeMenuOpen(false)} />
            <div className="absolute z-50 top-full left-0 right-0 mt-1.5 bg-white rounded-lg border border-dp-outline-variant shadow-lg overflow-hidden max-h-[60vh] overflow-y-auto">
              {types.map((t) => {
                const Icon = t.icon
                const isActive = activeType === t.key
                return (
                  <button
                    key={t.key}
                    onClick={() => { selectType(t.key); setMobileTypeMenuOpen(false) }}
                    className={`w-full flex items-center gap-2.5 px-4 py-3.5 text-left font-sans text-[15px] font-bold border-b border-dp-outline-variant last:border-b-0 cursor-pointer transition-colors ${isActive ? 'bg-dp-primary text-white' : 'text-dp-on-surface hover:bg-dp-surface-container-low'}`}
                  >
                    <Icon size={18} className="shrink-0" /> {t.label}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-5">
        {/* Transaction type sidebar (desktop only — see mobile menu button above) */}
        <div className="hidden md:block md:w-56 shrink-0">
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            {types.map((t) => {
              const Icon = t.icon
              const isActive = activeType === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => selectType(t.key)}
                  className={`w-full flex items-center gap-2.5 px-4 py-3 text-left font-sans text-[14px] font-semibold border-b border-dp-outline-variant last:border-b-0 cursor-pointer transition-colors ${isActive ? 'bg-dp-primary text-white' : 'text-dp-on-surface hover:bg-dp-surface-container-low'}`}
                >
                  <Icon size={16} className="shrink-0" /> {t.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Form + log */}
        <div className="flex-1 space-y-5 min-w-0">
          <div className="bg-white rounded-lg border border-dp-outline-variant p-6">
            {(['expense', 'income', 'contra', 'withdrawal', 'deposit'] as VoucherType[]).includes(activeType as VoucherType) && (() => {
              const cfg = voucherConfig[activeType as VoucherType]
              return (
                <div className="space-y-4">
                  <h2 className="font-heading text-[20px] font-bold text-dp-primary">{cfg.label}</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Date</label>
                      <input type="date" value={voucherForm.date} onChange={(e) => setVoucherForm({ ...voucherForm, date: e.target.value })} className="input-field" />
                    </div>
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Amount (PKR)</label>
                      <input type="number" value={voucherForm.amount || ''} onChange={(e) => setVoucherForm({ ...voucherForm, amount: +e.target.value })} className="input-field" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <SearchableField
                      label={cfg.fromLabel} value={voucherForm.fromId} placeholder="Select..."
                      items={accountPickerItems(cfg.fromFilter)}
                      onChange={(id) => setVoucherForm({ ...voucherForm, fromId: id })}
                    />
                    <SearchableField
                      label={cfg.toLabel} value={voucherForm.toId} placeholder="Select..."
                      items={accountPickerItems(cfg.toFilter)}
                      onChange={(id) => setVoucherForm({ ...voucherForm, toId: id })}
                    />
                  </div>
                  {cfg.partyLabel && (
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{cfg.partyLabel}</label>
                      <input value={voucherForm.party} onChange={(e) => setVoucherForm({ ...voucherForm, party: e.target.value })} className="input-field" />
                    </div>
                  )}
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Description *</label>
                    <input value={voucherForm.particular} onChange={(e) => setVoucherForm({ ...voucherForm, particular: e.target.value })} className="input-field" placeholder="What is this transaction for?" />
                  </div>
                  <button disabled={saving} onClick={saveVoucher} className="flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    <Save size={16} /> Save {cfg.label}
                  </button>
                </div>
              )
            })()}

            {activeType === 'bill' && editLoading && (
              <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading bill...</div>
            )}

            {activeType === 'bill' && !editLoading && editingBill && editingBill.paid_amount > 0 && (
              <div className="space-y-4">
                <h2 className="font-heading text-[20px] font-bold text-dp-primary">Edit Bill {editingBill.bill_number}</h2>
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-4">
                  <p className="font-sans text-[14px] font-semibold text-dp-error mb-1.5">This bill can&apos;t be edited — cash has already been received against it.</p>
                  <p className="font-sans text-[13px] text-dp-on-surface-variant mb-3">
                    Delete {lockedReceipts.length > 1 ? 'these receipts' : 'this receipt'} first, then come back here to edit the bill:
                  </p>
                  {lockedReceipts.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      {lockedReceipts.map((r) => (
                        <span key={r} className="px-2.5 py-1 bg-white border border-red-200 rounded-full font-sans text-[12.5px] font-semibold text-dp-error">Receipt #{r}</span>
                      ))}
                    </div>
                  )}
                  <Link href={`/admin/invoice/bill/${editingBill.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    <FileText size={13} /> View Bill & Ledger Postings
                  </Link>
                </div>
              </div>
            )}

            {activeType === 'bill' && !editLoading && !(editingBill && editingBill.paid_amount > 0) && (
              <div className="space-y-4">
                <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editingBill ? `Edit Bill ${editingBill.bill_number}` : 'Generate Bill'}</h2>

                {editingBill && (
                  <div className="flex items-center justify-between gap-3 bg-dp-secondary/10 border border-dp-secondary/30 rounded-lg px-4 py-3">
                    <p className="font-sans text-[13.5px] font-semibold text-dp-primary">Editing an existing bill — consumer can&apos;t be changed here.</p>
                    <button onClick={() => { selectType('bill'); router.push('/admin/finance/water_supply?action=generate_bill') }} className="shrink-0 font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">Cancel</button>
                  </div>
                )}

                {savedBill && (
                  <div className="flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
                    <p className="font-sans text-[13.5px] font-semibold text-emerald-900">Bill {savedBill.bill_number} generated successfully</p>
                    <Link href={`/admin/invoice/bill/${savedBill.id}`} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                      <FileText size={13} /> View & Send Invoice
                    </Link>
                  </div>
                )}

                <SearchableField
                  label="Consumer"
                  value={billForm.consumer_id}
                  disabled={!!editingBill}
                  placeholder="Select consumer..."
                  pickerTitle="Select Consumer"
                  searchPlaceholder="Search by name or consumer ID..."
                  items={consumers.map((c) => ({ id: c.consumer_id, label: c.name, sublabel: c.consumer_id }))}
                  onChange={(id) => { setBillForm({ ...billForm, consumer_id: id }); applyDefaultTemplate(id) }}
                />

                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Billing Period</label>
                  <input
                    type="month"
                    value={billForm.month && billForm.year ? `${billForm.year}-${String(billForm.month).padStart(2, '0')}` : ''}
                    onChange={(e) => {
                      const [y, m] = e.target.value.split('-').map(Number)
                      setBillForm({ ...billForm, year: y, month: m })
                    }}
                    className="input-field"
                  />
                </div>

                {/* Line items — connections/services auto-pulled from the default template, plus anything added manually */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant">Billing Items</label>
                    <button
                      onClick={() => setShowDiscountModePicker(true)}
                      className="flex items-center gap-1.5 px-2.5 py-1 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold text-dp-secondary hover:bg-dp-surface-container-low transition-all cursor-pointer"
                    >
                      Discount: {discountMode === 'per_item' ? 'Per Item' : 'On Total'}
                    </button>
                  </div>
                  <div className="border border-dp-outline-variant rounded-lg overflow-hidden">
                    {billLines.length === 0 ? (
                      <p className="px-3 py-4 text-center font-sans text-[13px] text-dp-on-surface-variant">No items yet — choose a consumer or add one below.</p>
                    ) : (
                      <table className="w-full text-[13.5px]" style={{ tableLayout: 'fixed' }}>
                        <colgroup>
                          <col />
                          <col style={{ width: '64px' }} />
                          <col style={{ width: '88px' }} />
                          {discountMode === 'per_item' && <col style={{ width: '68px' }} />}
                          <col style={{ width: '96px' }} />
                          <col style={{ width: '72px' }} />
                          <col style={{ width: '32px' }} />
                        </colgroup>
                        <thead>
                          <tr className="bg-dp-surface-container-low/60 text-left text-dp-on-surface-variant text-[11.5px] font-semibold">
                            <th className="px-3 py-2">Description</th>
                            <th className="px-3 py-2 text-right">Qty</th>
                            <th className="px-3 py-2 text-right">Rate</th>
                            {discountMode === 'per_item' && <th className="px-3 py-2 text-right">Disc %</th>}
                            <th className="px-3 py-2 text-right">Amount</th>
                            <th className="px-3 py-2 text-center" title="Recharged automatically on each recurring bill">Recurring</th>
                            <th className="px-3 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {billLines.map((l, i) => {
                            const lineGross = l.quantity * l.unit_price
                            const lineDiscount = discountMode === 'per_item' ? (lineGross * (l.discount_pct || 0)) / 100 : 0
                            return (
                              <tr key={i} className="border-t border-dp-outline-variant">
                                <td className="px-3 py-2 truncate">{l.description}</td>
                                <td className="px-3 py-2">
                                  <input type="number" min={0.01} step="0.01" value={l.quantity} onChange={(e) => updateLine(i, { quantity: +e.target.value })} className="w-full text-right bg-white border-2 border-[#bfc9c4] rounded-md px-3 py-2.5 font-sans text-[15px] focus:border-dp-secondary focus:outline-none" />
                                </td>
                                <td className="px-3 py-2">
                                  <input type="number" min={0} step="0.01" value={l.unit_price} onChange={(e) => updateLine(i, { unit_price: +e.target.value })} className="w-full text-right bg-white border-2 border-[#bfc9c4] rounded-md px-3 py-2.5 font-sans text-[15px] focus:border-dp-secondary focus:outline-none" />
                                </td>
                                {discountMode === 'per_item' && (
                                  <td className="px-3 py-2">
                                    <input type="number" min={0} max={100} step="0.01" value={l.discount_pct || ''} onChange={(e) => updateLine(i, { discount_pct: +e.target.value })} className="w-full text-right bg-white border-2 border-[#bfc9c4] rounded-md px-3 py-2.5 font-sans text-[15px] focus:border-dp-secondary focus:outline-none" />
                                  </td>
                                )}
                                <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                                  {fmtAmount(lineGross - lineDiscount)}
                                  {lineDiscount > 0 && <span className="block text-[11px] font-normal text-emerald-700">− {fmtAmount(lineDiscount)}</span>}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <input type="checkbox" checked={l.is_recurring} onChange={(e) => updateLine(i, { is_recurring: e.target.checked })} className="accent-dp-secondary w-4 h-4 cursor-pointer" />
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <button onClick={() => removeLine(i)} className="text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={13} /></button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                    <div className="flex flex-wrap items-end gap-2 p-3 bg-dp-surface-container-low/40 border-t border-dp-outline-variant">
                      <div className="w-full sm:w-36 sm:shrink-0">
                        <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Type</label>
                        <select value={newLine.kind} onChange={(e) => setNewLine({ ...emptyNewLine, kind: e.target.value as typeof newLine.kind })} className="input-field !py-3 text-[15px]">
                          <option value="custom">Custom Charge</option>
                          <option value="inventory">Inventory Item</option>
                          <option value="service">Service</option>
                        </select>
                      </div>
                      {newLine.kind === 'custom' ? (
                        <>
                          <div className="w-full sm:flex-1 min-w-0">
                            <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Description</label>
                            <input value={newLine.description} onChange={(e) => setNewLine({ ...newLine, description: e.target.value })} placeholder="e.g. New Connection Charge" className="input-field !py-3 text-[15px]" />
                          </div>
                          <div className="flex-1 sm:flex-none sm:w-28 min-w-0">
                            <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Amount</label>
                            <input type="number" min={0} step="0.01" value={newLine.unit_price || ''} onChange={(e) => setNewLine({ ...newLine, unit_price: +e.target.value })} placeholder="0" className="input-field !py-3 text-[15px]" />
                          </div>
                        </>
                      ) : (
                        <div className="w-full sm:flex-1 min-w-0">
                          <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Item</label>
                          <select value={newLine.itemId} onChange={(e) => setNewLine({ ...newLine, itemId: e.target.value })} className="input-field !py-3 text-[15px]">
                            <option value="">Select {newLine.kind}...</option>
                            {(newLine.kind === 'inventory' ? inventoryItems : serviceItems).map((it) => (
                              <option key={it.id} value={it.id}>{it.name} — Rs. {fmtAmount('unit_price' in it ? it.unit_price : it.charge_amount)}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="flex-1 sm:flex-none sm:w-20 min-w-0">
                        <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Qty</label>
                        <input type="number" min={0.01} step="0.01" value={newLine.quantity} onChange={(e) => setNewLine({ ...newLine, quantity: +e.target.value })} className="input-field !py-3 text-[15px]" />
                      </div>
                      <button onClick={addCatalogLine} className="w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer"><Plus size={14} /> Add</button>
                    </div>
                  </div>
                </div>

                <div className="border border-dp-outline-variant rounded-lg p-3.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={showOtherCharge} onChange={(e) => setShowOtherCharge(e.target.checked)} className="accent-dp-secondary w-4 h-4" />
                    <span className="font-sans text-[14px] font-semibold text-dp-on-surface">Add Other Charge</span>
                  </label>
                  {showOtherCharge && (
                    <div className="mt-3 space-y-3">
                      <SearchableField
                        label="Charge Account" value={otherChargeAccountId} placeholder="Select or add a charge account..."
                        pickerTitle="Add Other Charge" searchPlaceholder="Search charge accounts..."
                        items={accountPickerItems((a) => a.type === 'income' || a.type === 'expense')}
                        onChange={setOtherChargeAccountId}
                        extraAction={{ label: '+ Add New Charge Account', onClick: () => setShowAddChargeAccount(true) }}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Description (optional)</label>
                          <input value={otherChargeDescription} onChange={(e) => setOtherChargeDescription(e.target.value)} placeholder="e.g. Cartage charged" className="input-field !py-2.5 text-[15px]" />
                        </div>
                        <div>
                          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Amount</label>
                          <input type="number" min={0} value={otherChargeAmount || ''} onChange={(e) => setOtherChargeAmount(+e.target.value)} className="input-field !py-2.5 text-[15px]" />
                        </div>
                      </div>
                      <button onClick={addOtherChargeLine} className="flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer"><Plus size={14} /> Add Charge</button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
                      {discountMode === 'per_item' ? 'Discount (from per-item %)' : 'Discount (optional)'}
                    </label>
                    {discountMode === 'per_item' ? (
                      <p className="input-field !py-3 bg-dp-surface-container-low text-dp-on-surface-variant">Rs. {fmtAmount(perItemDiscountTotal)}</p>
                    ) : (
                      <input type="number" min={0} value={billForm.discount_amount || ''} onChange={(e) => setBillForm({ ...billForm, discount_amount: +e.target.value })} className="input-field" />
                    )}
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Due Date</label>
                    <input type="date" value={billForm.due_date} onChange={(e) => setBillForm({ ...billForm, due_date: e.target.value })} className="input-field" />
                  </div>
                </div>

                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Security Deposit / Advance (optional, refundable)</label>
                  {editingBill?.security_deposit_voucher_id ? (
                    <p className="input-field !py-3 bg-dp-surface-container-low text-dp-on-surface-variant">Rs. {fmtAmount(billForm.security_deposit_amount)} — already recorded</p>
                  ) : (
                    <input type="number" min={0} value={billForm.security_deposit_amount || ''} onChange={(e) => setBillForm({ ...billForm, security_deposit_amount: +e.target.value })} className="input-field" />
                  )}
                </div>
                {editingBill?.security_deposit_voucher_id && (
                  <p className="font-sans text-[12px] text-dp-on-surface-variant -mt-2">To change the security deposit, delete its voucher from Transactions first, then edit this bill again.</p>
                )}

                {/* Entering an amount above only records what's owed/promised — it never
                    moves cash on its own. Receiving it is a deliberate, separate action
                    here (same as "Receive Payment Now" below), exactly like a real cash
                    receipt is its own transaction distinct from the invoice it settles. */}
                {billForm.security_deposit_amount > 0 && !editingBill?.security_deposit_voucher_id && (
                  <div className="border border-dp-outline-variant rounded-lg p-3.5">
                    <label className="flex items-center gap-2 cursor-pointer mb-2">
                      <input type="checkbox" checked={receiveDepositNow} onChange={(e) => setReceiveDepositNow(e.target.checked)} className="accent-dp-secondary" />
                      <span className="font-sans text-[14px] font-semibold flex items-center gap-1.5"><Banknote size={14} /> Receive Deposit Now</span>
                    </label>
                    {receiveDepositNow ? (
                      <SearchableField
                        label="Received Into" value={billForm.deposit_account_id} placeholder="Select account..."
                        items={accountPickerItems((a) => a.type === 'cash' || a.type === 'bank')}
                        onChange={(id) => setBillForm({ ...billForm, deposit_account_id: id })}
                      />
                    ) : (
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">Leave unchecked to just record the deposit as owed — no cash transaction is created until you actually receive it (here, or later by editing this bill).</p>
                    )}
                  </div>
                )}

                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Description (optional)</label>
                  <input value={billForm.description} onChange={(e) => setBillForm({ ...billForm, description: e.target.value })} className="input-field" />
                </div>

                <FileAttachment
                  label="Attachment (optional)" currentUrl={billForm.attachment_url}
                  onUpload={(url) => setBillForm({ ...billForm, attachment_url: url })}
                />

                <div className="bg-dp-surface-container-low/60 rounded-lg p-4 space-y-1 text-[13.5px] font-sans">
                  <div className="flex justify-between"><span className="text-dp-on-surface-variant">Subtotal</span><span>Rs. {fmtAmount(billTotal)}</span></div>
                  {billForm.discount_amount > 0 && <div className="flex justify-between text-emerald-700"><span>Discount</span><span>− Rs. {fmtAmount(billForm.discount_amount)}</span></div>}
                  <div className="flex justify-between font-bold border-t border-dp-outline-variant pt-1 mt-1"><span>Net Payable</span><span>Rs. {fmtAmount(billNet)}</span></div>
                  {billForm.security_deposit_amount > 0 && <div className="flex justify-between text-dp-on-surface-variant"><span>+ Security Deposit (refundable, separate)</span><span>Rs. {fmtAmount(billForm.security_deposit_amount)}</span></div>}
                </div>

                {!editingBill && billForm.consumer_id && existingRecurring && (
                  <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 flex items-center gap-2">
                    <Repeat size={14} className="text-dp-secondary shrink-0" />
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      This consumer already has a recurring bill — {frequencyLabels[existingRecurring.frequency]}, Rs. {fmtAmount(existingRecurring.amount_pkr)}/period.
                      A consumer can only have one active schedule; manage or change it from{' '}
                      <Link href={`/admin/finance/${system}/recurring`} className="text-dp-secondary font-semibold hover:underline">Recurring Schedules</Link>.
                    </p>
                  </div>
                )}
                {!editingBill && !existingRecurring && (
                <div className="border border-dp-outline-variant rounded-lg p-3.5">
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <input type="checkbox" checked={recurringEnabled} onChange={(e) => setRecurringEnabled(e.target.checked)} className="accent-dp-secondary" />
                    <span className="font-sans text-[14px] font-semibold flex items-center gap-1.5"><Repeat size={14} /> Set Recurring</span>
                  </label>
                  {recurringEnabled && (
                    <div className="space-y-2">
                      <select value={recurringFrequency} onChange={(e) => setRecurringFrequency(e.target.value as Frequency)} className="input-field !py-2.5 text-[15px]">
                        {(Object.keys(frequencyLabels) as Frequency[]).map((f) => <option key={f} value={f}>{frequencyLabels[f]}</option>)}
                      </select>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2">
                        Only items marked <span className="font-semibold">Recurring</span> above are re-billed each period — Rs. {fmtAmount(recurringNet)} {frequencyLabels[recurringFrequency].toLowerCase()}.
                        The security deposit and any one-off charges (new connection fee, meters, etc.) are billed once, on this invoice only.
                      </p>
                    </div>
                  )}
                </div>
                )}
                {editingBill?.recurring_schedule_id && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2.5">
                    This bill has a recurring schedule attached — manage its frequency or amount from{' '}
                    <Link href={`/admin/finance/${system}/recurring`} className="text-dp-secondary font-semibold hover:underline">Recurring Schedules</Link>.
                  </p>
                )}

                {/* Reachable in edit mode too — this whole form only shows for bills with
                    paid_amount === 0 (a partially/fully paid bill shows the locked banner
                    instead), so the full outstanding amount is always available to receive. */}
                <div className="border border-dp-outline-variant rounded-lg p-3.5">
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <input type="checkbox" checked={receivePaymentNow} onChange={(e) => { setReceivePaymentNow(e.target.checked); if (e.target.checked && !paymentAmount) setPaymentAmount(billNet) }} className="accent-dp-secondary" />
                    <span className="font-sans text-[14px] font-semibold flex items-center gap-1.5"><Banknote size={14} /> Receive Payment Now</span>
                  </label>
                  {receivePaymentNow && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Amount (PKR)</label>
                        <input type="number" min={1} value={paymentAmount || ''} onChange={(e) => setPaymentAmount(+e.target.value)} className="input-field !py-2.5 text-[15px]" />
                      </div>
                      <div>
                        <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Method</label>
                        <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)} className="input-field !py-2.5 text-[15px]">
                          <option value="cash">Cash</option>
                          <option value="jazzcash">JazzCash</option>
                          <option value="easypaisa">Easypaisa</option>
                          <option value="bank">Bank Transfer</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                <button disabled={saving} onClick={editingBill ? updateBill : saveBill} className="flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                  <Save size={16} /> {editingBill ? 'Update Bill' : 'Generate Bill'}
                </button>
              </div>
            )}

            {activeType === 'purchase' && (
              <div className="space-y-4">
                <h2 className="font-heading text-[20px] font-bold text-dp-primary">Purchase Bill</h2>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Date</label>
                    <input type="date" value={purchaseForm.date} onChange={(e) => setPurchaseForm({ ...purchaseForm, date: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Purchased From (optional)</label>
                    <input value={purchaseForm.vendor} onChange={(e) => setPurchaseForm({ ...purchaseForm, vendor: e.target.value })} placeholder="Vendor / supplier name" className="input-field" />
                  </div>
                </div>

                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Items Purchased</label>
                  <div className="border border-dp-outline-variant rounded-lg overflow-hidden">
                    {purchaseLines.length === 0 ? (
                      <p className="px-3 py-4 text-center font-sans text-[13px] text-dp-on-surface-variant">No items yet — add one below.</p>
                    ) : (
                      <table className="w-full text-[15px]" style={{ tableLayout: 'fixed' }}>
                        <colgroup>
                          <col />
                          <col style={{ width: '72px' }} />
                          <col style={{ width: '104px' }} />
                          <col style={{ width: '104px' }} />
                          <col style={{ width: '32px' }} />
                        </colgroup>
                        <thead>
                          <tr className="bg-dp-surface-container-low/60 text-left text-dp-on-surface-variant text-[11.5px] font-semibold">
                            <th className="px-3 py-2">Item</th>
                            <th className="px-3 py-2 text-right">Qty</th>
                            <th className="px-3 py-2 text-right">Unit Cost</th>
                            <th className="px-3 py-2 text-right">Amount</th>
                            <th className="px-3 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {purchaseLines.map((l, i) => (
                            <tr key={i} className="border-t border-dp-outline-variant">
                              <td className="px-3 py-2 truncate">{l.description}</td>
                              <td className="px-3 py-2">
                                <input type="number" min={0.01} step="0.01" value={l.quantity} onChange={(e) => updatePurchaseLine(i, { quantity: +e.target.value })} className="w-full text-right bg-white border-2 border-[#bfc9c4] rounded-md px-3 py-2.5 font-sans text-[15px] focus:border-dp-secondary focus:outline-none" />
                              </td>
                              <td className="px-3 py-2">
                                <input type="number" min={0} step="0.01" value={l.unit_cost} onChange={(e) => updatePurchaseLine(i, { unit_cost: +e.target.value })} className="w-full text-right bg-white border-2 border-[#bfc9c4] rounded-md px-3 py-2.5 font-sans text-[15px] focus:border-dp-secondary focus:outline-none" />
                              </td>
                              <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{fmtAmount(l.quantity * l.unit_cost)}</td>
                              <td className="px-3 py-2 text-right">
                                <button onClick={() => removePurchaseLine(i)} className="text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="flex flex-wrap items-end gap-2 p-3 bg-dp-surface-container-low/40 border-t border-dp-outline-variant">
                      <div className="w-full sm:flex-1 min-w-0">
                        <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Item</label>
                        <SearchableField
                          value={newPurchaseLine.itemId} placeholder="Select item..." pickerTitle="Select Inventory Item"
                          items={inventoryItems.map((it) => ({ id: it.id, label: it.name, sublabel: it.unit }))}
                          onChange={(id) => { const item = inventoryItems.find((i) => i.id === id); setNewPurchaseLine({ ...newPurchaseLine, itemId: id, unit_cost: item?.unit_cost ?? 0 }) }}
                        />
                      </div>
                      <div className="flex-1 sm:flex-none sm:w-24 min-w-0 shrink-0">
                        <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Qty</label>
                        <input type="number" min={0.01} step="0.01" value={newPurchaseLine.quantity} onChange={(e) => setNewPurchaseLine({ ...newPurchaseLine, quantity: +e.target.value })} className="input-field !py-2.5 text-[15px]" />
                      </div>
                      <div className="flex-1 sm:flex-none sm:w-32 min-w-0 shrink-0">
                        <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">Unit Cost</label>
                        <input type="number" min={0} step="0.01" value={newPurchaseLine.unit_cost || ''} onChange={(e) => setNewPurchaseLine({ ...newPurchaseLine, unit_cost: +e.target.value })} className="input-field !py-2.5 text-[15px]" />
                      </div>
                      <button onClick={addPurchaseLine} className="w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer"><Plus size={14} /> Add</button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Paid Via</label>
                  <select value={purchaseForm.method} onChange={(e) => setPurchaseForm({ ...purchaseForm, method: e.target.value as 'cash' | 'bank' })} className="input-field">
                    <option value="cash">Cash</option>
                    <option value="bank">Bank</option>
                  </select>
                </div>

                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Note (optional)</label>
                  <input value={purchaseForm.note} onChange={(e) => setPurchaseForm({ ...purchaseForm, note: e.target.value })} className="input-field" />
                </div>

                <FileAttachment
                  label="Attachment (optional)" currentUrl={purchaseForm.attachment_url}
                  onUpload={(url) => setPurchaseForm({ ...purchaseForm, attachment_url: url })}
                />

                <div className="bg-dp-surface-container-low/60 rounded-lg p-4 flex justify-between font-sans text-[14px] font-bold">
                  <span>Total</span><span>Rs. {fmtAmount(purchaseTotal)}</span>
                </div>

                <button disabled={saving} onClick={savePurchaseBill} className="flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                  <Save size={16} /> Save Purchase Bill
                </button>
              </div>
            )}

            {activeType === 'donation' && (
              <div className="space-y-4">
                <h2 className="font-heading text-[20px] font-bold text-dp-primary">Record Donation</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Name</label>
                    <input value={donationForm.name} onChange={(e) => setDonationForm({ ...donationForm, name: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Name (Urdu)</label>
                    <input value={donationForm.name_ur} onChange={(e) => setDonationForm({ ...donationForm, name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Phone</label>
                    <input value={donationForm.phone} onChange={(e) => setDonationForm({ ...donationForm, phone: e.target.value })} placeholder="0300-1234567" className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Donor Type</label>
                    <select value={donationForm.donor_type} onChange={(e) => setDonationForm({ ...donationForm, donor_type: e.target.value })} className="input-field">
                      <option value="villager">Villager</option>
                      <option value="overseas">Overseas</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Amount (PKR)</label>
                    <input type="number" value={donationForm.amount_pkr || ''} onChange={(e) => setDonationForm({ ...donationForm, amount_pkr: +e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Date</label>
                    <input type="date" value={donationForm.date} onChange={(e) => setDonationForm({ ...donationForm, date: e.target.value })} className="input-field" />
                  </div>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Payment Method</label>
                  <select value={donationForm.payment_method} onChange={(e) => setDonationForm({ ...donationForm, payment_method: e.target.value })} className="input-field">
                    <option value="cash">Cash</option>
                    <option value="jazzcash">JazzCash</option>
                    <option value="easypaisa">Easypaisa</option>
                    <option value="bank">Bank</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Project (optional)</label>
                  <select value={donationForm.project_id} onChange={(e) => setDonationForm({ ...donationForm, project_id: e.target.value })} className="input-field">
                    <option value="">No specific project</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={donationForm.is_anonymous} onChange={(e) => setDonationForm({ ...donationForm, is_anonymous: e.target.checked })} className="accent-dp-secondary" />
                  <span className="font-sans text-[14px]">Anonymous Donor</span>
                </label>
                <button disabled={saving} onClick={saveDonation} className="flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                  <Save size={16} /> Record Donation
                </button>
              </div>
            )}
          </div>

          {/* Pending approvals — actual confirm/reject happens on the Approvals page
              (approvers get a real-time popup there); this is just a status summary. */}
          {pendingApprovals.length > 0 && (
            <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
              <div className="px-4 py-3 border-b border-dp-outline-variant bg-amber-50 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Clock size={15} className="text-amber-700" />
                  <span className="font-sans text-[14px] font-bold text-amber-900">Pending Approval ({pendingApprovals.length})</span>
                </span>
                <Link href="/admin/approvals" className="font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline">View all</Link>
              </div>
              <div>
                {pendingApprovals.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-3 px-4 py-3 border-t border-dp-outline-variant first:border-t-0">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{v.particular}</p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">{v.kind === 'purchase' ? 'Purchase Bill' : 'Voucher'} · {new Date(v.created_at).toLocaleDateString('en-GB')} · Rs. {fmtAmount(v.amount_pkr)}</p>
                    </div>
                    <ShieldCheck size={16} className="text-amber-600 shrink-0" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent transactions log */}
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="px-4 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low/60 flex items-center justify-between flex-wrap gap-2">
              <span className="font-sans text-[14px] font-bold text-dp-on-surface">Recent Transactions</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setFilterLogByType(!filterLogByType)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 border rounded-lg font-sans text-[12px] font-semibold transition-all cursor-pointer ${filterLogByType ? 'border-dp-secondary bg-dp-secondary/10 text-dp-primary' : 'border-dp-outline-variant text-dp-on-surface-variant hover:bg-white'}`}
                  title="Toggle filtering Recent Transactions to only the currently selected posting type"
                >
                  <Filter size={13} /> {filterLogByType ? `Only ${activeTypeLabel}` : 'All types'}
                </button>
                <button
                  onClick={() => setLogSortDir(logSortDir === 'desc' ? 'asc' : 'desc')}
                  className="flex items-center gap-1.5 px-2.5 py-1 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold text-dp-on-surface-variant hover:bg-white transition-all cursor-pointer"
                  title="Toggle date sort order"
                >
                  <ArrowUpDown size={13} /> Date {logSortDir === 'desc' ? 'Newest first' : 'Oldest first'}
                </button>
              </div>
            </div>
            {loading && <p className="px-4 py-8 text-center text-dp-on-surface-variant font-sans text-[13.5px]">Loading...</p>}
            {!loading && visibleTxnCards.length === 0 && <p className="px-4 py-8 text-center text-dp-on-surface-variant font-sans text-[13.5px]">{filterLogByType ? `No ${activeTypeLabel.toLowerCase()} transactions yet.` : 'No transactions yet.'}</p>}
            <div className="divide-y divide-dp-outline-variant">
              {!loading && visibleTxnCards.map((c) => (
                <div key={c.id} className={`flex border-l-[3px] ${c.borderColor}`}>
                  <div className="flex-1 min-w-0 p-3.5">
                    <div className="flex justify-between items-start gap-3">
                      <div className="min-w-0">
                        {c.typeLabel && <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-tight">{c.typeLabel}</p>}
                        <p className="font-sans text-[14px] font-bold text-dp-on-surface truncate">{c.partyName}</p>
                        {c.autoPosted && (
                          <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded font-sans text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800" title="Posted after 24 hours without every approver confirming">
                            Auto-posted
                          </span>
                        )}
                        {c.fullyApproved && (
                          <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded font-sans text-[10px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800" title="Confirmed by every configured approver">
                            Approved
                          </span>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-sans text-[13px] font-bold text-dp-on-surface whitespace-nowrap">{c.docLabel}</p>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant whitespace-nowrap">{new Date(c.date).toLocaleDateString('en-GB')}</p>
                      </div>
                    </div>
                    <div className="flex justify-between items-end gap-3 mt-1.5">
                      <p className="font-sans text-[13px] text-dp-on-surface-variant truncate">{c.description}</p>
                      <div className="text-right shrink-0">
                        <p className="font-sans text-[15px] font-bold text-dp-on-surface whitespace-nowrap">Rs {fmtAmount(c.amount)}</p>
                        {c.badge && (
                          <span className={`inline-block mt-1 px-2 py-0.5 rounded font-sans text-[10.5px] font-bold tracking-wide ${billBadgeClass[c.badge.tone]}`}>
                            {c.badge.text}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between items-center gap-3 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                      <p className="font-sans text-[12px] text-dp-on-surface-variant italic truncate">{c.note}</p>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {c.kind === 'bill' && c.billId && (
                          <>
                            {(c.billOutstanding ?? 0) > 0 && (
                              <button onClick={() => openQuickReceivePayment(c)} title="Receive payment" className="p-1.5 text-dp-on-surface-variant hover:text-emerald-700 cursor-pointer"><Banknote size={15} /></button>
                            )}
                            <Link href={`/admin/invoice/bill/${c.billId}`} title="View invoice" className="inline-block p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><FileText size={15} /></Link>
                            <Link href={`/admin/finance/${system}?action=generate_bill&bill=${c.billId}`} title="Edit bill" className="inline-block p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={15} /></Link>
                            <button onClick={() => attemptDeleteBill(c.billId!)} title="Delete bill" className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                          </>
                        )}
                        {c.kind === 'payment' && c.billId && (
                          <>
                            <button onClick={() => openPaymentReceipt(c)} title="View cash receipt" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><FileText size={15} /></button>
                            <button onClick={() => openEditPayment(c)} title="Edit payment" className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={15} /></button>
                            <button onClick={() => setConfirmDeletePaymentId(c.paymentId!)} title="Delete payment" className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                          </>
                        )}
                        {c.kind === 'voucher' && c.voucherId && (
                          <button onClick={() => setConfirmDeleteVoucherId(c.voucherId!)} title="Delete voucher" className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                        )}
                        {c.kind === 'purchase' && c.purchaseId && (
                          <button onClick={() => openPurchaseReceipt(c)} title="View payment voucher" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><FileText size={15} /></button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDeleteVoucherId}
        title="Delete Voucher"
        message="Are you sure you want to delete this voucher? Both ledger entries it created will be removed. This cannot be undone."
        onConfirm={deleteVoucher}
        onCancel={() => setConfirmDeleteVoucherId(null)}
      />

      <ConfirmDialog
        open={!!confirmDeleteBillId}
        title="Delete Bill"
        message="Are you sure you want to delete this bill? All its ledger entries will be removed. This cannot be undone."
        onConfirm={deleteBill}
        onCancel={() => setConfirmDeleteBillId(null)}
      />

      <ConfirmDialog
        open={!!confirmDeletePaymentId}
        title="Delete Payment"
        message="Are you sure you want to delete this payment? Its ledger entries will be reversed and the bill will show as unpaid/outstanding again. This cannot be undone."
        onConfirm={deletePayment}
        onCancel={() => setConfirmDeletePaymentId(null)}
      />

      {billDeleteBlock && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setBillDeleteBlock(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={20} className="text-dp-error shrink-0" />
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">Can&apos;t Delete Bill{billDeleteBlock.billNumber ? ` ${billDeleteBlock.billNumber}` : ''}</h2>
            </div>
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-3">
              Cash has already been received against this bill. Delete {billDeleteBlock.receipts.length > 1 ? 'these cash receipts' : 'this cash receipt'} first, then come back and delete the bill:
            </p>
            <div className="flex flex-wrap gap-2 mb-5">
              {billDeleteBlock.receipts.map((r) => (
                <span key={r} className="px-2.5 py-1 bg-red-50 border border-red-200 rounded-full font-sans text-[12.5px] font-semibold text-dp-error">Receipt #{r}</span>
              ))}
            </div>
            <button onClick={() => setBillDeleteBlock(null)} className="w-full px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">Got it</button>
          </div>
        </div>
      )}

      {showDiscountModePicker && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setShowDiscountModePicker(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-xs" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-4">Discount & Tax</h2>
            <div className="space-y-1">
              {(['per_item', 'on_total'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => switchDiscountMode(mode)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-dp-surface-container-low transition-all cursor-pointer text-left"
                >
                  <span className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${discountMode === mode ? 'border-dp-secondary' : 'border-dp-outline-variant'}`}>
                    {discountMode === mode && <span className="w-2 h-2 rounded-full bg-dp-secondary" />}
                  </span>
                  <span className="font-sans text-[14.5px] font-semibold text-dp-on-surface">{mode === 'per_item' ? 'Per Item' : 'On Total'}</span>
                </button>
              ))}
            </div>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-3">Switching clears whatever discount the other mode had set, so they never combine.</p>
          </div>
        </div>
      )}

      {showAddChargeAccount && (
        <div className="fixed inset-0 bg-black/50 z-[140] flex items-center justify-center p-4" onClick={() => setShowAddChargeAccount(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-xs" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-3">New Charge Account</h2>
            <input
              autoFocus value={newChargeAccountName} onChange={(e) => setNewChargeAccountName(e.target.value)}
              placeholder="e.g. Late Payment Surcharge" className="input-field mb-3"
            />
            <div className="flex gap-2">
              <button onClick={() => setShowAddChargeAccount(false)} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button onClick={createChargeAccount} className="flex-1 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">Save</button>
            </div>
          </div>
        </div>
      )}

      {receivePaymentTarget && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setReceivePaymentTarget(null)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-xs" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1">Receive Payment</h2>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{receivePaymentTarget.billNumber} — Rs. {fmtAmount(receivePaymentTarget.outstanding)} outstanding</p>
            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Amount (PKR)</label>
                <input type="number" min={1} value={quickPayAmount || ''} onChange={(e) => setQuickPayAmount(+e.target.value)} className="input-field !py-2.5 text-[15px]" />
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Method</label>
                <select value={quickPayMethod} onChange={(e) => setQuickPayMethod(e.target.value as typeof quickPayMethod)} className="input-field !py-2.5 text-[15px]">
                  <option value="cash">Cash</option>
                  <option value="jazzcash">JazzCash</option>
                  <option value="easypaisa">Easypaisa</option>
                  <option value="bank">Bank Transfer</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setReceivePaymentTarget(null)} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={quickPaySaving} onClick={saveQuickPayment} className="flex-1 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">{quickPaySaving ? 'Saving...' : 'Receive'}</button>
            </div>
          </div>
        </div>
      )}

      {viewReceipt && <ReceiptModal data={viewReceipt} onClose={() => setViewReceipt(null)} />}

      {editPaymentTarget && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setEditPaymentTarget(null)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-xs" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1">Edit Payment</h2>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{editPaymentTarget.receiptNo ? `Receipt #${editPaymentTarget.receiptNo}` : 'Receipt'} — number stays the same</p>
            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Amount (PKR)</label>
                <input type="number" min={1} value={editPaymentForm.amount || ''} onChange={(e) => setEditPaymentForm({ ...editPaymentForm, amount: +e.target.value })} className="input-field !py-2.5 text-[15px]" />
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Method</label>
                <select value={editPaymentForm.method} onChange={(e) => setEditPaymentForm({ ...editPaymentForm, method: e.target.value as typeof editPaymentForm.method })} className="input-field !py-2.5 text-[15px]">
                  <option value="cash">Cash</option>
                  <option value="jazzcash">JazzCash</option>
                  <option value="easypaisa">Easypaisa</option>
                  <option value="bank">Bank Transfer</option>
                </select>
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Date</label>
                <input type="date" value={editPaymentForm.date} onChange={(e) => setEditPaymentForm({ ...editPaymentForm, date: e.target.value })} className="input-field !py-2.5 text-[15px]" />
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Note (optional)</label>
                <input value={editPaymentForm.note} onChange={(e) => setEditPaymentForm({ ...editPaymentForm, note: e.target.value })} className="input-field !py-2.5 text-[15px]" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setEditPaymentTarget(null)} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={editPaymentSaving} onClick={saveEditPayment} className="flex-1 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">{editPaymentSaving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

    </>
  )
}
