import { createClient } from '@/lib/supabase/server'
import { ProjectsListClient, type Project, type FeeSummary } from '@/components/public/ProjectsListClient'

// Real perf fix, 2026-10-01: every sibling public page (/, /donate, /about,
// /news/[id]) already fetches server-side with revalidate — this page was
// the one holdout still doing the whole fetch client-side on every visit
// (site_settings + the RPC + the projects row + 6 dependent queries, all
// inside a useEffect with zero caching between navigations, and the main
// projects query had no .limit() at all). Moved the entire fetch here;
// the client component now only owns the status/category filter buttons.
export const revalidate = 300

type Lang = 'en' | 'ur'

// A generous cap, not a real pagination UI yet — this village's total
// project count is nowhere near this today, but the old query had no
// limit at all and would have gotten linearly slower as it grew.
const MAX_PROJECTS = 200

export default async function ProjectsPage() {
  const supabase = await createClient()

  const [{ data: settingsRow }, { data: privateTotalRaw }, { data: projectRows }] = await Promise.all([
    supabase.from('site_settings').select('value').eq('key', 'display_language').maybeSingle(),
    supabase.rpc('public_private_projects_total'),
    supabase
      .from('projects')
      .select('*')
      // Migration 365 — an "unlisted" project (e.g. the committee's own
      // general account) is fully public everywhere else; it just doesn't
      // render as a card here.
      .eq('unlisted', false)
      .order('created_at', { ascending: false })
      .limit(MAX_PROJECTS),
  ])

  const lang: Lang = settingsRow?.value === 'ur' ? 'ur' : 'en'
  const privateTotal = Number(privateTotalRaw ?? 0)
  const projects = (projectRows ?? []) as Project[]

  const voteCounts: Record<string, number> = {}
  const commentCounts: Record<string, number> = {}
  const receivedByProject: Record<string, number> = {}
  const expenseByProject: Record<string, number> = {}
  const feeByProject: Record<string, FeeSummary> = {}

  const allIds = projects.map((p) => p.id)
  if (allIds.length > 0) {
    const [{ data: voteRows }, { data: commentRows }, { data: donationRows }, { data: expenseRows }, { data: batchRows }, { data: coverRows }] = await Promise.all([
      supabase.from('project_votes_public').select('project_id').in('project_id', allIds),
      // Excludes comment_type='system' — those are the auto-posted "X submitted
      // a donation of Rs. Y" lines the donation trigger writes on every submission,
      // not something a visitor typed. Counting them made e.g. a 73-donor medical
      // project's card claim "73 comments" when the thread held zero real ones.
      supabase.from('project_comments_public').select('project_id').eq('comment_type', 'user').in('project_id', allIds),
      supabase.from('donors_public').select('project_id, amount_pkr').eq('is_verified', true).in('project_id', allIds),
      supabase.from('project_expenses_public').select('project_id, debit').in('project_id', allIds),
      supabase.from('training_batches').select('project_id, fee_villager_monthly_pkr, fee_outsider_monthly_pkr, fee_villager_full_pkr, fee_outsider_full_pkr').eq('status', 'active').in('project_id', allIds),
      supabase.from('project_media').select('project_id, url').eq('is_cover', true).in('project_id', allIds),
    ])

    if (coverRows && coverRows.length > 0) {
      const coverByProject: Record<string, string> = {}
      for (const c of coverRows) coverByProject[c.project_id] = c.url
      for (const p of projects) {
        if (coverByProject[p.id]) p.cover_photo_url = coverByProject[p.id]
      }
    }
    for (const v of voteRows ?? []) voteCounts[v.project_id] = (voteCounts[v.project_id] ?? 0) + 1
    for (const c of commentRows ?? []) commentCounts[c.project_id] = (commentCounts[c.project_id] ?? 0) + 1
    for (const d of donationRows ?? []) receivedByProject[d.project_id] = (receivedByProject[d.project_id] ?? 0) + Number(d.amount_pkr)
    for (const e of expenseRows ?? []) expenseByProject[e.project_id] = (expenseByProject[e.project_id] ?? 0) + Number(e.debit)
    for (const b of batchRows ?? []) {
      const existing = feeByProject[b.project_id] ?? { free: true, cheapestVillagerMonthly: null }
      const batchIsFree = !b.fee_villager_monthly_pkr && !b.fee_outsider_monthly_pkr && !b.fee_villager_full_pkr && !b.fee_outsider_full_pkr
      const villagerMonthly = Number(b.fee_villager_monthly_pkr) || null
      feeByProject[b.project_id] = {
        free: existing.free && batchIsFree,
        cheapestVillagerMonthly: villagerMonthly && (!existing.cheapestVillagerMonthly || villagerMonthly < existing.cheapestVillagerMonthly)
          ? villagerMonthly : existing.cheapestVillagerMonthly,
      }
    }
  }

  return (
    <ProjectsListClient
      projects={projects}
      voteCounts={voteCounts}
      commentCounts={commentCounts}
      receivedByProject={receivedByProject}
      expenseByProject={expenseByProject}
      feeByProject={feeByProject}
      privateTotal={privateTotal}
      lang={lang}
    />
  )
}
