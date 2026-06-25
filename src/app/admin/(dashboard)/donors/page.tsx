'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, CheckCircle, XCircle } from 'lucide-react'
import { toast, Toaster } from 'sonner'

interface Donor { id: string; name: string; amount_pkr: number; date: string; is_anonymous: boolean; is_verified: boolean; payment_method: string | null; notes: string | null }
const empty = { name: '', amount_pkr: 0, date: new Date().toISOString().split('T')[0], is_anonymous: false, payment_method: 'cash', notes: '' }

export default function AdminDonorsPage() {
  const [donors, setDonors] = useState<Donor[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => { const { data } = await supabase.from('donors').select('*').order('date', { ascending: false }); setDonors(data ?? []); setLoading(false) }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name required'); return }
    const { error } = await supabase.from('donors').insert({ ...form, is_verified: true })
    if (error) { toast.error(error.message); return }
    toast.success('Donor added'); setShowForm(false); setForm(empty); load()
  }

  const toggleVerify = async (id: string, current: boolean) => {
    await supabase.from('donors').update({ is_verified: !current }).eq('id', id)
    toast.success(current ? 'Unverified' : 'Verified'); load()
  }

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Donors</h1>
        <button onClick={() => { setForm(empty); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> Add Donor</button>
      </div>
      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]"><th className="p-4">Name</th><th className="p-4">Amount</th><th className="p-4">Date</th><th className="p-4">Method</th><th className="p-4">Verified</th><th className="p-4 text-right">Actions</th></tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && donors.map((d, i) => (
                <tr key={d.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant font-semibold">{d.is_anonymous ? <span className="italic text-dp-on-surface-variant">Anonymous</span> : d.name}</td>
                  <td className="p-4 border-b border-dp-outline-variant font-bold text-dp-secondary">Rs. {Number(d.amount_pkr).toLocaleString()}</td>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant">{new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td className="p-4 border-b border-dp-outline-variant"><span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[12px] font-sans">{d.payment_method ?? '—'}</span></td>
                  <td className="p-4 border-b border-dp-outline-variant">{d.is_verified ? <CheckCircle size={16} className="text-dp-secondary" /> : <XCircle size={16} className="text-dp-on-surface-variant" />}</td>
                  <td className="p-4 border-b border-dp-outline-variant text-right">
                    <button onClick={() => toggleVerify(d.id, d.is_verified)} className={`px-3 py-1 rounded text-[14px] font-sans font-semibold cursor-pointer transition-all ${d.is_verified ? 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container' : 'bg-dp-secondary text-white hover:bg-dp-primary'}`}>{d.is_verified ? 'Unverify' : 'Verify'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">Add Donor</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Amount (PKR)</label><input type="number" value={form.amount_pkr} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Date</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Payment Method</label><select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className="input-field"><option value="cash">Cash</option><option value="jazzcash">JazzCash</option><option value="easypaisa">Easypaisa</option><option value="bank">Bank</option></select></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_anonymous} onChange={(e) => setForm({ ...form, is_anonymous: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">Anonymous Donor</span></label>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">Add Donor</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
