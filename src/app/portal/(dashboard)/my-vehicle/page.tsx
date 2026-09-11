'use client'

// Driver dashboard — wallet + earnings + today's ledger + chat inbox only.
// Everything else that used to live on this one page (adda, routes,
// trips, dispatch/city-purchase requests, delivery settings, weekend
// offers) now has its own screen under this layout, matching the design
// zip's own screen split instead of one long scrolling page.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Wallet, MessageCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { WalletTopupModal } from '@/components/portal/WalletTopupModal'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Summary {
  balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null
  today_earnings_pkr: number; month_earnings_pkr: number; today_jobs_count: number; month_jobs_count: number; pending_bookings_count: number
  last_settlement_date: string | null; last_settlement_amount: number | null
}
interface LedgerRow { kind: string; label: string; amount: number; at: string }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleDashboardPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [showTopup, setShowTopup] = useState(false)
  const [negotiationInbox, setNegotiationInbox] = useState<{ id: string; kind: string; status: string; item: string | null; last_message: string | null; as_role: string }[]>([])

  const reload = async (id: string) => {
    const [{ data: s }, { data: led }, { data: inbox }] = await Promise.all([
      supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: id }),
      supabase.rpc('vehicle_today_ledger', { p_vehicle_id: id }),
      supabase.rpc('my_negotiation_threads'),
    ])
    setSummary(s as unknown as Summary)
    setLedger((led ?? []) as LedgerRow[])
    setNegotiationInbox(((inbox ?? []) as typeof negotiationInbox).filter((th) => th.as_role === 'driver'))
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) { setVehicleId(data.id); await reload(data.id) }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicleId) return null // layout's own guard already handled the no-vehicle case

  return (
    <div>
      <div className="flex items-center gap-1 bg-white border border-dp-outline-variant rounded-lg p-1 mb-3 w-fit">
        <span className={`px-3 py-1.5 rounded-md text-[12px] font-sans font-semibold ${summary?.commission_mode === 'monthly_lumpsum' ? 'bg-dp-primary text-white' : 'text-dp-on-surface-variant'}`}>{t('mv.lumpsumModeLabel')}</span>
        <span className={`px-3 py-1.5 rounded-md text-[12px] font-sans font-semibold ${summary?.commission_mode === 'per_order' ? 'bg-dp-primary text-white' : 'text-dp-on-surface-variant'}`}>{t('mv.perOrderModeLabel')}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-dp-secondary rounded-lg p-4">
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-white/75">{t('mv.thisMonthLabel')}</p>
          <p className="font-heading text-[24px] font-bold text-white mt-1 ltr-num">{fmt(summary?.month_earnings_pkr ?? 0)}</p>
          <p className="font-sans text-[11.5px] text-white/75 mt-0.5 ltr-num">{summary?.month_jobs_count ?? 0} {t('mv.jobsSuffix')}</p>
        </div>
        <div className="bg-dp-primary rounded-lg p-4">
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-white/75">{t('mv.todayLabel')}</p>
          <p className="font-heading text-[24px] font-bold text-white mt-1 ltr-num">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
          <p className="font-sans text-[11.5px] text-white/75 mt-0.5 ltr-num">{summary?.today_jobs_count ?? 0} {t('mv.jobsSuffix')}</p>
        </div>
      </div>

      <div className={`rounded-lg p-3.5 mb-3 border ${(summary?.balance_pkr ?? 0) < 0 ? 'bg-amber-50 border-amber-300' : 'bg-white border-dp-outline-variant'}`}>
        <div className="flex items-center justify-between gap-2">
          {(summary?.balance_pkr ?? 0) < 0 && <span className="font-sans text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-200 text-amber-900">{summary?.pending_bookings_count ?? 0} {t('cm.pendingOrdersTag')}</span>}
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant ms-auto">{t('cm.balanceLabel')}</p>
        </div>
        <p className={`font-heading text-[26px] font-bold mt-1 ltr-num ${(summary?.balance_pkr ?? 0) < 0 ? 'text-amber-700' : 'text-dp-primary'}`}>{fmt(summary?.balance_pkr ?? 0)}</p>
        {summary?.commission_mode === 'per_order' && (
          <button onClick={() => setShowTopup(true)} className="w-full mt-2.5 flex items-center justify-center gap-1.5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
            <Wallet size={14} /> {t('cm.topupWalletBtn')}
          </button>
        )}
        {summary?.commission_mode === 'per_order' && (summary?.balance_pkr ?? 0) < 0 && (
          <p className="font-sans text-[12px] text-amber-800 mt-1.5">{t('mv.negativeBalanceNote')}</p>
        )}
      </div>

      {summary?.commission_mode === 'monthly_lumpsum' && (
        <div className="bg-violet-50 border border-violet-200 rounded-lg p-3.5 mb-6">
          <p className="font-sans text-[13px] text-violet-900">{t('cm.onLumpsumNote')} <span className="font-bold ltr-num">{fmt(summary.lumpsum_fee_pkr ?? 0)}</span></p>
        </div>
      )}

      {summary?.last_settlement_date && (
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-6">{t('cm.lastSettlementLabel')} <span className="font-semibold text-dp-on-surface">{fmt(summary.last_settlement_amount ?? 0)}</span> — {new Date(summary.last_settlement_date).toLocaleDateString('en-GB')}</p>
      )}

      {ledger.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mv.todaysLedgerHeading')}</p>
          <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant/60">
            {ledger.map((row, i) => (
              <div key={i} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{row.label}</p>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-0.5">{t(`mv.ledgerKind.${row.kind}`)} · {new Date(row.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                </div>
                <p className="font-sans text-[13.5px] font-bold text-dp-on-surface shrink-0 ltr-num">{fmt(row.amount)}</p>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 p-3 bg-dp-surface-container/60">
              <p className="font-sans text-[13px] font-bold text-dp-on-surface">{t('mv.totalReceivedLabel')}</p>
              <p className="font-sans text-[14px] font-bold text-dp-secondary ltr-num">{fmt(ledger.reduce((sum, r) => sum + Number(r.amount || 0), 0))}</p>
            </div>
          </div>
          <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1.5 leading-[1.7]">{t('mv.ledgerFootnote')}</p>
        </div>
      )}

      {negotiationInbox.length > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><MessageCircle size={13} /> {t('vp.myConversationsTitle')}</p>
          <div className="space-y-2">
            {negotiationInbox.map((th) => (
              <Link key={th.id} href={`/portal/marketplace/negotiations/${th.id}`} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3 hover:border-dp-secondary transition-colors">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{th.item}</p>
                <span className={`shrink-0 text-[11px] font-bold ${th.status === 'open' ? 'text-amber-700' : th.status === 'agreed' ? 'text-emerald-700' : 'text-dp-on-surface-variant'}`}>{t(`vp.${th.status}StatusLabel`)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {showTopup && (
        <WalletTopupModal kind="vehicle" sellerId={vehicleId} onClose={() => setShowTopup(false)} onSubmitted={() => { setShowTopup(false); reload(vehicleId) }} />
      )}
    </div>
  )
}
