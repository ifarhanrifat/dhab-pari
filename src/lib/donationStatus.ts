import type { BillBadgeTone } from '@/lib/billStatus'

/**
 * Where a donation is in its life, in one place.
 *
 * A `donors` row is the same row from pledge to money-in-hand (migration 133),
 * which means "not verified" covers two situations that are nothing alike:
 *
 *   Announced — somebody has said they will give, and nothing has arrived. The
 *   committee's job is to follow it up.
 *
 *   Awaiting confirmation — the money has been sent and the donor is waiting
 *   for the committee to check the proof and confirm it. The committee's job is
 *   to look at it today.
 *
 * Both used to render as one amber "PENDING" chip on the workspace, so the
 * queue could not be triaged at a glance: a pledge made three weeks ago and a
 * transfer sitting unconfirmed since this morning looked identical.
 *
 * Returns a dictionary key rather than a string — the caller translates, so the
 * same three words never get typed twice in two screens and drift apart.
 */
export interface DonationBadge {
  key: 'dn.badge.received' | 'dn.badge.announced' | 'dn.badge.awaiting'
  tone: BillBadgeTone
}

export function donationBadge(
  d: { is_verified?: boolean | null; payment_status?: string | null },
): DonationBadge {
  if (d.is_verified) return { key: 'dn.badge.received', tone: 'green' }
  if (d.payment_status === 'pledged') return { key: 'dn.badge.announced', tone: 'amber' }
  return { key: 'dn.badge.awaiting', tone: 'gray' }
}
