import { dt, type Lang, type DocStringKey } from '@/lib/docTranslations'

// Shared across every ledger/statement view (Chart of Accounts statement, Daily
// Register, All Transactions) so a voucher's actual type — Advance, Expense,
// Security Deposit, etc. — reads the same everywhere instead of a generic
// "Voucher" label that tells the accountant nothing about what happened.
export const voucherTypeLabels: Record<string, string> = {
  expense: 'Expense',
  income: 'Income',
  contra: 'Bank Transfer',
  withdrawal: 'Cash Withdrawal',
  deposit: 'Cash Deposit',
  security_deposit: 'Security Deposit',
  security_deposit_refund: 'Security Deposit Refund',
  advance: 'Advance Payment',
  // Its real economic effect is an expense (funded via a pre-existing advance
  // instead of straight cash-out) — numbered from the expense counter since
  // migration 090, so it reads as a normal expense everywhere too.
  advance_settlement: 'Expense',
  // Committee-decided write-off of a consumer's bill dues on a genuine
  // service-failure complaint — kept as its own visible category rather than
  // folded into Expense, unlike advance_settlement above.
  complaint_waiver: 'Complaint Waiver Settlement',
  // Funds moved between two projects by committee decision (migration 206).
  // No cash leg — only which project the money belongs to changes.
  project_transfer: 'Project Fund Transfer',
}

export const referenceTypeLabels: Record<string, string> = {
  bill: 'Bill',
  payment: 'Receipt',
  donation: 'Donation',
  manual: 'Manual Entry',
  inventory: 'Inventory',
  collector_settlement: 'Collector Settlement',
}

// lang defaults to 'en' for admin-dashboard callers (out of scope for
// translation); the printable Daily Register / Account Statement pass the
// real display_language explicitly.
const voucherTypeDocKeys: Record<string, DocStringKey> = {
  expense: 'typeExpense', income: 'typeIncome', contra: 'typeBankTransfer',
  withdrawal: 'typeCashWithdrawal', deposit: 'typeCashDeposit',
  security_deposit: 'typeSecurityDeposit', security_deposit_refund: 'typeSecurityDepositRefund',
  advance: 'typeAdvancePayment', advance_settlement: 'typeExpense',
  complaint_waiver: 'typeComplaintWaiver', project_transfer: 'typeProjectTransfer',
}
const referenceTypeDocKeys: Record<string, DocStringKey> = {
  bill: 'typeBill', payment: 'typeReceipt', donation: 'typeDonation',
  manual: 'typeManualEntry', inventory: 'typeInventory', collector_settlement: 'typeCollectorSettlement',
}

export function entryTypeLabel(referenceType: string | null, voucherType?: string | null, lang: Lang = 'en'): string {
  if (referenceType === 'voucher') {
    if (!voucherType) return dt(lang, 'typeVoucher')
    const key = voucherTypeDocKeys[voucherType]
    return key ? dt(lang, key) : voucherTypeLabels[voucherType] ?? voucherType.replace(/_/g, ' ')
  }
  if (!referenceType) return dt(lang, 'typeManualEntry')
  const key = referenceTypeDocKeys[referenceType]
  return key ? dt(lang, key) : referenceTypeLabels[referenceType] ?? referenceType
}

// Which ReceiptDocument template a voucher_type should render as when viewed —
// cash-out types read as "Paid To" (purchase_payment template), cash-in as
// "Received From" (payment template), internal transfers (contra/withdrawal/
// deposit, no real counterparty) as a plain manual voucher.
export const voucherReceiptKind: Record<string, 'payment' | 'purchase_payment' | 'manual'> = {
  expense: 'purchase_payment', advance: 'purchase_payment', advance_settlement: 'purchase_payment',
  security_deposit_refund: 'purchase_payment', complaint_waiver: 'purchase_payment',
  income: 'payment', security_deposit: 'payment',
  contra: 'manual', withdrawal: 'manual', deposit: 'manual', project_transfer: 'manual',
}
