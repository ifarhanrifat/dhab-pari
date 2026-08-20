'use client'

import { useEffect, useRef, useState, useMemo, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Search, PlusCircle, Plus, X, ArrowLeft, ChevronRight, ChevronDown, SlidersHorizontal, Phone,
  Home, MapPin, MessageCircle, AlertCircle, CheckCircle2,
  Clock, CreditCard, Banknote, Pencil, Receipt, Users, UserCheck, UserX, Tag, UserPlus, Repeat, Trash2, FileText, Lock,
  Power, Ban, PauseCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { billBadge, billBadgeClass } from '@/lib/billStatus'
import { renderTemplate } from '@/lib/messageTemplates'
import { findDuplicate, type DuplicateCandidate } from '@/lib/duplicateCheck'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { fetchPeriodLockRule, periodIsLocked, DEFAULT_PERIOD_LOCK, type PeriodLockRule } from '@/lib/periodLock'

interface Consumer {
  consumer_id: string
  name: string
  father_husband_name: string | null
  mobile: string
  whatsapp_number: string | null
  whatsapp_same_as_mobile: boolean
  house_no: string | null
  sector: string | null
  area: string | null
  address: string | null
  connections: number
  monthly_rate: number
  status: string
  created_at: string
}

interface RecurringSchedule {
  id: string
  amount_pkr: number
  discount_amount: number
  frequency: string
  next_run_date: string
  is_active: boolean
  particular: string | null
  created_at: string
}

interface Bill {
  id: string
  bill_number: string | null
  consumer_id: string
  month: number
  year: number
  amount_pkr: number
  paid_amount: number
  description: string | null
  status: string
  paid_date: string | null
  payment_method: string | null
  discount_amount: number | null
  due_date: string | null
  waiver_voucher_id: string | null
  waiver_type: string | null
  waiver_percent: number | null
}

interface LinkedComplaint { id: string; complaint_number: string; status: string; complaint_text: string }

const complaintStatusLabels: Record<string, string> = { open: 'Open', awaiting_verification: 'Awaiting Verification' }
const complaintStatusColors: Record<string, string> = { open: 'bg-amber-100 text-amber-800', awaiting_verification: 'bg-blue-100 text-blue-800' }

interface PaymentForm {
  billId: string
  amount: number
  method: string
  description: string
  // Pre-filled from the consumer's saved WhatsApp number (or mobile, as a
  // fallback) but editable right here — the accountant verifies/corrects it
  // in the moment of receiving cash, which is also when a wrong or missing
  // number actually gets noticed and fixed.
  whatsapp: string
  sendReceipt: boolean
}

const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fullMonths = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// t(monthKey(m), fullMonths[m]) translates a bill's month name — same pair the
// <select> payment-method options already use their own key for.
const monthKey = (m: number) => `w.month${m}`
const paymentMethodKeys: Record<string, string> = { cash: 'billing.methodCash', jazzcash: 'billing.methodJazzcash', easypaisa: 'billing.methodEasypaisa', bank: 'billing.methodBank' }

// Net payable is amount_pkr (gross) minus any discount — the ledger posts the
// discount as its own leg rather than netting it into amount_pkr, so anywhere that
// needs "what does the consumer actually still owe" must subtract it explicitly.
function netPayable(bill: Bill) {
  return Math.max(bill.amount_pkr - (bill.discount_amount ?? 0), 0)
}
function outstanding(bill: Bill) {
  return netPayable(bill) - (bill.paid_amount ?? 0)
}

// Same badge computation and styling as Recent Transactions (src/lib/billStatus.ts)
// — a bill reads identically whether you're looking at it there or here.
function StatusBadge({ bill }: { bill: Bill }) {
  const badge = billBadge(bill)
  return (
    <span className={`inline-block px-2 py-0.5 rounded font-sans text-[10.5px] font-bold tracking-wide whitespace-nowrap ${billBadgeClass[badge.tone]}`}>
      {badge.text}
    </span>
  )
}

export default function BillingPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <BillingPageInner />
    </Suspense>
  )
}

function BillingPageInner() {
  const { t, isUrdu } = useLocale()
  const searchParams = useSearchParams()
  const [consumers, setConsumers] = useState<Consumer[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  // Receipt numbers against each bill. A bill with cash received is closed to
  // edits — the database refuses one (migration 204) — so the screen has to
  // know before it offers the button, and has to be able to name the receipt
  // that must be deleted first.
  const [receiptsByBill, setReceiptsByBill] = useState<Record<string, string[]>>({})
  const [lockRule, setLockRule] = useState<PeriodLockRule>(DEFAULT_PERIOD_LOCK)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sectorFilter, setSectorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedConsumer, setSelectedConsumer] = useState<Consumer | null>(null)
  // On a phone the list and the detail panel are the same full-width block
  // (`hidden md:flex` on the list — see the two-column div below), swapped
  // by tapping a consumer rather than shown side by side. Without this, the
  // swap happens wherever the page was already scrolled to — often well
  // past the top, on the list — so the detail that just replaced it never
  // enters view and reads as "nothing happened" until scrolled to manually.
  const detailPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selectedConsumer) return
    if (window.innerWidth >= 768) return
    detailPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedConsumer])
  // A single exclusive quick-filter rather than 5 independent booleans — these
  // read as tabs ("click a card, see that slice of consumers"), so combining a
  // stale filter left on from a previous click with a new one via AND silently
  // produced wrong/empty results (e.g. Deactivated left active, then clicking
  // With Discount intersected the two and showed nothing).
  type QuickFilter = 'none' | 'billed_this_month' | 'active' | 'inactive' | 'with_discount' | 'without_discount' | 'new_this_month'
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('none')
  const toggleQuickFilter = (f: QuickFilter) => setQuickFilter((cur) => (cur === f ? 'none' : f))
  const [deactivatedThisMonth, setDeactivatedThisMonth] = useState(0)
  const [recurringSchedules, setRecurringSchedules] = useState<Record<string, RecurringSchedule>>({})
  const [paymentForm, setPaymentForm] = useState<PaymentForm | null>(null)
  // Set right after a successful recordPayment() when "send receipt now" was
  // checked — opens the same ReceiptModal used everywhere else, pre-loaded with
  // the WhatsApp number the accountant just confirmed in the payment popup.
  const [viewPaymentReceipt, setViewPaymentReceipt] = useState<ReceiptData | null>(null)
  const [paymentReceiptPhone, setPaymentReceiptPhone] = useState<string | null>(null)
  const [showAddConsumer, setShowAddConsumer] = useState(false)
  const [confirmDeleteBill, setConfirmDeleteBill] = useState<string | null>(null)
  const [editConsumerTarget, setEditConsumerTarget] = useState<Consumer | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', father_husband_name: '', mobile: '', whatsapp_number: '', whatsapp_same_as_mobile: true,
    house_no: '', sector: '', area: '', address: '', connections: 1, monthly_rate: 200,
  })
  const [savingEdit, setSavingEdit] = useState(false)
  const [disconnectTarget, setDisconnectTarget] = useState<Consumer | null>(null)
  const [confirmToggleActive, setConfirmToggleActive] = useState<Consumer | null>(null)
  const [disconnectPreview, setDisconnectPreview] = useState<{ deposit_on_hand: number; pending_balance: number; applied: number; refund: number } | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [billingSetupTarget, setBillingSetupTarget] = useState<{ consumer_id: string; name: string; scheduleId: string | null } | null>(null)
  const [billingSetupForm, setBillingSetupForm] = useState({ discount_amount: 0, description: '', recurring_enabled: true, recurring_frequency: 'monthly', monthly_amount: 0 })
  const [settingUpBilling, setSettingUpBilling] = useState(false)
  const [newConsumer, setNewConsumer] = useState({
    name: '', father_husband_name: '', mobile: '', whatsapp_number: '', whatsapp_same_as_mobile: true,
    house_no: '', sector: '', area: '', address: '', connections: 1, monthly_rate: 200,
  })
  const supabase = createClient()

  const [sectorOptions, setSectorOptions] = useState<{ id: string; name: string }[]>([])
  const [messageTemplates, setMessageTemplates] = useState<Record<string, string>>({})
  const [complaintsByConsumer, setComplaintsByConsumer] = useState<Record<string, LinkedComplaint>>({})
  const [pendingRequestIdentities, setPendingRequestIdentities] = useState<DuplicateCandidate[]>([])
  const [waiverVoucherStatus, setWaiverVoucherStatus] = useState<Record<string, string>>({})
  const [inProcessConsumerIds, setInProcessConsumerIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase.from('message_templates').select('key, body').then(({ data }) => {
      setMessageTemplates(Object.fromEntries((data ?? []).map((t) => [t.key, t.body])))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadData = async () => {
    setLoading(true)
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const [cRes, bRes, secRes, auditRes, recurRes, complaintsRes, inProcessRes, pendingReqRes, payRes, lockRes] = await Promise.all([
      supabase.from('consumers').select('*').order('consumer_id'),
      supabase.from('bills').select('*').order('year', { ascending: false }).order('month', { ascending: false }),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
      supabase.from('audit_log').select('old_data, record_data').eq('table_name', 'consumers').eq('action', 'update').gte('performed_at', monthStart),
      // Not filtered to is_active=true — a paused schedule must still be found
      // here so "Set Up Recurring" reuses/reactivates it instead of inserting
      // a second row (exactly the bug that produced a real duplicate: one
      // permanently-paused orphan plus a fresh active one, same consumer,
      // same amount, same next_run_date).
      supabase.from('recurring_schedules').select('id, consumer_id, amount_pkr, discount_amount, frequency, next_run_date, is_active, particular, created_at').eq('schedule_type', 'bill'),
      supabase.from('complaints').select('id, complaint_number, status, complaint_text, consumer_id').eq('system', 'water_supply').not('consumer_id', 'is', null).neq('status', 'verified'),
      supabase.from('connection_requests').select('consumer_id').eq('status', 'processing').not('consumer_id', 'is', null),
      // Not-yet-converted requests too, so a duplicate can be caught before it
      // ever becomes a real consumer, not just after.
      supabase.from('connection_requests').select('id, consumer_name, consumer_phone, whatsapp_number, father_husband_name').is('consumer_id', null),
      supabase.from('payments').select('bill_id, receipt_no').not('bill_id', 'is', null),
      fetchPeriodLockRule(supabase),
    ])
    setConsumers(cRes.data ?? [])
    setPendingRequestIdentities((pendingReqRes.data ?? []).map((r) => ({
      id: r.id, name: r.consumer_name, mobile: r.consumer_phone, whatsapp_number: r.whatsapp_number, father_husband_name: r.father_husband_name,
    })))
    setBills(bRes.data ?? [])
    const receiptMap: Record<string, string[]> = {}
    for (const p of payRes.data ?? []) {
      // A receipt with no number still blocks the bill — it is still cash the
      // committee holds — so it counts, it just cannot be named.
      ;(receiptMap[p.bill_id as string] ??= []).push(p.receipt_no ?? '—')
    }
    setReceiptsByBill(receiptMap)
    setLockRule(lockRes)
    setSectorOptions(secRes.data ?? [])
    // One row per consumer — prefer the active one if there's ever more than
    // one for the same consumer (shouldn't happen now that the query above
    // and openRecurringSetup/saveBillingSetup always reuse an existing row,
    // but this is a harmless tie-break if stale duplicate data still exists).
    const recurByConsumer: Record<string, RecurringSchedule> = {}
    for (const r of recurRes.data ?? []) {
      if (!r.consumer_id) continue
      const existing = recurByConsumer[r.consumer_id]
      if (!existing || (r.is_active && !existing.is_active) || (r.is_active === existing.is_active && r.created_at > existing.created_at)) {
        recurByConsumer[r.consumer_id] = r as RecurringSchedule
      }
    }
    setRecurringSchedules(recurByConsumer)
    setComplaintsByConsumer(Object.fromEntries(
      (complaintsRes.data ?? []).map((c) => [c.consumer_id as string, c as LinkedComplaint])
    ))
    setInProcessConsumerIds(new Set((inProcessRes.data ?? []).map((r) => r.consumer_id as string)))
    const waiverVoucherIds = (bRes.data ?? []).map((b) => b.waiver_voucher_id).filter(Boolean) as string[]
    if (waiverVoucherIds.length > 0) {
      const { data: waiverVouchers } = await supabase.from('vouchers').select('id, status').in('id', waiverVoucherIds)
      setWaiverVoucherStatus(Object.fromEntries((waiverVouchers ?? []).map((v) => [v.id, v.status])))
    } else {
      setWaiverVoucherStatus({})
    }
    const deactivations = (auditRes.data ?? []).filter(
      (r) => r.old_data?.status === 'active' && r.record_data?.status === 'inactive'
    ).length
    setDeactivatedThisMonth(deactivations)
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])
  const sectors = useMemo(() => {
    const fromTable = sectorOptions.map((s) => s.name)
    const fromConsumers = consumers.map((c) => c.sector).filter(Boolean) as string[]
    return Array.from(new Set([...fromTable, ...fromConsumers])).sort()
  }, [consumers, sectorOptions])

  const billsByConsumer = useMemo(() => {
    const map: Record<string, Bill[]> = {}
    bills.forEach((b) => {
      if (!map[b.consumer_id]) map[b.consumer_id] = []
      map[b.consumer_id].push(b)
    })
    return map
  }, [bills])

  const consumerStats = useMemo(() => {
    const stats: Record<string, { outstanding: number; pendingCount: number; pendingMonths: string[] }> = {}
    consumers.forEach((c) => {
      const cb = billsByConsumer[c.consumer_id] ?? []
      const pending = cb.filter((b) => b.status !== 'paid')
      stats[c.consumer_id] = {
        outstanding: pending.reduce((s, b) => s + outstanding(b), 0),
        pendingCount: pending.length,
        pendingMonths: pending
          .sort((a, b) => a.year - b.year || a.month - b.month)
          .map((b) => `${months[b.month]}-${String(b.year).slice(2)}`),
      }
    })
    return stats
  }, [consumers, billsByConsumer])

  const now = new Date()
  const currentMonth = now.getMonth() + 1
  const currentYear = now.getFullYear()

  const monthlyStats = useMemo(() => {
    const thisMonthBills = bills.filter((b) => b.month === currentMonth && b.year === currentYear)
    const withDiscount = thisMonthBills.filter((b) => (b.discount_amount ?? 0) > 0)
    const withoutDiscount = thisMonthBills.filter((b) => !((b.discount_amount ?? 0) > 0))
    const activeConnections = consumers.filter((c) => c.status === 'active').length
    const inactiveConnections = consumers.filter((c) => c.status !== 'active').length
    const newConsumers = consumers.filter((c) => {
      const d = new Date(c.created_at)
      return d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear
    })
    const discountConsumerIds = new Set(withDiscount.map((b) => b.consumer_id))
    // "Without Discount" is the complement of "With Discount" across ALL
    // consumers, not just the subset already billed this month without one —
    // a consumer who hasn't been billed yet this month has just as much "no
    // discount" as one who was billed at full rate, and should show up here.
    const noDiscountConsumerIds = new Set(consumers.filter((c) => !discountConsumerIds.has(c.consumer_id)).map((c) => c.consumer_id))
    return {
      billCount: thisMonthBills.length,
      billTotal: thisMonthBills.reduce((s, b) => s + b.amount_pkr, 0),
      // Card counts reflect distinct consumers (matching what the click-through
      // list shows), not raw bill counts — a consumer billed twice in a month
      // would otherwise inflate the card past the number of rows it filters to.
      withDiscountCount: discountConsumerIds.size,
      withDiscountTotal: withDiscount.reduce((s, b) => s + b.amount_pkr, 0),
      withoutDiscountCount: noDiscountConsumerIds.size,
      withoutDiscountTotal: withoutDiscount.reduce((s, b) => s + b.amount_pkr, 0),
      activeConnections,
      inactiveConnections,
      newThisMonth: newConsumers.length,
      discountConsumerIds,
      noDiscountConsumerIds,
      billedConsumerIds: new Set(thisMonthBills.map((b) => b.consumer_id)),
      newConsumerIds: new Set(newConsumers.map((c) => c.consumer_id)),
    }
  }, [bills, consumers, currentMonth, currentYear])

  // Priority order for the left list: new-connection-in-process, then has an
  // open complaint, then no recurring set up, then has a pending (unpaid) bill,
  // then has a partial-payment bill, then everyone else — first match wins,
  // so e.g. a consumer with no recurring AND a pending bill lands in tier 2
  // (no recurring), not tier 3.
  const consumerTier = (c: Consumer): number => {
    if (inProcessConsumerIds.has(c.consumer_id)) return 0
    if (complaintsByConsumer[c.consumer_id]) return 1
    if (!recurringSchedules[c.consumer_id]?.is_active) return 2
    const cb = billsByConsumer[c.consumer_id] ?? []
    if (cb.some((b) => b.status === 'unpaid' || b.status === 'pending' || b.status === 'late')) return 3
    if (cb.some((b) => b.status === 'partial')) return 4
    return 5
  }

  const filteredConsumers = useMemo(() => {
    return consumers
      .filter((c) => {
        if (search) {
          const q = search.toLowerCase()
          if (!c.consumer_id.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q) && !c.mobile.includes(q)) return false
        }
        if (sectorFilter && c.sector !== sectorFilter) return false
        if (statusFilter === 'pending' && (consumerStats[c.consumer_id]?.pendingCount ?? 0) === 0) return false
        if (statusFilter === 'clear' && (consumerStats[c.consumer_id]?.pendingCount ?? 0) > 0) return false
        if (quickFilter === 'with_discount' && !monthlyStats.discountConsumerIds.has(c.consumer_id)) return false
        if (quickFilter === 'without_discount' && !monthlyStats.noDiscountConsumerIds.has(c.consumer_id)) return false
        if (quickFilter === 'active' && c.status !== 'active') return false
        if (quickFilter === 'inactive' && c.status === 'active') return false
        if (quickFilter === 'new_this_month' && !monthlyStats.newConsumerIds.has(c.consumer_id)) return false
        if (quickFilter === 'billed_this_month' && !monthlyStats.billedConsumerIds.has(c.consumer_id)) return false
        return true
      })
      .sort((a, b) => consumerTier(a) - consumerTier(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consumers, search, sectorFilter, statusFilter, consumerStats, quickFilter, monthlyStats, inProcessConsumerIds, complaintsByConsumer, recurringSchedules, billsByConsumer])

  const selectedBills = useMemo(() => {
    if (!selectedConsumer) return []
    return (billsByConsumer[selectedConsumer.consumer_id] ?? []).sort((a, b) => b.year - a.year || b.month - a.month)
  }, [selectedConsumer, billsByConsumer])

  const selectedOutstanding = useMemo(() => {
    return selectedBills.filter((b) => b.status !== 'paid').reduce((s, b) => s + outstanding(b), 0)
  }, [selectedBills])

  const recordPayment = async () => {
    if (!paymentForm) return
    const bill = bills.find((b) => b.id === paymentForm.billId)
    if (!bill) return

    // The full entered amount is recorded even if it exceeds what's outstanding — an
    // overpayment isn't an error, it's an advance. It posts in full to Cash/Bank and to
    // the consumer's ledger, so their overall balance correctly shows a credit rather
    // than silently discarding the extra money the accountant actually received.
    const entered = paymentForm.amount
    if (entered <= 0) { toast.error(t('billing.err.invalidAmount')); return }

    const { data: inserted, error } = await supabase.from('payments').insert({
      bill_id: paymentForm.billId,
      consumer_id: bill.consumer_id,
      amount_pkr: entered,
      method: paymentForm.method,
      note: paymentForm.description || null,
    }).select('id, receipt_no').single()

    if (error) { toast.error(friendlyError(error)); return }
    const remaining = outstanding(bill)
    if (entered > remaining) {
      toast.success(`Payment recorded — Rs. ${(entered - remaining).toLocaleString()} credited as advance balance`)
    } else {
      const isFull = (bill.paid_amount ?? 0) + entered >= netPayable(bill)
      toast.success(isFull ? 'Payment recorded — bill marked as paid' : `Partial payment of Rs. ${entered.toLocaleString()} recorded`)
    }

    // Whatever WhatsApp number the accountant confirmed or corrected in the
    // popup gets saved back onto the consumer — so the next payment starts
    // pre-filled correctly instead of asking again every single time.
    const consumer = consumers.find((c) => c.consumer_id === bill.consumer_id)
    const cleanedWhatsapp = paymentForm.whatsapp.trim()
    if (consumer && cleanedWhatsapp && cleanedWhatsapp !== (consumer.whatsapp_number || '')) {
      await supabase.from('consumers')
        .update({ whatsapp_number: cleanedWhatsapp, whatsapp_same_as_mobile: cleanedWhatsapp === consumer.mobile })
        .eq('consumer_id', consumer.consumer_id)
    }

    // "Send receipt now" is checked by default — the receipt pops up right
    // here so the accountant can hit Share via WhatsApp on the number they
    // just verified, without hunting for this payment again afterward.
    if (paymentForm.sendReceipt && consumer) {
      const billOutstandingNow = Math.max(remaining - entered, 0)
      setPaymentReceiptPhone(cleanedWhatsapp || null)
      setViewPaymentReceipt({
        kind: 'payment',
        receiptNo: inserted?.receipt_no || inserted?.id.slice(0, 8).toUpperCase() || '—',
        date: new Date().toISOString().slice(0, 10),
        systemLabel: t('dash.waterSupplySystem', 'Water Supply System'),
        accountName: consumer.name,
        particular: paymentForm.description || `${t(monthKey(bill.month), fullMonths[bill.month])} ${bill.year}`,
        amount: entered,
        balanceAfter: billOutstandingNow,
        billOutstandingAfter: billOutstandingNow,
      })
    }

    setPaymentForm(null)
    loadData()
  }

  const addConsumer = async () => {
    if (!newConsumer.name.trim()) { toast.error(t('billing.err.nameRequired')); return }
    if (!newConsumer.sector) { toast.error(t('billing.err.selectSector')); return }

    const whatsapp = newConsumer.whatsapp_same_as_mobile ? newConsumer.mobile : newConsumer.whatsapp_number
    const duplicate = findDuplicate(
      { name: newConsumer.name, father_husband_name: newConsumer.father_husband_name, mobile: newConsumer.mobile, whatsapp_number: whatsapp },
      [...consumers.map((c) => ({ id: c.consumer_id, name: c.name, father_husband_name: c.father_husband_name, mobile: c.mobile, whatsapp_number: c.whatsapp_number })), ...pendingRequestIdentities]
    )
    if (duplicate) { toast.error(duplicate); return }

    const { data, error: consumerError } = await supabase.from('consumers').insert({
      name: newConsumer.name, father_husband_name: newConsumer.father_husband_name || null,
      mobile: newConsumer.mobile, whatsapp_number: newConsumer.whatsapp_same_as_mobile ? newConsumer.mobile : newConsumer.whatsapp_number,
      whatsapp_same_as_mobile: newConsumer.whatsapp_same_as_mobile,
      house_no: newConsumer.house_no, sector: newConsumer.sector, area: newConsumer.area, address: newConsumer.address,
      connections: newConsumer.connections || 1, monthly_rate: newConsumer.monthly_rate, status: 'active',
    }).select('consumer_id').single()
    if (consumerError) { toast.error(friendlyError(consumerError)); return }

    toast.success(`Consumer ${data.consumer_id} created`)
    setShowAddConsumer(false)
    setBillingSetupTarget({ consumer_id: data.consumer_id, name: newConsumer.name, scheduleId: null })
    setBillingSetupForm({ discount_amount: 0, description: '', recurring_enabled: true, recurring_frequency: 'monthly', monthly_amount: newConsumer.monthly_rate })
    setNewConsumer({
      name: '', father_husband_name: '', mobile: '', whatsapp_number: '', whatsapp_same_as_mobile: true,
      house_no: '', sector: '', area: '', address: '', connections: 1, monthly_rate: 200,
    })
    loadData()
  }

  // Reuses the exact recurring-schedule mechanism the New Connections page's
  // Activation step already uses. Handles both cases: no scheduleId ->
  // create fresh (Add Consumer, or the "Set Up Recurring" button on an
  // existing consumer with none yet); scheduleId set -> update the existing
  // schedule's amount/discount/frequency in place, leaving next_run_date
  // untouched so an edit never skips or duplicates a billing cycle.
  const saveBillingSetup = async () => {
    if (!billingSetupTarget) return
    setSettingUpBilling(true)

    if (billingSetupTarget.scheduleId) {
      const { error: schedErr } = await supabase.from('recurring_schedules').update({
        frequency: billingSetupForm.recurring_frequency,
        amount_pkr: billingSetupForm.monthly_amount, discount_amount: billingSetupForm.discount_amount || 0,
        particular: billingSetupForm.description || null, is_active: billingSetupForm.recurring_enabled,
      }).eq('id', billingSetupTarget.scheduleId)
      if (schedErr) toast.error(`Recurring schedule could not be updated: ${schedErr.message}`)
      else toast.success(billingSetupForm.recurring_enabled ? 'Recurring billing updated' : 'Recurring billing paused')
    } else if (billingSetupForm.recurring_enabled && billingSetupForm.monthly_amount > 0) {
      const next = new Date()
      if (billingSetupForm.recurring_frequency === 'daily') next.setDate(next.getDate() + 1)
      else if (billingSetupForm.recurring_frequency === 'weekly') next.setDate(next.getDate() + 7)
      else if (billingSetupForm.recurring_frequency === 'monthly') next.setMonth(next.getMonth() + 1)
      else if (billingSetupForm.recurring_frequency === 'semi_annual') next.setMonth(next.getMonth() + 6)
      else next.setFullYear(next.getFullYear() + 1)
      // Gross amount + discount_amount kept separate (not pre-netted) so the
      // generated bill posts the discount as its own ledger leg (migration
      // 067) and still counts toward the "With Discount" filter below.
      const { error: schedErr } = await supabase.from('recurring_schedules').insert({
        system: 'water_supply', schedule_type: 'bill', frequency: billingSetupForm.recurring_frequency,
        next_run_date: next.toISOString(), consumer_id: billingSetupTarget.consumer_id,
        amount_pkr: billingSetupForm.monthly_amount, discount_amount: billingSetupForm.discount_amount || 0,
        particular: billingSetupForm.description || null,
      })
      if (schedErr) toast.error(schedErr.code === '23505' ? 'This consumer already has an active recurring bill' : `Recurring schedule could not be created: ${schedErr.message}`)
      else toast.success(t('billing.ok.recurringSetUp'))
    }
    setSettingUpBilling(false)
    setBillingSetupTarget(null)
    loadData()
  }

  // Manual trigger for an already-existing consumer (Add Consumer auto-opens
  // this same modal right after creation — this is the same step, just
  // reachable on demand from the consumer detail panel).
  const openRecurringSetup = (c: Consumer) => {
    const existing = recurringSchedules[c.consumer_id]
    setBillingSetupTarget({ consumer_id: c.consumer_id, name: c.name, scheduleId: existing?.id ?? null })
    setBillingSetupForm(existing ? {
      discount_amount: existing.discount_amount, description: existing.particular || '',
      recurring_enabled: existing.is_active, recurring_frequency: existing.frequency, monthly_amount: existing.amount_pkr,
    } : {
      discount_amount: 0, description: '', recurring_enabled: true, recurring_frequency: 'monthly', monthly_amount: c.monthly_rate,
    })
  }

  const openEditConsumer = (c: Consumer) => {
    setEditForm({
      name: c.name, father_husband_name: c.father_husband_name || '', mobile: c.mobile,
      whatsapp_number: c.whatsapp_number || '', whatsapp_same_as_mobile: c.whatsapp_same_as_mobile,
      house_no: c.house_no || '', sector: c.sector || '', area: c.area || '', address: c.address || '',
      connections: c.connections || 1, monthly_rate: c.monthly_rate,
    })
    setEditConsumerTarget(c)
  }

  const saveEditConsumer = async () => {
    if (!editConsumerTarget) return
    if (!editForm.name.trim() || !editForm.mobile.trim()) { toast.error(t('billing.err.nameMobileRequired')); return }

    const editWhatsapp = editForm.whatsapp_same_as_mobile ? editForm.mobile : editForm.whatsapp_number
    const editDuplicate = findDuplicate(
      { name: editForm.name, father_husband_name: editForm.father_husband_name, mobile: editForm.mobile, whatsapp_number: editWhatsapp },
      [...consumers.map((c) => ({ id: c.consumer_id, name: c.name, father_husband_name: c.father_husband_name, mobile: c.mobile, whatsapp_number: c.whatsapp_number })), ...pendingRequestIdentities],
      editConsumerTarget.consumer_id
    )
    if (editDuplicate) { toast.error(editDuplicate); return }

    setSavingEdit(true)
    const { error } = await supabase.from('consumers').update({
      name: editForm.name, father_husband_name: editForm.father_husband_name || null, mobile: editForm.mobile,
      whatsapp_number: editForm.whatsapp_same_as_mobile ? editForm.mobile : editForm.whatsapp_number,
      whatsapp_same_as_mobile: editForm.whatsapp_same_as_mobile,
      house_no: editForm.house_no || null, sector: editForm.sector || null, area: editForm.area || null,
      address: editForm.address || null, connections: editForm.connections || 1, monthly_rate: editForm.monthly_rate,
    }).eq('consumer_id', editConsumerTarget.consumer_id)
    setSavingEdit(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('billing.ok.consumerUpdated'))
    setEditConsumerTarget(null)
    loadData()
  }

  // Temporary pause, not permanent — a disconnected consumer can't be flipped
  // back on through this toggle (they'd need a fresh connection request).
  const toggleConsumerActive = async (c: Consumer) => {
    if (c.status === 'disconnected') return
    const nextStatus = c.status === 'active' ? 'inactive' : 'active'
    const { error } = await supabase.from('consumers').update({ status: nextStatus }).eq('consumer_id', c.consumer_id)
    if (error) { toast.error(friendlyError(error)); return }
    await supabase.from('accounts').update({ is_active: nextStatus === 'active' }).eq('type', 'consumer').eq('consumer_id', c.consumer_id)
    // Deactivating without pausing the schedule would keep generating bills
    // for someone marked inactive — pause it in sync, and resume it in sync
    // when reactivated, same as disconnect_consumer() already does for a
    // permanent disconnection.
    const schedule = recurringSchedules[c.consumer_id]
    if (schedule) {
      await supabase.from('recurring_schedules').update({ is_active: nextStatus === 'active' }).eq('id', schedule.id)
    }
    toast.success(
      nextStatus === 'active'
        ? `Consumer activated${schedule ? ' — recurring billing resumed' : ''}`
        : `Consumer deactivated${schedule ? ' — recurring billing paused' : ''}`
    )
    setSelectedConsumer({ ...c, status: nextStatus })
    loadData()
  }

  const openDisconnect = async (c: Consumer) => {
    setDisconnectTarget(c)
    setDisconnectPreview(null)
    const { data, error } = await supabase.rpc('preview_disconnect_consumer', { p_consumer_id: c.consumer_id })
    if (error) { toast.error(friendlyError(error)); setDisconnectTarget(null); return }
    setDisconnectPreview(data)
  }

  const confirmDisconnect = async () => {
    if (!disconnectTarget) return
    setDisconnecting(true)
    const { data, error } = await supabase.rpc('disconnect_consumer', { p_consumer_id: disconnectTarget.consumer_id })
    setDisconnecting(false)
    if (error) { toast.error(friendlyError(error)); return }
    const parts: string[] = []
    if (data.applied > 0) parts.push(`Rs. ${Number(data.applied).toLocaleString()} applied to their pending balance`)
    if (data.refund > 0) parts.push(`Rs. ${Number(data.refund).toLocaleString()} refunded`)
    toast.success(`Consumer disconnected${parts.length ? ' — ' + parts.join(', ') : ''}`)
    setDisconnectTarget(null)
    setDisconnectPreview(null)
    setSelectedConsumer(null)
    loadData()
  }

  const deleteBill = async () => {
    if (!confirmDeleteBill) return
    // The trigger in migration 204 refuses this too, but its message is English
    // and written for a log. Say it here in the language the accountant is
    // reading, naming the receipt they need to delete.
    const blocking = receiptsByBill[confirmDeleteBill] ?? []
    if (blocking.length > 0) {
      toast.error(renderTemplate(t('lock.billPaid'), { receipt: blocking.join(', ') }))
      setConfirmDeleteBill(null)
      return
    }
    const { error } = await supabase.from('bills').delete().eq('id', confirmDeleteBill)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('billing.ok.billDeleted'))
    setConfirmDeleteBill(null)
    loadData()
  }

  // Deep-link support: ?consumer=<id> auto-selects the consumer (used by links from
  // the invoice page and elsewhere).
  useEffect(() => {
    if (loading) return
    const consumerParam = searchParams.get('consumer')
    if (consumerParam) {
      const c = consumers.find((x) => x.consumer_id === consumerParam)
      if (c) setSelectedConsumer(c)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  // Deep-link support: ?quickFilter=<value>, from the analytics cards that
  // used to live on this page and now live on the Water Supply dashboard
  // (migration of that grid — mobile view stacked six cards into a wall
  // that pushed the actual consumer list below the fold). Validated against
  // the real type rather than cast, so a stale/mistyped link just falls
  // back to "none" instead of putting the state in an impossible value.
  useEffect(() => {
    const qf = searchParams.get('quickFilter')
    const valid: QuickFilter[] = ['billed_this_month', 'active', 'inactive', 'with_discount', 'without_discount', 'new_this_month']
    if (qf && (valid as string[]).includes(qf)) setQuickFilter(qf as QuickFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendWhatsApp = (consumer: Consumer) => {
    const stats = consumerStats[consumer.consumer_id]
    if (!consumer.mobile) { toast.error(t('billing.err.noMobile')); return }
    const template = messageTemplates.consumer_outstanding_notify
      ?? `*${SITE.name} Water Committee*\n\nDear %%name%%, your outstanding water bill is Rs. %%outstanding%% (%%pending_count%% bill(s) pending). Consumer No: %%consumer_id%%. Please pay at your earliest convenience. Thank you.`
    const msg = encodeURIComponent(renderTemplate(template, {
      name: consumer.name, outstanding: stats.outstanding.toLocaleString(),
      pending_count: String(stats.pendingCount), consumer_id: consumer.consumer_id,
    }))
    const phone = consumer.mobile.replace(/\D/g, '')
    const intlPhone = phone.startsWith('0') ? '92' + phone.slice(1) : phone
    window.open(`https://wa.me/${intlPhone}?text=${msg}`, '_blank')
  }

  const startPayment = (bill: Bill) => {
    const rem = outstanding(bill)
    const consumer = consumers.find((c) => c.consumer_id === bill.consumer_id) ?? selectedConsumer
    setPaymentForm({
      billId: bill.id, amount: rem, method: 'cash', description: '',
      whatsapp: consumer?.whatsapp_number || consumer?.mobile || '',
      sendReceipt: true,
    })
  }

  return (
    // Per the reference design (billing-screen-code.md): the page layout
    // itself stays in its normal (LTR) order regardless of language — only
    // individual Urdu text runs get dir="rtl" so they read/align correctly.
    // Nothing here repositions with the language switch.
    <div>

      {/* Compact app-bar shown ONLY on mobile once a consumer is selected —
          back arrow + the consumer's name, centered, nothing else. The full
          toolbar below (New Consumer/Generate Bill/title/search/filters) is
          irrelevant once you're looking at one specific consumer's detail,
          and wastes vertical space repeating chrome for a list that's no
          longer even visible at this width. Desktop keeps both panes side
          by side, so the toolbar there stays put regardless of selection. */}
      {selectedConsumer && (
        <div className="flex md:hidden items-center gap-3 mb-5">
          <button onClick={() => setSelectedConsumer(null)} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer" aria-label={t('action.cancel')}>
            <ArrowLeft size={20} />
          </button>
          <h1 className="flex-1 text-center font-sans text-[16px] font-bold text-dp-on-surface truncate">{selectedConsumer.name}</h1>
          <div className="w-9 shrink-0" />
        </div>
      )}

      <div className={selectedConsumer ? 'hidden md:block' : ''}>
      {/* Header — restyled to match the design mock: the two page actions as a
          small button pair, title shrunk to sit beside them on one row instead
          of a large heading above. Kept the row itself in normal (unflipped)
          order — only the Urdu text inside gets font/direction styling. */}
      <div className="flex items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAddConsumer(true)} className="flex items-center gap-1.5 border-[1.5px] border-dp-secondary bg-white text-dp-secondary rounded-[10px] px-3.5 py-2 font-sans text-[12.5px] font-semibold hover:bg-dp-secondary/5 transition-all cursor-pointer">
            <Plus size={14} /> <span dir={isUrdu ? 'rtl' : undefined}>{t('billing.addConsumer')}</span>
          </button>
          <Link href="/admin/finance/water_supply?action=generate_bill" className="flex items-center gap-1.5 bg-dp-secondary text-white rounded-[10px] px-4 py-2 font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <Plus size={14} /> <span dir={isUrdu ? 'rtl' : undefined}>{t('billing.generateBill')}</span>
          </Link>
        </div>
        <h1 dir={isUrdu ? 'rtl' : undefined} className="font-heading text-[21px] font-semibold text-dp-on-surface">{t('billing.title')}</h1>
      </div>

      {/* The six analytics cards that used to sit here (billed this month,
          active/inactive, with/without discount, new this month) moved to
          the Water Supply dashboard section on the admin home page —
          stacked six-across even on mobile, they pushed the actual
          consumer list below the fold before anyone got to it. They still
          filter this same list; a dashboard card now links here with
          ?quickFilter=<value> (read on mount above) instead of living
          inline. toggleQuickFilter/monthlyStats stay — the filter bar
          below and the list filtering itself still need them. */}
      {quickFilter !== 'none' && (
        <div className="flex items-center justify-between gap-2 bg-dp-secondary/10 border border-dp-secondary/30 rounded-lg px-4 py-2 mb-4 flex-wrap">
          <span className="font-sans text-[13px] text-dp-primary font-semibold">
            Filter: {{
              billed_this_month: 'Billed this month',
              active: 'Active connections',
              inactive: 'Deactivated connections',
              with_discount: 'With discount',
              without_discount: 'Without discount',
              new_this_month: 'New this month',
            }[quickFilter]}
          </span>
          <button
            onClick={() => setQuickFilter('none')}
            className="text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer whitespace-nowrap"
          >
            {t('billing.clear')}
          </button>
        </div>
      )}

      {/* Filters — restyled per the reference design: a filled search pill
          with a small square filter-icon button beside it (decorative, the
          mock shows it unconditionally next to an always-visible filter row
          below — same as here), then the two selects as chip-style rows.
          Both selects are real <select>s underneath (appearance-none, a
          chevron drawn over them) — only the skin changed, not the control. */}
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="relative flex-1">
          <Search size={16} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('billing.searchPlaceholder')} dir={isUrdu ? 'rtl' : undefined} className="w-full ps-10 pe-4 py-2.5 border-none rounded-xl bg-dp-surface-container-low focus:ring-2 focus:ring-dp-secondary/30 text-[13px] font-sans" />
        </div>
        <button type="button" className="w-[42px] h-[42px] shrink-0 rounded-xl bg-dp-surface-container-low border-none flex items-center justify-center text-dp-on-surface-variant cursor-pointer">
          <SlidersHorizontal size={17} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2.5 mb-6">
        <div className="relative">
          <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)} dir={isUrdu ? 'rtl' : undefined} className="w-full appearance-none border border-dp-outline-variant rounded-[11px] ps-3.5 pe-9 py-2.5 text-[12px] font-sans bg-white focus:border-dp-secondary focus:ring-0 text-dp-on-surface-variant">
            <option value="">{t('billing.allSectors')}</option>
            {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <ChevronDown size={14} className="absolute end-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        </div>
        <div className="relative">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} dir={isUrdu ? 'rtl' : undefined} className="w-full appearance-none border border-dp-outline-variant rounded-[11px] ps-3.5 pe-9 py-2.5 text-[12px] font-sans bg-white focus:border-dp-secondary focus:ring-0 text-dp-on-surface-variant">
            <option value="">{t('billing.allStatus')}</option>
            <option value="pending">{t('billing.hasOutstanding')}</option>
            <option value="clear">{t('billing.fullyPaid')}</option>
          </select>
          <ChevronDown size={14} className="absolute end-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        </div>
      </div>
      </div>

      {/* Two-column layout — stays in normal left/right order at every
          language, per the reference design. */}
      <div className="flex gap-6 h-[calc(100vh-300px)] min-h-[420px]">

        {/* Consumer list */}
        <div className={`${selectedConsumer ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-[340px] md:flex-shrink-0 min-h-0`}>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden flex flex-col flex-1 min-h-0">
            {loading ? (
              <div className="p-8 text-center text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
            ) : filteredConsumers.length === 0 ? (
              <div className="p-8 text-center text-dp-on-surface-variant font-sans">{t('billing.noConsumers')}</div>
            ) : (
              <div className="overflow-y-auto hide-scrollbar flex-1 min-h-0">
                {filteredConsumers.map((c, i) => {
                  const stats = consumerStats[c.consumer_id]
                  const isSelected = selectedConsumer?.consumer_id === c.consumer_id
                  return (
                    <button
                      key={c.consumer_id}
                      onClick={() => setSelectedConsumer(c)}
                      className={`w-full text-start px-4 py-3 flex items-center justify-between gap-3 transition-colors ${i > 0 ? 'border-t border-dp-outline-variant' : ''} ${isSelected ? 'bg-dp-primary-container/30 border-s-4 border-s-dp-secondary' : 'hover:bg-dp-surface-container-low'}`}
                    >
                      <div className="min-w-0">
                        {c.status === 'disconnected' && (
                          <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wide bg-gray-200 text-gray-700">
                            <Ban size={9} /> {t('billing.disconnected')}
                          </span>
                        )}
                        {c.status === 'inactive' && (
                          <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800">
                            <Power size={9} /> {t('billing.inactive')}
                          </span>
                        )}
                        {inProcessConsumerIds.has(c.consumer_id) && (
                          <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wide bg-dp-secondary/15 text-dp-secondary">
                            <UserPlus size={9} /> {t('billing.newConnectionInProcess')}
                          </span>
                        )}
                        {complaintsByConsumer[c.consumer_id] && (
                          <span className={`inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wide ${complaintStatusColors[complaintsByConsumer[c.consumer_id].status]}`}>
                            <AlertCircle size={9} /> {complaintsByConsumer[c.consumer_id].complaint_number}
                          </span>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-sans text-[11px] font-bold text-dp-secondary truncate max-w-[140px]">{c.consumer_id}</span>
                          {c.sector && <span className="text-[10px] text-dp-on-surface-variant font-sans">{c.sector}</span>}
                          {recurringSchedules[c.consumer_id]?.is_active ? (
                            <span className="flex items-center gap-0.5 text-[9.5px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full" title={t('billing.tip.hasRecurring')}>
                              <Repeat size={9} /> {t('billing.recurring')}
                            </span>
                          ) : recurringSchedules[c.consumer_id] ? (
                            // Has a schedule row, just paused — a distinct state from
                            // "never set up", so this is the account the accountant
                            // actually needs to go resume, not configure from scratch.
                            <span className="flex items-center gap-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded-full" title={t('billing.tip.recurringPaused')}>
                              <PauseCircle size={9} /> {t('billing.paused')}
                            </span>
                          ) : (
                            <span className="text-[9.5px] font-bold uppercase tracking-wide text-dp-on-surface-variant bg-dp-surface-container-low px-1.5 py-0.5 rounded-full" title={t('billing.tip.noRecurring')}>
                              {t('billing.notRecurring')}
                            </span>
                          )}
                        </div>
                        <p className="font-sans text-[15px] font-semibold text-dp-on-surface truncate">{c.name}</p>
                        {c.mobile && <p className="font-sans text-[12px] text-dp-on-surface-variant">{c.mobile}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {stats.pendingCount > 0 ? (
                          <div className="text-end">
                            <p className="font-sans text-[13px] font-bold text-dp-error">Rs. {stats.outstanding.toLocaleString()}</p>
                            <p className="font-sans text-[10px] text-dp-error/70">{stats.pendingCount} pending</p>
                            <p className="font-sans text-[9.5px] text-dp-error/60 max-w-[110px] truncate" title={stats.pendingMonths.join(', ')}>{stats.pendingMonths.join(', ')}</p>
                          </div>
                        ) : (
                          <CheckCircle2 size={18} className="text-dp-secondary" />
                        )}
                        <ChevronRight size={16} className="text-dp-on-surface-variant" />
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-2 text-center">
            {filteredConsumers.length} of {consumers.length} consumers
          </p>
        </div>

        {/* Consumer detail panel */}
        {selectedConsumer ? (
          <div ref={detailPanelRef} className="flex-1 bg-white rounded-[18px] shadow-[0_2px_10px_rgba(20,50,35,0.06)] overflow-hidden flex flex-col min-h-0">
            {/* Consumer header — icons on the left, info right-aligned on the
                right (a deliberate reversal from plain-LTR default, matching
                the reference design's own card exactly, not a language flip). */}
            <div className="px-4 pt-4 pb-3 border-b border-dp-outline-variant/60">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* No mobile close(X) here anymore — the back arrow in the
                      new compact app-bar above does that job now, and having
                      both was a redundant/duplicate way to do the same thing. */}
                  {selectedConsumer.mobile && (
                    <button
                      onClick={() => sendWhatsApp(selectedConsumer)}
                      className="w-[31px] h-[31px] rounded-[9px] bg-emerald-50 border-none flex items-center justify-center text-emerald-700 hover:opacity-90 transition-all cursor-pointer"
                      title={t('billing.tip.sendWhatsapp')}
                      aria-label={t('billing.notify')}
                    >
                      <MessageCircle size={15} />
                    </button>
                  )}
                </div>
                <div className="min-w-0 flex-1 text-end">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {selectedConsumer.sector && <span className="font-sans text-[11.5px] text-dp-on-surface-variant">{selectedConsumer.sector}</span>}
                    <span className="font-sans text-[11px] font-bold text-white bg-dp-secondary px-2.5 py-1 rounded-[6px] tracking-wide truncate max-w-[140px]">{selectedConsumer.consumer_id}</span>
                    {selectedConsumer.status === 'disconnected' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide bg-gray-200 text-gray-700"><Ban size={10} /> {t('billing.disconnected')}</span>
                    )}
                    {selectedConsumer.status === 'inactive' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800"><Power size={10} /> {t('billing.inactive')}</span>
                    )}
                  </div>
                  <div className="font-sans text-[19px] font-bold text-dp-on-surface mt-1 truncate">{selectedConsumer.name}</div>
                  {(selectedConsumer.house_no || selectedConsumer.mobile) && (
                    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 mt-1 font-sans text-[11.5px] text-dp-on-surface-variant">
                      {selectedConsumer.house_no && (
                        <span dir={isUrdu ? 'rtl' : undefined} className="inline-flex items-center gap-1">
                          <Home size={12} className="shrink-0" />
                          {t('billing.house')} <span dir="ltr" className="tabular-nums">{selectedConsumer.house_no}</span>
                        </span>
                      )}
                      {selectedConsumer.mobile && (
                        <span className="inline-flex items-center gap-1">
                          <Phone size={12} className="shrink-0" />
                          <span dir="ltr" className="tabular-nums">{selectedConsumer.mobile}</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Linked complaint */}
              {complaintsByConsumer[selectedConsumer.consumer_id] && (
                <Link
                  href={`/admin/complaints/${complaintsByConsumer[selectedConsumer.consumer_id].id}`}
                  className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 flex items-center justify-between gap-3 hover:bg-amber-100/60 transition-all"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertCircle size={16} className="text-amber-700 shrink-0" />
                    <span className="font-sans text-[13px] font-bold text-amber-800">{complaintsByConsumer[selectedConsumer.consumer_id].complaint_number}</span>
                    <span className={`px-2 py-0.5 rounded-full font-sans text-[10px] font-bold uppercase tracking-wide ${complaintStatusColors[complaintsByConsumer[selectedConsumer.consumer_id].status]}`}>
                      {complaintStatusLabels[complaintsByConsumer[selectedConsumer.consumer_id].status]}
                    </span>
                    <span className="font-sans text-[12.5px] text-amber-900 truncate">{complaintsByConsumer[selectedConsumer.consumer_id].complaint_text}</span>
                  </div>
                  <ChevronRight size={15} className="text-amber-700 shrink-0" />
                </Link>
              )}
            </div>

            {/* Balance + the action that settles it, as one unit */}
            {selectedOutstanding > 0 && (
              <div className="mx-4 mt-3.5 bg-red-50 rounded-[13px] px-[15px] py-[13px] flex items-center justify-between">
                <button
                  onClick={() => { const firstUnpaid = selectedBills.find((b) => outstanding(b) > 0); if (firstUnpaid) startPayment(firstUnpaid) }}
                  className="font-sans text-[12.5px] font-semibold bg-dp-secondary text-white border-none px-[18px] py-2 rounded-[10px] cursor-pointer"
                >
                  {t('billing.collect', 'وصولی')}
                </button>
                <div className="text-end">
                  <div dir={isUrdu ? 'rtl' : undefined} className="font-sans text-[11px] text-dp-error/80">{t('billing.balanceDue', 'باقی رقم')}</div>
                  <div className="tabular-nums text-[23px] font-bold text-dp-error tracking-tight">Rs. {selectedOutstanding.toLocaleString()}</div>
                </div>
              </div>
            )}

            {/* All four lifecycle actions, one row, ranked by weight — must
                stay on one line at 390px (whitespace-nowrap + tight gap/pad),
                a fifth action would need to go behind a menu instead. */}
            {/* justify-end + flex-wrap, not overflow-x-auto: English labels
                ("Permanent Disconnection") are long enough to overflow at
                390px, and end-justified content inside a horizontal-scroll
                container can leave its own start permanently unreachable
                (scrollLeft can't go negative) — wrapping to a 2nd line is
                the safe degrade; Urdu's shorter labels still fit one row. */}
            <div className="mx-4 mt-3.5 mb-4 pt-3 border-t border-dp-outline-variant/60 flex items-center justify-end gap-1.5 flex-wrap">
                {selectedConsumer.status === 'disconnected' ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-[7px] rounded-[9px] font-sans text-[11px] font-bold bg-gray-100 text-gray-600 whitespace-nowrap" title={t('billing.tip.reconnects')}>
                    <Ban size={11} />{t('billing.disconnectedNote')}</span>
                ) : (
                  <button onClick={() => openDisconnect(selectedConsumer)} className="border border-red-200 bg-white rounded-[9px] px-2.5 py-[7px] cursor-pointer">
                    <span className="font-sans text-[11px] font-semibold text-dp-error whitespace-nowrap">{t('billing.permanentDisconnection')}</span>
                  </button>
                )}
                {selectedConsumer.status !== 'disconnected' && (
                  <button onClick={() => setConfirmToggleActive(selectedConsumer)} className="border border-dp-outline-variant bg-white rounded-[9px] px-2.5 py-[7px] cursor-pointer">
                    <span className="font-sans text-[11px] font-semibold text-dp-on-surface-variant whitespace-nowrap">{selectedConsumer.status === 'active' ? t('billing.deactivateAction') : t('billing.activateAction')}</span>
                  </button>
                )}
                <button onClick={() => openEditConsumer(selectedConsumer)} className="border border-dp-outline-variant bg-white rounded-[9px] px-2.5 py-[7px] cursor-pointer">
                  <span className="font-sans text-[11px] font-semibold text-dp-on-surface-variant whitespace-nowrap">{t('action.edit')}</span>
                </button>
                {recurringSchedules[selectedConsumer.consumer_id]?.is_active ? (
                  <button
                    onClick={() => openRecurringSetup(selectedConsumer)}
                    title={t('billing.tip.editRecurring')}
                    className="flex items-center gap-1.5 bg-gray-100 border-none rounded-[9px] px-2.5 py-[7px] cursor-pointer hover:bg-gray-200 transition-all"
                  >
                    <PauseCircle size={12} className="text-gray-500" />
                    <span className="font-sans text-[11px] font-semibold text-gray-600 whitespace-nowrap">{t('billing.recurringBilling')}</span>
                  </button>
                ) : recurringSchedules[selectedConsumer.consumer_id] ? (
                  // Has a schedule row, just paused — its own amber state so it
                  // reads as "resume this" rather than "never set up" (the bug
                  // that produced a real duplicate row: this state used to be
                  // indistinguishable from "no schedule", so Save created a
                  // second one instead of reactivating the paused original).
                  <button
                    onClick={() => openRecurringSetup(selectedConsumer)}
                    title={t('billing.tip.recurringPaused')}
                    className="flex items-center gap-1.5 bg-amber-50 border-none rounded-[9px] px-2.5 py-[7px] cursor-pointer hover:bg-amber-100 transition-all"
                  >
                    <PauseCircle size={12} className="text-amber-700" />
                    <span className="font-sans text-[11px] font-semibold text-amber-800 whitespace-nowrap">{t('billing.recurringBillingPaused')}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => openRecurringSetup(selectedConsumer)}
                    className="flex items-center gap-1.5 bg-emerald-50 border-none rounded-[9px] px-2.5 py-[7px] cursor-pointer hover:bg-emerald-100 transition-all"
                  >
                    <Repeat size={12} className="text-dp-secondary" />
                    <span className="font-sans text-[11px] font-semibold text-dp-secondary whitespace-nowrap">{t('billing.recurringBilling')}</span>
                  </button>
                )}
            </div>

            {/* Bills list */}
            <div className="flex-1 overflow-y-auto min-h-0 p-4">
              <div className="flex items-center justify-between mb-1">
                <Link
                  href={`/admin/finance/water_supply?action=generate_bill&consumer=${selectedConsumer.consumer_id}`}
                  className="flex items-center gap-1.5 text-dp-secondary font-sans text-[12.5px] font-medium hover:underline cursor-pointer"
                >
                  <Plus size={14} /> {t('billing.generateBill')}
                </Link>
                <h3 className="font-sans text-[16px] font-semibold text-dp-on-surface">{t('billing.billsHistory')}</h3>
              </div>

              {selectedBills.length === 0 && (
                <div className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('billing.noBills')}</div>
              )}

              <div className="mt-3 flex flex-col gap-2.5">
              {selectedBills.map((bill) => {
                const rem = outstanding(bill)
                // Why this bill cannot be touched, if it cannot. Cash received
                // is checked first because it is the one an accountant can act
                // on: delete the receipt and the bill opens again. A closed
                // month cannot be reopened at all — it needs a journal voucher
                // in the current month instead.
                const blockingReceipts = receiptsByBill[bill.id] ?? []
                const monthClosed = periodIsLocked(bill.year, bill.month, lockRule)
                const lockReason = blockingReceipts.length > 0
                  ? renderTemplate(t('lock.billPaid'), { receipt: blockingReceipts.join(', ') })
                  : monthClosed ? t('lock.periodClosed') : null
                const fullBillHref = `/admin/finance/water_supply?action=generate_bill&bill=${bill.id}&consumer=${bill.consumer_id}`
                return (
                  <div key={bill.id} className="bg-white border border-dp-outline-variant rounded-[15px] shadow-[0_2px_8px_rgba(20,50,35,0.05)] px-[15px] py-3.5">
                    {/* Badge on one side, month/bill-number stacked and
                        right-aligned on the other — matches the reference
                        design's own bill-row header exactly. */}
                    <div className="flex items-center justify-between gap-3">
                      <StatusBadge bill={bill} />
                      <div className="text-end">
                        {lockReason ? (
                          <div className="font-sans text-[15px] font-bold text-dp-on-surface">{t(monthKey(bill.month), fullMonths[bill.month])} {bill.year}</div>
                        ) : (
                          <Link href={fullBillHref} title={t('lock.openFullBill')}
                            className="font-sans text-[15px] font-bold text-dp-on-surface hover:text-dp-secondary hover:underline cursor-pointer">
                            {t(monthKey(bill.month), fullMonths[bill.month])} {bill.year}
                          </Link>
                        )}
                        {bill.bill_number && <div className="font-mono text-[11px] text-dp-on-surface-variant tabular-nums">#{bill.bill_number}</div>}
                      </div>
                    </div>

                    {(bill.discount_amount ?? 0) > 0 || bill.waiver_voucher_id ? (
                      <div className="flex flex-wrap justify-end gap-1.5 mt-2">
                        {(bill.discount_amount ?? 0) > 0 && (
                          <span className="text-[10.5px] font-semibold text-emerald-700">{t('billing.discountLabel')}: − Rs. {(bill.discount_amount ?? 0).toLocaleString()}</span>
                        )}
                        {bill.waiver_voucher_id && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10.5px] font-bold uppercase tracking-wide">
                            {waiverVoucherStatus[bill.waiver_voucher_id] === 'pending'
                              ? t('billing.waiverPending')
                              : bill.waiver_type === 'full' ? t('billing.committeeWaivedFull') : t('billing.committeeWaivedPercent').replace('{pct}', String(bill.waiver_percent))}
                          </span>
                        )}
                      </div>
                    ) : null}
                    {bill.description && <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5 text-end italic">{bill.description}</p>}

                    {/* Footer: action icons on one side, Paid/Total split on
                        the other, same as the reference design — extended
                        with a Receive Now icon and a lock-reason badge for
                        states the simpler mock didn't need to model. */}
                    <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-dp-outline-variant/60">
                      <div className="flex items-center gap-1.5">
                        {rem > 0 && (
                          <button
                            onClick={() => startPayment(bill)}
                            title={t('billing.receiveNow')}
                            className="w-[30px] h-[30px] rounded-[9px] bg-emerald-50 border-none flex items-center justify-center text-dp-secondary cursor-pointer"
                          >
                            <Banknote size={14} />
                          </button>
                        )}
                        <Link href={`/admin/invoice/bill/${bill.id}`} title={t('billing.tip.viewInvoice')} className="w-[30px] h-[30px] rounded-[9px] bg-dp-surface-container-low flex items-center justify-center text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                          <FileText size={13} />
                        </Link>
                        {lockReason ? (
                          // One padlock carrying the reason, rather than two
                          // greyed-out icons that say nothing about why. The
                          // receipt number is in the tooltip because that is
                          // the thing the accountant has to go and delete.
                          <span
                            title={lockReason}
                            className="w-[30px] h-[30px] rounded-[9px] bg-dp-surface-container-low flex items-center justify-center text-dp-on-surface-variant"
                          >
                            <Lock size={13} />
                          </span>
                        ) : (
                          <>
                            <Link href={fullBillHref} title={t('billing.tip.editBill')} className="w-[30px] h-[30px] rounded-[9px] bg-dp-surface-container-low flex items-center justify-center text-dp-on-surface-variant hover:text-dp-primary cursor-pointer">
                              <Pencil size={13} />
                            </Link>
                            <button onClick={() => setConfirmDeleteBill(bill.id)} title={t('billing.tip.deleteBill')} className="w-[30px] h-[30px] rounded-[9px] bg-dp-surface-container-low flex items-center justify-center text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-end">
                          <div dir={isUrdu ? 'rtl' : undefined} className="font-sans text-[10px] text-dp-on-surface-variant">{t('billing.paidLabel')}</div>
                          <div className={`tabular-nums text-[14.5px] font-bold ${(bill.paid_amount ?? 0) > 0 ? 'text-emerald-700' : 'text-dp-on-surface-variant'}`}>Rs. {(bill.paid_amount ?? 0).toLocaleString()}</div>
                        </div>
                        <div className="text-end">
                          <div dir={isUrdu ? 'rtl' : undefined} className="font-sans text-[10px] text-dp-on-surface-variant">{t('billing.total')}</div>
                          <div className="tabular-nums text-[14.5px] font-bold text-dp-on-surface">Rs. {bill.amount_pkr.toLocaleString()}</div>
                        </div>
                      </div>
                    </div>

                    {bill.paid_date && (
                      <div dir={isUrdu ? 'rtl' : undefined} className="text-[11.5px] text-emerald-800 mt-2.5 bg-emerald-50 rounded-[9px] px-[11px] py-2 leading-snug">
                        {t('billing.paymentReceivedOn')} {new Date(bill.paid_date).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}{bill.payment_method ? ` ${t('billing.via')} ${t(paymentMethodKeys[bill.payment_method] ?? '', bill.payment_method)}` : ''}
                        {rem <= 0 ? ` — ${t('billing.noOutstandingAmount')}` : ''}
                      </div>
                    )}

                    {/* Receive-payment popup lives once, outside this map — see
                        the "Receive Payment modal" block below. */}
                  </div>
                )
              })}
              </div>
            </div>
          </div>
        ) : (
          <div className="hidden md:flex flex-1 bg-white rounded-lg border border-dp-outline-variant items-center justify-center">
            <div className="text-center text-dp-on-surface-variant">
              <ChevronRight size={40} className="mx-auto mb-3 opacity-30" />
              <p className="font-sans text-[16px]">{t('billing.selectConsumer')}</p>
            </div>
          </div>
        )}
      </div>

      {/* Delete bill confirm */}
      <ConfirmDialog
        open={!!confirmDeleteBill}
        title={t('billing.confirmDeleteBillTitle')}
        message={t('billing.confirmDeleteBillMsg')}
        confirmLabel={t('action.delete')}
        onConfirm={deleteBill}
        onCancel={() => setConfirmDeleteBill(null)}
      />

      {/* Deactivate/Activate confirm — this used to fire immediately on
          click, with no chance to back out of taking a consumer out of
          active billing. */}
      <ConfirmDialog
        open={!!confirmToggleActive}
        title={confirmToggleActive?.status === 'active' ? t('billing.confirmDeactivateTitle') : t('billing.confirmActivateTitle')}
        message={
          confirmToggleActive
            ? (confirmToggleActive.status === 'active' ? t('billing.confirmDeactivateMsg') : t('billing.confirmActivateMsg')).replace('{name}', confirmToggleActive.name)
            : ''
        }
        confirmLabel={confirmToggleActive?.status === 'active' ? t('billing.deactivateAction') : t('billing.activateAction')}
        onConfirm={() => { if (confirmToggleActive) toggleConsumerActive(confirmToggleActive); setConfirmToggleActive(null) }}
        onCancel={() => setConfirmToggleActive(null)}
      />

      {/* Receive Payment modal — was an inline panel that expanded downward
          under the bill row, which on mobile pushed the WhatsApp/checkbox
          step below the fold. A popup keeps the row list stable and gives
          the accountant room to verify the number before recording cash. */}
      {paymentForm && (() => {
        const bill = bills.find((b) => b.id === paymentForm.billId)
        if (!bill) return null
        const rem = outstanding(bill)
        const consumer = consumers.find((c) => c.consumer_id === bill.consumer_id)
        const hasSavedNumber = !!consumer?.whatsapp_number
        return (
          <Modal title={t('billing.recordPayment')} onClose={() => setPaymentForm(null)}>
            <div className="space-y-4">
              <div className="flex items-center gap-2 bg-dp-surface-container-low rounded-lg px-3 py-2">
                <CreditCard size={15} className="text-dp-secondary shrink-0" />
                <span className="font-sans text-[13px] text-dp-on-surface-variant">{t(monthKey(bill.month), fullMonths[bill.month])} {bill.year}</span>
                <span className="font-sans text-[13px] font-semibold text-dp-on-surface ms-auto">{t('billing.outstandingAmount').replace('{amt}', rem.toLocaleString())}</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t('billing.amountPkr')}>
                  <input
                    type="number" min={1} value={paymentForm.amount || ''}
                    onChange={(e) => setPaymentForm({ ...paymentForm, amount: +e.target.value })}
                    className="input-field"
                  />
                </Field>
                <Field label={t('billing.method')}>
                  <select
                    value={paymentForm.method}
                    onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}
                    className="input-field"
                  >
                    <option value="cash">{t('billing.methodCash')}</option>
                    <option value="jazzcash">{t('billing.methodJazzcash')}</option>
                    <option value="easypaisa">{t('billing.methodEasypaisa')}</option>
                    <option value="bank">{t('billing.methodBank')}</option>
                  </select>
                </Field>
              </div>

              <Field label={t('billing.noteOptional')}>
                <input
                  type="text" value={paymentForm.description}
                  onChange={(e) => setPaymentForm({ ...paymentForm, description: e.target.value })}
                  placeholder={t('billing.receiptRefPlaceholder')}
                  className="input-field"
                />
              </Field>

              {paymentForm.amount < rem && paymentForm.amount > 0 && (
                <div className="flex items-center gap-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  <Clock size={14} className="shrink-0" />
                  <span className="font-sans text-[12px]">{t('billing.partialWillRemain').replace('{amt}', (rem - paymentForm.amount).toLocaleString())}</span>
                </div>
              )}

              <div className="border-t border-dp-outline-variant pt-3 space-y-2">
                <label className="flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-on-surface-variant">
                  <MessageCircle size={14} className="text-dp-secondary shrink-0" />
                  {hasSavedNumber ? t('billing.verifyWhatsapp') : t('billing.askWhatsapp')}
                </label>
                <input
                  type="text" value={paymentForm.whatsapp}
                  onChange={(e) => setPaymentForm({ ...paymentForm, whatsapp: e.target.value })}
                  placeholder="0300-1234567"
                  className="input-field"
                />
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox" checked={paymentForm.sendReceipt}
                    onChange={(e) => setPaymentForm({ ...paymentForm, sendReceipt: e.target.checked })}
                    className="accent-dp-secondary w-4 h-4"
                  />
                  <span className="font-sans text-[13px] text-dp-on-surface">{t('billing.sendReceiptNow')}</span>
                </label>
              </div>

              <div className="flex gap-2">
                <button onClick={recordPayment} className="flex-1 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                  {t('billing.recordPayment')}
                </button>
                <button onClick={() => setPaymentForm(null)} className="px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] text-dp-on-surface-variant hover:bg-dp-surface-container cursor-pointer">
                  {t('action.cancel')}
                </button>
              </div>
            </div>
          </Modal>
        )
      })()}

      {/* Post-payment receipt — only opens when "send receipt now" was
          checked; the accountant hits Share via WhatsApp here on the number
          just confirmed above. */}
      {viewPaymentReceipt && (
        <ReceiptModal data={viewPaymentReceipt} phone={paymentReceiptPhone} system="water_supply" onClose={() => setViewPaymentReceipt(null)} />
      )}

      {/* Add Consumer Modal */}
      {showAddConsumer && (
        <Modal title="Add New Consumer" onClose={() => setShowAddConsumer(false)}>
          <div className="space-y-4">
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2">
              This only creates the consumer profile. Generate their first bill afterwards from Transactions → Generate Bill.
            </p>
            <Field label="Full Name">
              <input type="text" value={newConsumer.name} onChange={(e) => setNewConsumer({ ...newConsumer, name: e.target.value })} className="input-field" />
            </Field>
            <Field label="Father / Husband Name (S/O)">
              <input type="text" value={newConsumer.father_husband_name} onChange={(e) => setNewConsumer({ ...newConsumer, father_husband_name: e.target.value })} className="input-field" />
            </Field>
            <Field label="Contact Number">
              <input type="text" value={newConsumer.mobile} onChange={(e) => setNewConsumer({ ...newConsumer, mobile: e.target.value })} placeholder="0300-1234567" className="input-field" />
            </Field>
            <div>
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input type="checkbox" checked={newConsumer.whatsapp_same_as_mobile} onChange={(e) => setNewConsumer({ ...newConsumer, whatsapp_same_as_mobile: e.target.checked })} className="accent-dp-secondary" />
                <span className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('billing.whatsappSame')}</span>
              </label>
              {!newConsumer.whatsapp_same_as_mobile && (
                <input type="text" value={newConsumer.whatsapp_number} onChange={(e) => setNewConsumer({ ...newConsumer, whatsapp_number: e.target.value })} placeholder="0300-1234567" className="input-field" />
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="House No.">
                <input type="text" value={newConsumer.house_no} onChange={(e) => setNewConsumer({ ...newConsumer, house_no: e.target.value })} className="input-field" />
              </Field>
              <Field label="Sector">
                <select value={newConsumer.sector} onChange={(e) => setNewConsumer({ ...newConsumer, sector: e.target.value })} className="input-field">
                  <option value="">{t('billing.selectSector')}</option>
                  {sectorOptions.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Area / Mohalla">
              <input type="text" value={newConsumer.area} onChange={(e) => setNewConsumer({ ...newConsumer, area: e.target.value })} className="input-field" />
            </Field>
            <Field label="Full Address">
              <textarea value={newConsumer.address} onChange={(e) => setNewConsumer({ ...newConsumer, address: e.target.value })} rows={2} className="input-field resize-none" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Number of Connections">
                <input type="number" min={1} value={newConsumer.connections || ''} onChange={(e) => setNewConsumer({ ...newConsumer, connections: +e.target.value })} className="input-field" />
              </Field>
              <Field label="Monthly Rate (PKR)">
                <input type="number" value={newConsumer.monthly_rate || ''} onChange={(e) => setNewConsumer({ ...newConsumer, monthly_rate: +e.target.value })} className="input-field" />
              </Field>
            </div>
            <button onClick={addConsumer} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">{t('billing.addConsumer')}</button>
          </div>
        </Modal>
      )}

      {/* Edit Consumer Modal */}
      {editConsumerTarget && (
        <Modal title="Edit Consumer" onClose={() => setEditConsumerTarget(null)}>
          <div className="space-y-4">
            <Field label="Full Name">
              <input type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="input-field" />
            </Field>
            <Field label="Father / Husband Name (S/O)">
              <input type="text" value={editForm.father_husband_name} onChange={(e) => setEditForm({ ...editForm, father_husband_name: e.target.value })} className="input-field" />
            </Field>
            <Field label="Contact Number">
              <input type="text" value={editForm.mobile} onChange={(e) => setEditForm({ ...editForm, mobile: e.target.value })} className="input-field" />
            </Field>
            <div>
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input type="checkbox" checked={editForm.whatsapp_same_as_mobile} onChange={(e) => setEditForm({ ...editForm, whatsapp_same_as_mobile: e.target.checked })} className="accent-dp-secondary" />
                <span className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('billing.whatsappSame')}</span>
              </label>
              {!editForm.whatsapp_same_as_mobile && (
                <input type="text" value={editForm.whatsapp_number} onChange={(e) => setEditForm({ ...editForm, whatsapp_number: e.target.value })} placeholder="0300-1234567" className="input-field" />
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="House No.">
                <input type="text" value={editForm.house_no} onChange={(e) => setEditForm({ ...editForm, house_no: e.target.value })} className="input-field" />
              </Field>
              <Field label="Sector">
                <select value={editForm.sector} onChange={(e) => setEditForm({ ...editForm, sector: e.target.value })} className="input-field">
                  <option value="">{t('billing.selectSector')}</option>
                  {sectorOptions.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Area / Mohalla">
              <input type="text" value={editForm.area} onChange={(e) => setEditForm({ ...editForm, area: e.target.value })} className="input-field" />
            </Field>
            <Field label="Address">
              <textarea value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} rows={2} className="input-field resize-none" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Number of Connections">
                <input type="number" min={1} value={editForm.connections || ''} onChange={(e) => setEditForm({ ...editForm, connections: +e.target.value })} className="input-field" />
              </Field>
              <Field label="Monthly Rate (PKR)">
                <input type="number" value={editForm.monthly_rate || ''} onChange={(e) => setEditForm({ ...editForm, monthly_rate: +e.target.value })} className="input-field" />
              </Field>
            </div>
            <button disabled={savingEdit} onClick={saveEditConsumer} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {savingEdit ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {/* Permanent Disconnection */}
      {disconnectTarget && (
        <Modal title={t('billing.permanentDisconnection')} onClose={() => { setDisconnectTarget(null); setDisconnectPreview(null) }}>
          <div className="space-y-4">
            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3">
              <p className="font-sans text-[14px] font-bold text-dp-on-surface">{disconnectTarget.name}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{disconnectTarget.consumer_id}</p>
            </div>
            {!disconnectPreview ? (
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant text-center py-4">{t('billing.calculatingSettlement')}</p>
            ) : (
              <div className="space-y-1.5 font-sans text-[13.5px]">
                <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('billing.securityHeld')}</span><span className="font-semibold">Rs. {disconnectPreview.deposit_on_hand.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('billing.pendingBalance')}</span><span className="font-semibold">Rs. {Math.max(disconnectPreview.pending_balance, 0).toLocaleString()}</span></div>
                {disconnectPreview.applied > 0 && (
                  <div className="flex justify-between text-dp-on-surface-variant"><span>{t('billing.appliedToPending')}</span><span>− Rs. {disconnectPreview.applied.toLocaleString()}</span></div>
                )}
                <div className="flex justify-between border-t border-dp-outline-variant pt-2 mt-1 font-bold text-[14.5px]">
                  <span>{disconnectPreview.refund > 0 ? t('billing.refundDue') : t('billing.stillOwed')}</span>
                  <span className={disconnectPreview.refund > 0 ? 'text-emerald-700' : 'text-dp-error'}>
                    Rs. {(disconnectPreview.refund > 0 ? disconnectPreview.refund : Math.max(disconnectPreview.pending_balance - disconnectPreview.applied, 0)).toLocaleString()}
                  </span>
                </div>
              </div>
            )}
            <p dir={isUrdu ? 'rtl' : undefined} className="font-sans text-[12px] text-dp-on-surface-variant bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {t('billing.disconnectCannotUndo')}
            </p>
            <button disabled={disconnecting || !disconnectPreview} onClick={confirmDisconnect} className="w-full bg-dp-error text-white py-3 rounded-lg font-sans font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-50">
              {disconnecting ? t('billing.processing') : t('billing.confirmPermanentDisconnection')}
            </button>
          </div>
        </Modal>
      )}

      {/* Setup Billing — appears right after Add Consumer saves, same step
          New Connections' Activation uses once a connection request is done. */}
      {billingSetupTarget && (
        <Modal title={billingSetupTarget.scheduleId ? 'Edit Recurring Billing' : 'Set Up Recurring Billing'} onClose={() => setBillingSetupTarget(null)}>
          <div className="space-y-4">
            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3">
              <p className="font-sans text-[14px] font-bold text-dp-on-surface">{billingSetupTarget.name}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{billingSetupTarget.consumer_id}</p>
            </div>
            <Field label="Monthly Bill Price">
              <input type="number" min={0} value={billingSetupForm.monthly_amount || ''} onChange={(e) => setBillingSetupForm({ ...billingSetupForm, monthly_amount: +e.target.value })} className="input-field" />
            </Field>
            <Field label="Discount (optional)">
              <input type="number" min={0} value={billingSetupForm.discount_amount || ''} onChange={(e) => setBillingSetupForm({ ...billingSetupForm, discount_amount: +e.target.value })} placeholder="0" className="input-field" />
            </Field>
            {billingSetupForm.discount_amount > 0 && (
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant -mt-2">
                {t('billing.netMonthly')} <span className="font-bold text-dp-on-surface">Rs. {Math.max(billingSetupForm.monthly_amount - billingSetupForm.discount_amount, 0).toLocaleString()}</span>
              </p>
            )}
            <Field label="Description (optional)">
              <input value={billingSetupForm.description} onChange={(e) => setBillingSetupForm({ ...billingSetupForm, description: e.target.value })} className="input-field" />
            </Field>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={billingSetupForm.recurring_enabled} onChange={(e) => setBillingSetupForm({ ...billingSetupForm, recurring_enabled: e.target.checked })} className="accent-dp-secondary w-4 h-4" />
              <span className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5"><Clock size={14} /> {t('billing.setRecurringMonthly')}</span>
            </label>
            {billingSetupForm.recurring_enabled && (
              <select value={billingSetupForm.recurring_frequency} onChange={(e) => setBillingSetupForm({ ...billingSetupForm, recurring_frequency: e.target.value })} className="input-field">
                <option value="daily">{t('billing.freqDaily')}</option>
                <option value="weekly">{t('billing.freqWeekly')}</option>
                <option value="monthly">{t('billing.freqMonthly')}</option>
                <option value="semi_annual">{t('billing.freqSemiAnnual')}</option>
                <option value="yearly">{t('billing.freqYearly')}</option>
              </select>
            )}
            <button disabled={settingUpBilling} onClick={saveBillingSetup} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {settingUpBilling ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary">{title}</h2>
          <button onClick={onClose} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{label}</label>
      {children}
    </div>
  )
}
