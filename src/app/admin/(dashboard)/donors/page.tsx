'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, CheckCircle, XCircle } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { BulkActionsBar } from '@/components/admin/BulkActionsBar'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface Donor { id: string; name: string; phone: string | null; donor_type: string | null; amount_pkr: number; date: string; is_anonymous: boolean; is_verified: boolean; payment_method: string | null; notes: string | null; project_id: string | null }
interface Project { id: string; title: string }
const empty = { name: '', phone: '', donor_type: 'villager', amount_pkr: 0, date: new Date().toISOString().split('T')[0], is_anonymous: false, payment_method: 'cash', notes: '', project_id: '' }

export default function AdminDonorsPage() {
  const [donors, setDonors] = useState<Donor[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const [donorsRes, projectsRes] = await Promise.all([
      supabase.from('donors').select('*').order('date', { ascending: false }),
      supabase.from('projects').select('id, title').order('title'),
    ])
    setDonors(donorsRes.data ?? [])
    setProjects(projectsRes.data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name required'); return }
    const payload = { ...form, project_id: form.project_id || null, notes: form.notes || null, phone: form.phone || null }
    const { error } = await supabase.from('donors').insert({ ...payload, is_verified: true })
    if (error) { toast.error(error.message); return }
    toast.success('Donor added'); setShowForm(false); setForm(empty); load()
  }

  const toggleVerify = async (id: string, current: boolean) => {
    await supabase.from('donors').update({ is_verified: !current }).eq('id', id)
    toast.success(current ? 'Unverified' : 'Verified'); load()
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
    if (selected.size === donors.length) setSelected(new Set())
    else setSelected(new Set(donors.map((d) => d.id)))
  }

  const bulkVerify = async () => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('donors').update({ is_verified: true }).in('id', ids)
    if (error) { toast.error('Failed to verify donors'); return }
    toast.success(`${ids.length} donor(s) verified`)
    setSelected(new Set())
    load()
  }

  const bulkDelete = async () => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('donors').delete().in('id', ids)
    if (error) { toast.error('Failed to delete donors'); return }
    toast.success(`${ids.length} donor(s) deleted`)
    setSelected(new Set())
    setConfirmDelete(false)
    load()
  }

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Donors</h1>
        <button onClick={() => { setForm(empty); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> Add Donor</button>
      </div>
      <BulkActionsBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={[
          { label: 'Verify Selected', onClick: bulkVerify, variant: 'primary' },
          { label: 'Delete Selected', onClick: () => setConfirmDelete(true), variant: 'danger' },
        ]}
      />

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]"><th className="p-4 w-10"><input type="checkbox" checked={donors.length > 0 && selected.size === donors.length} onChange={toggleSelectAll} className="accent-dp-secondary cursor-pointer" /></th><th className="p-4">Name</th><th className="p-4">Type</th><th className="p-4">Phone</th><th className="p-4">Amount</th><th className="p-4">Date</th><th className="p-4">Method</th><th className="p-4">Verified</th><th className="p-4 text-right">Actions</th></tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={9} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && donors.map((d, i) => (
                <tr key={d.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${selected.has(d.id) ? 'bg-dp-secondary-container/20' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant"><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} className="accent-dp-secondary cursor-pointer" /></td>
                  <td className="p-4 border-b border-dp-outline-variant font-semibold">{d.is_anonymous ? <span className="italic text-dp-on-surface-variant">Anonymous</span> : d.name}</td>
                  <td className="p-4 border-b border-dp-outline-variant"><span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${d.donor_type === 'overseas' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>{d.donor_type === 'overseas' ? 'Overseas' : 'Villager'}</span></td>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant">{d.phone ?? '—'}</td>
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

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Donors"
        message={`Are you sure you want to delete ${selected.size} donor(s)? This cannot be undone.`}
        onConfirm={bulkDelete}
        onCancel={() => setConfirmDelete(false)}
      />
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">Add Donor</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Phone</label><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0300-1234567" className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Donor Type</label><select value={form.donor_type} onChange={(e) => setForm({ ...form, donor_type: e.target.value })} className="input-field"><option value="villager">Villager (مقامی)</option><option value="overseas">Overseas (بیرون ملک)</option></select></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Amount (PKR)</label><input type="number" value={form.amount_pkr} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Date</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Payment Method</label><select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className="input-field"><option value="cash">Cash</option><option value="jazzcash">JazzCash</option><option value="easypaisa">Easypaisa</option><option value="bank">Bank</option></select></div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Select Project (optional)</label>
                <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className="input-field">
                  <option value="">No specific project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Notes (optional)</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Any additional notes..." className="input-field resize-none" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_anonymous} onChange={(e) => setForm({ ...form, is_anonymous: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">Anonymous Donor</span></label>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">Add Donor</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
