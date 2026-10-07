'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, X, CreditCard, Power } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Plan {
  id: string; key: string; name: string; monthly_price_pkr: number
  commission_pct: number; max_admin_users: number | null; is_active: boolean
  includes_water_supply: boolean; includes_donors_projects: boolean
}

export default function PlatformPlansPage() {
  const supabase = createClient()
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ key: '', name: '', monthly_price_pkr: '', commission_pct: '', max_admin_users: '', includesWaterSupply: true, includesDonorsProjects: true })

  const load = async () => {
    const { data, error } = await supabase.from('subscription_plans').select('*').order('monthly_price_pkr')
    if (error) { toast.error(friendlyError(error)); return }
    setPlans((data as Plan[]) ?? [])
  }

  useEffect(() => { load() }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.key.trim() || !form.name.trim()) {
      toast.error('Key and name are required.')
      return
    }
    setSaving(true)
    const { error } = await supabase.from('subscription_plans').insert({
      key: form.key.trim(),
      name: form.name.trim(),
      monthly_price_pkr: Number(form.monthly_price_pkr) || 0,
      commission_pct: Number(form.commission_pct) || 0,
      max_admin_users: form.max_admin_users ? Number(form.max_admin_users) : null,
      includes_water_supply: form.includesWaterSupply,
      includes_donors_projects: form.includesDonorsProjects,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Plan created.')
    setShowCreate(false)
    setForm({ key: '', name: '', monthly_price_pkr: '', commission_pct: '', max_admin_users: '', includesWaterSupply: true, includesDonorsProjects: true })
    load()
  }

  const toggleActive = async (plan: Plan) => {
    const { error } = await supabase.from('subscription_plans').update({ is_active: !plan.is_active }).eq('id', plan.id)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-on-surface">Plans</h1>
          <p className="text-dp-on-surface-variant text-[13px] font-sans mt-0.5">
            The platform's own price list — subscription fee and commission rate per plan.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#1a1f2e] text-white rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 cursor-pointer"
        >
          <Plus size={16} /> New Plan
        </button>
      </div>

      {plans === null ? (
        <div className="flex justify-center py-16"><LoadingDots /></div>
      ) : plans.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <CreditCard size={28} className="mx-auto text-dp-on-surface-variant mb-3" />
          <p className="font-sans text-dp-on-surface-variant">No plans yet.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-sans font-bold text-[16px] text-dp-on-surface">{p.name}</h3>
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${p.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                  {p.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <p className="font-sans text-[13px] text-dp-on-surface-variant mb-3">{p.key}</p>
              <p className="font-sans text-[22px] font-bold text-dp-on-surface mb-1">
                Rs {Number(p.monthly_price_pkr).toLocaleString()}<span className="text-[13px] font-normal text-dp-on-surface-variant">/mo</span>
              </p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant mb-2">
                {p.commission_pct}% platform commission{p.max_admin_users ? ` · up to ${p.max_admin_users} admins` : ''}
              </p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4">
                {[p.includes_water_supply && 'Water Supply', p.includes_donors_projects && 'Donors & Projects'].filter(Boolean).join(' · ') || 'No modules included'}
              </p>
              <button
                onClick={() => toggleActive(p)}
                className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] font-semibold cursor-pointer transition-all ${
                  p.is_active ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-green-50 text-green-700 hover:bg-green-100'
                }`}
              >
                <Power size={13} /> {p.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-sans text-[18px] font-bold text-dp-on-surface">New Plan</h2>
              <button onClick={() => setShowCreate(false)} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><X size={20} /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Key</label>
                <input
                  type="text" value={form.key}
                  onChange={(e) => setForm((f) => ({ ...f, key: e.target.value.trim().toLowerCase().replace(/\s+/g, '_') }))}
                  required placeholder="starter"
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Name</label>
                <input
                  type="text" value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required placeholder="Starter"
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Monthly Price (PKR)</label>
                  <input
                    type="number" min="0" step="1" value={form.monthly_price_pkr}
                    onChange={(e) => setForm((f) => ({ ...f, monthly_price_pkr: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Commission %</label>
                  <input
                    type="number" min="0" max="100" step="0.1" value={form.commission_pct}
                    onChange={(e) => setForm((f) => ({ ...f, commission_pct: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Max Admin Users (optional)</label>
                <input
                  type="number" min="1" step="1" value={form.max_admin_users}
                  onChange={(e) => setForm((f) => ({ ...f, max_admin_users: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div className="space-y-2">
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant font-sans">Modules Included</label>
                <label className="flex items-center gap-2 text-[14px] font-sans text-dp-on-surface cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.includesWaterSupply}
                    onChange={(e) => setForm((f) => ({ ...f, includesWaterSupply: e.target.checked }))}
                    className="cursor-pointer"
                  />
                  Water Supply
                </label>
                <label className="flex items-center gap-2 text-[14px] font-sans text-dp-on-surface cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.includesDonorsProjects}
                    onChange={(e) => setForm((f) => ({ ...f, includesDonorsProjects: e.target.checked }))}
                    className="cursor-pointer"
                  />
                  Donors & Projects
                </label>
              </div>
              <button
                type="submit" disabled={saving}
                className="w-full bg-[#1a1f2e] text-white py-2.5 rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                {saving ? 'Creating...' : 'Create Plan'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
