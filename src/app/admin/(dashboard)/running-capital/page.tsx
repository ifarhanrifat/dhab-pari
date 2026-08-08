'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  Wallet, Landmark, TrendingUp, TrendingDown, Printer, X, ChevronDown, ChevronUp,
  FileText, UserCheck, UserPlus, MessageSquareWarning, ClipboardList, Heart, FolderKanban, ArrowDownToLine, ArrowUpFromLine, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { fetchBrandingSettings } from '@/lib/branding'
import { dt, type Lang } from '@/lib/docTranslations'
import {
  buildClosingNarrative, buildDonorClosingNarrative, expenseCashOutCategories, urduDate,
  type ClosingReportData, type ExpenseLine, type ComplaintEntry, type CashCategoryAmount,
  type NonPayerOpinion, type PendingBillConsumer, type NonPayerDueToComplaint, type TwoMonthDefaulter,
} from '@/lib/monthlyClosingNarrative'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import { printNodeInPopup } from '@/lib/receiptExport'

type SystemTab = 'water_supply' | 'donors_projects'
interface ClosingRow extends ClosingReportData { id: string }

const monthNamesEn = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const taskStatusLabel: Record<string, string> = { unassigned: 'Unassigned', assigned: 'Assigned', in_progress: 'In Progress', done: 'Done' }
const projectStatusLabel: Record<string, string> = { ongoing: 'Ongoing', completed: 'Completed', upcoming: 'Upcoming' }

function fmtAmount(n: number | null | undefined) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-3 mt-8 first:mt-0">{children}</h2>
}

function StatCard({ icon, label, value, tone = 'default' }: { icon: React.ReactNode; label: string; value: string; tone?: 'default' | 'good' | 'bad' }) {
  const toneClass = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-dp-error' : 'text-dp-on-surface'
  return (
    <div className="bg-white rounded-lg border border-dp-outline-variant p-4">
      <div className="flex items-center gap-2 text-dp-on-surface-variant mb-2">{icon}<span className="font-sans text-[12px] font-bold uppercase tracking-[0.04em]">{label}</span></div>
      <p className={`font-heading text-[22px] font-bold ${toneClass}`}>Rs. {value}</p>
    </div>
  )
}

// Shared by both systems — a voucher/purchase's real approver trail (or a clear
// "No approval required" / "Auto-posted" fallback) instead of a bare description.
function ExpenseTable({ lines }: { lines: ExpenseLine[] }) {
  return (
    <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
      <table className="w-full text-left">
        <thead>
          <tr className="text-dp-on-surface-variant text-[11px] font-sans font-bold uppercase tracking-[0.04em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
            <th className="px-4 py-2.5">Description</th>
            <th className="px-4 py-2.5">Approved By</th>
            <th className="px-4 py-2.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-dp-on-surface-variant font-sans text-[13px]">—</td></tr>}
          {lines.map((e, i) => (
            <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[13.5px]">
              <td className="px-4 py-2.5">{e.description}</td>
              <td className="px-4 py-2.5 text-[12.5px]">
                {(e.approved_by ?? []).length > 0 ? (
                  <span className="flex items-center gap-1.5 text-dp-on-surface-variant"><UserCheck size={13} className="text-emerald-600 shrink-0" /> {e.approved_by.join(', ')}</span>
                ) : e.auto_posted ? (
                  <span className="text-amber-700 font-semibold">Auto-posted</span>
                ) : (
                  <span className="text-dp-on-surface-variant">No approval required</span>
                )}
              </td>
              <td className={`px-4 py-2.5 text-right font-semibold whitespace-nowrap ${e.amount < 0 ? 'text-emerald-600' : ''}`}>Rs. {fmtAmount(e.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The Urdu monthly narrative points at this table instead of embedding the
// itemized breakdown as a comma-joined sentence — a wall of line items read
// as unprofessional when written as prose. RTL, Urdu column headers, but
// descriptions/approver names stay exactly as entered (never machine-translated).
// Compact (tight padding/font) — this only ever renders inside the printed
// report, never the live dashboard, so there's no separate on-screen size to preserve.
function UrduExpenseTable({ lines }: { lines: ExpenseLine[] }) {
  return (
    <div dir="rtl" className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden w-fit" style={{ fontFamily: 'var(--font-urdu), serif' }}>
      <table className="text-right">
        <thead>
          <tr className="text-dp-on-surface-variant text-[9.5px] font-sans font-bold border-b border-dp-outline-variant bg-dp-surface-container-low/60">
            <th className="px-2 py-1">تفصیل</th>
            <th className="px-2 py-1">منظوری</th>
            <th className="px-2 py-1 text-left">رقم</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && <tr><td colSpan={3} className="px-2 py-2 text-center text-dp-on-surface-variant font-sans text-[10px]">—</td></tr>}
          {lines.map((e, i) => (
            <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[10px]">
              <td className="px-2 py-0.5" style={{ direction: 'ltr', textAlign: 'right' }}>{e.description}</td>
              <td className="px-2 py-0.5 text-[9.5px]" style={{ direction: 'ltr', textAlign: 'right' }}>
                {(e.approved_by ?? []).length > 0 ? (
                  <span className="flex items-center gap-1 justify-end text-dp-on-surface-variant">{e.approved_by.join('، ')} <UserCheck size={10} className="text-emerald-600 shrink-0" /></span>
                ) : e.auto_posted ? (
                  <span className="text-amber-700 font-semibold">خودکار پوسٹ</span>
                ) : (
                  <span className="text-dp-on-surface-variant">کوئی منظوری درکار نہیں</span>
                )}
              </td>
              <td className={`px-2 py-0.5 text-left font-semibold whitespace-nowrap ${e.amount < 0 ? 'text-emerald-600' : ''}`}>روپے {fmtAmount(e.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Each table sizes to its own content (no forced equal-width columns — that
// made a 2-row, 5-line table look identical in width to a 20-row one) and
// sits centered on the page individually, not paired into rows.
function PrintTableBlock({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex flex-col items-center">
      <p dir="rtl" className="font-sans text-[10px] font-bold text-dp-primary mb-1" style={{ fontFamily: 'var(--font-urdu), serif' }}>{heading}</p>
      {children}
    </div>
  )
}

// Same compact styling as UrduExpenseTable — the discount detail previously
// lived only as a comma-joined sentence in the narrative.
function UrduDiscountTable({ lines }: { lines: { consumer_name: string; amount: number }[] }) {
  if (lines.length === 0) return null
  return (
    <div dir="rtl" className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden w-fit" style={{ fontFamily: 'var(--font-urdu), serif' }}>
      <table className="text-right">
        <thead>
          <tr className="text-dp-on-surface-variant text-[9.5px] font-sans font-bold border-b border-dp-outline-variant bg-dp-surface-container-low/60">
            <th className="px-2 py-1">صارف</th>
            <th className="px-2 py-1 text-left">رعایت</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((d, i) => (
            <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[10px]">
              <td className="px-2 py-0.5" style={{ direction: 'ltr', textAlign: 'right' }}>{d.consumer_name}</td>
              <td className="px-2 py-0.5 text-left font-semibold whitespace-nowrap">روپے {fmtAmount(d.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Pending bills grouped under a sector heading — same grouping pattern
// already used for agenda task categories in AgendaMinutesDocument.tsx.
function UrduPendingBillsBySectorTable({ consumers }: { consumers: PendingBillConsumer[] }) {
  if (consumers.length === 0) return null
  const sectors = Array.from(new Set(consumers.map((c) => c.sector))).sort()
  return (
    <div dir="rtl" className="w-fit" style={{ fontFamily: 'var(--font-urdu), serif' }}>
      {sectors.map((sector) => {
        const rows = consumers.filter((c) => c.sector === sector)
        const total = rows.reduce((s, r) => s + Number(r.amount), 0)
        return (
          <div key={sector} className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-1 last:mb-0">
            <div className="flex items-center justify-between gap-4 px-2 py-0.5 bg-dp-surface-container-low/60 border-b border-dp-outline-variant">
              <span className="font-sans text-[9.5px] font-bold text-dp-primary">{sector}</span>
              <span className="font-sans text-[9.5px] font-semibold">روپے {fmtAmount(total)}</span>
            </div>
            <table className="text-right">
              <tbody>
                {rows.map((c, i) => (
                  <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[10px]">
                    <td className="px-2 py-0.5" style={{ direction: 'ltr', textAlign: 'right' }}>{c.consumer_name}</td>
                    <td className="px-2 py-0.5 text-left font-semibold whitespace-nowrap w-20">روپے {fmtAmount(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// consumer_nonpayment_flags (064) already detects exactly "2 consecutive
// unpaid months" — reused directly (migration 114), not re-derived.
function UrduTwoMonthDefaultersTable({ defaulters }: { defaulters: TwoMonthDefaulter[] }) {
  if (defaulters.length === 0) return null
  return (
    <div dir="rtl" className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden w-fit" style={{ fontFamily: 'var(--font-urdu), serif' }}>
      <table className="text-right">
        <thead>
          <tr className="text-dp-on-surface-variant text-[9.5px] font-sans font-bold border-b border-dp-outline-variant bg-dp-surface-container-low/60">
            <th className="px-2 py-1">صارف</th>
            <th className="px-2 py-1">سیکٹر</th>
            <th className="px-2 py-1 text-left">بقایا</th>
          </tr>
        </thead>
        <tbody>
          {defaulters.map((d, i) => (
            <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[10px]">
              <td className="px-2 py-0.5" style={{ direction: 'ltr', textAlign: 'right' }}>{d.consumer_name}</td>
              <td className="px-2 py-0.5 text-dp-on-surface-variant">{d.sector ?? '—'}</td>
              <td className="px-2 py-0.5 text-left font-semibold whitespace-nowrap">روپے {fmtAmount(d.outstanding)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The one human-entered field (committee's opinion) sits alongside the
// auto-detected complaint/unpaid dates — same data the editable panel below
// (print:hidden) lets the accountant fill in.
function UrduNonPayersDueToComplaintTable({ entries, opinions }: { entries: NonPayerDueToComplaint[]; opinions: NonPayerOpinion[] }) {
  if (entries.length === 0) return null
  return (
    <div dir="rtl" className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden w-fit" style={{ fontFamily: 'var(--font-urdu), serif' }}>
      <table className="text-right">
        <thead>
          <tr className="text-dp-on-surface-variant text-[9.5px] font-sans font-bold border-b border-dp-outline-variant bg-dp-surface-container-low/60">
            <th className="px-2 py-1">صارف</th>
            <th className="px-2 py-1">شکایت</th>
            <th className="px-2 py-1">عدم ادائیگی</th>
            <th className="px-2 py-1 text-left">بقایا</th>
            <th className="px-2 py-1">رائے</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((n, i) => (
            <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[10px]">
              <td className="px-2 py-0.5" style={{ direction: 'ltr', textAlign: 'right' }}>{n.name}{n.sector ? ` (${n.sector})` : ''}</td>
              <td className="px-2 py-0.5 text-dp-on-surface-variant whitespace-nowrap">{urduDate(n.complaint_since)}</td>
              <td className="px-2 py-0.5 text-dp-on-surface-variant whitespace-nowrap">{urduDate(n.unpaid_since)}</td>
              <td className="px-2 py-0.5 text-left font-semibold whitespace-nowrap">روپے {fmtAmount(n.outstanding)}</td>
              <td className="px-2 py-0.5 text-dp-on-surface-variant">{opinions.find((o) => o.consumer_id === n.consumer_id)?.opinion?.trim() || 'ابھی زیر غور'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const complaintStatusMeta: Record<ComplaintEntry['status'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-red-100 text-red-700' },
  awaiting_verification: { label: 'Resolved — Awaiting Verification', cls: 'bg-amber-100 text-amber-800' },
  verified: { label: 'Resolved & Verified', cls: 'bg-emerald-100 text-emerald-700' },
}

// Shows each complaint's real current status instead of listing it as a bare
// unresolved item forever — a complaint the handler already closed and
// higher management already verified looked identical to a brand new one
// before this (migration 112 added status/incharge/resolved-by to the data).
function ComplaintList({ complaints }: { complaints: ComplaintEntry[] }) {
  return (
    <div className="bg-white rounded-lg border border-dp-outline-variant divide-y divide-dp-outline-variant">
      {complaints.map((c, i) => {
        const meta = complaintStatusMeta[c.status] ?? complaintStatusMeta.open
        return (
          <div key={i} className="p-3.5 flex items-start gap-3">
            <MessageSquareWarning size={16} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{c.name ?? 'Unknown'} {c.sector && <span className="font-normal text-dp-on-surface-variant">— Sector {c.sector}</span>}</p>
                <span className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold shrink-0 ${meta.cls}`}>{meta.label}</span>
              </div>
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{c.text}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                {c.status === 'verified'
                  ? <>Resolved by <span className="font-semibold">{c.resolved_by_name ?? 'Unknown'}</span>{c.resolved_at ? ` on ${new Date(c.resolved_at).toLocaleDateString('en-GB')}` : ''}</>
                  : <>Incharge: <span className="font-semibold">{c.incharge_name ?? 'Not yet assigned'}</span></>}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Purchases, advances, security-deposit refunds, internal transfers — real
// cash outflows that aren't "Expenses" (those already have their own table
// above) but were previously invisible: cash_out_breakdown already computed
// them, this page just never rendered it.
function OtherOutgoingPayments({ breakdown }: { breakdown: CashCategoryAmount[] }) {
  const other = breakdown.filter((c) => !expenseCashOutCategories.has(c.category))
  if (other.length === 0) return null
  return (
    <>
      <SectionHeading>Other Outgoing Payments</SectionHeading>
      <div className="bg-white rounded-lg border border-dp-outline-variant divide-y divide-dp-outline-variant">
        {other.map((c, i) => (
          <div key={i} className="p-3.5 flex items-center justify-between gap-3">
            <span className="font-sans text-[13.5px] text-dp-on-surface">{c.category}</span>
            <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">Rs. {fmtAmount(c.amount)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

export default function RunningCapitalPage() {
  const access = useSystemAccess()
  const [system, setSystem] = useState<SystemTab>('water_supply')
  useEffect(() => { if (!access.loading) setSystem(access.defaultSystem) }, [access.loading, access.defaultSystem])

  const [lang, setLang] = useState<Lang>('en')
  const [live, setLive] = useState<ClosingReportData | null>(null)
  const [loadingLive, setLoadingLive] = useState(true)
  const [reports, setReports] = useState<ClosingRow[]>([])
  const [loadingReports, setLoadingReports] = useState(true)
  const [showDiscountDetail, setShowDiscountDetail] = useState(false)
  const [canManage, setCanManage] = useState(false)
  const [viewTarget, setViewTarget] = useState<ClosingRow | null>(null)
  const [editingOpinions, setEditingOpinions] = useState<Record<string, string>>({})
  const [savingOpinions, setSavingOpinions] = useState(false)
  const [reconciliationRemarks, setReconciliationRemarks] = useState('')
  const [savingRemarks, setSavingRemarks] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  useEffect(() => { fetchBrandingSettings().then((b) => setLang(b.language)) }, [])

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data: me } = await supabase.from('admin_users').select('role, can_post_transactions').eq('auth_user_id', user.id).single()
      setCanManage(!!me && me.role !== 'viewer' && (me.role === 'super_admin' || me.can_post_transactions))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async () => {
    setLoadingLive(true)
    const now = new Date()
    const { data: liveData, error } = await supabase.rpc('compute_monthly_closing', {
      p_system: system, p_month: now.getMonth() + 1, p_year: now.getFullYear(),
    })
    if (error) toast.error(friendlyError(error))
    setLive(error ? null : (liveData as ClosingReportData))
    setLoadingLive(false)

    setLoadingReports(true)
    const { data: reportRows } = await supabase.from('monthly_closing_reports').select('*')
      .eq('system', system).order('report_year', { ascending: false }).order('report_month', { ascending: false })
    setReports((reportRows ?? []) as ClosingRow[])
    setLoadingReports(false)
  }, [system, supabase])

  useEffect(() => { load() }, [load])

  const openView = (r: ClosingRow) => {
    setViewTarget(r)
    setEditingOpinions(Object.fromEntries((r.non_payer_opinions ?? []).map((o) => [o.consumer_id, o.opinion])))
    setReconciliationRemarks(r.reconciliation_remarks)
  }

  const saveRemarks = async () => {
    if (!viewTarget) return
    setSavingRemarks(true)
    const { error } = await supabase.rpc('update_closing_report_reconciliation_remarks', { p_report_id: viewTarget.id, p_remarks: reconciliationRemarks })
    setSavingRemarks(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Saved')
    setViewTarget({ ...viewTarget, reconciliation_remarks: reconciliationRemarks })
    load()
  }

  // Who's on the list is auto-detected (complaints.consumer_id + outstanding
  // bills, migration 113) — nothing to type there. The committee's opinion is
  // the one thing that's still a human judgment call, saved per consumer_id.
  const saveOpinions = async () => {
    if (!viewTarget) return
    setSavingOpinions(true)
    const opinions: NonPayerOpinion[] = Object.entries(editingOpinions)
      .filter(([, opinion]) => opinion.trim())
      .map(([consumer_id, opinion]) => ({ consumer_id, opinion: opinion.trim() }))
    const { error } = await supabase.rpc('update_closing_report_non_payer_opinions', { p_report_id: viewTarget.id, p_opinions: opinions })
    setSavingOpinions(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Saved')
    setViewTarget({ ...viewTarget, non_payer_opinions: opinions })
    load()
  }

  // Only the cron sweep ever writes a report row (last month's, on the 1st)
  // — an older stale report generated before a report-logic fix (like the
  // discount-exclusion / purchase-labeling / complaint-status fix in
  // migration 112) otherwise sits frozen forever. This recomputes and
  // overwrites one specific report on demand.
  const regenerateReport = async () => {
    if (!viewTarget) return
    setRegenerating(true)
    const { error } = await supabase.rpc('regenerate_monthly_closing_report', { p_report_id: viewTarget.id })
    setRegenerating(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Report regenerated with current figures')
    const { data: refreshed } = await supabase.from('monthly_closing_reports').select('*').eq('id', viewTarget.id).single()
    if (refreshed) setViewTarget(refreshed as ClosingRow)
    load()
  }

  const handlePrint = () => {
    if (printRef.current) printNodeInPopup(printRef.current, `${dt(lang, 'monthlyClosingReports')} — ${monthNamesEn[(viewTarget?.report_month ?? 1) - 1]} ${viewTarget?.report_year}`)
  }

  const systemLabel = dt(lang, system === 'water_supply' ? 'waterSupplySystem' : 'donorsProjectsSystem')
  const netCash = live ? Number(live.this_month_cash) - Number(live.prev_month_cash) : 0
  const grossPosition = live ? Number(live.this_month_cash) + Number(live.total_receivable) : 0
  const netPosition = live ? grossPosition - Number(live.total_payable) : 0

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary">{dt(lang, 'runningCapital')}</h1>
        {!access.loading && (access.canWaterSupply || access.canDonorsProjects) && (
          <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
            {access.canWaterSupply && (
              <button onClick={() => setSystem('water_supply')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'water_supply' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>Water Supply</button>
            )}
            {access.canDonorsProjects && (
              <button onClick={() => setSystem('donors_projects')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'donors_projects' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>Donors &amp; Projects</button>
            )}
          </div>
        )}
      </div>

      {live?.opening_balance_mismatch && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-6 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-700 shrink-0 mt-0.5" />
          <div>
            <p className="font-sans text-[13.5px] font-bold text-amber-900">Opening balance doesn&apos;t match last month&apos;s closing figure</p>
            <p className="font-sans text-[13px] text-amber-800 mt-0.5">
              Expected Rs. {fmtAmount(live.opening_balance_expected)} (last month&apos;s reported closing cash), but the ledger now shows Rs. {fmtAmount(live.opening_balance_actual)}.
              {' '}This means a prior-period transaction was edited or deleted after that month was reported. Open last month&apos;s report below to see what changed and add an explanation.
            </p>
          </div>
        </div>
      )}

      {loadingLive ? (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans">Loading...</div>
      ) : !live ? (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans">Could not load figures.</div>
      ) : system === 'water_supply' ? (
        <>
          <SectionHeading>{dt(lang, 'livePosition')}</SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={<Wallet size={16} />} label={dt(lang, 'totalCash')} value={fmtAmount(Number(live.this_month_cash))} />
            <StatCard icon={<Landmark size={16} />} label={dt(lang, 'totalReceivable')} value={fmtAmount(live.total_receivable)} />
            <StatCard icon={<TrendingDown size={16} />} label={dt(lang, 'totalPayableRC')} value={fmtAmount(live.total_payable)} />
            <StatCard icon={<TrendingUp size={16} />} label={dt(lang, 'grossPosition')} value={fmtAmount(grossPosition)} />
            <StatCard icon={<TrendingUp size={16} />} label={dt(lang, 'netRealizablePosition')} value={fmtAmount(netPosition)} tone={netPosition >= 0 ? 'good' : 'bad'} />
          </div>

          <SectionHeading>Billing This Month</SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={<TrendingUp size={16} />} label="Billed Amount (Gross)" value={fmtAmount(live.this_month_billed)} />
            <StatCard icon={<TrendingDown size={16} />} label="Discount Given" value={fmtAmount(live.this_month_discount)} />
            <StatCard icon={<TrendingUp size={16} />} label="Net Billing Income" value={fmtAmount(live.billing_income)} />
            {live.sale_income != null && <StatCard icon={<TrendingUp size={16} />} label={dt(lang, 'saleServiceIncome')} value={fmtAmount(live.sale_income)} />}
          </div>
          {live.discount_by_consumer.length > 0 && (
            <>
              <button onClick={() => setShowDiscountDetail(!showDiscountDetail)} className="flex items-center gap-1.5 text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer mt-3">
                {showDiscountDetail ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Discount by Consumer
              </button>
              {showDiscountDetail && (
                <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mt-2">
                  <table className="w-full text-left">
                    <tbody>
                      {live.discount_by_consumer.map((d, i) => (
                        <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[13.5px]">
                          <td className="px-4 py-2">{d.consumer_name}</td>
                          <td className="px-4 py-2 text-right font-semibold">Rs. {fmtAmount(d.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <SectionHeading>Expenses This Month</SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
            <StatCard icon={<TrendingDown size={16} />} label={dt(lang, 'totalExpenses')} value={fmtAmount(live.total_expenses)} />
            <StatCard icon={live.net_surplus >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} label={dt(lang, 'netSurplusDeficit')} value={fmtAmount(live.net_surplus)} tone={live.net_surplus >= 0 ? 'good' : 'bad'} />
          </div>
          <ExpenseTable lines={live.expense_lines} />
          <OtherOutgoingPayments breakdown={live.cash_out_breakdown} />

          <SectionHeading>Cash Flow</SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={<ArrowDownToLine size={16} />} label="Cash In This Month" value={fmtAmount(live.cash_in)} tone="good" />
            <StatCard icon={<ArrowUpFromLine size={16} />} label="Cash Out This Month" value={fmtAmount(live.cash_out)} tone="bad" />
            <StatCard icon={<Wallet size={16} />} label={dt(lang, 'previousMonth') + ' — ' + dt(lang, 'totalCash')} value={fmtAmount(live.prev_month_cash)} />
            <StatCard icon={netCash >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} label={dt(lang, 'change')} value={fmtAmount(Math.abs(netCash))} tone={netCash >= 0 ? 'good' : 'bad'} />
            <StatCard icon={<TrendingUp size={16} />} label={dt(lang, 'previousMonthBilling')} value={fmtAmount(live.prev_month_billing)} />
            {live.total_pending_bills > 0 && <StatCard icon={<Landmark size={16} />} label={dt(lang, 'previousMonthReceivable')} value={fmtAmount(live.prev_month_receivable)} />}
            <StatCard icon={<TrendingUp size={16} />} label={dt(lang, 'thisMonthRecovery')} value={fmtAmount(live.this_month_recovery)} />
            {live.total_pending_bills > 0 && <StatCard icon={<TrendingDown size={16} />} label={dt(lang, 'totalPendingToDate')} value={fmtAmount(live.total_pending_bills)} />}
          </div>
          {Object.keys(live.pending_by_sector ?? {}).length > 0 && (
            <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mt-3">
              <p className="font-sans text-[12px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-2">{dt(lang, 'pendingBySector')}</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(live.pending_by_sector).sort(([, a], [, b]) => b - a).map(([sector, amt]) => (
                  <span key={sector} className="px-3 py-1.5 bg-dp-surface-container-low rounded-full font-sans text-[12.5px] font-semibold text-dp-on-surface">{sector}: Rs. {fmtAmount(amt)}</span>
                ))}
              </div>
            </div>
          )}

          <SectionHeading>New Connections This Month</SectionHeading>
          {live.new_connections_detail.length === 0 ? (
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant">No new connections this month.</p>
          ) : (
            <div className="bg-white rounded-lg border border-dp-outline-variant divide-y divide-dp-outline-variant">
              {live.new_connections_detail.map((c, i) => (
                <div key={i} className="p-3.5 flex items-center gap-3">
                  <UserPlus size={16} className="text-dp-secondary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{c.consumer_name}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant">Incharge: {c.incharge_name ?? 'Not yet assigned'}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${c.activated ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{c.activated ? 'Activated' : 'In Progress'}</span>
                </div>
              ))}
            </div>
          )}

          {live.complaints_this_month.length > 0 && (
            <>
              <SectionHeading>Complaints This Month</SectionHeading>
              <ComplaintList complaints={live.complaints_this_month} />
            </>
          )}

          {live.task_progress.length > 0 && (
            <>
              <SectionHeading>Installation Task Progress</SectionHeading>
              <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-dp-on-surface-variant text-[11px] font-sans font-bold uppercase tracking-[0.04em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                      <th className="px-4 py-2.5">Consumer</th>
                      <th className="px-4 py-2.5">Sector</th>
                      <th className="px-4 py-2.5"><ClipboardList size={12} className="inline mr-1" />Incharge</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.task_progress.map((t, i) => (
                      <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[13px]">
                        <td className="px-4 py-2.5">{t.consumer_name} <span className="text-dp-on-surface-variant text-[11.5px]">({t.request_number})</span></td>
                        <td className="px-4 py-2.5 text-dp-on-surface-variant">{t.sector ?? '—'}</td>
                        <td className="px-4 py-2.5 text-dp-on-surface-variant">{t.incharge_name ?? 'Not yet assigned'}</td>
                        <td className="px-4 py-2.5"><span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-dp-surface-container-low">{taskStatusLabel[t.task_status] ?? t.task_status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <SectionHeading>Cash Position</SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={<Wallet size={16} />} label={dt(lang, 'totalCash')} value={fmtAmount(Number(live.this_month_cash))} />
            <StatCard icon={<ArrowDownToLine size={16} />} label="Cash In This Month" value={fmtAmount(live.cash_in)} tone="good" />
            <StatCard icon={<ArrowUpFromLine size={16} />} label="Cash Out This Month" value={fmtAmount(live.cash_out)} tone="bad" />
            <StatCard icon={netCash >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} label={dt(lang, 'change') + ' vs ' + dt(lang, 'previousMonth')} value={fmtAmount(Math.abs(netCash))} tone={netCash >= 0 ? 'good' : 'bad'} />
          </div>

          <SectionHeading>Donations This Month</SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
            <StatCard icon={<Heart size={16} />} label="Donations Received" value={fmtAmount(live.billing_income)} />
            <StatCard icon={<Heart size={16} />} label={dt(lang, 'previousMonth')} value={fmtAmount(live.prev_month_billing)} />
          </div>
          {live.donor_breakdown.by_project.length > 0 && (
            <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mb-3">
              <p className="font-sans text-[12px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-2">By Project</p>
              <div className="flex flex-wrap gap-2">
                {live.donor_breakdown.by_project.map((p, i) => (
                  <span key={i} className="px-3 py-1.5 bg-dp-surface-container-low rounded-full font-sans text-[12.5px] font-semibold text-dp-on-surface">{p.title}: Rs. {fmtAmount(p.total)}</span>
                ))}
              </div>
            </div>
          )}
          {live.donor_breakdown.by_type.length > 0 && (
            <div className="bg-white rounded-lg border border-dp-outline-variant p-4">
              <p className="font-sans text-[12px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-2">By Donor Type</p>
              <div className="flex flex-wrap gap-2">
                {live.donor_breakdown.by_type.map((t, i) => (
                  <span key={i} className="px-3 py-1.5 bg-dp-surface-container-low rounded-full font-sans text-[12.5px] font-semibold text-dp-on-surface capitalize">{t.type}: Rs. {fmtAmount(t.total)}</span>
                ))}
              </div>
            </div>
          )}

          <SectionHeading>Project Progress</SectionHeading>
          {live.project_progress.length === 0 ? (
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant">No projects yet.</p>
          ) : (
            <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-dp-on-surface-variant text-[11px] font-sans font-bold uppercase tracking-[0.04em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                    <th className="px-4 py-2.5"><FolderKanban size={12} className="inline mr-1" />Project</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Progress</th>
                    <th className="px-4 py-2.5 text-right">Budget</th>
                    <th className="px-4 py-2.5 text-right">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {live.project_progress.map((p, i) => (
                    <tr key={i} className="border-b border-dp-outline-variant last:border-0 font-sans text-[13px]">
                      <td className="px-4 py-2.5 font-semibold">{p.title}</td>
                      <td className="px-4 py-2.5"><span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-dp-surface-container-low">{projectStatusLabel[p.status] ?? p.status}</span></td>
                      <td className="px-4 py-2.5 text-dp-on-surface-variant">{p.progress_percent != null ? `${p.progress_percent}%` : '—'}</td>
                      <td className="px-4 py-2.5 text-right">{p.budget_pkr != null ? `Rs. ${fmtAmount(p.budget_pkr)}` : '—'}</td>
                      <td className="px-4 py-2.5 text-right">{p.spent_pkr != null ? `Rs. ${fmtAmount(p.spent_pkr)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <SectionHeading>Expenses This Month</SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
            <StatCard icon={<TrendingDown size={16} />} label={dt(lang, 'totalExpenses')} value={fmtAmount(live.total_expenses)} />
            <StatCard icon={live.net_surplus >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} label={dt(lang, 'netSurplusDeficit')} value={fmtAmount(live.net_surplus)} tone={live.net_surplus >= 0 ? 'good' : 'bad'} />
          </div>
          <ExpenseTable lines={live.expense_lines} />
          <OtherOutgoingPayments breakdown={live.cash_out_breakdown} />

          {live.complaints_this_month.length > 0 && (
            <>
              <SectionHeading>Complaints This Month</SectionHeading>
              <ComplaintList complaints={live.complaints_this_month} />
            </>
          )}
        </>
      )}

      {/* Monthly Closing Reports archive */}
      <SectionHeading>{dt(lang, 'monthlyClosingReports')}</SectionHeading>
      {loadingReports ? (
        <p className="font-sans text-dp-on-surface-variant text-[13.5px]">Loading...</p>
      ) : reports.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{dt(lang, 'noReportsYet')}</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden divide-y divide-dp-outline-variant">
          {reports.map((r) => (
            <div key={r.id} className="p-4 flex items-center justify-between gap-3">
              <div>
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{monthNamesEn[r.report_month - 1]} {r.report_year}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">Rs. {fmtAmount(r.this_month_cash)} cash · Rs. {fmtAmount(r.net_surplus)} net surplus</p>
              </div>
              <button onClick={() => openView(r)} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <FileText size={13} /> {dt(lang, 'viewPrint')}
              </button>
            </div>
          ))}
        </div>
      )}

      {viewTarget && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-center justify-center p-4" onClick={() => setViewTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant shrink-0">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{monthNamesEn[viewTarget.report_month - 1]} {viewTarget.report_year}</h2>
              <div className="flex items-center gap-2">
                {canManage && (
                  <button onClick={regenerateReport} disabled={regenerating} title="Recompute this report with current figures/logic" className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
                    <RefreshCw size={13} className={regenerating ? 'animate-spin' : ''} /> {regenerating ? 'Regenerating...' : 'Regenerate'}
                  </button>
                )}
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer"><Printer size={13} /> Print</button>
                <button onClick={() => setViewTarget(null)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              <div ref={printRef}>
                {/* Scoped to this printed report only — captured by
                    printNodeInPopup's outerHTML copy, so it never leaks into
                    any other document printed elsewhere in the app. No @page
                    rule existed anywhere before this. */}
                <style>{`
                  @page { size: A4; margin: 10mm; }
                  @media print {
                    .monthly-report-print { font-size: 10px; }
                    .monthly-report-print p { margin-bottom: 5px !important; }
                  }
                `}</style>
                <div className="monthly-report-print">
                  <DocumentHeader title={`${dt(lang, 'monthlyClosingReports')} — ${systemLabel}`} className="hidden print:block" />
                  {(() => {
                    const narrative = system === 'water_supply' ? buildClosingNarrative(viewTarget, 'واٹر سپلائی') : buildDonorClosingNarrative(viewTarget)
                    return (
                      <>
                        <p dir="rtl" className="font-sans text-[11px] leading-[1.55] text-dp-on-surface whitespace-pre-wrap" style={{ fontFamily: 'var(--font-urdu), serif', textAlign: 'right' }}>
                          {narrative.before}
                        </p>

                        <PrintTableBlock heading="اخراجات"><UrduExpenseTable lines={viewTarget.expense_lines} /></PrintTableBlock>
                        {viewTarget.discount_by_consumer.length > 0 && (
                          <PrintTableBlock heading="رعایت پانے والے صارفین"><UrduDiscountTable lines={viewTarget.discount_by_consumer} /></PrintTableBlock>
                        )}
                        {viewTarget.pending_bills_by_consumer.length > 0 && (
                          <PrintTableBlock heading="زیر التوا بل — سیکٹر وار"><UrduPendingBillsBySectorTable consumers={viewTarget.pending_bills_by_consumer} /></PrintTableBlock>
                        )}
                        {viewTarget.two_month_defaulters.length > 0 && (
                          <PrintTableBlock heading="مسلسل 2 ماہ سے نادہندہ صارفین"><UrduTwoMonthDefaultersTable defaulters={viewTarget.two_month_defaulters} /></PrintTableBlock>
                        )}
                        {viewTarget.non_payers_due_to_complaint.length > 0 && (
                          <PrintTableBlock heading="شکایت کی وجہ سے عدم ادائیگی"><UrduNonPayersDueToComplaintTable entries={viewTarget.non_payers_due_to_complaint} opinions={viewTarget.non_payer_opinions} /></PrintTableBlock>
                        )}

                        <p dir="rtl" className="font-sans text-[11px] leading-[1.55] text-dp-on-surface whitespace-pre-wrap mt-3" style={{ fontFamily: 'var(--font-urdu), serif', textAlign: 'right' }}>
                          {narrative.after}
                        </p>
                      </>
                    )
                  })()}
                </div>
              </div>

              {viewTarget.opening_balance_mismatch && (
                <div className="border-t border-dp-outline-variant pt-4 print:hidden">
                  <p className="font-sans text-[13px] font-bold text-amber-800 uppercase tracking-[0.05em] mb-2 flex items-center gap-1.5"><AlertTriangle size={14} /> Reconciliation Remarks</p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">Explain why this month&apos;s opening balance didn&apos;t match the previous report — this note is included when the report is printed.</p>
                  <textarea
                    value={reconciliationRemarks} onChange={(e) => setReconciliationRemarks(e.target.value)}
                    disabled={!canManage} rows={3} placeholder="e.g. Deleted a duplicate expense voucher dated last month..."
                    className="input-field w-full disabled:opacity-60"
                  />
                  {canManage && (
                    <button disabled={savingRemarks} onClick={saveRemarks} className="mt-2 px-4 py-1.5 bg-dp-secondary text-white rounded-full font-sans text-[12.5px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                      {savingRemarks ? 'Saving...' : 'Save'}
                    </button>
                  )}
                </div>
              )}

              {system === 'water_supply' && viewTarget.non_payers_due_to_complaint.length > 0 && (
                <div className="border-t border-dp-outline-variant pt-4 print:hidden">
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">{dt(lang, 'nonPayersDueToComplaint')}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">Auto-detected — a consumer with an active complaint and an outstanding bill. Add the committee&apos;s opinion for the printed report; nothing else here is editable.</p>
                  <div className="space-y-3">
                    {viewTarget.non_payers_due_to_complaint.map((n) => (
                      <div key={n.consumer_id} className="border border-dp-outline-variant rounded-lg p-3">
                        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                          <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{n.name}{n.sector ? ` — ${n.sector}` : ''}</p>
                          <span className="font-sans text-[12.5px] font-semibold text-dp-error">Rs. {fmtAmount(n.outstanding)}</span>
                        </div>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">
                          Complaint since {new Date(n.complaint_since).toLocaleDateString('en-GB')}
                          {n.unpaid_since && ` · Unpaid since ${new Date(n.unpaid_since).toLocaleDateString('en-GB')}`}
                        </p>
                        <textarea
                          value={editingOpinions[n.consumer_id] ?? ''} onChange={(e) => setEditingOpinions({ ...editingOpinions, [n.consumer_id]: e.target.value })}
                          disabled={!canManage} rows={2} placeholder="Committee's opinion..."
                          className="input-field w-full disabled:opacity-60 !text-[13px]"
                        />
                      </div>
                    ))}
                  </div>
                  {canManage && (
                    <button disabled={savingOpinions} onClick={saveOpinions} className="mt-3 px-4 py-1.5 bg-dp-secondary text-white rounded-full font-sans text-[12.5px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                      {savingOpinions ? 'Saving...' : 'Save'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
