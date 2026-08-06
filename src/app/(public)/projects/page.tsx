'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import {
  MapPin,
  CheckCircle,
  Vote,
  ThumbsUp,
  MessageSquare,
  ArrowRight,
  Flame,
  Lock,
} from 'lucide-react'

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
}

const filters = ['All', 'Ongoing', 'Completed', 'Upcoming', 'Announced']

function formatPKR(val: number | null) {
  if (!val) return '0'
  if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`
  if (val >= 1000) return `${Math.round(val / 1000)}k`
  return val.toLocaleString()
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [voteCounts, setVoteCounts] = useState<Record<string, number>>({})
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  const [activeFilter, setActiveFilter] = useState('All')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
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

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="mb-12">
        <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface">
          Village Welfare Projects
        </h2>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px] max-w-2xl mt-2">
          Tracking the growth of Dhab Pari through community-funded
          infrastructure, healthcare, and educational initiatives.
        </p>
      </div>

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
          >
            {f}
          </button>
        ))}
        <div className="ml-auto hidden md:flex items-center gap-2 text-dp-on-surface-variant">
          <span className="font-sans text-[14px] font-semibold tracking-[0.05em] uppercase">
            Sort by Date
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
            if (project.status === 'ongoing') return <OngoingCard key={project.id} project={project} isHot={hotIds.has(project.id)} />
            if (project.status === 'completed') return <CompletedCard key={project.id} project={project} isHot={hotIds.has(project.id)} />
            if (project.status === 'upcoming') return <UpcomingCard key={project.id} project={project} voteCount={voteCounts[project.id] ?? 0} isHot={hotIds.has(project.id)} />
            if (project.status === 'announced') return <AnnouncedCard key={project.id} project={project} />
            return null
          })}

          {filtered.length === 0 && !loading && (
            <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">
              No projects found for this filter.
            </div>
          )}
        </div>
      )}

      {/* Bottom CTA */}
      <div className="mt-20 bg-dp-primary-container text-white p-12 rounded-2xl text-center relative overflow-hidden">
        <div className="relative z-10">
          <h3 className="font-heading text-[32px] font-bold leading-[40px] mb-4">
            Have an idea for the village?
          </h3>
          <p className="font-sans text-[18px] leading-[28px] mb-8 max-w-xl mx-auto opacity-90">
            Every great transformation starts with a simple suggestion. Share
            your vision for Dhab Pari&apos;s future infrastructure or welfare
            projects.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/portal/propose-project"
              className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-dp-secondary text-white hover:bg-dp-primary"
            >
              Submit Proposal
            </Link>
            <button
              onClick={() => setActiveFilter('Upcoming')}
              className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-transparent border-2 border-white text-white hover:bg-white/10"
            >
              Browse Proposals
            </button>
          </div>
        </div>
        <div className="absolute top-[-50px] right-[-50px] w-64 h-64 bg-dp-primary rounded-full opacity-20 blur-3xl" />
        <div className="absolute bottom-[-50px] left-[-50px] w-64 h-64 bg-dp-secondary rounded-full opacity-10 blur-3xl" />
      </div>
    </div>
  )
}

/* ========== ONGOING CARD ========== */
function HotBadge() {
  return (
    <span className="absolute top-2 right-2 z-20 bg-red-500 text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-full font-sans flex items-center gap-1">
      <Flame size={11} /> Hot
    </span>
  )
}

function OngoingCard({ project, isHot }: { project: Project; isHot: boolean }) {
  return (
    <div className="relative bg-white border border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 hover:border-dp-secondary transition-all">
      {isHot && <HotBadge />}
      {/* Left: Before / Present */}
      <div className="relative grid grid-cols-2 gap-[2px] bg-dp-outline-variant p-[2px]">
        <div className="relative">
          <div className="absolute top-2 left-2 z-10 bg-black/50 text-white text-[10px] uppercase font-bold px-2 py-0.5 rounded font-sans">
            Before
          </div>
          <div className="aspect-[4/3] bg-gradient-to-br from-dp-surface-container-high to-dp-surface-dim" />
        </div>
        <div className="relative">
          <div className="absolute top-2 left-2 z-10 bg-dp-primary text-white text-[10px] uppercase font-bold px-2 py-0.5 rounded font-sans">
            Present
          </div>
          <div className="aspect-[4/3] bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container" />
        </div>
      </div>

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-dp-primary-container text-dp-on-primary-container px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase">
              {project.category}
            </span>
            <span className="bg-amber-100 text-amber-900 px-3 py-1 rounded-full font-sans text-[12px] font-semibold flex items-center gap-1">
              <span className="w-2 h-2 bg-amber-600 rounded-full animate-pulse" />
              Ongoing
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
            <div className="flex justify-between font-sans text-[14px] font-semibold tracking-[0.05em] mb-2 text-dp-on-surface">
              <span>Project Completion</span>
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
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans">
                Budget
              </p>
              <p className="text-[20px] font-bold text-dp-primary font-sans leading-[28px]">
                {formatPKR(project.budget_pkr)}{' '}
                <span className="text-[14px] font-normal">PKR</span>
              </p>
            </div>
            <div className="p-3 bg-dp-surface-container-low rounded-lg">
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans">
                Spent
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
          <div className="flex -space-x-3">
            {['bg-dp-primary-container', 'bg-dp-secondary', 'bg-dp-tertiary-container'].map((bg, i) => (
              <div key={i} className={`w-8 h-8 rounded-full border-2 border-white ${bg}`} />
            ))}
            <div className="w-8 h-8 rounded-full border-2 border-white bg-dp-surface-container-high flex items-center justify-center text-[10px] font-bold font-sans">
              +14
            </div>
          </div>
          <div className="flex gap-2">
            <Link href={`/projects/${project.id}`} className="px-4 py-2 border-2 border-dp-primary text-dp-primary font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-dp-primary-container hover:text-white transition-all">
              Details
            </Link>
            <Link
              href={`/projects/${project.id}`}
              className="px-4 py-2 bg-dp-primary text-white font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:scale-95 transition-transform"
            >
              Donate
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ========== COMPLETED CARD ========== */
function CompletedCard({ project, isHot }: { project: Project; isHot: boolean }) {
  return (
    <div className="relative bg-white border border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 hover:border-dp-secondary transition-all">
      {isHot && <HotBadge />}
      {/* Left: Photo */}
      <div className="relative">
        <div className="absolute top-4 left-4 z-10 bg-dp-primary text-white text-[10px] uppercase font-bold px-3 py-1 rounded font-sans">
          Success Story
        </div>
        <div className="h-full min-h-[300px] bg-gradient-to-br from-dp-secondary to-dp-primary-container" />
      </div>

      {/* Right: Content */}
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-dp-primary-container text-dp-on-primary-container px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase">
              {project.category}
            </span>
            <span className="bg-dp-primary text-white px-3 py-1 rounded-full font-sans text-[12px] font-semibold flex items-center gap-1">
              <CheckCircle size={14} />
              Completed
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
            <div className="flex justify-between font-sans text-[14px] font-semibold tracking-[0.05em] mb-2 text-dp-primary font-bold">
              <span>Operational Status</span>
              <span>100% Fully Functional</span>
            </div>
            <div className="h-3 w-full bg-dp-surface-container-highest rounded-full overflow-hidden">
              <div className="h-full bg-dp-primary w-full" />
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="p-3 border border-dp-outline-variant rounded-lg">
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans">
                Total Cost
              </p>
              <p className="text-[20px] font-bold text-dp-on-surface font-sans leading-[28px]">
                {formatPKR(project.budget_pkr)}{' '}
                <span className="text-[14px] font-normal">PKR</span>
              </p>
            </div>
            <div className="p-3 border border-dp-outline-variant rounded-lg">
              <p className="text-dp-on-surface-variant text-[12px] uppercase font-semibold mb-1 font-sans">
                Beneficiaries
              </p>
              <p className="text-[20px] font-bold text-dp-on-surface font-sans leading-[28px]">
                {project.beneficiaries_count ?? 0}+{' '}
                <span className="text-[14px] font-normal">Homes</span>
              </p>
            </div>
          </div>
        </div>

        {/* Bottom */}
        <div className="flex items-center justify-between">
          <p className="text-dp-on-surface-variant font-sans text-[16px] italic border-l-4 border-dp-secondary-fixed pl-3 max-w-[60%]">
            &ldquo;Pure water is life for our children.&rdquo; — Haji Rasheed
          </p>
          <Link href={`/projects/${project.id}`} className="px-6 py-2 bg-dp-surface-container-highest text-dp-on-surface font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-dp-outline-variant transition-all">
            View Audit
          </Link>
        </div>
      </div>
    </div>
  )
}

/* ========== UPCOMING CARD ========== */
function UpcomingCard({ project, voteCount, isHot }: { project: Project; voteCount: number; isHot: boolean }) {
  return (
    <div className="relative bg-white border-2 border-dashed border-blue-200 rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 shadow-sm">
      {isHot && <HotBadge />}
      {/* Left: Illustration */}
      <div className="relative bg-blue-50 flex items-center justify-center min-h-[300px]">
        <div className="text-center p-8">
          <Vote size={64} className="text-blue-500 mb-4 mx-auto" />
          <h4 className="font-heading text-[24px] font-bold leading-[32px] text-blue-900 mb-2">
            Future Vision
          </h4>
          <p className="text-blue-700 font-sans text-[16px]">Community Voting Stage</p>
        </div>
        <div
          className="absolute inset-0 opacity-10"
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
            <span className="bg-blue-600 text-white px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase">
              {project.category}
            </span>
            <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full font-sans text-[12px] font-semibold flex items-center gap-1">
              <Vote size={14} />
              Upcoming / Voting
            </span>
          </div>
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-1 text-dp-on-surface">
            {project.title}
          </h3>
          <div className="flex items-center text-dp-on-surface-variant mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[16px]">{project.location}</span>
          </div>
          <p className="text-dp-on-surface-variant mb-8 line-clamp-3 font-sans text-[16px] leading-[24px]">
            {project.description}
          </p>

          {/* Vote Box */}
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 flex items-center justify-between mb-6">
            <div>
              <p className="text-blue-900 font-bold text-[20px] font-sans leading-[28px]">
                {voteCount} Votes
              </p>
              <p className="text-blue-700 text-[14px] font-sans font-semibold tracking-[0.05em]">
                {project.vote_target ? `Requires ${project.vote_target} to advance` : 'Vote target not set'}
              </p>
            </div>
            <div className="h-2 w-24 bg-blue-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600" style={{ width: `${project.vote_target ? Math.min(100, (voteCount / project.vote_target) * 100) : 0}%` }} />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <Link
            href={`/projects/${project.id}`}
            className="flex-1 py-3 bg-blue-600 text-white font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
          >
            <ThumbsUp size={16} />
            View &amp; Vote
          </Link>
          <Link
            href="/suggestions"
            className="px-6 py-3 border-2 border-blue-600 text-blue-600 font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-blue-50 transition-colors text-center"
          >
            Submit Suggestion
          </Link>
        </div>
      </div>
    </div>
  )
}

/* ========== ANNOUNCED CARD ========== */
// A freshly-posted proposal, paused until the proposer's own self-commitment
// is paid and staff-confirmed (migration 141) — greyed out on purpose, no
// vote/donate actions yet, just the "waiting" label from the detail page.
function AnnouncedCard({ project }: { project: Project }) {
  return (
    <div className="relative bg-dp-surface-container-low border-2 border-dashed border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 opacity-90">
      <div className="relative bg-slate-100 flex items-center justify-center min-h-[220px] md:min-h-[300px]">
        <div className="text-center p-8">
          <Lock size={56} className="text-slate-400 mb-4 mx-auto" />
          <p className="text-slate-500 font-sans text-[15px] font-semibold">Waiting for the announced payment confirmation</p>
        </div>
      </div>
      <div className="p-8 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="bg-slate-300 text-slate-700 px-3 py-1 rounded font-sans text-[12px] font-semibold tracking-[0.05em] uppercase">
              {project.category}
            </span>
            <span className="bg-slate-200 text-slate-600 px-3 py-1 rounded-full font-sans text-[12px] font-semibold">
              Announced
            </span>
          </div>
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-1 text-dp-on-surface-variant">
            {project.title}
          </h3>
          <div className="flex items-center text-dp-on-surface-variant mb-6 gap-1">
            <MapPin size={16} />
            <span className="font-sans text-[16px]">{project.location}</span>
          </div>
          <p className="text-dp-on-surface-variant line-clamp-3 font-sans text-[16px] leading-[24px]">
            {project.description}
          </p>
        </div>
        <Link
          href={`/projects/${project.id}`}
          className="mt-6 py-3 border-2 border-dp-outline-variant text-dp-on-surface-variant font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:border-dp-primary hover:text-dp-primary transition-colors flex items-center justify-center gap-2"
        >
          View Details
        </Link>
      </div>
    </div>
  )
}
