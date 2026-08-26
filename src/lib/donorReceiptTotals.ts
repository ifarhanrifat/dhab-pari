import { createClient } from '@/lib/supabase/client'

export interface DonorReceiptTotals {
  /** Lifetime confirmed donations for this donor identity, including this receipt. */
  totalContributed: number
  /** Announced/pledged under this identity but not yet collected. */
  announcedRemaining: number
  /** Project this donation is earmarked for; null means unearmarked (General Fund). */
  projectName: string | null
  /** False until an admin confirms the donation — see migration 173. */
  isConfirmed: boolean
}

// A donation receipt speaks about the *donor*, not the single donors row it was
// printed from — "you have given X in total, Y of what you announced is still
// outstanding". Identity resolution (name+phone → donor_key) lives in the
// donor_receipt_totals() RPC (migration 171) rather than being re-derived here,
// because it must match exactly how ensure_donor_account() groups donations.
//
// The project comes from a plain select alongside it: it belongs to this one
// donation, not to the donor identity, so it has no business inside that RPC.
//
// Never throws: a receipt that can't reach the database should still print,
// just without the lifetime figures.
export async function donorReceiptTotals(donorId: string): Promise<DonorReceiptTotals> {
  const supabase = createClient()
  const [totalsRes, projectRes] = await Promise.all([
    supabase.rpc('donor_receipt_totals', { p_donor_id: donorId }),
    supabase.from('donors').select('projects(title, display_name)').eq('id', donorId).maybeSingle(),
  ])

  const row = Array.isArray(totalsRes.data) ? totalsRes.data[0] : totalsRes.data
  const projects = projectRes.data?.projects
  const project = Array.isArray(projects) ? projects[0] : projects

  const failed = !!totalsRes.error || !row
  return {
    totalContributed: failed ? 0 : Number(row.total_contributed ?? 0),
    announcedRemaining: failed ? 0 : Number(row.announced_remaining ?? 0),
    // A receipt leaves the building — it must show the same public label
    // (migration 364) the donor already saw on the project's card, never
    // the real title, for a project whose real title is a patient's name.
    projectName: project?.display_name || project?.title || null,
    // If the RPC could not be read at all, treat the donation as unconfirmed
    // rather than asserting a confirmed receipt off numbers we do not have.
    isConfirmed: failed ? false : row.is_confirmed === true,
  }
}
