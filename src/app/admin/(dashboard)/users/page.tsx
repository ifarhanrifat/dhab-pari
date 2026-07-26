'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Save, ShieldCheck, UserCircle2 } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface AdminUser {
  id: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  notes: string | null
  created_at: string
}

const roleColors: Record<string, string> = {
  super_admin: 'bg-dp-primary text-white',
  water_accountant: 'bg-blue-100 text-blue-800',
  donor_accountant: 'bg-violet-100 text-violet-800',
  publisher: 'bg-amber-100 text-amber-800',
  viewer: 'bg-gray-100 text-gray-600',
}

const roleLabels: Record<string, string> = {
  super_admin: 'Super Admin',
  water_accountant: 'Water Accountant',
  donor_accountant: 'Donor Accountant',
  publisher: 'Publisher',
  viewer: 'Viewer',
}

const roleDescriptions: Record<string, string> = {
  super_admin: 'Full access to all sections of the admin panel.',
  water_accountant: 'Manages water billing, consumers, and water supply accounts.',
  donor_accountant: 'Manages donors, projects, and donor/project accounts.',
  publisher: 'Can create news posts and videos — requires admin approval before publishing.',
  viewer: 'Read-only access. Can view data but cannot make changes.',
}

const emptyUser = {
  email: '',
  full_name: '',
  role: 'viewer',
  is_active: true,
  notes: '',
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyUser)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('admin_users').select('*').order('role').order('full_name')
    setUsers(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const openAdd = () => {
    setEditId(null)
    setForm(emptyUser)
    setShowForm(true)
  }

  const openEdit = (u: AdminUser) => {
    setEditId(u.id)
    setForm({ email: u.email, full_name: u.full_name, role: u.role, is_active: u.is_active, notes: u.notes ?? '' })
    setShowForm(true)
  }

  const save = async () => {
    if (!form.email.trim() || !form.full_name.trim()) { toast.error('Email and full name required'); return }
    const payload = { ...form, notes: form.notes || null }
    if (editId) {
      const { error } = await supabase.from('admin_users').update(payload).eq('id', editId)
      if (error) { toast.error(error.message); return }
      toast.success('User updated')
    } else {
      const { error } = await supabase.from('admin_users').insert(payload)
      if (error) { toast.error(error.message); return }
      toast.success('User added')
    }
    setShowForm(false)
    setEditId(null)
    load()
  }

  const deleteUser = async () => {
    if (!confirmDelete) return
    const { error } = await supabase.from('admin_users').delete().eq('id', confirmDelete)
    if (error) { toast.error(error.message); return }
    toast.success('User removed')
    setConfirmDelete(null)
    load()
  }

  const toggleActive = async (id: string, current: boolean) => {
    await supabase.from('admin_users').update({ is_active: !current }).eq('id', id)
    toast.success(current ? 'User deactivated' : 'User activated')
    load()
  }

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">User Management</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Manage admin panel users and their access roles.</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> Add User
        </button>
      </div>

      {/* Role legend */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {Object.entries(roleLabels).map(([key, label]) => (
          <div key={key} className="bg-white rounded-lg border border-dp-outline-variant p-3">
            <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${roleColors[key]}`}>{label}</span>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-2 leading-[1.4]">{roleDescriptions[key]}</p>
          </div>
        ))}
      </div>

      {/* Users table */}
      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-dp-surface-container-low text-dp-outline text-[13px] font-sans font-bold tracking-[0.05em]">
                <th className="p-4">Name</th>
                <th className="p-4">Email</th>
                <th className="p-4">Role</th>
                <th className="p-4">Status</th>
                <th className="p-4 hidden md:table-cell">Notes</th>
                <th className="p-4">Added</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="font-sans text-[14px]">
              {loading && (
                <tr><td colSpan={7} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>
              )}
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center">
                    <UserCircle2 size={40} className="text-dp-on-surface-variant mx-auto mb-3 opacity-40" />
                    <p className="font-sans text-[16px] text-dp-on-surface-variant mb-4">No users yet. Add your first user below.</p>
                    <button onClick={openAdd} className="flex items-center gap-2 px-5 py-2 bg-dp-secondary text-white rounded-lg font-sans font-semibold cursor-pointer mx-auto hover:bg-dp-primary transition-all">
                      <PlusCircle size={16} /> Add First User
                    </button>
                  </td>
                </tr>
              )}
              {!loading && users.map((u, i) => (
                <tr key={u.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${!u.is_active ? 'opacity-50' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-dp-primary-container flex items-center justify-center font-bold text-[13px] text-dp-on-primary-container shrink-0">
                        {u.full_name.charAt(0).toUpperCase()}
                      </div>
                      <span className="font-semibold text-dp-on-surface">{u.full_name}</span>
                    </div>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant text-dp-on-surface-variant">{u.email}</td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${roleColors[u.role] ?? 'bg-gray-100 text-gray-600'}`}>
                      {roleLabels[u.role] ?? u.role}
                    </span>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant hidden md:table-cell text-dp-on-surface-variant text-[13px]">{u.notes ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant text-dp-on-surface-variant text-[13px]">
                    {new Date(u.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => openEdit(u)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer" title="Edit"><Pencil size={15} /></button>
                      <button onClick={() => toggleActive(u.id, u.is_active)} className={`text-[11px] px-2 py-0.5 rounded font-sans font-semibold cursor-pointer border ${u.is_active ? 'border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container' : 'bg-dp-secondary text-white border-transparent hover:bg-dp-primary'}`}>
                        {u.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => setConfirmDelete(u.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title="Delete"><X size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Remove User"
        message="Are you sure you want to remove this user? They will lose access to the admin panel."
        onConfirm={deleteUser}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[24px] font-bold text-dp-primary">{editId ? 'Edit User' : 'Add User'}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Full Name *</label>
                <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Email *</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user@example.com" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Role *</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="input-field">
                  <option value="viewer">Viewer — Read only</option>
                  <option value="publisher">Publisher — Create posts (needs approval)</option>
                  <option value="water_accountant">Water Accountant — Billing & water accounts</option>
                  <option value="donor_accountant">Donor Accountant — Donors & project accounts</option>
                  <option value="super_admin">Super Admin — Full access</option>
                </select>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{roleDescriptions[form.role]}</p>
              </div>
              {form.role === 'publisher' && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-2">
                  <ShieldCheck size={16} className="text-amber-700 shrink-0 mt-0.5" />
                  <p className="font-sans text-[13px] text-amber-800">Publisher posts will appear as <strong>drafts</strong> and must be approved by a Super Admin before going live on the website.</p>
                </div>
              )}
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Notes (optional)</label>
                <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Water supply accountant for Sector B" className="input-field" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" />
                <span className="font-sans text-[14px]">Active (can log in)</span>
              </label>
              <button onClick={save} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> {editId ? 'Save Changes' : 'Add User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
