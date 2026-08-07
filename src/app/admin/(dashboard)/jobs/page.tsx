'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Briefcase, Power } from 'lucide-react'

interface Listing {
  id: string; category: string; headline: string; description: string | null; sector: string | null
  contact_name: string; contact_mobile: string; contact_whatsapp: string | null; is_active: boolean; created_at: string
}

const CATEGORIES = ['plumber', 'electrician', 'mason', 'carpenter', 'painter', 'laborer', 'driver', 'tailor', 'cook', 'tutor', 'mechanic', 'other']

// Committee-wide moderation lever, mirroring /admin/blood-donors — not
// system-scoped (job_listings_staff_read/moderate gate on "any active staff
// member", same as blood_donors). Listings go live the moment a portal user
// posts them (no pre-approval queue, low friction by design); this page is
// how staff take one down if something inappropriate slips through.
export default function AdminJobsPage() {
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('job_listings').select('*').order('created_at', { ascending: false })
    setListings(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    return listings.filter((l) => (!category || l.category === category) && (!activeOnly || l.is_active))
  }, [listings, category, activeOnly])

  const toggleActive = async (l: Listing) => {
    const { error } = await supabase.from('job_listings').update({ is_active: !l.is_active }).eq('id', l.id)
    if (error) { toast.error(error.message); return }
    toast.success(l.is_active ? 'Listing deactivated' : 'Listing reactivated')
    load()
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><Briefcase size={26} className="text-dp-secondary" /> Job Listings</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">Public village job board — deactivate a listing here if it needs to come down.</p>
      </div>

      <div className="flex flex-wrap gap-3 mb-5">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field w-auto">
          <option value="">All Categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
        </select>
        <label className="flex items-center gap-2 cursor-pointer font-sans text-[14px]">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-dp-secondary" />
          Active only
        </label>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
              <th className="p-4">Headline</th><th className="p-4">Category</th><th className="p-4">Contact</th><th className="p-4">Sector</th><th className="p-4">Status</th><th className="p-4"></th>
            </tr></thead>
            <tbody className="font-sans text-[15px]">
              {loading && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && filtered.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">No matching listings.</td></tr>}
              {!loading && filtered.map((l, i) => (
                <tr key={l.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${!l.is_active ? 'opacity-60' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant font-semibold">{l.headline}</td>
                  <td className="p-4 border-b border-dp-outline-variant"><span className="bg-dp-secondary-container text-dp-on-secondary-container px-2 py-0.5 rounded-full text-[12px] font-bold uppercase">{l.category}</span></td>
                  <td className="p-4 border-b border-dp-outline-variant">{l.contact_name} · {l.contact_mobile}</td>
                  <td className="p-4 border-b border-dp-outline-variant text-dp-on-surface-variant">{l.sector ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${l.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>{l.is_active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <button onClick={() => toggleActive(l)} title={l.is_active ? 'Deactivate' : 'Reactivate'} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Power size={16} /></button>
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
