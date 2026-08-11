'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Send } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Complaint {
  id: string; complaint_number: string | null; system: string; complaint_text: string
  status: string; created_at: string; sector: string | null
}

const statusLabel: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-amber-100 text-amber-700' },
  awaiting_verification: { label: 'Resolved, Pending Verification', cls: 'bg-blue-100 text-blue-700' },
  verified: { label: 'Resolved', cls: 'bg-emerald-100 text-emerald-700' },
}

export default function PortalComplaintsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [complaints, setComplaints] = useState<Complaint[]>([])
  const [sectors, setSectors] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [system, setSystem] = useState<'water_supply' | 'donors_projects'>('donors_projects')
  const [sector, setSector] = useState('')
  const [complaintText, setComplaintText] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const [{ data: c }, { data: s }] = await Promise.all([
      supabase.from('complaints').select('id, complaint_number, system, complaint_text, status, created_at, sector')
        .eq('portal_user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
    ])
    setComplaints(c ?? [])
    setSectors(s ?? [])
    setLoading(false)
    if (user.consumer_id) setSystem('water_supply')
  }
  useEffect(() => { load() }, [user])

  const submit = async () => {
    if (!user || !complaintText.trim()) { toast.error('Please describe your complaint'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('complaints').insert({
      system, portal_user_id: user.id, complainant_name: user.full_name, phone: user.whatsapp_number ?? user.mobile,
      sector: system === 'water_supply' ? (sector || null) : null, complaint_text: complaintText.trim(), source: 'website',
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Complaint submitted')
    setComplaintText('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('g.complaints')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.complaintsBlurb')}</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-8">
        <div className="flex flex-wrap gap-3 mb-5">
          <button type="button" onClick={() => setSystem('donors_projects')}
            className={`px-4 py-2 rounded-full font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${system === 'donors_projects' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t('a.donorsProjects')}
          </button>
          {user?.consumer_id && (
            <button type="button" onClick={() => setSystem('water_supply')}
              className={`px-4 py-2 rounded-full font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${system === 'water_supply' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
              {t('a.waterSupply')}
            </button>
          )}
        </div>
        {system === 'water_supply' && (
          <div className="mb-4">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.sectorOptional')}</label>
            <select value={sector} onChange={(e) => setSector(e.target.value)} className="input-field">
              <option value="">{t('w.selectSector')}</option>
              {sectors.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        )}
        <textarea value={complaintText} onChange={(e) => setComplaintText(e.target.value)} rows={4} placeholder="Describe the issue..." className="input-field resize-none mb-4" />
        <button onClick={submit} disabled={saving} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          <Send size={16} /> {saving ? 'Submitting...' : 'Submit Complaint'}
        </button>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low/60"><span className="font-sans text-[14px] font-bold">{t('p.myComplaints')}</span></div>
        {complaints.length === 0 ? (
          <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('p.noComplaints')}</p>
        ) : (
          complaints.map((c) => (
            <div key={c.id} className="px-5 py-4 border-b border-dp-outline-variant last:border-b-0">
              <div className="flex items-start justify-between gap-2">
                <p className="font-sans text-[14px] flex-1">{c.complaint_text}</p>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${statusLabel[c.status]?.cls}`}>{statusLabel[c.status]?.label ?? c.status}</span>
              </div>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">
                {c.complaint_number ?? '—'} · {c.system === 'water_supply' ? 'Water Supply' : 'Donors & Projects'} · {new Date(c.created_at).toLocaleDateString('en-GB')}
              </p>
            </div>
          ))
        )}
      </div>
    </>
  )
}
