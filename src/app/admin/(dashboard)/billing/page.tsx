'use client'

import { useEffect, useState, useMemo, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Search, PlusCircle, X, ChevronRight, Phone,
  Home, MapPin, MessageCircle, AlertCircle, CheckCircle2,
  Clock, CreditCard, Banknote, Pencil, Receipt, Users, UserCheck, UserX, Tag, UserPlus, Repeat, Trash2, FileText,
  Power, Ban, PauseCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { billBadge, billBadgeClass } from '@/lib/billStatus'
import { renderTemplate } from '@/lib/messageTemplates'
import { findDuplicate, type DuplicateCandidate } from '@/lib/duplicateCheck'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

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
}

const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fullMonths = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const frequencyLabels: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month', semi_annual: '6 months', yearly: 'year' }

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
  const { t, locale } = useLocale()
  const searchParams = useSearchParams()
  const [consumers, setConsumers] = useState<Consumer[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sectorFilter, setSectorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedConsumer, setSelectedConsumer] = useState<Consumer | null>(null)
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
  const [showAddConsumer, setShowAddConsumer] = useState(false)
  const [confirmDeleteBill, setConfirmDeleteBill] = useState<string | null>(null)
  const [editConsumerTarget, setEditConsumerTarget] = useState<Consumer | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', father_husband_name: '', mobile: '', whatsapp_number: '', whatsapp_same_as_mobile: true,
    house_no: '', sector: '', area: '', address: '', connections: 1, monthly_rate: 200,
  })
  const [savingEdit, setSavingEdit] = useState(false)
  const [disconnectTarget, setDisconnectTarget] = useState<Consumer | null>(null)
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
    const [cRes, bRes, secRes, auditRes, recurRes, complaintsRes, inProcessRes, pendingReqRes] = await Promise.all([
      supabase.from('consumers').select('*').order('consumer_id'),
      supabase.from('bills').select('*').order('year', { ascending: false }).order('month', { ascending: false }),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
      supabase.from('audit_log').select('old_data, record_data').eq('table_name', 'consumers').eq('action', 'update').gte('performed_at', monthStart),
      supabase.from('recurring_schedules').select('id, consumer_id, amount_pkr, discount_amount, frequency, next_run_date, is_active, particular').eq('schedule_type', 'bill').eq('is_active', true),
      supabase.from('complaints').select('id, complaint_number, status, complaint_text, consumer_id').eq('system', 'water_supply').not('consumer_id', 'is', null).neq('status', 'verified'),
      supabase.from('connection_requests').select('consumer_id').eq('status', 'processing').not('consumer_id', 'is', null),
      // Not-yet-converted requests too, so a duplicate can be caught before it
      // ever becomes a real consumer, not just after.
      supabase.from('connection_requests').select('id, consumer_name, consumer_phone, whatsapp_number, father_husband_name').is('consumer_id', null),
    ])
    setConsumers(cRes.data ?? [])
    setPendingRequestIdentities((pendingReqRes.data ?? []).map((r) => ({
      id: r.id, name: r.consumer_name, mobile: r.consumer_phone, whatsapp_number: r.whatsapp_number, father_husband_name: r.father_husband_name,
    })))
    setBills(bRes.data ?? [])
    setSectorOptions(secRes.data ?? [])
    setRecurringSchedules(Object.fromEntries(
      (recurRes.data ?? []).filter((r) => r.consumer_id).map((r) => [r.consumer_id as string, r as RecurringSchedule])
    ))
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
    if (!recurringSchedules[c.consumer_id]) return 2
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

    const { error } = await supabase.from('payments').insert({
      bill_id: paymentForm.billId,
      consumer_id: bill.consumer_id,
      amount_pkr: entered,
      method: paymentForm.method,
      note: paymentForm.description || null,
    })

    if (error) { toast.error(friendlyError(error)); return }
    const remaining = outstanding(bill)
    if (entered > remaining) {
      toast.success(`Payment recorded — Rs. ${(entered - remaining).toLocaleString()} credited as advance balance`)
    } else {
      const isFull = (bill.paid_amount ?? 0) + entered >= netPayable(bill)
      toast.success(isFull ? 'Payment recorded — bill marked as paid' : `Partial payment of Rs. ${entered.toLocaleString()} recorded`)
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

  const pauseSchedule = async (scheduleId: string) => {
    const { error } = await supabase.from('recurring_schedules').update({ is_active: false }).eq('id', scheduleId)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('billing.ok.recurringPaused'))
    loadData()
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
    setPaymentForm({ billId: bill.id, amount: rem, method: 'cash', description: '' })
  }

  return (
    // This page has had its direction-specific CSS converted to logical
    // properties (ms-/me-/ps-/pe-/text-start/text-end), so it can carry its own
    // dir. Everything inside mirrors from this one attribute; the rest of the
    // app stays left-to-right until it gets the same treatment.
    <div dir={locale === 'ur' ? 'rtl' : 'ltr'}>

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('billing.title')}</h1>
        <div className="flex gap-3">
          <button onClick={() => setShowAddConsumer(true)} className="flex items-center gap-2 px-4 py-2 border-2 border-dp-secondary text-dp-secondary rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
            <PlusCircle size={16} /> {t('billing.addConsumer')}
          </button>
          <Link href="/admin/finance/water_supply?action=generate_bill" className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <PlusCircle size={16} /> {t('billing.generateBill')}
          </Link>
        </div>
      </div>

      {/* Analytics bar — this month's billing activity at a glance */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <button
          onClick={() => toggleQuickFilter('billed_this_month')}
          className={`text-start bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'billed_this_month' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title={t('billing.tip.billedThisMonth')}
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><Receipt size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">{t('billing.billedThisMonth')}</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-primary">Rs. {monthlyStats.billTotal.toLocaleString()}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">{monthlyStats.billCount} bill{monthlyStats.billCount === 1 ? '' : 's'}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('active')}
          className={`text-start bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'active' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title={t('billing.tip.active')}
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><UserCheck size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">{t('billing.activeConnections')}</span></div>
          <p className="font-sans text-[18px] font-bold text-emerald-700">{monthlyStats.activeConnections}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('inactive')}
          className={`text-start bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'inactive' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title={t('billing.tip.deactivated')}
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><UserX size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">{t('billing.deactivated')}</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-error">{monthlyStats.inactiveConnections}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">{deactivatedThisMonth} this month</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('with_discount')}
          className={`text-start bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'with_discount' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view only consumers with a discounted bill this month"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><Tag size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">{t('billing.withDiscount')}</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-primary">{monthlyStats.withDiscountCount}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">Rs. {monthlyStats.withDiscountTotal.toLocaleString()}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('without_discount')}
          className={`text-start bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'without_discount' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view consumers who were not given a discount this month (includes those not yet billed)"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><Users size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">{t('billing.withoutDiscount')}</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-primary">{monthlyStats.withoutDiscountCount}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">Rs. {monthlyStats.withoutDiscountTotal.toLocaleString()}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('new_this_month')}
          className={`text-start bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'new_this_month' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title={t('billing.tip.newThisMonth')}
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><UserPlus size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">{t('billing.newThisMonth')}</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-secondary">{monthlyStats.newThisMonth}</p>
        </button>
      </div>
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

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-outline" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('billing.searchPlaceholder')} className="w-full ps-10 pe-4 py-2 border-2 border-dp-outline-variant rounded-lg focus:border-dp-primary focus:ring-0 text-[14px] font-sans bg-white" />
        </div>
        <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)} className="px-3 py-2 border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans bg-white focus:border-dp-primary focus:ring-0">
          <option value="">{t('billing.allSectors')}</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans bg-white focus:border-dp-primary focus:ring-0">
          <option value="">{t('billing.allStatus')}</option>
          <option value="pending">{t('billing.hasOutstanding')}</option>
          <option value="clear">{t('billing.fullyPaid')}</option>
        </select>
      </div>

      {/* Two-column layout */}
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
                        <div className="flex items-center gap-2">
                          <span className="font-sans text-[11px] font-bold text-dp-secondary">{c.consumer_id}</span>
                          {c.sector && <span className="text-[10px] text-dp-on-surface-variant font-sans">{c.sector}</span>}
                          {recurringSchedules[c.consumer_id] ? (
                            <span className="flex items-center gap-0.5 text-[9.5px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full" title={t('billing.tip.hasRecurring')}>
                              <Repeat size={9} /> {t('billing.recurring')}
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
          <div className="flex-1 bg-white rounded-lg border border-dp-outline-variant overflow-hidden flex flex-col min-h-0">
            {/* Consumer header */}
            <div className="bg-dp-surface-container-low px-6 py-4 border-b border-dp-outline-variant">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-sans text-[12px] font-bold text-dp-secondary bg-dp-primary-container px-2 py-0.5 rounded">{selectedConsumer.consumer_id}</span>
                    {selectedConsumer.sector && (
                      <span className="font-sans text-[12px] text-dp-on-surface-variant flex items-center gap-1"><MapPin size={12} />{selectedConsumer.sector}</span>
                    )}
                    {selectedConsumer.status === 'disconnected' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide bg-gray-200 text-gray-700"><Ban size={10} /> {t('billing.disconnected')}</span>
                    )}
                    {selectedConsumer.status === 'inactive' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800"><Power size={10} /> {t('billing.inactive')}</span>
                    )}
                  </div>
                  <h2 className="font-heading text-[22px] font-bold text-dp-primary">{selectedConsumer.name}</h2>
                  <div className="flex flex-wrap gap-3 mt-1">
                    {selectedConsumer.mobile && (
                      <span className="font-sans text-[13px] text-dp-on-surface-variant flex items-center gap-1"><Phone size={13} />{selectedConsumer.mobile}</span>
                    )}
                    {selectedConsumer.house_no && (
                      <span className="font-sans text-[13px] text-dp-on-surface-variant flex items-center gap-1"><Home size={13} />House {selectedConsumer.house_no}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedConsumer.mobile && (
                    <button
                      onClick={() => sendWhatsApp(selectedConsumer)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#25d366] text-white rounded-lg font-sans text-[13px] font-semibold hover:opacity-90 transition-all cursor-pointer"
                      title={t('billing.tip.sendWhatsapp')}
                    >
                      <MessageCircle size={15} /> {t('billing.notify')}
                    </button>
                  )}
                  <button onClick={() => setSelectedConsumer(null)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer md:hidden">
                    <X size={20} />
                  </button>
                </div>
              </div>

              {/* Outstanding summary */}
              {selectedOutstanding > 0 && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-4 py-2 flex items-center gap-2">
                  <AlertCircle size={16} className="text-dp-error shrink-0" />
                  <span className="font-sans text-[14px] font-bold text-dp-error">Outstanding: Rs. {selectedOutstanding.toLocaleString()}</span>
                </div>
              )}

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

              {/* Lifecycle actions */}
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => openEditConsumer(selectedConsumer)} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
                  <Pencil size={13} /> {t('action.edit')}
                </button>
                {selectedConsumer.status !== 'disconnected' && (
                  <button onClick={() => toggleConsumerActive(selectedConsumer)} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
                    <Power size={13} /> {selectedConsumer.status === 'active' ? 'Deactivate' : 'Activate'}
                  </button>
                )}
                {selectedConsumer.status === 'disconnected' ? (
                  <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans text-[12.5px] font-bold bg-gray-100 text-gray-600" title={t('billing.tip.reconnects')}>
                    <Ban size={13} />{t('billing.disconnectedNote')}</span>
                ) : (
                  <button onClick={() => openDisconnect(selectedConsumer)} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-error/40 text-dp-error rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-error/5 transition-all cursor-pointer">
                    <Ban size={13} /> {t('billing.permanentDisconnection')}
                  </button>
                )}
              </div>
            </div>

            {/* Recurring billing — the one place to start or adjust a consumer's
                recurring water bill, instead of the separate Transactions →
                Recurring page. */}
            <div className="px-6 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low/40">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Repeat size={14} className="text-dp-secondary" />
                <span className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('billing.recurringBilling')}</span>
              </div>
              {recurringSchedules[selectedConsumer.consumer_id] ? (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="font-sans text-[13.5px] text-dp-on-surface">
                    Rs. {(recurringSchedules[selectedConsumer.consumer_id].amount_pkr - recurringSchedules[selectedConsumer.consumer_id].discount_amount).toLocaleString()} / {frequencyLabels[recurringSchedules[selectedConsumer.consumer_id].frequency] ?? recurringSchedules[selectedConsumer.consumer_id].frequency}
                    {recurringSchedules[selectedConsumer.consumer_id].discount_amount > 0 && (
                      <span className="text-emerald-700"> (Rs. {recurringSchedules[selectedConsumer.consumer_id].discount_amount.toLocaleString()} discount)</span>
                    )}
                    <span className="text-dp-on-surface-variant"> · Next: {new Date(recurringSchedules[selectedConsumer.consumer_id].next_run_date).toLocaleDateString('en-GB')}</span>
                  </p>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => openRecurringSetup(selectedConsumer)} title={t('billing.tip.editRecurring')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={14} /></button>
                    <button onClick={() => pauseSchedule(recurringSchedules[selectedConsumer.consumer_id].id)} title={t('billing.tip.pauseRecurring')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><PauseCircle size={15} /></button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('billing.noRecurring')}</p>
                  <button onClick={() => openRecurringSetup(selectedConsumer)} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    <Repeat size={13} /> {t('billing.setUpRecurring')}
                  </button>
                </div>
              )}
            </div>

            {/* Bills list */}
            <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-sans text-[14px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('billing.billsHistory')}</h3>
                <Link
                  href={`/admin/finance/water_supply?action=generate_bill&consumer=${selectedConsumer.consumer_id}`}
                  className="flex items-center gap-1 text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer"
                >
                  <PlusCircle size={14} /> {t('billing.generateBill')}
                </Link>
              </div>

              {selectedBills.length === 0 && (
                <div className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('billing.noBills')}</div>
              )}

              {selectedBills.map((bill) => {
                const rem = outstanding(bill)
                const isPaymentOpen = paymentForm?.billId === bill.id
                return (
                  <div key={bill.id} className={`border rounded-lg overflow-hidden ${rem <= 0 ? 'border-dp-outline-variant' : 'border-dp-error/30'}`}>
                    <div className="px-4 py-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-sans text-[15px] font-semibold text-dp-on-surface">{fullMonths[bill.month]} {bill.year}</span>
                          {bill.bill_number && <span className="font-mono text-[11px] text-dp-on-surface-variant">#{bill.bill_number}</span>}
                          <StatusBadge bill={bill} />
                        </div>
                        <div className="font-sans text-[13px] text-dp-on-surface-variant">
                          Total: Rs. {bill.amount_pkr.toLocaleString()}
                          {(bill.discount_amount ?? 0) > 0 && <span className="ms-2 text-emerald-700">Discount: − Rs. {(bill.discount_amount ?? 0).toLocaleString()}</span>}
                          {(bill.paid_amount ?? 0) > 0 && <span className="ms-2 text-emerald-600">Paid: Rs. {(bill.paid_amount ?? 0).toLocaleString()}</span>}
                          {rem > 0 && <span className="ms-2 text-dp-error">Due: Rs. {rem.toLocaleString()}</span>}
                          {bill.waiver_voucher_id && (
                            <span className="ms-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10.5px] font-bold uppercase tracking-wide">
                              {waiverVoucherStatus[bill.waiver_voucher_id] === 'pending'
                                ? 'Waiver Pending Approval'
                                : `Committee Waived ${bill.waiver_type === 'full' ? '(Full)' : `(${bill.waiver_percent}%)`}`}
                            </span>
                          )}
                        </div>
                        {bill.description && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 italic">{bill.description}</p>}
                        {bill.paid_date && (
                          <p className="font-sans text-[11px] text-dp-secondary mt-0.5">
                            Payment received on {new Date(bill.paid_date).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}{bill.payment_method ? ` via ${bill.payment_method}` : ''}
                            {rem <= 0 ? ' — No outstanding amount.' : ''}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {rem > 0 && (
                          <button
                            onClick={() => isPaymentOpen ? setPaymentForm(null) : startPayment(bill)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer"
                          >
                            <Banknote size={15} />
                            {t('billing.receiveNow')}
                          </button>
                        )}
                        <Link href={`/admin/invoice/bill/${bill.id}`} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer" title={t('billing.tip.viewInvoice')}>
                          <FileText size={15} />
                        </Link>
                        <Link href={`/admin/finance/water_supply?action=generate_bill&bill=${bill.id}&consumer=${bill.consumer_id}`} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer" title={t('billing.tip.editBill')}>
                          <Pencil size={15} />
                        </Link>
                        <button onClick={() => setConfirmDeleteBill(bill.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title={t('billing.tip.deleteBill')}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    {/* Inline payment form */}
                    {isPaymentOpen && paymentForm && (
                      <div className="bg-dp-surface-container-low border-t border-dp-outline-variant px-4 py-3 space-y-3">
                        <div className="flex items-center gap-2 mb-1">
                          <CreditCard size={15} className="text-dp-secondary" />
                          <span className="font-sans text-[13px] font-semibold text-dp-on-surface">{t('billing.recordPayment')}</span>
                          <span className="font-sans text-[12px] text-dp-on-surface-variant ml-auto">Outstanding: Rs. {rem.toLocaleString()}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('billing.amountPkr')}</label>
                            <input
                              type="number"
                              min={1}
                              value={paymentForm.amount || ''}
                              onChange={(e) => setPaymentForm({ ...paymentForm, amount: +e.target.value })}
                              className="w-full px-3 py-2 bg-white border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans focus:border-dp-secondary focus:ring-0"
                            />
                          </div>
                          <div>
                            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('billing.method')}</label>
                            <select
                              value={paymentForm.method}
                              onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}
                              className="w-full px-3 py-2 bg-white border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans focus:border-dp-secondary focus:ring-0"
                            >
                              <option value="cash">{t('billing.methodCash')}</option>
                              <option value="jazzcash">{t('billing.methodJazzcash')}</option>
                              <option value="easypaisa">{t('billing.methodEasypaisa')}</option>
                              <option value="bank">{t('billing.methodBank')}</option>
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('billing.noteOptional')}</label>
                          <input
                            type="text"
                            value={paymentForm.description}
                            onChange={(e) => setPaymentForm({ ...paymentForm, description: e.target.value })}
                            placeholder="e.g. receipt no, bank ref..."
                            className="w-full px-3 py-2 bg-white border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans focus:border-dp-secondary focus:ring-0"
                          />
                        </div>
                        {paymentForm.amount < rem && paymentForm.amount > 0 && (
                          <div className="flex items-center gap-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                            <Clock size={14} className="shrink-0" />
                            <span className="font-sans text-[12px]">Partial payment — Rs. {(rem - paymentForm.amount).toLocaleString()} will remain outstanding.</span>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button onClick={recordPayment} className="flex-1 bg-dp-secondary text-white py-2 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">{t('billing.recordPayment')}</button>
                          <button onClick={() => setPaymentForm(null)} className="px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[14px] text-dp-on-surface-variant hover:bg-dp-surface-container cursor-pointer">
                            {t('action.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
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
        title="Delete Bill"
        message="Are you sure you want to delete this bill? This cannot be undone."
        onConfirm={deleteBill}
        onCancel={() => setConfirmDeleteBill(null)}
      />

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
        <Modal title="Permanent Disconnection" onClose={() => { setDisconnectTarget(null); setDisconnectPreview(null) }}>
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
                  <span>{disconnectPreview.refund > 0 ? 'Refund due to consumer' : 'Still owed by consumer'}</span>
                  <span className={disconnectPreview.refund > 0 ? 'text-emerald-700' : 'text-dp-error'}>
                    Rs. {(disconnectPreview.refund > 0 ? disconnectPreview.refund : Math.max(disconnectPreview.pending_balance - disconnectPreview.applied, 0)).toLocaleString()}
                  </span>
                </div>
              </div>
            )}
            <p className="font-sans text-[12px] text-dp-on-surface-variant bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              This cannot be undone. Any recurring bill for this consumer will stop, and their status becomes Disconnected.
            </p>
            <button disabled={disconnecting || !disconnectPreview} onClick={confirmDisconnect} className="w-full bg-dp-error text-white py-3 rounded-lg font-sans font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-50">
              {disconnecting ? 'Processing...' : 'Confirm Permanent Disconnection'}
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
