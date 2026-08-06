'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { Droplet, ShieldCheck } from 'lucide-react'

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

export default function PortalBloodDonorPage() {
  const { user, loading: userLoading } = usePortalUser()
  const [registered, setRegistered] = useState(false)
  const [bloodGroup, setBloodGroup] = useState('')
  const [sector, setSector] = useState('')
  const [isAvailable, setIsAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    supabase.from('blood_donors').select('blood_group, sector, is_available').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      if (data) {
        setRegistered(true)
        setBloodGroup(data.blood_group)
        setSector(data.sector ?? '')
        setIsAvailable(data.is_available)
      }
      setLoading(false)
    })
  }, [user])

  const save = async () => {
    if (!user || !bloodGroup) { toast.error('Select your blood group'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('blood_donors').upsert(
      { portal_user_id: user.id, blood_group: bloodGroup, sector: sector || null, is_available: isAvailable, updated_at: new Date().toISOString() },
      { onConflict: 'portal_user_id' }
    )
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('Saved')
    setRegistered(true)
  }

  const remove = async () => {
    if (!user) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('blood_donors').delete().eq('portal_user_id', user.id)
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('Removed from the blood donor registry')
    setRegistered(false)
    setBloodGroup('')
    setSector('')
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Droplet size={22} className="text-dp-error" /> Blood Donor Registration</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Help the community in an emergency. Your details are visible only to committee staff — never public.</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md">
        <div className="mb-4 flex items-center gap-2 text-[12.5px] font-sans text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2.5">
          <ShieldCheck size={15} className="text-dp-secondary shrink-0" />
          Only committee staff can search this registry. It is never shown publicly or to other donors.
        </div>

        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Blood Group</label>
          <div className="grid grid-cols-4 gap-2">
            {GROUPS.map((g) => (
              <button key={g} type="button" onClick={() => setBloodGroup(g)}
                className={`py-2 rounded-lg font-sans text-[14px] font-bold cursor-pointer transition-all ${bloodGroup === g ? 'bg-dp-error text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-error'}`}>
                {g}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Sector / Area (optional)</label>
          <input value={sector} onChange={(e) => setSector(e.target.value)} className="input-field" />
        </div>

        <label className="flex items-center gap-2 cursor-pointer mb-6">
          <input type="checkbox" checked={isAvailable} onChange={(e) => setIsAvailable(e.target.checked)} className="accent-dp-secondary" />
          <span className="font-sans text-[14px]">I am currently available to donate</span>
        </label>

        <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 mb-2">
          {saving ? 'Saving...' : registered ? 'Update' : 'Register as Blood Donor'}
        </button>
        {registered && (
          <button onClick={remove} disabled={saving} className="w-full border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all disabled:opacity-50">
            Remove My Registration
          </button>
        )}
      </div>
    </>
  )
}
