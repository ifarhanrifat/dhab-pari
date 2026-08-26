'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
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
  Share2,
  Eye,
  HandHeart,
} from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Project {
  id: string
  title: string
  title_ur: string | null
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
  sector: string | null
  beneficiaries_count: number | null
  vote_target: number | null
  before_image_url: string | null
  after_image_url: string | null
  proposal_image_url: string | null
}

type Lang = 'en' | 'ur'

// Same site-wide "Accounts Display Language" toggle every other bilingual
// page here already respects (site_settings.display_language).
const t: Record<string, { en: string; ur: string }> = {
  pageTitle: { en: 'Village Welfare Projects', ur: 'گاؤں کی فلاحی منصوبے' },
  pageSubtitle: { en: `Tracking the growth of ${SITE.name} through community-funded infrastructure, healthcare, and educational initiatives.`, ur: `کمیونٹی کی مالی معاونت سے تعمیرات، صحت اور تعلیمی اقدامات کے ذریعے ${SITE.nameUrdu} کی ترقی کا سفر۔` },
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
  ctaBody: { en: `Every great transformation starts with a simple suggestion. Share your vision for ${SITE.name}'s future infrastructure or welfare projects.`, ur: `ہر بڑی تبدیلی ایک سادہ تجویز سے شروع ہوتی ہے۔ ${SITE.nameUrdu} کے مستقبل کے تعمیراتی یا فلاحی منصوبوں کے لیے اپنا خیال پیش کریں۔` },
  submitProposal: { en: 'Submit Proposal', ur: 'تجویز جمع کرائیں' },
  browseProposals: { en: 'Browse Proposals', ur: 'تجاویز دیکھیں' },

  before: { en: 'Before', ur: 'پہلے' },
  present: { en: 'Present', ur: 'اب' },
  ongoingBadge: { en: 'Ongoing', ur: 'جاری' },
  completionLabel: { en: 'Project Completion', ur: 'منصوبے کی تکمیل' },
  budgetLabel: { en: 'Budget', ur: 'بجٹ' },
  spentLabel: { en: 'Spent', ur: 'خرچ شدہ' },
  detailsBtn: { en: 'Details', ur: 'تفصیلات' },
  donateBtn: { en: 'Donate', ur: 'عطیہ دیں' },

  successStory: { en: 'Success Story', ur: 'کامیابی کی کہانی' },
  completedBadge: { en: 'Completed', ur: 'مکمل' },
  operationalStatus: { en: 'Operational Status', ur: 'آپریشنل حیثیت' },
  fullyFunctional: { en: '100% Fully Functional', ur: '100% مکمل طور پر فعال' },
  totalCost: { en: 'Total Cost', ur: 'کل لاگت' },
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
  environment: 'ماحولیات', welfare: 'بہبود', sports: 'کھیل', other: 'دیگر',
}

const filters = ['All', 'Ongoing', 'Completed', 'Upcoming', 'Announced']

function formatPKR(val: number | null) {
  if (!val) return '0'
  if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`
  if (val >= 1000) return `${Math.round(val / 1000)}k`
  return val.toLocaleString()
}

function fmtFull(val: number | null) {
  return (val ?? 0).toLocaleString()
}

function categoryLabel(category: string | null, isUrdu: boolean) {
  const c = category ?? 'other'
  return isUrdu ? (CATEGORY_LABEL_UR[c] ?? c) : c
}

export default function ProjectsPage() {
  const { t: tr } = useLocale()
  const [projects, setProjects] = useState<Project[]>([])
  const [voteCounts, setVoteCounts] = useState<Record<string, number>>({})
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  const [activeFilter, setActiveFilter] = useState('All')
  const [loading, setLoading] = useState(true)
  const [lang, setLang] = useState<Lang>('en')
  // Private/medical projects never appear individually anywhere on this
  // page (RLS blocks the rows themselves) — this is the one honest number
  // the public IS told, naming no one and no specific case.
  const [privateTotal, setPrivateTotal] = useState(0)
  const dt = (key: keyof typeof t) => t[key][lang]
  const isUrdu = lang === 'ur'

  useEffect(() => {
    const supabase = createClient()
    supabase.from('site_settings').select('value').eq('key', 'display_language').maybeSingle().then(({ data }) => {
      if (data?.value === 'ur') setLang('ur')
    })
    supabase.rpc('public_private_projects_total').then(({ data }) => setPrivateTotal(Number(data ?? 0)))
    supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false })
      .then(async ({ data }) => {
        setProjects(data ?? [])
        setLoading(false)
        const allIds = (data ?? []).map((p) => p.id)
        if (allIds.length > 0) {
          const [{ data: voteRows }, { data: commentRows }] = await Promise.all([
            supabase.from('project_votes_public').select('project_id').in('project_id', allIds),
            supabase.from('project_comments_public').select('project_id').in('project_id', allIds),
          ])
          const vCounts: Record<string, number> = {}
          for (const v of voteRows ?? []) vCounts[v.project_id] = (vCounts[v.project_id] ?? 0) + 1
          setVoteCounts(vCounts)
          const cCounts: Record<string, number> = {}
          for (const c of commentRows ?? []) cCounts[c.project_id] = (cCounts[c.project_id] ?? 0) + 1
          setCommentCounts(cCounts)
        }
      })
  }, [])

  // Engagement score weights votes above comments (a vote is a stronger
  // support signal) — used both to sort within a filter and to mark "Hot".
  const engagementScore = (p: Project) => (voteCounts[p.id] ?? 0) * 2 + (commentCounts[p.id] ?? 0)
  const hotIds = new Set(
    [...projects].sort((a, b) => engagementScore(b) - engagementScore(a)).slice(0, 3)
      .filter((p) => engagementScore(p) > 0).map((p) => p.id)
  )

  const filtered = (
    activeFilter === 'All'
      ? projects
      : projects.filter((p) => p.status === activeFilter.toLowerCase())
  ).slice().sort((a, b) => engagementScore(b) - engagementScore(a))

  const filterKeys: Record<string, keyof typeof t> = {
    All: 'filterAll', Ongoing: 'filterOngoing', Completed: 'filterCompleted', Upcoming: 'filterUpcoming', Announced: 'filterAnnounced',
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="mb-12">
        <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
          {dt('pageTitle')}
        </h2>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px] max-w-2xl mt-2" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
          {dt('pageSubtitle')}
        </p>
      </div>

      {/* Private/medical support — the one aggregate figure for projects
          this page never lists individually. Quiet by design, not a hero
          stat, since the point is discretion, not drawing attention. */}
      {privateTotal > 0 && (
        <div className="flex items-start gap-3 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-5 py-4 mb-8 max-w-2xl" dir={isUrdu ? 'rtl' : 'ltr'}>
          <Lock size={17} className="text-dp-on-surface-variant shrink-0 mt-0.5" />
          <div>
            <p className="font-sans text-[15px] font-bold text-dp-on-surface" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
              {dt('privateTotalLabel')}: Rs. {fmtFull(privateTotal)}
            </p>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5 leading-relaxed" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
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
            className={`px-6 py-2 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em] transition-all cursor-pointer ${
              activeFilter === f
                ? 'bg-dp-primary text-white shadow-sm'
                : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary hover:text-dp-primary'
            }`}
            style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
          >
            {dt(filterKeys[f])}
          </button>
        ))}
        <div className="ms-auto hidden md:flex items-center gap-2 text-dp-on-surface-variant">
          <span className="font-sans text-[14px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
            {dt('sortByDate')}
          </span>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-8">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white border border-dp-outline-variant rounded-lg h-[300px] animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Project Cards */}
      {!loading && (
        <div className="space-y-8">
          {filtered.map((project) => {
            if (project.status === 'ongoing') return <OngoingCard key={project.id} project={project} isHot={hotIds.has(project.id)} commentCount={commentCounts[project.id] ?? 0} dt={dt} isUrdu={isUrdu} />
            if (project.status === 'completed') return <CompletedCard key={project.id} project={project} isHot={hotIds.has(project.id)} dt={dt} isUrdu={isUrdu} />
            if (project.status === 'upcoming') return <UpcomingCard key={project.id} project={project} voteCount={voteCounts[project.id] ?? 0} isHot={hotIds.has(project.id)} dt={dt} isUrdu={isUrdu} />
            if (project.status === 'announced') return <AnnouncedCard key={project.id} project={project} dt={dt} isUrdu={isUrdu} />
            return null
          })}

          {filtered.length === 0 && !loading && (
            <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
              {dt('noProjects')}
            </div>
          )}
        </div>
      )}

      {/* Bottom CTA */}
      <div className="mt-20 bg-dp-primary-container text-white p-12 rounded-2xl text-center relative overflow-hidden">
        <div className="relative z-10">
          <h3 className="font-heading text-[32px] font-bold leading-[40px] mb-4" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
            {dt('ctaTitle')}
          </h3>
          <p className="font-sans text-[18px] leading-[28px] mb-8 max-w-xl mx-auto opacity-90" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
            {dt('ctaBody')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/portal/propose-project"
              className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-dp-secondary text-white hover:bg-dp-primary"
              style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
            >
              {dt('submitProposal')}
            </Link>
            <button
              onClick={() => setActiveFilter('Upcoming')}
              className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-transparent border-2 border-white text-white hover:bg-white/10"
              style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
            >
              {dt('browseProposals')}
            </button>
          </div>
        </div>
        <div className="absolute top-[-50px] right-[-50px] w-64 h-64 bg-dp-primary rounded-full opacity-20 blur-3xl" />
        <div className="absolute bottom-[-50px] left-[-50px] w-64 h-64 bg-dp-secondary rounded-full opacity-10 blur-3xl" />
      </div>
    </div>
  )
}

type Dt = (key: keyof typeof t) => string

/* ========== ONGOING CARD ========== */
function HotBadge() {
  const { t: tr } = useLocale()
  return (
    <span className="absolute top-2 right-2 z-20 bg-red-500 text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-full font-sans flex items-center gap-1">
      <Flame size={11} /> {tr('y.hot')}
    </span>
  )
}

const urduStyle = { fontFamily: 'var(--font-urdu), serif' } as const

function OngoingCard({ project, isHot, commentCount, dt, isUrdu }: { project: Project; isHot: boolean; commentCount: number; dt: Dt; isUrdu: boolean }) {
  const { t: tr } = useLocale()
  return (
    <div className="relative bg-white border border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 hover:border-dp-secondary transition-all">
      {isHot && <HotBadge />}
      {/* Left: Before / Present */}
      <div className="relative grid grid-cols-2 gap-[2px] bg-dp-outline-variant p-[2px]">
        <div className="relative aspect-[4/3]">
          <div className="absolute top-2 left-2 z-10 bg-black/50 text-white text-[10px] uppercase font-bold px-2 py-0.5 rounded font-sans">
            {dt('before')}
          </div>
          {project.before_image_url ? (
            <Image src={project.before_image_url} alt="Before" fill sizes="(min-width: 768px) 25vw, 50vw" className="object-cover" />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-dp-surface-container-high to-dp-surface-dim" />
          )}
        </div>
        <div className="relative aspect-[4/3]">
          <div className="absolute top-2 left-2 z-10 bg-dp-primary text-white text-[10px] uppercase font-bold px-2 py-0.5 rounded font-sans">
            {dt('present')}
          </div>
          {project.after_image_url || project.proposal_image_url ? (
            <Image src={project.after_image_url ?? project.proposal_image_url ?? ''} alt="Present" fill sizes="(min-width: 768px) 25vw, 50vw" className="object-cover" />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container" />
          )}
        </div>
      </div>

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-dp-primary-container text-dp-on-primary-container px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
              {categoryLabel(project.category, isUrdu)}
            </span>
            <span className="bg-amber-100 text-amber-900 px-3 py-1 rounded-full font-sans text-[12px] font-semibold flex items-center gap-1" style={isUrdu ? urduStyle : undefined}>
              <span className="w-2 h-2 bg-amber-600 rounded-full animate-pulse" />
              {dt('ongoingBadge')}
            </span>
          </div>
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-1 text-dp-on-surface">
            {project.title}
          </h3>
          <div className="flex items-center text-dp-on-surface-variant mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[16px]">{project.location}</span>
          </div>

          {/* Progress */}
          <div className="mb-6">
            <div className="flex justify-between font-sans text-[14px] font-semibold tracking-[0.05em] mb-2 text-dp-on-surface" style={isUrdu ? urduStyle : undefined}>
              <span>{dt('completionLabel')}</span>
              <span>{project.progress_percent}%</span>
            </div>
            <div className="h-3 w-full bg-dp-surface-container-highest rounded-full overflow-hidden">
              <div
                className="h-full bg-dp-secondary transition-all duration-1000"
                style={{ width: `${project.progress_percent}%` }}
              />
            </div>
          </div>

          {/* Budget */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="p-3 bg-dp-surface-container-low rounded-lg">
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('budgetLabel')}
              </p>
              <p className="text-[20px] font-bold text-dp-primary font-sans leading-[28px]">
                {formatPKR(project.budget_pkr)}{' '}
                <span className="text-[14px] font-normal">PKR</span>
              </p>
            </div>
            <div className="p-3 bg-dp-surface-container-low rounded-lg">
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('spentLabel')}
              </p>
              <p className="text-[20px] font-bold text-dp-secondary font-sans leading-[28px]">
                {formatPKR(project.spent_pkr)}{' '}
                <span className="text-[14px] font-normal">PKR</span>
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between">
          {commentCount > 0 ? (
            <Link href={`/projects/${project.id}`} className="flex items-center gap-1.5 text-dp-on-surface-variant font-sans text-[13px] hover:text-dp-secondary transition-colors">
              <MessageSquare size={15} /> {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
            </Link>
          ) : <span />}
          <div className="flex gap-2">
            <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
              <Link href={`/projects/${project.id}`} className="flex items-center gap-1.5 px-4 py-2 border-2 border-dp-primary text-dp-primary font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-dp-primary hover:text-white transition-colors" style={isUrdu ? urduStyle : undefined}>
                <Eye size={15} /> {dt('detailsBtn')}
              </Link>
            </motion.div>
            <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
              <Link
                href={`/projects/${project.id}`}
                className="flex items-center gap-1.5 px-4 py-2 bg-dp-primary text-white font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg shadow-sm hover:shadow-md hover:bg-dp-primary-container transition-all"
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
function CompletedCard({ project, isHot, dt, isUrdu }: { project: Project; isHot: boolean; dt: Dt; isUrdu: boolean }) {
  const { t: tr } = useLocale()
  return (
    <div className="relative bg-white border border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 hover:border-dp-secondary transition-all">
      {isHot && <HotBadge />}
      {/* Left: Photo */}
      <div className="relative h-full min-h-[300px]">
        <div className="absolute top-4 left-4 z-10 bg-dp-primary text-white text-[10px] uppercase font-bold px-3 py-1 rounded font-sans">
          {dt('successStory')}
        </div>
        {project.after_image_url || project.proposal_image_url ? (
          <Image src={project.after_image_url ?? project.proposal_image_url ?? ''} alt={project.title} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-dp-secondary to-dp-primary-container" />
        )}
      </div>

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-dp-primary-container text-dp-on-primary-container px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
              {categoryLabel(project.category, isUrdu)}
            </span>
            <span className="bg-dp-primary text-white px-3 py-1 rounded-full font-sans text-[12px] font-semibold flex items-center gap-1" style={isUrdu ? urduStyle : undefined}>
              <CheckCircle size={14} />
              {dt('completedBadge')}
            </span>
          </div>
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-1 text-dp-on-surface">
            {project.title}
          </h3>
          <div className="flex items-center text-dp-on-surface-variant mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[16px]">{project.location}</span>
          </div>

          {/* Progress */}
          <div className="mb-6">
            <div className="flex justify-between font-sans text-[14px] font-semibold tracking-[0.05em] mb-2 text-dp-primary font-bold" style={isUrdu ? urduStyle : undefined}>
              <span>{dt('operationalStatus')}</span>
              <span>{dt('fullyFunctional')}</span>
            </div>
            <div className="h-3 w-full bg-dp-surface-container-highest rounded-full overflow-hidden">
              <div className="h-full bg-dp-primary w-full" />
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="p-3 border border-dp-outline-variant rounded-lg">
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('totalCost')}
              </p>
              <p className="text-[20px] font-bold text-dp-on-surface font-sans leading-[28px]">
                {formatPKR(project.budget_pkr)}{' '}
                <span className="text-[14px] font-normal">PKR</span>
              </p>
            </div>
            <div className="p-3 border border-dp-outline-variant rounded-lg">
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans" style={isUrdu ? urduStyle : undefined}>
                {dt('beneficiaries')}
              </p>
              <p className="text-[20px] font-bold text-dp-on-surface font-sans leading-[28px]">
                {project.beneficiaries_count ?? 0}+{' '}
                <span className="text-[14px] font-normal" style={isUrdu ? urduStyle : undefined}>{dt('homes')}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Bottom */}
        <div className="flex items-center justify-between">
          {project.end_date ? (
            <p className="text-dp-on-surface-variant font-sans text-[14px] border-s-4 border-dp-secondary-fixed ps-3" style={isUrdu ? urduStyle : undefined}>
              {dt('completedOn')} {new Date(project.end_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          ) : <span />}
          <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
            <Link href={`/projects/${project.id}`} className="flex items-center gap-1.5 px-6 py-2 bg-dp-surface-container-highest text-dp-on-surface font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg shadow-sm hover:bg-dp-outline-variant hover:shadow-md transition-all" style={isUrdu ? urduStyle : undefined}>
              <Eye size={15} /> {dt('viewAudit')}
            </Link>
          </motion.div>
        </div>
      </div>
    </div>
  )
}

/* ========== UPCOMING CARD ========== */
function UpcomingCard({ project, voteCount, isHot, dt, isUrdu }: { project: Project; voteCount: number; isHot: boolean; dt: Dt; isUrdu: boolean }) {
  const { t: tr } = useLocale()
  const share = async () => {
    const url = typeof window !== 'undefined' ? `${window.location.origin}/projects/${project.id}` : ''
    const text = `${project.title} — ${url}`
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: project.title, text, url }); return } catch { return }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank')
  }

  return (
    <div className="relative bg-white border-2 border-dashed border-blue-200 rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 shadow-sm">
      {isHot && <HotBadge />}
      {/* Left: Photo when the proposer submitted one, else the illustration */}
      <div className="relative bg-blue-50 flex items-center justify-center min-h-[300px]">
        {project.proposal_image_url ? (
          <Image src={project.proposal_image_url} alt={project.title} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
        ) : (
          <div className="text-center p-8">
            <Vote size={64} className="text-blue-500 mb-4 mx-auto" />
            <h4 className="font-heading text-[24px] font-bold leading-[32px] text-blue-900 mb-2" style={isUrdu ? urduStyle : undefined}>
              {dt('futureVision')}
            </h4>
            <p className="text-blue-700 font-sans text-[16px]" style={isUrdu ? urduStyle : undefined}>{dt('votingStage')}</p>
          </div>
        )}
        <div
          className={`absolute inset-0 ${project.proposal_image_url ? 'hidden' : 'opacity-10'}`}
          style={{
            backgroundImage: 'radial-gradient(#2563eb 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        />
      </div>

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-blue-600 text-white px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
              {categoryLabel(project.category, isUrdu)}
            </span>
            <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full font-sans text-[12px] font-semibold flex items-center gap-1" style={isUrdu ? urduStyle : undefined}>
              <Vote size={14} />
              {dt('upcomingVoting')}
            </span>
          </div>
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-1 text-dp-on-surface">
            {project.title}
          </h3>
          <div className="flex items-center text-dp-on-surface-variant mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[16px]">{project.location}</span>
          </div>
          <p className="text-dp-on-surface-variant mb-4 line-clamp-3 font-sans text-[16px] leading-[24px]">
            {project.description}
          </p>

          {/* Budget — compulsory info before voting, not just votes */}
          <div className="flex items-center justify-between mb-4 px-1">
            <span className="font-sans text-[13px] font-semibold text-dp-on-surface-variant uppercase tracking-wide" style={isUrdu ? urduStyle : undefined}>{dt('requestedBudget')}</span>
            <span className="font-heading text-[20px] font-bold text-blue-900">Rs. {fmtFull(project.budget_pkr)}</span>
          </div>

          {/* Vote Box */}
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 flex items-center justify-between mb-6">
            <div>
              <p className="text-blue-900 font-bold text-[20px] font-sans leading-[28px]">
                {voteCount} {dt('votesWord')}
              </p>
              <p className="text-blue-700 text-[14px] font-sans font-semibold tracking-[0.05em]" style={isUrdu ? urduStyle : undefined}>
                {project.vote_target ? dt('requiresToAdvance').replace('{n}', String(project.vote_target)) : dt('voteTargetNotSet')}
              </p>
            </div>
            <div className="h-2 w-24 bg-blue-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600" style={{ width: `${project.vote_target ? Math.min(100, (voteCount / project.vote_target) * 100) : 0}%` }} />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2.5">
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} className="flex-1">
            <Link
              href={`/projects/${project.id}`}
              className="w-full py-3 bg-blue-600 text-white font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg shadow-sm hover:shadow-md hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
              style={isUrdu ? urduStyle : undefined}
            >
              <ThumbsUp size={16} />
              {dt('viewAndVote')}
            </Link>
          </motion.div>
          <motion.button
            whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }}
            onClick={share}
            title={dt('shareToVote')}
            className="px-4 py-3 border-2 border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors cursor-pointer"
          >
            <Share2 size={16} />
          </motion.button>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Link
              href="/suggestions"
              className="h-full px-5 py-3 border-2 border-blue-600 text-blue-600 font-sans text-[13.5px] font-semibold tracking-[0.03em] rounded-lg hover:bg-blue-50 transition-colors text-center flex items-center justify-center"
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
  const { t: tr } = useLocale()
  return (
    <div className="relative bg-dp-surface-container-low border-2 border-dashed border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 opacity-90">
      <div className="relative bg-slate-100 flex items-center justify-center min-h-[220px] md:min-h-[300px]">
        {project.proposal_image_url && (
          <Image src={project.proposal_image_url} alt={project.title} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover grayscale opacity-40" />
        )}
        <div className="relative text-center p-8">
          <Lock size={56} className="text-slate-400 mb-4 mx-auto" />
          <p className="text-slate-500 font-sans text-[15px] font-semibold" style={isUrdu ? urduStyle : undefined}>{dt('waitingConfirmation')}</p>
        </div>
      </div>
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-slate-300 text-slate-700 px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase" style={isUrdu ? urduStyle : undefined}>
              {categoryLabel(project.category, isUrdu)}
            </span>
            <span className="bg-slate-200 text-slate-600 px-3 py-1 rounded-full font-sans text-[12px] font-semibold" style={isUrdu ? urduStyle : undefined}>
              {dt('announcedBadge')}
            </span>
          </div>
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-1 text-dp-on-surface-variant">
            {project.title}
          </h3>
          <div className="flex items-center text-dp-on-surface-variant mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[16px]">{project.location}</span>
          </div>
          <p className="text-dp-on-surface-variant line-clamp-3 font-sans text-[16px] leading-[24px] mb-4">
            {project.description}
          </p>
          <div className="flex items-center justify-between px-1">
            <span className="font-sans text-[13px] font-semibold text-dp-on-surface-variant uppercase tracking-wide" style={isUrdu ? urduStyle : undefined}>{dt('requestedBudget')}</span>
            <span className="font-heading text-[18px] font-bold text-dp-on-surface-variant">Rs. {fmtFull(project.budget_pkr)}</span>
          </div>
        </div>
        <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
          <Link
            href={`/projects/${project.id}`}
            className="mt-6 py-3 border-2 border-dp-outline-variant text-dp-on-surface-variant font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:border-dp-primary hover:text-dp-primary transition-colors flex items-center justify-center gap-2"
            style={isUrdu ? urduStyle : undefined}
          >
            <Eye size={15} /> {dt('viewDetails')}
          </Link>
        </motion.div>
      </div>
    </div>
  )
}
