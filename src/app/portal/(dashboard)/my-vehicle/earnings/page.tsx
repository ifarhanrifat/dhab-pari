'use client'

// Driver Earnings — the design file's own `driver:earn` screen (today's
// total, a by-service breakdown, then full history), plus this app's own
// real additions the file has no equivalent for: a wallet balance and
// commission mode, since real commission is actually owed money, not a
// toy demo number. Moved here unchanged in substance from the old
// my-vehicle/page.tsx dashboard — only the chrome and classes changed.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Wallet, MessageCircle, Lock } from 'lucide-react'
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
interface PendingTopup { id: string; amount_pkr: number; announced_at: string }
interface StatementRow { id: string; voucher_no: string; date: string; particular: string; amount_pkr: number; direction: 'debit' | 'credit'; created_at: string }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleEarningsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [ownerMobile, setOwnerMobile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [pendingTopups, setPendingTopups] = useState<PendingTopup[]>([])
  const [showTopup, setShowTopup] = useState(false)
  const [negotiationInbox, setNegotiationInbox] = useState<{ id: string; kind: string; status: string; item: string | null; last_message: string | null; as_role: string }[]>([])
  const [statement, setStatement] = useState<StatementRow[]>([])
  const [showStatement, setShowStatement] = useState(false)

  const reload = async (id: string) => {
    const [{ data: s }, { data: led }, { data: inbox }, { data: topups }, { data: stmt }] = await Promise.all([
      supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: id }),
      supabase.rpc('vehicle_today_ledger', { p_vehicle_id: id }),
      supabase.rpc('my_negotiation_threads'),
      supabase.from('vehicle_wallet_topups').select('id, amount_pkr, announced_at').eq('vehicle_id', id).eq('status', 'announced').order('announced_at', { ascending: false }),
      supabase.rpc('vehicle_wallet_statement', { p_vehicle_id: id }),
    ])
    setSummary(s as unknown as Summary)
    setLedger((led ?? []) as LedgerRow[])
    setNegotiationInbox(((inbox ?? []) as typeof negotiationInbox).filter((th) => th.as_role === 'driver'))
    setPendingTopups((topups ?? []) as PendingTopup[])
    setStatement((stmt ?? []) as StatementRow[])
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_mobile').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) { setVehicleId(data.id); setOwnerMobile(data.owner_mobile); await reload(data.id) }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicleId) return null

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] text-[#005A36]">{t('mb.navEarnings')}</h1>

      <div className="flex items-center gap-2 bg-white border border-[#e5e2d0] rounded-xl p-2.5 w-fit">
        <Lock size={13} className="text-[#64748b] shrink-0" />
        <span className="font-sans text-[12px] font-semibold text-[#1e293b]">{summary?.commission_mode === 'monthly_lumpsum' ? t('mv.lumpsumModeLabel') : t('mv.perOrderModeLabel')}</span>
        <span className="font-sans text-[10.5px] text-[#64748b]">· {t('vp.billingModeLockNote')}</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="bg-[#166534] rounded-2xl p-4">
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-white/75">{t('mv.thisMonthLabel')}</p>
          <p className="font-bold text-[22px] text-white mt-1 ltr-num">{fmt(summary?.month_earnings_pkr ?? 0)}</p>
          <p className="font-sans text-[11.5px] text-white/75 mt-0.5 ltr-num">{summary?.month_jobs_count ?? 0} {t('mv.jobsSuffix')}</p>
        </div>
        <div className="bg-[#005A36] rounded-2xl p-4">
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-white/75">{t('mv.todayLabel')}</p>
          <p className="font-bold text-[22px] text-white mt-1 ltr-num">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
          <p className="font-sans text-[11.5px] text-white/75 mt-0.5 ltr-num">{summary?.today_jobs_count ?? 0} {t('mv.jobsSuffix')}</p>
        </div>
      </div>

      <div className="rounded-2xl p-3.5 border" style={{ background: (summary?.balance_pkr ?? 0) < 0 ? '#fffbeb' : '#fff', borderColor: (summary?.balance_pkr ?? 0) < 0 ? '#fde68a' : '#e5e2d0' }}>
        <div className="flex items-center justify-between gap-2">
          {(summary?.balance_pkr ?? 0) < 0 && <span className="font-sans text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-200 text-amber-900">{summary?.pending_bookings_count ?? 0} {t('cm.pendingOrdersTag')}</span>}
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] ms-auto">{t('cm.balanceLabel')}</p>
        </div>
        <p className="font-bold text-[24px] mt-1 ltr-num" style={{ color: (summary?.balance_pkr ?? 0) < 0 ? '#92400e' : '#005A36' }}>{fmt(summary?.balance_pkr ?? 0)}</p>
        {summary?.commission_mode === 'per_order' && (
          <button onClick={() => setShowTopup(true)} className="w-full mt-2.5 flex items-center justify-center gap-1.5 py-2.5 bg-[#166534] text-white rounded-xl font-sans text-[13px] font-semibold cursor-pointer">
            <Wallet size={14} /> {t('cm.topupWalletBtn')}
          </button>
        )}
        {summary?.commission_mode === 'per_order' && (summary?.balance_pkr ?? 0) < 0 && (
          <p className="font-sans text-[12px] text-amber-800 mt-1.5">{t('mv.negativeBalanceNote')}</p>
        )}
      </div>

      {pendingTopups.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {pendingTopups.map((tu) => (
            <div key={tu.id} className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <span className="text-[14px]">⏳</span>
              <span className="flex-1 font-sans text-[12px] font-semibold text-amber-800">{t('mv.topupVerifyingNote')}</span>
              <span className="font-sans text-[12.5px] font-extrabold text-amber-900 ltr-num">{fmt(tu.amount_pkr)}</span>
            </div>
          ))}
        </div>
      )}

      {ownerMobile && (
        <div className="flex items-center gap-2.5 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="shrink-0 w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center text-[16px]">📱</span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[11px] text-[#64748b]">{t('mv.myEasypaisaAccountLabel')}</p>
            <p className="font-sans text-[13.5px] font-bold text-[#1e293b] ltr-num">{ownerMobile}</p>
          </div>
        </div>
      )}

      {summary?.commission_mode === 'monthly_lumpsum' && (
        <div className="bg-violet-50 border border-violet-200 rounded-2xl p-3.5">
          <p className="font-sans text-[13px] text-violet-900">{t('cm.onLumpsumNote')} <span className="font-bold ltr-num">{fmt(summary.lumpsum_fee_pkr ?? 0)}</span></p>
        </div>
      )}

      {/* Real ask, 2026-10-27: "where in the driver wallet and account
          I can see that deposited payment? Where it has been
          recorded?" — the balance number above was already live, but
          nowhere in the app showed WHY it changed: no top-up log, no
          commission log, nothing beyond the one running number. This
          reads back every real voucher that's ever touched this
          vehicle's own ledger account (vehicle_wallet_statement, 739)
          — top-ups, per-order commission, route/trip posting stakes —
          the same real data the balance card itself is computed from. */}
      <div>
        <p className="font-sans text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-1.5">{t('mv.walletStatementHeading')}</p>
        {statement.length === 0 ? (
          <p className="font-sans text-[12.5px] text-[#64748b]">{t('mv.noTransactionsYetNote')}</p>
        ) : (
          <>
            <div className="bg-white border border-[#e5e2d0] rounded-2xl divide-y divide-[#f1f5f9]">
              {(showStatement ? statement : statement.slice(0, 6)).map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{row.particular}</p>
                    <p className="font-sans text-[10.5px] text-[#94a3b8] mt-0.5 ltr-num">{row.voucher_no} · {new Date(row.date).toLocaleDateString('en-GB')}</p>
                  </div>
                  <p className={`font-sans text-[13.5px] font-bold shrink-0 ltr-num ${row.direction === 'credit' ? 'text-[#166534]' : 'text-[#b91c1c]'}`}>
                    {row.direction === 'credit' ? '+' : '−'}{fmt(row.amount_pkr)}
                  </p>
                </div>
              ))}
            </div>
            {statement.length > 6 && (
              <button onClick={() => setShowStatement((v) => !v)} className="w-full text-center font-sans text-[12px] font-semibold text-[#166534] mt-1.5 cursor-pointer">
                {showStatement ? t('action.showLess') : t('action.showMore')}
              </button>
            )}
          </>
        )}
      </div>

      {summary?.last_settlement_date && (
        <p className="font-sans text-[12.5px] text-[#64748b]">{t('cm.lastSettlementLabel')} <span className="font-semibold text-[#1e293b]">{fmt(summary.last_settlement_amount ?? 0)}</span> — {new Date(summary.last_settlement_date).toLocaleDateString('en-GB')}</p>
      )}

      {ledger.length > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-1.5">{t('mv.todaysLedgerHeading')}</p>
          <div className="bg-white border border-[#e5e2d0] rounded-2xl divide-y divide-[#f1f5f9]">
            {ledger.map((row, i) => (
              <div key={i} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate">{row.label}</p>
                  <p className="font-sans text-[11px] text-[#64748b] mt-0.5">{t(`mv.ledgerKind.${row.kind}`)} · {new Date(row.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                </div>
                <p className="font-sans text-[13.5px] font-bold text-[#1e293b] shrink-0 ltr-num">{fmt(row.amount)}</p>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 p-3 bg-[#F9F9F6] rounded-b-2xl">
              <p className="font-sans text-[13px] font-bold text-[#1e293b]">{t('mv.totalReceivedLabel')}</p>
              <p className="font-sans text-[14px] font-bold text-[#166534] ltr-num">{fmt(ledger.reduce((sum, r) => sum + Number(r.amount || 0), 0))}</p>
            </div>
          </div>
          <p className="font-sans text-[11px] text-[#64748b] mt-1.5 leading-[1.7]">{t('mv.ledgerFootnote')}</p>
        </div>
      )}

      {negotiationInbox.length > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-1.5 flex items-center gap-1.5"><MessageCircle size={13} /> {t('vp.myConversationsTitle')}</p>
          <div className="flex flex-col gap-2">
            {negotiationInbox.map((th) => (
              <Link key={th.id} href={`/portal/marketplace/negotiations/${th.id}`} className="flex items-center justify-between gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
                <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate">{th.item}</p>
                <span className="shrink-0 text-[11px] font-bold" style={{ color: th.status === 'open' ? '#92400e' : th.status === 'agreed' ? '#166534' : '#64748b' }}>{t(`vp.${th.status}StatusLabel`)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {showTopup && vehicleId && (
        <WalletTopupModal kind="vehicle" sellerId={vehicleId} onClose={() => setShowTopup(false)} onSubmitted={() => { setShowTopup(false); reload(vehicleId) }} />
      )}
    </div>
  )
}
