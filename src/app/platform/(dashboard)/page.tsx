'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Plus, X, Building2, Users, UserCircle2, ChevronRight, Power } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Tenant {
  id: string
  name: string
  name_ur: string | null
  slug: string
  is_active: boolean
  water_supply_enabled: boolean
  donors_enabled: boolean
  created_at: string
  admin_count: number
  portal_user_count: number
  subscription_status: string | null
  subscription_plan: string | null
}

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  trialing: 'bg-blue-100 text-blue-800',
  past_due: 'bg-amber-100 text-amber-800',
  cancelled: 'bg-gray-100 text-gray-600',
}

export default function PlatformTenantsPage() {
  const supabase = createClient()
  const [tenants, setTenants] = useState<Tenant[] | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ name: '', name_ur: '', slug: '' })

  const load = async () => {
    const { data, error } = await supabase.rpc('platform_list_tenants')
    if (error) {
      toast.error(friendlyError(error))
      return
    }
    setTenants((data as Tenant[]) ?? [])
  }

  useEffect(() => { load() }, [])

  const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.slug.trim()) {
      toast.error('Name and slug are required.')
      return
    }
    setSaving(true)
    const { error } = await supabase.rpc('platform_create_tenant', {
      p_name: form.name.trim(),
      p_slug: form.slug.trim(),
      p_name_ur: form.name_ur.trim() || null,
    })
    setSaving(false)
    if (error) {
      toast.error(friendlyError(error))
      return
    }
    toast.success('Tenant created.')
    setShowCreate(false)
    setForm({ name: '', name_ur: '', slug: '' })
    load()
  }

  const toggleActive = async (tenant: Tenant) => {
    const { error } = await supabase.rpc('platform_set_tenant_active', {
      p_tenant_id: tenant.id,
      p_is_active: !tenant.is_active,
    })
    if (error) {
      toast.error(friendlyError(error))
      return
    }
    toast.success(tenant.is_active ? 'Tenant deactivated.' : 'Tenant activated.')
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-on-surface">Tenants</h1>
          <p className="text-dp-on-surface-variant text-[13px] font-sans mt-0.5">
            Every village committee running on this platform.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#1a1f2e] text-white rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 transition-all cursor-pointer"
        >
          <Plus size={16} /> New Tenant
        </button>
      </div>

      {tenants === null ? (
        <div className="flex justify-center py-16"><LoadingDots /></div>
      ) : tenants.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <Building2 size={28} className="mx-auto text-dp-on-surface-variant mb-3" />
          <p className="font-sans text-dp-on-surface-variant">No tenants yet.</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
          <table className="w-full text-[13.5px] font-sans">
            <thead className="bg-dp-surface-container text-dp-on-surface-variant text-left">
              <tr>
                <th className="px-4 py-3 font-semibold">Tenant</th>
                <th className="px-4 py-3 font-semibold">Admins</th>
                <th className="px-4 py-3 font-semibold">Portal Users</th>
                <th className="px-4 py-3 font-semibold">Subscription</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-t border-dp-outline-variant hover:bg-dp-surface-container/50">
                  <td className="px-4 py-3">
                    <Link href={`/platform/tenants/${t.id}`} className="flex items-center gap-2 font-semibold text-dp-on-surface hover:text-dp-secondary">
                      {t.name}
                      <ChevronRight size={14} className="text-dp-on-surface-variant" />
                    </Link>
                    <p className="text-dp-on-surface-variant text-[12px]">{t.slug}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5"><UserCircle2 size={14} className="text-dp-on-surface-variant" /> {t.admin_count}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5"><Users size={14} className="text-dp-on-surface-variant" /> {t.portal_user_count}</span>
                  </td>
                  <td className="px-4 py-3">
                    {t.subscription_plan ?? <span className="text-dp-on-surface-variant">No plan</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className={`inline-block w-fit px-2 py-0.5 rounded-full text-[11px] font-bold ${t.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                        {t.is_active ? 'Active' : 'Inactive'}
                      </span>
                      {t.subscription_status && (
                        <span className={`inline-block w-fit px-2 py-0.5 rounded-full text-[11px] font-bold ${statusColors[t.subscription_status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {t.subscription_status}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => toggleActive(t)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold cursor-pointer transition-all ${
                        t.is_active ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-green-50 text-green-700 hover:bg-green-100'
                      }`}
                    >
                      <Power size={13} /> {t.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-sans text-[18px] font-bold text-dp-on-surface">New Tenant</h2>
              <button onClick={() => setShowCreate(false)} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Committee Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, slug: f.slug || slugify(e.target.value) }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  placeholder="e.g. Chak 123 Welfare Committee"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Name (Urdu, optional)</label>
                <input
                  type="text"
                  value={form.name_ur}
                  onChange={(e) => setForm((f) => ({ ...f, name_ur: e.target.value }))}
                  dir="rtl"
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Slug</label>
                <input
                  type="text"
                  value={form.slug}
                  onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  placeholder="chak-123"
                />
              </div>
              <button
                type="submit"
                disabled={saving}
                className="w-full bg-[#1a1f2e] text-white py-2.5 rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                {saving ? 'Creating...' : 'Create Tenant'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
