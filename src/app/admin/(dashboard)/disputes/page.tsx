'use client'

// Disputes queue (485), per the v2 design handoff (§2.5 item 4): five
// places rider/customer and driver/vehicle can disagree about money
// (fare, damaged goods, no-show, shadi withdrawal, hourly overage) and,
// until now, no screen where the committee actually settles it.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { Scale, User, Truck } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Dispute {
  id: string; kind: string; ref_type: string; ref_id: string
  claimed_amount_pkr: number | null; agreed_amount_pkr: number | null
  note: string; status: 'open' | 'closed'; ruling: 'rider' | 'driver' | null; resolution_note: string | null
  created_at: string; resolved_at: string | null
  filed_by_name: string; filed_by_mobile: string | null
  ref_summary: Record<string, string | number | null> | null
}

function fmt(n: number | null) {
  if (n == null) return '—'
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function AdminDisputesPage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [tab, setTab] = useState<'open' | 'closed'>('open')
  const [rows, setRows] = useState<Dispute[]>([])
  const [loading, setLoading] = useState(true)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [pendingRuling, setPendingRuling] = useState<'rider' | 'driver' | null>(null)
  const [resolutionNote, setResolutionNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async (status: 'open' | 'closed') => {
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_disputes', { p_status: status })
    if (error) toast.error(friendlyError(error, undefined, isUrdu))
    setRows((data ?? []) as Dispute[])
    setLoading(false)
  }
  useEffect(() => { load(tab) }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const startResolve = (id: string, ruling: 'rider' | 'driver') => {
    setResolvingId(id); setPendingRuling(ruling); setResolutionNote('')
  }

  const confirmResolve = async () => {
    if (!resolvingId || !pendingRuling) return
    setSaving(true)
    const { error } = await supabase.rpc('admin_resolve_dispute', {
      p_dispute_id: resolvingId, p_ruling: pendingRuling, p_resolution_note: resolutionNote.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('g.saveChanges'))
    setResolvingId(null); setPendingRuling(null); setResolutionNote('')
    load(tab)
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('dq.noAccessMessage')}</p></div>
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><Scale size={26} /> {t('dq.pageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('dq.pageSubtitle')}</p>
      </div>

      <div className="flex items-center gap-1 bg-dp-surface-container rounded-lg p-1 mb-5 w-fit">
        <button onClick={() => setTab('open')} className={`px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'open' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}>{t('dq.openTab')}</button>
        <button onClick={() => setTab('closed')} className={`px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === 'closed' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}>{t('dq.closedTab')}</button>
      </div>

      {loading && <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>}
      {!loading && rows.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('dq.noResults')}</p>}

      <div className="space-y-3">
        {rows.map((d) => (
          <div key={d.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t(`dq.kind.${d.kind}`)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
                  {new Date(d.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {d.ref_summary?.vehicle_owner && <> · <Truck size={11} className="inline -mt-0.5" /> {d.ref_summary.vehicle_owner}</>}
                  {d.ref_summary?.shop_name && <> · {d.ref_summary.shop_name}</>}
                </p>
              </div>
              <div className="text-end shrink-0">
                {d.claimed_amount_pkr != null && <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('dq.claimedAmount')}: <span className="font-bold text-dp-secondary ltr-num">{fmt(d.claimed_amount_pkr)}</span></p>}
                {d.agreed_amount_pkr != null && <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('dq.agreedAmount')}: <span className="ltr-num">{fmt(d.agreed_amount_pkr)}</span></p>}
              </div>
            </div>

            <p className="font-sans text-[13px] text-dp-on-surface mt-2 pt-2 border-t border-dp-outline-variant">{d.note}</p>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5 flex items-center gap-1"><User size={11} /> {t('dq.filedBy')}: {d.filed_by_name}{d.filed_by_mobile ? ` · ${d.filed_by_mobile}` : ''}</p>

            {d.status === 'closed' ? (
              <div className="mt-2.5 pt-2.5 border-t border-dp-outline-variant">
                <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{t('dq.ruledFor')}: {t(`dq.ruling.${d.ruling}`)}</p>
                {d.resolution_note && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{d.resolution_note}</p>}
              </div>
            ) : resolvingId === d.id ? (
              <div className="mt-2.5 pt-2.5 border-t border-dp-outline-variant space-y-2">
                <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{t('dq.ruledFor')}: {pendingRuling && t(`dq.ruling.${pendingRuling}`)}</p>
                <textarea value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} placeholder={t('dq.resolutionNotePlaceholder')} className="input-field" rows={2} />
                <div className="flex gap-2">
                  <button onClick={() => setResolvingId(null)} className="flex-1 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                  <button onClick={confirmResolve} disabled={saving} className="flex-1 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{saving ? t('action.saving') : t('dq.resolveBtn')}</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant">
                <button onClick={() => startResolve(d.id, 'rider')} className="flex-1 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-surface-container">{t('dq.ruleRiderBtn')}</button>
                <button onClick={() => startResolve(d.id, 'driver')} className="flex-1 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-surface-container">{t('dq.ruleDriverBtn')}</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
