'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { MessageSquareWarning, PlusCircle, X, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type SystemTab = 'water_supply' | 'donors_projects'
type StatusFilter = 'all' | 'open' | 'awaiting_verification' | 'verified'

interface Complaint {
  id: string; complaint_number: string; complainant_name: string | null; phone: string | null
  sector: string | null; complaint_text: string; status: string; assigned_to: string | null
  deadline_at: string; created_at: string
}
interface Person { id: string; full_name: string }
interface ConsumerOption { consumer_id: string; name: string; mobile: string }

const statusLabels: Record<string, string> = { open: 'Open', awaiting_verification: 'Awaiting Verification', verified: 'Verified' }
const statusColors: Record<string, string> = {
  open: 'bg-amber-100 text-amber-800', awaiting_verification: 'bg-blue-100 text-blue-800', verified: 'bg-emerald-100 text-emerald-800',
}

function deadlineText(deadline: string, status: string) {
  if (status === 'verified') return null
  const hrs = Math.round((new Date(deadline).getTime() - Date.now()) / 3600000)
  if (hrs <= 0) return { text: 'Overdue', tone: 'text-dp-error' }
  if (hrs < 24) return { text: `${hrs}h left`, tone: 'text-amber-700' }
  return { text: `${Math.round(hrs / 24)}d left`, tone: 'text-dp-on-surface-variant' }
}

const emptyForm = { complainant_name: '', phone: '', sector: '', complaint_text: '', consumer_id: '' }

export default function ComplaintsPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const access = useSystemAccess()
  const [system, setSystem] = useState<SystemTab>('water_supply')
  const [systemOverride] = useState<SystemTab | null>(() => {
    if (typeof window === 'undefined') return null
    const p = new URLSearchParams(window.location.search).get('system')
    return p === 'water_supply' || p === 'donors_projects' ? p : null
  })
  useEffect(() => {
    if (access.loading) return
    if (systemOverride === 'water_supply' && access.canWaterSupply) { setSystem('water_supply'); return }
    if (systemOverride === 'donors_projects' && access.canDonorsProjects) { setSystem('donors_projects'); return }
    setSystem(access.defaultSystem)
  }, [access.loading, access.defaultSystem, access.canWaterSupply, access.canDonorsProjects, systemOverride])

  const [complaints, setComplaints] = useState<Complaint[]>([])
  const [people, setPeople] = useState<Record<string, string>>({})
  const [sectors, setSectors] = useState<{ id: string; name: string }[]>([])
  const [consumers, setConsumers] = useState<ConsumerOption[]>([])
  const [consumerQuery, setConsumerQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const [{ data: rows }, { data: roster }, { data: sectorsData }, { data: consumersData }] = await Promise.all([
      supabase.from('complaints').select('*').eq('system', system).order('created_at', { ascending: false }),
      supabase.rpc('get_approvers_roster', { p_system: system }),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
      system === 'water_supply' ? supabase.from('consumers').select('consumer_id, name, mobile').order('name') : Promise.resolve({ data: [] }),
    ])
    setComplaints(rows ?? [])
    setPeople(Object.fromEntries(((roster ?? []) as Person[]).map((p) => [p.id, p.full_name])))
    setSectors(sectorsData ?? [])
    setConsumers((consumersData ?? []) as ConsumerOption[])
    setLoading(false)
  }
  useEffect(() => { load() }, [system]) // eslint-disable-line react-hooks/exhaustive-deps

  const matchingConsumers = useMemo(() => {
    const q = consumerQuery.trim().toLowerCase()
    if (!q) return []
    return consumers.filter((c) => c.name.toLowerCase().includes(q) || c.consumer_id.toLowerCase().includes(q) || c.mobile?.includes(q)).slice(0, 8)
  }, [consumers, consumerQuery])
  const selectedConsumerOption = useMemo(() => consumers.find((c) => c.consumer_id === form.consumer_id) ?? null, [consumers, form.consumer_id])

  const filtered = useMemo(() => complaints.filter((c) => statusFilter === 'all' || c.status === statusFilter), [complaints, statusFilter])

  const createComplaint = async () => {
    if (!form.complaint_text.trim()) { toast.error('Describe the complaint'); return }
    setSaving(true)
    const { data, error } = await supabase.from('complaints').insert({
      system, complainant_name: form.complainant_name || null, phone: form.phone || null,
      sector: form.sector || null, complaint_text: form.complaint_text, source: 'manual',
      consumer_id: form.consumer_id || null,
    }).select('complaint_number').single()
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`Complaint ${data.complaint_number} registered`)
    setShowForm(false)
    setForm(emptyForm)
    load()
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
            <MessageSquareWarning size={26} /> {t('g.complaints')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">2-day SLA, assign a handler, verify before closing.</p>
        </div>
        <div className="flex items-center gap-3">
          {!access.loading && (access.canWaterSupply || access.canDonorsProjects) && (
            <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
              {access.canWaterSupply && (
                <button onClick={() => setSystem('water_supply')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'water_supply' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>{t('a.waterSupply')}</button>
              )}
              {access.canDonorsProjects && (
                <button onClick={() => setSystem('donors_projects')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'donors_projects' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>{t('a.donorsProjects')}</button>
              )}
            </div>
          )}
          <button onClick={() => { setForm(emptyForm); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <PlusCircle size={16} /> {t('y.registerComplaint')}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-5">
        {(['all', 'open', 'awaiting_verification', 'verified'] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all border ${statusFilter === s ? 'bg-dp-secondary text-white border-dp-secondary' : 'border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container-low'}`}
          >
            {s === 'all' ? 'All' : statusLabels[s]}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        {loading ? (
          <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('action.loading')}</p>
        ) : filtered.length === 0 ? (
          <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('y.noComplaintsFilter')}</p>
        ) : (
          <div className="divide-y divide-dp-outline-variant">
            {filtered.map((c) => {
              const dl = deadlineText(c.deadline_at, c.status)
              return (
                <Link key={c.id} href={`/admin/complaints/${c.id}`} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-dp-surface-container-low transition-all">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-sans text-[13px] font-bold text-dp-secondary">{c.complaint_number}</span>
                      <span className={`px-2 py-0.5 rounded-full font-sans text-[10.5px] font-bold uppercase tracking-wide ${statusColors[c.status]}`}>{statusLabels[c.status]}</span>
                      {c.sector && <span className="font-sans text-[11.5px] text-dp-on-surface-variant">{c.sector}</span>}
                    </div>
                    <p className="font-sans text-[14px] text-dp-on-surface truncate max-w-lg">{c.complaint_text}</p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">
                      {c.complainant_name || 'Anonymous'}{c.phone ? ` · ${c.phone}` : ''} · {new Date(c.created_at).toLocaleDateString('en-GB')}
                    </p>
                  </div>
                  <div className="text-end shrink-0">
                    <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{c.assigned_to ? (people[c.assigned_to] ?? 'Assigned') : 'Unassigned'}</p>
                    {dl && <p className={`font-sans text-[11.5px] font-semibold flex items-center justify-end gap-1 mt-0.5 ${dl.tone}`}><Clock size={11} /> {dl.text}</p>}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('y.registerComplaint')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('y.complainantName')}</label>
                <input value={form.complainant_name} onChange={(e) => setForm({ ...form, complainant_name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.phoneOptional')}</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0300-1234567" className="input-field" />
              </div>
              {system === 'water_supply' && (
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.sectorOptional')}</label>
                  <select value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} className="input-field">
                    <option value="">{t('g.selectSector')}</option>
                    {sectors.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </div>
              )}
              {system === 'water_supply' && (
                <div className="relative">
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
                    {t('y.linkConsumer')} <span className="font-normal opacity-70">— required to waive bill dues later</span>
                  </label>
                  {selectedConsumerOption ? (
                    <div className="flex items-center justify-between px-3 py-2 border border-dp-outline-variant rounded-lg bg-dp-surface-container-low">
                      <span className="font-sans text-[13.5px]"><strong>{selectedConsumerOption.consumer_id}</strong> — {selectedConsumerOption.name}</span>
                      <button onClick={() => { setForm({ ...form, consumer_id: '' }); setConsumerQuery('') }} className="cursor-pointer text-dp-on-surface-variant"><X size={16} /></button>
                    </div>
                  ) : (
                    <>
                      <input
                        value={consumerQuery} onChange={(e) => setConsumerQuery(e.target.value)}
                        placeholder="Search by name, consumer no., or mobile..." className="input-field"
                      />
                      {matchingConsumers.length > 0 && (
                        <div className="absolute z-10 mt-1 w-full bg-white border border-dp-outline-variant rounded-lg shadow-lg max-h-48 overflow-y-auto">
                          {matchingConsumers.map((c) => (
                            <button
                              key={c.consumer_id} type="button"
                              onClick={() => { setForm({ ...form, consumer_id: c.consumer_id }); setConsumerQuery('') }}
                              className="w-full text-start px-3 py-2 hover:bg-dp-surface-container-low font-sans text-[13px] cursor-pointer"
                            >
                              <strong>{c.consumer_id}</strong> — {c.name} {c.mobile && <span className="text-dp-on-surface-variant">· {c.mobile}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('y.complaint')}</label>
                <textarea value={form.complaint_text} onChange={(e) => setForm({ ...form, complaint_text: e.target.value })} rows={4} className="input-field resize-none" />
              </div>
              <button disabled={saving} onClick={createComplaint} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {saving ? 'Saving...' : 'Register Complaint'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
