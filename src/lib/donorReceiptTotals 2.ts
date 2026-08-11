import { createClient } from '@/lib/supabase/client'

export interface DonorReceiptTotals {
  /** Lifetime confirmed donations for this donor identity, including this receipt. */
  totalContributed: number
  /** Announced/pledged under this identity but not yet collected. */
  announcedRemaining: number
}

// A donation receipt speaks about the *donor*, not the single donors row it was
// printed from — "you have given X in total, Y of what you announced is still
// outstanding". Identity resolution (name+phone → donor_key) lives in the
// donor_receipt_totals() RPC (migration 171) rather than being re-derived here,
// because it must match exactly how ensure_donor_account() groups donations.
//
// Never throws: a receipt that can't reach the RPC should still print, just
// without the lifetime figures.
export async function donorReceiptTotals(donorId: string): Promise<DonorReceiptTotals> {
  const supabase = createClient()
  const { data, error } = await supabase.rpc('donor_receipt_totals', { p_donor_id: donorId })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row) return { totalContributed: 0, announcedRemaining: 0 }
  return {
    totalContributed: Number(row.total_contributed ?? 0),
    announcedRemaining: Number(row.announced_remaining ?? 0),
  }
}
