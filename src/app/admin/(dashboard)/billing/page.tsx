'use client'

import { useEffect, useState, useMemo, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Search, PlusCircle, X, ChevronRight, Phone,
  Home, MapPin, MessageCircle, AlertCircle, CheckCircle2,
  Clock, CreditCard, Banknote, Pencil, Receipt, Users, UserCheck, UserX, Tag, UserPlus, Repeat, Trash2, FileText,
} from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { billBadge, billBadgeClass } from '@/lib/billStatus'

interface Consumer {
  consumer_id: string
  name: string
  mobile: string
  house_no: string | null
  sector: string | null
  area: string | null
  address: string | null
  monthly_rate: number
  status: string
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
}

interface PaymentForm {
  billId: string
  amount: number
  method: string
  description: string
}

const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fullMonths = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

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
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>}>
      <BillingPageInner />
    </Suspense>
  )
}

function BillingPageInner() {
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
  const [recurringConsumerIds, setRecurringConsumerIds] = useState<Set<string>>(new Set())
  const [paymentForm, setPaymentForm] = useState<PaymentForm | null>(null)
  const [showAddConsumer, setShowAddConsumer] = useState(false)
  const [confirmDeleteBill, setConfirmDeleteBill] = useState<string | null>(null)
  const [newConsumer, setNewConsumer] = useState({
    name: '', father_husband_name: '', mobile: '', whatsapp_number: '', whatsapp_same_as_mobile: true,
    house_no: '', sector: '', area: '', address: '', connections: 1, monthly_rate: 200,
  })
  const supabase = createClient()

  const [sectorOptions, setSectorOptions] = useState<{ id: string; name: string }[]>([])

  const loadData = async () => {
    setLoading(true)
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const [cRes, bRes, secRes, auditRes, recurRes] = await Promise.all([
      supabase.from('consumers').select('*').order('consumer_id'),
      supabase.from('bills').select('*').order('year', { ascending: false }).order('month', { ascending: false }),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
      supabase.from('audit_log').select('old_data, record_data').eq('table_name', 'consumers').eq('action', 'update').gte('performed_at', monthStart),
      supabase.from('recurring_schedules').select('consumer_id').eq('schedule_type', 'bill').eq('is_active', true),
    ])
    setConsumers(cRes.data ?? [])
    setBills(bRes.data ?? [])
    setSectorOptions(secRes.data ?? [])
    setRecurringConsumerIds(new Set((recurRes.data ?? []).map((r) => r.consumer_id).filter(Boolean) as string[]))
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

  const filteredConsumers = useMemo(() => {
    return consumers.filter((c) => {
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
  }, [consumers, search, sectorFilter, statusFilter, consumerStats, quickFilter, monthlyStats])

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
    if (entered <= 0) { toast.error('Invalid amount'); return }

    const { error } = await supabase.from('payments').insert({
      bill_id: paymentForm.billId,
      consumer_id: bill.consumer_id,
      amount_pkr: entered,
      method: paymentForm.method,
      note: paymentForm.description || null,
    })

    if (error) { toast.error(error.message); return }
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
    if (!newConsumer.name.trim()) { toast.error('Name is required'); return }
    if (!newConsumer.sector) { toast.error('Select a sector'); return }

    const { data, error: consumerError } = await supabase.from('consumers').insert({
      name: newConsumer.name, father_husband_name: newConsumer.father_husband_name || null,
      mobile: newConsumer.mobile, whatsapp_number: newConsumer.whatsapp_same_as_mobile ? newConsumer.mobile : newConsumer.whatsapp_number,
      whatsapp_same_as_mobile: newConsumer.whatsapp_same_as_mobile,
      house_no: newConsumer.house_no, sector: newConsumer.sector, area: newConsumer.area, address: newConsumer.address,
      connections: newConsumer.connections || 1, monthly_rate: newConsumer.monthly_rate, status: 'active',
    }).select('consumer_id').single()
    if (consumerError) { toast.error(consumerError.message); return }

    toast.success(`Consumer ${data.consumer_id} added — generate their first bill from Transactions → Generate Bill`)
    setShowAddConsumer(false)
    setNewConsumer({
      name: '', father_husband_name: '', mobile: '', whatsapp_number: '', whatsapp_same_as_mobile: true,
      house_no: '', sector: '', area: '', address: '', connections: 1, monthly_rate: 200,
    })
    loadData()
  }

  const deleteBill = async () => {
    if (!confirmDeleteBill) return
    const { error } = await supabase.from('bills').delete().eq('id', confirmDeleteBill)
    if (error) { toast.error(error.message); return }
    toast.success('Bill deleted')
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
    if (!consumer.mobile) { toast.error('No mobile number for this consumer'); return }
    const msg = encodeURIComponent(
      `*Dhab Pari Water Committee*\n\nDear ${consumer.name},\n\nYour outstanding water bill is *Rs. ${stats.outstanding.toLocaleString()}* (${stats.pendingCount} bill${stats.pendingCount > 1 ? 's' : ''} pending).\n\nConsumer No: ${consumer.consumer_id}\n\nPlease pay at your earliest convenience. Thank you.`
    )
    const phone = consumer.mobile.replace(/\D/g, '')
    const intlPhone = phone.startsWith('0') ? '92' + phone.slice(1) : phone
    window.open(`https://wa.me/${intlPhone}?text=${msg}`, '_blank')
  }

  const startPayment = (bill: Bill) => {
    const rem = outstanding(bill)
    setPaymentForm({ billId: bill.id, amount: rem, method: 'cash', description: '' })
  }

  return (
    <>
      <Toaster position="top-right" />

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Billing Management</h1>
        <div className="flex gap-3">
          <button onClick={() => setShowAddConsumer(true)} className="flex items-center gap-2 px-4 py-2 border-2 border-dp-secondary text-dp-secondary rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
            <PlusCircle size={16} /> Add Consumer
          </button>
          <Link href="/admin/finance/water_supply?action=generate_bill" className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <PlusCircle size={16} /> Generate Bill
          </Link>
        </div>
      </div>

      {/* Analytics bar — this month's billing activity at a glance */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <button
          onClick={() => toggleQuickFilter('billed_this_month')}
          className={`text-left bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'billed_this_month' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view only consumers billed this month"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><Receipt size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">Billed This Month</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-primary">Rs. {monthlyStats.billTotal.toLocaleString()}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">{monthlyStats.billCount} bill{monthlyStats.billCount === 1 ? '' : 's'}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('active')}
          className={`text-left bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'active' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view only active connections"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><UserCheck size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">Active Connections</span></div>
          <p className="font-sans text-[18px] font-bold text-emerald-700">{monthlyStats.activeConnections}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('inactive')}
          className={`text-left bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'inactive' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view only deactivated connections"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><UserX size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">Deactivated</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-error">{monthlyStats.inactiveConnections}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">{deactivatedThisMonth} this month</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('with_discount')}
          className={`text-left bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'with_discount' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view only consumers with a discounted bill this month"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><Tag size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">With Discount</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-primary">{monthlyStats.withDiscountCount}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">Rs. {monthlyStats.withDiscountTotal.toLocaleString()}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('without_discount')}
          className={`text-left bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'without_discount' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view consumers who were not given a discount this month (includes those not yet billed)"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><Users size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">Without Discount</span></div>
          <p className="font-sans text-[18px] font-bold text-dp-primary">{monthlyStats.withoutDiscountCount}</p>
          <p className="font-sans text-[11px] text-dp-on-surface-variant">Rs. {monthlyStats.withoutDiscountTotal.toLocaleString()}</p>
        </button>
        <button
          onClick={() => toggleQuickFilter('new_this_month')}
          className={`text-left bg-white border rounded-lg px-4 py-3 cursor-pointer transition-all ${quickFilter === 'new_this_month' ? 'border-dp-secondary ring-2 ring-dp-secondary/30' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
          title="Click to view only consumers added this month"
        >
          <div className="flex items-center gap-1.5 text-dp-on-surface-variant mb-1"><UserPlus size={13} /><span className="font-sans text-[11px] font-bold uppercase tracking-[0.04em]">New This Month</span></div>
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
            Clear
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-outline" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, consumer no, mobile..." className="w-full pl-10 pr-4 py-2 border-2 border-dp-outline-variant rounded-lg focus:border-dp-primary focus:ring-0 text-[14px] font-sans bg-white" />
        </div>
        <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)} className="px-3 py-2 border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans bg-white focus:border-dp-primary focus:ring-0">
          <option value="">All Sectors</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans bg-white focus:border-dp-primary focus:ring-0">
          <option value="">All Status</option>
          <option value="pending">Has Outstanding Bills</option>
          <option value="clear">Fully Paid Up</option>
        </select>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-6 min-h-[600px]">

        {/* Consumer list */}
        <div className={`${selectedConsumer ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-[340px] md:flex-shrink-0`}>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden flex flex-col flex-1">
            {loading ? (
              <div className="p-8 text-center text-dp-on-surface-variant font-sans">Loading...</div>
            ) : filteredConsumers.length === 0 ? (
              <div className="p-8 text-center text-dp-on-surface-variant font-sans">No consumers found.</div>
            ) : (
              <div className="overflow-y-auto">
                {filteredConsumers.map((c, i) => {
                  const stats = consumerStats[c.consumer_id]
                  const isSelected = selectedConsumer?.consumer_id === c.consumer_id
                  return (
                    <button
                      key={c.consumer_id}
                      onClick={() => setSelectedConsumer(c)}
                      className={`w-full text-left px-4 py-3 flex items-center justify-between gap-3 transition-colors ${i > 0 ? 'border-t border-dp-outline-variant' : ''} ${isSelected ? 'bg-dp-primary-container/30 border-l-4 border-l-dp-secondary' : 'hover:bg-dp-surface-container-low'}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-sans text-[11px] font-bold text-dp-secondary">{c.consumer_id}</span>
                          {c.sector && <span className="text-[10px] text-dp-on-surface-variant font-sans">{c.sector}</span>}
                          {recurringConsumerIds.has(c.consumer_id) ? (
                            <span className="flex items-center gap-0.5 text-[9.5px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full" title="Has an active recurring bill">
                              <Repeat size={9} /> Recurring
                            </span>
                          ) : (
                            <span className="text-[9.5px] font-bold uppercase tracking-wide text-dp-on-surface-variant bg-dp-surface-container-low px-1.5 py-0.5 rounded-full" title="No recurring bill set up yet">
                              Not Recurring
                            </span>
                          )}
                        </div>
                        <p className="font-sans text-[15px] font-semibold text-dp-on-surface truncate">{c.name}</p>
                        {c.mobile && <p className="font-sans text-[12px] text-dp-on-surface-variant">{c.mobile}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {stats.pendingCount > 0 ? (
                          <div className="text-right">
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
          <div className="flex-1 bg-white rounded-lg border border-dp-outline-variant overflow-hidden flex flex-col">
            {/* Consumer header */}
            <div className="bg-dp-surface-container-low px-6 py-4 border-b border-dp-outline-variant">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-sans text-[12px] font-bold text-dp-secondary bg-dp-primary-container px-2 py-0.5 rounded">{selectedConsumer.consumer_id}</span>
                    {selectedConsumer.sector && (
                      <span className="font-sans text-[12px] text-dp-on-surface-variant flex items-center gap-1"><MapPin size={12} />{selectedConsumer.sector}</span>
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
                      title="Send WhatsApp notification"
                    >
                      <MessageCircle size={15} /> Notify
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
            </div>

            {/* Bills list */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-sans text-[14px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">Bills History</h3>
                <Link
                  href={`/admin/finance/water_supply?action=generate_bill&consumer=${selectedConsumer.consumer_id}`}
                  className="flex items-center gap-1 text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer"
                >
                  <PlusCircle size={14} /> Generate Bill
                </Link>
              </div>

              {selectedBills.length === 0 && (
                <div className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">No bills yet for this consumer.</div>
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
                          {(bill.discount_amount ?? 0) > 0 && <span className="ml-2 text-emerald-700">Discount: − Rs. {(bill.discount_amount ?? 0).toLocaleString()}</span>}
                          {(bill.paid_amount ?? 0) > 0 && <span className="ml-2 text-emerald-600">Paid: Rs. {(bill.paid_amount ?? 0).toLocaleString()}</span>}
                          {rem > 0 && <span className="ml-2 text-dp-error">Due: Rs. {rem.toLocaleString()}</span>}
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
                            Receive Now
                          </button>
                        )}
                        <Link href={`/admin/invoice/bill/${bill.id}`} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer" title="View invoice">
                          <FileText size={15} />
                        </Link>
                        <Link href={`/admin/finance/water_supply?action=generate_bill&bill=${bill.id}&consumer=${bill.consumer_id}`} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer" title="Edit bill">
                          <Pencil size={15} />
                        </Link>
                        <button onClick={() => setConfirmDeleteBill(bill.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title="Delete bill">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    {/* Inline payment form */}
                    {isPaymentOpen && paymentForm && (
                      <div className="bg-dp-surface-container-low border-t border-dp-outline-variant px-4 py-3 space-y-3">
                        <div className="flex items-center gap-2 mb-1">
                          <CreditCard size={15} className="text-dp-secondary" />
                          <span className="font-sans text-[13px] font-semibold text-dp-on-surface">Record Payment</span>
                          <span className="font-sans text-[12px] text-dp-on-surface-variant ml-auto">Outstanding: Rs. {rem.toLocaleString()}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Amount (PKR)</label>
                            <input
                              type="number"
                              min={1}
                              value={paymentForm.amount || ''}
                              onChange={(e) => setPaymentForm({ ...paymentForm, amount: +e.target.value })}
                              className="w-full px-3 py-2 bg-white border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans focus:border-dp-secondary focus:ring-0"
                            />
                          </div>
                          <div>
                            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Method</label>
                            <select
                              value={paymentForm.method}
                              onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}
                              className="w-full px-3 py-2 bg-white border-2 border-dp-outline-variant rounded-lg text-[14px] font-sans focus:border-dp-secondary focus:ring-0"
                            >
                              <option value="cash">Cash</option>
                              <option value="jazzcash">JazzCash</option>
                              <option value="easypaisa">Easypaisa</option>
                              <option value="bank">Bank Transfer</option>
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Note (optional)</label>
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
                          <button onClick={recordPayment} className="flex-1 bg-dp-secondary text-white py-2 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                            Record Payment
                          </button>
                          <button onClick={() => setPaymentForm(null)} className="px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[14px] text-dp-on-surface-variant hover:bg-dp-surface-container cursor-pointer">
                            Cancel
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
              <p className="font-sans text-[16px]">Select a consumer to view details</p>
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
                <span className="font-sans text-[13.5px] text-dp-on-surface-variant">WhatsApp number is the same as contact number</span>
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
                  <option value="">Select sector...</option>
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
            <button onClick={addConsumer} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">Add Consumer</button>
          </div>
        </Modal>
      )}
    </>
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
