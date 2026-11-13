'use client'

// 864: real ask — "reporting should be real like when admin or user
// will select any report then that report will be appeared like we did
// in water supply and donor accounts... only adjust the reporting
// section for now" (visual redesign explicitly deferred to a future
// pass). Rebuilt on the exact same shape as admin/(dashboard)/reports/
// page.tsx and the donor statement: a report-type selector + a date
// range, ONE report rendered at a time (not every section stacked on
// one scrolling page, which is what 862 built and what prompted this),
// a real letterhead/signature footer via the same DocumentHeader/
// DocumentFooter every other real report in this app already uses, and
// the same printNodeInPopup + overflow-unclip print pattern.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Printer } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { printNodeInPopup } from '@/lib/receiptExport'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import { DocumentFooter } from '@/components/admin/DocumentFooter'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

type ReportType = 'pl' | 'bookings' | 'expenses' | 'commission' | 'remittances' | 'salaries'

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
interface BookingSummaryRow {
  travel_date: string; manual_count: number; manual_amount_pkr: number
  online_confirmed_count: number; online_confirmed_amount_pkr: number; online_unconfirmed_count: number; online_unconfirmed_amount_pkr: number
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB')
}
function monthStart() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10) }
function today() { return new Date().toISOString().slice(0, 10) }

export default function FleetReportsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const printRef = useRef<HTMLDivElement>(null)
  const lang: 'en' | 'ur' = isUrdu ? 'ur' : 'en'

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [fleetName, setFleetName] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [reportType, setReportType] = useState<ReportType>('pl')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())

  const [pl, setPl] = useState<{ vehicles: FleetVehicleSummary[]; fleet_today_profit_pkr: number; fleet_month_profit_pkr: number } | null>(null)
  const [expenses, setExpenses] = useState<ExpenseTxn[]>([])
  const [salaries, setSalaries] = useState<SalaryTxn[]>([])
  const [ledgerLines, setLedgerLines] = useState<LedgerTxn[]>([])
  const [remittances, setRemittances] = useState<RemittanceTxn[]>([])
  const [bookingSummary, setBookingSummary] = useState<BookingSummaryRow[]>([])

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
          const { data: counterIds } = await supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id })
          const ids = ((counterIds ?? []) as { id: string }[]).map((c) => c.id)
          const [{ data: sal }, { data: rem }] = await Promise.all([
            supabase.rpc('fleet_salary_payment_transactions', { p_fleet_id: f.fleet_id }),
            ids.length > 0
              ? supabase.from('fleet_counter_remittances').select('id, created_at, amount_pkr, note, fleet_counters(city, name)').in('counter_id', ids).order('created_at', { ascending: false })
              : Promise.resolve({ data: [] }),
          ])
          setSalaries((sal ?? []) as SalaryTxn[])
          setRemittances((rem ?? []) as unknown as RemittanceTxn[])
        }
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (!fleetId || reportType !== 'bookings') return
    supabase.rpc('fleet_booking_summary', { p_fleet_id: fleetId, p_from: from, p_to: to }).then(({ data }) => setBookingSummary((data ?? []) as BookingSummaryRow[]))
  }, [fleetId, reportType, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  const inRange = (iso: string) => iso >= from && iso <= to
  const visibleExpenses = useMemo(() => expenses.filter((e) => inRange(e.expense_date)), [expenses, from, to])
  const visibleSalaries = useMemo(() => salaries.filter((s) => inRange(s.paid_on)), [salaries, from, to])
  const visibleLedger = useMemo(() => ledgerLines.filter((l) => inRange(l.entry_date)), [ledgerLines, from, to])
  const visibleRemittances = useMemo(() => remittances.filter((r) => inRange(r.created_at.slice(0, 10))), [remittances, from, to])

  const reportTitles: Record<ReportType, string> = {
    pl: t('mv.fleetPLHeading'), bookings: t('mv.bookingSummaryHeading'), expenses: t('mv.vehicleExpensesHeading'), commission: t('mv.commissionSettlementsHeading'),
    remittances: t('mv.remittanceHistoryHeading'), salaries: t('mv.staffSalariesHeading'),
  }

  const handlePrint = () => {
    if (!printRef.current) return
    const scrollers = Array.from(printRef.current.querySelectorAll<HTMLElement>('.overflow-x-auto'))
    const prevOverflow = scrollers.map((el) => el.style.overflow)
    scrollers.forEach((el) => { el.style.overflow = 'visible' })
    try {
      const ok = printNodeInPopup(printRef.current, `${reportTitles[reportType]} — ${fleetName}`)
      if (!ok) toast.error(t('mv.allowPopupsToPrintHint'))
    } finally {
      scrollers.forEach((el, i) => { el.style.overflow = prevOverflow[i] })
    }
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary">{t('mv.fleetReportsHeading')}</h1>
        <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[12px] font-semibold text-[#166534] cursor-pointer">
          <Printer size={14} /> {t('mv.printReportBtn')}
        </button>
      </div>

      {/* Report selector + date range — same shape as the admin Reports
          hub and the donor statement: pick a report, it appears below. */}
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[180px]">
          <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.reportTypeLabel')}</label>
          <select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
            <option value="pl">{t('mv.fleetPLHeading')}</option>
            <option value="bookings">{t('mv.bookingSummaryHeading')}</option>
            <option value="expenses">{t('mv.vehicleExpensesHeading')}</option>
            <option value="commission">{t('mv.commissionSettlementsHeading')}</option>
            {isOwner && <option value="remittances">{t('mv.remittanceHistoryHeading')}</option>}
            {isOwner && <option value="salaries">{t('mv.staffSalariesHeading')}</option>}
          </select>
        </div>
        {reportType !== 'pl' && (
          <>
            <div className="flex-1 min-w-[140px]">
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('a.from')}</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('rp.to')}</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
          </>
        )}
      </div>

      <div ref={printRef} dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
        <DocumentHeader title={reportTitles[reportType]} subtitle={fleetName} className="hidden print:block" lang={lang} />

        {reportType === 'pl' && (
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <div className="flex gap-2 mb-3">
              <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-2.5">
                <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.todayProfitLabel')}</p>
                <p className="font-sans text-[17px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl?.fleet_today_profit_pkr ?? 0)}</p>
              </div>
              <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-2.5">
                <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.monthProfitLabel')}</p>
                <p className="font-sans text-[17px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl?.fleet_month_profit_pkr ?? 0)}</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="text-[#94a3b8] text-[10.5px] font-sans font-bold uppercase tracking-[0.04em] border-b border-[#e5e2d0]">
                    <th className="p-2">{t('mv.vehicleColumnLabel')}</th>
                    <th className="p-2 text-end">{t('mv.todayLabel')}</th>
                    <th className="p-2 text-end">{t('mv.monthLabel')}</th>
                    <th className="p-2 text-end">{t('mv.walletLabel')}</th>
                  </tr>
                </thead>
                <tbody className="font-sans text-[12.5px]">
                  {(pl?.vehicles ?? []).length === 0 && <tr><td colSpan={4} className="p-6 text-center text-[#94a3b8]">{t('mv.noFleetYetHint')}</td></tr>}
                  {(pl?.vehicles ?? []).map((v) => (
                    <tr key={v.vehicle_id} className="border-t border-[#f1f5f9]">
                      <td className="p-2">{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</td>
                      <td className="p-2 text-end ltr-num">₨{fmt(v.today_profit_pkr)}</td>
                      <td className="p-2 text-end font-bold ltr-num">₨{fmt(v.month_profit_pkr)}</td>
                      <td className="p-2 text-end text-[#94a3b8] ltr-num">₨{fmt(v.wallet_balance_pkr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {reportType === 'bookings' && (() => {
          const totals = bookingSummary.reduce((s, r) => ({
            manual: s.manual + r.manual_count, manualAmt: s.manualAmt + Number(r.manual_amount_pkr),
            onlineConfirmed: s.onlineConfirmed + r.online_confirmed_count, onlineConfirmedAmt: s.onlineConfirmedAmt + Number(r.online_confirmed_amount_pkr),
            onlineUnconfirmed: s.onlineUnconfirmed + r.online_unconfirmed_count, onlineUnconfirmedAmt: s.onlineUnconfirmedAmt + Number(r.online_unconfirmed_amount_pkr),
          }), { manual: 0, manualAmt: 0, onlineConfirmed: 0, onlineConfirmedAmt: 0, onlineUnconfirmed: 0, onlineUnconfirmedAmt: 0 })
          return (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
              <div className="flex gap-2 mb-3 flex-wrap">
                <div className="flex-1 min-w-[90px] bg-[#F9F9F6] border border-[#e5e2d0] rounded-lg p-2.5">
                  <p className="font-sans text-[10px] text-[#64748b]">{t('mv.sourceManualLabel')}</p>
                  <p className="font-sans text-[16px] font-extrabold text-[#1e293b] ltr-num">{totals.manual}</p>
                  <p className="font-sans text-[10px] text-[#64748b] ltr-num">₨{fmt(totals.manualAmt)}</p>
                </div>
                <div className="flex-1 min-w-[90px] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-2.5">
                  <p className="font-sans text-[10px] text-[#166534]">{t('mv.confirmedLabel')}</p>
                  <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">{totals.onlineConfirmed}</p>
                  <p className="font-sans text-[10px] text-[#166534] ltr-num">₨{fmt(totals.onlineConfirmedAmt)}</p>
                </div>
                <div className="flex-1 min-w-[90px] bg-[#FFFBEB] border border-[#fde68a] rounded-lg p-2.5">
                  <p className="font-sans text-[10px] text-[#92400e]">{t('mv.unconfirmedLabel')}</p>
                  <p className="font-sans text-[16px] font-extrabold text-[#92400e] ltr-num">{totals.onlineUnconfirmed}</p>
                  <p className="font-sans text-[10px] text-[#92400e] ltr-num">₨{fmt(totals.onlineUnconfirmedAmt)}</p>
                </div>
              </div>
              {bookingSummary.length === 0 ? (
                <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noBookingsFoundHint')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-start border-collapse">
                    <thead>
                      <tr className="text-[#94a3b8] text-[10.5px] font-sans font-bold uppercase tracking-[0.04em] border-b border-[#e5e2d0]">
                        <th className="p-2">{t('w.date')}</th>
                        <th className="p-2 text-end">{t('mv.sourceManualLabel')}</th>
                        <th className="p-2 text-end">{t('mv.confirmedLabel')}</th>
                        <th className="p-2 text-end">{t('mv.unconfirmedLabel')}</th>
                      </tr>
                    </thead>
                    <tbody className="font-sans text-[12.5px]">
                      {bookingSummary.map((r) => (
                        <tr key={r.travel_date} className="border-t border-[#f1f5f9]">
                          <td className="p-2 ltr-num text-[#94a3b8]">{fmtDate(r.travel_date)}</td>
                          <td className="p-2 text-end ltr-num">{r.manual_count}</td>
                          <td className="p-2 text-end ltr-num text-[#166534] font-bold">{r.online_confirmed_count}</td>
                          <td className="p-2 text-end ltr-num text-[#92400e]">{r.online_unconfirmed_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })()}

        {reportType === 'expenses' && (
          <ReportTable emptyHint={t('mv.noExpensesYetHint')} totalLabel={t('mv.totalLabel')} total={visibleExpenses.reduce((s, e) => s + Number(e.amount_pkr), 0)}
            columns={[t('mv.txnNoLabel'), t('w.date'), t('mv.vehicleColumnLabel'), t('w.particular'), t('w.amount')]}
            rows={visibleExpenses.map((e) => [e.txn_no, fmtDate(e.expense_date), e.owner_name, `${t(`mv.expenseCategory${e.category.charAt(0).toUpperCase()}${e.category.slice(1)}`)}${e.note ? ` — ${e.note}` : ''}`, `₨${fmt(e.amount_pkr)}`])} />
        )}

        {reportType === 'commission' && (
          <ReportTable emptyHint={t('mv.noCommissionHistoryHint')} totalLabel={t('mv.totalCommissionSettledLabel')} total={visibleLedger.reduce((s, l) => s + Number(l.debit), 0)}
            columns={[t('mv.txnNoLabel'), t('w.date'), t('mv.vehicleColumnLabel'), t('w.particular'), t('w.amount')]}
            rows={visibleLedger.map((l) => [l.txn_no ?? '—', fmtDate(l.entry_date), l.owner_name, l.particular, Number(l.debit) > 0 ? `−₨${fmt(l.debit)}` : `+₨${fmt(l.credit)}`])} />
        )}

        {reportType === 'remittances' && isOwner && (
          <ReportTable emptyHint={t('mv.noRemittanceHistoryHint')} totalLabel={t('mv.totalLabel')} total={visibleRemittances.reduce((s, r) => s + Number(r.amount_pkr), 0)}
            columns={[t('w.date'), t('mv.counterColumnLabel'), t('w.particular'), t('w.amount')]}
            rows={visibleRemittances.map((r) => [fmtDate(r.created_at), `${r.fleet_counters?.city ?? ''}${r.fleet_counters?.name ? ` · ${r.fleet_counters.name}` : ''}`, r.note ?? t('mv.recordRemittanceBtn'), `₨${fmt(r.amount_pkr)}`])} />
        )}

        {reportType === 'salaries' && isOwner && (
          <ReportTable emptyHint={t('mv.noStaffYetHint')} totalLabel={t('mv.totalLabel')} total={visibleSalaries.reduce((s, e) => s + Number(e.amount_pkr), 0)}
            columns={[t('mv.txnNoLabel'), t('w.date'), t('mv.staffColumnLabel'), t('w.particular'), t('w.amount')]}
            rows={visibleSalaries.map((s) => [s.txn_no, fmtDate(s.paid_on), s.full_name, s.note ?? '—', `₨${fmt(s.amount_pkr)}`])} />
        )}

        <DocumentFooter lang={lang} />
      </div>
    </div>
  )
}

function ReportTable({ emptyHint, columns, rows, totalLabel, total }: {
  emptyHint: string; columns: string[]; rows: string[][]; totalLabel: string; total: number
}) {
  return (
    <div className="bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden">
      {rows.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8] p-6 text-center">{emptyHint}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead>
              <tr className="text-[#94a3b8] text-[10.5px] font-sans font-bold uppercase tracking-[0.04em] bg-[#F9F9F6]">
                {columns.map((c, i) => <th key={i} className={`p-3 ${i === columns.length - 1 ? 'text-end' : ''}`}>{c}</th>)}
              </tr>
            </thead>
            <tbody className="font-sans text-[12.5px]">
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-[#f1f5f9]">
                  {r.map((cell, j) => (
                    <td key={j} className={`p-3 ${j === r.length - 1 ? 'text-end font-bold ltr-num' : j === 0 ? 'ltr-num text-[#94a3b8]' : ''}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[#e5e2d0] bg-[#F9F9F6]">
                <td colSpan={columns.length - 1} className="p-3 font-sans text-[11.5px] font-bold text-[#64748b]">{totalLabel}</td>
                <td className="p-3 text-end font-sans text-[13px] font-extrabold text-[#166534] ltr-num">₨{fmt(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
