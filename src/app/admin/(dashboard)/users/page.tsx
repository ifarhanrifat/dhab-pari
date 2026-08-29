'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Save, ShieldCheck, UserCircle2, Clock, CheckCircle2, Truck, Pencil, Trash2, Power, ChevronDown, ChevronUp, Key, Copy, Eye, EyeOff, RefreshCw, Search, GraduationCap } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ImageUpload } from '@/components/admin/ImageUpload'

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
  can_publish_news: boolean
  can_publish_videos: boolean
  can_publish_gallery: boolean
  can_publish_ticker: boolean
  can_publish_jobs: boolean
  can_publish_poetry: boolean
  can_publish_blog: boolean
  invited_at: string | null
  invite_accepted_at: string | null
  created_at: string
  mobile: string | null
  assigned_sectors: string[] | null
  can_collect_payments: boolean
  can_verify_complaints: boolean
  assigned_training_program_ids: string[] | null
  trainer_bio: string | null
  trainer_bio_ur: string | null
  trainer_photo_url: string | null
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

// Values are i18n keys (module scope has no useLocale()) — resolved via
// t() at render time.
const roleLabelKey: Record<string, string> = {
  super_admin: 'us.roleSuperAdmin',
  admin: 'us.roleAdmin',
  accountant: 'us.roleAccountant',
  water_accountant: 'us.roleWaterAccountant',
  donor_accountant: 'us.roleDonorAccountant',
  publisher: 'us.rolePublisher',
  viewer: 'us.viewer',
}

const roleDescriptionKey: Record<string, string> = {
  super_admin: 'us.descSuperAdmin',
  admin: 'us.descAdmin',
  accountant: 'us.descAccountant',
  water_accountant: 'us.descWaterAccountant',
  donor_accountant: 'us.descDonorAccountant',
  publisher: 'us.descPublisher',
  viewer: 'us.descViewer',
}

// The exact, concrete capability list per role — not just a one-line summary.
// "System access" here means the RLS boundary (the real security guarantee);
// the individual can_* flags below it are opt-in on top of that, checked
// per-person in the Permissions section (or, for viewers, in the pencil-icon
// modal), not implied automatically by picking the role.
// Values are i18n keys (module scope has no useLocale()) — resolved via
// t() at render time.
const rolePermissionKeys: Record<string, string[]> = {
  super_admin: ['us.perm.superAdmin1', 'us.perm.superAdmin2', 'us.perm.superAdmin3', 'us.perm.superAdmin4', 'us.perm.superAdmin5'],
  admin: ['us.perm.admin1', 'us.perm.admin2', 'us.perm.admin3'],
  accountant: ['us.perm.accountant1', 'us.perm.accountant2'],
  water_accountant: ['us.perm.waterAccountant1', 'us.perm.waterAccountant2'],
  donor_accountant: ['us.perm.donorAccountant1', 'us.perm.donorAccountant2'],
  publisher: ['us.perm.publisher1', 'us.perm.publisher2'],
  viewer: ['us.perm.viewer1', 'us.perm.viewer2', 'us.perm.viewer3', 'us.perm.viewer4'],
}

const permissionFields: { key: keyof AdminUser; labelKey: string }[] = [
  { key: 'can_post_transactions', labelKey: 'us.perm.canPost' },
  { key: 'can_edit_transactions', labelKey: 'us.perm.canEditTx' },
  { key: 'can_delete_transactions', labelKey: 'us.perm.canDeleteTx' },
  { key: 'can_approve_transactions', labelKey: 'us.perm.canApprove' },
  { key: 'can_view_reports', labelKey: 'us.perm.canViewReports' },
  { key: 'can_manage_parties', labelKey: 'us.perm.canManageParties' },
  { key: 'can_manage_accounts', labelKey: 'us.perm.canManageAccounts' },
  { key: 'can_edit_accounts', labelKey: 'us.perm.canEditAccounts' },
  { key: 'can_delete_accounts', labelKey: 'us.perm.canDeleteAccounts' },
]

// Each maps to one admin section and its RLS policy, so ticking a box here is
// the same grant the database enforces — not a menu-hiding convenience.
const publishFields: { key: keyof AdminUser; labelKey: string; hintKey: string }[] = [
  { key: 'can_publish_news', labelKey: 'us.pub.news', hintKey: 'us.pub.newsHint' },
  { key: 'can_publish_videos', labelKey: 'us.pub.videos', hintKey: 'us.pub.videosHint' },
  { key: 'can_publish_gallery', labelKey: 'us.pub.gallery', hintKey: 'us.pub.galleryHint' },
  { key: 'can_publish_ticker', labelKey: 'us.pub.ticker', hintKey: 'us.pub.tickerHint' },
  { key: 'can_publish_jobs', labelKey: 'us.pub.jobs', hintKey: 'us.pub.jobsHint' },
  { key: 'can_publish_poetry', labelKey: 'us.pub.poetry', hintKey: 'us.pub.poetryHint' },
  { key: 'can_publish_blog', labelKey: 'us.pub.blog', hintKey: 'us.pub.blogHint' },
]

const adminPermissionFields: { key: keyof AdminUser; labelKey: string }[] = [
  { key: 'can_restore_deleted', labelKey: 'us.perm.canRestore' },
  { key: 'can_invite_users', labelKey: 'us.perm.canInvite' },
]

const emptyInvite = {
  email: '', full_name: '', role: 'water_accountant', secondary_role: '', password: '',
  can_post_transactions: false, can_edit_transactions: false, can_delete_transactions: false,
  can_view_reports: false, can_approve_transactions: false,
  can_manage_parties: false, can_manage_accounts: false, can_edit_accounts: false, can_delete_accounts: false,
  can_restore_deleted: false, can_invite_users: false,
  access_water_supply: false, access_donors_projects: false,
  can_publish_news: false, can_publish_videos: false, can_publish_gallery: false,
  can_publish_ticker: false, can_publish_jobs: false,
  can_publish_poetry: false, can_publish_blog: false,
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%'
  let out = ''
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

const emptyCollectorForm = {
  mobile: '', can_collect_payments: false, assigned_sectors: [] as string[],
  can_verify_complaints: false, secondary_role: '',
  access_water_supply: false, access_donors_projects: false,
  can_publish_news: false, can_publish_videos: false, can_publish_gallery: false,
  can_publish_ticker: false, can_publish_jobs: false,
  can_publish_poetry: false, can_publish_blog: false,
  assigned_training_program_ids: [] as string[],
  trainer_bio: '', trainer_bio_ur: '', trainer_photo_url: '',
}

export default function AdminUsersPage() {
  const { t, isUrdu } = useLocale()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyInvite)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [currentAuthUserId, setCurrentAuthUserId] = useState<string | null>(null)
  const [currentRole, setCurrentRole] = useState<string | null>(null)
  const [sectorOptions, setSectorOptions] = useState<{ id: string; name: string }[]>([])
  const [academyOptions, setAcademyOptions] = useState<{ id: string; title: string; display_name: string | null }[]>([])
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
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(true)
  const supabase = createClient()

  // Name / email / mobile, case-insensitive. Deactivated accounts can be
  // hidden too — there are a lot of retired test logins that can't be hard
  // deleted (they hold history other tables still point at), and they were
  // burying the real staff list.
  const visibleUsers = users.filter((u) => {
    if (!showInactive && !u.is_active) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (
      u.full_name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.mobile ?? '').toLowerCase().includes(q)
    )
  })
  const hiddenCount = users.length - visibleUsers.length

  const load = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    setCurrentAuthUserId(user?.id ?? null)
    const [{ data }, { data: sectorsData }, { data: academiesData }] = await Promise.all([
      supabase.from('admin_users').select('*').order('role').order('full_name'),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
      supabase.from('projects').select('id, title, display_name').in('category', ['sports', 'training']).order('title'),
    ])
    setUsers(data ?? [])
    setSectorOptions(sectorsData ?? [])
    setAcademyOptions(academiesData ?? [])
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
      access_water_supply: u.access_water_supply, access_donors_projects: u.access_donors_projects,
      can_publish_news: u.can_publish_news, can_publish_videos: u.can_publish_videos,
      can_publish_gallery: u.can_publish_gallery, can_publish_ticker: u.can_publish_ticker,
      can_publish_jobs: u.can_publish_jobs,
      can_publish_poetry: u.can_publish_poetry, can_publish_blog: u.can_publish_blog,
      assigned_training_program_ids: u.assigned_training_program_ids ?? [],
      trainer_bio: u.trainer_bio ?? '', trainer_bio_ur: u.trainer_bio_ur ?? '', trainer_photo_url: u.trainer_photo_url ?? '',
    })
  }

  const toggleSector = (name: string) => {
    setCollectorForm((f) => ({
      ...f,
      assigned_sectors: f.assigned_sectors.includes(name) ? f.assigned_sectors.filter((s) => s !== name) : [...f.assigned_sectors, name],
    }))
  }

  const toggleAcademy = (id: string) => {
    setCollectorForm((f) => ({
      ...f,
      assigned_training_program_ids: f.assigned_training_program_ids.includes(id)
        ? f.assigned_training_program_ids.filter((a) => a !== id) : [...f.assigned_training_program_ids, id],
    }))
  }

  const saveCollectorSettings = async () => {
    if (!editingUser) return
    if (collectorForm.secondary_role === editingUser.role) { toast.error(t('us.secondaryRoleDiffer')); return }
    if (collectorForm.secondary_role === 'super_admin' && currentRole !== 'super_admin') { toast.error(t('us.onlySuperAdminGrant')); return }
    setSavingCollector(true)
    const { error } = await supabase.from('admin_users').update({
      mobile: collectorForm.mobile.trim() || null,
      can_collect_payments: collectorForm.can_collect_payments,
      assigned_sectors: collectorForm.can_collect_payments && collectorForm.assigned_sectors.length > 0 ? collectorForm.assigned_sectors : null,
      assigned_training_program_ids: collectorForm.can_collect_payments && collectorForm.assigned_training_program_ids.length > 0 ? collectorForm.assigned_training_program_ids : null,
      trainer_bio: collectorForm.trainer_bio.trim() || null,
      trainer_bio_ur: collectorForm.trainer_bio_ur.trim() || null,
      trainer_photo_url: collectorForm.trainer_photo_url.trim() || null,
      can_verify_complaints: collectorForm.can_verify_complaints,
      secondary_role: collectorForm.secondary_role || null,
      access_water_supply: collectorForm.access_water_supply,
      access_donors_projects: collectorForm.access_donors_projects,
      can_publish_news: collectorForm.can_publish_news,
      can_publish_videos: collectorForm.can_publish_videos,
      can_publish_gallery: collectorForm.can_publish_gallery,
      can_publish_ticker: collectorForm.can_publish_ticker,
      can_publish_jobs: collectorForm.can_publish_jobs,
      can_publish_poetry: collectorForm.can_publish_poetry,
      can_publish_blog: collectorForm.can_publish_blog,
    }).eq('id', editingUser.id)
    setSavingCollector(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`${editingUser.full_name}${t('us.settingsUpdatedSuffix')}`)
    setEditingUser(null)
    load()
  }

  const permissionEligibleRoles = ['admin', 'accountant', 'water_accountant', 'donor_accountant']
  const showPermissions = permissionEligibleRoles.includes(form.role) || permissionEligibleRoles.includes(form.secondary_role)
  const availableRoles = currentRole === 'super_admin'
    ? ['water_accountant', 'donor_accountant', 'accountant', 'viewer', 'publisher', 'admin', 'super_admin']
    : ['water_accountant', 'donor_accountant', 'accountant', 'viewer', 'publisher', 'admin']

  const sendInvite = async () => {
    if (!form.email.trim() || !form.full_name.trim()) { toast.error(t('us.emailNameRequired')); return }
    setInviting(true)
    try {
      const res = await fetch('/api/admin/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || t('us.failedSendInvite')); setInviting(false); return }
      toast.success(`${t('us.invitationSentPrefix')} ${form.email}`)
      setShowForm(false)
      setForm(emptyInvite)
      load()
    } catch {
      toast.error(t('us.networkErrorInvite'))
    }
    setInviting(false)
  }

  // Bridge while invite/reset-password emails aren't reaching people — creates
  // a working login immediately with a chosen password instead of an email.
  const createDirect = async () => {
    if (!form.email.trim() || !form.full_name.trim()) { toast.error(t('us.emailNameRequired')); return }
    if (!form.password || form.password.length < 8) { toast.error(t('us.passwordMinLength')); return }
    setCreatingDirect(true)
    try {
      const res = await fetch('/api/admin/users/create-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || t('us.failedCreateUser')); setCreatingDirect(false); return }
      toast.success(`${form.full_name} ${t('us.canLoginNowSuffix')}`)
      setShowForm(false)
      setForm(emptyInvite)
      load()
    } catch {
      toast.error(t('us.networkErrorCreate'))
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
    if (!passwordValue || passwordValue.length < 8) { toast.error(t('us.passwordMinLength')); return }
    setSavingPassword(true)
    try {
      const res = await fetch('/api/admin/users/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminUserId: passwordTarget.id, password: passwordValue }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || t('us.failedSetPassword')); setSavingPassword(false); return }
      toast.success(`${t('us.passwordSetForPrefix')} ${passwordTarget.full_name}`)
      setPasswordTarget(null)
    } catch {
      toast.error(t('us.networkErrorPassword'))
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
      if (!res.ok) { toast.error(data.error || t('us.failedRemoveUser')); setConfirmRemove(null); return }
      toast.success(t('us.userRemoved'))
    } catch {
      toast.error(t('us.networkErrorRemove'))
    }
    setConfirmRemove(null)
    load()
  }

  const toggleActive = async (id: string, current: boolean) => {
    await supabase.from('admin_users').update({ is_active: !current }).eq('id', id)
    toast.success(current ? t('us.userDeactivated') : t('us.userActivated'))
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
    if (error) { toast.error(friendlyError(error)); load(); return }
    toast.success(`${u.full_name}${t('us.roleChangedTo')} ${t(roleLabelKey[newRole] ?? newRole, newRole)}`)
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('us.title')}</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('z.usersBlurb')}</p>
        </div>
        <button onClick={() => { setForm(emptyInvite); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={16} /> {t('us.inviteUser')}
        </button>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant mb-6 overflow-hidden">
        <button
          onClick={() => setShowRoleDetails(!showRoleDetails)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 cursor-pointer hover:bg-dp-surface-container-low/50 transition-all"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-sans text-[13px] font-bold text-dp-on-surface-variant">{t('us.rolesPermissions')}</span>
            {Object.entries(roleLabelKey).map(([key, labelKey]) => (
              <span key={key} className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${roleColors[key]}`}>{t(labelKey)}</span>
            ))}
          </div>
          <span className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary shrink-0">
            {showRoleDetails ? <>{t('us.hideDetails')} <ChevronUp size={14} /></> : <>{t('us.showDetails')} <ChevronDown size={14} /></>}
          </span>
        </button>

        {showRoleDetails && (
          <div className="border-t border-dp-outline-variant p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {Object.entries(roleLabelKey).map(([key, labelKey]) => (
                <div key={key} className="bg-dp-surface-container-low/40 rounded-lg border border-dp-outline-variant p-3.5">
                  <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans ${roleColors[key]}`}>{t(labelKey)}</span>
                  <ul className="mt-2 space-y-1">
                    {(rolePermissionKeys[key] ?? []).map((lineKey, i) => (
                      <li key={i} className="font-sans text-[11px] text-dp-on-surface-variant leading-[1.4] ps-3 relative before:content-['•'] before:absolute before:left-0 before:text-dp-outline">
                        {t(lineKey)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="bg-dp-primary-container/40 border border-dp-primary/20 rounded-lg p-4">
              <p className="font-sans text-[13px] font-bold text-dp-primary mb-1">{t('us.managementSetupTitle')}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant leading-[1.5]">
                {t('us.managementSetupBefore')} <strong>{t('us.viewer')}</strong> {t('us.managementSetupMid1')} <strong>{t('us.complaintVerifier')}</strong> {t('us.managementSetupMid2')} <strong>{t('us.secondaryRole')}</strong> {t('us.managementSetupAfter')}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-3 mb-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('us.searchPlaceholder')}
            className="filter-field !ps-9"
          />
          {search && (
            <button onClick={() => setSearch('')} aria-label={t('us.clearSearch')} className="absolute end-2.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer">
              <X size={15} />
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-dp-secondary" />
          <span className="font-sans text-[13px] text-dp-on-surface-variant">{t('us.showDeactivated')}</span>
        </label>
        <span className="font-sans text-[12.5px] text-dp-on-surface-variant shrink-0">
          {visibleUsers.length} {t('us.ofPrefix')} {users.length}{hiddenCount > 0 ? ` · ${hiddenCount} ${t('us.hiddenSuffix')}` : ''}
        </span>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead>
              <tr className="bg-dp-surface-container-low text-dp-outline text-[13px] font-sans font-bold tracking-[0.05em]">
                <th className="p-4">{t('a.name')}</th>
                <th className="p-4">{t('a.email')}</th>
                <th className="p-4">{t('us.role')}</th>
                <th className="p-4">{t('us.inviteStatus')}</th>
                <th className="p-4">{t('w.status')}</th>
                <th className="p-4 text-end">{t('a.actions')}</th>
              </tr>
            </thead>
            <tbody className="font-sans text-[14px]">
              {loading && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">{t('action.loading')}</td></tr>}
              {!loading && visibleUsers.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center">
                  <UserCircle2 size={40} className="text-dp-on-surface-variant mx-auto mb-3 opacity-40" />
                  <p className="font-sans text-[16px] text-dp-on-surface-variant">{t('us.noUsers')}</p>
                </td></tr>
              )}
              {!loading && visibleUsers.map((u, i) => (
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
                      {t(roleLabelKey[u.role] ?? u.role, u.role)}
                    </span>
                    {u.secondary_role && (
                      <span className={`ms-1 text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full font-sans border ${roleColors[u.secondary_role] ?? 'bg-gray-100 text-gray-600'}`} title={t('us.secondaryRoleTitle')}>
                        + {t(roleLabelKey[u.secondary_role] ?? u.secondary_role, u.secondary_role)}
                      </span>
                    )}
                    {u.can_collect_payments && (u.assigned_sectors?.length ?? 0) > 0 && (
                      <span className="ms-1.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-teal-700 bg-teal-100 px-1.5 py-0.5 rounded-full" title={`${t('us.fieldCollectorTitlePrefix')} ${(u.assigned_sectors ?? []).join(', ') || t('us.noSectorsAssigned')}`}>
                        <Truck size={10} /> {t('a.collector')}
                      </span>
                    )}
                    {u.can_collect_payments && (u.assigned_training_program_ids?.length ?? 0) > 0 && (
                      <span className="ms-1.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-teal-700 bg-teal-100 px-1.5 py-0.5 rounded-full" title={t('us.trainerTitlePrefix')}>
                        <GraduationCap size={10} /> {t('us.trainer')}
                      </span>
                    )}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    {!u.invited_at ? (
                      <span className="text-[11px] text-dp-on-surface-variant">—</span>
                    ) : u.invite_accepted_at ? (
                      <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-700"><CheckCircle2 size={12} /> {t('us.accepted')}</span>
                    ) : (
                      <span className="flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock size={12} /> {t('tx.pending')}</span>
                    )}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {u.is_active ? t('g.active') : t('g.inactive')}
                    </span>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant text-end">
                    {u.auth_user_id === currentAuthUserId ? (
                      <span className="text-[11px] text-dp-on-surface-variant italic">{t('us.thisIsYou')}</span>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <select
                          value={u.role}
                          onChange={(e) => changeRole(u, e.target.value)}
                          title={t('us.changeRoleTitle')}
                          className="text-[12px] font-sans border border-dp-outline-variant rounded px-1.5 py-1 cursor-pointer bg-white"
                        >
                          {(currentRole === 'super_admin' ? availableRoles : availableRoles.filter((r) => r !== 'super_admin')).map((r) => (
                            <option key={r} value={r}>{t(roleLabelKey[r])}</option>
                          ))}
                          {u.role === 'super_admin' && !availableRoles.includes('super_admin') && (
                            <option value="super_admin">{t(roleLabelKey.super_admin)}</option>
                          )}
                        </select>
                        <button onClick={() => openEditCollector(u)} title={t('us.editCollectorTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                          <Pencil size={15} />
                        </button>
                        {currentRole === 'super_admin' && (
                          <button onClick={() => openPasswordPanel(u)} title={t('us.viewSetPasswordTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                            <Key size={15} />
                          </button>
                        )}
                        <button onClick={() => toggleActive(u.id, u.is_active)} title={u.is_active ? t('em.deactivateTitle') : t('em.activateTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-amber-600 cursor-pointer">
                          <Power size={15} />
                        </button>
                        <button onClick={() => setConfirmRemove(u.id)} title={t('us.deleteUserTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
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
        title={t('us.removeUserTitle')}
        message={t('us.removeUserMessage')}
        onConfirm={removeUser}
        onCancel={() => setConfirmRemove(null)}
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[24px] font-bold text-dp-primary">{t('us.inviteUser')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('g.fullNameReq')}</label>
                <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.emailReq')}</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t('us.emailPlaceholder')} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('z.roleReq')}</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="input-field">
                  {availableRoles.map((r) => <option key={r} value={r}>{t(roleLabelKey[r])}</option>)}
                </select>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{t(roleDescriptionKey[form.role])}</p>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('g.secondaryOptional')}</label>
                <select value={form.secondary_role} onChange={(e) => setForm({ ...form, secondary_role: e.target.value })} className="input-field">
                  <option value="">{t('us.none')}</option>
                  {availableRoles.filter((r) => r !== form.role).map((r) => <option key={r} value={r}>{t(roleLabelKey[r])}</option>)}
                </select>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{t('us.grantsAccess')} <em>{t('us.grantsAccessInAddition')}</em> {t('us.grantsAccessExample')}</p>
              </div>
              {/* Which books, asked for every role rather than only for
                  'accountant'. That restriction is why "a viewer for the water
                  accounts only" or "a collector for donations only" could not be
                  expressed — a viewer always saw both sets. Full administrators
                  are not scoped; scoping them would lock the only people who can
                  undo a scoping mistake out of undoing it. */}
              {form.role !== 'super_admin' && form.role !== 'admin' && (
                <div className="bg-dp-surface-container-low rounded-lg p-4 space-y-2.5">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">{t('us.whichBooks')}</p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.access_water_supply} onChange={(e) => setForm({ ...form, access_water_supply: e.target.checked })} className="accent-dp-secondary" />
                    <span className="font-sans text-[13.5px]">{t('a.waterSupplySystem')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.access_donors_projects} onChange={(e) => setForm({ ...form, access_donors_projects: e.target.checked })} className="accent-dp-secondary" />
                    <span className="font-sans text-[13.5px]">{t('ac.donorsSystem')}</span>
                  </label>
                  {!form.access_water_supply && !form.access_donors_projects && form.role !== 'publisher' && (
                    <p className="font-sans text-[12px] text-dp-error bg-dp-error/5 border border-dp-error/30 rounded px-2.5 py-2 mt-1">
                      {t('us.neitherTickedWarning')}
                    </p>
                  )}
                </div>
              )}

              {/* Publishing areas. One publisher writes the news, another keeps
                  the gallery — each sees only their own section, and the same
                  grant is what the database checks on write. */}
              {(form.role === 'publisher' || form.secondary_role === 'publisher') && (
                <div className="bg-dp-surface-container-low rounded-lg p-4 space-y-2.5">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">{t('us.whatPublish')}</p>
                  {publishFields.map((f) => (
                    <label key={f.key} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!form[f.key as keyof typeof form]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                        className="accent-dp-secondary mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block font-sans text-[13.5px]">{t(f.labelKey)}</span>
                        <span className="block font-sans text-[11.5px] text-dp-on-surface-variant">{t(f.hintKey)}</span>
                      </span>
                    </label>
                  ))}
                  {publishFields.every((f) => !form[f.key as keyof typeof form]) && (
                    <p className="font-sans text-[12px] text-dp-error bg-dp-error/5 border border-dp-error/30 rounded px-2.5 py-2 mt-1">
                      {t('us.noAreasTickedWarning')}
                    </p>
                  )}
                </div>
              )}
              {showPermissions && (
                <div className="bg-dp-surface-container-low rounded-lg p-4 space-y-2.5">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">{t('us.permissions')}</p>
                  {permissionFields.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!form[f.key as keyof typeof form]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                        className="accent-dp-secondary"
                      />
                      <span className="font-sans text-[13.5px]">{t(f.labelKey)}</span>
                    </label>
                  ))}
                </div>
              )}
              {form.role === 'admin' && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 space-y-2.5">
                  <p className="font-sans text-[13px] font-bold text-indigo-900 uppercase tracking-[0.05em] mb-1">{t('us.adminCapabilities')}</p>
                  {adminPermissionFields.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!form[f.key as keyof typeof form]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                        className="accent-indigo-600"
                      />
                      <span className="font-sans text-[13.5px] text-indigo-900">{t(f.labelKey)}</span>
                    </label>
                  ))}
                </div>
              )}
              {form.role === 'publisher' && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-2">
                  <ShieldCheck size={16} className="text-amber-700 shrink-0 mt-0.5" />
                  <p className="font-sans text-[13px] text-amber-800">{t('z.publisherAppearAs')} <strong>{t('y.draft')}</strong> {t('us.draftsApprovalNote')}</p>
                </div>
              )}
              <button disabled={inviting} onClick={sendInvite} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {inviting ? t('us.sendingInvite') : t('us.sendInvitation')}
              </button>

              {currentRole === 'super_admin' && (
                <div className="border-t border-dp-outline-variant pt-4 mt-2">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">{t('us.orCreateDirectly')}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">{t('us.emailFixNote')}</p>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('g.passwordReq')}</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder={t('us.atLeast8Chars')}
                      className="input-field font-mono"
                    />
                    <button type="button" onClick={() => setForm({ ...form, password: generatePassword() })} title={t('us.generatePasswordTitle')} className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                      <RefreshCw size={16} />
                    </button>
                  </div>
                  <button disabled={creatingDirect} onClick={createDirect} className="w-full flex items-center justify-center gap-2 border-2 border-dp-secondary text-dp-secondary py-3 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-secondary/5 transition-all cursor-pointer disabled:opacity-50 mt-3">
                    <Key size={16} /> {creatingDirect ? t('us.creating') : t('us.createDirectly')}
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
              <h2 className="font-heading text-[20px] font-bold text-dp-primary flex items-center gap-2"><Key size={18} /> {t('w.password')}</h2>
              <button onClick={() => setPasswordTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{passwordTarget.full_name} · {passwordTarget.email}</p>
            {loadingPassword ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant text-center py-4">{t('action.loading')}</p>
            ) : (
              <>
                {!passwordValue && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2 mb-4">
                    {t('us.noPasswordOnFile')}
                  </p>
                )}
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">
                  {passwordValue ? t('us.passwordLabel') : t('us.setPasswordLabel')}
                </label>
                <div className="flex gap-2">
                  <input
                    type={revealPassword ? 'text' : 'password'}
                    value={passwordValue}
                    onChange={(e) => setPasswordValue(e.target.value)}
                    placeholder={t('us.atLeast8Chars')}
                    className="input-field font-mono"
                  />
                  <button onClick={() => setRevealPassword(!revealPassword)} title={t('us.showHideTitle')} className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                    {revealPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  {passwordValue && (
                    <button onClick={() => { navigator.clipboard.writeText(passwordValue); toast.success(t('us.copied')) }} title={t('us.copyTitle')} className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                      <Copy size={16} />
                    </button>
                  )}
                  <button onClick={() => setPasswordValue(generatePassword())} title={t('us.generateTitle')} className="px-3 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer shrink-0">
                    <RefreshCw size={16} />
                  </button>
                </div>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1.5">{t('us.editPasswordWarning')}</p>
                <button disabled={savingPassword} onClick={savePassword} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50 mt-4">
                  <Save size={16} /> {savingPassword ? t('em.saving') : t('us.savePasswordBtn')}
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
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('us.mobileNumber')}</label>
                <input
                  value={collectorForm.mobile}
                  onChange={(e) => setCollectorForm({ ...collectorForm, mobile: e.target.value })}
                  placeholder="0300-1234567"
                  className="input-field"
                />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('us.mobileWhatsappNote')}</p>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('us.secondaryRole')}</label>
                <select value={collectorForm.secondary_role} onChange={(e) => setCollectorForm({ ...collectorForm, secondary_role: e.target.value })} className="input-field">
                  <option value="">{t('us.none')}</option>
                  {(currentRole === 'super_admin' ? availableRoles : availableRoles.filter((r) => r !== 'super_admin'))
                    .filter((r) => r !== editingUser.role)
                    .map((r) => <option key={r} value={r}>{t(roleLabelKey[r])}</option>)}
                </select>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('us.grantsRoleAccessPrefix')} ({t(roleLabelKey[editingUser.role])}).</p>
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
                    <span className="font-sans text-[13.5px] font-semibold text-teal-900 flex items-center gap-1.5"><Truck size={14} /> {t('z.collectorBlurb')}</span>
                  </label>
                  {collectorForm.can_collect_payments && (
                    <div>
                      <p className="font-sans text-[12.5px] font-semibold text-teal-900 mb-1.5">{t('us.assignedSectors')}</p>
                      {sectorOptions.length === 0 ? (
                        <p className="font-sans text-[12px] text-teal-800">{t('z.noSectorsDefined')}</p>
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
                      <p className="font-sans text-[11.5px] text-teal-800 mt-1.5">{t('us.collectorSectorRestriction')}</p>
                    </div>
                  )}
                  {collectorForm.can_collect_payments && (
                    <div className="border-t border-teal-200 pt-3">
                      <p className="font-sans text-[12.5px] font-semibold text-teal-900 mb-1.5 flex items-center gap-1.5"><GraduationCap size={13} /> {t('us.assignedAcademies')}</p>
                      {academyOptions.length === 0 ? (
                        <p className="font-sans text-[12px] text-teal-800">{t('us.noAcademiesDefined')}</p>
                      ) : (
                        <div className="grid grid-cols-1 gap-1.5 max-h-40 overflow-y-auto">
                          {academyOptions.map((a) => (
                            <label key={a.id} className="flex items-center gap-1.5 cursor-pointer">
                              <input type="checkbox" checked={collectorForm.assigned_training_program_ids.includes(a.id)} onChange={() => toggleAcademy(a.id)} className="accent-teal-700" />
                              <span className="font-sans text-[12.5px] text-teal-900">{a.display_name || a.title}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <p className="font-sans text-[11.5px] text-teal-800 mt-1.5">{t('us.trainerAcademyRestriction')}</p>

                      {collectorForm.assigned_training_program_ids.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-teal-200 space-y-2.5">
                          <p className="font-sans text-[12.5px] font-semibold text-teal-900">{t('us.trainerPublicProfile')}</p>
                          <ImageUpload bucket="images" currentUrl={collectorForm.trainer_photo_url} onUpload={(url) => setCollectorForm({ ...collectorForm, trainer_photo_url: url })} label={t('us.trainerPhoto')} />
                          <div>
                            <label className="block font-sans text-[12px] font-semibold text-teal-900 mb-1">{t('us.trainerBioEn')}</label>
                            <textarea value={collectorForm.trainer_bio} onChange={(e) => setCollectorForm({ ...collectorForm, trainer_bio: e.target.value })} rows={2} className="input-field" />
                          </div>
                          <div>
                            <label className="block font-sans text-[12px] font-semibold text-teal-900 mb-1">{t('us.trainerBioUr')}</label>
                            <textarea value={collectorForm.trainer_bio_ur} onChange={(e) => setCollectorForm({ ...collectorForm, trainer_bio_ur: e.target.value })} rows={2} dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }} className="input-field" />
                          </div>
                          <p className="font-sans text-[11.5px] text-teal-800">{t('us.trainerProfileHint')}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                {/* Which books, for a user who already exists. Previously only
                    settable at invite time, so correcting somebody's access meant
                    deleting and recreating them. */}
                {editingUser.role !== 'super_admin' && editingUser.role !== 'admin' && (
                  <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-2 mb-3">
                    <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('us.whichBooks')}</p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={collectorForm.access_water_supply} onChange={(e) => setCollectorForm({ ...collectorForm, access_water_supply: e.target.checked })} className="accent-dp-secondary" />
                      <span className="font-sans text-[13.5px]">{t('a.waterSupply')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={collectorForm.access_donors_projects} onChange={(e) => setCollectorForm({ ...collectorForm, access_donors_projects: e.target.checked })} className="accent-dp-secondary" />
                      <span className="font-sans text-[13.5px]">{t('a.donorsProjects')}</span>
                    </label>
                  </div>
                )}

                {(editingUser.role === 'publisher' || collectorForm.secondary_role === 'publisher') && (
                  <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-2 mb-3">
                    <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('us.whatPublish')}</p>
                    {publishFields.map((f) => (
                      <label key={f.key} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={!!collectorForm[f.key as keyof typeof collectorForm]} onChange={(e) => setCollectorForm({ ...collectorForm, [f.key]: e.target.checked })} className="accent-dp-secondary" />
                        <span className="font-sans text-[13.5px]">{t(f.labelKey)}</span>
                      </label>
                    ))}
                  </div>
                )}

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={collectorForm.can_verify_complaints}
                    onChange={(e) => setCollectorForm({ ...collectorForm, can_verify_complaints: e.target.checked })}
                    className="accent-indigo-600"
                  />
                  <span className="font-sans text-[13.5px] font-semibold text-indigo-900 flex items-center gap-1.5"><ShieldCheck size={14} /> {t('z.verifierBlurb')}</span>
                </label>
                <p className="font-sans text-[11.5px] text-indigo-800 mt-1.5">{t('us.verifierNotTiedNote')}</p>
              </div>
              <button disabled={savingCollector} onClick={saveCollectorSettings} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {savingCollector ? t('em.saving') : t('g.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
