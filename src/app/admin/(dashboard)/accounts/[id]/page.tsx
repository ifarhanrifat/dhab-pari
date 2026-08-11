'use client'

import { useEffect, useState, useCallback, useRef, use as usePromise } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Eye, Pencil, Trash2, Printer, PlusCircle, X, Save, Banknote } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { fetchBrandingSettings } from '@/lib/branding'
import { printNodeInPopup } from '@/lib/receiptExport'
import { entryTypeLabel } from '@/lib/ledgerLabels'
import { dt } from '@/lib/docTranslations'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Account {
  id: string; code: string; name: string; name_ur: string | null
  type: string; system: string; opening_balance: number; is_active: boolean
  consumer_id: string | null; donor_key: string | null; project_id: string | null
}
interface ConsumerInfo {
  consumer_id: string; mobile: string; address: string | null; connections: number
}
interface LedgerRow {
  id: string; account_id: string; entry_date: string; particular: string
  debit: number; credit: number; reference_type: string | null
  reference_id: string | null; bill_number: string | null; receipt_no: string | null
  voucher_type?: string | null; voucher_no?: string | null
}
interface BillStatus { status: string; paid_amount: number; amount_pkr: number; discount_amount: number }

const systemLabels: Record<string, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects System' }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB')
}

export default function ViewAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { t } = useLocale()
  const { id } = usePromise(params)
  const [account, setAccount] = useState<Account | null>(null)
  const [consumerInfo, setConsumerInfo] = useState<ConsumerInfo | null>(null)
  const [rows, setRows] = useState<(LedgerRow & { balance: number })[]>([])
  const [billStatusMap, setBillStatusMap] = useState<Record<string, BillStatus>>({})
  const [paymentBillMap, setPaymentBillMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [confirmDeleteRow, setConfirmDeleteRow] = useState<LedgerRow | null>(null)
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [editBillRow, setEditBillRow] = useState<LedgerRow | null>(null)
  const [billForm, setBillForm] = useState({ month: 1, year: 2026, amount_pkr: 0 })
  const [payBillRow, setPayBillRow] = useState<LedgerRow | null>(null)
  const [payForm, setPayForm] = useState({ amount: 0, method: 'cash', note: '' })
  const [payOutstanding, setPayOutstanding] = useState(0)
  const [paying, setPaying] = useState(false)
  const [showManualForm, setShowManualForm] = useState(false)
  const [manualForm, setManualForm] = useState({ entry_date: new Date().toISOString().slice(0, 10), particular: '', debit: 0, credit: 0 })
  const [printing, setPrinting] = useState(false)
  const [lang, setLang] = useState<'en' | 'ur'>('en')
  const [channels, setChannels] = useState<{ payment_method: string; total_pkr: number }[]>([])
  const statementRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  const load = useCallback(async () => {
    const { data: acc } = await supabase.from('accounts').select('*').eq('id', id).single()
    setAccount(acc)
    if (acc?.type === 'project' && acc.project_id) {
      const { data: ch } = await supabase.rpc('project_donation_channels_pkr', { p_project_id: acc.project_id })
      setChannels(ch ?? [])
    }

    const brandingSettings = await fetchBrandingSettings()
    if (brandingSettings.language === 'ur') setLang('ur')

    if (acc?.type === 'consumer' && acc.consumer_id) {
      const { data: c } = await supabase.from('consumers').select('consumer_id, mobile, address, connections').eq('consumer_id', acc.consumer_id).single()
      setConsumerInfo(c)
    } else {
      setConsumerInfo(null)
    }

    const { data: entries } = await supabase
      .from('ledger_entries')
      .select('*')
      .eq('account_id', id)
      .order('entry_date', { ascending: true })
      .order('created_at', { ascending: true })

    // A ledger row referencing a voucher only stores reference_type='voucher' — the
    // actual voucher_type (Advance, Expense, Security Deposit...) that tells the
    // accountant what really happened lives on the vouchers table itself.
    const voucherIds = Array.from(new Set((entries ?? [])
      .filter((e) => e.reference_type === 'voucher' && e.reference_id)
      .map((e) => e.reference_id as string)))
    let voucherById: Record<string, { voucher_type: string; voucher_no: string | null }> = {}
    if (voucherIds.length > 0) {
      const { data: vouchersData } = await supabase.from('vouchers').select('id, voucher_type, voucher_no').in('id', voucherIds)
      voucherById = Object.fromEntries((vouchersData ?? []).map((v) => [v.id, { voucher_type: v.voucher_type, voucher_no: v.voucher_no }]))
    }

    // Same normal-balance rule as the Chart of Accounts list: income/liability/donor
    // accounts increase with a credit, everything else increases with a debit. Project
    // accounts (migration 118) are the same shape as donor accounts — credited on
    // donations, debited on project-tagged expenses.
    const creditNormal = acc?.type === 'donor' || acc?.type === 'income' || acc?.type === 'liability' || acc?.type === 'project'
    let running = acc?.opening_balance ?? 0
    const withBalance = (entries ?? []).map((e) => {
      running += creditNormal ? Number(e.credit) - Number(e.debit) : Number(e.debit) - Number(e.credit)
      const v = e.reference_id ? voucherById[e.reference_id] : undefined
      return { ...e, voucher_type: v?.voucher_type ?? null, voucher_no: v?.voucher_no ?? null, balance: running }
    })
    setRows(withBalance)

    // Per-row bill status, so the Receive Payment control can be hidden once a bill
    // is fully paid instead of showing unconditionally for every bill-referencing row.
    const billIds = new Set((entries ?? [])
      .filter((e) => e.reference_type === 'bill' && e.reference_id)
      .map((e) => e.reference_id as string))

    // A "payment" ledger row's own balance is the account's running total, not the
    // specific bill's remaining balance — that only lives on payments.bill_id. Resolve
    // it here so receipts can show a reliable Paid/Partial stamp for that one bill.
    const paymentIds = Array.from(new Set((entries ?? [])
      .filter((e) => e.reference_type === 'payment' && e.reference_id)
      .map((e) => e.reference_id as string)))
    let paymentBills: Record<string, string> = {}
    if (paymentIds.length > 0) {
      const { data: paymentsData } = await supabase.from('payments').select('id, bill_id').in('id', paymentIds)
      paymentBills = Object.fromEntries((paymentsData ?? []).filter((p) => p.bill_id).map((p) => [p.id, p.bill_id as string]))
      Object.values(paymentBills).forEach((billId) => billIds.add(billId))
    }
    setPaymentBillMap(paymentBills)

    if (billIds.size > 0) {
      const { data: billsData } = await supabase.from('bills').select('id, status, paid_amount, amount_pkr, discount_amount').in('id', Array.from(billIds))
      setBillStatusMap(Object.fromEntries((billsData ?? []).map((b) => [b.id, { status: b.status, paid_amount: b.paid_amount ?? 0, amount_pkr: b.amount_pkr, discount_amount: b.discount_amount ?? 0 }])))
    } else {
      setBillStatusMap({})
    }
    setLoading(false)
  }, [id, supabase])

  useEffect(() => { load() }, [load])

  const openView = async (row: LedgerRow & { balance: number }) => {
    let receiptNo = row.id.slice(0, 8).toUpperCase()
    let phone: string | null = null
    let billOutstandingAfter: number | null = null
    if (row.reference_type === 'payment' && row.reference_id) {
      const { data } = await supabase.from('payments').select('receipt_no').eq('id', row.reference_id).single()
      if (data?.receipt_no) receiptNo = data.receipt_no
      const billId = paymentBillMap[row.reference_id]
      const bill = billId ? billStatusMap[billId] : undefined
      if (bill) {
        const net = Math.max(bill.amount_pkr - bill.discount_amount, 0)
        billOutstandingAfter = Math.max(net - bill.paid_amount, 0)
      }
    }
    if (consumerInfo) phone = consumerInfo.mobile

    const receiptKind = row.reference_type === 'bill' || row.reference_type === 'payment' || row.reference_type === 'donation' ? row.reference_type : 'manual'
    setReceipt({
      kind: receiptKind,
      receiptNo,
      date: row.entry_date,
      systemLabel: systemLabels[account?.system ?? ''] ?? '',
      accountName: account?.name ?? '',
      accountNameUr: account?.name_ur,
      accountAddress: consumerInfo?.address,
      particular: row.particular,
      amount: row.debit > 0 ? row.debit : row.credit,
      balanceAfter: row.balance,
      billOutstandingAfter,
    })
    void phone
  }

  const handlePrintStatement = () => {
    if (!statementRef.current) return
    setPrinting(true)
    // Hide the Actions column before cloning — it has no place on a printed statement.
    const hidden = Array.from(statementRef.current.querySelectorAll<HTMLElement>('.no-export'))
    const prevDisplay = hidden.map((el) => el.style.display)
    hidden.forEach((el) => { el.style.display = 'none' })
    const scrollers = Array.from(statementRef.current.querySelectorAll<HTMLElement>('.overflow-x-auto'))
    const prevOverflow = scrollers.map((el) => el.style.overflow)
    scrollers.forEach((el) => { el.style.overflow = 'visible' })
    try {
      // Print via an isolated about:blank popup rather than window.print() on the live page —
      // printing the actual admin route would leak its internal URL (and account UUID) into
      // the printed output's browser-injected header/footer.
      const ok = printNodeInPopup(statementRef.current, `Statement - ${account?.name ?? ''}`)
      if (!ok) toast.error('Please allow pop-ups to print this statement')
    } finally {
      hidden.forEach((el, i) => { el.style.display = prevDisplay[i] })
      scrollers.forEach((el, i) => { el.style.overflow = prevOverflow[i] })
      setPrinting(false)
    }
  }

  const openEditBill = async (row: LedgerRow) => {
    if (!row.reference_id) return
    const { data } = await supabase.from('bills').select('*').eq('id', row.reference_id).single()
    if (!data) return
    setBillForm({ month: data.month, year: data.year, amount_pkr: data.amount_pkr })
    setEditBillRow(row)
  }

  const saveBillEdit = async () => {
    if (!editBillRow?.reference_id) return
    const { error } = await supabase.from('bills').update(billForm).eq('id', editBillRow.reference_id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Bill updated')
    setEditBillRow(null)
    load()
  }

  const openReceivePayment = async (row: LedgerRow) => {
    if (!row.reference_id) return
    const { data } = await supabase.from('bills').select('amount_pkr, paid_amount, discount_amount').eq('id', row.reference_id).single()
    if (!data) return
    const outstanding = data.amount_pkr - (data.discount_amount ?? 0) - (data.paid_amount ?? 0)
    if (outstanding <= 0) { toast.info('This bill is already fully paid'); return }
    setPayOutstanding(outstanding)
    setPayForm({ amount: outstanding, method: 'cash', note: '' })
    setPayBillRow(row)
  }

  const savePayment = async () => {
    if (!payBillRow?.reference_id || !account?.consumer_id) return
    // The full entered amount posts even if it exceeds what's outstanding — an
    // overpayment becomes a tracked advance credit on the consumer's ledger rather
    // than being silently discarded.
    const amount = payForm.amount
    if (amount <= 0) { toast.error('Enter a valid amount'); return }
    setPaying(true)
    const { error } = await supabase.from('payments').insert({
      bill_id: payBillRow.reference_id, consumer_id: account.consumer_id,
      amount_pkr: amount, method: payForm.method, note: payForm.note || null,
    })
    setPaying(false)
    if (error) { toast.error(friendlyError(error)); return }
    if (amount > payOutstanding) {
      toast.success(`Payment recorded — Rs. ${fmtAmount(amount - payOutstanding)} credited as advance balance`)
    } else {
      toast.success(amount >= payOutstanding ? 'Payment recorded — bill paid in full' : `Partial payment of Rs. ${fmtAmount(amount)} recorded`)
    }
    setPayBillRow(null)
    load()
  }

  const deleteRow = async () => {
    if (!confirmDeleteRow) return
    const row = confirmDeleteRow
    let error = null
    if (row.reference_type === 'bill' && row.reference_id) {
      ({ error } = await supabase.from('bills').delete().eq('id', row.reference_id))
    } else if (row.reference_type === 'payment' && row.reference_id) {
      ({ error } = await supabase.from('payments').delete().eq('id', row.reference_id))
    } else if (row.reference_type === 'donation' && row.reference_id) {
      ({ error } = await supabase.from('donors').delete().eq('id', row.reference_id))
    } else {
      ({ error } = await supabase.from('ledger_entries').delete().eq('id', row.id))
    }
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Transaction deleted')
    setConfirmDeleteRow(null)
    load()
  }

  const saveManualEntry = async () => {
    if (!manualForm.particular.trim()) { toast.error('Particular is required'); return }
    if (!manualForm.debit && !manualForm.credit) { toast.error('Enter a debit or credit amount'); return }
    const { error } = await supabase.from('ledger_entries').insert({
      account_id: id, entry_date: manualForm.entry_date, particular: manualForm.particular,
      debit: manualForm.debit || 0, credit: manualForm.credit || 0, reference_type: 'manual',
    })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Entry added')
    setShowManualForm(false)
    setManualForm({ entry_date: new Date().toISOString().slice(0, 10), particular: '', debit: 0, credit: 0 })
    load()
  }

  if (loading) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans">{t('y.loadingAccount')}</div>
  }
  if (!account) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center">
        <p className="font-sans text-dp-on-surface-variant mb-4">{t('y.accountNotFound')}</p>
        <Link href="/admin/accounts" className="text-dp-secondary font-sans font-semibold">{t('y.backToChart')}</Link>
      </div>
    )
  }

  const isParty = account.type === 'consumer' || account.type === 'donor'
  const currentBalance = rows.length > 0 ? rows[rows.length - 1].balance : account.opening_balance
  const accountPrimaryName = lang === 'ur' && account.name_ur ? account.name_ur : account.name
  const accountSecondaryName = lang === 'ur' && account.name_ur ? account.name : account.name_ur

  return (
    <>

      <div className="flex items-center justify-between mb-6 print:hidden">
        <Link href="/admin/accounts" className="flex items-center gap-2 text-dp-on-surface-variant hover:text-dp-primary font-sans text-[14px] font-semibold">
          <ArrowLeft size={16} /> {t('y.backToChart')}
        </Link>
        <div className="flex items-center gap-2">
          {!isParty && (
            <button onClick={() => setShowManualForm(true)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <PlusCircle size={15} /> {t('y.addManualEntry')}
            </button>
          )}
          <button disabled={printing} onClick={handlePrintStatement} className="flex items-center gap-2 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
            <Printer size={15} /> {t('y.printStatement')}
          </button>
        </div>
      </div>

      <div ref={statementRef} dir={lang === 'ur' ? 'rtl' : 'ltr'} style={lang === 'ur' ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 mb-4">
        <DocumentHeader title={dt(lang, account.system === 'donors_projects' ? 'donorsProjectsSystem' : 'waterSupplySystem')} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-heading text-[24px] font-bold text-dp-primary">{accountPrimaryName}</h1>
            {lang === 'ur' && accountSecondaryName && (
              <p className="text-[15px] text-dp-on-surface-variant">
                {accountSecondaryName}
              </p>
            )}
            {consumerInfo && (
              <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">
                {consumerInfo.mobile}{consumerInfo.address ? ` · ${consumerInfo.address}` : ''} · {consumerInfo.connections} connection{consumerInfo.connections === 1 ? '' : 's'}
              </p>
            )}
            <p className="font-mono text-[12px] text-dp-on-surface-variant mt-1">{account.code}</p>
          </div>
          <div className="text-end">
            <p className="font-sans text-[12px] font-bold tracking-widest uppercase text-dp-on-surface-variant">
              {dt(lang, account.type === 'donor' ? 'totalContributed' : account.type === 'consumer' && currentBalance < 0 ? 'advanceBalance' : 'currentBalance')}
            </p>
            <p className={`font-heading text-[28px] font-bold ${account.type === 'consumer' && currentBalance > 0 ? 'text-dp-error' : account.type === 'consumer' && currentBalance < 0 ? 'text-emerald-600' : 'text-dp-primary'}`}>
              Rs. {fmtAmount(account.type === 'consumer' && currentBalance < 0 ? -currentBalance : currentBalance)}
            </p>
          </div>
        </div>
        {account.type === 'project' && channels.length > 0 && (
          <div className="mt-4 pt-4 border-t border-dp-outline-variant">
            <p className="font-sans text-[11px] font-bold tracking-widest uppercase text-dp-on-surface-variant mb-2">{dt(lang, 'receivedVia')}</p>
            <div className="flex flex-wrap gap-4">
              {channels.map((c) => (
                <p key={c.payment_method} className="font-sans text-[13.5px] text-dp-on-surface">
                  <span className="capitalize font-semibold">{c.payment_method}</span>: Rs. {fmtAmount(c.total_pkr)}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start min-w-[720px]">
            <thead>
              <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                <th className="px-4 py-2.5">{dt(lang, 'date')}</th>
                <th className="px-4 py-2.5">{dt(lang, 'type')}</th>
                <th className="px-4 py-2.5">{dt(lang, 'particular')}</th>
                <th className="px-4 py-2.5">{dt(lang, 'billHash')}</th>
                {consumerInfo && <th className="px-4 py-2.5 text-center">{dt(lang, 'connections')}</th>}
                {account.type === 'donor' ? (
                  <th className="px-4 py-2.5 text-end">{dt(lang, 'amountDonated')}</th>
                ) : (
                  <>
                    <th className="px-4 py-2.5 text-end">{isParty ? dt(lang, 'billReceivable') : dt(lang, 'debit')}</th>
                    <th className="px-4 py-2.5 text-end">{isParty ? dt(lang, 'paid') : dt(lang, 'credit')}</th>
                  </>
                )}
                <th className="px-4 py-2.5 text-end">{account.type === 'donor' ? dt(lang, 'total') : dt(lang, 'balance')}</th>
                <th className="no-export px-4 py-2.5 text-end print:hidden">{t('a.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDate(row.entry_date)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="inline-block px-2 py-0.5 rounded font-sans text-[11px] font-bold bg-dp-surface-container-low text-dp-on-surface-variant">
                      {entryTypeLabel(row.reference_type, row.voucher_type, lang)}
                    </span>
                  </td>
                  <td className="px-4 py-3">{row.particular}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-dp-on-surface-variant whitespace-nowrap">
                    {row.bill_number ?? row.voucher_no ?? '—'}
                    {row.receipt_no && <span className="block text-dp-secondary">{dt(lang, 'receiptHash')}{row.receipt_no}</span>}
                  </td>
                  {consumerInfo && <td className="px-4 py-3 text-center">{consumerInfo.connections}</td>}
                  {account.type === 'donor' ? (
                    <td className="px-4 py-3 text-end">{fmtAmount(row.credit)}</td>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-end">{row.debit > 0 ? fmtAmount(row.debit) : '—'}</td>
                      <td className="px-4 py-3 text-end">{row.credit > 0 ? fmtAmount(row.credit) : '—'}</td>
                    </>
                  )}
                  <td className="px-4 py-3 text-end font-bold">{fmtAmount(row.balance)}</td>
                  <td className="no-export px-4 py-3 text-end print:hidden">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => openView(row)} title="View" className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Eye size={15} /></button>
                      {row.reference_type === 'bill' && row.reference_id && (
                        <>
                          {billStatusMap[row.reference_id]?.status === 'paid' ? (
                            <span className="text-[10px] font-black uppercase px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 whitespace-nowrap">{t('w.paid')}</span>
                          ) : (
                            <>
                              {billStatusMap[row.reference_id]?.status === 'partial' && (
                                <span className="text-[10px] font-black uppercase px-2 py-1 rounded-full bg-amber-100 text-amber-800 whitespace-nowrap">
                                  Partial: Rs {fmtAmount(billStatusMap[row.reference_id].amount_pkr - billStatusMap[row.reference_id].discount_amount - billStatusMap[row.reference_id].paid_amount)}
                                </span>
                              )}
                              <button onClick={() => openReceivePayment(row)} title="Receive Now" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Banknote size={15} /></button>
                            </>
                          )}
                          <button onClick={() => openEditBill(row)} title="Edit" className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={15} /></button>
                        </>
                      )}
                      <button onClick={() => setConfirmDeleteRow(row)} title="Delete" className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5 + (consumerInfo ? 1 : 0) + (account.type === 'donor' ? 2 : 3)} className="px-4 py-12 text-center text-dp-on-surface-variant font-sans">
                    {dt(lang, 'noTransactionsYet')}
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (() => {
              const totalDebit = rows.reduce((s, r) => s + Number(r.debit), 0)
              const totalCredit = rows.reduce((s, r) => s + Number(r.credit), 0)
              const closingBalance = rows[rows.length - 1].balance
              return (
                <tfoot>
                  <tr className="font-sans text-[13.5px] font-bold bg-dp-surface-container-low/60 border-t-2 border-dp-outline-variant">
                    <td className="px-4 py-3" colSpan={4 + (consumerInfo ? 1 : 0)}>{dt(lang, 'total')}</td>
                    {account.type === 'donor' ? (
                      <td className="px-4 py-3 text-end">{fmtAmount(totalCredit)}</td>
                    ) : (
                      <>
                        <td className="px-4 py-3 text-end">{fmtAmount(totalDebit)}</td>
                        <td className="px-4 py-3 text-end">{fmtAmount(totalCredit)}</td>
                      </>
                    )}
                    <td className="px-4 py-3 text-end">{fmtAmount(closingBalance)}</td>
                    <td className="no-export px-4 py-3 print:hidden"></td>
                  </tr>
                </tfoot>
              )
            })()}
          </table>
        </div>
      </div>
      </div>

      <ConfirmDialog
        open={!!confirmDeleteRow}
        title="Delete Transaction"
        message="Are you sure you want to delete this transaction? This cannot be undone."
        onConfirm={deleteRow}
        onCancel={() => setConfirmDeleteRow(null)}
      />

      {receipt && <ReceiptModal data={receipt} phone={consumerInfo?.mobile} system={account?.system === 'donors_projects' ? 'donors_projects' : 'water_supply'} onClose={() => setReceipt(null)} />}

      {editBillRow && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEditBillRow(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('g.editBill')}</h2>
              <button onClick={() => setEditBillRow(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.month')}</label>
                  <input type="number" min={1} max={12} value={billForm.month || ''} onChange={(e) => setBillForm({ ...billForm, month: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.year')}</label>
                  <input type="number" value={billForm.year || ''} onChange={(e) => setBillForm({ ...billForm, year: +e.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                <input type="number" value={billForm.amount_pkr || ''} onChange={(e) => setBillForm({ ...billForm, amount_pkr: +e.target.value })} className="input-field" />
              </div>
              <button onClick={saveBillEdit} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> {t('g.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {payBillRow && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayBillRow(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('f.receivePayment')}</h2>
              <button onClick={() => setPayBillRow(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{payBillRow.particular} · Outstanding: Rs. {fmtAmount(payOutstanding)}</p>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                <input type="number" value={payForm.amount || ''} onChange={(e) => setPayForm({ ...payForm, amount: +e.target.value })} className="input-field" />
                {payForm.amount > payOutstanding && (
                  <p className="text-[12px] font-sans text-dp-secondary mt-1.5">
                    Rs. {fmtAmount(payForm.amount - payOutstanding)} above the bill will be recorded as an advance credit on this consumer&apos;s account.
                  </p>
                )}
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.method')}</label>
                <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className="input-field">
                  <option value="cash">{t('w.cash')}</option>
                  <option value="jazzcash">{t('w.jazzcash')}</option>
                  <option value="easypaisa">{t('w.easypaisa')}</option>
                  <option value="bank">{t('w.bankTransfer')}</option>
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.noteOptional')}</label>
                <input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} className="input-field" />
              </div>
              <button disabled={paying} onClick={savePayment} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Banknote size={16} /> {t('billing.recordPayment')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showManualForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowManualForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('y.addManualEntry')}</h2>
              <button onClick={() => setShowManualForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.date')}</label>
                <input type="date" value={manualForm.entry_date} onChange={(e) => setManualForm({ ...manualForm, entry_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.particular')}</label>
                <input value={manualForm.particular} onChange={(e) => setManualForm({ ...manualForm, particular: e.target.value })} className="input-field" placeholder="e.g. Cash deposit" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.debit')}</label>
                  <input type="number" value={manualForm.debit || ''} onChange={(e) => setManualForm({ ...manualForm, debit: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.credit')}</label>
                  <input type="number" value={manualForm.credit || ''} onChange={(e) => setManualForm({ ...manualForm, credit: +e.target.value })} className="input-field" />
                </div>
              </div>
              <button onClick={saveManualEntry} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> {t('y.addEntry')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
