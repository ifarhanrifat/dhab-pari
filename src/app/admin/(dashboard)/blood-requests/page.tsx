'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Droplet, Plus, X, Search, MessageCircle, Megaphone, Pause, Play, Ban, CheckCircle2, Heart, Phone } from 'lucide-react'
import { friendlyError } from '@/lib/errors'
import { normalizePakPhone } from '@/lib/receiptExport'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const GROUPS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-']

interface BloodRequest {
  id: string; patient_name: string; requester_name: string; requester_whatsapp: string
  requester_relation: string | null; blood_group: string; units_needed: number
  city: string; hospital: string; needed_on: string; needed_time: string | null; notes: string | null
  patient_kind: 'man' | 'woman' | 'child' | null
  needed_hour: number | null; needed_period: 'subha' | 'dopahar' | 'shaam' | 'raat' | null
  status: 'pending_approval' | 'open' | 'paused' | 'fulfilled' | 'cancelled' | 'expired'
  taken_at: string; approved_at: string | null; cancelled_at: string | null
  cancel_reason: string | null; fulfilled_at: string | null
  ticker_id: string | null; thanks_ticker_id: string | null
  source: 'phone_call' | 'public_form'; verified_by_call: boolean
}
interface Eligible {
  blood_donor_id: string; full_name: string; mobile: string; whatsapp_number: string | null
  blood_group: string; city: string | null; sector: string | null
  last_donation_date: string | null; available_from: string | null
  already_contacted: boolean; response: string | null
}

const PERIOD_EN: Record<string, string> = {
  subha: 'in the morning', dopahar: 'in the afternoon', shaam: 'in the evening', raat: 'at night',
}
// Falls back to the free-text time on requests recorded before the structured
// hour/period fields existed.
function fmtTime(r: { needed_hour: number | null; needed_period: string | null; needed_time: string | null }) {
  if (r.needed_hour && r.needed_period) return `${r.needed_hour} ${PERIOD_EN[r.needed_period] ?? ''}`.trim()
  return r.needed_time ?? ''
}

const STATUS_STYLE: Record<string, string> = {
  pending_approval: 'bg-amber-100 text-amber-800',
  open: 'bg-rose-100 text-rose-700',
  paused: 'bg-dp-surface-container-high text-dp-on-surface-variant',
  fulfilled: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-dp-surface-container-high text-dp-on-surface-variant',
  expired: 'bg-dp-surface-container-high text-dp-on-surface-variant',
}
const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Awaiting approval', open: 'Open — donors notified', paused: 'Paused',
  fulfilled: 'Fulfilled', cancelled: 'Cancelled', expired: 'Expired',
}

const emptyForm = {
  patient_name: '', requester_name: '', requester_whatsapp: '', requester_relation: '',
  blood_group: 'O+', units_needed: 1, city: '', hospital: '',
  needed_on: new Date().toISOString().slice(0, 10), notes: '',
  patient_kind: 'man', needed_hour: 9, needed_period: 'subha',
}

// Requests arrive two ways — typed up here from a phone call, or submitted by
// anyone from the website — and neither reaches a donor until someone holding
// the blood permission approves it. A website request additionally cannot be
// approved until the approver confirms they phoned the requester back. A fake
// request reaching forty villagers at 2am is the failure this screen guards
// against, so the taker, the approver and the call are all recorded.
export default function AdminBloodRequestsPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [requests, setRequests] = useState<BloodRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'active' | 'all' | 'fulfilled' | 'cancelled'>('active')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [eligible, setEligible] = useState<Eligible[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [cancelFor, setCancelFor] = useState<string | null>(null)
  const [verifyFor, setVerifyFor] = useState<BloodRequest | null>(null)
  const [verifyChecked, setVerifyChecked] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [tickerFor, setTickerFor] = useState<string | null>(null)
  const [tickerNumber, setTickerNumber] = useState('')
  const [appealAudience, setAppealAudience] = useState('everyone')
  const [appealCountries, setAppealCountries] = useState('')
  const [appealPublic, setAppealPublic] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase.from('blood_requests').select('*').order('created_at', { ascending: false })
    setRequests((data ?? []) as BloodRequest[])
    setLoading(false)
  }, [supabase])
  useEffect(() => { load() }, [load])

  const loadEligible = useCallback(async (id: string) => {
    const { data, error } = await supabase.rpc('eligible_blood_donors', { p_request_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    setEligible((data ?? []) as Eligible[])
    setPicked(new Set())
  }, [supabase])

  const toggleOpen = (id: string) => {
    if (openId === id) { setOpenId(null); setEligible([]); return }
    setOpenId(id)
    loadEligible(id)
  }

  const saveRequest = async () => {
    if (!form.patient_name.trim() || !form.requester_name.trim() || !form.requester_whatsapp.trim()
      || !form.city.trim() || !form.hospital.trim()) {
      toast.error('Patient, caller, WhatsApp, city and hospital are all required')
      return
    }
    setSaving(true)
    const { data: me } = await supabase.auth.getUser()
    const { data: admin } = me.user
      ? await supabase.from('admin_users').select('id').eq('auth_user_id', me.user.id).maybeSingle()
      : { data: null }
    const { error } = await supabase.from('blood_requests').insert({
      ...form,
      requester_relation: form.requester_relation || null,
      notes: form.notes || null,
      taken_by_admin_user_id: admin?.id ?? null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Recorded — approve it to notify donors')
    setForm(emptyForm)
    setShowForm(false)
    load()
  }

  // A request the committee took by phone is already verified by definition.
  // One that arrived from the website is not, so it goes through the call
  // modal — the database refuses it otherwise.
  const approve = async (id: string, calledRequester = false) => {
    setBusy(true)
    const { data, error } = await supabase.rpc('approve_blood_request', {
      p_request_id: id, p_called_requester: calledRequester,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    setVerifyFor(null)
    toast.success(`Approved — ${data ?? 0} matching donor(s) notified in their portal`)
    load(); if (openId === id) loadEligible(id)
  }

  const setPaused = async (id: string, paused: boolean) => {
    const { error } = await supabase.rpc('set_blood_request_paused', { p_request_id: id, p_paused: paused })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(paused ? 'Paused' : 'Resumed')
    load()
  }

  const doCancel = async () => {
    if (!cancelFor) return
    setBusy(true)
    const { data, error } = await supabase.rpc('cancel_blood_request', { p_request_id: cancelFor, p_reason: cancelReason })
    setBusy(false)
    setCancelFor(null); setCancelReason('')
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`Cancelled — ${data ?? 0} donor(s) told to stand down`)
    load()
  }

  const fulfil = async (id: string) => {
    if (picked.size === 0) { toast.error('Tick who actually donated — that starts their 12-week rest period'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('fulfil_blood_request', {
      p_request_id: id, p_donor_ids: [...picked], p_donated_on: new Date().toISOString().slice(0, 10),
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`Closed — ${picked.size} donor(s) recorded, ${data ?? 0} other(s) stood down`)
    load(); loadEligible(id)
  }

  const postTicker = async () => {
    if (!tickerFor || !tickerNumber.trim()) { toast.error('Give a number for the public to call'); return }
    const { error } = await supabase.rpc('post_blood_appeal', {
      p_request_id: tickerFor,
      p_contact_number: tickerNumber.trim(),
      p_audience: appealAudience,
      p_audience_countries: appealCountries.split(',').map((c) => c.trim()).filter(Boolean),
      p_is_public: appealPublic,
    })
    setTickerFor(null); setTickerNumber('')
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Appeal posted — it shows in red at the top of every matching portal')
    load()
  }

  const postThanks = async (id: string) => {
    const { error } = await supabase.rpc('post_blood_thanks_ticker', { p_request_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Thank-you posted — only donors who agreed to be named appear')
    load()
  }

  const whatsappDonor = (d: Eligible, r: BloodRequest) => {
    const intl = normalizePakPhone(d.whatsapp_number || d.mobile || '')
    if (!intl) { toast.error('No usable number for this donor'); return }
    const msg = `Assalam o Alaikum ${d.full_name}. ${r.units_needed} unit(s) of ${r.blood_group} blood are needed for a patient at ${r.hospital}, ${r.city} on ${new Date(r.needed_on).toLocaleDateString('en-GB')}${fmtTime(r) ? ` at ${fmtTime(r)}` : ''}. If you are able to help, please reply. — ${SITE.fullName}`
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(msg)}`, '_blank')
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return requests.filter((r) => {
      if (statusFilter === 'active' && !['pending_approval', 'open', 'paused'].includes(r.status)) return false
      if (statusFilter === 'fulfilled' && r.status !== 'fulfilled') return false
      if (statusFilter === 'cancelled' && r.status !== 'cancelled') return false
      if (!q) return true
      return [r.patient_name, r.requester_name, r.hospital, r.city, r.blood_group].join(' ').toLowerCase().includes(q)
    })
  }, [requests, statusFilter, search])

  const pendingCount = requests.filter((r) => r.status === 'pending_approval').length

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-heading text-[24px] sm:text-[32px] font-bold leading-[32px] sm:leading-[40px] text-dp-primary flex items-center gap-2">
            <Droplet size={26} /> {t('br.title')}
          </h1>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">
            Every request is taken by phone and approved here. Nobody can raise one themselves.
            {pendingCount > 0 && <span className="text-amber-700 font-semibold"> · {pendingCount} awaiting approval</span>}
          </p>
        </div>
        <button onClick={() => { setForm(emptyForm); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
          <Plus size={16} /> {t('br.recordCall')}
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient, caller, hospital, city or group..." className="input-field !ps-9" />
        </div>
        {(['active', 'fulfilled', 'cancelled', 'all'] as const).map((f) => (
          <button key={f} onClick={() => setStatusFilter(f)} className={`px-4 py-1.5 rounded-full font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${statusFilter === f ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}
      {!loading && visible.length === 0 && (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('br.noRequests')}</p>
        </div>
      )}

      <div className="space-y-3">
        {!loading && visible.map((r) => (
          <div key={r.id} className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="font-sans text-[16px] font-bold text-dp-on-surface">
                    <span className="text-rose-600">{r.blood_group}</span> · {r.units_needed} unit(s) · {r.patient_name}
                  </p>
                  <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">
                    {r.hospital}, {r.city} · {new Date(r.needed_on).toLocaleDateString('en-GB')}{fmtTime(r) ? ` at ${fmtTime(r)}` : ''}
                  </p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                    {r.source === 'public_form' ? 'Requested by' : 'Caller'}: {r.requester_name}{r.requester_relation ? ` (${r.requester_relation})` : ''} · {r.requester_whatsapp}
                  </p>
                  {r.source === 'public_form' && r.status === 'pending_approval' && (
                    <p className="font-sans text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1.5 inline-block">
                      Submitted from the website — nobody has spoken to them yet. Phone before approving.
                    </p>
                  )}
                  {r.notes && <p className="font-sans text-[13px] text-dp-on-surface mt-1">{r.notes}</p>}
                  {r.cancel_reason && <p className="font-sans text-[12.5px] text-dp-error mt-1">Cancelled: {r.cancel_reason}</p>}
                </div>
                <span className={`text-[11px] font-bold uppercase px-2.5 py-1 rounded-full font-sans shrink-0 ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-dp-outline-variant/60">
                {r.status === 'pending_approval' && (
                  r.source === 'public_form' ? (
                    <button disabled={busy} onClick={() => { setVerifyFor(r); setVerifyChecked(false) }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dp-secondary text-white font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                      <Phone size={14} /> {t('br.verifyApprove')}
                    </button>
                  ) : (
                    <button disabled={busy} onClick={() => approve(r.id)} className="px-3 py-1.5 rounded-lg bg-dp-secondary text-white font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                      {t('br.approveNotify')}
                    </button>
                  )
                )}
                {(r.status === 'open' || r.status === 'paused') && (
                  <>
                    <button onClick={() => toggleOpen(r.id)} className="px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-on-surface cursor-pointer hover:bg-dp-surface-container-low transition-all">
                      {openId === r.id ? 'Hide donors' : 'Matching donors'}
                    </button>
                    <button onClick={() => setPaused(r.id, r.status === 'open')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-on-surface cursor-pointer hover:bg-dp-surface-container-low transition-all">
                      {r.status === 'open' ? <><Pause size={14} /> {t('br.pause')}</> : <><Play size={14} /> {t('br.resume')}</>}
                    </button>
                    {!r.ticker_id && (
                      <button onClick={() => { setTickerFor(r.id); setTickerNumber(r.requester_whatsapp) }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-on-surface cursor-pointer hover:bg-dp-surface-container-low transition-all">
                        <Megaphone size={14} /> {t('br.postAppealBtn')}
                      </button>
                    )}
                  </>
                )}
                {!['cancelled', 'fulfilled'].includes(r.status) && (
                  <button onClick={() => { setCancelFor(r.id); setCancelReason('') }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-error cursor-pointer hover:bg-dp-surface-container-low transition-all">
                    <Ban size={14} /> {t('action.cancel')}
                  </button>
                )}
                {r.status === 'fulfilled' && !r.thanks_ticker_id && (
                  <button onClick={() => postThanks(r.id)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-secondary cursor-pointer hover:bg-dp-surface-container-low transition-all">
                    <Heart size={14} /> {t('br.postThanks')}
                  </button>
                )}
              </div>
            </div>

            {openId === r.id && (
              <div className="border-t border-dp-outline-variant bg-dp-surface-container-low/40 p-4">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface mb-2">
                  Compatible donors for {r.blood_group} — available and past their rest period
                </p>
                {eligible.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">Nobody eligible right now. Widen the appeal publicly, or check who is inside their rest period on the Blood Donors page.</p>}
                <div className="space-y-1.5">
                  {eligible.map((d) => (
                    <div key={d.blood_donor_id} className="flex items-center justify-between gap-3 bg-white rounded-lg border border-dp-outline-variant px-3 py-2">
                      <label className="flex items-center gap-2.5 min-w-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={picked.has(d.blood_donor_id)}
                          onChange={() => setPicked((prev) => { const n = new Set(prev); n.has(d.blood_donor_id) ? n.delete(d.blood_donor_id) : n.add(d.blood_donor_id); return n })}
                          className="accent-dp-secondary cursor-pointer shrink-0"
                        />
                        <span className="min-w-0">
                          <span className="block font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">
                            {d.full_name} <span className="text-rose-600">{d.blood_group}</span>
                          </span>
                          <span className="block font-sans text-[12px] text-dp-on-surface-variant">
                            {d.city || d.sector || '—'} · {d.mobile}
                            {d.response && d.response !== 'pending' && <span className={d.response === 'yes' ? ' text-emerald-700 font-semibold' : ' text-dp-on-surface-variant'}> · said {d.response}</span>}
                          </span>
                        </span>
                      </label>
                      <button onClick={() => whatsappDonor(d, r)} className="inline-flex items-center justify-center p-2 rounded-lg border border-dp-outline-variant text-dp-secondary cursor-pointer hover:bg-dp-surface-container-low transition-all shrink-0" title={t('w.whatsapp')} aria-label={t('w.whatsapp')}>
                        <MessageCircle size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                {eligible.length > 0 && (
                  <button disabled={busy} onClick={() => fulfil(r.id)} className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-dp-secondary text-white font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                    <CheckCircle2 size={15} /> {t('br.markDonated')}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('br.recordRequest')}</h2>
              <button onClick={() => setShowForm(false)} className="text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={18} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
              Take these details on the phone. Nothing reaches donors until someone approves it.
            </p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.patientName')}</label>
                  <input value={form.patient_name} onChange={(e) => setForm({ ...form, patient_name: e.target.value })} className="input-field !py-2.5 text-[15px]" />
                </div>
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.groupNeeded')}</label>
                  <select value={form.blood_group} onChange={(e) => setForm({ ...form, blood_group: e.target.value })} className="input-field !py-2.5 text-[15px]">
                    {GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.whoCalled')}</label>
                  <input value={form.requester_name} onChange={(e) => setForm({ ...form, requester_name: e.target.value })} className="input-field !py-2.5 text-[15px]" />
                </div>
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.theirWhatsapp')}</label>
                  <input value={form.requester_whatsapp} onChange={(e) => setForm({ ...form, requester_whatsapp: e.target.value })} placeholder="03xx-xxxxxxx" className="input-field !py-2.5 text-[15px]" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.relation')}</label>
                  <input value={form.requester_relation} onChange={(e) => setForm({ ...form, requester_relation: e.target.value })} placeholder="brother, son..." className="input-field !py-2.5 text-[15px]" />
                </div>
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.unitsNeeded')}</label>
                  <input type="number" min={1} value={form.units_needed} onChange={(e) => setForm({ ...form, units_needed: +e.target.value })} className="input-field !py-2.5 text-[15px]" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.hospital')}</label>
                  <input value={form.hospital} onChange={(e) => setForm({ ...form, hospital: e.target.value })} className="input-field !py-2.5 text-[15px]" />
                </div>
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.city')}</label>
                  <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Chakwal" className="input-field !py-2.5 text-[15px]" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.dateNeeded')}</label>
                  <input type="date" value={form.needed_on} onChange={(e) => setForm({ ...form, needed_on: e.target.value })} className="input-field !py-2.5 text-[15px]" />
                </div>
                <div>
                  <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.timeNeeded')}</label>
                  <div className="flex gap-1.5">
                    <select value={form.needed_hour} onChange={(e) => setForm({ ...form, needed_hour: +e.target.value })} className="input-field !py-2.5 text-[15px] w-20">
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <select value={form.needed_period} onChange={(e) => setForm({ ...form, needed_period: e.target.value })} className="input-field !py-2.5 text-[15px] flex-1">
                      <option value="subha">صبح — morning</option>
                      <option value="dopahar">دوپہر — afternoon</option>
                      <option value="shaam">شام — evening</option>
                      <option value="raat">رات — night</option>
                    </select>
                  </div>
                </div>
              </div>
              {/* Drives the public appeal's wording, which never names the patient. */}
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.patientIs')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {([['man', 'A man'], ['woman', 'A woman'], ['child', 'A child']] as const).map(([v, l]) => (
                    <button key={v} type="button" onClick={() => setForm({ ...form, patient_kind: v })}
                      className={`py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${form.patient_kind === v ? 'bg-dp-error text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-error'}`}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('a.notesOptional')}</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="input-field resize-none !py-2.5 text-[15px]" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">{t('action.cancel')}</button>
              <button disabled={saving} onClick={saveRequest} className="flex-1 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">{saving ? 'Saving...' : 'Record'}</button>
            </div>
          </div>
        </div>
      )}

      {/* The gate on the whole open-form idea. Approving sends this to every
          compatible donor at once, so the one thing that cannot be skipped is
          hearing a human confirm it. */}
      {verifyFor && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setVerifyFor(null)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1">{t('br.verifyBefore')}</h2>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
              This request came from the website. Approving it notifies every compatible donor
              at once, so speak to the person who sent it first.
            </p>

            <div className="bg-dp-surface-container-low rounded-lg p-3 mb-4">
              <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{verifyFor.requester_name}</p>
              {verifyFor.requester_relation && (
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{verifyFor.requester_relation} of {verifyFor.patient_name}</p>
              )}
              <p dir="ltr" className="font-mono text-[16px] font-bold text-dp-primary mt-1">{verifyFor.requester_whatsapp}</p>
              <div className="flex gap-2 mt-3">
                <a href={`tel:${normalizePakPhone(verifyFor.requester_whatsapp)}`}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-dp-primary text-white font-sans text-[13px] font-semibold hover:opacity-90 transition-all">
                  <Phone size={14} /> {t('br.call')}
                </a>
                <a href={`https://wa.me/${normalizePakPhone(verifyFor.requester_whatsapp)}`} target="_blank" rel="noopener noreferrer"
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#25D366] text-white font-sans text-[13px] font-semibold hover:opacity-90 transition-all">
                  <MessageCircle size={14} /> {t('w.whatsapp')}
                </a>
              </div>
            </div>

            <label className="flex items-start gap-2 cursor-pointer mb-4">
              <input type="checkbox" checked={verifyChecked} onChange={(e) => setVerifyChecked(e.target.checked)} className="accent-dp-secondary mt-0.5" />
              <span className="font-sans text-[13px] text-dp-on-surface">
                I have spoken to {verifyFor.requester_name} and this request is genuine.
                <span className="block text-[11.5px] text-dp-on-surface-variant">{t('br.againstYourName')}</span>
              </span>
            </label>

            <div className="flex gap-2">
              <button onClick={() => setVerifyFor(null)} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant cursor-pointer">{t('f.back')}</button>
              <button disabled={busy || !verifyChecked} onClick={() => approve(verifyFor.id, true)}
                className="flex-1 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">
                {t('br.approveNotify')}
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelFor && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setCancelFor(null)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1">{t('br.cancelThis')}</h2>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">
              Everyone already contacted is told to stand down, and they are told why. Say if this was a fake call — that is worth recording.
            </p>
            <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Fake call / arranged elsewhere / family cancelled" className="input-field !py-2.5 text-[15px]" />
            <div className="flex gap-2 mt-4">
              <button onClick={() => setCancelFor(null)} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant cursor-pointer">{t('f.back')}</button>
              <button disabled={busy || !cancelReason.trim()} onClick={doCancel} className="flex-1 px-4 py-2 bg-dp-error text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">{t('br.cancelRequest')}</button>
            </div>
          </div>
        </div>
      )}

      {tickerFor && (
        <div className="fixed inset-0 bg-black/50 z-[130] flex items-center justify-center p-4" onClick={() => setTickerFor(null)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1">{t('br.postAppeal')}</h2>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">
              Shows in red at the top of every matching portal, and on the website if public. The
              patient is described as &quot;a villager (man/woman/child)&quot; — never by name.
            </p>

            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.numberToCall')}</label>
            <input value={tickerNumber} onChange={(e) => setTickerNumber(e.target.value)} placeholder="03xx-xxxxxxx" className="input-field !py-2.5 text-[15px]" />

            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1 mt-3">{t('g.whoShouldSee')}</label>
            <div className="grid grid-cols-2 gap-2">
              {([['everyone', 'Everyone'], ['villagers', 'Villagers only'], ['consumers', 'Water consumers'], ['donors', 'Donors only'], ['overseas', 'Overseas only']] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setAppealAudience(v)}
                  className={`py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer transition-all ${appealAudience === v ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary'}`}>
                  {l}
                </button>
              ))}
            </div>

            {appealAudience === 'overseas' && (
              <div className="mt-2">
                <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('br.countries')}</label>
                <input value={appealCountries} onChange={(e) => setAppealCountries(e.target.value)} placeholder="UK, UAE, Saudi Arabia" className="input-field !py-2.5 text-[14px]" />
              </div>
            )}

            <label className="flex items-start gap-2 cursor-pointer mt-3">
              <input type="checkbox" checked={appealPublic} onChange={(e) => setAppealPublic(e.target.checked)} className="accent-dp-secondary mt-0.5" />
              <span className="font-sans text-[12.5px] text-dp-on-surface">
                {t('g.alsoPublic')}
                <span className="block text-[11px] text-dp-on-surface-variant">Untick to keep it inside the portal only — a targeted appeal usually should not be public.</span>
              </span>
            </label>
            <div className="flex gap-2 mt-4">
              <button onClick={() => { setTickerFor(null); setTickerNumber('') }} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant cursor-pointer">{t('f.back')}</button>
              <button disabled={!tickerNumber.trim()} onClick={postTicker} className="flex-1 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">{t('br.postAppealBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
