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
}

const filters = ['All', 'Ongoing', 'Completed', 'Upcoming']

function formatPKR(val: number | null) {
  if (!val) return '0'
  if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`
  if (val >= 1000) return `${Math.round(val / 1000)}k`
  return val.toLocaleString()
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeFilter, setActiveFilter] = useState('All')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setProjects(data ?? [])
        setLoading(false)
      })
  }, [])

  const filtered =
    activeFilter === 'All'
      ? projects
      : projects.filter(
          (p) => p.status === activeFilter.toLowerCase()
        )

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
            if (project.status === 'ongoing') return <OngoingCard key={project.id} project={project} />
            if (project.status === 'completed') return <CompletedCard key={project.id} project={project} />
            if (project.status === 'upcoming') return <UpcomingCard key={project.id} project={project} />
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
              href="/suggestions"
              className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-dp-secondary text-white hover:bg-dp-primary"
            >
              Submit Proposal
            </Link>
            <Link
              href="/suggestions"
              className="inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer px-8 py-3 bg-transparent border-2 border-white text-white hover:bg-white/10"
            >
              Browse Proposals
            </Link>
          </div>
        </div>
        <div className="absolute top-[-50px] right-[-50px] w-64 h-64 bg-dp-primary rounded-full opacity-20 blur-3xl" />
        <div className="absolute bottom-[-50px] left-[-50px] w-64 h-64 bg-dp-secondary rounded-full opacity-10 blur-3xl" />
      </div>
    </div>
  )
}

/* ========== ONGOING CARD ========== */
function OngoingCard({ project }: { project: Project }) {
  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 hover:border-dp-secondary transition-all">
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
            <button className="px-4 py-2 border-2 border-dp-primary text-dp-primary font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-dp-primary-container hover:text-white transition-all cursor-pointer">
              Details
            </button>
            <Link
              href="/donate"
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
function CompletedCard({ project }: { project: Project }) {
  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 hover:border-dp-secondary transition-all">
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
          <button className="px-6 py-2 bg-dp-surface-container-highest text-dp-on-surface font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-dp-outline-variant transition-all cursor-pointer">
            View Audit
          </button>
        </div>
      </div>
    </div>
  )
}

/* ========== UPCOMING CARD ========== */
function UpcomingCard({ project }: { project: Project }) {
  return (
    <div className="bg-[#fcf9f8] border-2 border-dashed border-blue-200 rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 shadow-sm">
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
                142 Votes
              </p>
              <p className="text-blue-700 text-[14px] font-sans font-semibold tracking-[0.05em]">
                Requires 250 to initiate fund
              </p>
            </div>
            <div className="flex -space-x-2">
              <span className="w-8 h-8 bg-blue-200 border-2 border-white rounded-full" />
              <span className="w-8 h-8 bg-blue-300 border-2 border-white rounded-full" />
              <span className="w-8 h-8 bg-blue-400 border-2 border-white rounded-full" />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <button className="flex-1 py-3 bg-blue-600 text-white font-sans text-[14px] font-semibold tracking-[0.05em] rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 cursor-pointer">
            <ThumbsUp size={16} />
            Vote for Project
          </button>
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
