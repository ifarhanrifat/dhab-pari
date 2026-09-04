export type BillBadgeTone = 'red' | 'green' | 'amber' | 'gray'
export interface BillBadge { text: string; tone: BillBadgeTone }

// Single source of truth for how a bill's payment status reads across the admin
// panel (Recent Transactions cards, Billing Management) — computed from the
// actual numbers (net payable, paid, due date) rather than a separate stored
// status column, so the two screens can never silently drift out of sync.
//
// WAIVED is checked first and short-circuits everything else — once a
// committee decision waives a bill (waive_bill, migration 438), the
// remaining "net" math would actually read PAID anyway (discount_amount
// is set to cover the full remaining balance), but WAIVED is a
// meaningfully different fact than "somebody paid this" and the two
// must never look identical in the UI.
export function billBadge(bill: { amount_pkr: number; discount_amount: number | null; paid_amount: number | null; due_date: string | null; status?: string | null }): BillBadge {
  if (bill.status === 'waived') return { text: 'WAIVED', tone: 'gray' }
  const net = Math.max(bill.amount_pkr - (bill.discount_amount ?? 0), 0)
  const paid = bill.paid_amount ?? 0
  if (net > 0 && paid >= net) return { text: 'PAID', tone: 'green' }
  if (paid > 0) return { text: 'PARTIAL PAYMENT', tone: 'amber' }
  if (bill.due_date) {
    const days = Math.floor((Date.now() - new Date(bill.due_date + 'T00:00:00').getTime()) / 86400000)
    if (days > 0) return { text: `OVERDUE BY ${days} DAY${days > 1 ? 'S' : ''}`, tone: 'red' }
  }
  return { text: 'PENDING', tone: 'red' }
}

// Same idea as billBadge, for the three receivable tables that share a
// paid_pkr/due_on/status shape instead of bills' own paid_amount/
// discount_amount/due_date one: wazifa_repayment_schedule,
// wazifa_installment_charges, training_fee_charges (all migration 438).
// Their own `status` column ('due'/'part_paid'/'paid'/'waived'/
// 'deferred') is already the source of truth here — unlike bills, there
// was never a competing amount-math-derived status to drift out of sync
// with, so this just translates it into the same badge shape.
export function receivableBadge(row: { amount_pkr: number; paid_pkr: number | null; due_on: string | null; status: string }): BillBadge {
  if (row.status === 'waived') return { text: 'WAIVED', tone: 'gray' }
  if (row.status === 'paid') return { text: 'PAID', tone: 'green' }
  if (row.status === 'deferred') return { text: 'DEFERRED', tone: 'amber' }
  const paid = row.paid_pkr ?? 0
  if (paid > 0) return { text: 'PARTIAL PAYMENT', tone: 'amber' }
  if (row.due_on) {
    const days = Math.floor((Date.now() - new Date(row.due_on + 'T00:00:00').getTime()) / 86400000)
    if (days > 0) return { text: `OVERDUE BY ${days} DAY${days > 1 ? 'S' : ''}`, tone: 'red' }
  }
  return { text: 'PENDING', tone: 'red' }
}

export const billBadgeClass: Record<BillBadgeTone, string> = {
  red: 'bg-red-100 text-red-700', green: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700', gray: 'bg-dp-surface-container-low text-dp-on-surface-variant',
}
