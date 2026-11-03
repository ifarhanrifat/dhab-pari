'use client'

// Driver Earnings — the design file's own `driver:earn` screen (today's
// total, a by-service breakdown, then full history), plus this app's own
// real additions the file has no equivalent for: a wallet balance and
// commission mode, since real commission is actually owed money, not a
// toy demo number. Moved here unchanged in substance from the old
// my-vehicle/page.tsx dashboard — only the chrome and classes changed.

import { useEffect, useState, type ComponentType } from 'react'
import Link from 'next/link'
import { Wallet, MessageCircle, Lock, Bus, CarFront, Clock, PartyPopper, ShoppingBag, Truck, Tractor, Car, Info, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { WalletTopupModal } from '@/components/portal/WalletTopupModal'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Summary {
  balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null
  today_earnings_pkr: number; month_earnings_pkr: number; today_jobs_count: number; month_jobs_count: number; pending_bookings_count: number
  commission_pct: number
  last_settlement_date: string | null; last_settlement_amount: number | null
}
interface LedgerRow { kind: string; label: string; amount: number; at: string }
interface PendingTopup { id: string; amount_pkr: number; announced_at: string }
interface StatementRow { id: string; voucher_no: string; date: string; particular: string; kind: string; detail: string; amount_pkr: number; direction: 'debit' | 'credit'; created_at: string }
interface BreakdownRow { kind: string; count: number; amount_pkr: number }
interface Breakdown { today: BreakdownRow[]; month: BreakdownRow[] }

// Same job-kind set vehicle_today_ledger/vehicle_earnings_breakdown
// (782) tag their rows with — one icon per real line of business this
// vehicle can earn from, not a single generic "job" icon, so a driver
// can tell at a glance which kind of work paid what.
const KIND_ICON: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  route: Bus, trip: CarFront, hourly: Clock, shadi: PartyPopper, delivery: ShoppingBag, dispatch: Truck, equipment: Tractor, rental: Car,
}

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
  const [selectedStatementRow, setSelectedStatementRow] = useState<StatementRow | null>(null)
  const [negotiationInbox, setNegotiationInbox] = useState<{ id: string; kind: string; status: string; item: string | null; last_message: string | null; as_role: string }[]>([])
  const [statement, setStatement] = useState<StatementRow[]>([])
  const [showStatement, setShowStatement] = useState(false)
  const [breakdown, setBreakdown] = useState<Breakdown>({ today: [], month: [] })
  const [period, setPeriod] = useState<'today' | 'month'>('today')

  const reload = async (id: string) => {
    const [{ data: s }, { data: led }, { data: inbox }, { data: topups }, { data: stmt }, { data: bd }] = await Promise.all([
      supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: id }),
      supabase.rpc('vehicle_today_ledger', { p_vehicle_id: id }),
      supabase.rpc('my_negotiation_threads'),
      supabase.from('vehicle_wallet_topups').select('id, amount_pkr, announced_at').eq('vehicle_id', id).eq('status', 'announced').order('announced_at', { ascending: false }),
      supabase.rpc('vehicle_wallet_statement', { p_vehicle_id: id }),
      supabase.rpc('vehicle_earnings_breakdown', { p_vehicle_id: id }),
    ])
    setSummary(s as unknown as Summary)
    setLedger((led ?? []) as LedgerRow[])
    setNegotiationInbox(((inbox ?? []) as typeof negotiationInbox).filter((th) => th.as_role === 'driver'))
    setPendingTopups((topups ?? []) as PendingTopup[])
    setStatement((stmt ?? []) as StatementRow[])
    setBreakdown((bd as unknown as Breakdown) ?? { today: [], month: [] })
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
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary">{t('mb.navEarnings')}</h1>

      <div className="flex items-center gap-2 bg-white border border-[#e5e2d0] rounded-xl p-2.5 w-fit">
        <Lock size={13} className="text-[#64748b] shrink-0" />
        <span className="font-sans text-[12px] font-semibold text-[#1e293b]">{summary?.commission_mode === 'monthly_lumpsum' ? t('mv.lumpsumModeLabel') : t('mv.perOrderModeLabel')}</span>
        <span className="font-sans text-[10.5px] text-[#64748b]">· {t('vp.billingModeLockNote')}</span>
      </div>

      {/* Real ask, 2026-11-03: "deeply look at this page design... how
          we will show here for the village driver which mostly are
          uneducated so they can view easily as per the rides and types
          we are having here." Two side-by-side numbers never showed
          WHAT paid — this is a single big total for whichever period
          is selected, plus the real per-job-type breakdown underneath
          (vehicle_earnings_breakdown, 782) so a driver can see "3 رائیڈ،
          1 شادی" instead of just one opaque sum. */}
      <div className="bg-[#005A36] rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-white/15 w-fit">
          {(['today', 'month'] as const).map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className="px-3.5 py-1.5 rounded-[9px] font-sans text-[12px] font-bold cursor-pointer"
              style={{ background: period === p ? '#fff' : 'transparent', color: period === p ? '#005A36' : '#fff' }}>
              {t(p === 'today' ? 'mv.todayLabel' : 'mv.thisMonthLabel')}
            </button>
          ))}
        </div>
        <div>
          <p className="font-bold text-[34px] text-white leading-none ltr-num">
            {fmt(period === 'today' ? (summary?.today_earnings_pkr ?? 0) : (summary?.month_earnings_pkr ?? 0))}
          </p>
          <p className="font-sans text-[12px] text-white/75 mt-1.5 ltr-num">
            {period === 'today' ? (summary?.today_jobs_count ?? 0) : (summary?.month_jobs_count ?? 0)} {t('mv.jobsSuffix')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5 bg-white/10 rounded-xl p-2.5">
          {(period === 'today' ? breakdown.today : breakdown.month).length === 0 ? (
            <p className="font-sans text-[12px] text-white/70 px-1 py-1">{t('mv.noEarningsYetNote')}</p>
          ) : (period === 'today' ? breakdown.today : breakdown.month).map((row) => {
            const KindIcon = KIND_ICON[row.kind] ?? Car
            return (
              <div key={row.kind} className="flex items-center gap-2.5 px-1 py-1">
                <span className="shrink-0 w-8 h-8 rounded-full bg-white/15 flex items-center justify-center"><KindIcon size={15} className="text-white" /></span>
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-[13px] font-bold text-white">{t(`mv.ledgerKind.${row.kind}`)}</p>
                  <p className="font-sans text-[10.5px] text-white/70 ltr-num">{row.count} {t('mv.jobsSuffix')}</p>
                </div>
                <p className="font-sans text-[14px] font-extrabold text-white shrink-0 ltr-num">{fmt(row.amount_pkr)}</p>
              </div>
            )
          })}
        </div>
      </div>

      {summary?.commission_mode === 'per_order' && (
        <div className="flex items-start gap-2 bg-sky-50 border border-sky-200 rounded-xl p-2.5">
          <Info size={14} className="text-sky-700 shrink-0 mt-0.5" />
          <p className="font-sans text-[12px] text-sky-900 leading-[1.6]">{t('mv.commissionOwedExplainer').replace('{pct}', String(summary.commission_pct ?? 0))}</p>
        </div>
      )}

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
              {/* Real ask, 2026-11-03: "note down the statement which is
                  showing in English, make it Urdu with better wording
                  and make it all the description of it readable when
                  clicked on it." The raw vouchers.particular text (739)
                  is real general-ledger wording shared with every other
                  system in the app — rewriting it at the source would
                  touch the whole accounting trail, not just this
                  screen. Instead (784) tags each row with a `kind` for
                  a short, correctly-worded label here, keeps a cleaned
                  `detail` line, and still surfaces the full original
                  text untouched in the tap-through below — nothing
                  hidden, just not crammed into one truncated line. */}
              {(showStatement ? statement : statement.slice(0, 6)).map((row) => (
                <button key={row.id} onClick={() => setSelectedStatementRow(row)} className="w-full flex items-center justify-between gap-3 p-3 text-start cursor-pointer">
                  <div className="min-w-0">
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{t(`mv.statementKind.${row.kind}`)}</p>
                    <p className="font-sans text-[11px] text-[#64748b] truncate mt-0.5"><bdi>{row.detail}</bdi></p>
                    <p className="font-sans text-[10.5px] text-[#94a3b8] mt-0.5 ltr-num">{row.voucher_no} · {new Date(row.date).toLocaleDateString('en-GB')}</p>
                  </div>
                  <p className={`font-sans text-[13.5px] font-bold shrink-0 ltr-num ${row.direction === 'credit' ? 'text-[#166534]' : 'text-[#b91c1c]'}`}>
                    {row.direction === 'credit' ? '+' : '−'}{fmt(row.amount_pkr)}
                  </p>
                </button>
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

      {selectedStatementRow && (
        <div className="fixed inset-0 bg-black/55 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setSelectedStatementRow(null)}>
          <div className="bg-white w-full sm:max-w-[400px] rounded-t-[24px] sm:rounded-[24px] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <p className="font-sans text-[15px] font-extrabold text-[#1e293b]">{t('mv.statementDetailTitle')}</p>
              <button onClick={() => setSelectedStatementRow(null)} aria-label="Close" className="w-8 h-8 rounded-full bg-[#F9F9F6] flex items-center justify-center cursor-pointer"><X size={16} /></button>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <p className="font-sans text-[12px] font-bold text-[#64748b]">{t(`mv.statementKind.${selectedStatementRow.kind}`)}</p>
                <p className={`font-sans text-[24px] font-black mt-0.5 ltr-num ${selectedStatementRow.direction === 'credit' ? 'text-[#166534]' : 'text-[#b91c1c]'}`}>
                  {selectedStatementRow.direction === 'credit' ? '+' : '−'}{fmt(selectedStatementRow.amount_pkr)}
                </p>
              </div>
              <div className="rounded-xl bg-[#F9F9F6] p-3">
                <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-1">{t('mv.statementFullTextLabel')}</p>
                <p className="font-sans text-[13px] text-[#1e293b] leading-[1.7]"><bdi>{selectedStatementRow.particular}</bdi></p>
              </div>
              <div className="flex items-center justify-between font-sans text-[12px] text-[#64748b]">
                <span>{t('mv.statementVoucherLabel')}</span>
                <span className="ltr-num font-semibold text-[#1e293b]">{selectedStatementRow.voucher_no}</span>
              </div>
              <div className="flex items-center justify-between font-sans text-[12px] text-[#64748b]">
                <span>{t('mv.statementDateLabel')}</span>
                <span className="ltr-num font-semibold text-[#1e293b]">{new Date(selectedStatementRow.date).toLocaleDateString('en-GB')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
