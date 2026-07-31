'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Printer } from 'lucide-react'
import { printNodeInPopup } from '@/lib/receiptExport'
import { DocumentHeader } from '@/components/admin/DocumentHeader'

type SystemTab = 'water_supply' | 'donors_projects'
const systemLabels: Record<SystemTab, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects' }

interface Row { id: string; entry_date: string; account_name: string; particular: string; bill_number: string | null; receipt_no: string | null; reference_type: string | null; debit: number; credit: number; balance: number }

const today = () => new Date().toISOString().slice(0, 10)

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const referenceTypeLabels: Record<string, string> = {
  bill: 'Bill', payment: 'Receipt', voucher: 'Voucher', donation: 'Donation',
  inventory: 'Inventory', manual: 'Manual',
}
function typeLabel(referenceType: string | null) {
  return referenceType ? (referenceTypeLabels[referenceType] ?? referenceType) : '—'
}

interface DailyRegisterViewProps {
  system: SystemTab
  backHref?: string
}

// Shared by the register nested under a transaction-entry system (finance/[system]/register,
// linked from within that workflow) and the standalone sidebar entry (/admin/register, with
// its own system switcher) — same cash/bank running-balance ledger, two entry points.
export function DailyRegisterView({ system, backHref }: DailyRegisterViewProps) {
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [rows, setRows] = useState<Row[]>([])
  const [openingBalance, setOpeningBalance] = useState(0)
  const [loading, setLoading] = useState(true)
  const printRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  const load = useCallback(async () => {
    setLoading(true)
    const { data: cashBankAccounts } = await supabase
      .from('accounts').select('id, name, opening_balance').eq('system', system).in('type', ['cash', 'bank'])
    const accts = cashBankAccounts ?? []
    const accountsById = Object.fromEntries(accts.map((a) => [a.id, a.name]))
    const ids = accts.map((a) => a.id)

    if (ids.length === 0) {
      setRows([]); setOpeningBalance(0); setLoading(false); return
    }

    const [{ data: priorEntries }, { data: rangeEntries }] = await Promise.all([
      supabase.from('ledger_entries').select('debit, credit').in('account_id', ids).lt('entry_date', from),
      supabase.from('ledger_entries').select('id, entry_date, particular, bill_number, receipt_no, reference_type, debit, credit, account_id, created_at')
        .in('account_id', ids).gte('entry_date', from).lte('entry_date', to)
        .order('entry_date').order('created_at'),
    ])

    const baseOpening = accts.reduce((s, a) => s + Number(a.opening_balance), 0)
    const priorNet = (priorEntries ?? []).reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0)
    const opening = baseOpening + priorNet
    setOpeningBalance(opening)

    let running = opening
    const withBalance: Row[] = (rangeEntries ?? []).map((e) => {
      running += Number(e.debit) - Number(e.credit)
      return {
        id: e.id, entry_date: e.entry_date, particular: e.particular, bill_number: e.bill_number, receipt_no: e.receipt_no,
        reference_type: e.reference_type,
        account_name: accountsById[e.account_id] ?? '—', debit: Number(e.debit), credit: Number(e.credit), balance: running,
      }
    })
    setRows(withBalance)
    setLoading(false)
  }, [system, from, to, supabase])

  useEffect(() => { load() }, [load])

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0)
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0)
  const closingBalance = rows.length > 0 ? rows[rows.length - 1].balance : openingBalance

  const handlePrint = () => {
    if (printRef.current) printNodeInPopup(printRef.current, `Daily Register - ${systemLabels[system]}`)
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6 print:hidden">
        {backHref ? (
          <Link href={backHref} className="flex items-center gap-2 text-dp-on-surface-variant hover:text-dp-primary font-sans text-[14px] font-semibold">
            <ArrowLeft size={16} /> Back to Transactions
          </Link>
        ) : <div />}
        <button onClick={handlePrint} className="flex items-center gap-2 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
          <Printer size={15} /> Print
        </button>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mb-4 flex flex-wrap items-end gap-4 print:hidden">
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field" />
        </div>
        <button onClick={() => { setFrom(today()); setTo(today()) }} className="px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
          Today
        </button>
      </div>

      <div ref={printRef}>
        <div className="bg-white rounded-lg border border-dp-outline-variant p-6 mb-4">
          <DocumentHeader
            title={`Daily Register — ${systemLabels[system]}`}
            subtitle={`${new Date(from).toLocaleDateString('en-GB')} to ${new Date(to).toLocaleDateString('en-GB')}`}
          />
          <div className="flex justify-between">
            <div>
              <p className="font-sans text-[12px] font-bold uppercase tracking-widest text-dp-on-surface-variant">Opening Balance</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">Rs. {fmtAmount(openingBalance)}</p>
            </div>
            <div className="text-right">
              <p className="font-sans text-[12px] font-bold uppercase tracking-widest text-dp-on-surface-variant">Closing Balance</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">Rs. {fmtAmount(closingBalance)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[600px]">
              <thead>
                <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Account</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Particular</th>
                  <th className="px-4 py-2.5">Bill #</th>
                  <th className="px-4 py-2.5 text-right">Debit</th>
                  <th className="px-4 py-2.5 text-right">Credit</th>
                  <th className="px-4 py-2.5 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">Loading...</td></tr>}
                {!loading && rows.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">No cash/bank transactions in this period.</td></tr>}
                {!loading && rows.map((r) => (
                  <tr key={r.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                    <td className="px-4 py-3 whitespace-nowrap">{new Date(r.entry_date).toLocaleDateString('en-GB')}</td>
                    <td className="px-4 py-3">{r.account_name}</td>
                    <td className="px-4 py-3 text-dp-on-surface-variant">{typeLabel(r.reference_type)}</td>
                    <td className="px-4 py-3">{r.particular}</td>
                    <td className="px-4 py-3 font-mono text-[12px] text-dp-on-surface-variant whitespace-nowrap">
                      {r.bill_number ?? '—'}
                      {r.receipt_no && <span className="block text-dp-secondary">Receipt #{r.receipt_no}</span>}
                    </td>
                    <td className="px-4 py-3 text-right">{r.debit > 0 ? fmtAmount(r.debit) : '—'}</td>
                    <td className="px-4 py-3 text-right">{r.credit > 0 ? fmtAmount(r.credit) : '—'}</td>
                    <td className="px-4 py-3 text-right font-bold">{fmtAmount(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="font-sans text-[13.5px] font-bold bg-dp-surface-container-low/60 border-t-2 border-dp-outline-variant">
                    <td className="px-4 py-3" colSpan={5}>Total</td>
                    <td className="px-4 py-3 text-right">{fmtAmount(totalDebit)}</td>
                    <td className="px-4 py-3 text-right">{fmtAmount(totalCredit)}</td>
                    <td className="px-4 py-3 text-right">{fmtAmount(closingBalance)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </>
  )
}
