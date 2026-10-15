'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Megaphone, Plus, Pause, Play, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Tenant { id: string; name: string; name_ur: string | null }
interface Ilan {
  id: string; placement: string; target_tenant_ids: string[]; title_ur: string; body_ur: string
  starts_at: string; ends_at: string; price_pkr: number; status: string; is_paused: boolean; rejection_reason: string | null
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

function toLocalInputValue(d: Date) {
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function MyVehicleIlanPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const params = useSearchParams()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [ilans, setIlans] = useState<Ilan[]>([])
  const [showForm, setShowForm] = useState(!!params.get('route'))
  const [placement, setPlacement] = useState<'ticker' | 'banner'>('ticker')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [titleUr, setTitleUr] = useState('')
  const [titleEn, setTitleEn] = useState('')
  const [bodyUr, setBodyUr] = useState(() => {
    const o = params.get('origin'); const d = params.get('destination')
    return o && d ? `${o} سے ${d} روزانہ سفر دستیاب ہے۔` : ''
  })
  const [bodyEn, setBodyEn] = useState('')
  const [contact, setContact] = useState('')
  const [startsAt, setStartsAt] = useState(() => toLocalInputValue(new Date(Date.now() + 3600000)))
  const [endsAt, setEndsAt] = useState(() => toLocalInputValue(new Date(Date.now() + 3600000 * 25)))
  const [quote, setQuote] = useState<number | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const routeId = params.get('route') || null

  const load = useCallback(async (vid: string) => {
    const [{ data: tn }, { data: list }] = await Promise.all([
      supabase.rpc('ilan_target_tenants'),
      supabase.from('commercial_ilans').select('id, placement, target_tenant_ids, title_ur, body_ur, starts_at, ends_at, price_pkr, status, is_paused, rejection_reason')
        .eq('vehicle_id', vid).order('created_at', { ascending: false }),
    ])
    setTenants((tn ?? []) as Tenant[])
    setIlans((list ?? []) as Ilan[])
  }, [supabase])

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_mobile').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) { setVehicleId(data.id); setContact(data.owner_mobile ?? ''); await load(data.id) }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePick = (id: string) => {
    setPicked((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
    setQuote(null)
  }

  const runQuote = async () => {
    if (picked.size === 0) { toast.error(t('il.pickAtLeastOneVillageError')); return }
    setQuoting(true)
    const { data, error } = await supabase.rpc('quote_commercial_ilan', {
      p_placement: placement, p_target_tenant_ids: Array.from(picked),
      p_starts_at: new Date(startsAt).toISOString(), p_ends_at: new Date(endsAt).toISOString(),
    })
    setQuoting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); setQuote(null); return }
    setQuote(data as number)
  }

  const submit = async () => {
    if (!vehicleId) return
    if (picked.size === 0) { toast.error(t('il.pickAtLeastOneVillageError')); return }
    if (!titleUr.trim() || !bodyUr.trim()) { toast.error(t('il.requestSubmitted')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('request_commercial_ilan', {
      p_vehicle_id: vehicleId,
      p_placement: placement,
      p_target_tenant_ids: Array.from(picked),
      p_title_ur: titleUr.trim(), p_body_ur: bodyUr.trim(),
      p_starts_at: new Date(startsAt).toISOString(), p_ends_at: new Date(endsAt).toISOString(),
      p_vehicle_route_id: routeId,
      p_title_en: titleEn.trim() || null, p_body_en: bodyEn.trim() || null, p_contact_mobile: contact.trim() || null,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('il.requestSubmitted'))
    setShowForm(false); setTitleUr(''); setTitleEn(''); setBodyUr(''); setBodyEn(''); setPicked(new Set()); setQuote(null)
    if (vehicleId) load(vehicleId)
  }

  const pauseIlan = async (id: string) => {
    const { error } = await supabase.rpc('pause_commercial_ilan', { p_ilan_id: id })
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('il.ilanPaused')); if (vehicleId) load(vehicleId)
  }
  const resumeIlan = async (id: string) => {
    const { error } = await supabase.rpc('resume_commercial_ilan', { p_ilan_id: id })
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('il.ilanResumed')); if (vehicleId) load(vehicleId)
  }
  const cancelIlan = async (id: string) => {
    const { error } = await supabase.rpc('cancel_commercial_ilan', { p_ilan_id: id })
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('il.ilanCancelled')); if (vehicleId) load(vehicleId)
  }

  const statusBadge = (ilan: Ilan) => {
    const now = Date.now()
    if (ilan.status === 'pending_approval') return <span className="text-amber-700 font-bold">{t('il.statusPending')}</span>
    if (ilan.status === 'rejected') return <span className="text-[#b91c1c] font-bold">{t('il.statusRejected')} {ilan.rejection_reason ? `— ${ilan.rejection_reason}` : ''}</span>
    if (ilan.status === 'cancelled') return <span className="text-[#64748b] font-bold">{t('il.statusCancelled')}</span>
    if (ilan.is_paused) return <span className="text-amber-700 font-bold">{t('il.pausedBadge')}</span>
    if (new Date(ilan.ends_at).getTime() < now) return <span className="text-[#64748b] font-bold">{t('il.ended')}</span>
    if (new Date(ilan.starts_at).getTime() > now) return <span className="text-blue-700 font-bold">{t('il.scheduled')}</span>
    return <span className="text-emerald-700 font-bold">{t('il.live')}</span>
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicleId) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Megaphone size={19} /> {t('mv.tab.ilan')}</h1>
        <button onClick={() => setShowForm((v) => !v)} className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-semibold cursor-pointer">
          <Plus size={14} /> {t('il.newIlanBtn')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5 flex flex-col gap-2.5">
          <p className="font-sans text-[13px] font-bold text-[#1e293b]">{t('il.heading')}</p>

          <div className="flex gap-2">
            <button type="button" onClick={() => { setPlacement('ticker'); setQuote(null) }} className={`flex-1 py-2 rounded-lg font-sans text-[12.5px] font-bold cursor-pointer ${placement === 'ticker' ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>{t('il.placement.ticker')}</button>
            <button type="button" onClick={() => { setPlacement('banner'); setQuote(null) }} className={`flex-1 py-2 rounded-lg font-sans text-[12.5px] font-bold cursor-pointer ${placement === 'banner' ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>{t('il.placement.banner')}</button>
          </div>

          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('il.villagesLabel')}</label>
            <div className="flex flex-wrap gap-1.5">
              {tenants.map((tn) => (
                <label key={tn.id} className={`px-2.5 py-1.5 rounded-full font-sans text-[12px] cursor-pointer border-2 ${picked.has(tn.id) ? 'border-[#166534] bg-[#166534]/10 text-[#166534] font-bold' : 'border-[#e5e2d0] text-[#64748b]'}`}>
                  <input type="checkbox" checked={picked.has(tn.id)} onChange={() => togglePick(tn.id)} className="sr-only" />
                  {isUrdu && tn.name_ur ? tn.name_ur : tn.name}
                </label>
              ))}
            </div>
          </div>

          <input value={titleUr} onChange={(e) => setTitleUr(e.target.value)} placeholder={t('il.titleUrPlaceholder')} dir="rtl" className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          <input value={titleEn} onChange={(e) => setTitleEn(e.target.value)} placeholder={t('il.titleEnPlaceholder')} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          <textarea value={bodyUr} onChange={(e) => setBodyUr(e.target.value)} placeholder={t('il.bodyUrPlaceholder')} dir="rtl" rows={2} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] resize-none" />
          <textarea value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} placeholder={t('il.bodyEnPlaceholder')} rows={2} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] resize-none" />
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder={t('il.contactPlaceholder')} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('il.startLabel')}</label>
              <input type="datetime-local" value={startsAt} onChange={(e) => { setStartsAt(e.target.value); setQuote(null) }} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
            <div>
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('il.endLabel')}</label>
              <input type="datetime-local" value={endsAt} onChange={(e) => { setEndsAt(e.target.value); setQuote(null) }} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </div>
          </div>

          <button onClick={runQuote} disabled={quoting} className="px-3 py-2 rounded-lg border border-[#166534] text-[#166534] font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
            {quoting ? '...' : t('il.quotedPriceLabel')}{quote != null ? `: ₨${fmt(quote)}` : ''}
          </button>

          <button onClick={submit} disabled={submitting} className="px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {t('il.submitRequestBtn')}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em]">{t('il.myIlansHeading')}</p>
        {ilans.length === 0 && <p className="font-sans text-[13px] text-[#94a3b8] text-center py-6">{t('il.noIlansYet')}</p>}
        {ilans.map((ilan) => (
          <div key={ilan.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-sans text-[13.5px] font-semibold text-[#1e293b] truncate" dir="rtl">{ilan.title_ur}</p>
                <p className="font-sans text-[12px] text-[#64748b] mt-0.5">
                  {ilan.placement === 'ticker' ? t('il.placement.ticker') : t('il.placement.banner')} · ₨{fmt(ilan.price_pkr)} · {ilan.target_tenant_ids.length} {t('il.villagesLabel')}
                </p>
                <p className="font-sans text-[11.5px] mt-1">{statusBadge(ilan)}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {ilan.status === 'pending_approval' && (
                  <button onClick={() => cancelIlan(ilan.id)} className="p-1.5 rounded-lg border border-[#e5e2d0] text-[#b91c1c] cursor-pointer"><X size={14} /></button>
                )}
                {ilan.status === 'approved' && new Date(ilan.ends_at).getTime() > Date.now() && (
                  ilan.is_paused
                    ? <button onClick={() => resumeIlan(ilan.id)} className="p-1.5 rounded-lg border border-[#e5e2d0] text-[#166534] cursor-pointer"><Play size={14} /></button>
                    : <button onClick={() => pauseIlan(ilan.id)} className="p-1.5 rounded-lg border border-[#e5e2d0] text-amber-700 cursor-pointer"><Pause size={14} /></button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
