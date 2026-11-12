'use client'

// 862: Reports tab rebuilt as a real printable statement — real ask:
// "what a garbage way of reporting... not just one page, viewable and
// printable, along with all transaction types, transaction numbers."
// Every section below is now a full transaction table (date, a real
// reference number, who/what, amount), not a monthly-aggregate card,
// built on fleet_expense_transactions/fleet_salary_payment_transactions/
// fleet_commission_ledger_lines (862) plus a direct read of
// fleet_counter_remittances (855's own RLS already allows this). The
// P&L summary at top is unchanged (860) — it's a legitimate summary,
// not the problem; the problem was everything below it being invisible.
//
// Print/export reuses the exact pattern admin/accounts/[id]/page.tsx
// already established: a `statementRef` around the printable region,
// `.no-export` elements hidden and `.overflow-x-auto` scrollers
// unclipped before handing the node to printNodeInPopup (receiptExport.ts),
// which already handles both the native Android print plugin and a
// plain browser popup fallback — nothing new to build there.

import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { printNodeInPopup } from '@/lib/receiptExport'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicleSummary {
  vehicle_id: string; owner_name: string; vehicle_type: string
  today_earnings_pkr: number; today_expenses_pkr: number; today_profit_pkr: number
  month_earnings_pkr: number; month_expenses_pkr: number; month_profit_pkr: number
  wallet_balance_pkr: number
}
interface ExpenseTxn { txn_no: string; id: string; expense_date: string; owner_name: string; category: string; note: string | null; amount_pkr: number }
interface SalaryTxn { txn_no: string; id: string; paid_on: string; full_name: string; note: string | null; amount_pkr: number }
interface LedgerTxn { txn_no: string | null; id: string; entry_date: string; owner_name: string; particular: string; debit: number; credit: number }
interface RemittanceTxn { id: string; created_at: string; amount_pkr: number; note: string | null; fleet_counters: { city: string; name: string | null } | null }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
function monthBounds(offset: number) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { from: iso(start), to: iso(end), label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }
}

export default function FleetReportsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const statementRef = useRef<HTMLDivElement>(null)

  const [loading, setLoading] = useState(true)
  const [printing, setPrinting] = useState(false)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [fleetName, setFleetName] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [pl, setPl] = useState<{ vehicles: FleetVehicleSummary[]; fleet_today_profit_pkr: number; fleet_month_profit_pkr: number } | null>(null)
  const [expenses, setExpenses] = useState<ExpenseTxn[]>([])
  const [salaries, setSalaries] = useState<SalaryTxn[]>([])
  const [ledgerLines, setLedgerLines] = useState<LedgerTxn[]>([])
  const [remittances, setRemittances] = useState<RemittanceTxn[]>([])

  const [monthOffset, setMonthOffset] = useState(0)
  const [from, setFrom] = useState(() => monthBounds(0).from)
  const [to, setTo] = useState(() => monthBounds(0).to)

  useEffect(() => {
    const b = monthBounds(monthOffset)
    setFrom(b.from); setTo(b.to)
  }, [monthOffset])

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string; name: string; is_owner: boolean } | null
      setFleetId(f?.fleet_id ?? null)
      setFleetName(f?.name ?? '')
      setIsOwner(f?.is_owner ?? false)
      if (f) {
        const [{ data: plData }, { data: exp }, { data: ledger }] = await Promise.all([
          supabase.rpc('fleet_dashboard_summary'),
          supabase.rpc('fleet_expense_transactions', { p_fleet_id: f.fleet_id }),
          supabase.rpc('fleet_commission_ledger_lines', { p_fleet_id: f.fleet_id }),
        ])
        setPl(plData as typeof pl)
        setExpenses((exp ?? []) as ExpenseTxn[])
        setLedgerLines((ledger ?? []) as LedgerTxn[])
        if (f.is_owner) {
          const [{ data: sal }, { data: rem }] = await Promise.all([
            supabase.rpc('fleet_salary_payment_transactions', { p_fleet_id: f.fleet_id }),
            supabase.from('fleet_counter_remittances').select('id, created_at, amount_pkr, note, fleet_counters(city, name)')
              .in('counter_id', (await supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id })).data?.map((c: { id: string }) => c.id) ?? [])
              .order('created_at', { ascending: false }),
          ])
          setSalaries((sal ?? []) as SalaryTxn[])
          setRemittances((rem ?? []) as unknown as RemittanceTxn[])
        }
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const inRange = (iso: string) => iso >= from && iso <= to
  const visibleExpenses = useMemo(() => expenses.filter((e) => inRange(e.expense_date)), [expenses, from, to])
  const visibleSalaries = useMemo(() => salaries.filter((s) => inRange(s.paid_on)), [salaries, from, to])
  const visibleLedger = useMemo(() => ledgerLines.filter((l) => inRange(l.entry_date)), [ledgerLines, from, to])
  const visibleRemittances = useMemo(() => remittances.filter((r) => inRange(r.created_at.slice(0, 10))), [remittances, from, to])

  const totalExpenses = visibleExpenses.reduce((s, e) => s + Number(e.amount_pkr), 0)
  const totalSalaries = visibleSalaries.reduce((s, e) => s + Number(e.amount_pkr), 0)
  const totalCommission = visibleLedger.reduce((s, l) => s + Number(l.debit), 0)
  const totalToppedUp = visibleLedger.reduce((s, l) => s + Number(l.credit), 0)
  const totalRemitted = visibleRemittances.reduce((s, r) => s + Number(r.amount_pkr), 0)

  const handlePrint = () => {
    if (!statementRef.current) return
    setPrinting(true)
    const hidden = Array.from(statementRef.current.querySelectorAll<HTMLElement>('.no-export'))
    const prevDisplay = hidden.map((el) => el.style.display)
    hidden.forEach((el) => { el.style.display = 'none' })
    const scrollers = Array.from(statementRef.current.querySelectorAll<HTMLElement>('.overflow-x-auto'))
    const prevOverflow = scrollers.map((el) => el.style.overflow)
    scrollers.forEach((el) => { el.style.overflow = 'visible' })
    try {
      const ok = printNodeInPopup(statementRef.current, `${fleetName} — ${t('mv.fleetReportsHeading')}`)
      if (!ok) toast.error(t('mv.allowPopupsToPrintHint'))
    } finally {
      hidden.forEach((el, i) => { el.style.display = prevDisplay[i] })
      scrollers.forEach((el, i) => { el.style.overflow = prevOverflow[i] })
      setPrinting(false)
    }
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between no-export">
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><BarChart3 size={19} /> {t('mv.fleetReportsHeading')}</h1>
        <button disabled={printing} onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[12px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
          <Printer size={14} /> {t('mv.printReportBtn')}
        </button>
      </div>

      <div className="flex items-center gap-2 no-export">
        <button onClick={() => setMonthOffset((o) => o - 1)} className="px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[12px] cursor-pointer">←</button>
        <span className="flex-1 text-center font-sans text-[13px] font-bold text-[#1e293b]">{monthBounds(monthOffset).label}</span>
        <button onClick={() => setMonthOffset((o) => o + 1)} disabled={monthOffset >= 0} className="px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[12px] cursor-pointer disabled:opacity-30">→</button>
      </div>

      <div ref={statementRef} dir={isUrdu ? 'rtl' : 'ltr'} className="flex flex-col gap-3">
        <div className="hidden print:block mb-2">
          <p className="font-bold text-[16px]">{fleetName}</p>
          <p className="font-sans text-[12px] text-[#64748b]">{t('mv.fleetReportsHeading')} — {monthBounds(monthOffset).label}</p>
        </div>

        {/* P&L summary — unchanged from 860, kept as the report's header block */}
        {pl && pl.vehicles.length > 0 && (
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{t('mv.fleetPLHeading')}</p>
            <div className="flex gap-2 mb-3">
              <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-2.5">
                <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.todayProfitLabel')}</p>
                <p className="font-sans text-[17px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl.fleet_today_profit_pkr)}</p>
              </div>
              <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-2.5">
                <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.monthProfitLabel')}</p>
                <p className="font-sans text-[17px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl.fleet_month_profit_pkr)}</p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {pl.vehicles.map((v) => (
                <div key={v.vehicle_id} className="border border-[#e5e2d0] rounded-lg px-3 py-2">
                  <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</p>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-sans text-[11px] text-[#64748b] ltr-num">{t('mv.monthLabel')}: ₨{fmt(v.month_earnings_pkr)} − ₨{fmt(v.month_expenses_pkr)} = <span className="font-bold text-[#1e293b]">₨{fmt(v.month_profit_pkr)}</span></span>
                    <span className="font-sans text-[10.5px] text-[#94a3b8] ltr-num">{t('mv.walletLabel')} ₨{fmt(v.wallet_balance_pkr)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Vehicle expenses — full transaction table */}
        <ReportTable
          heading={t('mv.vehicleExpensesHeading')}
          emptyHint={t('mv.noExpensesYetHint')}
          totalLabel={t('mv.totalLabel')}
          total={totalExpenses}
          columns={[t('mv.txnNoLabel'), t('w.date'), t('mv.vehicleColumnLabel'), t('w.particular'), t('w.amount')]}
          rows={visibleExpenses.map((e) => [
            e.txn_no, fmtDate(e.expense_date), e.owner_name,
            `${t(`mv.expenseCategory${e.category.charAt(0).toUpperCase()}${e.category.slice(1)}`)}${e.note ? ` — ${e.note}` : ''}`,
            `₨${fmt(e.amount_pkr)}`,
          ])}
        />

        {/* Committee commission ledger — real ledger_entries rows, real receipt numbers */}
        <ReportTable
          heading={t('mv.commissionSettlementsHeading')}
          emptyHint={t('mv.noCommissionHistoryHint')}
          totalLabel={t('mv.totalCommissionSettledLabel')}
          total={totalCommission}
          secondaryTotalLabel={totalToppedUp > 0 ? t('mv.totalToppedUpLabel') : undefined}
          secondaryTotal={totalToppedUp > 0 ? totalToppedUp : undefined}
          columns={[t('mv.txnNoLabel'), t('w.date'), t('mv.vehicleColumnLabel'), t('w.particular'), t('w.amount')]}
          rows={visibleLedger.map((l) => [
            l.txn_no ?? '—', fmtDate(l.entry_date), l.owner_name, l.particular,
            Number(l.debit) > 0 ? `−₨${fmt(l.debit)}` : `+₨${fmt(l.credit)}`,
          ])}
        />

        {isOwner && (
          <>
            {/* Counter remittances — full history, not just the running balance */}
            <ReportTable
              heading={t('mv.remittanceHistoryHeading')}
              emptyHint={t('mv.noRemittanceHistoryHint')}
              totalLabel={t('mv.totalLabel')}
              total={totalRemitted}
              columns={[t('w.date'), t('mv.counterColumnLabel'), t('w.particular'), t('w.amount')]}
              rows={visibleRemittances.map((r) => [
                fmtDate(r.created_at), `${r.fleet_counters?.city ?? ''}${r.fleet_counters?.name ? ` · ${r.fleet_counters.name}` : ''}`,
                r.note ?? t('mv.recordRemittanceBtn'), `₨${fmt(r.amount_pkr)}`,
              ])}
            />

            {/* Staff salary payments — full transaction table */}
            <ReportTable
              heading={t('mv.staffSalariesHeading')}
              emptyHint={t('mv.noStaffYetHint')}
              totalLabel={t('mv.totalLabel')}
              total={totalSalaries}
              columns={[t('mv.txnNoLabel'), t('w.date'), t('mv.staffColumnLabel'), t('w.particular'), t('w.amount')]}
              rows={visibleSalaries.map((s) => [s.txn_no, fmtDate(s.paid_on), s.full_name, s.note ?? '—', `₨${fmt(s.amount_pkr)}`])}
            />
          </>
        )}
      </div>
    </div>
  )
}

function ReportTable({ heading, emptyHint, columns, rows, totalLabel, total, secondaryTotalLabel, secondaryTotal }: {
  heading: string; emptyHint: string; columns: string[]; rows: string[][]
  totalLabel: string; total: number; secondaryTotalLabel?: string; secondaryTotal?: number
}) {
  return (
    <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
      <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{heading}</p>
      {rows.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8]">{emptyHint}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead>
              <tr className="text-[#94a3b8] text-[10.5px] font-sans font-bold uppercase tracking-[0.04em]">
                {columns.map((c, i) => <th key={i} className={`p-2 ${i === columns.length - 1 ? 'text-end' : ''}`}>{c}</th>)}
              </tr>
            </thead>
            <tbody className="font-sans text-[12.5px]">
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-[#f1f5f9]">
                  {r.map((cell, j) => (
                    <td key={j} className={`p-2 ${j === r.length - 1 ? 'text-end font-bold ltr-num' : j === 0 ? 'ltr-num text-[#94a3b8]' : ''}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[#e5e2d0]">
                <td colSpan={columns.length - 1} className="p-2 font-sans text-[11.5px] font-bold text-[#64748b]">
                  {totalLabel}{secondaryTotalLabel ? ` · ${secondaryTotalLabel}` : ''}
                </td>
                <td className="p-2 text-end font-sans text-[13px] font-extrabold text-[#166534] ltr-num">
                  ₨{fmt(total)}{secondaryTotal != null ? ` / +₨${fmt(secondaryTotal)}` : ''}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
