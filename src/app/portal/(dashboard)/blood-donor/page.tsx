'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Droplet, ShieldCheck } from 'lucide-react'

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

interface OpenRequest {
  id: string; blood_group: string; units_needed: number; hospital: string; city: string
  needed_on: string; needed_time: string | null; status: string; response: string
}

// A donor may not give again for 12 weeks (16 for women). Showing the date they
// become eligible is kinder than silently hiding them, and stops people
// wondering why they are never called.
function coolOffDays(gender: string) { return gender === 'female' ? 112 : 84 }

function fmtDay(d: string) {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

export default function PortalBloodDonorPage() {
  const { user, loading: userLoading } = usePortalUser()
  const [registered, setRegistered] = useState(false)
  const [bloodGroup, setBloodGroup] = useState('')
  const [sector, setSector] = useState('')
  const [isAvailable, setIsAvailable] = useState(true)
  const [gender, setGender] = useState('')
  const [city, setCity] = useState('')
  const [allowThanks, setAllowThanks] = useState(false)
  const [lastDonation, setLastDonation] = useState<string | null>(null)
  const [availableFrom, setAvailableFrom] = useState<string | null>(null)
  const [openRequests, setOpenRequests] = useState<OpenRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    ;(async () => {
      const { data } = await supabase
        .from('blood_donors')
        .select('id, blood_group, sector, is_available, gender, city, allow_public_thanks, last_donation_date')
        .eq('portal_user_id', user.id).maybeSingle()
      if (data) {
        setRegistered(true)
        setBloodGroup(data.blood_group)
        setSector(data.sector ?? '')
        setIsAvailable(data.is_available)
        setGender(data.gender ?? '')
        setCity(data.city ?? '')
        setAllowThanks(!!data.allow_public_thanks)
        setLastDonation(data.last_donation_date)
        if (data.last_donation_date) {
          const from = new Date(data.last_donation_date)
          from.setDate(from.getDate() + coolOffDays(data.gender ?? ''))
          setAvailableFrom(from.toISOString().slice(0, 10))
        }

        // RLS returns only this donor's own contact rows.
        const { data: rows } = await supabase
          .from('blood_request_contacts')
          .select('response, blood_requests(id, blood_group, units_needed, hospital, city, needed_on, needed_time, status)')
          .is('stood_down_at', null)
        setOpenRequests(
          (rows ?? []).flatMap((c) => {
            const br = Array.isArray(c.blood_requests) ? c.blood_requests[0] : c.blood_requests
            if (!br || !['open', 'paused'].includes(br.status as string)) return []
            return [{ ...(br as Omit<OpenRequest, 'response'>), response: c.response as string }]
          })
        )
      }
      setLoading(false)
    })()
  }, [user])

  const save = async () => {
    if (!user || !bloodGroup) { toast.error('Select your blood group'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('blood_donors').upsert(
      {
        portal_user_id: user.id, blood_group: bloodGroup, sector: sector || null,
        is_available: isAvailable, gender: gender || null, city: city || null,
        allow_public_thanks: allowThanks, updated_at: new Date().toISOString(),
      },
      { onConflict: 'portal_user_id' }
    )
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Saved')
    setRegistered(true)
  }

  const remove = async () => {
    if (!user) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('blood_donors').delete().eq('portal_user_id', user.id)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Removed from the blood donor registry')
    setRegistered(false)
    setBloodGroup('')
    setSector('')
  }

  const respond = async (requestId: string, answer: 'yes' | 'no') => {
    const supabase = createClient()
    const { error } = await supabase.rpc('respond_to_blood_request', { p_request_id: requestId, p_response: answer })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(answer === 'yes' ? 'Thank you — the committee will contact you' : 'Noted, thank you for answering')
    setOpenRequests((prev) => prev.map((r) => r.id === requestId ? { ...r, response: answer } : r))
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Droplet size={22} className="text-dp-error" /> Blood Donor Registration</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Help the community in an emergency. Your details are visible only to committee staff — never public.</p>
      </div>

      {/* Requests the committee has matched to this donor. Nothing about the
          patient is shown — only what a donor needs to answer yes or no. */}
      {openRequests.length > 0 && (
        <div className="mb-6 max-w-md space-y-3">
          {openRequests.map((r) => (
            <div key={r.id} className="bg-white border-2 border-dp-error rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-heading text-[17px] font-bold text-dp-error">{r.blood_group} blood needed</span>
                <span className="font-sans text-[12px] text-dp-on-surface-variant">{r.units_needed} unit{r.units_needed > 1 ? 's' : ''}</span>
              </div>
              <p className="font-sans text-[13.5px] text-dp-on-surface mb-1">{r.hospital}, {r.city}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">
                Needed on {fmtDay(r.needed_on)}{r.needed_time ? ` at ${r.needed_time}` : ''}
              </p>

              {r.status === 'paused' ? (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2">
                  This request is on hold — please wait for the committee to call.
                </p>
              ) : r.response === 'pending' ? (
                <div className="flex gap-2">
                  <button onClick={() => respond(r.id, 'yes')} className="flex-1 bg-dp-error text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:opacity-90 transition-all">
                    Yes, I can donate
                  </button>
                  <button onClick={() => respond(r.id, 'no')} className="flex-1 border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all">
                    Not this time
                  </button>
                </div>
              ) : (
                <p className={`font-sans text-[13px] font-semibold ${r.response === 'yes' ? 'text-dp-secondary' : 'text-dp-on-surface-variant'}`}>
                  {r.response === 'yes'
                    ? 'You answered yes — the committee will contact you with the details.'
                    : 'You answered no. Thank you for letting us know.'}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

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

        {/* The safe gap between donations is longer for women, so this is not an
            optional nicety — without it the register would call people back too
            soon. */}
        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Gender</label>
          <div className="grid grid-cols-2 gap-2">
            {[{ v: 'male', l: 'Male / مرد' }, { v: 'female', l: 'Female / خاتون' }].map((o) => (
              <button key={o.v} type="button" onClick={() => setGender(o.v)}
                className={`py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${gender === o.v ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary'}`}>
                {o.l}
              </button>
            ))}
          </div>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">Men may donate every 12 weeks, women every 16 weeks. We use this only to work out when you are eligible again.</p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">City / Town</label>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Chakwal" className="input-field" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Sector / Area (optional)</label>
            <input value={sector} onChange={(e) => setSector(e.target.value)} className="input-field" />
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer mb-3">
          <input type="checkbox" checked={isAvailable} onChange={(e) => setIsAvailable(e.target.checked)} className="accent-dp-secondary" />
          <span className="font-sans text-[14px]">I am currently available to donate</span>
        </label>

        <label className="flex items-start gap-2 cursor-pointer mb-6">
          <input type="checkbox" checked={allowThanks} onChange={(e) => setAllowThanks(e.target.checked)} className="accent-dp-secondary mt-0.5" />
          <span className="font-sans text-[13.5px]">
            You may thank me publicly by name after I donate
            <span className="block text-[11.5px] text-dp-on-surface-variant">Leave this unticked and your name is never published — you will simply be thanked as an anonymous donor.</span>
          </span>
        </label>

        {availableFrom && (
          <div className={`mb-6 rounded-lg px-3 py-2.5 font-sans text-[12.5px] ${availableFrom > new Date().toISOString().slice(0, 10) ? 'bg-dp-error/10 text-dp-error' : 'bg-dp-secondary/10 text-dp-secondary'}`}>
            {availableFrom > new Date().toISOString().slice(0, 10)
              ? <>You last donated on {fmtDay(lastDonation!)}. You are eligible again on <strong>{fmtDay(availableFrom)}</strong> — we will not call you before then.</>
              : <>You last donated on {fmtDay(lastDonation!)} and are eligible again now.</>}
          </div>
        )}

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
