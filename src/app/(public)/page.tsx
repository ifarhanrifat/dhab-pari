import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'Home',
  description: `Official portal for ${SITE.fullName} — village transparency, water bills, projects, and community updates.`,
}

// Homepage stats/activity digest change more often than About/Donate, but
// nothing here is per-visitor — a 1-minute cache still means every real
// visitor gets a fast cached page instead of the full stats+jobs+volunteers+
// achievements query set running fresh on every single visit.
export const revalidate = 60
import {
  Wallet,
  GitBranch,
  Heart,
  Users,
  ArrowRight,
  Play,
  Eye,
  ChevronRight,
  Briefcase,
  HandHeart,
  Trophy,
  Lock,
  Droplet,
} from 'lucide-react'
import { HomeHero } from '@/components/home/HomeHero'
import { HomeMobileQuickActions } from '@/components/home/HomeMobileQuickActions'
import { HomeMobileUrduCta } from '@/components/home/HomeMobileUrduCta'
import { T, LocaleDir } from '@/components/i18n/T'
import { WelfareCards } from '@/components/home/WelfareCards'
import { CareerCards } from '@/components/home/CareerCards'
import { CommitteeNoteCard } from '@/components/home/CommitteeNoteCard'
import { welfareCardContentKeys } from '@/lib/welfareCardContent'

function fmtPKR(n: number) {
  return Math.round(n).toLocaleString()
}

interface HomepageStats {
  available_funds: number; active_projects: number; donations_this_month: number
  registered_households: number; revenue_this_month: number; expenses_this_month: number
}

export default async function HomePage() {
  const supabase = await createClient()

  const [projectsRes, newsRes, videosRes, donorsRes, statsRes, jobsRes, volunteersRes, achievementsRes, bloodRes,
         needsRes, kafalatRes, wazifaRes, sadqaRes, committeeNotesRes, welfareContentRes, careerCountsRes] = await Promise.all([
    supabase
      .from('projects')
      .select('id, title, title_ur, status, progress_percent, budget_pkr, spent_pkr, category, location, before_image_url, after_image_url')
      .eq('status', 'ongoing')
      .limit(2),
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
    supabase
      .from('donors')
      .select('id, name, amount_pkr, date, is_anonymous')
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
    supabase.from('committee_notes').select('id, body_en, body_ur, release_date, linked_project_id, link_url, link_label_en, link_label_ur, projects(title, title_ur)')
      .eq('is_published', true).order('created_at', { ascending: false }).limit(6),
    // Zakat/Kafalat/Wazifa/Esal-e-Sawab card copy — migration 307, editable
    // from Settings. Fetched by exact key list rather than a blanket
    // site_settings select, since this page already avoids reading settings
    // it doesn't use.
    supabase.from('site_settings').select('key, value').in('key', welfareCardContentKeys()),
    supabase.rpc('career_program_counts'),
  ])

  const projects = projectsRes.data ?? []
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
    projects: { title: string; title_ur: string | null } | { title: string; title_ur: string | null }[] | null
  }[]
  const committeeNotes = committeeNotesRaw.map((n) => {
    const proj = Array.isArray(n.projects) ? n.projects[0] : n.projects
    return {
      id: n.id, body_en: n.body_en, body_ur: n.body_ur, release_date: n.release_date,
      project_id: n.linked_project_id, project_title: proj?.title ?? null, project_title_ur: proj?.title_ur ?? null,
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

  const categoryEmojis: Record<string, string> = {
    sports: '⚽',
    education: '🎓',
    health: '🩺',
    environment: '🌿',
    social: '🤝',
    announcement: '📢',
    event: '🎉',
    editorial: '✍️',
    poetry: '🖋️',
    blog: '📝',
  }

  function formatDuration(seconds: number | null) {
    if (!seconds) return '0:00'
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime()
    const hours = Math.floor(diff / 3600000)
    if (hours < 1) return 'Just now'
    if (hours < 24) return `${hours} hours ago`
    const days = Math.floor(hours / 24)
    if (days === 1) return 'Yesterday'
    return `${days} days ago`
  }

  return (
    // Direction is per-reader and this page is cached and shared, so it cannot
    // be decided on the server. LocaleDir is a client island that applies it
    // after hydration; the CSS on this page is all logical properties now, so
    // everything inside mirrors from here.
    <LocaleDir>
      {/* ========== HERO ========== */}
      <HomeHero />

      {/* ========== STAT CARDS (overlapping hero on desktop only) ==========
          The -mt-16 pull-up is a desktop effect: that hero has pb-32 to make
          room for it. The mobile hero has no such padding, so on a phone the
          cards rode up and covered the hero's own paragraph. Keep the overlap
          from md upward, sit normally below the hero on mobile. */}
      <div className="max-w-[1200px] mx-auto px-6 md:-mt-16 relative z-20">
        {/* Desktop: 4 cols / Mobile: 2x2 grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
          <div className="bg-white border border-dp-outline-variant p-4 lg:p-6 rounded-lg hover:bg-dp-surface-container-low transition-colors">
            <div className="flex justify-between items-start mb-2">
              <span className="p-2 bg-dp-primary-fixed text-dp-primary rounded-lg">
                <Wallet size={20} />
              </span>
            </div>
            <div className="text-dp-primary font-bold text-[20px] font-sans leading-[28px]">PKR {fmtPKR(stats.available_funds)}</div>
            <div className="text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]"><T k="home.availableFunds" /></div>
          </div>

          <div className="bg-white border border-dp-outline-variant p-4 lg:p-6 rounded-lg hover:bg-dp-surface-container-low transition-colors">
            <div className="flex justify-between items-start mb-2">
              <span className="p-2 bg-dp-primary-fixed text-dp-primary rounded-lg">
                <GitBranch size={20} />
              </span>
              <span className="bg-dp-secondary-container text-dp-on-secondary-container px-2 py-0.5 rounded text-[10px] font-bold"><T k="home.active" /></span>
            </div>
            <div className="text-dp-primary font-bold text-[20px] font-sans leading-[28px]">{stats.active_projects} Projects</div>
            <div className="text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]"><T k="home.activeDrives" /></div>
          </div>

          <div className="bg-white border border-dp-outline-variant p-4 lg:p-6 rounded-lg hover:bg-dp-surface-container-low transition-colors">
            <div className="flex justify-between items-start mb-2">
              <span className="p-2 bg-dp-primary-fixed text-dp-primary rounded-lg">
                <Heart size={20} />
              </span>
              <span className="text-dp-primary-container font-bold text-[14px] font-sans tracking-[0.05em]"><T k="home.thisMonth" /></span>
            </div>
            <div className="text-dp-primary font-bold text-[20px] font-sans leading-[28px]">PKR {fmtPKR(stats.donations_this_month)}</div>
            <div className="text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]"><T k="home.totalDonations" /></div>
          </div>

          <div className="bg-white border border-dp-outline-variant p-4 lg:p-6 rounded-lg hover:bg-dp-surface-container-low transition-colors">
            <div className="flex justify-between items-start mb-2">
              <span className="p-2 bg-dp-primary-fixed text-dp-primary rounded-lg">
                <Users size={20} />
              </span>
              <span className="text-dp-outline-variant">
                <Eye size={16} />
              </span>
            </div>
            <div className="text-dp-primary font-bold text-[20px] font-sans leading-[28px]">{stats.registered_households} Consumers</div>
            <div className="text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]"><T k="home.registeredHouseholds" /></div>
          </div>
        </div>
      </div>

      {/* ========== MOBILE: Quick Actions ========== */}
      <HomeMobileQuickActions />

      {/* ========== MAIN CONTENT + SIDEBAR ========== */}
      <div className="max-w-[1200px] mx-auto px-6 py-8 flex flex-col lg:flex-row gap-6">

        {/* ===== MAIN COLUMN ===== */}
        <div className="flex-1 space-y-8">

          {/* --- Ongoing Projects --- */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title"><T k="home.ongoingProjects" /></h2>
              <Link href="/projects" className="text-dp-secondary font-bold hover:underline flex items-center text-[14px] font-sans tracking-[0.05em]">
                <T k="home.viewAll" /> <ArrowRight size={16} className="ms-1 rtl:-scale-x-100" />
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects`}
                  className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden hover:shadow-md transition-shadow group"
                >
                  <div className="h-48 bg-dp-surface-container overflow-hidden">
                    <div className="w-full h-full bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container flex items-center justify-center">
                      <GitBranch size={48} className="text-dp-on-primary-container/40" />
                    </div>
                  </div>
                  <div className="p-6">
                    <span className="bg-dp-secondary-container text-dp-on-secondary-container text-[10px] font-extrabold px-2 py-1 rounded uppercase tracking-wider">
                      {project.status}
                    </span>
                    <h3 className="text-[20px] font-sans font-semibold leading-[28px] mt-2 text-dp-primary group-hover:text-dp-secondary transition-colors">
                      {project.title}
                    </h3>
                    <div className="mt-4 space-y-2">
                      <div className="flex justify-between text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant">
                        <span><T k="home.progress" /></span>
                        <span>{project.progress_percent}%</span>
                      </div>
                      <div className="w-full bg-dp-surface-container-high h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-dp-secondary h-full transition-all duration-1000"
                          style={{ width: `${project.progress_percent}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex justify-between mt-6 pt-4 border-t border-dp-outline-variant text-[14px] font-sans font-semibold tracking-[0.05em]">
                      <div>
                        <p className="text-dp-on-surface-variant"><T k="home.budget" /></p>
                        <p className="font-bold text-dp-primary">
                          PKR {(project.budget_pkr ?? 0).toLocaleString()}
                        </p>
                      </div>
                      <div className="text-end">
                        <p className="text-dp-on-surface-variant"><T k="home.spent" /></p>
                        <p className="font-bold text-dp-primary">
                          PKR {(project.spent_pkr ?? 0).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
              {projects.length === 0 && (
                <div className="col-span-2 text-center py-12 text-dp-on-surface-variant">
                  <T k="home.noProjects" />
                </div>
              )}
            </div>
          </section>

          {/* --- Welfare: Zakat, Kafalat, Taleemi Wazifa, Esal-e-Sawab ---
              A client island, because the counters animate as they scroll
              into view and the cards lift on hover — none of which a server
              component can do. The counts are computed here and passed down,
              so the page still renders them without waiting on the browser. */}
          <WelfareCards
            needs={needs}
            kafalat={kafalat}
            wazifa={wazifa}
            sadqaWorking={sadqaWorking}
            sadqaTotal={sadqaObjects.length}
            content={welfareContent}
          />

          {/* --- Mentors & Career Support --- */}
          <CareerCards
            mentorsAvailable={careerCounts.mentors_available ?? 0}
            institutes={careerCounts.institutes ?? 0}
            trainingProgramsOpen={careerCounts.training_programs_open ?? 0}
            talentShowcased={careerCounts.talent_showcased ?? 0}
          />

          {/* --- Latest News --- */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title"><T k="home.latestNews" /></h2>
              <Link href="/news" className="text-dp-secondary font-bold hover:underline text-[14px] font-sans tracking-[0.05em]">
                <T k="home.fullArchive" />
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {news.map((post) => (
                <Link
                  key={post.id}
                  href={`/news`}
                  className="p-5 bg-white border border-dp-outline-variant rounded-lg flex gap-4 hover:bg-dp-surface-container-low transition-colors cursor-pointer group"
                >
                  <div className="text-4xl shrink-0">
                    {categoryEmojis[post.category ?? ''] ?? '📰'}
                  </div>
                  <div className="min-w-0">
                    <span className="text-[10px] font-bold text-dp-secondary uppercase tracking-widest font-sans">
                      {post.category}
                    </span>
                    {post.is_featured && (
                      <span className="ms-2 text-[10px] font-extrabold text-amber-600 uppercase tracking-widest font-sans">★ <T k="y.featured" fallback="Featured" /></span>
                    )}
                    <h4 className="font-bold text-dp-primary group-hover:text-dp-secondary transition-colors text-[16px] font-sans leading-[24px] line-clamp-2">
                      {post.title}
                    </h4>
                    <p className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant mt-1 line-clamp-2">
                      {post.content?.slice(0, 100)}...
                    </p>
                  </div>
                </Link>
              ))}
              {news.length === 0 && (
                <div className="col-span-2 text-center py-12 text-dp-on-surface-variant">
                  <T k="home.noNews" />
                </div>
              )}
            </div>
          </section>

          {/* --- Featured Videos --- */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title"><T k="home.featuredVideos" /></h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {videos.map((video) => (
                <Link
                  key={video.id}
                  href={`/videos/${video.id}`}
                  className="group relative rounded-lg overflow-hidden bg-black cursor-pointer block" style={{ aspectRatio: '16/10' }}
                >
                  <div className="w-full h-full bg-gradient-to-br from-dp-primary to-dp-tertiary-container opacity-60 group-hover:opacity-40 transition-opacity" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-12 h-12 bg-white/20 backdrop-blur rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                      <Play size={24} className="text-white ms-1" fill="white" />
                    </div>
                  </div>
                  <div className="absolute bottom-2 right-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-sans">
                    {formatDuration(video.duration_seconds)}
                  </div>
                  <div className="absolute bottom-4 left-4 right-4">
                    <p className="text-white font-bold text-[14px] font-sans tracking-[0.05em] truncate">
                      {video.title}
                    </p>
                  </div>
                </Link>
              ))}
              {videos.length === 0 && (
                <div className="col-span-2 text-center py-12 text-dp-on-surface-variant">
                  <T k="home.noVideos" />
                </div>
              )}
            </div>
          </section>

          {/* --- Village Job Board --- */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title flex items-center gap-3"><Briefcase size={26} /> <T k="home.jobBoard" /></h2>
              <Link href="/jobs" className="text-dp-secondary font-bold hover:underline flex items-center text-[14px] font-sans tracking-[0.05em]">
                <T k="home.viewAll" /> <ArrowRight size={16} className="ms-1 rtl:-scale-x-100" />
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {jobs.map((job) => (
                <Link
                  key={job.id}
                  href="/jobs"
                  className="p-5 bg-white border border-dp-outline-variant rounded-lg hover:bg-dp-surface-container-low transition-colors group"
                >
                  <span className="bg-dp-secondary-container text-dp-on-secondary-container text-[10px] font-extrabold px-2 py-1 rounded uppercase tracking-wider">
                    {job.category}
                  </span>
                  <p className="text-[15px] font-sans font-semibold text-dp-primary group-hover:text-dp-secondary transition-colors mt-2 line-clamp-2">
                    {job.headline}
                  </p>
                </Link>
              ))}
              {jobs.length === 0 && (
                <div className="col-span-3 text-center py-12 text-dp-on-surface-variant">
                  <T k="home.noListings" /> <Link href="/portal/post-job" className="text-dp-secondary font-semibold hover:underline">post the first one</Link>.
                </div>
              )}
            </div>
          </section>

          {/* --- Our Achievements --- */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title flex items-center gap-3"><Trophy size={26} /> <T k="home.achievements" /></h2>
              <Link href="/achievements" className="text-dp-secondary font-bold hover:underline flex items-center text-[14px] font-sans tracking-[0.05em]">
                <T k="home.viewAll" /> <ArrowRight size={16} className="ms-1 rtl:-scale-x-100" />
              </Link>
            </div>
            <div className="space-y-3">
              {achievements.map((a) => (
                <div key={a.id} className="p-4 bg-white border border-dp-outline-variant rounded-lg flex items-start gap-3">
                  {a.is_private ? <Lock size={16} className="text-dp-on-surface-variant shrink-0 mt-0.5" /> : <Trophy size={16} className="text-dp-secondary shrink-0 mt-0.5" />}
                  {a.is_private ? (
                    <p className="text-[14px] font-sans text-dp-on-surface-variant italic"><T k="home.privateTask" /> <span className="font-semibold not-italic">{a.done_by_name ?? 'a committee member'}</span></p>
                  ) : (
                    <p className="text-[14px] font-sans text-dp-on-surface" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{a.text_ur}</p>
                  )}
                </div>
              ))}
              {achievements.length === 0 && (
                <div className="text-center py-12 text-dp-on-surface-variant">
                  <T k="home.nothingCompleted" />
                </div>
              )}
            </div>
          </section>

        </div>

        {/* ===== RIGHT SIDEBAR (280px) ===== */}
        <aside className="w-full lg:w-[280px] shrink-0 space-y-6">

          {/* Committee Note */}
          <CommitteeNoteCard latest={latestCommitteeNote} archive={committeeNotesArchive} />

          {/* Cash Position */}
          <div className="bg-dp-primary text-white rounded-lg p-6 border border-dp-primary-container">
            <h3 className="text-[14px] font-sans font-semibold tracking-[0.05em] uppercase opacity-80 mb-4">
              <T k="home.cashPosition" />
            </h3>
            <div className="space-y-4">
              <div>
                <div className="text-[28px] font-bold font-sans">PKR {fmtPKR(stats.available_funds)}</div>
                <div className="text-[12px] opacity-70 font-sans"><T k="home.totalLiquid" /></div>
              </div>
              <div className="h-px bg-white/20 w-full" />
              <div className="grid grid-cols-2 gap-2 text-[14px] font-sans font-semibold tracking-[0.05em]">
                <div>
                  <p className="opacity-60"><T k="home.revenueMonth" /></p>
                  <p className="font-bold">+{fmtPKR(stats.revenue_this_month)}</p>
                </div>
                <div className="text-end">
                  <p className="opacity-60"><T k="home.expensesMonth" /></p>
                  <p className="font-bold text-red-300">-{fmtPKR(stats.expenses_this_month)}</p>
                </div>
              </div>
              <Link
                href="/accounts"
                className="block w-full py-2 bg-white/10 hover:bg-white/20 rounded text-center font-bold text-[14px] font-sans tracking-[0.05em] transition-colors"
              >
                <T k="home.financialReport" />
              </Link>
            </div>
          </div>

          {/* Donors Transparency */}
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
            <div className="p-4 bg-dp-surface-container-low border-b border-dp-outline-variant flex items-center justify-between">
              <h3 className="font-bold text-dp-primary text-[14px] font-sans tracking-[0.05em]">
                <T k="home.donorsTransparency" />
              </h3>
              <Eye size={16} className="text-dp-primary" />
            </div>
            <div className="divide-y divide-dp-outline-variant max-h-[300px] overflow-y-auto hide-scrollbar">
              {donors.map((donor) => (
                <div
                  key={donor.id}
                  className="p-4 flex items-center justify-between hover:bg-dp-surface-container-low transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-bold text-dp-on-surface text-[14px] font-sans tracking-[0.05em] truncate">
                      {donor.is_anonymous ? 'Anonymous Donor' : donor.name}
                    </p>
                    <p className="text-[10px] text-dp-on-surface-variant font-sans">
                      {timeAgo(donor.date)}
                    </p>
                  </div>
                  <div className="text-dp-secondary font-bold text-[14px] font-sans tracking-[0.05em] shrink-0 ms-2">
                    PKR {donor.amount_pkr.toLocaleString()}
                  </div>
                </div>
              ))}
              {donors.length === 0 && (
                <div className="p-4 text-center text-dp-on-surface-variant text-[14px]">
                  <T k="home.noDonors" />
                </div>
              )}
            </div>
            <Link
              href="/donate"
              className="block p-3 text-center text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-secondary font-bold bg-dp-surface-container-low border-t border-dp-outline-variant hover:bg-dp-surface-container transition-colors"
            >
              <T k="home.viewFullList" />
            </Link>
          </div>

          {/* Volunteers */}
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
            <div className="p-4 bg-dp-surface-container-low border-b border-dp-outline-variant flex items-center justify-between">
              <h3 className="font-bold text-dp-primary text-[14px] font-sans tracking-[0.05em] flex items-center gap-2">
                <HandHeart size={16} /> <T k="home.volunteers" />
              </h3>
            </div>
            <div className="divide-y divide-dp-outline-variant max-h-[300px] overflow-y-auto hide-scrollbar">
              {volunteers.map((v) => (
                <div key={v.id} className="p-4 hover:bg-dp-surface-container-low transition-colors">
                  <p className="font-bold text-dp-on-surface text-[14px] font-sans tracking-[0.05em] truncate">
                    {v.full_name}
                  </p>
                  <p className="text-[12px] text-dp-secondary font-sans font-semibold truncate">
                    {volunteerProjectTitle(v.project_id)}
                  </p>
                </div>
              ))}
              {volunteers.length === 0 && (
                <div className="p-4 text-center text-dp-on-surface-variant text-[14px]">
                  <T k="home.noVolunteers" />
                </div>
              )}
            </div>
            <Link
              href="/volunteer"
              className="block p-3 text-center text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-secondary font-bold bg-dp-surface-container-low border-t border-dp-outline-variant hover:bg-dp-surface-container transition-colors"
            >
              <T k="home.joinVolunteer" />
            </Link>
          </div>

          {/* Blood Donor Registry — numbers only.
              Publishing names and numbers is how village blood lists get
              spammed and how donors quietly de-register. Anyone who needs
              blood phones the committee; the committee does the matching. */}
          {bloodGroups.length > 0 && (
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
            <div className="p-4 bg-dp-surface-container-low border-b border-dp-outline-variant flex items-center justify-between">
              <h3 className="font-bold text-dp-primary text-[14px] font-sans tracking-[0.05em] flex items-center gap-2">
                <Droplet size={16} className="text-dp-error" /> <T k="home.bloodRegistry" />
              </h3>
              <span className="text-[12px] font-sans font-bold text-dp-on-surface-variant">{bloodTotal} <T k="home.registered" /></span>
            </div>
            <div className="p-4 grid grid-cols-4 gap-2">
              {bloodGroups.map((g) => (
                <div key={g.blood_group} className="text-center border border-dp-outline-variant rounded-lg py-2">
                  <p className="font-heading text-[15px] font-bold text-dp-error leading-none">{g.blood_group}</p>
                  <p className="font-sans text-[17px] font-bold text-dp-on-surface leading-tight mt-1">{g.registered}</p>
                  <p className="font-sans text-[9.5px] text-dp-on-surface-variant leading-none">{g.available_now} <T k="home.ready" /></p>
                </div>
              ))}
            </div>
            <div className="px-4 pb-3">
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-snug"><T k="home.bloodNote" /></p>
            </div>
            <Link
              href="/blood"
              className="block p-3 text-center text-[14px] font-sans font-bold tracking-[0.05em] text-white bg-dp-error hover:opacity-90 transition-opacity"
            >
              <T k="home.requestBlood" />
            </Link>
            <Link
              href="/portal/blood-donor"
              className="block p-3 text-center text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-secondary font-bold bg-dp-surface-container-low border-t border-dp-outline-variant hover:bg-dp-surface-container transition-colors"
            >
              <T k="home.registerBloodDonor" />
            </Link>
          </div>
          )}

          {/* Donate Now Card */}
          <div className="bg-dp-secondary text-white rounded-lg p-6 relative overflow-hidden">
            <div className="relative z-10">
              <h3 className="text-[20px] font-sans font-semibold leading-[28px] mb-2"><T k="home.donateNow" /></h3>
              <p className="text-[14px] font-sans font-semibold tracking-[0.05em] opacity-90 mb-6">
                <T k="home.donateBlurb" />
              </p>
              <div className="space-y-4">
                <div className="bg-white/10 p-3 rounded border border-white/20">
                  <p className="text-[10px] uppercase font-bold opacity-60 font-sans"><T k="home.jazzcashEasypaisa" /></p>
                  <p className="font-mono text-[18px]">{SITE.jazzcash}</p>
                </div>
                <div className="bg-white/10 p-3 rounded border border-white/20">
                  <p className="text-[10px] uppercase font-bold opacity-60 font-sans">Bank Account ({SITE.bankName})</p>
                  <p className="font-mono text-[14px]">{SITE.bankAccount}</p>
                  <p className="text-[10px] mt-1 font-sans">Title: {SITE.jazzcashName}</p>
                </div>
              </div>
              <Link
                href="/donate"
                className="block w-full mt-6 py-3 bg-white text-dp-secondary rounded-lg text-center font-bold font-sans hover:bg-dp-secondary-container transition-all"
              >
                <T k="home.submitReceipt" />
              </Link>
            </div>
            <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-white/10 rounded-full blur-2xl" />
          </div>
        </aside>
      </div>

      {/* ========== MOBILE: Urdu CTA ========== */}
      <HomeMobileUrduCta />
    </LocaleDir>
  )
}
