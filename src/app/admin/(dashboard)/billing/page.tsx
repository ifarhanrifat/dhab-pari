'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Search, PlusCircle, X, ChevronRight, Phone,
  Home, MapPin, MessageCircle, AlertCircle, CheckCircle2,
  Clock, CreditCard, Banknote,
} from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

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
}

interface Bill {
  id: string
  consumer_id: string
  month: number
  year: number
  amount_pkr: number
  paid_amount: number
  description: string | null
  status: string
  paid_date: string | null
  payment_method: string | null
}

interface PaymentForm {
  billId: string
  amount: number
  method: string
  description: string
}

const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fullMonths = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function outstanding(bill: Bill) {
  return bill.amount_pkr - (bill.paid_amount ?? 0)
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    paid: 'bg-emerald-100 text-emerald-700',
    partial: 'bg-amber-100 text-amber-800',
    unpaid: 'bg-red-100 text-red-700',
    pending: 'bg-blue-100 text-blue-700',
    late: 'bg-red-700 text-white',
  }
  return (
    <span className={`text-[10px] uppercase font-black px-2 py-0.5 rounded-full font-sans ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status === 'partial' ? 'Partial' : status}
    </span>
  )
}

export default function BillingPage() {
  const [consumers, setConsumers] = useState<Consumer[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sectorFilter, setSectorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedConsumer, setSelectedConsumer] = useState<Consumer | null>(null)
  const [paymentForm, setPaymentForm] = useState<PaymentForm | null>(null)
  const [showAddBill, setShowAddBill] = useState(false)
  const [showAddConsumer, setShowAddConsumer] = useState(false)
  const [confirmDeleteBill, setConfirmDeleteBill] = useState<string | null>(null)
  const [newBill, setNewBill] = useState({
    consumer_id: '',
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    amount_pkr: 200,
    description: '',
  })
  const [newConsumer, setNewConsumer] = useState({
    consumer_id: '', name: '', mobile: '', house_no: '', sector: '', area: '', address: '', monthly_rate: 200,
  })
  const supabase = createClient()

  const loadData = async () => {
    setLoading(true)
    const [cRes, bRes] = await Promise.all([
      supabase.from('consumers').select('*').order('consumer_id'),
      supabase.from('bills').select('*').order('year', { ascending: false }).order('month', { ascending: false }),
    ])
    setConsumers(cRes.data ?? [])
    setBills(bRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const sectors = useMemo(() => {
    const s = new Set(consumers.map((c) => c.sector).filter(Boolean))
    return Array.from(s).sort() as string[]
  }, [consumers])

  const billsByConsumer = useMemo(() => {
    const map: Record<string, Bill[]> = {}
    bills.forEach((b) => {
      if (!map[b.consumer_id]) map[b.consumer_id] = []
      map[b.consumer_id].push(b)
    })
    return map
  }, [bills])

  const consumerStats = useMemo(() => {
    const stats: Record<string, { outstanding: number; pendingCount: number }> = {}
    consumers.forEach((c) => {
      const cb = billsByConsumer[c.consumer_id] ?? []
      const pending = cb.filter((b) => b.status !== 'paid')
      stats[c.consumer_id] = {
        outstanding: pending.reduce((s, b) => s + outstanding(b), 0),
        pendingCount: pending.length,
      }
    })
    return stats
  }, [consumers, billsByConsumer])

  const filteredConsumers = useMemo(() => {
    return consumers.filter((c) => {
      if (search) {
        const q = search.toLowerCase()
        if (!c.consumer_id.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q) && !c.mobile.includes(q)) return false
      }
      if (sectorFilter && c.sector !== sectorFilter) return false
      if (statusFilter === 'pending' && (consumerStats[c.consumer_id]?.pendingCount ?? 0) === 0) return false
      if (statusFilter === 'clear' && (consumerStats[c.consumer_id]?.pendingCount ?? 0) > 0) return false
      return true
    })
  }, [consumers, search, sectorFilter, statusFilter, consumerStats])

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

    const remaining = outstanding(bill)
    const entered = Math.min(paymentForm.amount, remaining)

    if (entered <= 0) { toast.error('Invalid amount'); return }

    const newPaid = (bill.paid_amount ?? 0) + entered
    const isFull = newPaid >= bill.amount_pkr

    const { error } = await supabase.from('bills').update({
      paid_amount: newPaid,
      status: isFull ? 'paid' : 'partial',
      paid_date: isFull ? new Date().toISOString().split('T')[0] : bill.paid_date,
      payment_method: paymentForm.method,
      description: paymentForm.description || bill.description,
    }).eq('id', paymentForm.billId)

    if (error) { toast.error(error.message); return }
    toast.success(isFull ? 'Payment recorded — bill marked as paid' : `Partial payment of Rs. ${entered.toLocaleString()} recorded`)
    setPaymentForm(null)
    loadData()
  }

  const addBill = async () => {
    if (!newBill.consumer_id) { toast.error('Select a consumer'); return }
    const { error } = await supabase.from('bills').insert({
      ...newBill,
      description: newBill.description || null,
      paid_amount: 0,
    })
    if (error) { toast.error(error.message); return }
    toast.success('Bill added')
    setShowAddBill(false)
    setNewBill({ consumer_id: '', month: new Date().getMonth() + 1, year: new Date().getFullYear(), amount_pkr: 200, description: '' })
    loadData()
  }

  const addConsumer = async () => {
    if (!newConsumer.consumer_id.trim() || !newConsumer.name.trim()) { toast.error('Consumer ID and name required'); return }
    const { error } = await supabase.from('consumers').insert({ ...newConsumer, status: 'active' })
    if (error) { toast.error(error.message); return }
    toast.success('Consumer added')
    setShowAddConsumer(false)
    setNewConsumer({ consumer_id: '', name: '', mobile: '', house_no: '', sector: '', area: '', address: '', monthly_rate: 200 })
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
          <button onClick={() => setShowAddBill(true)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <PlusCircle size={16} /> Add Bill
          </button>
        </div>
      </div>

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
                        </div>
                        <p className="font-sans text-[15px] font-semibold text-dp-on-surface truncate">{c.name}</p>
                        {c.mobile && <p className="font-sans text-[12px] text-dp-on-surface-variant">{c.mobile}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {stats.pendingCount > 0 ? (
                          <div className="text-right">
                            <p className="font-sans text-[13px] font-bold text-dp-error">Rs. {stats.outstanding.toLocaleString()}</p>
                            <p className="font-sans text-[10px] text-dp-error/70">{stats.pendingCount} pending</p>
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
                <button
                  onClick={() => { setNewBill((prev) => ({ ...prev, consumer_id: selectedConsumer.consumer_id })); setShowAddBill(true) }}
                  className="flex items-center gap-1 text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer"
                >
                  <PlusCircle size={14} /> Add Bill
                </button>
              </div>

              {selectedBills.length === 0 && (
                <div className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">No bills yet for this consumer.</div>
              )}

              {selectedBills.map((bill) => {
                const rem = outstanding(bill)
                const isPaymentOpen = paymentForm?.billId === bill.id
                return (
                  <div key={bill.id} className={`border rounded-lg overflow-hidden ${bill.status === 'paid' ? 'border-dp-outline-variant' : 'border-dp-error/30'}`}>
                    <div className="px-4 py-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-sans text-[15px] font-semibold text-dp-on-surface">{fullMonths[bill.month]} {bill.year}</span>
                          <StatusBadge status={bill.status} />
                        </div>
                        <div className="font-sans text-[13px] text-dp-on-surface-variant">
                          Total: Rs. {bill.amount_pkr.toLocaleString()}
                          {(bill.paid_amount ?? 0) > 0 && <span className="ml-2 text-emerald-600">Paid: Rs. {(bill.paid_amount ?? 0).toLocaleString()}</span>}
                          {rem > 0 && rem < bill.amount_pkr && <span className="ml-2 text-dp-error">Due: Rs. {rem.toLocaleString()}</span>}
                        </div>
                        {bill.description && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 italic">{bill.description}</p>}
                        {bill.paid_date && <p className="font-sans text-[11px] text-dp-secondary mt-0.5">Paid on {new Date(bill.paid_date).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}{bill.payment_method ? ` via ${bill.payment_method}` : ''}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {bill.status !== 'paid' && (
                          <button
                            onClick={() => isPaymentOpen ? setPaymentForm(null) : startPayment(bill)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer"
                          >
                            <Banknote size={15} />
                            {bill.status === 'partial' ? 'Pay Remaining' : 'Receive Payment'}
                          </button>
                        )}
                        <button onClick={() => setConfirmDeleteBill(bill.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title="Delete bill">
                          <X size={16} />
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
                              max={rem}
                              min={1}
                              value={paymentForm.amount}
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

      {/* Add Bill Modal */}
      {showAddBill && (
        <Modal title="Add New Bill" onClose={() => setShowAddBill(false)}>
          <div className="space-y-4">
            <Field label="Consumer">
              <select value={newBill.consumer_id} onChange={(e) => setNewBill({ ...newBill, consumer_id: e.target.value })} className="input-field">
                <option value="">Select Consumer</option>
                {consumers.map((c) => <option key={c.consumer_id} value={c.consumer_id}>{c.consumer_id} — {c.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Month">
                <select value={newBill.month} onChange={(e) => setNewBill({ ...newBill, month: +e.target.value })} className="input-field">
                  {months.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
                </select>
              </Field>
              <Field label="Year">
                <input type="number" value={newBill.year} onChange={(e) => setNewBill({ ...newBill, year: +e.target.value })} className="input-field" />
              </Field>
            </div>
            <Field label="Amount (PKR)">
              <input type="number" value={newBill.amount_pkr} onChange={(e) => setNewBill({ ...newBill, amount_pkr: +e.target.value })} className="input-field" />
            </Field>
            <Field label="Description (optional)">
              <input type="text" value={newBill.description} onChange={(e) => setNewBill({ ...newBill, description: e.target.value })} placeholder="e.g. Monthly water bill" className="input-field" />
            </Field>
            <button onClick={addBill} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">Add Bill</button>
          </div>
        </Modal>
      )}

      {/* Add Consumer Modal */}
      {showAddConsumer && (
        <Modal title="Add New Consumer" onClose={() => setShowAddConsumer(false)}>
          <div className="space-y-4">
            <Field label="Consumer No. (e.g. DP-1011)">
              <input type="text" value={newConsumer.consumer_id} onChange={(e) => setNewConsumer({ ...newConsumer, consumer_id: e.target.value.toUpperCase() })} placeholder="DP-1011" className="input-field" />
            </Field>
            <Field label="Full Name">
              <input type="text" value={newConsumer.name} onChange={(e) => setNewConsumer({ ...newConsumer, name: e.target.value })} className="input-field" />
            </Field>
            <Field label="Mobile">
              <input type="text" value={newConsumer.mobile} onChange={(e) => setNewConsumer({ ...newConsumer, mobile: e.target.value })} placeholder="0300-1234567" className="input-field" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="House No.">
                <input type="text" value={newConsumer.house_no} onChange={(e) => setNewConsumer({ ...newConsumer, house_no: e.target.value })} className="input-field" />
              </Field>
              <Field label="Sector">
                <input type="text" value={newConsumer.sector} onChange={(e) => setNewConsumer({ ...newConsumer, sector: e.target.value })} placeholder="Sector A" className="input-field" />
              </Field>
            </div>
            <Field label="Area / Mohalla">
              <input type="text" value={newConsumer.area} onChange={(e) => setNewConsumer({ ...newConsumer, area: e.target.value })} className="input-field" />
            </Field>
            <Field label="Full Address">
              <textarea value={newConsumer.address} onChange={(e) => setNewConsumer({ ...newConsumer, address: e.target.value })} rows={2} className="input-field resize-none" />
            </Field>
            <Field label="Monthly Rate (PKR)">
              <input type="number" value={newConsumer.monthly_rate} onChange={(e) => setNewConsumer({ ...newConsumer, monthly_rate: +e.target.value })} className="input-field" />
            </Field>
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
