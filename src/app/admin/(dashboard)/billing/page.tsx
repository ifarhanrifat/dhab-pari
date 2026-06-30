'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Filter, PlusCircle, CheckCheck, X, Pencil } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { BulkActionsBar } from '@/components/admin/BulkActionsBar'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface Bill {
  id: string
  consumer_id: string
  month: number
  year: number
  amount_pkr: number
  status: string
  paid_date: string | null
  payment_method: string | null
}

interface Consumer {
  consumer_id: string
  name: string
  house_no: string | null
  sector: string | null
  mobile: string
  lookup_token: string | null
  monthly_rate: number
}

const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function BillingPage() {
  const [bills, setBills] = useState<Bill[]>([])
  const [consumers, setConsumers] = useState<Consumer[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showAddBill, setShowAddBill] = useState(false)
  const [showAddConsumer, setShowAddConsumer] = useState(false)
  const [newBill, setNewBill] = useState({ consumer_id: '', month: new Date().getMonth() + 1, year: new Date().getFullYear(), amount_pkr: 200 })
  const [newConsumer, setNewConsumer] = useState({ consumer_id: '', name: '', mobile: '', house_no: '', sector: '', monthly_rate: 200 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)

  const supabase = createClient()

  const loadData = async () => {
    const [billsRes, consumersRes] = await Promise.all([
      supabase.from('bills').select('*').order('year', { ascending: false }).order('month', { ascending: false }).limit(50),
      supabase.from('consumers').select('consumer_id, name, house_no, sector, mobile, monthly_rate, lookup_token').order('consumer_id'),
    ])
    setBills(billsRes.data ?? [])
    setConsumers(consumersRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const consumerMap: Record<string, Consumer> = {}
  consumers.forEach((c) => { consumerMap[c.consumer_id] = c })

  const filtered = bills.filter((b) => {
    if (!search) return true
    const q = search.toLowerCase()
    const c = consumerMap[b.consumer_id]
    return b.consumer_id.toLowerCase().includes(q) || c?.name.toLowerCase().includes(q)
  })

  const markPaid = async (billId: string) => {
    const { error } = await supabase.from('bills').update({ status: 'paid', paid_date: new Date().toISOString().split('T')[0], payment_method: 'cash' }).eq('id', billId)
    if (error) { toast.error('Failed to mark as paid'); return }
    toast.success('Bill marked as paid')
    loadData()
  }

  const addBill = async () => {
    const { error } = await supabase.from('bills').insert(newBill)
    if (error) { toast.error(error.message); return }
    toast.success('Bill added')
    setShowAddBill(false)
    setNewBill({ consumer_id: '', month: new Date().getMonth() + 1, year: new Date().getFullYear(), amount_pkr: 200 })
    loadData()
  }

  const addConsumer = async () => {
    const { error } = await supabase.from('consumers').insert({ ...newConsumer, status: 'active' })
    if (error) { toast.error(error.message); return }
    toast.success('Consumer added')
    setShowAddConsumer(false)
    setNewConsumer({ consumer_id: '', name: '', mobile: '', house_no: '', sector: '', monthly_rate: 200 })
    loadData()
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map((b) => b.id)))
  }

  const bulkMarkPaid = async () => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('bills').update({ status: 'paid', paid_date: new Date().toISOString().split('T')[0], payment_method: 'cash' }).in('id', ids)
    if (error) { toast.error('Failed to mark bills as paid'); return }
    toast.success(`${ids.length} bill(s) marked as paid`)
    setSelected(new Set())
    loadData()
  }

  const bulkDelete = async () => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('bills').delete().in('id', ids)
    if (error) { toast.error('Failed to delete bills'); return }
    toast.success(`${ids.length} bill(s) deleted`)
    setSelected(new Set())
    setConfirmDelete(false)
    loadData()
  }

  return (
    <>
      <Toaster position="top-right" />
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

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-outline" />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by Consumer ID or Name..." className="w-full pl-10 pr-4 py-2 border-2 border-dp-outline-variant rounded-lg focus:border-dp-primary focus:ring-0 text-[14px] font-sans" />
      </div>

      {/* Bulk actions */}
      <BulkActionsBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={[
          { label: 'Mark Selected as Paid', onClick: bulkMarkPaid, variant: 'primary' },
          { label: 'Delete Selected', onClick: () => setConfirmDelete(true), variant: 'danger' },
        ]}
      />

      {/* Table */}
      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
                <th className="p-4 w-10"><input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleSelectAll} className="accent-dp-secondary cursor-pointer" /></th>
                <th className="p-4">Consumer ID</th>
                <th className="p-4">Lookup Code</th>
                <th className="p-4">Name</th>
                <th className="p-4">Period</th>
                <th className="p-4">Amount</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={8} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && filtered.map((bill, i) => {
                const c = consumerMap[bill.consumer_id]
                return (
                  <tr key={bill.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${selected.has(bill.id) ? 'bg-dp-secondary-container/20' : ''}`}>
                    <td className="p-4 border-b border-dp-outline-variant"><input type="checkbox" checked={selected.has(bill.id)} onChange={() => toggleSelect(bill.id)} className="accent-dp-secondary cursor-pointer" /></td>
                    <td className="p-4 border-b border-dp-outline-variant">{bill.consumer_id}</td>
                    <td className="p-4 border-b border-dp-outline-variant font-mono text-[12px] text-dp-secondary">{c?.lookup_token ?? '—'}</td>
                    <td className="p-4 border-b border-dp-outline-variant font-semibold">{c?.name ?? '—'}</td>
                    <td className="p-4 border-b border-dp-outline-variant">{months[bill.month]} {bill.year}</td>
                    <td className="p-4 border-b border-dp-outline-variant font-bold">Rs. {bill.amount_pkr.toLocaleString()}</td>
                    <td className="p-4 border-b border-dp-outline-variant">
                      <StatusBadge status={bill.status} />
                    </td>
                    <td className="p-4 border-b border-dp-outline-variant text-right space-x-2">
                      {bill.status !== 'paid' ? (
                        <button onClick={() => markPaid(bill.id)} className="bg-dp-primary text-white px-3 py-1 rounded text-[14px] font-sans font-semibold hover:bg-dp-primary-container transition-all cursor-pointer">
                          Mark Paid
                        </button>
                      ) : (
                        <button disabled className="opacity-30 cursor-not-allowed border border-dp-outline px-3 py-1 rounded text-[14px] font-sans">Paid</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!loading && filtered.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-dp-on-surface-variant">No bills found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Bills"
        message={`Are you sure you want to delete ${selected.size} bill(s)? This cannot be undone.`}
        onConfirm={bulkDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      {/* Add Bill Modal */}
      {showAddBill && (
        <Modal title="Add New Bill" onClose={() => setShowAddBill(false)}>
          <div className="space-y-4">
            <Field label="Consumer ID">
              <select value={newBill.consumer_id} onChange={(e) => setNewBill({ ...newBill, consumer_id: e.target.value })} className="input-field">
                <option value="">Select Consumer</option>
                {consumers.map((c) => <option key={c.consumer_id} value={c.consumer_id}>{c.consumer_id} — {c.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Month"><input type="number" min={1} max={12} value={newBill.month} onChange={(e) => setNewBill({ ...newBill, month: +e.target.value })} className="input-field" /></Field>
              <Field label="Year"><input type="number" value={newBill.year} onChange={(e) => setNewBill({ ...newBill, year: +e.target.value })} className="input-field" /></Field>
            </div>
            <Field label="Amount (PKR)"><input type="number" value={newBill.amount_pkr} onChange={(e) => setNewBill({ ...newBill, amount_pkr: +e.target.value })} className="input-field" /></Field>
            <button onClick={addBill} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">Add Bill</button>
          </div>
        </Modal>
      )}

      {/* Add Consumer Modal */}
      {showAddConsumer && (
        <Modal title="Add New Consumer" onClose={() => setShowAddConsumer(false)}>
          <div className="space-y-4">
            <Field label="Consumer ID"><input type="text" value={newConsumer.consumer_id} onChange={(e) => setNewConsumer({ ...newConsumer, consumer_id: e.target.value })} placeholder="e.g. DP-1011" className="input-field" /></Field>
            <Field label="Name"><input type="text" value={newConsumer.name} onChange={(e) => setNewConsumer({ ...newConsumer, name: e.target.value })} className="input-field" /></Field>
            <Field label="Mobile"><input type="text" value={newConsumer.mobile} onChange={(e) => setNewConsumer({ ...newConsumer, mobile: e.target.value })} placeholder="0300-1234567" className="input-field" /></Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="House No."><input type="text" value={newConsumer.house_no} onChange={(e) => setNewConsumer({ ...newConsumer, house_no: e.target.value })} className="input-field" /></Field>
              <Field label="Sector"><input type="text" value={newConsumer.sector} onChange={(e) => setNewConsumer({ ...newConsumer, sector: e.target.value })} placeholder="Sector A" className="input-field" /></Field>
            </div>
            <Field label="Monthly Rate (PKR)"><input type="number" value={newConsumer.monthly_rate} onChange={(e) => setNewConsumer({ ...newConsumer, monthly_rate: +e.target.value })} className="input-field" /></Field>
            <button onClick={addConsumer} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">Add Consumer</button>
          </div>
        </Modal>
      )}
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  const s: Record<string, string> = { paid: 'bg-dp-primary-container text-white', unpaid: 'bg-dp-error-container text-dp-error', pending: 'bg-amber-100 text-amber-800', late: 'bg-dp-error text-white' }
  return <span className={`text-[10px] uppercase font-black px-2 py-1 rounded font-sans ${s[status] ?? ''}`}>{status}</span>
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
