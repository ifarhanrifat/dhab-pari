'use client'

import { useEffect, useState, useCallback, useMemo, useRef, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Printer, ExternalLink } from 'lucide-react'
import { printNodeInPopup } from '@/lib/receiptExport'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import { dt, type Lang, type DocStringKey } from '@/lib/docTranslations'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type SystemTab = 'water_supply' | 'donors_projects'
type ReportType = 'trial_balance' | 'balance_sheet' | 'income_expense' | 'consumer_outstanding' | 'donor_report' | 'account_statement'

const systemLabels: Record<SystemTab, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects' }
const systemLabelKeys: Record<SystemTab, DocStringKey> = { water_supply: 'waterSupplySystem', donors_projects: 'donorsProjects' }
const reportTypeLabels: Record<ReportType, string> = {
  trial_balance: 'Trial Balance',
  balance_sheet: 'Balance Sheet',
  income_expense: 'Profit & Loss Statement',
  consumer_outstanding: 'Consumer Outstanding Report',
  donor_report: 'Donor Report',
  account_statement: 'Account Statement Lookup',
}
const reportTypeDocKeys: Record<ReportType, DocStringKey> = {
  trial_balance: 'reportTrialBalance',
  balance_sheet: 'reportBalanceSheet',
  income_expense: 'reportIncomeExpense',
  consumer_outstanding: 'reportConsumerOutstanding',
  donor_report: 'reportDonorReport',
  account_statement: 'reportAccountStatement',
}

// COGS and Discount Given are both type='expense' in the chart of accounts (so
// they show correctly on the Trial Balance), but a proper P&L needs them pulled
// out of "Operating Expenses" — COGS to compute Gross Profit, Discount to reduce
// Revenue — rather than sitting flat next to office supplies and salaries.
const cogsCode: Record<SystemTab, string> = { water_supply: 'WS-3007', donors_projects: 'DP-3004' }
const discountCode: Record<SystemTab, string> = { water_supply: 'WS-3008', donors_projects: 'DP-3005' }

interface Account { id: string; code: string; name: string; type: string; system: string; opening_balance: number; consumer_id: string | null }
interface AccountHeader { system: string; code: string; label: string }
interface LedgerAgg { account_id: string; debit: number; credit: number }
interface Consumer { consumer_id: string; name: string; mobile: string; sector: string | null }
interface Donation { id: string; name: string; amount_pkr: number; date: string; donor_type: string | null; project_id: string | null; payment_method: string | null }
interface Project { id: string; title: string }
interface LedgerRow { id: string; entry_date: string; particular: string; bill_number: string | null; receipt_no: string | null; debit: number; credit: number }

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10) }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const creditNormal = (type: string) => type === 'donor' || type === 'income' || type === 'liability'

export default function ReportsPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <ReportsPageInner />
    </Suspense>
  )
}

function ReportsPageInner() {
  const { t, isUrdu } = useLocale()
  const searchParams = useSearchParams()
  const access = useSystemAccess()
  const initialReport = (searchParams.get('report') as ReportType) || 'trial_balance'
  const initialSystem = (searchParams.get('system') as SystemTab) || 'water_supply'
  const [system, setSystem] = useState<SystemTab>(initialSystem)
  const [reportType, setReportType] = useState<ReportType>(initialReport)

  // A water_accountant could previously pick "Donors & Projects" here and get
  // an empty report (RLS returned nothing), which reads as a broken page
  // rather than a permission boundary. Snap to whichever system they can
  // actually see; the <select> below only offers those too. Same treatment
  // /admin/transactions already had — Reports just never got it.
  useEffect(() => {
    if (access.loading) return
    if (system === 'water_supply' && !access.canWaterSupply) setSystem(access.defaultSystem)
    if (system === 'donors_projects' && !access.canDonorsProjects) setSystem(access.defaultSystem)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.loading, access.canWaterSupply, access.canDonorsProjects, system])
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [loading, setLoading] = useState(false)

  const [accounts, setAccounts] = useState<Account[]>([])
  const [headers, setHeaders] = useState<AccountHeader[]>([])
  const [balances, setBalances] = useState<Record<string, LedgerAgg>>({})
  const [consumers, setConsumers] = useState<Record<string, Consumer>>({})
  const [donations, setDonations] = useState<Donation[]>([])
  const [projects, setProjects] = useState<Record<string, string>>({})
  const [projectFilter, setProjectFilter] = useState('')
  const [sectorFilter, setSectorFilter] = useState('')

  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [statementRows, setStatementRows] = useState<LedgerRow[]>([])
  const [statementOpening, setStatementOpening] = useState(0)

  // An internal report -- follows the admin's own chosen language rather
  // than the site's public-document branding default.
  const lang: Lang = isUrdu ? 'ur' : 'en'
  const printRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  const load = useCallback(async () => {
    setLoading(true)
    const [accountsRes, headersRes, ledgerRes, consumersRes] = await Promise.all([
      supabase.from('accounts').select('id, code, name, type, system, opening_balance, consumer_id').eq('system', system).order('code'),
      supabase.from('account_headers').select('system, code, label').eq('system', system),
      supabase.from('ledger_entries').select('account_id, debit, credit'),
      supabase.from('consumers').select('consumer_id, name, mobile, sector'),
    ])
    setAccounts(accountsRes.data ?? [])
    setHeaders(headersRes.data ?? [])
    const bMap: Record<string, LedgerAgg> = {}
    ;(ledgerRes.data ?? []).forEach((l: { account_id: string; debit: number; credit: number }) => {
      const cur = bMap[l.account_id] ?? { account_id: l.account_id, debit: 0, credit: 0 }
      cur.debit += Number(l.debit); cur.credit += Number(l.credit)
      bMap[l.account_id] = cur
    })
    setBalances(bMap)
    const cMap: Record<string, Consumer> = {}
    ;(consumersRes.data ?? []).forEach((c) => { cMap[c.consumer_id] = c })
    setConsumers(cMap)

    if (system === 'donors_projects') {
      const [{ data: donationsData }, { data: projectsData }] = await Promise.all([
        // Verified-only — an unconfirmed donation hasn't actually posted to
        // ledger_entries yet (trg_donor_ledger), so counting it here would
        // disagree with the Trial Balance/Balance Sheet on this same page,
        // both of which are ledger-derived. Matches homepage_stats()'s
        // precedent. (Recent Transactions on the finance page deliberately
        // still shows pending ones too, with a Pending badge — that's the
        // operational queue, this is a financial summary.)
        supabase.from('donors').select('id, name, amount_pkr, date, donor_type, project_id, payment_method').eq('is_verified', true).order('date', { ascending: false }),
        supabase.from('projects').select('id, title'),
      ])
      setDonations(donationsData ?? [])
      setProjects(Object.fromEntries((projectsData ?? []).map((p: Project) => [p.id, p.title])))
    }
    setLoading(false)
  }, [system, supabase])

  useEffect(() => { load() }, [load])

  const balanceOf = (a: Account) => {
    const b = balances[a.id]
    const net = b ? b.debit - b.credit : 0
    return creditNormal(a.type) ? a.opening_balance - net : a.opening_balance + net
  }

  const headerLabel = (type: string) => headers.find((h) => h.code === type)?.label ?? type

  const trialBalanceRows = useMemo(() => {
    return accounts.map((a) => {
      const bal = balanceOf(a)
      const isDebitNormal = !creditNormal(a.type)
      return {
        account: a,
        debitCol: isDebitNormal && bal > 0 ? bal : (!isDebitNormal && bal < 0 ? -bal : 0),
        creditCol: !isDebitNormal && bal > 0 ? bal : (isDebitNormal && bal < 0 ? -bal : 0),
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, balances])

  const totalDebitCol = trialBalanceRows.reduce((s, r) => s + r.debitCol, 0)
  const totalCreditCol = trialBalanceRows.reduce((s, r) => s + r.creditCol, 0)

  // As-of-now snapshot (same balanceOf() the Trial Balance already uses — a
  // Balance Sheet is a point-in-time statement, not a date-range one). Consumer
  // receivables are genuine assets (unpaid bills owed to the committee); donor
  // accounts are a subsidiary/memo record of contributions received, not a
  // balance-sheet item, so they're excluded here. Fund Balance is a computed
  // residual (Assets − Liabilities) rather than its own account — the standard
  // simple approach for a non-profit committee instead of a stock-company "equity."
  const balanceSheetData = useMemo(() => {
    // 'collector' = cash currently held by a field collector, awaiting
    // settlement into real Cash-in-Hand/Bank (migration 056) — a genuine
    // asset in the meantime, and was missing from this list, which would have
    // silently understated Total Assets (and the Fund Balance residual) by
    // whatever any collector was currently holding uncleared.
    const assetTypes = ['cash', 'bank', 'asset', 'consumer', 'collector']
    // 'student', 'institution', 'project' and 'restricted_fund' are subsidiary
    // ledgers, deliberately excluded — the expense, receivable and cash
    // accounts already carry the same money once.
    const assets = accounts.filter((a) => assetTypes.includes(a.type)).map((a) => ({ account: a, balance: balanceOf(a) }))
    const liabilities = accounts.filter((a) => a.type === 'liability').map((a) => ({ account: a, balance: balanceOf(a) }))
    const totalAssets = assets.reduce((s, r) => s + r.balance, 0)
    const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0)
    return { assets, liabilities, totalAssets, totalLiabilities, fundBalance: totalAssets - totalLiabilities }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, balances])

  const sectors = useMemo(() => {
    const s = new Set(Object.values(consumers).map((c) => c.sector).filter(Boolean) as string[])
    return Array.from(s).sort()
  }, [consumers])

  const consumerOutstanding = useMemo(() => {
    return accounts
      .filter((a) => a.type === 'consumer')
      .map((a) => ({ account: a, balance: balanceOf(a), info: a.consumer_id ? consumers[a.consumer_id] : undefined }))
      .filter((r) => r.balance > 0)
      .filter((r) => !sectorFilter || r.info?.sector === sectorFilter)
      .sort((a, b) => b.balance - a.balance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, balances, consumers, sectorFilter])

  const filteredDonations = useMemo(() => {
    return donations.filter((d) => {
      if (d.date < from || d.date > to) return false
      if (projectFilter && d.project_id !== projectFilter) return false
      return true
    })
  }, [donations, from, to, projectFilter])

  const incomeExpense = useMemo(() => {
    const incomeAccounts = accounts.filter((a) => a.type === 'income')
    const cogsAccount = accounts.find((a) => a.code === cogsCode[system]) ?? null
    const discountAccount = accounts.find((a) => a.code === discountCode[system]) ?? null
    const expenseAccounts = accounts.filter((a) => a.type === 'expense' && a.id !== cogsAccount?.id && a.id !== discountAccount?.id)
    return { incomeAccounts, expenseAccounts, cogsAccount, discountAccount }
  }, [accounts, system])

  const [rangeLedger, setRangeLedger] = useState<Record<string, LedgerAgg>>({})
  useEffect(() => {
    if (reportType !== 'income_expense') return
    (async () => {
      const ids = accounts.filter((a) => a.type === 'income' || a.type === 'expense').map((a) => a.id)
      if (ids.length === 0) { setRangeLedger({}); return }
      const { data } = await supabase.from('ledger_entries').select('account_id, debit, credit').in('account_id', ids).gte('entry_date', from).lte('entry_date', to)
      const m: Record<string, LedgerAgg> = {}
      ;(data ?? []).forEach((l: { account_id: string; debit: number; credit: number }) => {
        const cur = m[l.account_id] ?? { account_id: l.account_id, debit: 0, credit: 0 }
        cur.debit += Number(l.debit); cur.credit += Number(l.credit)
        m[l.account_id] = cur
      })
      setRangeLedger(m)
    })()
  }, [reportType, accounts, from, to, supabase])

  const netCredit = (a: Account) => (rangeLedger[a.id]?.credit ?? 0) - (rangeLedger[a.id]?.debit ?? 0)
  const netDebit = (a: Account) => (rangeLedger[a.id]?.debit ?? 0) - (rangeLedger[a.id]?.credit ?? 0)

  const grossRevenue = incomeExpense.incomeAccounts.reduce((s, a) => s + netCredit(a), 0)
  const discountTotal = incomeExpense.discountAccount ? netDebit(incomeExpense.discountAccount) : 0
  const netRevenue = grossRevenue - discountTotal
  const cogsTotal = incomeExpense.cogsAccount ? netDebit(incomeExpense.cogsAccount) : 0
  const grossProfit = netRevenue - cogsTotal
  const totalExpenseInRange = incomeExpense.expenseAccounts.reduce((s, a) => s + netDebit(a), 0)
  const netSurplus = grossProfit - totalExpenseInRange

  useEffect(() => {
    if (reportType !== 'account_statement' || !selectedAccountId) { setStatementRows([]); return }
    (async () => {
      const acc = accounts.find((a) => a.id === selectedAccountId)
      if (!acc) return
      const [{ data: prior }, { data: range }] = await Promise.all([
        supabase.from('ledger_entries').select('debit, credit').eq('account_id', selectedAccountId).lt('entry_date', from),
        supabase.from('ledger_entries').select('id, entry_date, particular, bill_number, receipt_no, debit, credit').eq('account_id', selectedAccountId).gte('entry_date', from).lte('entry_date', to).order('entry_date').order('created_at'),
      ])
      const priorNet = (prior ?? []).reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0)
      const isCredit = creditNormal(acc.type)
      setStatementOpening(isCredit ? acc.opening_balance - priorNet : acc.opening_balance + priorNet)
      setStatementRows(range ?? [])
    })()
  }, [reportType, selectedAccountId, from, to, accounts, supabase])

  const handlePrint = () => {
    if (printRef.current) printNodeInPopup(printRef.current, `${reportTypeLabels[reportType]} - ${systemLabels[system]}`)
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6 print:hidden">
        <h1 className="font-heading text-[26px] sm:text-[32px] font-bold leading-[34px] sm:leading-[40px] text-dp-primary">{t('rp.title')}</h1>
        <button onClick={handlePrint} className="filter-btn border border-dp-outline-variant text-dp-on-surface hover:bg-dp-surface-container-low shrink-0">
          <Printer size={15} /> {t('a.print')}
        </button>
      </div>

      {/* Each control gets flex-1 with a sensible minimum so the row fills the
          width on desktop and wraps into clean full-width rows on a phone,
          instead of shrinking to content and stair-stepping. */}
      <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <div className="flex-1 min-w-[160px]">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ac.system')}</label>
          <select value={system} onChange={(e) => setSystem(e.target.value as SystemTab)} className="filter-field">
            {access.canWaterSupply && <option value="water_supply">{t('a.waterSupplySystem')}</option>}
            {access.canDonorsProjects && <option value="donors_projects">{t('a.donorsProjects')}</option>}
          </select>
        </div>
        <div className="flex-1 min-w-[190px]">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('rp.report')}</label>
          <select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)} className="filter-field">
            <option value="trial_balance">{t('rp.trialBalance')}</option>
            <option value="balance_sheet">{t('rp.balanceSheet')}</option>
            <option value="income_expense">{t('rp.profitLoss')}</option>
            {system === 'water_supply' && <option value="consumer_outstanding">{t('rp.consumerOutstanding')}</option>}
            {system === 'donors_projects' && <option value="donor_report">{t('rp.donorReport')}</option>}
            <option value="account_statement">{t('rp.statementLookup')}</option>
          </select>
        </div>
        {(reportType === 'income_expense' || reportType === 'donor_report' || reportType === 'account_statement') && (
          <>
            <div className="flex-1 min-w-[140px]">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.from')}</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="filter-field" />
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('rp.to')}</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="filter-field" />
            </div>
          </>
        )}
        {reportType === 'donor_report' && (
          <div className="flex-1 min-w-[170px]">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.project')}</label>
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="filter-field">
              <option value="">{t('rp.allProjects')}</option>
              {Object.entries(projects).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select>
          </div>
        )}
        {reportType === 'consumer_outstanding' && (
          <div className="flex-1 min-w-[150px]">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.sector')}</label>
            <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)} className="filter-field">
              <option value="">{t('rp.allSectors')}</option>
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {reportType === 'account_statement' && (
          <div className="flex items-end gap-2 flex-1 min-w-[220px] flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('rp.account')}</label>
              <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} className="filter-field">
                <option value="">{t('rp.selectAccount')}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            {selectedAccountId && (
              <Link href={`/admin/accounts/${selectedAccountId}`} className="filter-btn text-dp-secondary hover:underline px-0 sm:px-2">
                <ExternalLink size={13} /> {t('rp.openInChart')}
              </Link>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
      ) : (
        <div ref={printRef} dir={lang === 'ur' ? 'rtl' : 'ltr'} style={lang === 'ur' ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
          <DocumentHeader title={`${dt(lang, reportTypeDocKeys[reportType])} — ${dt(lang, systemLabelKeys[system])}`} className="hidden print:block" />

          {reportType === 'trial_balance' && (
            <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-start min-w-[600px]">
                  <thead>
                    <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                      <th className="px-4 py-2.5">{dt(lang, 'account')}</th>
                      <th className="px-4 py-2.5">{dt(lang, 'header')}</th>
                      <th className="px-4 py-2.5 text-end">{dt(lang, 'debit')}</th>
                      <th className="px-4 py-2.5 text-end">{dt(lang, 'credit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trialBalanceRows.map(({ account, debitCol, creditCol }) => (
                      <tr key={account.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                        <td className="px-4 py-3 font-semibold">{account.name}</td>
                        <td className="px-4 py-3 text-dp-on-surface-variant">{headerLabel(account.type)}</td>
                        <td className="px-4 py-3 text-end">{debitCol > 0 ? fmtAmount(debitCol) : '—'}</td>
                        <td className="px-4 py-3 text-end">{creditCol > 0 ? fmtAmount(creditCol) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-sans text-[13.5px] font-bold bg-dp-surface-container-low/60 border-t-2 border-dp-outline-variant">
                      <td className="px-4 py-3" colSpan={2}>{dt(lang, 'total')}</td>
                      <td className="px-4 py-3 text-end">{fmtAmount(totalDebitCol)}</td>
                      <td className="px-4 py-3 text-end">{fmtAmount(totalCreditCol)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {reportType === 'balance_sheet' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
                <div className="px-4 py-3 bg-dp-surface-container-low/60 border-b border-dp-outline-variant font-sans text-[14px] font-bold">{dt(lang, 'assets')}</div>
                {balanceSheetData.assets.map(({ account, balance }) => (
                  <div key={account.id} className="flex justify-between px-4 py-2.5 border-t border-dp-outline-variant font-sans text-[13.5px]"><span>{account.name}</span><span className="font-semibold">{fmtAmount(balance)}</span></div>
                ))}
                <div className="flex justify-between px-4 py-3 border-t-2 border-dp-outline-variant font-sans text-[14px] font-bold bg-dp-surface-container-low/40"><span>{dt(lang, 'totalAssets')}</span><span>{fmtAmount(balanceSheetData.totalAssets)}</span></div>
              </div>
              <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
                <div className="px-4 py-3 bg-dp-surface-container-low/60 border-b border-dp-outline-variant font-sans text-[14px] font-bold">{dt(lang, 'liabilities')}</div>
                {balanceSheetData.liabilities.map(({ account, balance }) => (
                  <div key={account.id} className="flex justify-between px-4 py-2.5 border-t border-dp-outline-variant font-sans text-[13.5px]"><span>{account.name}</span><span className="font-semibold">{fmtAmount(balance)}</span></div>
                ))}
                <div className="flex justify-between px-4 py-3 border-t-2 border-dp-outline-variant font-sans text-[14px] font-bold bg-dp-surface-container-low/40"><span>{dt(lang, 'totalLiabilities')}</span><span>{fmtAmount(balanceSheetData.totalLiabilities)}</span></div>
                <div className="flex justify-between px-4 py-3 border-t border-dp-outline-variant font-sans text-[13.5px]"><span className="font-semibold">{dt(lang, 'fundBalance')}</span><span className="font-bold">{fmtAmount(balanceSheetData.fundBalance)}</span></div>
              </div>
              <p className="md:col-span-2 font-sans text-[12px] text-dp-on-surface-variant px-1">{dt(lang, 'fundBalanceFootnote')}</p>
            </div>
          )}

          {reportType === 'income_expense' && (
            <div className="max-w-2xl mx-auto">
              <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
                <div className="px-4 py-3 bg-dp-surface-container-low/60 border-b border-dp-outline-variant font-sans text-[14px] font-bold">{dt(lang, 'revenue')}</div>
                {incomeExpense.incomeAccounts.map((a) => (
                  <div key={a.id} className="flex justify-between px-4 py-2.5 border-t border-dp-outline-variant font-sans text-[13.5px]"><span>{a.name}</span><span className="font-semibold">{fmtAmount(netCredit(a))}</span></div>
                ))}
                <div className="flex justify-between px-4 py-2.5 border-t border-dp-outline-variant font-sans text-[13.5px]"><span>{dt(lang, 'grossRevenue')}</span><span className="font-semibold">{fmtAmount(grossRevenue)}</span></div>
                {discountTotal > 0 && (
                  <div className="flex justify-between px-4 py-2.5 border-t border-dp-outline-variant font-sans text-[13.5px] text-emerald-700"><span>{dt(lang, 'lessDiscountGiven')}</span><span>− {fmtAmount(discountTotal)}</span></div>
                )}
                <div className="flex justify-between px-4 py-3 border-t-2 border-dp-outline-variant font-sans text-[14px] font-bold bg-dp-surface-container-low/40"><span>{dt(lang, 'netRevenue')}</span><span>{fmtAmount(netRevenue)}</span></div>

                {incomeExpense.cogsAccount && (
                  <>
                    <div className="flex justify-between px-4 py-2.5 border-t border-dp-outline-variant font-sans text-[13.5px]"><span>{dt(lang, 'lessCogs')}</span><span>− {fmtAmount(cogsTotal)}</span></div>
                    <div className="flex justify-between px-4 py-3 border-t-2 border-dp-outline-variant font-sans text-[14px] font-bold bg-dp-surface-container-low/40"><span>{dt(lang, 'grossProfit')}</span><span>{fmtAmount(grossProfit)}</span></div>
                  </>
                )}

                <div className="px-4 py-3 bg-dp-surface-container-low/60 border-y border-dp-outline-variant font-sans text-[14px] font-bold">{dt(lang, 'operatingExpenses')}</div>
                {incomeExpense.expenseAccounts.map((a) => (
                  <div key={a.id} className="flex justify-between px-4 py-2.5 border-t border-dp-outline-variant font-sans text-[13.5px]"><span>{a.name}</span><span className="font-semibold">{fmtAmount(netDebit(a))}</span></div>
                ))}
                <div className="flex justify-between px-4 py-3 border-t-2 border-dp-outline-variant font-sans text-[14px] font-bold bg-dp-surface-container-low/40"><span>{dt(lang, 'totalOperatingExpenses')}</span><span>{fmtAmount(totalExpenseInRange)}</span></div>

                <div className="flex justify-between items-center px-4 py-5 border-t-2 border-dp-outline-variant">
                  <span className="font-sans text-[15px] font-bold text-dp-on-surface">{dt(lang, 'netSurplusDeficit')}</span>
                  <span className={`font-heading text-[24px] font-bold ${netSurplus >= 0 ? 'text-dp-primary' : 'text-dp-error'}`}>Rs. {fmtAmount(netSurplus)}</span>
                </div>
              </div>
            </div>
          )}

          {reportType === 'consumer_outstanding' && (
            <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-start min-w-[500px]">
                  <thead>
                    <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                      <th className="px-4 py-2.5">{dt(lang, 'consumer')}</th>
                      <th className="px-4 py-2.5">{dt(lang, 'sector')}</th>
                      <th className="px-4 py-2.5">{dt(lang, 'mobile')}</th>
                      <th className="px-4 py-2.5 text-end">{dt(lang, 'outstanding')}</th>
                      <th className="px-4 py-2.5 text-end print:hidden">{dt(lang, 'statement')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consumerOutstanding.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{dt(lang, 'noOutstandingBalances')}</td></tr>}
                    {consumerOutstanding.map(({ account, balance, info }) => (
                      <tr key={account.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                        <td className="px-4 py-3 font-semibold">{account.name}</td>
                        <td className="px-4 py-3 text-dp-on-surface-variant">{info?.sector ?? '—'}</td>
                        <td className="px-4 py-3 text-dp-on-surface-variant">{info?.mobile ?? '—'}</td>
                        <td className="px-4 py-3 text-end font-bold text-dp-error">{fmtAmount(balance)}</td>
                        <td className="px-4 py-3 text-end print:hidden">
                          <Link href={`/admin/accounts/${account.id}`} className="inline-flex items-center gap-1 text-dp-secondary font-semibold hover:underline">
                            <ExternalLink size={13} /> {dt(lang, 'view')}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {consumerOutstanding.length > 0 && (
                    <tfoot>
                      <tr className="font-sans text-[13.5px] font-bold bg-dp-surface-container-low/60 border-t-2 border-dp-outline-variant">
                        <td className="px-4 py-3" colSpan={3}>{dt(lang, 'totalOutstanding')}</td>
                        <td className="px-4 py-3 text-end">{fmtAmount(consumerOutstanding.reduce((s, r) => s + r.balance, 0))}</td>
                        <td className="px-4 py-3 print:hidden"></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}

          {reportType === 'donor_report' && (
            <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-start min-w-[600px]">
                  <thead>
                    <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                      <th className="px-4 py-2.5">{dt(lang, 'date')}</th>
                      <th className="px-4 py-2.5">{dt(lang, 'donor')}</th>
                      <th className="px-4 py-2.5">{dt(lang, 'project')}</th>
                      <th className="px-4 py-2.5">{dt(lang, 'method')}</th>
                      <th className="px-4 py-2.5 text-end">{dt(lang, 'amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDonations.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{dt(lang, 'noDonationsInPeriod')}</td></tr>}
                    {filteredDonations.map((d) => (
                      <tr key={d.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                        <td className="px-4 py-3 whitespace-nowrap">{new Date(d.date).toLocaleDateString('en-GB')}</td>
                        <td className="px-4 py-3 font-semibold">{d.name}</td>
                        <td className="px-4 py-3 text-dp-on-surface-variant">{d.project_id ? projects[d.project_id] ?? '—' : '—'}</td>
                        <td className="px-4 py-3 text-dp-on-surface-variant">{d.payment_method ?? '—'}</td>
                        <td className="px-4 py-3 text-end font-bold">{fmtAmount(d.amount_pkr)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {filteredDonations.length > 0 && (
                    <tfoot>
                      <tr className="font-sans text-[13.5px] font-bold bg-dp-surface-container-low/60 border-t-2 border-dp-outline-variant">
                        <td className="px-4 py-3" colSpan={4}>{dt(lang, 'total')}</td>
                        <td className="px-4 py-3 text-end">{fmtAmount(filteredDonations.reduce((s, d) => s + Number(d.amount_pkr), 0))}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}

          {reportType === 'account_statement' && (
            <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
              {!selectedAccountId ? (
                <div className="px-4 py-12 text-center text-dp-on-surface-variant font-sans">{dt(lang, 'selectAccountToView')}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-start min-w-[550px]">
                    <thead>
                      <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                        <th className="px-4 py-2.5">{dt(lang, 'date')}</th>
                        <th className="px-4 py-2.5">{dt(lang, 'particular')}</th>
                        <th className="px-4 py-2.5">{dt(lang, 'billHash')}</th>
                        <th className="px-4 py-2.5 text-end">{dt(lang, 'debit')}</th>
                        <th className="px-4 py-2.5 text-end">{dt(lang, 'credit')}</th>
                        <th className="px-4 py-2.5 text-end">{dt(lang, 'balance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="font-sans text-[13.5px] bg-dp-surface-container-low/30">
                        <td className="px-4 py-2.5" colSpan={5}>{dt(lang, 'openingBalance')}</td>
                        <td className="px-4 py-2.5 text-end font-bold">{fmtAmount(statementOpening)}</td>
                      </tr>
                      {(() => {
                        const acc = accounts.find((a) => a.id === selectedAccountId)
                        const isCredit = acc ? creditNormal(acc.type) : false
                        let running = statementOpening
                        return statementRows.map((r) => {
                          running += isCredit ? Number(r.credit) - Number(r.debit) : Number(r.debit) - Number(r.credit)
                          return (
                            <tr key={r.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                              <td className="px-4 py-3 whitespace-nowrap">{new Date(r.entry_date).toLocaleDateString('en-GB')}</td>
                              <td className="px-4 py-3">{r.particular}</td>
                              <td className="px-4 py-3 font-mono text-[12px] text-dp-on-surface-variant whitespace-nowrap">
                                {r.bill_number ?? '—'}
                                {r.receipt_no && <span className="block text-dp-secondary">{dt(lang, 'receiptHash')}{r.receipt_no}</span>}
                              </td>
                              <td className="px-4 py-3 text-end">{r.debit > 0 ? fmtAmount(r.debit) : '—'}</td>
                              <td className="px-4 py-3 text-end">{r.credit > 0 ? fmtAmount(r.credit) : '—'}</td>
                              <td className="px-4 py-3 text-end font-bold">{fmtAmount(running)}</td>
                            </tr>
                          )
                        })
                      })()}
                      {statementRows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{dt(lang, 'noTransactionsInPeriod')}</td></tr>}
                    </tbody>
                    {statementRows.length > 0 && (() => {
                      const acc = accounts.find((a) => a.id === selectedAccountId)
                      const isCredit = acc ? creditNormal(acc.type) : false
                      const totalDebit = statementRows.reduce((s, r) => s + Number(r.debit), 0)
                      const totalCredit = statementRows.reduce((s, r) => s + Number(r.credit), 0)
                      const closingBalance = statementOpening + (isCredit ? totalCredit - totalDebit : totalDebit - totalCredit)
                      return (
                        <tfoot>
                          <tr className="font-sans text-[13.5px] font-bold bg-dp-surface-container-low/60 border-t-2 border-dp-outline-variant">
                            <td className="px-4 py-3" colSpan={3}>{dt(lang, 'total')} / {dt(lang, 'closingBalance')}</td>
                            <td className="px-4 py-3 text-end">{fmtAmount(totalDebit)}</td>
                            <td className="px-4 py-3 text-end">{fmtAmount(totalCredit)}</td>
                            <td className="px-4 py-3 text-end">{fmtAmount(closingBalance)}</td>
                          </tr>
                        </tfoot>
                      )
                    })()}
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
