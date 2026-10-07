'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Plus, X, UserCircle2, Copy, Eye, EyeOff, Power, CreditCard, Pencil, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { passwordMeetsPolicy, PASSWORD_REQUIREMENTS } from '@/lib/passwordPolicy'

interface TenantSummary {
  id: string; name: string; name_ur: string | null; slug: string; is_active: boolean
  admin_count: number; portal_user_count: number
  subscription_status: string | null; subscription_plan: string | null
  water_supply_enabled: boolean; donors_enabled: boolean
}

interface TenantAdmin {
  id: string; full_name: string; email: string; role: string
  secondary_role: string | null; is_active: boolean; created_at: string
}

interface Plan {
  id: string; key: string; name: string; monthly_price_pkr: number; commission_pct: number
}

interface CurrentPlanLimit {
  max_admin_users: number | null
}

function generatePassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digits = '23456789'
  const special = '!@#$%^&*'
  const all = lower + upper + digits + special
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)]
  const required = [pick(lower), pick(upper), pick(digits), pick(special)]
  const rest = Array.from({ length: 8 }, () => pick(all))
  const out = [...required, ...rest]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out.join('')
}

export default function PlatformTenantDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = createClient()

  const [tenant, setTenant] = useState<TenantSummary | null>(null)
  const [admins, setAdmins] = useState<TenantAdmin[] | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])

  const [showAddAdmin, setShowAddAdmin] = useState(false)
  const [adminForm, setAdminForm] = useState({ email: '', full_name: '', password: generatePassword() })
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)

  const [showSubscribe, setShowSubscribe] = useState(false)
  const [subscribeForm, setSubscribeForm] = useState({ plan_id: '', billing_cycle: 'monthly', trial_days: '' })
  const [subscribing, setSubscribing] = useState(false)
  const [planLimit, setPlanLimit] = useState<CurrentPlanLimit | null>(null)

  const [showEdit, setShowEdit] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', name_ur: '', slug: '' })
  const [editSaving, setEditSaving] = useState(false)

  const load = async () => {
    const [{ data: tenants, error: tenantsError }, { data: adminsData, error: adminsError }, { data: plansData }, { data: subData }] = await Promise.all([
      supabase.rpc('platform_list_tenants'),
      supabase.rpc('platform_get_tenant_admins', { p_tenant_id: id }),
      supabase.from('subscription_plans').select('id, key, name, monthly_price_pkr, commission_pct').eq('is_active', true).order('monthly_price_pkr'),
      supabase.from('tenant_subscriptions').select('plan:subscription_plans(max_admin_users)').eq('tenant_id', id).in('status', ['active', 'trialing', 'past_due']).maybeSingle(),
    ])
    if (tenantsError) toast.error(friendlyError(tenantsError))
    else setTenant(((tenants as TenantSummary[]) ?? []).find((t) => t.id === id) ?? null)

    if (adminsError) toast.error(friendlyError(adminsError))
    else setAdmins((adminsData as TenantAdmin[]) ?? [])

    setPlans((plansData as Plan[]) ?? [])
    setPlanLimit((subData as unknown as { plan: CurrentPlanLimit } | null)?.plan ?? null)
  }

  useEffect(() => { load() }, [id])

  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!adminForm.email.trim() || !adminForm.full_name.trim()) {
      toast.error('Email and full name are required.')
      return
    }
    if (!passwordMeetsPolicy(adminForm.password)) {
      toast.error('Password does not meet the requirements.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/platform/tenants/${id}/admins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: adminForm.email.trim().toLowerCase(),
          full_name: adminForm.full_name.trim(),
          password: adminForm.password,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Could not create admin.')
        return
      }
      toast.success(`Admin created. Share these credentials with ${adminForm.full_name} securely.`)
      setShowAddAdmin(false)
      setAdminForm({ email: '', full_name: '', password: generatePassword() })
      load()
    } finally {
      setSaving(false)
    }
  }

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!subscribeForm.plan_id) {
      toast.error('Choose a plan.')
      return
    }
    setSubscribing(true)
    const { error } = await supabase.rpc('platform_subscribe_tenant', {
      p_tenant_id: id,
      p_plan_id: subscribeForm.plan_id,
      p_billing_cycle: subscribeForm.billing_cycle,
      p_trial_days: subscribeForm.trial_days ? Number(subscribeForm.trial_days) : null,
    })
    setSubscribing(false)
    if (error) {
      toast.error(friendlyError(error))
      return
    }
    toast.success('Subscription updated.')
    setShowSubscribe(false)
    setSubscribeForm({ plan_id: '', billing_cycle: 'monthly', trial_days: '' })
    load()
  }

  const toggleActive = async () => {
    if (!tenant) return
    const { error } = await supabase.rpc('platform_set_tenant_active', { p_tenant_id: tenant.id, p_is_active: !tenant.is_active })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(tenant.is_active ? 'Tenant deactivated.' : 'Tenant activated.')
    load()
  }

  const openEdit = () => {
    if (!tenant) return
    setEditForm({ name: tenant.name, name_ur: tenant.name_ur ?? '', slug: tenant.slug })
    setShowEdit(true)
  }

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!tenant) return
    if (!editForm.name.trim() || !editForm.slug.trim()) {
      toast.error('Name and slug are required.')
      return
    }
    setEditSaving(true)
    const { error } = await supabase.from('tenants').update({
      name: editForm.name.trim(),
      name_ur: editForm.name_ur.trim() || null,
      slug: editForm.slug.trim().toLowerCase(),
    }).eq('id', tenant.id)
    setEditSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Tenant updated.')
    setShowEdit(false)
    load()
  }

  const toggleModule = async (field: 'water_supply_enabled' | 'donors_enabled') => {
    if (!tenant) return
    const { error } = await supabase.from('tenants').update({ [field]: !tenant[field] }).eq('id', tenant.id)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const copyCredentials = () => {
    navigator.clipboard.writeText(`Email: ${adminForm.email}\nPassword: ${adminForm.password}`)
    toast.success('Copied to clipboard.')
  }

  if (!tenant || admins === null) {
    return <div className="flex justify-center py-16"><LoadingDots /></div>
  }

  return (
    <div>
      <button onClick={() => router.push('/platform')} className="flex items-center gap-1.5 text-dp-on-surface-variant hover:text-dp-on-surface text-[13.5px] font-sans mb-4 cursor-pointer">
        <ArrowLeft size={15} /> Back to tenants
      </button>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <div>
            <h1 className="font-heading text-[26px] font-bold text-dp-on-surface">{tenant.name}</h1>
            <p className="text-dp-on-surface-variant text-[13px] font-sans mt-0.5">{tenant.slug}</p>
          </div>
          <button onClick={openEdit} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1.5" aria-label="Edit tenant">
            <Pencil size={16} />
          </button>
        </div>
        <button
          onClick={toggleActive}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13.5px] font-semibold cursor-pointer transition-all ${
            tenant.is_active ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-green-50 text-green-700 hover:bg-green-100'
          }`}
        >
          <Power size={14} /> {tenant.is_active ? 'Deactivate Tenant' : 'Activate Tenant'}
        </button>
      </div>

      {/* Modules */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-6">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface flex items-center gap-2 mb-3">
          <Settings2 size={16} /> Modules
        </h2>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">
          Live for this tenant right now — independent of its plan. Turning a module off revokes it for every admin and villager immediately.
        </p>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[14px] font-sans text-dp-on-surface cursor-pointer">
            <input type="checkbox" checked={tenant.water_supply_enabled} onChange={() => toggleModule('water_supply_enabled')} className="cursor-pointer" />
            Water Supply
          </label>
          <label className="flex items-center gap-2 text-[14px] font-sans text-dp-on-surface cursor-pointer">
            <input type="checkbox" checked={tenant.donors_enabled} onChange={() => toggleModule('donors_enabled')} className="cursor-pointer" />
            Donors & Projects
          </label>
        </div>
      </div>

      {/* Subscription */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-sans text-[15px] font-bold text-dp-on-surface flex items-center gap-2">
            <CreditCard size={16} /> Subscription
          </h2>
          <button
            onClick={() => setShowSubscribe(true)}
            className="text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer"
          >
            {tenant.subscription_plan ? 'Change plan' : 'Subscribe'}
          </button>
        </div>
        {tenant.subscription_plan ? (
          <p className="font-sans text-[14px] text-dp-on-surface">
            {tenant.subscription_plan} — <span className="text-dp-on-surface-variant">{tenant.subscription_status}</span>
          </p>
        ) : (
          <p className="font-sans text-[14px] text-dp-on-surface-variant">No active subscription.</p>
        )}
      </div>

      {/* Admins */}
      <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-dp-outline-variant">
          <div>
            <h2 className="font-sans text-[15px] font-bold text-dp-on-surface flex items-center gap-2">
              <UserCircle2 size={16} /> Admin Users ({admins.length}{planLimit?.max_admin_users ? ` / ${planLimit.max_admin_users}` : ''})
            </h2>
            {planLimit?.max_admin_users != null && admins.length >= planLimit.max_admin_users && (
              <p className="text-[12px] text-amber-700 font-sans mt-0.5">At this tenant's plan limit — deactivate one or move it to a higher plan to add more.</p>
            )}
          </div>
          <button
            onClick={() => setShowAddAdmin(true)}
            disabled={planLimit?.max_admin_users != null && admins.length >= planLimit.max_admin_users}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1f2e] text-white rounded-lg font-sans font-semibold text-[13px] hover:opacity-90 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={14} /> Add Admin
          </button>
        </div>
        {admins.length === 0 ? (
          <p className="p-5 text-dp-on-surface-variant font-sans text-[14px]">No admins yet — this tenant can't be signed into.</p>
        ) : (
          <table className="w-full text-[13.5px] font-sans">
            <thead className="bg-dp-surface-container text-dp-on-surface-variant text-left">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Email</th>
                <th className="px-4 py-2.5 font-semibold">Role</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} className="border-t border-dp-outline-variant">
                  <td className="px-4 py-2.5">{a.full_name}</td>
                  <td className="px-4 py-2.5">{a.email}</td>
                  <td className="px-4 py-2.5">{a.role}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${a.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                      {a.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add admin modal */}
      {showAddAdmin && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowAddAdmin(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-sans text-[18px] font-bold text-dp-on-surface">Add Admin — {tenant.name}</h2>
              <button onClick={() => setShowAddAdmin(false)} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><X size={20} /></button>
            </div>
            <form onSubmit={handleAddAdmin} className="space-y-4">
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Full Name</label>
                <input
                  type="text" value={adminForm.full_name}
                  onChange={(e) => setAdminForm((f) => ({ ...f, full_name: e.target.value }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Email</label>
                <input
                  type="email" value={adminForm.email}
                  onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[13px] font-semibold text-dp-on-surface-variant font-sans">Password</label>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setAdminForm((f) => ({ ...f, password: generatePassword() }))} className="text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer">Regenerate</button>
                    <button type="button" onClick={copyCredentials} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><Copy size={14} /></button>
                  </div>
                </div>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'} value={adminForm.password}
                    onChange={(e) => setAdminForm((f) => ({ ...f, password: e.target.value }))}
                    required
                    className="w-full px-3 py-2.5 pe-10 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  />
                  <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant cursor-pointer">
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <ul className="mt-2 space-y-0.5">
                  {PASSWORD_REQUIREMENTS.map((r) => (
                    <li key={r.key} className={`text-[11.5px] font-sans ${r.test(adminForm.password) ? 'text-green-700' : 'text-dp-on-surface-variant'}`}>
                      {r.test(adminForm.password) ? '✓' : '○'} {r.labelEn}
                    </li>
                  ))}
                </ul>
              </div>
              <button
                type="submit" disabled={saving}
                className="w-full bg-[#1a1f2e] text-white py-2.5 rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                {saving ? 'Creating...' : 'Create Admin'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {showEdit && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowEdit(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-sans text-[18px] font-bold text-dp-on-surface">Edit Tenant</h2>
              <button onClick={() => setShowEdit(false)} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><X size={20} /></button>
            </div>
            <form onSubmit={handleEdit} className="space-y-4">
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Committee Name</label>
                <input
                  type="text" value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Name (Urdu, optional)</label>
                <input
                  type="text" value={editForm.name_ur}
                  onChange={(e) => setEditForm((f) => ({ ...f, name_ur: e.target.value }))}
                  dir="rtl"
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Slug</label>
                <input
                  type="text" value={editForm.slug}
                  onChange={(e) => setEditForm((f) => ({ ...f, slug: e.target.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
                <p className="text-[12px] text-dp-on-surface-variant mt-1 font-sans">Public subdomain: {editForm.slug || '...'}.dhabpari.com</p>
              </div>
              <button
                type="submit" disabled={editSaving}
                className="w-full bg-[#1a1f2e] text-white py-2.5 rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                {editSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Subscribe modal */}
      {showSubscribe && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowSubscribe(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-sans text-[18px] font-bold text-dp-on-surface">Subscribe — {tenant.name}</h2>
              <button onClick={() => setShowSubscribe(false)} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><X size={20} /></button>
            </div>
            {plans.length === 0 ? (
              <p className="font-sans text-[14px] text-dp-on-surface-variant">
                No plans exist yet. <Link href="/platform/plans" className="text-dp-secondary hover:underline">Create one first</Link>.
              </p>
            ) : (
              <form onSubmit={handleSubscribe} className="space-y-4">
                <div>
                  <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Plan</label>
                  <select
                    value={subscribeForm.plan_id}
                    onChange={(e) => setSubscribeForm((f) => ({ ...f, plan_id: e.target.value }))}
                    required
                    className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  >
                    <option value="">Choose a plan</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} — Rs {p.monthly_price_pkr}/mo, {p.commission_pct}% commission</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Billing Cycle</label>
                  <select
                    value={subscribeForm.billing_cycle}
                    onChange={(e) => setSubscribeForm((f) => ({ ...f, billing_cycle: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  >
                    <option value="monthly">Monthly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Start as a trial (optional)</label>
                  <input
                    type="number" min="1" step="1" value={subscribeForm.trial_days}
                    onChange={(e) => setSubscribeForm((f) => ({ ...f, trial_days: e.target.value }))}
                    placeholder="Number of days, leave blank to bill immediately"
                    className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  />
                </div>
                <button
                  type="submit" disabled={subscribing}
                  className="w-full bg-[#1a1f2e] text-white py-2.5 rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  {subscribing ? 'Saving...' : 'Confirm Subscription'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
