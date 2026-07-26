'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Save, Droplets, Heart } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface Account {
  id: string
  code: string
  name: string
  name_ur: string | null
  type: string
  system: string
  description: string | null
  opening_balance: number
  is_active: boolean
}

type SystemTab = 'water_supply' | 'donors_projects'

const typeColors: Record<string, string> = {
  cash: 'bg-emerald-100 text-emerald-800',
  bank: 'bg-blue-100 text-blue-800',
  income: 'bg-violet-100 text-violet-800',
  expense: 'bg-red-100 text-red-700',
  asset: 'bg-amber-100 text-amber-800',
  liability: 'bg-slate-100 text-slate-700',
}

const typeOrder = ['cash', 'bank', 'income', 'expense', 'asset', 'liability']

const emptyAccount = {
  code: '',
  name: '',
  name_ur: '',
  type: 'expense',
  system: 'water_supply' as SystemTab,
  description: '',
  opening_balance: 0,
  is_active: true,
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<SystemTab>('water_supply')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...emptyAccount, system: 'water_supply' as SystemTab })
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('accounts').select('*').order('code')
    setAccounts(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const bySystem = useMemo(() => {
    return accounts.filter((a) => a.system === tab)
  }, [accounts, tab])

  const byType = useMemo(() => {
    const grouped: Record<string, Account[]> = {}
    typeOrder.forEach((t) => { grouped[t] = [] })
    bySystem.forEach((a) => {
      if (!grouped[a.type]) grouped[a.type] = []
      grouped[a.type].push(a)
    })
    return grouped
  }, [bySystem])

  const openAdd = () => {
    setEditId(null)
    setForm({ ...emptyAccount, system: tab })
    setShowForm(true)
  }

  const openEdit = (a: Account) => {
    setEditId(a.id)
    setForm({ code: a.code, name: a.name, name_ur: a.name_ur ?? '', type: a.type, system: a.system as SystemTab, description: a.description ?? '', opening_balance: a.opening_balance, is_active: a.is_active })
    setShowForm(true)
  }

  const save = async () => {
    if (!form.code.trim() || !form.name.trim()) { toast.error('Code and name required'); return }
    const payload = { ...form, name_ur: form.name_ur || null, description: form.description || null }
    if (editId) {
      const { error } = await supabase.from('accounts').update(payload).eq('id', editId)
      if (error) { toast.error(error.message); return }
      toast.success('Account updated')
    } else {
      const { error } = await supabase.from('accounts').insert(payload)
      if (error) { toast.error(error.message); return }
      toast.success('Account created')
    }
    setShowForm(false)
    setEditId(null)
    load()
  }

  const deleteAccount = async () => {
    if (!confirmDelete) return
    const { error } = await supabase.from('accounts').delete().eq('id', confirmDelete)
    if (error) { toast.error(error.message); return }
    toast.success('Account deleted')
    setConfirmDelete(null)
    load()
  }

  const toggleActive = async (id: string, current: boolean) => {
    await supabase.from('accounts').update({ is_active: !current }).eq('id', id)
    toast.success(current ? 'Account deactivated' : 'Account activated')
    load()
  }

  const waterCount = accounts.filter((a) => a.system === 'water_supply').length
  const donorCount = accounts.filter((a) => a.system === 'donors_projects').length

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Chart of Accounts</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Manage expense accounts, cash accounts, and income accounts for each system.</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> New Account
        </button>
      </div>

      {/* System tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('water_supply')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-sans text-[14px] font-semibold transition-all cursor-pointer ${tab === 'water_supply' ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container-low'}`}
        >
          <Droplets size={16} />
          Water Supply System
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tab === 'water_supply' ? 'bg-white/20 text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{waterCount}</span>
        </button>
        <button
          onClick={() => setTab('donors_projects')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-sans text-[14px] font-semibold transition-all cursor-pointer ${tab === 'donors_projects' ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container-low'}`}
        >
          <Heart size={16} />
          Donors &amp; Projects
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tab === 'donors_projects' ? 'bg-white/20 text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{donorCount}</span>
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans">Loading accounts...</div>
      ) : (
        <div className="space-y-6">
          {typeOrder.map((type) => {
            const typeAccounts = byType[type] ?? []
            if (typeAccounts.length === 0) return null
            return (
              <div key={type} className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
                <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low flex items-center gap-2">
                  <span className={`text-[11px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${typeColors[type]}`}>{type}</span>
                  <span className="font-sans text-[13px] text-dp-on-surface-variant font-semibold capitalize">Accounts ({typeAccounts.length})</span>
                </div>
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant">
                      <th className="px-5 py-2.5">Code</th>
                      <th className="px-5 py-2.5">Account Name</th>
                      <th className="px-5 py-2.5 hidden md:table-cell">Urdu Name</th>
                      <th className="px-5 py-2.5 hidden lg:table-cell">Description</th>
                      <th className="px-5 py-2.5 text-right">Opening Balance</th>
                      <th className="px-5 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {typeAccounts.map((a, i) => (
                      <tr key={a.id} className={`font-sans text-[14px] ${i % 2 === 1 ? 'bg-dp-surface-container/20' : ''} ${!a.is_active ? 'opacity-50' : ''}`}>
                        <td className="px-5 py-3 font-mono text-[13px] font-bold text-dp-secondary">{a.code}</td>
                        <td className="px-5 py-3 font-semibold text-dp-on-surface">{a.name}</td>
                        <td className="px-5 py-3 hidden md:table-cell text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '1.8' }}>{a.name_ur ?? '—'}</td>
                        <td className="px-5 py-3 hidden lg:table-cell text-dp-on-surface-variant text-[13px]">{a.description ?? '—'}</td>
                        <td className="px-5 py-3 text-right font-semibold">
                          {a.opening_balance > 0 ? <span className="text-dp-secondary">Rs. {Number(a.opening_balance).toLocaleString()}</span> : <span className="text-dp-on-surface-variant">—</span>}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={() => openEdit(a)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer" title="Edit"><Pencil size={15} /></button>
                            <button onClick={() => toggleActive(a.id, a.is_active)} className={`text-[11px] px-2 py-0.5 rounded font-sans font-semibold cursor-pointer transition-all ${a.is_active ? 'text-dp-on-surface-variant border border-dp-outline-variant hover:bg-dp-surface-container' : 'bg-dp-secondary text-white hover:bg-dp-primary'}`}>
                              {a.is_active ? 'Disable' : 'Enable'}
                            </button>
                            <button onClick={() => setConfirmDelete(a.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title="Delete"><X size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}

          {bySystem.length === 0 && (
            <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center">
              <p className="font-sans text-[16px] text-dp-on-surface-variant mb-4">No accounts yet for this system.</p>
              <button onClick={openAdd} className="flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer mx-auto">
                <PlusCircle size={16} /> Create First Account
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Account"
        message="Are you sure you want to delete this account? This cannot be undone."
        onConfirm={deleteAccount}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[24px] font-bold text-dp-primary">{editId ? 'Edit Account' : 'New Account'}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Account Code *</label>
                  <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. WS-3005" className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Account Type *</label>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="input-field">
                    <option value="cash">Cash</option>
                    <option value="bank">Bank</option>
                    <option value="income">Income</option>
                    <option value="expense">Expense</option>
                    <option value="asset">Asset</option>
                    <option value="liability">Liability</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Account Name (English) *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Account Name (Urdu)</label>
                <input value={form.name_ur ?? ''} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder="اردو میں نام" className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">System</label>
                <select value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value as SystemTab })} className="input-field">
                  <option value="water_supply">Water Supply System</option>
                  <option value="donors_projects">Donors &amp; Projects System</option>
                </select>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Opening Balance (PKR)</label>
                <input type="number" value={form.opening_balance} onChange={(e) => setForm({ ...form, opening_balance: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Description</label>
                <textarea value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="input-field resize-none" />
              </div>
              <button onClick={save} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> {editId ? 'Save Changes' : 'Create Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
