'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Save, ShieldCheck, UserCircle2, Clock, CheckCircle2, Truck, Pencil, Trash2, Power, ChevronDown, ChevronUp, Key, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface AdminUser {
  id: string
  email: string
  full_name: string
  role: string
  secondary_role: string | null
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

// The exact, concrete capability list per role — not just a one-line summary.
// "System access" here means the RLS boundary (the real security guarantee);
// the individual can_* flags below it are opt-in on top of that, checked
// per-person in the Permissions section (or, for viewers, in the pencil-icon
// modal), not implied automatically by picking the role.
const rolePermissions: Record<string, string[]> = {
  super_admin: [
    'Full read + write access to both Water Supply and Donors & Projects',
    'The only role that can grant Super Admin to anyone, including via a secondary role',
    'Configures Approvers, Complaint Handlers, and Notification Preferences (Settings)',
    'Can approve an outgoing transaction on behalf of a stuck/unresponsive approver',
    'Can verify & close complaints (implicitly — no separate flag needed)',
  ],
  admin: [
    'Same day-to-day system access as Super Admin, but can never hold or grant Super Admin',
    'Individual grants (checked below): post/edit/delete transactions, approve transactions, restore deleted records, invite/remove users (never Super Admins)',
    'With the invite_users grant: can configure Approvers, Complaint Handlers, Notification Preferences',
  ],
  accountant: [
    'System access (Water Supply and/or Donors & Projects) is set explicitly per-person below — not implied by the role',
    'Individual grants (checked below): post/edit/delete transactions, view reports, manage consumers/donors, manage chart of accounts',
  ],
  water_accountant: [
    'Confined to the Water Supply book only — consumers, billing, inventory, collectors, approvals, complaints, reports',
    'Individual grants (checked below): post/edit/delete transactions, view reports, manage parties/accounts',
  ],
  donor_accountant: [
    'Confined to the Donors & Projects book only — donations, projects, approvals, complaints, reports',
    'Individual grants (checked below): post/edit/delete transactions, view reports, manage parties/accounts',
  ],
  publisher: [
    'Can create News posts and Videos',
    'Everything they publish is held as a draft until a Super Admin approves it',
  ],
  viewer: [
    'Read-only across both systems by default — can view and drill into everything, but never post/edit/delete a transaction',
    'Already included for every role, no extra grant needed: view + reply to Suggestions, view + post comments/status updates on any Complaint',
    'Opt-in add-on — Field Collector: collect a payment on the spot for consumers in assigned sector(s) (grant + pick sectors in the pencil-icon modal)',
    'Opt-in add-on — Complaint Verifier: final sign-off closing a resolved complaint (grant in the pencil-icon modal, not tied to role — assignable to anyone)',
  ],
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
  email: '', full_name: '', role: 'water_accountant', secondary_role: '', password: '',
  can_post_transactions: false, can_edit_transactions: false, can_delete_transactions: false,
  can_view_reports: false, can_approve_transactions: false,
  can_manage_parties: false, can_manage_accounts: false, can_edit_accounts: false, can_delete_accounts: false,
  can_restore_deleted: false, can_invite_users: false,
  access_water_supply: false, access_donors_projects: false,
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%'
  let out = ''
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

const emptyCollectorForm = { mobile: '', can_collect_payments: false, assigned_sectors: [] as string[], can_verify_complaints: false, secondary_role: '' }

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
  const [showRoleDetails, setShowRoleDetails] = useState(false)
  const [collectorForm, setCollectorForm] = useState(emptyCollectorForm)
  const [savingCollector, setSavingCollector] = useState(false)
  const [creatingDirect, setCreatingDirect] = useState(false)
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null)
  const [passwordValue, setPasswordValue] = useState('')
  const [loadingPassword, setLoadingPassword] = useState(false)
  const [revealPassword, setRevealPassword] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
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
    setCollectorForm({
      mobile: u.mobile ?? '', can_collect_payments: u.can_collect_payments, assigned_sectors: u.assigned_sectors ?? [],
      can_verify_complaints: u.can_verify_complaints, secondary_role: u.secondary_role ?? '',
    })
  }

  const toggleSector = (name: string) => {
    setCollectorForm((f) => ({
      ...f,
      assigned_sectors: f.assigned_sectors.includes(name) ? f.assigned_sectors.filter((s) => s !== name) : [...f.assigned_sectors, name],
    }))
  }

  const saveCollectorSettings = async () => {
    if (!editingUser) return
    if (collectorForm.secondary_role === editingUser.role) { toast.error('Secondary role must be different from the primary role'); return }
    if (collectorForm.secondary_role === 'super_admin' && currentRole !== 'super_admin') { toast.error('Only a Super Admin can grant Super Admin as a secondary role'); return }
    setSavingCollector(true)
    const { error } = await supabase.from('admin_users').update({
      mobile: collectorForm.mobile.trim() || null,
      can_collect_payments: collectorForm.can_collect_payments,
      assigned_sectors: collectorForm.can_collect_payments && collectorForm.assigned_sectors.length > 0 ? collectorForm.assigned_sectors : null,
      can_verify_complaints: collectorForm.can_verify_complaints,
      secondary_role: collectorForm.secondary_role || null,
    }).eq('id', editingUser.id)
    setSavingCollector(false)
    if (error) { toast.error(error.message); return }
    toast.success(`${editingUser.full_name}'s settings updated`)
    setEditingUser(null)
    load()
  }

  const permissionEligibleRoles = ['admin', 'accountant', 'water_accountant', 'donor_accountant']
  const showPermissions = permissionEligibleRoles.includes(form.role) || permissionEligibleRoles.includes(form.secondary_role)
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

  // Bridge while invite/reset-password emails aren't reaching people — creates
  // a working login immediately with a chosen password instead of an email.
  const createDirect = async () => {
    if (!form.email.trim() || !form.full_name.trim()) { toast.error('Email and full name required'); return }
    if (!form.password || form.password.length < 8) { toast.error('Password must be at least 8 characters'); return }
    setCreatingDirect(true)
    try {
      const res = await fetch('/api/admin/users/create-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Failed to create user'); setCreatingDirect(false); return }
      toast.success(`${form.full_name} can log in now with the password you set`)
      setShowForm(false)
      setForm(emptyInvite)
      load()
    } catch {
      toast.error('Network error creating user')
    }
    setCreatingDirect(false)
  }

  const openPasswordPanel = async (u: AdminUser) => {
    setPasswordTarget(u)
    setPasswordValue('')
    setRevealPassword(false)
    setLoadingPassword(true)
    const { data } = await supabase.from('admin_user_credentials').select('password').eq('admin_user_id', u.id).maybeSingle()
    setPasswordValue(data?.password ?? '')
    setLoadingPassword(false)
  }

  const savePassword = async () => {
    if (!passwordTarget) return
    if (!passwordValue || passwordValue.length < 8) { toast.error('Password must be at least 8 characters'); return }
    setSavingPassword(true)
    try {
      const res = await fetch('/api/admin/users/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminUserId: passwordTarget.id, password: passwordValue }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Failed to set password'); setSavingPassword(false); return }
      toast.success(`Password set for ${passwordTarget.full_name}`)
      setPasswordTarget(null)
    } catch {
      toast.error('Network error setting password')
    }
    setSavingPassword(false)
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
    // If their secondary role would now match the new primary role, clear it —
    // same role in both slots is redundant and just confusing to display.
    const clearingSecondary = u.secondary_role === newRole
    const { error } = await supabase.from('admin_users').update({
      role: newRole, ...(clearingSecondary ? { secondary_role: null } : {}),
    }).eq('id', u.id)
    if (error) { toast.error(error.message); load(); return }
    toast.success(`${u.full_name}'s role changed to ${roleLabels[newRole] ?? newRole}`)
    load()
  }

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">User Management</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Invite users and control exactly what they can access.</p>
        </div>
        <button onClick={() => { setForm(emptyInvite); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> Invite User
        </button>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant mb-6 overflow-hidden">
        <button
          onClick={() => setShowRoleDetails(!showRoleDetails)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 cursor-pointer hover:bg-dp-surface-container-low/50 transition-all"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-sans text-[13px] font-bold text-dp-on-surface-variant">Roles &amp; Permissions</span>
            {Object.entries(roleLabels).map(([key, label]) => (
              <span key={key} className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${roleColors[key]}`}>{label}</span>
            ))}
          </div>
          <span className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary shrink-0">
            {showRoleDetails ? <>Hide details <ChevronUp size={14} /></> : <>Show details <ChevronDown size={14} /></>}
          </span>
        </button>

        {showRoleDetails && (
          <div className="border-t border-dp-outline-variant p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {Object.entries(roleLabels).map(([key, label]) => (
                <div key={key} className="bg-dp-surface-container-low/40 rounded-lg border border-dp-outline-variant p-3.5">
                  <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${roleColors[key]}`}>{label}</span>
                  <ul className="mt-2 space-y-1">
                    {(rolePermissions[key] ?? []).map((line, i) => (
                      <li key={i} className="font-sans text-[11px] text-dp-on-surface-variant leading-[1.4] pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-dp-outline">
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="bg-dp-primary-container/40 border border-dp-primary/20 rounded-lg p-4">
              <p className="font-sans text-[13px] font-bold text-dp-primary mb-1">Setting up &quot;Management&quot; (view everything, reply, verify complaints)</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant leading-[1.5]">
                There&apos;s no separate &quot;Management&quot; role — it&apos;s a recipe: give them <strong>Viewer</strong> (full read access to both systems already, plus the ability to comment on complaints and reply to Suggestions with no extra grant), then check <strong>Complaint Verifier</strong> for them in the pencil-icon menu so they can give final sign-off on resolved complaints. If they also need to actually post transactions or approve things themselves, give them a <strong>secondary role</strong> below instead of switching their primary role away from Viewer.
              </p>
            </div>
          </div>
        )}
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
                    {u.secondary_role && (
                      <span className={`ml-1 text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans border ${roleColors[u.secondary_role] ?? 'bg-gray-100 text-gray-600'}`} title="Secondary role">
                        + {roleLabels[u.secondary_role] ?? u.secondary_role}
                      </span>
                    )}
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
                      <div className="flex items-center justify-end gap-1.5">
                        <select
                          value={u.role}
                          onChange={(e) => changeRole(u, e.target.value)}
                          title="Change role"
                          className="text-[12px] font-sans border border-dp-outline-variant rounded px-1.5 py-1 cursor-pointer bg-white"
                        >
                          {(currentRole === 'super_admin' ? availableRoles : availableRoles.filter((r) => r !== 'super_admin')).map((r) => (
                            <option key={r} value={r}>{roleLabels[r]}</option>
                          ))}
                          {u.role === 'super_admin' && !availableRoles.includes('super_admin') && (
                            <option value="super_admin">{roleLabels.super_admin}</option>
                          )}
                        </select>
                        <button onClick={() => openEditCollector(u)} title="Edit mobile number / field collector / secondary role settings" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                          <Pencil size={15} />
                        </button>
                        {currentRole === 'super_admin' && (
                          <button onClick={() => openPasswordPanel(u)} title="View / Set Password" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                            <Key size={15} />
                          </button>
                        )}
                        <button onClick={() => toggleActive(u.id, u.is_active)} title={u.is_active ? 'Deactivate' : 'Activate'} className="p-1.5 text-dp-on-surface-variant hover:text-amber-600 cursor-pointer">
                          <Power size={15} />
                        </button>
                        <button onClick={() => setConfirmRemove(u.id)} title="Delete user permanently" className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
                          <Trash2 size={15} />
                        </button>
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
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Secondary Role (optional)</label>
                <select value={form.secondary_role} onChange={(e) => setForm({ ...form, secondary_role: e.target.value })} className="input-field">
                  <option value="">None</option>
                  {availableRoles.filter((r) => r !== form.role).map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
                </select>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">Grants this role&apos;s access <em>in addition to</em> the primary role above — e.g. a Water Accountant with Donor Accountant as secondary can access both books.</p>
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
              <button disabled={inviting} onClick={sendInvite} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {inviting ? 'Sending Invite...' : 'Send Invitation'}
              </button>

              {currentRole === 'super_admin' && (
                <div className="border-t border-dp-outline-variant pt-4 mt-2">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">Or Create Directly</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">If invite/reset-password emails aren&apos;t reaching people, set a password here and give it to them yourself. Remove this once email is fixed.</p>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Password *</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder="At least 8 characters"
                      className="input-field font-mono"
                    />
                    <button type="button" onClick={() => setForm({ ...form, password: generatePassword() })} title="Generate a password" className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                      <RefreshCw size={16} />
                    </button>
                  </div>
                  <button disabled={creatingDirect} onClick={createDirect} className="w-full flex items-center justify-center gap-2 border-2 border-dp-secondary text-dp-secondary py-3 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-secondary/5 transition-all cursor-pointer disabled:opacity-50 mt-3">
                    <Key size={16} /> {creatingDirect ? 'Creating...' : 'Create Directly'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {passwordTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPasswordTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary flex items-center gap-2"><Key size={18} /> Password</h2>
              <button onClick={() => setPasswordTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{passwordTarget.full_name} · {passwordTarget.email}</p>
            {loadingPassword ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant text-center py-4">Loading...</p>
            ) : (
              <>
                {!passwordValue && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2 mb-4">
                    No password on file here (invited normally, or never reset through this page). Set one below to unblock their login.
                  </p>
                )}
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">
                  {passwordValue ? 'Password' : 'Set Password'}
                </label>
                <div className="flex gap-2">
                  <input
                    type={revealPassword ? 'text' : 'password'}
                    value={passwordValue}
                    onChange={(e) => setPasswordValue(e.target.value)}
                    placeholder="At least 8 characters"
                    className="input-field font-mono"
                  />
                  <button onClick={() => setRevealPassword(!revealPassword)} title="Show/hide" className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                    {revealPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  {passwordValue && (
                    <button onClick={() => { navigator.clipboard.writeText(passwordValue); toast.success('Copied') }} title="Copy" className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                      <Copy size={16} />
                    </button>
                  )}
                  <button onClick={() => setPasswordValue(generatePassword())} title="Generate" className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                    <RefreshCw size={16} />
                  </button>
                </div>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1.5">Editing and saving here changes their real login password immediately.</p>
                <button disabled={savingPassword} onClick={savePassword} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50 mt-4">
                  <Save size={16} /> {savingPassword ? 'Saving...' : 'Save Password'}
                </button>
              </>
            )}
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
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Secondary Role</label>
                <select value={collectorForm.secondary_role} onChange={(e) => setCollectorForm({ ...collectorForm, secondary_role: e.target.value })} className="input-field">
                  <option value="">None</option>
                  {(currentRole === 'super_admin' ? availableRoles : availableRoles.filter((r) => r !== 'super_admin'))
                    .filter((r) => r !== editingUser.role)
                    .map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
                </select>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">Grants this role&apos;s access in addition to their primary role ({roleLabels[editingUser.role]}).</p>
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
