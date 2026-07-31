'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Save, ShieldCheck, UserCircle2, Clock, CheckCircle2, Truck, Pencil } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface AdminUser {
  id: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  auth_user_id: string | null
  can_post_transactions: boolean
  can_edit_transactions: boolean
  can_delete_transactions: boolean
  can_view_reports: boolean
  can_approve_transactions: boolean
  can_manage_parties: boolean
  can_manage_accounts: boolean
  can_edit_accounts: boolean
  can_delete_accounts: boolean
  can_restore_deleted: boolean
  can_invite_users: boolean
  access_water_supply: boolean
  access_donors_projects: boolean
  invited_at: string | null
  invite_accepted_at: string | null
  created_at: string
  mobile: string | null
  assigned_sectors: string[] | null
  can_collect_payments: boolean
  can_verify_complaints: boolean
}

const roleColors: Record<string, string> = {
  super_admin: 'bg-dp-primary text-white',
  admin: 'bg-indigo-600 text-white',
  accountant: 'bg-teal-100 text-teal-800',
  water_accountant: 'bg-blue-100 text-blue-800',
  donor_accountant: 'bg-violet-100 text-violet-800',
  publisher: 'bg-amber-100 text-amber-800',
  viewer: 'bg-gray-100 text-gray-600',
}

const roleLabels: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  accountant: 'Accountant',
  water_accountant: 'Water Accountant',
  donor_accountant: 'Donor Accountant',
  publisher: 'Publisher',
  viewer: 'Viewer',
}

const roleDescriptions: Record<string, string> = {
  super_admin: 'Full access to everything — the only role that can grant Super Admin to someone else.',
  admin: 'Administrative tier below Super Admin. Can be granted approvals, restoring deleted records, and inviting users — but can never grant itself or anyone else the Super Admin role.',
  accountant: 'General bookkeeper. System access (Water Supply / Donors & Projects) is set explicitly below, independent of role.',
  water_accountant: 'Confined to Water Supply consumers, billing, accounts, and reports only.',
  donor_accountant: 'Confined to Donors & Projects accounts, donations, and reports only.',
  publisher: 'Can create news posts and videos — requires admin approval before publishing.',
  viewer: 'Read-only access across everything. Can view and drill into data but can never make changes.',
}

const permissionFields: { key: keyof AdminUser; label: string }[] = [
  { key: 'can_post_transactions', label: 'Can post transactions (bills, payments, donations, vouchers)' },
  { key: 'can_edit_transactions', label: 'Can edit existing transactions' },
  { key: 'can_delete_transactions', label: 'Can delete transactions' },
  { key: 'can_approve_transactions', label: 'Can approve pending transactions / publish content' },
  { key: 'can_view_reports', label: 'Can view reports and the dashboard' },
  { key: 'can_manage_parties', label: 'Can manage consumers/donors (add/edit)' },
  { key: 'can_manage_accounts', label: 'Can create chart of accounts entries' },
  { key: 'can_edit_accounts', label: 'Can edit chart of accounts entries' },
  { key: 'can_delete_accounts', label: 'Can delete chart of accounts entries' },
]

const adminPermissionFields: { key: keyof AdminUser; label: string }[] = [
  { key: 'can_restore_deleted', label: 'Can restore deleted records from the Audit Log' },
  { key: 'can_invite_users', label: 'Can invite and remove users (never Super Admins)' },
]

const emptyInvite = {
  email: '', full_name: '', role: 'water_accountant',
  can_post_transactions: false, can_edit_transactions: false, can_delete_transactions: false,
  can_view_reports: false, can_approve_transactions: false,
  can_manage_parties: false, can_manage_accounts: false, can_edit_accounts: false, can_delete_accounts: false,
  can_restore_deleted: false, can_invite_users: false,
  access_water_supply: false, access_donors_projects: false,
}

const emptyCollectorForm = { mobile: '', can_collect_payments: false, assigned_sectors: [] as string[], can_verify_complaints: false }

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyInvite)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [currentAuthUserId, setCurrentAuthUserId] = useState<string | null>(null)
  const [currentRole, setCurrentRole] = useState<string | null>(null)
  const [sectorOptions, setSectorOptions] = useState<{ id: string; name: string }[]>([])
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null)
  const [collectorForm, setCollectorForm] = useState(emptyCollectorForm)
  const [savingCollector, setSavingCollector] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    setCurrentAuthUserId(user?.id ?? null)
    const [{ data }, { data: sectorsData }] = await Promise.all([
      supabase.from('admin_users').select('*').order('role').order('full_name'),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
    ])
    setUsers(data ?? [])
    setSectorOptions(sectorsData ?? [])
    if (user) {
      const mine = (data ?? []).find((u) => u.auth_user_id === user.id)
      setCurrentRole(mine?.role ?? null)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const openEditCollector = (u: AdminUser) => {
    setEditingUser(u)
    setCollectorForm({ mobile: u.mobile ?? '', can_collect_payments: u.can_collect_payments, assigned_sectors: u.assigned_sectors ?? [], can_verify_complaints: u.can_verify_complaints })
  }

  const toggleSector = (name: string) => {
    setCollectorForm((f) => ({
      ...f,
      assigned_sectors: f.assigned_sectors.includes(name) ? f.assigned_sectors.filter((s) => s !== name) : [...f.assigned_sectors, name],
    }))
  }

  const saveCollectorSettings = async () => {
    if (!editingUser) return
    setSavingCollector(true)
    const { error } = await supabase.from('admin_users').update({
      mobile: collectorForm.mobile.trim() || null,
      can_collect_payments: collectorForm.can_collect_payments,
      assigned_sectors: collectorForm.can_collect_payments && collectorForm.assigned_sectors.length > 0 ? collectorForm.assigned_sectors : null,
      can_verify_complaints: collectorForm.can_verify_complaints,
    }).eq('id', editingUser.id)
    setSavingCollector(false)
    if (error) { toast.error(error.message); return }
    toast.success(`${editingUser.full_name}'s settings updated`)
    setEditingUser(null)
    load()
  }

  const showPermissions = ['admin', 'accountant', 'water_accountant', 'donor_accountant'].includes(form.role)
  const availableRoles = currentRole === 'super_admin'
    ? ['water_accountant', 'donor_accountant', 'accountant', 'viewer', 'publisher', 'admin', 'super_admin']
    : ['water_accountant', 'donor_accountant', 'accountant', 'viewer', 'publisher', 'admin']

  const sendInvite = async () => {
    if (!form.email.trim() || !form.full_name.trim()) { toast.error('Email and full name required'); return }
    setInviting(true)
    try {
      const res = await fetch('/api/admin/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Failed to send invite'); setInviting(false); return }
      toast.success(`Invitation sent to ${form.email}`)
      setShowForm(false)
      setForm(emptyInvite)
      load()
    } catch {
      toast.error('Network error sending invite')
    }
    setInviting(false)
  }

  const removeUser = async () => {
    if (!confirmRemove) return
    try {
      const res = await fetch('/api/admin/users/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminUserId: confirmRemove }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Failed to remove user'); setConfirmRemove(null); return }
      toast.success('User removed')
    } catch {
      toast.error('Network error removing user')
    }
    setConfirmRemove(null)
    load()
  }

  const toggleActive = async (id: string, current: boolean) => {
    await supabase.from('admin_users').update({ is_active: !current }).eq('id', id)
    toast.success(current ? 'User deactivated' : 'User activated')
    load()
  }

  const changeRole = async (u: AdminUser, newRole: string) => {
    if (newRole === u.role) return
    const { error } = await supabase.from('admin_users').update({ role: newRole }).eq('id', u.id)
    if (error) { toast.error(error.message); load(); return }
    toast.success(`${u.full_name}'s role changed to ${roleLabels[newRole] ?? newRole}`)
    load()
  }

  const handleRowAction = (u: AdminUser, value: string) => {
    if (value === '__toggle_active__') { toggleActive(u.id, u.is_active); return }
    if (value === '__delete__') { setConfirmRemove(u.id); return }
    changeRole(u, value)
  }

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">User Management</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Invite users and control exactly what they can access.</p>
        </div>
        <button onClick={() => { setForm(emptyInvite); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> Invite User
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {Object.entries(roleLabels).map(([key, label]) => (
          <div key={key} className="bg-white rounded-lg border border-dp-outline-variant p-3">
            <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${roleColors[key]}`}>{label}</span>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-2 leading-[1.4]">{roleDescriptions[key]}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-dp-surface-container-low text-dp-outline text-[13px] font-sans font-bold tracking-[0.05em]">
                <th className="p-4">Name</th>
                <th className="p-4">Email</th>
                <th className="p-4">Role</th>
                <th className="p-4">Invite Status</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="font-sans text-[14px]">
              {loading && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && users.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center">
                  <UserCircle2 size={40} className="text-dp-on-surface-variant mx-auto mb-3 opacity-40" />
                  <p className="font-sans text-[16px] text-dp-on-surface-variant">No users yet.</p>
                </td></tr>
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
                    {u.can_collect_payments && (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-teal-700 bg-teal-100 px-1.5 py-0.5 rounded-full" title={`Field collector — ${(u.assigned_sectors ?? []).join(', ') || 'no sectors assigned'}`}>
                        <Truck size={10} /> Collector
                      </span>
                    )}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    {!u.invited_at ? (
                      <span className="text-[11px] text-dp-on-surface-variant">—</span>
                    ) : u.invite_accepted_at ? (
                      <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-700"><CheckCircle2 size={12} /> Accepted</span>
                    ) : (
                      <span className="flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock size={12} /> Pending</span>
                    )}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant text-right">
                    {u.auth_user_id === currentAuthUserId ? (
                      <span className="text-[11px] text-dp-on-surface-variant italic">This is you</span>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => openEditCollector(u)} title="Edit mobile number / field collector settings" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                          <Pencil size={15} />
                        </button>
                        <select
                          value={u.role}
                          onChange={(e) => handleRowAction(u, e.target.value)}
                          className="text-[12px] font-sans border border-dp-outline-variant rounded px-1.5 py-1 cursor-pointer bg-white"
                        >
                          <optgroup label="Change Role">
                            {(currentRole === 'super_admin' ? availableRoles : availableRoles.filter((r) => r !== 'super_admin')).map((r) => (
                              <option key={r} value={r}>{roleLabels[r]}</option>
                            ))}
                            {u.role === 'super_admin' && !availableRoles.includes('super_admin') && (
                              <option value="super_admin">{roleLabels.super_admin}</option>
                            )}
                          </optgroup>
                          <optgroup label="Actions">
                            <option value="__toggle_active__">{u.is_active ? 'Deactivate' : 'Activate'}</option>
                            <option value="__delete__">Delete User</option>
                          </optgroup>
                        </select>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove User"
        message="This permanently deletes their login and revokes all access immediately. This cannot be undone."
        onConfirm={removeUser}
        onCancel={() => setConfirmRemove(null)}
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[24px] font-bold text-dp-primary">Invite User</h2>
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
                  {availableRoles.map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
                </select>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{roleDescriptions[form.role]}</p>
              </div>
              {form.role === 'accountant' && (
                <div className="bg-dp-surface-container-low rounded-lg p-4 space-y-2.5">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">System Access</p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.access_water_supply} onChange={(e) => setForm({ ...form, access_water_supply: e.target.checked })} className="accent-dp-secondary" />
                    <span className="font-sans text-[13.5px]">Water Supply System</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.access_donors_projects} onChange={(e) => setForm({ ...form, access_donors_projects: e.target.checked })} className="accent-dp-secondary" />
                    <span className="font-sans text-[13.5px]">Donors &amp; Projects System</span>
                  </label>
                </div>
              )}
              {showPermissions && (
                <div className="bg-dp-surface-container-low rounded-lg p-4 space-y-2.5">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">Permissions</p>
                  {permissionFields.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!form[f.key as keyof typeof form]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                        className="accent-dp-secondary"
                      />
                      <span className="font-sans text-[13.5px]">{f.label}</span>
                    </label>
                  ))}
                </div>
              )}
              {form.role === 'admin' && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 space-y-2.5">
                  <p className="font-sans text-[13px] font-bold text-indigo-900 uppercase tracking-[0.05em] mb-1">Admin Capabilities</p>
                  {adminPermissionFields.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!form[f.key as keyof typeof form]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                        className="accent-indigo-600"
                      />
                      <span className="font-sans text-[13.5px] text-indigo-900">{f.label}</span>
                    </label>
                  ))}
                </div>
              )}
              {form.role === 'publisher' && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-2">
                  <ShieldCheck size={16} className="text-amber-700 shrink-0 mt-0.5" />
                  <p className="font-sans text-[13px] text-amber-800">Publisher posts will appear as <strong>drafts</strong> and must be approved by a Super Admin before going live on the website.</p>
                </div>
              )}
              <button disabled={inviting} onClick={sendInvite} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {inviting ? 'Sending Invite...' : 'Send Invitation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingUser && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEditingUser(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{editingUser.full_name}</h2>
              <button onClick={() => setEditingUser(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Mobile Number</label>
                <input
                  value={collectorForm.mobile}
                  onChange={(e) => setCollectorForm({ ...collectorForm, mobile: e.target.value })}
                  placeholder="0300-1234567"
                  className="input-field"
                />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">Used for WhatsApp notifications (e.g. a field collector's payment alert).</p>
              </div>
              {editingUser.role === 'viewer' && (
                <div className="bg-teal-50 border border-teal-200 rounded-lg p-4 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={collectorForm.can_collect_payments}
                      onChange={(e) => setCollectorForm({ ...collectorForm, can_collect_payments: e.target.checked })}
                      className="accent-teal-700"
                    />
                    <span className="font-sans text-[13.5px] font-semibold text-teal-900 flex items-center gap-1.5"><Truck size={14} /> Field Collector — can collect payments on the spot</span>
                  </label>
                  {collectorForm.can_collect_payments && (
                    <div>
                      <p className="font-sans text-[12.5px] font-semibold text-teal-900 mb-1.5">Assigned Sectors</p>
                      {sectorOptions.length === 0 ? (
                        <p className="font-sans text-[12px] text-teal-800">No sectors defined yet.</p>
                      ) : (
                        <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                          {sectorOptions.map((s) => (
                            <label key={s.id} className="flex items-center gap-1.5 cursor-pointer">
                              <input type="checkbox" checked={collectorForm.assigned_sectors.includes(s.name)} onChange={() => toggleSector(s.name)} className="accent-teal-700" />
                              <span className="font-sans text-[12.5px] text-teal-900">{s.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <p className="font-sans text-[11.5px] text-teal-800 mt-1.5">Can only collect payments from consumers in these sectors — enforced by the database, not just the UI.</p>
                    </div>
                  )}
                </div>
              )}
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={collectorForm.can_verify_complaints}
                    onChange={(e) => setCollectorForm({ ...collectorForm, can_verify_complaints: e.target.checked })}
                    className="accent-indigo-600"
                  />
                  <span className="font-sans text-[13.5px] font-semibold text-indigo-900 flex items-center gap-1.5"><ShieldCheck size={14} /> Complaint Verifier — final higher-management sign-off</span>
                </label>
                <p className="font-sans text-[11.5px] text-indigo-800 mt-1.5">Not tied to role — any user can be a verifier. They&apos;ll be notified when a handler marks a complaint resolved, and can verify &amp; close it or send it back.</p>
              </div>
              <button disabled={savingCollector} onClick={saveCollectorSettings} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {savingCollector ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
