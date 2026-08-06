'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Droplet } from 'lucide-react'

interface BloodDonor {
  id: string; blood_group: string; is_available: boolean; sector: string | null
  full_name: string; mobile: string; whatsapp_number: string | null; updated_at: string
}

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

export default function AdminBloodDonorsPage() {
  const [donors, setDonors] = useState<BloodDonor[]>([])
  const [loading, setLoading] = useState(true)
  const [groupFilter, setGroupFilter] = useState('')
  const [availableOnly, setAvailableOnly] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    supabase.rpc('search_blood_donors').then(({ data }) => { setDonors(data ?? []); setLoading(false) })
  }, [])

  const filtered = useMemo(() => {
    return donors.filter((d) => (!groupFilter || d.blood_group === groupFilter) && (!availableOnly || d.is_available))
  }, [donors, groupFilter, availableOnly])

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><Droplet size={26} className="text-dp-error" /> Blood Donors</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">Registered by portal users. Contact info shown here is staff-only — never public.</p>
      </div>

      <div className="flex flex-wrap gap-3 mb-5">
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="input-field w-auto">
          <option value="">All Blood Groups</option>
          {GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <label className="flex items-center gap-2 cursor-pointer font-sans text-[14px]">
          <input type="checkbox" checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} className="accent-dp-secondary" />
          Available only
        </label>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
              <th className="p-4">Name</th><th className="p-4">Group</th><th className="p-4">Sector</th><th className="p-4">Mobile</th><th className="p-4">WhatsApp</th><th className="p-4">Status</th>
            </tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && filtered.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">No matching blood donors.</td></tr>}
              {!loading && filtered.map((d, i) => (
                <tr key={d.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant font-semibold">{d.full_name}</td>
                  <td className="p-4 border-b border-dp-outline-variant"><span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full text-[12px] font-bold">{d.blood_group}</span></td>
                  <td className="p-4 border-b border-dp-outline-variant text-dp-on-surface-variant">{d.sector ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant">{d.mobile}</td>
                  <td className="p-4 border-b border-dp-outline-variant">{d.whatsapp_number ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${d.is_available ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>{d.is_available ? 'Available' : 'Unavailable'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
