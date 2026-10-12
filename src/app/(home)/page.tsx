import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getPaymentAccount } from '@/lib/paymentAccounts'
import { getPublicSiteContext, getCardImages } from '@/lib/publicSite'
import { getCookieTenantId } from '@/lib/tenant'
import { Home2 } from '@/components/home2/Home2'
import { welfareCardContentKeys } from '@/lib/welfareCardContent'

// Same fixed cover used on /projects for a medical/health project — a real
// photo of someone's treatment is never shown publicly, on this page either.
const HEALTH_COVER_IMAGE = '/images/health-project-cover.jpg'
const isHealthCategory = (category: string | null) => category === 'health'

// Description is deliberately omitted -- it falls through to the root
// layout's generateMetadata(), which already resolves the real tenant
// (this used to hardcode SITE.fullName, always "Dhab Pari").
export const metadata: Metadata = {
  title: 'Home',
}

// Homepage stats/activity digest change more often than About/Donate, but
// nothing here is per-visitor — a 1-minute cache still means every real
// visitor gets a fast cached page instead of the full stats+jobs+volunteers+
// achievements query set running fresh on every single visit.
export const revalidate = 60

interface HomepageStats {
  available_funds: number; active_projects: number; donations_this_month: number
  registered_households: number; revenue_this_month: number; expenses_this_month: number
}

export default async function HomePage() {
  const supabase = await createClient()
  // Real gap found 2026-10-08: a water-supply-only tenant's homepage
  // still rendered every donor/welfare section unconditionally (stats
  // row, Welfare & Education cards, Sadqa board, Ongoing Projects) --
  // same class of bug as the header/footer nav, fixed the same day.
  const site = await getPublicSiteContext(supabase, await getCookieTenantId())

  const [projectsRes, newsRes, videosRes, donorsRes, statsRes, jobsRes, volunteersRes, achievementsRes, bloodRes,
         needsRes, kafalatRes, wazifaRes, sadqaRes, committeeNotesRes, welfareContentRes, careerCountsRes, paymentAccount, classifiedsRes] = await Promise.all([
    supabase
      .from('projects')
      .select('id, title, title_ur, display_name, status, progress_percent, budget_pkr, spent_pkr, category, location, before_image_url, after_image_url, funding_model')
      // Grouped by category below (Sports, Health, Infrastructure, ...),
      // several cards per category rather than two undifferentiated ones —
      // a recurring_support academy/program (a trainer's ongoing salary)
      // stays listed even once marked "completed", same rule already
      // built for /projects itself.
      .or('status.eq.ongoing,funding_model.eq.recurring_support')
      // unlisted (365) keeps a row off every public "project" listing, not
      // just /projects — this card grid is exactly that. display_name
      // (364) is selected above so a medical project's real title (the
      // patient's name) never reaches this page either.
      .eq('unlisted', false)
      .order('created_at', { ascending: false })
      .limit(6),
    supabase
      .from('news_posts')
      .select('id, title, category, content, published_at, is_featured')
      .eq('is_published', true)
      // Featured posts lead regardless of category — a publisher's "show
      // this prominently" carries across News/Poetry/Blog alike, then the
      // rest fall back to newest first, same as before.
      .order('is_featured', { ascending: false })
      .order('published_at', { ascending: false })
      .limit(4),
    supabase
      .from('video_content')
      .select('id, title, video_url, thumbnail_url, duration_seconds, category')
      .eq('is_published', true)
      .limit(4),
    // donors_public, not the raw donors table -- donors has no
    // anonymous-read RLS policy at all (donors_read/donors_portal_read_own
    // both require an authenticated admin/portal session), so this always
    // returned zero rows for every real site visitor. donors_public
    // already masks is_anonymous donors as "Anonymous" server-side
    // (migration 133), which is why it has no is_anonymous column to
    // select here.
    supabase
      .from('donors_public')
      .select('id, name, amount_pkr, date')
      .eq('is_verified', true)
      .order('date', { ascending: false })
      .limit(4),
    // Real aggregate stats (migration 150) — the stat cards and Cash
    // Position card below used to be hardcoded placeholder text.
    supabase.rpc('homepage_stats').maybeSingle(),
    supabase.from('job_listings').select('id, category, headline').eq('is_active', true).order('created_at', { ascending: false }).limit(3),
    supabase.from('volunteers_public').select('id, project_id, full_name').order('created_at', { ascending: false }).limit(4),
    supabase.from('achievements_public').select('id, done_at, is_private, text_ur, done_by_name').limit(3),
    // Counts only — the function is SECURITY DEFINER precisely so that no
    // donor name, number or address can ever reach this page (migration 188).
    supabase.rpc('blood_group_counts'),
    supabase.rpc('needs_register_summary'),
    supabase.rpc('public_kafalat_summary'),
    supabase.rpc('public_wazifa_summary'),
    supabase.rpc('public_sadqa_board'),
    // Ordered by when it was actually posted, not release_date — release_date
    // is admin-editable display text (an easy typo away from silently
    // burying the newest note behind an older one with a later-looking
    // date); "which one is latest" should never depend on getting that
    // field right.
    supabase.from('committee_notes').select('id, body_en, body_ur, release_date, linked_project_id, link_url, link_label_en, link_label_ur, projects(title, title_ur, display_name)')
      .eq('is_published', true).order('created_at', { ascending: false }).limit(6),
    // Zakat/Kafalat/Wazifa/Esal-e-Sawab card copy — migration 307, editable
    // from Settings. Fetched by exact key list rather than a blanket
    // site_settings select, since this page already avoids reading settings
    // it doesn't use.
    supabase.from('site_settings').select('key, value').in('key', welfareCardContentKeys()),
    supabase.rpc('career_program_counts'),
    getPaymentAccount(supabase, 'donors_projects'),
    // Real Buy & Sell cards for the homepage, per direct correction --
    // the design template's own "market" section used fake tractor/straw
    // placeholder listings; this is the real classified_listings table
    // (migration 532), same one /classifieds and the portal posting flow
    // already use.
    supabase.from('classified_listings').select('id, title, price_pkr, photo_url, category')
      .eq('status', 'active').eq('is_active', true).order('created_at', { ascending: false }).limit(6),
  ])

  const projects = projectsRes.data ?? []
  // Real ledger totals, not the unused manual spent_pkr column — same fix
  // already applied on /projects, just never carried over to this page's
  // own separate query. The project ids are only known after the query
  // above resolves, so this can't join the first Promise.all.
  const projectIds = projects.map((p) => p.id)
  const { data: expenseRows } = projectIds.length > 0
    ? await supabase.from('project_expenses_public').select('project_id, debit').in('project_id', projectIds)
    : { data: [] as { project_id: string; debit: number }[] }
  const expenseByProject: Record<string, number> = {}
  for (const e of expenseRows ?? []) expenseByProject[e.project_id] = (expenseByProject[e.project_id] ?? 0) + Number(e.debit)

  // A designated cover photo (383) wins over the before/after fallback —
  // an admin picking one specific photo to represent the project should
  // actually show up as the card image, not whichever of before/after
  // happened to be set.
  const coverByProject: Record<string, string> = {}
  if (projectIds.length > 0) {
    const { data: coverRows } = await supabase.from('project_media').select('project_id, url').eq('is_cover', true).in('project_id', projectIds)
    for (const c of coverRows ?? []) coverByProject[c.project_id] = c.url
  }

  // Fee badge for a sports/training card — same "starting from" logic
  // /projects already uses, just never carried over to this page's own
  // separate query, so a new academy showed up here with zero fee info
  // at all until a visitor clicked through.
  interface FeeSummary { free: boolean; cheapestVillagerMonthly: number | null }
  const feeByProject: Record<string, FeeSummary> = {}
  if (projects.some((p) => p.category === 'sports' || p.category === 'training')) {
    const { data: batchRows } = await supabase.rpc('training_batches_public')
    for (const b of (batchRows ?? []) as { project_id: string; fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null; fee_villager_full_pkr: number | null; fee_outsider_full_pkr: number | null }[]) {
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

  const news = newsRes.data ?? []
  const videos = videosRes.data ?? []
  const donors = donorsRes.data ?? []
  const stats = (statsRes.data as HomepageStats | null) ?? { available_funds: 0, active_projects: 0, donations_this_month: 0, registered_households: 0, revenue_this_month: 0, expenses_this_month: 0 }
  const jobs = jobsRes.data ?? []
  const volunteers = volunteersRes.data ?? []
  const achievements = achievementsRes.data ?? []
  const bloodGroups = (bloodRes.data ?? []) as { blood_group: string; registered: number; available_now: number }[]
  const bloodTotal = bloodGroups.reduce((s, g) => s + g.registered, 0)
  // Supabase returns the embedded FK as an object for a to-one relationship,
  // but as an array on some PostgREST versions/configurations — normalising
  // here once rather than at every call site that reads project_title.
  const committeeNotesRaw = (committeeNotesRes.data ?? []) as unknown as {
    id: string; body_en: string; body_ur: string; release_date: string; linked_project_id: string | null
    link_url: string | null; link_label_en: string | null; link_label_ur: string | null
    projects: { title: string; title_ur: string | null; display_name: string | null } | { title: string; title_ur: string | null; display_name: string | null }[] | null
  }[]
  const committeeNotes = committeeNotesRaw.map((n) => {
    const proj = Array.isArray(n.projects) ? n.projects[0] : n.projects
    return {
      id: n.id, body_en: n.body_en, body_ur: n.body_ur, release_date: n.release_date,
      // display_name (364) over the real title, same as everywhere else a
      // donor/visitor sees a project — a note mentioning a medical project
      // shouldn't be the one place its real title still leaks through.
      project_id: n.linked_project_id, project_title: (proj?.display_name || proj?.title) ?? null, project_title_ur: proj?.display_name ? null : (proj?.title_ur ?? null),
      link_url: n.link_url, link_label_en: n.link_label_en, link_label_ur: n.link_label_ur,
    }
  })
  const latestCommitteeNote = committeeNotes[0] ?? null
  const committeeNotesArchive = committeeNotes.slice(1)

  // The welfare modules. Counts only — no household, child or student is ever
  // named on a public page, so what the village sees is scale rather than
  // people: how many are being reached, and how many are still waiting.
  const needs = (needsRes.data ?? {}) as Record<string, number>
  const kafalat = (kafalatRes.data ?? {}) as Record<string, number>
  const wazifa = (wazifaRes.data ?? {}) as Record<string, number>
  const sadqaObjects = ((sadqaRes.data ?? []) as { status: string }[])
  const sadqaWorking = sadqaObjects.filter((o) => ['installed', 'in_service'].includes(o.status)).length
  const careerCounts = (careerCountsRes.data ?? {}) as Record<string, number>
  const welfareContent: Record<string, string> = {}
  ;((welfareContentRes.data ?? []) as { key: string; value: string | null }[]).forEach((s) => { welfareContent[s.key] = s.value ?? '' })
  const volunteerProjectIds = volunteers.map((v) => v.project_id).filter((id): id is string => !!id)
  const { data: volunteerProjects } = volunteerProjectIds.length
    ? await supabase.from('projects').select('id, title').in('id', volunteerProjectIds)
    : { data: [] as { id: string; title: string }[] }
  const volunteerProjectTitle = (id: string | null) => id ? (volunteerProjects?.find((p) => p.id === id)?.title ?? 'a project') : 'General — Any Project'

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime()
    const hours = Math.floor(diff / 3600000)
    if (hours < 1) return 'Just now'
    if (hours < 24) return `${hours} hours ago`
    const days = Math.floor(hours / 24)
    if (days === 1) return 'Yesterday'
    return `${days} days ago`
  }

  // Phase 1 of the card-based redesign, 2026-10-12: the welfare/mentor
  // card thumbnails have no real backing table of their own (unlike
  // project/classifieds/video photos, read from their own existing
  // columns above) -- this is the one lookup for those few
  // site_card_images slots (migration 642).
  const cardImages = await getCardImages(supabase, await getCookieTenantId(), [
    'welfare_1', 'welfare_2', 'welfare_3', 'welfare_4',
    'mentor_1', 'mentor_2', 'mentor_3', 'mentor_4',
    'fund_available', 'fund_drives', 'fund_month', 'fund_households',
    'mp_shops', 'mp_adda', 'mp_order_city', 'mp_city_purchase', 'mp_commute', 'mp_shadi',
  ])

  return (
    <Home2
      projects={projects.map((p) => ({
        id: p.id, title: p.title, title_ur: p.title_ur, display_name: p.display_name, status: p.status,
        progress_percent: p.progress_percent, budget_pkr: p.budget_pkr ?? 0, category: p.category,
        coverUrl: isHealthCategory(p.category) ? HEALTH_COVER_IMAGE : (coverByProject[p.id] ?? p.after_image_url ?? p.before_image_url ?? null),
        spent: expenseByProject[p.id] ?? 0,
      }))}
      news={news.map((n) => ({ id: n.id, title: n.title, category: n.category, content: n.content, is_featured: n.is_featured }))}
      videos={videos.map((v) => ({ id: v.id, title: v.title, thumbnail_url: v.thumbnail_url, duration_seconds: v.duration_seconds }))}
      donors={donors.map((d) => ({ id: d.id, name: d.name, amount_pkr: d.amount_pkr, date: timeAgo(d.date) }))}
      stats={stats}
      jobs={jobs}
      volunteers={volunteers.map((v) => ({ id: v.id, full_name: v.full_name, projectTitle: volunteerProjectTitle(v.project_id) }))}
      achievements={achievements}
      bloodGroups={bloodGroups}
      bloodTotal={bloodTotal}
      needs={needs}
      kafalat={kafalat}
      wazifa={wazifa}
      sadqaWorking={sadqaWorking}
      sadqaTotal={sadqaObjects.length}
      careerCounts={careerCounts}
      welfareContent={welfareContent}
      classifieds={(classifiedsRes.data ?? []).map((c) => ({ id: c.id, title: c.title, price_pkr: c.price_pkr, photo_url: c.photo_url, category: c.category }))}
      cardImages={cardImages}
      latestCommitteeNote={latestCommitteeNote}
      committeeNotesArchive={committeeNotesArchive}
      paymentAccount={paymentAccount}
    />
  )
}

