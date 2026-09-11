'use client'

// Marketplace reputation complaints (497) — deliberately separate from
// /admin/complaints, which is the donor/villager complaint-ticket system
// (063) and shares nothing with this one beyond the English word. A
// complaint here is filed against a vehicle/shop/rider, not a donor
// pledge, and resolving it can immediately block a vehicle (wrong-
// vehicle/wrong-driver, upheld) rather than just closing a ticket.

import { useEffect, useState } from 'react'
import { ShieldAlert, CheckCircle2, XCircle, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Complaint {
  id: string; kind: string; note: string; is_urgent: boolean; status: string
  against_party_type: string; against_party_id: string; against_name: string | null
  filed_by_name: string | null; ref_type: string | null; ref_id: string | null
  resolution_note: string | null; resolved_at: string | null; created_at: string
}

export default function PartyComplaintsPage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [tab, setTab] = useState<'open' | 'upheld' | 'dismissed'>('open')
  const [complaints, setComplaints] = useState<Complaint[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [noteById, setNoteById] = useState<Record<string, string>>({})

  const load = async (status: string) => {
    setLoading(true)
    const { data } = await supabase.rpc('admin_list_complaints', { p_status: status })
    setComplaints((data ?? []) as Complaint[])
    setLoading(false)
  }
  useEffect(() => { load(tab) }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const resolve = async (c: Complaint, status: 'upheld' | 'dismissed', block: boolean) => {
    if (block && !window.confirm(t('pc.confirmBlockOnResolve'))) return
    setBusyId(c.id)
    const { error } = await supabase.rpc('admin_resolve_complaint', {
      p_complaint_id: c.id, p_status: status, p_resolution_note: noteById[c.id] || null, p_block: block,
    })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(status === 'upheld' ? t('pc.upheldToast') : t('pc.dismissedToast'))
    load(tab)
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('mr.noAccessMessage')}</p></div>
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><ShieldAlert size={28} /> {t('nav.partyComplaints')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('pc.pageSubtitle')}</p>
      </div>

      <div className="flex items-center gap-1 bg-dp-surface-container rounded-lg p-1 mb-5 w-fit">
        {(['open', 'upheld', 'dismissed'] as const).map((s) => (
          <button key={s} onClick={() => setTab(s)} className={`px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === s ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}>
            {t(`pc.tab.${s}`)}
          </button>
        ))}
      </div>

      {loading && <p className="font-sans text-[13px] text-dp-on-surface-variant"><LoadingDots /></p>}
      {!loading && complaints.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('pc.noneNote')}</p>}

      <div className="space-y-3">
        {complaints.map((c) => (
          <div key={c.id} className={`bg-white border rounded-lg p-4 ${c.is_urgent && c.status === 'open' ? 'border-dp-error' : 'border-dp-outline-variant'}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {c.is_urgent && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-dp-error">{t('pc.urgentBadge')}</span>}
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t(`pc.kind.${c.kind}`)}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container">{t(`pc.partyType.${c.against_party_type}`)}: {c.against_name ?? '—'}</span>
                </div>
                <p className="font-sans text-[13.5px] text-dp-on-surface mt-2">{c.note}</p>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pc.filedByLabel')}: {c.filed_by_name ?? '—'} · {new Date(c.created_at).toLocaleDateString()}</p>
                {c.resolution_note && <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 italic">{t('pc.resolutionNoteLabel')}: {c.resolution_note}</p>}
              </div>
            </div>

            {c.status === 'open' && (
              <div className="mt-3 pt-3 border-t border-dp-outline-variant/60 space-y-2">
                <input value={noteById[c.id] ?? ''} onChange={(e) => setNoteById({ ...noteById, [c.id]: e.target.value })} placeholder={t('pc.resolutionNotePlaceholder')} className="input-field" />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button onClick={() => resolve(c, 'dismissed', false)} disabled={busyId === c.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50"><XCircle size={13} /> {t('pc.dismissBtn')}</button>
                  <button onClick={() => resolve(c, 'upheld', false)} disabled={busyId === c.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50"><CheckCircle2 size={13} /> {t('pc.upholdBtn')}</button>
                  {c.against_party_type === 'vehicle' && (
                    <button onClick={() => resolve(c, 'upheld', true)} disabled={busyId === c.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-dp-error text-white hover:opacity-90 disabled:opacity-50"><Ban size={13} /> {t('pc.upholdAndBlockBtn')}</button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
