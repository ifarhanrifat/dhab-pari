export type BillBadgeTone = 'red' | 'green' | 'amber' | 'gray'
export interface BillBadge { text: string; tone: BillBadgeTone }

// Single source of truth for how a bill's payment status reads across the admin
// panel (Recent Transactions cards, Billing Management) — computed from the
// actual numbers (net payable, paid, due date) rather than a separate stored
// status column, so the two screens can never silently drift out of sync.
export function billBadge(bill: { amount_pkr: number; discount_amount: number | null; paid_amount: number | null; due_date: string | null }): BillBadge {
  const net = Math.max(bill.amount_pkr - (bill.discount_amount ?? 0), 0)
  const paid = bill.paid_amount ?? 0
  if (net > 0 && paid >= net) return { text: 'PAID', tone: 'green' }
  if (paid > 0) return { text: 'PARTIAL PAYMENT', tone: 'amber' }
  if (bill.due_date) {
    const days = Math.floor((Date.now() - new Date(bill.due_date + 'T00:00:00').getTime()) / 86400000)
    if (days > 0) return { text: `OVERDUE BY ${days} DAY${days > 1 ? 'S' : ''}`, tone: 'red' }
  }
  return { text: 'PENDING', tone: 'gray' }
}

export const billBadgeClass: Record<BillBadgeTone, string> = {
  red: 'bg-red-100 text-red-700', green: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700', gray: 'bg-dp-surface-container-low text-dp-on-surface-variant',
}
