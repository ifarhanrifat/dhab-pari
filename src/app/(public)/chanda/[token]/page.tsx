'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Landmark, CheckCircle2, Trash2 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface CampaignInfo { id: string; type: string; title: string; payment_method: string; account_number: string; account_title: string | null; bank_name: string | null }
interface Pledge { id: string; giver_name: string; giver_mobile: string | null; amount: number; message: string | null; status: string; created_at: string; confirmed_at: string | null }

// Phase 3, 2026-10-01. Private committee-side page for a Chanda campaign
// -- reached only via the manage_token link an admin shares directly
// (migration 548), same no-login pattern as /salami/[token].
export default function ChandaManagePage() {
  const { token } = useParams<{ token: string }>()
  const { t, isUrdu } = useLocale()
  const [campaign, setCampaign] = useState<CampaignInfo | null>(null)
  const [pledges, setPledges] = useState<Pledge[]>([])
  const [loading, setLoading] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const { data: c, error: cErr } = await supabase.rpc('chanda_campaign_by_token', { p_token: token }).maybeSingle()
    if (cErr || !c) { setInvalid(true); setLoading(false); return }
    setCampaign(c as CampaignInfo)
    const { data: p } = await supabase.rpc('chanda_manager_pledges', { p_token: token })
    setPledges((p ?? []) as Pledge[])
    setLoading(false)
  }
  useEffect(() => { load() }, [token])

  const markReceived = async (id: string) => {
    const { error } = await supabase.rpc('chanda_mark_received', { p_token: token, p_pledge_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.markedReceived'))
    load()
  }
  const remove = async (id: string) => {
    if (!confirm(t('sl.confirmDeletePledge'))) return
    const { error } = await supabase.rpc('chanda_delete_pledge', { p_token: token, p_pledge_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.pledgeDeleted'))
    load()
  }

  if (loading) return <div className="text-center py-20 text-dp-on-surface-variant"><LoadingDots /></div>
  if (invalid || !campaign) return <div className="max-w-md mx-auto py-20 px-6 text-center font-sans text-[14px] text-dp-on-surface-variant">{t('sl.invalidLink')}</div>

  const pending = pledges.filter((p) => p.status === 'pending')
  const received = pledges.filter((p) => p.status === 'received')
  const receivedTotal = received.reduce((s, p) => s + Number(p.amount), 0)
  const pendingTotal = pending.reduce((s, p) => s + Number(p.amount), 0)

  return (
    <div className="max-w-[700px] mx-auto px-6 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Landmark size={24} className="text-dp-secondary" />
        <h1 className="font-heading text-[24px] font-bold text-dp-primary">{campaign.title}</h1>
      </div>
      <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-6">{t('sl.managePageIntro')}</p>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-emerald-50 rounded-lg p-3.5"><p className="text-emerald-700 font-bold font-sans text-[15px] ltr-num">{receivedTotal.toLocaleString()}</p><p className="text-emerald-600 font-sans text-[12px]">{t('sl.confirmed')} · {received.length}</p></div>
        <div className="bg-amber-50 rounded-lg p-3.5"><p className="text-amber-700 font-bold font-sans text-[15px] ltr-num">{pendingTotal.toLocaleString()}</p><p className="text-amber-600 font-sans text-[12px]">{t('sl.pending')} · {pending.length}</p></div>
      </div>

      {pending.length > 0 && (
        <>
          <h2 className="font-heading text-[16px] font-bold text-dp-on-surface mb-3">{t('sl.pending')}</h2>
          <div className="space-y-2 mb-6">
            {pending.map((p) => (
              <div key={p.id} className="bg-white border border-amber-200 rounded-lg p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{p.giver_name}{p.giver_mobile ? ` · ${p.giver_mobile}` : ''}</p>
                  {p.message && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{p.message}</p>}
                  <p className="font-sans text-[15px] font-bold text-amber-700 mt-1 ltr-num">{Number(p.amount).toLocaleString()}</p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => markReceived(p.id)} title={t('sl.markReceived')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700"><CheckCircle2 size={15} /></button>
                  <button onClick={() => remove(p.id)} title={t('sl.deletePledge')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><Trash2 size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="font-heading text-[16px] font-bold text-dp-on-surface mb-3">{t('sl.confirmed')}</h2>
      {received.length === 0 ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('sl.noneYet')}</p>
      ) : (
        <div className="space-y-2">
          {received.map((p) => (
            <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3">
              <p className="font-sans text-[13.5px] text-dp-on-surface">{p.giver_name}{p.giver_mobile ? ` · ${p.giver_mobile}` : ''}</p>
              <span className="font-sans text-[14px] font-bold text-emerald-700 ltr-num">{Number(p.amount).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
