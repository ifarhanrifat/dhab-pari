'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X } from 'lucide-react'
import { toast, Toaster } from 'sonner'

interface Transaction { id: string; type: string; amount_pkr: number; date: string; category: string; description: string; reference_no: string | null }

const incomeCategories = ['Utilities', 'Donation', 'Welfare', 'Other']
const expenseCategories = ['Maintenance', 'Salaries', 'Power', 'Infrastructure', 'Welfare', 'Other']

export default function FinancePage() {
  const [txns, setTxns] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ type: 'income', amount_pkr: 0, date: new Date().toISOString().split('T')[0], category: 'Utilities', description: '' })
  const supabase = createClient()

  const load = async () => { const { data } = await supabase.from('transactions').select('*').order('date', { ascending: false }).limit(50); setTxns(data ?? []); setLoading(false) }
  useEffect(() => { load() }, [])

  const totalIncome = txns.filter((t) => t.type === 'income').reduce((s, t) => s + Number(t.amount_pkr), 0)
  const totalExpense = txns.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount_pkr), 0)

  const save = async () => {
    if (!form.description.trim()) { toast.error('Description required'); return }
    const { error } = await supabase.from('transactions').insert({ ...form, created_by: 'Admin' })
    if (error) { toast.error(error.message); return }
    toast.success('Entry added'); setShowForm(false); setForm({ type: 'income', amount_pkr: 0, date: new Date().toISOString().split('T')[0], category: 'Utilities', description: '' }); load()
  }

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Accounts & Finance</h1>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> Add Entry</button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white p-5 rounded-lg border border-dp-outline-variant"><p className="text-[14px] font-sans font-semibold text-dp-on-surface-variant uppercase tracking-[0.05em]">Total Income</p><p className="font-heading text-[28px] font-bold text-dp-secondary">Rs. {totalIncome.toLocaleString()}</p></div>
        <div className="bg-white p-5 rounded-lg border border-dp-outline-variant"><p className="text-[14px] font-sans font-semibold text-dp-on-surface-variant uppercase tracking-[0.05em]">Total Expenses</p><p className="font-heading text-[28px] font-bold text-dp-error">Rs. {totalExpense.toLocaleString()}</p></div>
        <div className="bg-white p-5 rounded-lg border border-dp-outline-variant"><p className="text-[14px] font-sans font-semibold text-dp-on-surface-variant uppercase tracking-[0.05em]">Net Balance</p><p className="font-heading text-[28px] font-bold text-dp-primary">Rs. {(totalIncome - totalExpense).toLocaleString()}</p></div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
              <th className="p-4">Date</th><th className="p-4">Description</th><th className="p-4">Category</th><th className="p-4">Type</th><th className="p-4 text-right">Amount</th>
            </tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={5} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && txns.map((t, i) => (
                <tr key={t.id} className={`border-l-4 ${t.type === 'income' ? 'border-l-dp-secondary' : 'border-l-dp-error'} ${i % 2 === 1 ? 'bg-dp-surface-container/50' : ''} hover:bg-dp-surface-container-low transition-colors`}>
                  <td className="p-4 text-[14px] text-dp-on-surface-variant">{new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td className="p-4 font-semibold">{t.description}</td>
                  <td className="p-4"><span className="bg-dp-surface-container-high px-2 py-1 rounded text-[12px]">{t.category}</span></td>
                  <td className="p-4">{t.type === 'income' ? <span className="bg-dp-secondary text-white px-3 py-1 rounded-full text-[12px] font-bold uppercase">Income</span> : <span className="bg-dp-error text-white px-3 py-1 rounded-full text-[12px] font-bold uppercase">Expense</span>}</td>
                  <td className={`p-4 text-right font-bold ${t.type === 'income' ? 'text-dp-secondary' : 'text-dp-error'}`}>Rs. {Number(t.amount_pkr).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">Add Transaction</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Type</label><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, category: e.target.value === 'income' ? 'Utilities' : 'Maintenance' })} className="input-field"><option value="income">Income</option><option value="expense">Expense</option></select></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Date</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Category</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">{(form.type === 'income' ? incomeCategories : expenseCategories).map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Amount (PKR)</label><input type="number" value={form.amount_pkr} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Description</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input-field" /></div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">Add Entry</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
