'use client'

import { useEffect, useState, useCallback, useRef, use as usePromise } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Eye, FileText, Printer, PlusCircle, X, Save, Banknote, Link2, Search, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { printNodeInPopup } from '@/lib/receiptExport'
import { entryTypeLabel, voucherReceiptKind } from '@/lib/ledgerLabels'
import { dt } from '@/lib/docTranslations'
import { translateParticular } from '@/lib/ledgerParticular'
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
interface PortalUserMatch { id: string; full_name: string; mobile: string; whatsapp_number: string | null; consumer_id: string | null }

const systemLabels: Record<string, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects System' }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB')
}

export default function ViewAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { t, isUrdu } = useLocale()
  const { id } = usePromise(params)
  const [account, setAccount] = useState<Account | null>(null)
  const [consumerInfo, setConsumerInfo] = useState<ConsumerInfo | null>(null)
  const [rows, setRows] = useState<(LedgerRow & { balance: number })[]>([])
  const [billStatusMap, setBillStatusMap] = useState<Record<string, BillStatus>>({})
  const [paymentBillMap, setPaymentBillMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [payBillRow, setPayBillRow] = useState<LedgerRow | null>(null)
  const [payForm, setPayForm] = useState({ amount: 0, method: 'cash', note: '' })
  const [payOutstanding, setPayOutstanding] = useState(0)
  const [paying, setPaying] = useState(false)
  const [showManualForm, setShowManualForm] = useState(false)
  const [manualForm, setManualForm] = useState({ entry_date: new Date().toISOString().slice(0, 10), particular: '', debit: 0, credit: 0 })
  const [printing, setPrinting] = useState(false)
  // An account statement, viewed internally -- follows the admin's own
  // chosen language rather than the site's public-document branding
  // default (Urdu, meant for water bills mailed to consumers), which was
  // leaking in here regardless of what language the admin was actually
  // browsing in.
  const lang: 'en' | 'ur' = isUrdu ? 'ur' : 'en'
  const [channels, setChannels] = useState<{ payment_method: string; total_pkr: number }[]>([])
  const statementRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  // The fallback for when signup's own auto-match by mobile/WhatsApp number
  // misses — a consumer whose water connection is registered under a
  // different or older number than the one they signed up to the portal
  // with. Search only ever returns real, already-verified portal_users
  // rows; nothing here is a free-text number a staff member could mistype.
  const [linkedPortalUser, setLinkedPortalUser] = useState<{ id: string; full_name: string; mobile: string } | null>(null)
  const [showLinkSearch, setShowLinkSearch] = useState(false)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkResults, setLinkResults] = useState<PortalUserMatch[]>([])
  const [linkSearching, setLinkSearching] = useState(false)
  const [linking, setLinking] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data: acc } = await supabase.from('accounts').select('*').eq('id', id).single()
    setAccount(acc)
    if (acc?.type === 'project' && acc.project_id) {
      const { data: ch } = await supabase.rpc('project_donation_channels_pkr', { p_project_id: acc.project_id })
      setChannels(ch ?? [])
    }

    if (acc?.type === 'consumer' && acc.consumer_id) {
      const { data: c } = await supabase.from('consumers').select('consumer_id, mobile, address, connections').eq('consumer_id', acc.consumer_id).single()
      setConsumerInfo(c)
      const { data: linked } = await supabase.rpc('admin_portal_user_for_consumer', { p_consumer_id: acc.consumer_id })
      setLinkedPortalUser((linked ?? null) as { id: string; full_name: string; mobile: string } | null)
    } else {
      setConsumerInfo(null)
      setLinkedPortalUser(null)
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

    // A donation ledger row stores reference_type='donation' with
    // reference_id pointing at the donors row, not a vouchers row — its
    // real voucher number (assigned by confirm_donation()/the legacy
    // importer, same DP-INC-V-#### series) lives there and was never
    // being looked up here, so every donation showed a bare "—" instead
    // of its actual number.
    const donationIds = Array.from(new Set((entries ?? [])
      .filter((e) => e.reference_type === 'donation' && e.reference_id)
      .map((e) => e.reference_id as string)))
    let donationById: Record<string, { voucher_no: string | null }> = {}
    if (donationIds.length > 0) {
      const { data: donationsData } = await supabase.from('donors').select('id, voucher_no').in('id', donationIds)
      donationById = Object.fromEntries((donationsData ?? []).map((d) => [d.id, { voucher_no: d.voucher_no }]))
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
      const d = e.reference_id ? donationById[e.reference_id] : undefined
      return { ...e, voucher_type: v?.voucher_type ?? null, voucher_no: v?.voucher_no ?? d?.voucher_no ?? null, balance: running }
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
    // A voucher-sourced ledger row (a real expense, an advance settlement,
    // any bill_id-linked posting) already carries a real receipt_no/
    // bill_number right on itself — post_voucher_ledger_legs() copies it
    // onto every leg. The random 8-character UUID slice below was being
    // used unconditionally regardless, so a printed receipt for e.g. an
    // imported expense showed a meaningless code like "C245644B" instead
    // of its real, traceable reference. Only entries with genuinely
    // neither (a true one-off manual posting) still fall back to it.
    //
    // A voucher's own voucher_no (the system's real, serially-numbered
    // reference, e.g. DP-EXP-V-0249) takes priority over receipt_no —
    // receipt_no on a legacy-imported voucher holds the ORIGINAL
    // BookKeeper reference (e.g. "PAY31"), kept for traceability and
    // already printed in the particular/remarks text, but it is not this
    // system's own document number and should not headline the receipt.
    let receiptNo = (row.reference_type === 'voucher' ? row.voucher_no : null) ?? row.receipt_no ?? row.bill_number ?? row.id.slice(0, 8).toUpperCase()
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

    // A multi-category voucher (Kafalat's monthly payment, a water_supply
    // multi-line expense) posts through voucher_line_items -- without this
    // the statement's own receipt view showed the same bare lump total the
    // Transactions Workspace's did before that got the same fix.
    let lineItems: { description: string; quantity: number; unitPrice: number }[] | undefined
    // A voucher-sourced ledger row was always being printed with the SAME
    // generic "Receipt / Received From / Outstanding Amount" wording a
    // donation or a water bill payment gets — an expense (money paid OUT)
    // read exactly like money coming in, and whichever account's statement
    // happened to be open printed as if IT were the payee, same class of
    // bug as the donor-vs-project mixup fixed earlier. The Transactions
    // Workspace already solved this correctly (voucherReceiptKind +
    // resolving the real from/to account names, not the page's own
    // account) — replicated here rather than re-invented.
    let voucherAccountName: string | undefined
    let voucherAccountNameUr: string | null | undefined
    let paidFromName: string | undefined
    let voucherKind: ReceiptData['kind'] | undefined
    // A multi-line voucher's own amount_pkr (the real total across every
    // category) — NOT the amount on whichever single leg/account happened
    // to be open, which for a split voucher is only that one category's
    // slice and understates "Paid From"/Total on every template.
    let voucherAmount: number | undefined
    if (row.reference_type === 'voucher' && row.reference_id) {
      const { data: items } = await supabase.from('voucher_line_items')
        .select('description, category, amount').eq('voucher_id', row.reference_id)
      if (items && items.length > 0) {
        lineItems = items.map((l) => ({
          description: l.description || (l.category ? l.category.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Item'),
          quantity: 1, unitPrice: Number(l.amount),
        }))
      }

      const { data: v } = await supabase.from('vouchers')
        .select('voucher_type, from_account_id, to_account_id, party_name, amount_pkr')
        .eq('id', row.reference_id).single()
      if (v) {
        voucherKind = voucherReceiptKind[v.voucher_type ?? ''] ?? 'manual'
        if (lineItems && lineItems.length > 0) voucherAmount = Number(v.amount_pkr)
        const acctIds = [v.from_account_id, v.to_account_id].filter((x): x is string => !!x)
        let namesById: Record<string, { name: string; name_ur: string | null }> = {}
        if (acctIds.length > 0) {
          const { data: accts } = await supabase.from('accounts').select('id, name, name_ur').in('id', acctIds)
          namesById = Object.fromEntries((accts ?? []).map((a) => [a.id, { name: a.name, name_ur: a.name_ur }]))
        }
        const toAccount = v.to_account_id ? namesById[v.to_account_id] : undefined
        voucherAccountName = toAccount?.name ?? v.party_name ?? entryTypeLabel('voucher', v.voucher_type, lang)
        voucherAccountNameUr = toAccount?.name_ur
        paidFromName = v.from_account_id ? namesById[v.from_account_id]?.name : undefined
      }
    }

    // What this donation was earmarked for — a project, or, for Kafalat/
    // Wazifa/Sadqa giving (which has no project of its own), the pool it
    // fed and who it was named for. Left unset only for genuinely
    // unearmarked general giving, where "General Fund" is the true answer
    // rather than a fallback standing in for a lookup nobody ran.
    let projectName: string | undefined
    // Who actually gave this — not whichever account's statement page the
    // receipt happened to be opened from. A donation shows up on three
    // different accounts' ledgers (the donor's own, cash/bank, and the
    // project's), and printing it from the project's page was silently
    // using the project's own name as "Donor" on the receipt — same
    // account.name field the bill/payment receipts below correctly use
    // for THEIR own account, but wrong for a donation specifically, whose
    // real party lives on the donors row, not the account being viewed.
    let donorName: string | undefined
    let donorNameUr: string | null | undefined
    let donorVoucherNo: string | undefined
    if (row.reference_type === 'donation' && row.reference_id) {
      const { data: donor } = await supabase.from('donors')
        .select('project_id, fund_type, name, name_ur, voucher_no').eq('id', row.reference_id).single()
      donorName = donor?.name ?? undefined
      donorNameUr = donor?.name_ur
      donorVoucherNo = donor?.voucher_no ?? undefined
      if (donor?.project_id) {
        // Same public label (migration 364) a donor already saw on the
        // project's card — this receipt is handed to them, never the real
        // title, for a project whose real title is a patient's name.
        const { data: proj } = await supabase.from('projects').select('title, display_name').eq('id', donor.project_id).single()
        projectName = proj?.display_name || proj?.title || undefined
      } else {
        const { data: pp } = await supabase.from('pool_payments')
          .select('pool:support_pools(name), kafalat_child_id, wazifa_student_id, sadqa_object_id')
          .eq('donor_id', row.reference_id).maybeSingle()
        const poolRow = pp as unknown as { pool: { name: string } | null
          kafalat_child_id: string | null; wazifa_student_id: string | null; sadqa_object_id: string | null } | null
        if (poolRow?.pool?.name) {
          let named: string | null = null
          if (poolRow.kafalat_child_id) {
            const { data } = await supabase.from('kafalat_children').select('first_name').eq('id', poolRow.kafalat_child_id).single()
            named = data?.first_name ?? null
          } else if (poolRow.wazifa_student_id) {
            const { data } = await supabase.from('wazifa_students').select('full_name').eq('id', poolRow.wazifa_student_id).single()
            named = data?.full_name ?? null
          } else if (poolRow.sadqa_object_id) {
            const { data } = await supabase.from('sadqa_objects').select('item_name').eq('id', poolRow.sadqa_object_id).single()
            named = data?.item_name ?? null
          }
          projectName = poolRow.pool.name + (named ? ` — ${named}` : '')
        } else if (donor?.fund_type && donor.fund_type !== 'general') {
          projectName = donor.fund_type.charAt(0).toUpperCase() + donor.fund_type.slice(1)
        }
      }
    }

    const receiptKind = row.reference_type === 'bill' || row.reference_type === 'payment' || row.reference_type === 'donation'
      ? row.reference_type
      : row.reference_type === 'voucher' ? (voucherKind ?? 'manual') : 'manual'
    // A voucher has no "outstanding balance" concept — the running figure
    // on whichever account statement happened to be open was being printed
    // under that label regardless, which read as a real amount owed.
    const balanceAfter = row.reference_type === 'voucher' ? 0 : row.balance
    setReceipt({
      kind: receiptKind,
      receiptNo: donorVoucherNo ?? receiptNo,
      date: row.entry_date,
      systemLabel: systemLabels[account?.system ?? ''] ?? '',
      accountName: donorName ?? voucherAccountName ?? account?.name ?? '',
      accountNameUr: donorName ? donorNameUr : (voucherAccountNameUr ?? account?.name_ur),
      accountAddress: consumerInfo?.address,
      particular: translateParticular(row.particular, t, isUrdu),
      amount: voucherAmount ?? (row.debit > 0 ? row.debit : row.credit),
      balanceAfter,
      billOutstandingAfter,
      projectName,
      paidFromName,
      lineItems,
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
      toast.success(`Payment recorded — ${fmtAmount(amount - payOutstanding)} credited as advance balance`)
    } else {
      toast.success(amount >= payOutstanding ? 'Payment recorded — bill paid in full' : `Partial payment of ${fmtAmount(amount)} recorded`)
    }
    setPayBillRow(null)
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

  const searchPortalUsers = async (q: string) => {
    setLinkQuery(q)
    if (q.trim().length < 3) { setLinkResults([]); return }
    setLinkSearching(true)
    const { data, error } = await supabase.rpc('admin_search_portal_users', { p_query: q.trim() })
    setLinkSearching(false)
    if (error) { toast.error(friendlyError(error)); return }
    setLinkResults((data ?? []) as PortalUserMatch[])
  }

  const linkPortalUser = async (match: PortalUserMatch) => {
    if (!account?.consumer_id) return
    if (match.consumer_id && match.consumer_id !== account.consumer_id) {
      if (!confirm(`${match.full_name} is already linked to consumer account ${match.consumer_id}. Re-link to ${account.consumer_id} instead?`)) return
    }
    setLinking(match.id)
    const { error } = await supabase.rpc('admin_link_portal_account', { p_portal_user_id: match.id, p_consumer_id: account.consumer_id })
    setLinking(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`Linked to ${match.full_name}'s portal account`)
    setShowLinkSearch(false)
    setLinkQuery('')
    setLinkResults([])
    load()
  }

  const unlinkPortalUser = async () => {
    if (!linkedPortalUser) return
    if (!confirm(`Unlink ${linkedPortalUser.full_name} from this water account? They'll stop seeing their bills on the portal until re-linked.`)) return
    const { error } = await supabase.rpc('admin_unlink_portal_account', { p_portal_user_id: linkedPortalUser.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Unlinked')
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
    <div dir={isUrdu ? 'rtl' : 'ltr'}>

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

      {/* ── Portal account link ──────────────────────────────────────────
          Consumer accounts only. Signup already tries to auto-match by
          mobile/WhatsApp; this is the manual fallback for when a
          connection is registered under a different number. Search results
          are real portal_users rows — nothing here is a number typed by
          hand, so a mistyped digit can never attach the wrong person. */}
      {account.type === 'consumer' && (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-5 mb-4 print:hidden">
          <h2 className="font-heading text-[15px] font-bold text-dp-primary flex items-center gap-2 mb-3">
            <Link2 size={16} className="text-dp-secondary" /> Portal Account
          </h2>
          {linkedPortalUser ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-sans text-[13.5px] text-dp-on-surface">
                Linked to <span className="font-bold">{linkedPortalUser.full_name}</span>
                <span className="text-dp-on-surface-variant"> · {linkedPortalUser.mobile}</span>
              </p>
              <button onClick={unlinkPortalUser} className="flex items-center gap-1.5 text-dp-on-surface-variant hover:text-dp-error font-sans text-[12.5px] font-semibold cursor-pointer">
                <Unlink size={13} /> Unlink
              </button>
            </div>
          ) : !showLinkSearch ? (
            <div className="flex items-center justify-between gap-3">
              <p className="font-sans text-[13px] text-dp-on-surface-variant">No portal account linked yet — this consumer can't see their bills online.</p>
              <button onClick={() => setShowLinkSearch(true)} className="flex items-center gap-1.5 px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0">
                <Link2 size={13} /> Link Portal Account
              </button>
            </div>
          ) : (
            <div>
              <div className="relative mb-2">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
                <input autoFocus value={linkQuery} onChange={(e) => searchPortalUsers(e.target.value)}
                  placeholder="Search by name or mobile number..." className="input-field !ps-9 !py-2 text-[13.5px]" />
              </div>
              {linkSearching && <p className="font-sans text-[12.5px] text-dp-on-surface-variant py-2">Searching…</p>}
              {!linkSearching && linkQuery.trim().length >= 3 && linkResults.length === 0 && (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant py-2">No portal accounts match that.</p>
              )}
              {linkResults.length > 0 && (
                <div className="border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant overflow-hidden mb-2">
                  {linkResults.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                      <div className="min-w-0">
                        <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{m.full_name}</p>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant">
                          {m.mobile}
                          {m.consumer_id && <span className="text-amber-700"> · already linked to {m.consumer_id}</span>}
                        </p>
                      </div>
                      <button disabled={linking === m.id} onClick={() => linkPortalUser(m)}
                        className="shrink-0 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                        {linking === m.id ? 'Linking…' : 'Link'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => { setShowLinkSearch(false); setLinkQuery(''); setLinkResults([]) }} className="font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer">Cancel</button>
            </div>
          )}
        </div>
      )}

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
              {fmtAmount(account.type === 'consumer' && currentBalance < 0 ? -currentBalance : currentBalance)}
            </p>
          </div>
        </div>
        {account.type === 'project' && channels.length > 0 && (
          <div className="mt-4 pt-4 border-t border-dp-outline-variant">
            <p className="font-sans text-[11px] font-bold tracking-widest uppercase text-dp-on-surface-variant mb-2">{dt(lang, 'receivedVia')}</p>
            <div className="flex flex-wrap gap-4">
              {channels.map((c) => (
                <p key={c.payment_method} className="font-sans text-[13.5px] text-dp-on-surface">
                  <span className="capitalize font-semibold">{c.payment_method}</span>: {fmtAmount(c.total_pkr)}
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
                  <td className="px-4 py-3">{translateParticular(row.particular, t, isUrdu)}</td>
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
                  {/* A statement reports what happened; it does not change it.
                      Edit and Delete used to live here and were the easiest
                      place in the whole system to quietly rewrite a settled
                      figure — from a screen whose whole purpose is to be the
                      trusted record. Receiving cash still belongs here, because
                      that adds a new receipt rather than altering an old one. */}
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
                                  Partial: {fmtAmount(billStatusMap[row.reference_id].amount_pkr - billStatusMap[row.reference_id].discount_amount - billStatusMap[row.reference_id].paid_amount)}
                                </span>
                              )}
                              <button onClick={() => openReceivePayment(row)} title="Receive Now" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Banknote size={15} /></button>
                            </>
                          )}
                          <Link href={`/admin/invoice/bill/${row.reference_id}`} title={t('f.viewBillLedger')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><FileText size={15} /></Link>
                        </>
                      )}
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

      {receipt && <ReceiptModal data={receipt} phone={consumerInfo?.mobile} system={account?.system === 'donors_projects' ? 'donors_projects' : 'water_supply'} onClose={() => setReceipt(null)} />}

      {payBillRow && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayBillRow(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('f.receivePayment')}</h2>
              <button onClick={() => setPayBillRow(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{payBillRow.particular} · Outstanding: {fmtAmount(payOutstanding)}</p>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                <input type="number" value={payForm.amount || ''} onChange={(e) => setPayForm({ ...payForm, amount: +e.target.value })} className="input-field" />
                {payForm.amount > payOutstanding && (
                  <p className="text-[12px] font-sans text-dp-secondary mt-1.5">
                    {fmtAmount(payForm.amount - payOutstanding)} above the bill will be recorded as an advance credit on this consumer&apos;s account.
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
    </div>
  )
}
