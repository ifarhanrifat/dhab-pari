'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { motion } from 'motion/react'
import {
  MapPin,
  CheckCircle,
  Vote,
  ThumbsUp,
  MessageSquare,
  Flame,
  Lock,
  Eye,
  HandHeart,
} from 'lucide-react'
import { useSite } from '@/components/layout/SiteProvider'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ProjectShareCard } from '@/components/public/ProjectShareCard'

export interface Project {
  id: string
  title: string
  title_ur: string | null
  display_name: string | null
  description: string | null
  description_ur: string | null
  status: string
  progress_percent: number
  start_date: string | null
  end_date: string | null
  budget_pkr: number | null
  spent_pkr: number | null
  category: string | null
  location: string | null
  location_ur: string | null
  sector: string | null
  beneficiaries_count: number | null
  vote_target: number | null
  before_image_url: string | null
  after_image_url: string | null
  proposal_image_url: string | null
  funding_model: string | null
  cover_photo_url?: string | null
}

// Migration 370 — the rate card moved off the project onto its batches
// (kids/adults, day/night, tape/hard ball, as many as the academy needs),
// since one number was never going to describe a whole academy. The card
// badge shows the cheapest villager rate across all of an academy's
// batches — "starting from" is the honest summary for something that can
// now have several different prices at once.
export interface FeeSummary { free: boolean; cheapestVillagerMonthly: number | null }
const isFeeCategory = (category: string | null) => category === 'sports' || category === 'training'
function feeBadgeLabel(p: Project, fee: FeeSummary | undefined, isUrdu: boolean): string | null {
  if (!isFeeCategory(p.category) || !fee) return null
  if (fee.free) return isUrdu ? 'مفت' : 'Free'
  if (fee.cheapestVillagerMonthly) {
    return isUrdu ? `فیس — ${fee.cheapestVillagerMonthly.toLocaleString()} سے/ماہ` : `Fee — from ${fee.cheapestVillagerMonthly.toLocaleString()}/mo`
  }
  return isUrdu ? 'فیس لاگو' : 'Fee applies'
}

type Lang = 'en' | 'ur'

// Health/medical projects use one fixed, non-editable cover image instead
// of a real before/after pair — the "before" photo of an actual patient's
// treatment isn't something the committee has (or should be showing)
// publicly, unlike a street or a water tank. Same asset admin's project
// form is blocked from replacing (see the admin projects page).
const HEALTH_COVER_IMAGE = '/images/health-project-cover.jpg'
const isHealthCategory = (category: string | null) => category === 'health'
// Every donor-facing surface on this page prefers the admin-set public
// label (see migration 364) over the real title — for a medical project
// whose real title is a patient's name, this is the whole point.
const displayTitle = (project: Project) => project.display_name || project.title
// Same fallback chain each card already uses for its own hero photo — reused
// here so a share card's preview image always matches what the card itself
// shows. Health stays on the fixed placeholder for the same privacy reason
// the card enforces it: never a real patient's photo.
const shareImage = (project: Project) =>
  isHealthCategory(project.category) ? HEALTH_COVER_IMAGE
    : project.cover_photo_url ?? project.after_image_url ?? project.proposal_image_url ?? project.before_image_url ?? null

// Same site-wide "Accounts Display Language" toggle every other bilingual
// page here already respects (site_settings.display_language).
const t: Record<string, { en: string; ur: string }> = {
  pageTitle: { en: 'Village Welfare Projects', ur: 'گاؤں کی فلاحی منصوبے' },
  pageSubtitle: { en: `Tracking the growth of {name} through community-funded infrastructure, healthcare, and educational initiatives.`, ur: `کمیونٹی کی مالی معاونت سے تعمیرات، صحت اور تعلیمی اقدامات کے ذریعے {nameUrdu} کی ترقی کا سفر۔` },
  privateTotalLabel: { en: 'Spent on confidential medical support', ur: 'خفیہ طبی امداد پر خرچ' },
  privateTotalNote: { en: "Individual cases are kept private — names, amounts, and details are never shown here to protect the people involved.", ur: 'انفرادی کیسز کو خفیہ رکھا جاتا ہے — متعلقہ افراد کی حفاظت کے لیے یہاں نام، رقم یا تفصیلات ظاہر نہیں کی جاتیں۔' },
  filterAll: { en: 'All', ur: 'تمام' },
  filterOngoing: { en: 'Ongoing', ur: 'جاری' },
  filterCompleted: { en: 'Completed', ur: 'مکمل' },
  filterUpcoming: { en: 'Upcoming', ur: 'آئندہ' },
  filterAnnounced: { en: 'Announced', ur: 'اعلان شدہ' },
  sortByDate: { en: 'Sort by Date', ur: 'تاریخ کے مطابق ترتیب' },
  noProjects: { en: 'No projects found for this filter.', ur: 'اس فلٹر کے لیے کوئی منصوبہ نہیں ملا۔' },
  ctaTitle: { en: 'Have an idea for the village?', ur: 'گاؤں کے لیے کوئی خیال ہے؟' },
  ctaBody: { en: `Every great transformation starts with a simple suggestion. Share your vision for {name}'s future infrastructure or welfare projects.`, ur: `ہر بڑی تبدیلی ایک سادہ تجویز سے شروع ہوتی ہے۔ {nameUrdu} کے مستقبل کے تعمیراتی یا فلاحی منصوبوں کے لیے اپنا خیال پیش کریں۔` },
  submitProposal: { en: 'Submit Proposal', ur: 'تجویز جمع کرائیں' },
  browseProposals: { en: 'Browse Proposals', ur: 'تجاویز دیکھیں' },

  before: { en: 'Before', ur: 'پہلے' },
  present: { en: 'Present', ur: 'اب' },
  ongoingBadge: { en: 'Ongoing', ur: 'جاری' },
  completionLabel: { en: 'Progress', ur: 'پیش رفت' },
  budgetLabel: { en: 'Budget', ur: 'بجٹ' },
  spentLabel: { en: 'Spent', ur: 'خرچ شدہ' },
  detailsBtn: { en: 'Details', ur: 'تفصیلات' },
  donateBtn: { en: 'Donate', ur: 'عطیہ دیں' },

  successStory: { en: 'Success Story', ur: 'کامیابی کی کہانی' },
  completedBadge: { en: 'Completed', ur: 'مکمل' },
  operationalStatus: { en: 'Operational Status', ur: 'آپریشنل حیثیت' },
  fullyFunctional: { en: '100% Fully Functional', ur: '100% مکمل طور پر فعال' },
  totalCost: { en: 'Total Cost', ur: 'کل لاگت' },
  totalReceived: { en: 'Total Received', ur: 'کل موصولہ' },
  totalSpent: { en: 'Total Spent', ur: 'کل خرچ' },
  balanceRemaining: { en: 'Balance remaining in this account', ur: 'اس اکاؤنٹ میں باقی رقم' },
  balanceDeficit: { en: 'Covered by the general fund', ur: 'عمومی فنڈ سے پورا کیا گیا' },
  beneficiaries: { en: 'Beneficiaries', ur: 'مستفید افراد' },
  homes: { en: 'Homes', ur: 'گھر' },
  completedOn: { en: 'Completed', ur: 'مکمل ہوا' },
  viewAudit: { en: 'View Audit', ur: 'آڈٹ دیکھیں' },

  futureVision: { en: 'Future Vision', ur: 'مستقبل کا منصوبہ' },
  votingStage: { en: 'Community Voting Stage', ur: 'کمیونٹی ووٹنگ مرحلہ' },
  upcomingVoting: { en: 'Upcoming / Voting', ur: 'آئندہ / ووٹنگ' },
  requestedBudget: { en: 'Requested Budget', ur: 'مطلوبہ بجٹ' },
  votesWord: { en: 'Votes', ur: 'ووٹ' },
  requiresToAdvance: { en: 'Requires {n} to advance', ur: 'آگے بڑھنے کے لیے {n} درکار' },
  voteTargetNotSet: { en: 'Vote target not set', ur: 'ووٹ کا ہدف مقرر نہیں' },
  viewAndVote: { en: 'View & Vote', ur: 'دیکھیں اور ووٹ دیں' },
  shareToVote: { en: 'Share', ur: 'شیئر کریں' },
  submitSuggestion: { en: 'Submit Suggestion', ur: 'تجویز جمع کرائیں' },

  announcedBadge: { en: 'Announced', ur: 'اعلان شدہ' },
  waitingConfirmation: { en: 'Waiting for the announced payment confirmation', ur: 'اعلان شدہ ادائیگی کی تصدیق کا انتظار' },
  viewDetails: { en: 'View Details', ur: 'تفصیلات دیکھیں' },
}

const CATEGORY_LABEL_UR: Record<string, string> = {
  infrastructure: 'تعمیرات', water: 'پانی', health: 'صحت', education: 'تعلیم',
  environment: 'ماحولیات', welfare: 'بہبود', sports: 'کھیل', training: 'تربیت', other: 'دیگر',
}
const ALL_CATEGORIES = ['infrastructure', 'water', 'health', 'education', 'environment', 'welfare', 'sports', 'training', 'other']

const filters = ['All', 'Ongoing', 'Completed', 'Upcoming', 'Announced']

function fmtFull(val: number | null) {
  return (val ?? 0).toLocaleString()
}

function categoryLabel(category: string | null, isUrdu: boolean) {
  const c = category ?? 'other'
  return isUrdu ? (CATEGORY_LABEL_UR[c] ?? c) : c
}

export interface ProjectsListClientProps {
  projects: Project[]
  voteCounts: Record<string, number>
  commentCounts: Record<string, number>
  receivedByProject: Record<string, number>
  expenseByProject: Record<string, number>
  feeByProject: Record<string, FeeSummary>
  privateTotal: number
  lang: Lang
}

// Real perf fix, 2026-10-01: this used to be the whole page as a 'use
// client' component doing useEffect + 7 sequential/parallel Supabase
// queries on every visit (no cache between navigations, no .limit() on
// the main query) — every sibling public page (/,  /donate, /about,
// /news/[id]) already fetches server-side with `revalidate = 300`
// instead. All the data-fetching moved to the parent Server Component
// (src/app/(public2)/projects/page.tsx); this component only owns what
// actually has to be interactive client state — the status/category
// filter buttons — over data that arrives pre-fetched as props.
//
// Re-skinned onto the card-based redesign's own palette/radius/type scale
// (dp2-* tokens, rounded-2xl cards), 2026-10-12 — this was the one
// remaining page still on the old Material3 dp-* tokens despite already
// sitting inside the new PublicChrome2 header/footer, so its cards read
// as visually disconnected from every other card on the site (Home2's
// Projects carousel included). The two-column photo+content layout itself
// is kept — it's a real content page, not a condensed homepage tile, and
// that layout still earns its keep on desktop — only the color/radius/
// spacing language changes.
export function ProjectsListClient({ projects, voteCounts, commentCounts, receivedByProject, expenseByProject, feeByProject, privateTotal, lang }: ProjectsListClientProps) {
  const [activeFilter, setActiveFilter] = useState('All')
  // A second, independent exclusive filter — status and category each
  // narrow on their own axis and combine (AND), same as any normal
  // category+status facet filter; within each row only one button is
  // ever active at a time, never several ANDed together as booleans.
  const [categoryFilter, setCategoryFilter] = useState('All')
  const site = useSite()
  const dt = (key: keyof typeof t) => t[key][lang].replaceAll('{name}', site.name).replaceAll('{nameUrdu}', site.nameUrdu)
  const isUrdu = lang === 'ur'

  // Engagement score weights votes above comments (a vote is a stronger
  // support signal) — used both to sort within a filter and to mark "Hot".
  const engagementScore = (p: Project) => (voteCounts[p.id] ?? 0) * 2 + (commentCounts[p.id] ?? 0)
  const hotIds = new Set(
    [...projects].sort((a, b) => engagementScore(b) - engagementScore(a)).slice(0, 3)
      .filter((p) => engagementScore(p) > 0).map((p) => p.id)
  )

  const filtered = projects
    .filter((p) => activeFilter === 'All' || p.status === activeFilter.toLowerCase())
    .filter((p) => categoryFilter === 'All' || (p.category ?? 'other') === categoryFilter)
    .slice().sort((a, b) => engagementScore(b) - engagementScore(a))

  // Counts follow the status filter (so "Medical (3)" always matches
  // what clicking it will actually show) but not each other — every
  // category button's own count is computed as if it, not whichever one
  // happens to be active, were selected.
  const categoryCounts: Record<string, number> = { All: 0 }
  for (const p of projects) {
    if (activeFilter !== 'All' && p.status !== activeFilter.toLowerCase()) continue
    categoryCounts.All += 1
    const cat = p.category ?? 'other'
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1
  }
  const presentCategories = ALL_CATEGORIES.filter((c) => (categoryCounts[c] ?? 0) > 0)

  const filterKeys: Record<string, keyof typeof t> = {
    All: 'filterAll', Ongoing: 'filterOngoing', Completed: 'filterCompleted', Upcoming: 'filterUpcoming', Announced: 'filterAnnounced',
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="mb-12">
        <h2 className="font-heading text-[33px] font-bold leading-[41px] text-dp2-primary" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
          {dt('pageTitle')}
        </h2>
        <p className="text-slate-500 font-sans text-[19px] leading-[29px] max-w-2xl mt-2" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
          {dt('pageSubtitle')}
        </p>
      </div>

      {/* Private/medical support — the one aggregate figure for projects
          this page never lists individually. Quiet by design, not a hero
          stat, since the point is discretion, not drawing attention. */}
      {privateTotal > 0 && (
        <div className="flex items-start gap-3 bg-dp2-surface border border-dp2-card-border rounded-2xl px-5 py-4 mb-8 max-w-2xl" dir={isUrdu ? 'rtl' : 'ltr'}>
          <Lock size={17} className="text-slate-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-sans text-[16px] font-bold text-slate-800" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
              {dt('privateTotalLabel')}: {fmtFull(privateTotal)}
            </p>
            <p className="font-sans text-[14px] text-slate-500 mt-0.5 leading-relaxed" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
              {dt('privateTotalNote')}
            </p>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-4 mb-8">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            className={`px-6 py-2 rounded-full font-sans text-[15px] font-semibold tracking-[0.05em] transition-all cursor-pointer ${
              activeFilter === f
                ? 'bg-dp2-primary-dark text-white shadow-sm'
                : 'bg-white border border-dp2-card-border text-slate-500 hover:border-dp2-primary hover:text-dp2-primary'
            }`}
            style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}
          >
            {dt(filterKeys[f])}
          </button>
        ))}
        <div className="ms-auto hidden md:flex items-center gap-2 text-slate-500">
          <span className="font-sans text-[15px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
            {dt('sortByDate')}
          </span>
        </div>
      </div>

      {/* Category filter — its own exclusive row, combines with the status
          filter above rather than replacing it. Counts follow whichever
          status is active, so "Medical (3)" always matches what clicking
          it actually shows. */}
      {presentCategories.length > 1 && (
        <div className="flex flex-wrap items-center gap-2.5 mb-8 -mt-3">
          <button
            onClick={() => setCategoryFilter('All')}
            className={`px-4 py-1.5 rounded-full font-sans text-[14px] font-semibold tracking-[0.03em] transition-all cursor-pointer ${
              categoryFilter === 'All'
                ? 'bg-dp2-primary-dark text-white shadow-sm'
                : 'bg-dp2-surface text-slate-500 hover:bg-dp2-card-border/40'
            }`}
            style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}
          >
            {dt('filterAll')} ({categoryCounts.All ?? 0})
          </button>
          {presentCategories.map((c) => (
            <button
              key={c}
              onClick={() => setCategoryFilter(c)}
              className={`px-4 py-1.5 rounded-full font-sans text-[14px] font-semibold tracking-[0.03em] transition-all cursor-pointer ${
                categoryFilter === c
                  ? 'bg-dp2-primary-dark text-white shadow-sm'
                  : 'bg-dp2-surface text-slate-500 hover:bg-dp2-card-border/40'
              }`}
              style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}
            >
              {categoryLabel(c, isUrdu)} ({categoryCounts[c] ?? 0})
            </button>
          ))}
        </div>
      )}

      {/* Project Cards */}
      <div className="space-y-8">
        {filtered.map((project) => {
          if (project.status === 'ongoing') return <OngoingCard key={project.id} project={project} isHot={hotIds.has(project.id)} commentCount={commentCounts[project.id] ?? 0} expense={expenseByProject[project.id] ?? 0} fee={feeByProject[project.id]} dt={dt} isUrdu={isUrdu} />
          if (project.status === 'completed') return <CompletedCard key={project.id} project={project} isHot={hotIds.has(project.id)} dt={dt} isUrdu={isUrdu} received={receivedByProject[project.id] ?? 0} expense={expenseByProject[project.id] ?? 0} />
          if (project.status === 'upcoming') return <UpcomingCard key={project.id} project={project} voteCount={voteCounts[project.id] ?? 0} isHot={hotIds.has(project.id)} dt={dt} isUrdu={isUrdu} />
          if (project.status === 'announced') return <AnnouncedCard key={project.id} project={project} dt={dt} isUrdu={isUrdu} />
          return null
        })}

        {filtered.length === 0 && (
          <div className="text-center py-16 text-slate-500 font-sans text-[17px]" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
            {dt('noProjects')}
          </div>
        )}
      </div>

      {/* Bottom CTA */}
      <div className="mt-20 text-white p-12 rounded-2xl text-center relative overflow-hidden border border-dp2-gold/20" style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
        <div className="relative z-10">
          <h3 className="font-heading text-[33px] font-bold leading-[41px] mb-4" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
            {dt('ctaTitle')}
          </h3>
          <p className="font-sans text-[19px] leading-[29px] mb-8 max-w-xl mx-auto opacity-90" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
            {dt('ctaBody')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/portal/propose-project"
              className="inline-flex items-center justify-center gap-2 font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-dp2-gold text-slate-900 hover:brightness-95"
              style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}
            >
              {dt('submitProposal')}
            </Link>
            <button
              onClick={() => setActiveFilter('Upcoming')}
              className="inline-flex items-center justify-center gap-2 font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-transparent border-2 border-white text-white hover:bg-white/10"
              style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}
            >
              {dt('browseProposals')}
            </button>
          </div>
        </div>
        <div className="absolute top-[-50px] right-[-50px] w-64 h-64 bg-dp2-gold rounded-full opacity-20 blur-3xl" />
        <div className="absolute bottom-[-50px] left-[-50px] w-64 h-64 bg-white rounded-full opacity-10 blur-3xl" />
      </div>
    </div>
  )
}

type Dt = (key: keyof typeof t) => string

/* ========== ONGOING CARD ========== */
function HotBadge() {
  const { t: tr } = useLocale()
  return (
    <span className="absolute top-2 right-2 z-20 bg-red-500 text-white text-[11px] font-bold uppercase px-2 py-0.5 rounded-full font-sans flex items-center gap-1">
      <Flame size={11} /> {tr('y.hot')}
    </span>
  )
}

const urduStyle = { fontFamily: 'var(--font-urdu-ui)' } as const
const cardShell = 'relative bg-white border border-dp2-card-border rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-2 shadow-[0_4px_8px_rgba(0,0,0,.06)] hover:border-dp2-primary-dark transition-all'

function OngoingCard({ project, isHot, commentCount, expense, fee, dt, isUrdu }: { project: Project; isHot: boolean; commentCount: number; expense: number; fee: FeeSummary | undefined; dt: Dt; isUrdu: boolean }) {
  return (
    <div className={cardShell}>
      {isHot && <HotBadge />}
      {/* Left: Before / Present — except health projects, which get one
          fixed cover image, never a real before/after pair. */}
      {isHealthCategory(project.category) ? (
        <div className="relative aspect-[4/3] md:aspect-auto md:h-full min-h-[240px]">
          <Image src={HEALTH_COVER_IMAGE} alt={displayTitle(project)} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-contain bg-white p-6" />
        </div>
      ) : (
        <div className="relative grid grid-cols-2 gap-[2px] bg-dp2-card-border p-[2px]">
          <div className="relative aspect-[4/3]">
            <div className="absolute top-2 left-2 z-10 bg-black/50 text-white text-[11px] uppercase font-bold px-2 py-0.5 rounded font-sans">
              {dt('before')}
            </div>
            {project.before_image_url ? (
              <Image src={project.before_image_url} alt="Before" fill sizes="(min-width: 768px) 25vw, 50vw" className="object-cover" />
            ) : (
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg,#e5e2d0,#cbd5c9)' }} />
            )}
          </div>
          <div className="relative aspect-[4/3]">
            <div className="absolute top-2 left-2 z-10 bg-dp2-primary-dark text-white text-[11px] uppercase font-bold px-2 py-0.5 rounded font-sans">
              {dt('present')}
            </div>
            {project.after_image_url || project.proposal_image_url ? (
              <Image src={project.after_image_url ?? project.proposal_image_url ?? ''} alt="Present" fill sizes="(min-width: 768px) 25vw, 50vw" className="object-cover" />
            ) : (
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }} />
            )}
          </div>
        </div>
      )}

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="bg-emerald-50 text-dp2-primary-dark px-3 py-1 rounded-full font-sans text-[13px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
                {categoryLabel(project.category, isUrdu)}
              </span>
              {feeBadgeLabel(project, fee, isUrdu) && (
                <span className={`px-3 py-1 rounded-full font-sans text-[13px] font-semibold ${fee?.free ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`} style={isUrdu ? urduStyle : undefined}>
                  {feeBadgeLabel(project, fee, isUrdu)}
                </span>
              )}
            </div>
            <span className="bg-amber-100 text-amber-900 px-3 py-1 rounded-full font-sans text-[13px] font-semibold flex items-center gap-1" style={isUrdu ? urduStyle : undefined}>
              <span className="w-2 h-2 bg-amber-600 rounded-full animate-pulse" />
              {dt('ongoingBadge')}
            </span>
          </div>
          <h3 className="font-sans text-[21px] font-semibold leading-[29px] mb-1 text-dp2-primary">
            {displayTitle(project)}
          </h3>
          <div className="flex items-center text-slate-500 mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[17px]">{isUrdu ? (project.location_ur || project.location) : project.location}</span>
          </div>

          {/* Progress */}
          <div className="mb-6">
            <div className="flex justify-between font-sans text-[15px] font-semibold tracking-[0.05em] mb-2 text-slate-800" style={isUrdu ? urduStyle : undefined}>
              <span>{dt('completionLabel')}</span>
              <span>{project.progress_percent}%</span>
            </div>
            <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-dp2-gold transition-all duration-1000"
                style={{ width: `${project.progress_percent}%` }}
              />
            </div>
          </div>

          {/* Budget */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="p-3 bg-dp2-surface border border-dp2-card-border rounded-xl">
              <p className="text-slate-500 text-[13px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('budgetLabel')}
              </p>
              <p className="text-[21px] font-bold text-dp2-primary font-sans leading-[29px]">
                {fmtFull(project.budget_pkr)}{' '}
                <span className="text-[15px] font-normal">PKR</span>
              </p>
            </div>
            <div className="p-3 bg-dp2-surface border border-dp2-card-border rounded-xl">
              <p className="text-slate-500 text-[13px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('spentLabel')}
              </p>
              <p className="text-[21px] font-bold text-dp2-primary-dark font-sans leading-[29px]">
                {fmtFull(expense)}{' '}
                <span className="text-[15px] font-normal">PKR</span>
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {commentCount > 0 ? (
              <Link href={`/projects/${project.id}`} className="flex items-center gap-1.5 text-slate-500 font-sans text-[14px] hover:text-dp2-primary-dark transition-colors">
                <MessageSquare size={15} /> {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
              </Link>
            ) : <span />}
            <ProjectShareCard projectId={project.id} title={displayTitle(project)} imageUrl={shareImage(project)} isUrdu={isUrdu} />
          </div>
          <div className="flex gap-2">
            <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
              <Link href={`/projects/${project.id}`} className="flex items-center gap-1.5 px-4 py-2 border-2 border-dp2-primary text-dp2-primary font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl hover:bg-dp2-primary hover:text-white transition-colors" style={isUrdu ? urduStyle : undefined}>
                <Eye size={15} /> {dt('detailsBtn')}
              </Link>
            </motion.div>
            <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
              <Link
                href={`/projects/${project.id}`}
                className="flex items-center gap-1.5 px-4 py-2 bg-dp2-primary-dark text-white font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl shadow-sm hover:shadow-md hover:brightness-110 transition-all"
                style={isUrdu ? urduStyle : undefined}
              >
                <HandHeart size={15} /> {dt('donateBtn')}
              </Link>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ========== COMPLETED CARD ========== */
function CompletedCard({ project, isHot, dt, isUrdu, received, expense }: { project: Project; isHot: boolean; dt: Dt; isUrdu: boolean; received: number; expense: number }) {
  // A completed project's real final numbers, not the original budget
  // estimate — a leftover balance (received > expense) is money still
  // sitting in this project's account, not yet moved anywhere; a deficit
  // (expense > received) was covered by the general pool. Both shown
  // as-is for now — reconciling either via a real project-transfer is a
  // separate, deliberate accounting action, not something this card
  // decides on its own.
  const remaining = received - expense
  return (
    <div className={cardShell}>
      {isHot && <HotBadge />}
      {/* Left: Photo */}
      <div className="relative h-full min-h-[300px]">
        <div className="absolute top-4 left-4 z-10 bg-dp2-primary-dark text-white text-[11px] uppercase font-bold px-3 py-1 rounded-full font-sans">
          {dt('successStory')}
        </div>
        {isHealthCategory(project.category) ? (
          <Image src={HEALTH_COVER_IMAGE} alt={displayTitle(project)} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-contain bg-white p-6" />
        ) : project.cover_photo_url || project.after_image_url || project.proposal_image_url ? (
          <Image src={project.cover_photo_url ?? project.after_image_url ?? project.proposal_image_url ?? ''} alt={displayTitle(project)} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
        ) : (
          <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }} />
        )}
      </div>

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-emerald-50 text-dp2-primary-dark px-3 py-1 rounded-full font-sans text-[13px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
              {categoryLabel(project.category, isUrdu)}
            </span>
            <span className="bg-dp2-primary-dark text-white px-3 py-1 rounded-full font-sans text-[13px] font-semibold flex items-center gap-1" style={isUrdu ? urduStyle : undefined}>
              <CheckCircle size={14} />
              {dt('completedBadge')}
            </span>
          </div>
          <h3 className="font-sans text-[21px] font-semibold leading-[29px] mb-1 text-dp2-primary">
            {displayTitle(project)}
          </h3>
          <div className="flex items-center text-slate-500 mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[17px]">{isUrdu ? (project.location_ur || project.location) : project.location}</span>
          </div>

          {/* Progress */}
          <div className="mb-6">
            <div className="flex justify-between font-sans text-[15px] font-semibold tracking-[0.05em] mb-2 text-dp2-primary-dark" style={isUrdu ? urduStyle : undefined}>
              <span>{dt('operationalStatus')}</span>
              <span>{dt('fullyFunctional')}</span>
            </div>
            <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-dp2-primary-dark w-full" />
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="p-3 border border-dp2-card-border rounded-xl">
              <p className="text-slate-500 text-[12px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('totalReceived')}
              </p>
              <p className={`text-[17px] font-bold text-slate-800 font-sans ${isUrdu ? 'leading-[29px]' : 'leading-[23px]'}`}>
                {fmtFull(received)}
              </p>
            </div>
            <div className="p-3 border border-dp2-card-border rounded-xl">
              <p className="text-slate-500 text-[12px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('totalSpent')}
              </p>
              <p className={`text-[17px] font-bold text-slate-800 font-sans ${isUrdu ? 'leading-[29px]' : 'leading-[23px]'}`}>
                {fmtFull(expense)}
              </p>
            </div>
            <div className="p-3 border border-dp2-card-border rounded-xl">
              <p className="text-slate-500 text-[12px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('beneficiaries')}
              </p>
              <p className={`text-[17px] font-bold text-slate-800 font-sans ${isUrdu ? 'leading-[29px]' : 'leading-[23px]'}`}>
                {project.beneficiaries_count ?? 0}+{' '}
                <span className="text-[13px] font-normal" style={isUrdu ? urduStyle : undefined}>{dt('homes')}</span>
              </p>
            </div>
          </div>
          <div className="mb-6">
            {remaining !== 0 && (
              <p className={`font-sans text-[14px] font-semibold ${remaining > 0 ? 'text-dp2-primary-dark' : 'text-red-600'}`} style={isUrdu ? urduStyle : undefined}>
                {remaining > 0 ? dt('balanceRemaining') : dt('balanceDeficit')}: {fmtFull(Math.abs(remaining))}
              </p>
            )}
          </div>
        </div>

        {/* Bottom */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {project.end_date ? (
              <p className="text-slate-500 font-sans text-[15px] border-s-4 border-dp2-gold ps-3" style={isUrdu ? urduStyle : undefined}>
                {dt('completedOn')} {new Date(project.end_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>
            ) : <span />}
            <ProjectShareCard projectId={project.id} title={displayTitle(project)} imageUrl={shareImage(project)} isUrdu={isUrdu} />
          </div>
          <div className="flex items-center gap-2">
            {/* A one-time build is done once it's completed — but a
                recurring_support project (a salary, a monthly running
                cost) still needs donors regardless of the build's own
                status, so it keeps its Donate link even here. */}
            {project.funding_model === 'recurring_support' && (
              <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
                <Link href={`/projects/${project.id}`} className="flex items-center gap-1.5 px-4 py-2 bg-dp2-primary-dark text-white font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl shadow-sm hover:brightness-110 transition-all">
                  <HandHeart size={15} /> {dt('donateBtn')}
                </Link>
              </motion.div>
            )}
            <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
              <Link href={`/projects/${project.id}`} className="flex items-center gap-1.5 px-6 py-2 bg-dp2-surface text-slate-800 font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl shadow-sm hover:bg-dp2-card-border/50 hover:shadow-md transition-all" style={isUrdu ? urduStyle : undefined}>
                <Eye size={15} /> {dt('viewAudit')}
              </Link>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ========== UPCOMING CARD ========== */
function UpcomingCard({ project, voteCount, isHot, dt, isUrdu }: { project: Project; voteCount: number; isHot: boolean; dt: Dt; isUrdu: boolean }) {
  return (
    <div className="relative bg-white border-2 border-dashed border-dp2-gold/40 rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-2 shadow-[0_4px_8px_rgba(0,0,0,.06)]">
      {isHot && <HotBadge />}
      {/* Left: Photo when the proposer submitted one, else the illustration */}
      <div className="relative bg-dp2-surface flex items-center justify-center min-h-[300px]">
        {isHealthCategory(project.category) ? (
          <Image src={HEALTH_COVER_IMAGE} alt={displayTitle(project)} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-contain bg-white p-6" />
        ) : project.proposal_image_url ? (
          <Image src={project.proposal_image_url} alt={displayTitle(project)} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
        ) : (
          <div className="text-center p-8">
            <Vote size={64} className="text-dp2-primary-dark mb-4 mx-auto" />
            <h4 className="font-heading text-[25px] font-bold leading-[33px] text-dp2-primary mb-2" style={isUrdu ? urduStyle : undefined}>
              {dt('futureVision')}
            </h4>
            <p className="text-dp2-primary-dark font-sans text-[17px]" style={isUrdu ? urduStyle : undefined}>{dt('votingStage')}</p>
          </div>
        )}
        <div
          className={`absolute inset-0 ${project.proposal_image_url ? 'hidden' : 'opacity-10'}`}
          style={{
            backgroundImage: 'radial-gradient(#005A36 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        />
      </div>

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-dp2-primary-dark text-white px-3 py-1 rounded-full font-sans text-[13px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
              {categoryLabel(project.category, isUrdu)}
            </span>
            <span className="bg-dp2-surface text-dp2-primary-dark px-3 py-1 rounded-full font-sans text-[13px] font-semibold flex items-center gap-1" style={isUrdu ? urduStyle : undefined}>
              <Vote size={14} />
              {dt('upcomingVoting')}
            </span>
          </div>
          <h3 className="font-sans text-[21px] font-semibold leading-[29px] mb-1 text-dp2-primary">
            {displayTitle(project)}
          </h3>
          <div className="flex items-center text-slate-500 mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[17px]">{isUrdu ? (project.location_ur || project.location) : project.location}</span>
          </div>
          <p className={`text-slate-500 mb-4 line-clamp-3 font-sans text-[17px] ${isUrdu ? 'leading-[27px]' : 'leading-[25px]'}`}>
            {project.description}
          </p>

          {/* Budget — compulsory info before voting, not just votes */}
          <div className="flex items-center justify-between mb-4 px-1">
            <span className="font-sans text-[14px] font-semibold text-slate-500 uppercase tracking-wide" style={isUrdu ? urduStyle : undefined}>{dt('requestedBudget')}</span>
            <span className="font-heading text-[21px] font-bold text-dp2-primary">{fmtFull(project.budget_pkr)}</span>
          </div>

          {/* Vote Box */}
          <div className="bg-dp2-surface p-4 rounded-xl border border-dp2-card-border flex items-center justify-between mb-6">
            <div>
              <p className="text-dp2-primary font-bold text-[21px] font-sans leading-[29px]">
                {voteCount} {dt('votesWord')}
              </p>
              <p className="text-dp2-primary-dark text-[15px] font-sans font-semibold tracking-[0.05em]" style={isUrdu ? urduStyle : undefined}>
                {project.vote_target ? dt('requiresToAdvance').replace('{n}', String(project.vote_target)) : dt('voteTargetNotSet')}
              </p>
            </div>
            <div className="h-2 w-24 bg-dp2-card-border rounded-full overflow-hidden">
              <div className="h-full bg-dp2-primary-dark" style={{ width: `${project.vote_target ? Math.min(100, (voteCount / project.vote_target) * 100) : 0}%` }} />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2.5">
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} className="flex-1">
            <Link
              href={`/projects/${project.id}`}
              className="w-full py-3 bg-dp2-primary-dark text-white font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl shadow-sm hover:shadow-md hover:brightness-110 transition-all flex items-center justify-center gap-2"
              style={isUrdu ? urduStyle : undefined}
            >
              <ThumbsUp size={16} />
              {dt('viewAndVote')}
            </Link>
          </motion.div>
          <motion.div whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }}>
            <ProjectShareCard
              projectId={project.id} title={displayTitle(project)} imageUrl={shareImage(project)}
              isVotingOpen isUrdu={isUrdu}
              className="flex items-center justify-center px-4 py-3 border-2 border-dp2-primary-dark text-dp2-primary-dark rounded-xl hover:bg-dp2-surface transition-colors cursor-pointer h-full"
            />
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Link
              href="/suggestions"
              className="h-full px-5 py-3 border-2 border-dp2-primary-dark text-dp2-primary-dark font-sans text-[14.5px] font-semibold tracking-[0.03em] rounded-xl hover:bg-dp2-surface transition-colors text-center flex items-center justify-center"
              style={isUrdu ? urduStyle : undefined}
            >
              {dt('submitSuggestion')}
            </Link>
          </motion.div>
        </div>
      </div>
    </div>
  )
}

/* ========== ANNOUNCED CARD ========== */
// A freshly-posted proposal, paused until the proposer's own self-commitment
// is paid and staff-confirmed (migration 141) — greyed out on purpose, no
// vote/donate actions yet, just the "waiting" label from the detail page.
function AnnouncedCard({ project, dt, isUrdu }: { project: Project; dt: Dt; isUrdu: boolean }) {
  return (
    <div className="relative bg-dp2-surface border-2 border-dashed border-dp2-card-border rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-2 opacity-90">
      <div className="relative bg-slate-100 flex items-center justify-center min-h-[220px] md:min-h-[300px]">
        {project.proposal_image_url && (
          <Image src={project.proposal_image_url} alt={displayTitle(project)} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover grayscale opacity-40" />
        )}
        <div className="relative text-center p-8">
          <Lock size={56} className="text-slate-400 mb-4 mx-auto" />
          <p className="text-slate-500 font-sans text-[16px] font-semibold" style={isUrdu ? urduStyle : undefined}>{dt('waitingConfirmation')}</p>
        </div>
      </div>
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-slate-300 text-slate-700 px-3 py-1 rounded-full font-sans text-[13px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
              {categoryLabel(project.category, isUrdu)}
            </span>
            <span className="bg-slate-200 text-slate-600 px-3 py-1 rounded-full font-sans text-[13px] font-semibold" style={isUrdu ? urduStyle : undefined}>
              {dt('announcedBadge')}
            </span>
          </div>
          <h3 className="font-sans text-[21px] font-semibold leading-[29px] mb-1 text-slate-500">
            {displayTitle(project)}
          </h3>
          <div className="flex items-center text-slate-500 mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[17px]">{isUrdu ? (project.location_ur || project.location) : project.location}</span>
          </div>
          <p className={`text-slate-500 line-clamp-3 font-sans text-[17px] mb-4 ${isUrdu ? 'leading-[27px]' : 'leading-[25px]'}`}>
            {project.description}
          </p>
          <div className="flex items-center justify-between px-1">
            <span className="font-sans text-[14px] font-semibold text-slate-500 uppercase tracking-wide" style={isUrdu ? urduStyle : undefined}>{dt('requestedBudget')}</span>
            <span className="font-heading text-[19px] font-bold text-slate-500">{fmtFull(project.budget_pkr)}</span>
          </div>
        </div>
        <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
          <Link
            href={`/projects/${project.id}`}
            className="mt-6 py-3 border-2 border-dp2-card-border text-slate-500 font-sans text-[15px] font-semibold tracking-[0.05em] rounded-xl hover:border-dp2-primary hover:text-dp2-primary transition-colors flex items-center justify-center gap-2"
            style={isUrdu ? urduStyle : undefined}
          >
            <Eye size={15} /> {dt('viewDetails')}
          </Link>
        </motion.div>
      </div>
    </div>
  )
}
