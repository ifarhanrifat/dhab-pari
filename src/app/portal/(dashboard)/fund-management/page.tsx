'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Gift, Landmark, CheckCircle2, Trash2 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface SalamiAccount {
  id: string; event_id: string; side: string; family_name: string; payment_method: string
  account_number: string; account_title: string | null; village_events: { title: string; title_ur: string | null } | null
}
interface ChandaCampaign {
  id: string; title: string; title_ur: string | null; payment_method: string; account_number: string; account_title: string | null
}
interface Pledge { id: string; giver_name: string; giver_mobile: string | null; amount: number; message: string | null; status: string; receipt_url: string | null }

// Phase 3, 2026-10-01. Real security correction: "this link part is
// unsecure what if it get leaked... instead we just ask them any portal
// account so that we will just link this to and the tab of this link
// will be appear in there portals" — replaces the manage_token link
// (540/548) with a real portal account an admin links directly
// (migration 554). Everything here is a plain RLS-protected query, no
// token/RPC involved — the person is authenticated by their own portal
// login.
export default function FundManagementPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [salamiAccounts, setSalamiAccounts] = useState<SalamiAccount[]>([])
  const [chandaCampaigns, setChandaCampaigns] = useState<ChandaCampaign[]>([])
  const [salamiPledges, setSalamiPledges] = useState<Record<string, Pledge[]>>({})
  const [chandaPledges, setChandaPledges] = useState<Record<string, Pledge[]>>({})
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const load = async () => {
    if (!user) return
    const [{ data: sa }, { data: cc }] = await Promise.all([
      supabase.from('event_salami_accounts').select('id, event_id, side, family_name, payment_method, account_number, account_title, village_events(title, title_ur)').eq('manager_portal_user_id', user.id),
      supabase.from('chanda_campaigns').select('id, title, title_ur, payment_method, account_number, account_title').eq('manager_portal_user_id', user.id),
    ])
    const accounts = (sa ?? []) as unknown as SalamiAccount[]
    const campaigns = (cc ?? []) as ChandaCampaign[]
    setSalamiAccounts(accounts); setChandaCampaigns(campaigns)

    const sp: Record<string, Pledge[]> = {}
    for (const a of accounts) {
      const { data } = await supabase.from('event_salami_pledges').select('id, giver_name, giver_mobile, amount, message, status, receipt_url').eq('event_id', a.event_id).eq('side', a.side).order('status', { ascending: true }).order('created_at', { ascending: false })
      sp[a.id] = (data ?? []) as Pledge[]
    }
    setSalamiPledges(sp)

    const cp: Record<string, Pledge[]> = {}
    for (const c of campaigns) {
      const { data } = await supabase.from('chanda_pledges').select('id, giver_name, giver_mobile, amount, message, status, receipt_url').eq('campaign_id', c.id).order('status', { ascending: true }).order('created_at', { ascending: false })
      cp[c.id] = (data ?? []) as Pledge[]
    }
    setChandaPledges(cp)
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const markSalamiReceived = async (id: string) => {
    const { error } = await supabase.from('event_salami_pledges').update({ status: 'received', confirmed_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.markedReceived')); load()
  }
  const deleteSalamiPledge = async (id: string) => {
    if (!confirm(t('sl.confirmDeletePledge'))) return
    const { error } = await supabase.from('event_salami_pledges').delete().eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.pledgeDeleted')); load()
  }
  const markChandaReceived = async (id: string) => {
    const { error } = await supabase.from('chanda_pledges').update({ status: 'received', confirmed_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.markedReceived')); load()
  }
  const deleteChandaPledge = async (id: string) => {
    if (!confirm(t('sl.confirmDeletePledge'))) return
    const { error } = await supabase.from('chanda_pledges').delete().eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.pledgeDeleted')); load()
  }

  const pledgeRow = (p: Pledge, onReceive: () => void, onDelete: () => void) => (
    <div key={p.id} className={`bg-white border rounded-lg p-3.5 flex items-center justify-between gap-3 ${p.status === 'pending' ? 'border-amber-200' : 'border-dp-outline-variant'}`}>
      <div className="min-w-0">
        <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{p.giver_name}{p.giver_mobile ? ` · ${p.giver_mobile}` : ''}</p>
        {p.message && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{p.message}</p>}
        <p className={`font-sans text-[14px] font-bold mt-1 ltr-num ${p.status === 'received' ? 'text-emerald-700' : 'text-amber-700'}`}>{Number(p.amount).toLocaleString()}</p>
      </div>
      {p.status === 'pending' && (
        <div className="flex gap-1.5 shrink-0">
          <button onClick={onReceive} title={t('sl.markReceived')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700"><CheckCircle2 size={15} /></button>
          <button onClick={onDelete} title={t('sl.deletePledge')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><Trash2 size={15} /></button>
        </div>
      )}
    </div>
  )

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  const hasNothing = salamiAccounts.length === 0 && chandaCampaigns.length === 0

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2 mb-2"><Landmark size={22} className="text-dp-secondary" /> {t('fnd.pageTitle')}</h1>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('fnd.pageIntro')}</p>

      {hasNothing ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center max-w-xl">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('fnd.noneManaged')}</p>
        </div>
      ) : (
        <div className="space-y-8 max-w-2xl">
          {salamiAccounts.length > 0 && (
            <div>
              <h2 className="font-heading text-[18px] font-bold text-dp-on-surface flex items-center gap-2 mb-3"><Gift size={18} className="text-dp-secondary" /> {t('fnd.weddingSalamiSection')}</h2>
              <div className="space-y-4">
                {salamiAccounts.map((a) => (
                  <div key={a.id} className="bg-dp-surface-container-low rounded-lg p-4">
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">{a.family_name} — {t(`sl.side.${a.side}`)}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">{a.village_events ? (isUrdu && a.village_events.title_ur ? a.village_events.title_ur : a.village_events.title) : ''}</p>
                    <div className="space-y-2">
                      {(salamiPledges[a.id] ?? []).map((p) => pledgeRow(p, () => markSalamiReceived(p.id), () => deleteSalamiPledge(p.id)))}
                      {(salamiPledges[a.id] ?? []).length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('sl.noneYet')}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {chandaCampaigns.length > 0 && (
            <div>
              <h2 className="font-heading text-[18px] font-bold text-dp-on-surface flex items-center gap-2 mb-3"><Landmark size={18} className="text-dp-secondary" /> {t('fnd.chandaSection')}</h2>
              <div className="space-y-4">
                {chandaCampaigns.map((c) => (
                  <div key={c.id} className="bg-dp-surface-container-low rounded-lg p-4">
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">{isUrdu && c.title_ur ? c.title_ur : c.title}</p>
                    <div className="space-y-2 mt-3">
                      {(chandaPledges[c.id] ?? []).map((p) => pledgeRow(p, () => markChandaReceived(p.id), () => deleteChandaPledge(p.id)))}
                      {(chandaPledges[c.id] ?? []).length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('sl.noneYet')}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
