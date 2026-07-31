'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Search, FileText } from 'lucide-react'
import { billBadge, billBadgeClass, type BillBadgeTone } from '@/lib/billStatus'
import { useSystemAccess } from '@/hooks/useSystemAccess'

type SystemTab = 'water_supply' | 'donors_projects'

interface TxnRow {
  id: string
  kind: 'bill' | 'payment' | 'voucher' | 'donation' | 'purchase'
  voucherType?: string
  borderColor: string
  typeLabel: string | null
  partyName: string
  docLabel: string
  date: string
  description: string
  amount: number
  badge: { text: string; tone: BillBadgeTone } | null
  note: string | null
  searchBlob: string
  billId?: string
  paymentId?: string
  voucherId?: string
  autoPosted?: boolean
  fullyApproved?: boolean
}

const voucherTypeLabels: Record<string, string> = {
  expense: 'Expense', income: 'Income', contra: 'Bank Transfer',
  withdrawal: 'Cash Withdrawal', deposit: 'Cash Deposit', security_deposit: 'Security Deposit',
}

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10) }
const yearStart = (y: number) => `${y}-01-01`
const yearEnd = (y: number) => `${y}-12-31`

export default function AllTransactionsPage() {
  const access = useSystemAccess()
  const [system, setSystem] = useState<SystemTab>('water_supply')
  const [systemOverride] = useState<SystemTab | null>(() => {
    if (typeof window === 'undefined') return null
    const p = new URLSearchParams(window.location.search).get('system')
    return p === 'water_supply' || p === 'donors_projects' ? p : null
  })
  useEffect(() => {
    if (access.loading) return
    if (systemOverride === 'water_supply' && access.canWaterSupply) { setSystem('water_supply'); return }
    if (systemOverride === 'donors_projects' && access.canDonorsProjects) { setSystem('donors_projects'); return }
    setSystem(access.defaultSystem)
  }, [access.loading, access.defaultSystem, access.canWaterSupply, access.canDonorsProjects, systemOverride])
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'partial' | 'pending' | 'overdue'>('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [autoPostedOnly, setAutoPostedOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<TxnRow[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const applyYear = (y: string) => {
    if (!y) return
    const yr = +y
    const isCurrent = yr === new Date().getFullYear()
    setFrom(yearStart(yr))
    setTo(isCurrent ? today() : yearEnd(yr))
  }

  const setCurrentMonth = () => { setFrom(monthStart()); setTo(today()) }

  const load = useCallback(async () => {
    setLoading(true)
    const [consumersRes, billsRes, paymentsRes, vouchersRes, donationsRes, purchasesRes, autoPostedRes] = await Promise.all([
      system === 'water_supply'
        ? supabase.from('consumers').select('consumer_id, name, mobile')
        : Promise.resolve({ data: [] as { consumer_id: string; name: string; mobile: string }[] }),
      system === 'water_supply'
        ? supabase.from('bills').select('id, bill_number, consumer_id, month, year, amount_pkr, discount_amount, paid_amount, due_date, description, created_at')
            .gte('created_at', from).lte('created_at', `${to}T23:59:59`)
        : Promise.resolve({ data: [] as { id: string; bill_number: string | null; consumer_id: string; month: number; year: number; amount_pkr: number; discount_amount: number | null; paid_amount: number | null; due_date: string | null; description: string | null; created_at: string }[] }),
      system === 'water_supply'
        ? supabase.from('payments').select('id, bill_id, consumer_id, amount_pkr, method, paid_date, receipt_no, note').gte('paid_date', from).lte('paid_date', to)
        : Promise.resolve({ data: [] as { id: string; bill_id: string; consumer_id: string; amount_pkr: number; method: string | null; paid_date: string; receipt_no: string | null; note: string | null }[] }),
      supabase.from('vouchers').select('id, voucher_type, voucher_no, receipt_no, voucher_date, particular, amount_pkr, party_name')
        .eq('system', system).in('status', ['posted', 'approved']).gte('voucher_date', from).lte('voucher_date', to),
      system === 'donors_projects'
        ? supabase.from('donors').select('id, name, amount_pkr, date, payment_method, notes, is_anonymous').gte('date', from).lte('date', to)
        : Promise.resolve({ data: [] as { id: string; name: string; amount_pkr: number; date: string; payment_method: string | null; notes: string | null; is_anonymous: boolean }[] }),
      system === 'water_supply'
        ? supabase.from('purchases').select('id, vendor, purchase_date, method, note').eq('system', system).eq('status', 'posted').gte('purchase_date', from).lte('purchase_date', to)
        : Promise.resolve({ data: [] as { id: string; vendor: string | null; purchase_date: string; method: string; note: string | null }[] }),
      // Auto-posted = the transaction went live after the 24-hour deadline
      // without every configured approver confirming (migration 060) — flagged
      // here so it can be surfaced/filtered separately from a normally-approved one.
      supabase.from('approval_requests').select('reference_id, auto_posted').eq('system', system).eq('status', 'posted'),
    ])
    const autoPostedIds = new Set((autoPostedRes.data ?? []).filter((r) => r.auto_posted).map((r) => r.reference_id))
    const fullyApprovedIds = new Set((autoPostedRes.data ?? []).filter((r) => !r.auto_posted).map((r) => r.reference_id))

    const consumersById = Object.fromEntries((consumersRes.data ?? []).map((c) => [c.consumer_id, c]))
    const billNumberById = Object.fromEntries((billsRes.data ?? []).map((b) => [b.id, b.bill_number]))
    const result: TxnRow[] = []

    for (const b of billsRes.data ?? []) {
      const net = Math.max(b.amount_pkr - (b.discount_amount ?? 0), 0)
      const consumer = consumersById[b.consumer_id]
      result.push({
        id: `bill-${b.id}`, kind: 'bill', borderColor: 'border-emerald-500',
        typeLabel: null, partyName: consumer?.name ?? b.consumer_id,
        docLabel: b.bill_number ? `Bill # ${b.bill_number}` : 'Bill',
        date: b.due_date ?? new Date(b.year, b.month - 1, 1).toISOString().slice(0, 10),
        description: b.description || `Water Bill — ${new Date(b.year, b.month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
        amount: net, badge: billBadge(b), note: null, billId: b.id,
        searchBlob: `${consumer?.name ?? ''} ${b.consumer_id} ${consumer?.mobile ?? ''} ${b.bill_number ?? ''} ${b.description ?? ''}`.toLowerCase(),
      })
    }

    for (const p of paymentsRes.data ?? []) {
      const billNo = billNumberById[p.bill_id]
      const consumer = consumersById[p.consumer_id]
      result.push({
        id: `payment-${p.id}`, kind: 'payment', borderColor: 'border-cyan-500',
        typeLabel: p.method ? p.method.charAt(0).toUpperCase() + p.method.slice(1) : 'Cash',
        partyName: consumer?.name ?? p.consumer_id,
        docLabel: p.receipt_no ? `Receipt # ${p.receipt_no}` : 'Receipt',
        date: p.paid_date, description: billNo ? `Against Bill ${billNo}` : 'Payment received',
        amount: p.amount_pkr, badge: null, note: p.note, billId: p.bill_id, paymentId: p.id,
        searchBlob: `${consumer?.name ?? ''} ${p.consumer_id} ${consumer?.mobile ?? ''} ${p.receipt_no ?? ''} ${p.method ?? ''} ${p.note ?? ''}`.toLowerCase(),
      })
    }

    for (const v of vouchersRes.data ?? []) {
      const isSecurityDeposit = v.voucher_type === 'security_deposit'
      const docLabel = isSecurityDeposit
        ? (v.receipt_no ? `Receipt # ${v.receipt_no}` : 'Receipt')
        : (v.voucher_no ? `Voucher # ${v.voucher_no}` : 'Voucher')
      const label = voucherTypeLabels[v.voucher_type] ?? v.voucher_type.replace(/_/g, ' ')
      result.push({
        id: `voucher-${v.id}`, kind: 'voucher', voucherType: v.voucher_type,
        borderColor: isSecurityDeposit ? 'border-cyan-500' : 'border-slate-400',
        typeLabel: label, partyName: v.party_name || label, docLabel,
        date: v.voucher_date, description: v.particular, amount: v.amount_pkr,
        badge: null, note: null, voucherId: v.id, autoPosted: autoPostedIds.has(v.id), fullyApproved: fullyApprovedIds.has(v.id),
        searchBlob: `${v.party_name ?? ''} ${label} ${v.voucher_no ?? ''} ${v.receipt_no ?? ''} ${v.particular ?? ''}`.toLowerCase(),
      })
    }

    for (const d of donationsRes.data ?? []) {
      result.push({
        id: `donation-${d.id}`, kind: 'donation', borderColor: 'border-violet-500',
        typeLabel: d.payment_method ? d.payment_method.charAt(0).toUpperCase() + d.payment_method.slice(1) : null,
        partyName: d.is_anonymous ? 'Anonymous Donor' : d.name,
        docLabel: 'Donation', date: d.date, description: d.notes || 'Donation received',
        amount: d.amount_pkr, badge: null, note: null,
        searchBlob: `${d.name} ${d.payment_method ?? ''} ${d.notes ?? ''}`.toLowerCase(),
      })
    }

    for (const p of purchasesRes.data ?? []) {
      result.push({
        id: `purchase-${p.id}`, kind: 'purchase', borderColor: 'border-amber-500',
        typeLabel: p.method.charAt(0).toUpperCase() + p.method.slice(1),
        partyName: p.vendor || 'Purchase', docLabel: 'Purchase Bill',
        date: p.purchase_date, description: p.note || 'Inventory purchase',
        amount: 0, badge: null, note: p.note, autoPosted: autoPostedIds.has(p.id), fullyApproved: fullyApprovedIds.has(p.id),
        searchBlob: `${p.vendor ?? ''} ${p.method} ${p.note ?? ''}`.toLowerCase(),
      })
    }

    result.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    setRows(result)
    setLoading(false)
  }, [system, from, to, supabase])

  useEffect(() => { load() }, [load])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== 'all') {
        if (r.kind !== 'bill' || !r.badge) return false
        const tone = r.badge.tone
        if (statusFilter === 'paid' && tone !== 'green') return false
        if (statusFilter === 'partial' && tone !== 'amber') return false
        if (statusFilter === 'pending' && tone !== 'gray') return false
        if (statusFilter === 'overdue' && tone !== 'red') return false
      }
      if (kindFilter !== 'all') {
        if (kindFilter.startsWith('voucher:')) {
          const vt = kindFilter.slice('voucher:'.length)
          if (r.kind !== 'voucher' || r.voucherType !== vt) return false
        } else if (r.kind !== kindFilter) {
          return false
        }
      }
      if (autoPostedOnly && !r.autoPosted) return false
      if (q && !r.searchBlob.includes(q)) return false
      return true
    })
    // Auto-posted (no full confirmation before the 24h deadline) sorts to the
    // top within the existing date-descending order, so they're easy to spot
    // and audit even without turning on the dedicated filter above.
    .sort((a, b) => (a.autoPosted === b.autoPosted ? 0 : a.autoPosted ? -1 : 1))
  }, [rows, statusFilter, kindFilter, autoPostedOnly, search])

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear()
    return Array.from({ length: 6 }, (_, i) => currentYear - i)
  }, [])

  return (
    <>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary">All Transactions</h1>
        {!access.loading && (access.canWaterSupply || access.canDonorsProjects) && (
          <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
            {access.canWaterSupply && (
              <button onClick={() => setSystem('water_supply')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'water_supply' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>Water Supply</button>
            )}
            {access.canDonorsProjects && (
              <button onClick={() => setSystem('donors_projects')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'donors_projects' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>Donors &amp; Projects</button>
            )}
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mb-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field !py-2 text-[14px]" />
          </div>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field !py-2 text-[14px]" />
          </div>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Year</label>
            <select onChange={(e) => applyYear(e.target.value)} defaultValue="" className="input-field !py-2 text-[14px]">
              <option value="">Jump to year...</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button onClick={setCurrentMonth} className="px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
            This Month
          </button>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="input-field !py-2 text-[14px]">
              <option value="all">All statuses</option>
              <option value="paid">Paid</option>
              <option value="partial">Partial</option>
              <option value="pending">Pending</option>
              <option value="overdue">Overdue</option>
            </select>
          </div>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Type</label>
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="input-field !py-2 text-[14px]">
              <option value="all">All types</option>
              <option value="bill">Bills</option>
              <option value="payment">Payments / Receipts</option>
              {system === 'donors_projects' && <option value="donation">Donations</option>}
              {system === 'water_supply' && <option value="purchase">Purchases</option>}
              <option value="voucher:expense">Expense Vouchers</option>
              <option value="voucher:income">Income Vouchers</option>
              <option value="voucher:contra">Bank Transfers</option>
              <option value="voucher:withdrawal">Cash Withdrawals</option>
              <option value="voucher:deposit">Cash Deposits</option>
              <option value="voucher:security_deposit">Security Deposits</option>
            </select>
          </div>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">&nbsp;</label>
            <button
              onClick={() => setAutoPostedOnly(!autoPostedOnly)}
              title="Vouchers/purchases that posted after 24 hours without every approver confirming"
              className={`px-3 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all cursor-pointer border ${autoPostedOnly ? 'bg-amber-100 border-amber-400 text-amber-900' : 'border-dp-outline-variant text-dp-on-surface hover:bg-dp-surface-container-low'}`}
            >
              Auto-posted only
            </button>
          </div>
          <div className="flex-1 min-w-[220px]">
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Search</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, account ID, phone, receipt/voucher #, method..."
                className="input-field !py-2 !pl-9 text-[14px]"
              />
            </div>
          </div>
        </div>
        <p className="font-sans text-[12px] text-dp-on-surface-variant">Showing {filteredRows.length} of {rows.length} transactions in this date range. Widen the date range or jump to a year for older activity — only the current month loads by default.</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        {loading && <p className="px-4 py-8 text-center text-dp-on-surface-variant font-sans text-[13.5px]">Loading...</p>}
        {!loading && filteredRows.length === 0 && <p className="px-4 py-8 text-center text-dp-on-surface-variant font-sans text-[13.5px]">No transactions match these filters.</p>}
        <div className="divide-y divide-dp-outline-variant">
          {!loading && filteredRows.map((r) => (
            <div key={r.id} className={`flex border-l-[3px] ${r.borderColor}`}>
              <div className="flex-1 min-w-0 p-3.5">
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0">
                    {r.typeLabel && <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-tight">{r.typeLabel}</p>}
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface truncate">{r.partyName}</p>
                    {r.autoPosted && (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded font-sans text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800" title="Posted after 24 hours without every approver confirming">
                        Auto-posted
                      </span>
                    )}
                    {r.fullyApproved && (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded font-sans text-[10px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800" title="Confirmed by every configured approver">
                        Approved
                      </span>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-sans text-[13px] font-bold text-dp-on-surface whitespace-nowrap">{r.docLabel}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant whitespace-nowrap">{new Date(r.date).toLocaleDateString('en-GB')}</p>
                  </div>
                </div>
                <div className="flex justify-between items-end gap-3 mt-1.5">
                  <p className="font-sans text-[13px] text-dp-on-surface-variant truncate">{r.description}</p>
                  <div className="text-right shrink-0">
                    {r.amount > 0 && <p className="font-sans text-[15px] font-bold text-dp-on-surface whitespace-nowrap">Rs {fmtAmount(r.amount)}</p>}
                    {r.badge && (
                      <span className={`inline-block mt-1 px-2 py-0.5 rounded font-sans text-[10.5px] font-bold tracking-wide ${billBadgeClass[r.badge.tone]}`}>{r.badge.text}</span>
                    )}
                  </div>
                </div>
                {r.billId && (
                  <div className="flex justify-end mt-2 pt-2 border-t border-dp-outline-variant/60">
                    <Link href={`/admin/invoice/bill/${r.billId}`} title="View invoice" className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[12px] font-semibold hover:underline cursor-pointer"><FileText size={13} /> View</Link>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
