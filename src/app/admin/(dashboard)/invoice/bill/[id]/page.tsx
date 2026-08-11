'use client'

import { useEffect, useState, useCallback, useRef, use as usePromise } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Printer, Download, Share2, Mail, Pencil, Trash2, ChevronDown, ChevronUp, BookOpen } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ReceiptDocument, type ReceiptData, type InvoiceTemplate } from '@/components/admin/ReceiptDocument'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'
import {
  getPreferredFormat, setPreferredFormat, nodeToPdfBlob, nodeToPngBlob,
  downloadBlob, shareReceipt, printBlob, normalizePakPhone, type ReceiptFormat,
} from '@/lib/receiptExport'

const systemLabels: Record<string, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects' }

interface BillRow {
  id: string; bill_number: string | null; month: number; year: number; amount_pkr: number
  discount_amount: number | null; security_deposit_amount: number | null; paid_amount: number | null
  due_date: string | null; description: string | null; status: string; paid_date: string | null
  payment_method: string | null; consumer_id: string; security_deposit_voucher_id: string | null
  waiver_voucher_id: string | null
}
interface ConsumerRow {
  name: string; name_ur: string | null; mobile: string; whatsapp_number: string | null
  address: string | null; area: string | null; house_no: string | null; sector: string | null
}
interface LineItemRow { description: string; quantity: number; unit_price: number }
interface LedgerRow { id: string; account_name: string; entry_date: string; particular: string; debit: number; credit: number; receipt_no: string | null }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function BillInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params)
  const supabase = createClient()
  const router = useRouter()
  const nodeRef = useRef<HTMLDivElement>(null)

  const [bill, setBill] = useState<BillRow | null>(null)
  const [consumer, setConsumer] = useState<ConsumerRow | null>(null)
  const [lineItems, setLineItems] = useState<LineItemRow[]>([])
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([])
  const [depositReceiptNo, setDepositReceiptNo] = useState<string | null>(null)
  const [waiverVoucherNo, setWaiverVoucherNo] = useState<string | null>(null)
  const [showLedger, setShowLedger] = useState(false)
  const [template, setTemplate] = useState<InvoiceTemplate>('classic')
  const [branding, setBranding] = useState<Partial<BrandingSettings>>({})
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [format, setFormat] = useState<ReceiptFormat>(getPreferredFormat())
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    const { data: billRow } = await supabase.from('bills')
      .select('id, bill_number, month, year, amount_pkr, discount_amount, security_deposit_amount, paid_amount, due_date, description, status, paid_date, payment_method, consumer_id, security_deposit_voucher_id, waiver_voucher_id')
      .eq('id', id).single()
    if (!billRow) { setNotFound(true); setLoading(false); return }
    setBill(billRow)
    if (billRow.waiver_voucher_id) {
      const { data: waiverVoucher } = await supabase.from('vouchers').select('voucher_no').eq('id', billRow.waiver_voucher_id).single()
      setWaiverVoucherNo(waiverVoucher?.voucher_no ?? null)
    } else {
      setWaiverVoucherNo(null)
    }

    const [{ data: consumerRow }, { data: lines }, brandingSettings, { data: billLedger }] = await Promise.all([
      supabase.from('consumers').select('name, name_ur, mobile, whatsapp_number, address, area, house_no, sector').eq('consumer_id', billRow.consumer_id).single(),
      supabase.from('bill_line_items').select('description, quantity, unit_price').eq('bill_id', id).order('created_at'),
      fetchBrandingSettings(),
      supabase.from('ledger_entries').select('id, entry_date, particular, debit, credit, account_id, receipt_no, accounts(name)').eq('reference_type', 'bill').eq('reference_id', id),
    ])
    setConsumer(consumerRow ?? null)
    setLineItems(lines ?? [])
    setTemplate(brandingSettings.invoiceTemplate)
    setBranding(brandingSettings)

    let ledger: LedgerRow[] = (billLedger ?? []).map((r) => ({
      id: r.id, account_name: (r.accounts as unknown as { name: string } | null)?.name ?? '—',
      entry_date: r.entry_date, particular: r.particular, debit: r.debit, credit: r.credit, receipt_no: r.receipt_no,
    }))
    if (billRow.security_deposit_voucher_id) {
      const { data: depositLedger } = await supabase.from('ledger_entries')
        .select('id, entry_date, particular, debit, credit, account_id, receipt_no, accounts(name)')
        .eq('reference_type', 'voucher').eq('reference_id', billRow.security_deposit_voucher_id)
      ledger = ledger.concat((depositLedger ?? []).map((r) => ({
        id: r.id, account_name: (r.accounts as unknown as { name: string } | null)?.name ?? '—',
        entry_date: r.entry_date, particular: r.particular, debit: r.debit, credit: r.credit, receipt_no: r.receipt_no,
      })))
      setDepositReceiptNo(depositLedger?.[0]?.receipt_no ?? null)
    }
    setLedgerRows(ledger)
    setLoading(false)
  }, [id, supabase])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="text-center py-16 text-dp-on-surface-variant font-sans">Loading invoice...</div>
  if (notFound || !bill) return (
    <div className="text-center py-16">
      <p className="font-sans text-dp-on-surface-variant mb-4">This bill could not be found.</p>
      <Link href="/admin/billing" className="text-dp-secondary font-sans font-semibold">← Back to Billing</Link>
    </div>
  )

  const discount = bill.discount_amount ?? 0
  const deposit = bill.security_deposit_amount ?? 0
  const paidAmount = bill.paid_amount ?? 0
  const netAmount = Math.max(bill.amount_pkr - discount, 0)
  const balance = Math.max(netAmount - paidAmount, 0)
  const whatsappPhone = consumer?.whatsapp_number || consumer?.mobile || null
  const address = [consumer?.house_no, consumer?.address, consumer?.sector, consumer?.area].filter(Boolean).join(', ')
  const billingPeriod = new Date(bill.year, bill.month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const data: ReceiptData = {
    kind: 'bill',
    receiptNo: bill.bill_number ?? bill.id.slice(0, 8).toUpperCase(),
    date: bill.due_date ?? new Date(bill.year, bill.month - 1, 1).toISOString().slice(0, 10),
    dueDate: bill.due_date,
    billingPeriod,
    systemLabel: systemLabels.water_supply,
    accountName: consumer?.name ?? bill.consumer_id,
    accountNameUr: consumer?.name_ur,
    accountAddress: address || null,
    accountPhone: consumer?.mobile,
    particular: (bill.description || '') + (waiverVoucherNo ? ` — Committee waiver settled via ${waiverVoucherNo}` : ''),
    amount: netAmount,
    balanceAfter: balance,
    paidAmount,
    lineItems: lineItems.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price })),
    discountAmount: discount,
    securityDepositAmount: deposit,
    securityDepositReceiptNo: depositReceiptNo,
    ...branding,
  }

  const chooseFormat = (f: ReceiptFormat) => { setFormat(f); setPreferredFormat(f) }
  const buildBlob = async () => {
    if (!nodeRef.current) throw new Error('Invoice not ready')
    return format === 'pdf' ? nodeToPdfBlob(nodeRef.current) : nodeToPngBlob(nodeRef.current)
  }
  const filename = () => `invoice-${data.receiptNo}.${format === 'pdf' ? 'pdf' : 'png'}`

  const handlePrint = async () => {
    setBusy(true)
    try {
      const blob = await nodeToPdfBlob(nodeRef.current!)
      printBlob(blob)
    } catch {
      toast.error('Could not prepare the invoice for printing')
    } finally {
      setBusy(false)
    }
  }

  const handleDownload = async () => {
    setBusy(true)
    try {
      const blob = await buildBlob()
      downloadBlob(blob, filename())
      toast.success(`Downloaded ${format.toUpperCase()}`)
    } catch {
      toast.error('Could not generate the file')
    } finally {
      setBusy(false)
    }
  }

  const handleWhatsApp = async () => {
    setBusy(true)
    try {
      const blob = await buildBlob()
      const mime = format === 'pdf' ? 'application/pdf' : 'image/png'
      const result = await shareReceipt({
        blob, filename: filename(), mime, phone: whatsappPhone,
        message: `Water bill ${data.receiptNo} — Rs. ${netAmount.toLocaleString()}`,
      })
      toast.success(result === 'shared' ? 'Shared' : whatsappPhone ? 'Downloaded — WhatsApp opened, attach the file to send' : 'Downloaded — no WhatsApp number on file for this consumer')
    } catch {
      toast.error('Could not share the invoice')
    } finally {
      setBusy(false)
    }
  }

  const handleEmail = async () => {
    setBusy(true)
    try {
      const blob = await buildBlob()
      downloadBlob(blob, filename())
      const subject = encodeURIComponent(`Water Bill ${data.receiptNo}`)
      const body = encodeURIComponent(`Please find attached water bill ${data.receiptNo} for Rs. ${netAmount.toLocaleString()}.\n\n(The invoice file was just downloaded — please attach it to this email before sending.)`)
      window.open(`mailto:?subject=${subject}&body=${body}`, '_blank')
      toast.success('Downloaded — attach it to the email that just opened')
    } catch {
      toast.error('Could not prepare the invoice for email')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    const { error } = await supabase.from('bills').delete().eq('id', bill.id)
    if (error) { toast.error(friendlyError(error)); setConfirmDelete(false); return }
    toast.success('Bill deleted')
    router.push('/admin/billing')
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link href="/admin/billing" className="flex items-center gap-2 text-dp-on-surface-variant hover:text-dp-primary font-sans text-[14px] font-semibold">
          <ArrowLeft size={16} /> Back to Billing
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/admin/finance/water_supply?action=generate_bill&bill=${bill.id}&consumer=${bill.consumer_id}`}
            title={paidAmount > 0 ? 'A payment is recorded — delete it first to edit this bill' : undefined}
            className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer"
          >
            <Pencil size={14} /> Edit Bill
          </Link>
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 px-3 py-2 border border-dp-error/30 text-dp-error rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-error/10 transition-all cursor-pointer"
          >
            <Trash2 size={14} /> Delete
          </button>
          <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
            <button onClick={() => chooseFormat('pdf')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${format === 'pdf' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>PDF</button>
            <button onClick={() => chooseFormat('png')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${format === 'png' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>PNG</button>
          </div>
        </div>
      </div>

      {bill.status === 'paid' && bill.paid_date && (
        <div className="mb-4 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 font-sans text-[13.5px] text-emerald-800 print:hidden">
          Payment received on {new Date(bill.paid_date).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}{bill.payment_method ? ` via ${bill.payment_method}` : ''} — No outstanding amount.
        </div>
      )}

      <div className="flex justify-center p-4 bg-dp-surface-container-low/40 rounded-lg print:bg-white print:p-0">
        <ReceiptDocument ref={nodeRef} data={data} template={template} />
      </div>

      <div className="flex items-center gap-2 mt-5 print:hidden">
        <button disabled={busy} onClick={handlePrint} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
          <Printer size={16} /> Print
        </button>
        <button disabled={busy} onClick={handleDownload} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
          <Download size={16} /> Download {format.toUpperCase()}
        </button>
        <button disabled={busy} onClick={handleEmail} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
          <Mail size={16} /> Email
        </button>
        <button disabled={busy} onClick={handleWhatsApp} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
          <Share2 size={16} /> {whatsappPhone ? `WhatsApp (${normalizePakPhone(whatsappPhone) ?? whatsappPhone})` : 'WhatsApp'}
        </button>
      </div>

      {/* Ledger postings — what this bill actually posted, for verification */}
      <div className="mt-5 bg-white rounded-lg border border-dp-outline-variant overflow-hidden print:hidden">
        <button onClick={() => setShowLedger(!showLedger)} className="w-full flex items-center justify-between px-4 py-3 cursor-pointer">
          <span className="flex items-center gap-2 font-sans text-[14px] font-bold text-dp-on-surface"><BookOpen size={15} /> Ledger Postings ({ledgerRows.length})</span>
          {showLedger ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showLedger && (
          <div className="overflow-x-auto border-t border-dp-outline-variant">
            <table className="w-full text-start min-w-[500px]">
              <thead>
                <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant">
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Account</th>
                  <th className="px-4 py-2">Particular</th>
                  <th className="px-4 py-2">Receipt #</th>
                  <th className="px-4 py-2 text-end">Debit</th>
                  <th className="px-4 py-2 text-end">Credit</th>
                </tr>
              </thead>
              <tbody>
                {ledgerRows.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-dp-on-surface-variant font-sans text-[13px]">No ledger postings found.</td></tr>}
                {ledgerRows.map((r) => (
                  <tr key={r.id} className="font-sans text-[13px] border-b border-dp-outline-variant last:border-b-0">
                    <td className="px-4 py-2 whitespace-nowrap">{new Date(r.entry_date).toLocaleDateString('en-GB')}</td>
                    <td className="px-4 py-2">{r.account_name}</td>
                    <td className="px-4 py-2">{r.particular}</td>
                    <td className="px-4 py-2 text-dp-secondary">{r.receipt_no ? `#${r.receipt_no}` : '—'}</td>
                    <td className="px-4 py-2 text-end">{r.debit > 0 ? fmtAmount(r.debit) : '—'}</td>
                    <td className="px-4 py-2 text-end">{r.credit > 0 ? fmtAmount(r.credit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Bill"
        message={`Are you sure you want to delete Bill ${bill.bill_number ?? ''}? This cannot be undone.`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
