'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ArrowLeft, MapPin, HeartHandshake, Megaphone, Receipt, CheckCircle, Vote, ThumbsUp, Flag, Share2, Clock, Users, HandHeart, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonorBadge } from '@/components/public/DonorBadge'
import type { DonorBadgeTier } from '@/lib/donorBadges'

interface Project {
  id: string; title: string; description: string | null; status: string
  budget_pkr: number | null; category: string | null; location: string | null
  vote_target: number | null; minimum_monthly_commitment_pkr: number | null
  funding_model: string | null; monthly_operating_cost_pkr: number | null
}
interface DonorRow { id: string; name: string; amount_pkr: number; date: string; is_verified: boolean; payment_status: string }
interface ExpenseRow { id: string; entry_date: string; particular: string; debit: number }
interface VoteRow { id: string; username: string | null; avatar_url: string | null }
interface CommentRow {
  id: string; content: string; created_at: string; portal_user_id: string | null; parent_comment_id: string | null; comment_type: string
  username: string | null; avatar_url: string | null; badge_tier: DonorBadgeTier | null; like_count: number
}


function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

type Lang = 'en' | 'ur'

// Same site-wide "Accounts Display Language" toggle /water/apply and
// propose-project already respect (site_settings.display_language).
const t: Record<string, { en: string; ur: string }> = {
  announcedSub: { en: "These donors have announced their funding, but it hasn't reached the project account yet.", ur: 'ان عطیہ دہندگان نے فنڈنگ کا اعلان کیا ہے، لیکن رقم ابھی تک منصوبے کے اکاؤنٹ میں نہیں پہنچی۔' },
  confirmedSub: { en: "This donor's amount has already arrived in the project's account.", ur: 'اس عطیہ دہندہ کی رقم منصوبے کے اکاؤنٹ میں پہنچ چکی ہے۔' },
  expensesHeading: { en: 'Expenses', ur: 'اخراجات' },
  discussionHeading: { en: 'Discussion', ur: 'تبادلہ خیال' },
  noAnnounced: { en: 'No announced pledges yet.', ur: 'ابھی تک کوئی اعلان شدہ وعدہ نہیں۔' },
  noConfirmed: { en: 'No verified donations yet.', ur: 'ابھی تک کوئی تصدیق شدہ عطیہ نہیں۔' },
  noExpenses: { en: 'No expenses recorded yet.', ur: 'ابھی تک کوئی خرچ درج نہیں ہوا۔' },
  receivedVia: { en: 'Received via', ur: 'موصولہ ذریعہ' },
}

// The first public, per-project real financial view in this app — everything
// before this (the old /accounts page) was either admin-only or hardcoded
// placeholder data. Reuses the project's own ledger account (migration 118)
// via the already-public donors_public view and the already-public
// ledger_entries table.
export default function ProjectDetailPage() {
  const { t: tr } = useLocale()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)
  const [verified, setVerified] = useState<DonorRow[]>([])
  const [announced, setAnnounced] = useState<DonorRow[]>([])
  const [expenses, setExpenses] = useState<ExpenseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [lang, setLang] = useState<Lang>('en')
  const dt = (key: keyof typeof t) => t[key][lang]
  const isUrdu = lang === 'ur'
  const [comments, setComments] = useState<CommentRow[]>([])
  const [myLikes, setMyLikes] = useState<Set<string>>(new Set())
  const [newComment, setNewComment] = useState('')
  const [postingComment, setPostingComment] = useState(false)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [portalUser, setPortalUser] = useState<{ id: string; full_name: string; mobile: string; whatsapp_number: string | null; name_ur: string | null; donor_type: string | null } | null>(null)

  const [showAnnounce, setShowAnnounce] = useState(false)
  const [announceAmount, setAnnounceAmount] = useState(0)
  const [announcing, setAnnouncing] = useState(false)

  const [showVolunteer, setShowVolunteer] = useState(false)
  const [volunteerMessage, setVolunteerMessage] = useState('')
  const [volunteering, setVolunteering] = useState(false)

  const [votes, setVotes] = useState<VoteRow[]>([])
  const [myVoteId, setMyVoteId] = useState<string | null>(null)
  const [voting, setVoting] = useState(false)
  const [monthlySponsored, setMonthlySponsored] = useState(0)
  const [channels, setChannels] = useState<{ payment_method: string; total_pkr: number }[]>([])

  const load = useCallback(async () => {
    const supabase = createClient()
    const [{ data: p }, { data: v }, { data: a }, { data: expenseAcct }, { data: voteRows }, { data: commentRows }] = await Promise.all([
      supabase.from('projects').select('id, title, description, status, budget_pkr, category, location, vote_target, minimum_monthly_commitment_pkr, funding_model, monthly_operating_cost_pkr').eq('id', id).single(),
      supabase.from('donors_public').select('id, name, amount_pkr, date, is_verified, payment_status').eq('project_id', id).eq('is_verified', true).order('amount_pkr', { ascending: false }),
      supabase.from('donors_public').select('id, name, amount_pkr, date, is_verified, payment_status').eq('project_id', id).eq('is_verified', false).order('date', { ascending: false }),
      supabase.from('project_accounts_public').select('id').eq('project_id', id).maybeSingle(),
      supabase.from('project_votes_public').select('id, username, avatar_url').eq('project_id', id).order('created_at', { ascending: false }),
      supabase.from('project_comments_public').select('*').eq('project_id', id).order('created_at', { ascending: false }),
    ])
    setProject(p ?? null)
    setVerified(v ?? [])
    setAnnounced(a ?? [])
    setVotes(voteRows ?? [])
    setComments(commentRows ?? [])
    if (expenseAcct) {
      // Narrow public view (migration 182) — project spending stays public
      // without the rest of the ledger coming with it.
      const { data: legs } = await supabase.from('project_expenses_public').select('id, entry_date, particular, debit')
        .eq('project_id', id).order('entry_date', { ascending: false })
      setExpenses(legs ?? [])
    }
    if (p?.funding_model === 'recurring_support') {
      const { data: sponsored } = await supabase.rpc('project_monthly_sponsorship_pkr', { p_project_id: id })
      setMonthlySponsored(Number(sponsored ?? 0))
    }
    const { data: ch } = await supabase.rpc('project_donation_channels_pkr', { p_project_id: id })
    setChannels(ch ?? [])
    setLoading(false)

    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (authUser) {
      const { data: pu } = await supabase.from('portal_users').select('id, full_name, mobile, whatsapp_number, name_ur, donor_type').eq('auth_user_id', authUser.id).maybeSingle()
      setPortalUser(pu ?? null)
      if (pu) {
        const { data: myVote } = await supabase.from('project_votes').select('id').eq('project_id', id).eq('portal_user_id', pu.id).maybeSingle()
        setMyVoteId(myVote?.id ?? null)
        if ((commentRows ?? []).length > 0) {
          const { data: likeRows } = await supabase.from('project_comment_likes').select('comment_id').eq('portal_user_id', pu.id).in('comment_id', (commentRows ?? []).map((c) => c.id))
          setMyLikes(new Set((likeRows ?? []).map((l) => l.comment_id)))
        }
      }
    }
  }, [id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    createClient().from('site_settings').select('value').eq('key', 'display_language').maybeSingle().then(({ data }) => {
      if (data?.value === 'ur') setLang('ur')
    })
  }, [])

  // Live expenses — updates the moment staff post a project-tagged expense,
  // no refresh needed (migration 134 enables Realtime on ledger_entries).
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase.channel(`project-ledger:${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ledger_entries' }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [id, load])

  // Live chat feel — new comments appear without a refresh (migration 138
  // enables Realtime on project_comments).
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase.channel(`project-comments:${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'project_comments', filter: `project_id=eq.${id}` }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [id, load])

  const totalVerified = verified.reduce((s, d) => s + Number(d.amount_pkr), 0)
  const totalAnnounced = announced.reduce((s, d) => s + Number(d.amount_pkr), 0)
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.debit), 0)

  const submitAnnounce = async () => {
    if (!portalUser) { router.push(`/portal/login?next=/projects/${id}`); return }
    if (!announceAmount || announceAmount <= 0) { toast.error('Enter a valid amount'); return }
    setAnnouncing(true)
    const supabase = createClient()
    const { error } = await supabase.from('donors').insert({
      name: portalUser.full_name, name_ur: portalUser.name_ur, phone: portalUser.mobile, whatsapp_number: portalUser.whatsapp_number,
      donor_type: portalUser.donor_type ?? 'villager', amount_pkr: announceAmount, date: new Date().toISOString().split('T')[0],
      payment_method: 'jazzcash', project_id: id, is_anonymous: false, is_verified: false, submitted_via: 'public',
      payment_status: 'pledged', portal_user_id: portalUser.id,
    })
    setAnnouncing(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Pledge announced! Pay anytime from your portal to complete it.')
    setShowAnnounce(false)
    setAnnounceAmount(0)
    load()
  }

  const submitVolunteer = async () => {
    if (!portalUser) { router.push(`/portal/login?next=/projects/${id}`); return }
    setVolunteering(true)
    const supabase = createClient()
    const { error } = await supabase.from('volunteers').insert({
      portal_user_id: portalUser.id, project_id: id, message: volunteerMessage.trim() || null,
    })
    setVolunteering(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Thank you for volunteering!')
    setShowVolunteer(false)
    setVolunteerMessage('')
  }

  // Votes are permanent once cast — no retract path (RLS has no delete-own
  // policy for project_votes, matching migration 139).
  const castVote = async () => {
    if (!portalUser) { router.push(`/portal/login?next=/projects/${id}`); return }
    if (myVoteId) return
    setVoting(true)
    const supabase = createClient()
    const { error } = await supabase.from('project_votes').insert({ project_id: id, portal_user_id: portalUser.id })
    setVoting(false)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const postComment = async (parentId?: string) => {
    if (!portalUser) { router.push(`/portal/login?next=/projects/${id}`); return }
    const content = parentId ? replyText : newComment
    if (!content.trim()) return
    setPostingComment(true)
    const supabase = createClient()
    const { error } = await supabase.from('project_comments').insert({ project_id: id, portal_user_id: portalUser.id, content: content.trim(), parent_comment_id: parentId ?? null })
    setPostingComment(false)
    if (error) { toast.error(friendlyError(error)); return }
    if (parentId) { setReplyText(''); setReplyingTo(null) } else { setNewComment('') }
    load()
  }

  const toggleLike = async (commentId: string) => {
    if (!portalUser) { router.push(`/portal/login?next=/projects/${id}`); return }
    const supabase = createClient()
    if (myLikes.has(commentId)) {
      await supabase.from('project_comment_likes').delete().eq('comment_id', commentId).eq('portal_user_id', portalUser.id)
    } else {
      await supabase.from('project_comment_likes').insert({ comment_id: commentId, portal_user_id: portalUser.id })
    }
    load()
  }

  // Web Share API where supported (mobile browsers), falling back to the
  // same wa.me deep-link pattern already used throughout admin (collect,
  // donors, reminders pages) — no recipient number, just opens WhatsApp's
  // own share-to-any-chat picker.
  const shareProject = async () => {
    const url = typeof window !== 'undefined' ? window.location.href : ''
    const text = `Vote for "${project?.title}" — help it reach ${project?.vote_target ?? 'the'} votes! ${url}`
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: project?.title ?? 'Vote for this project', text, url }); return } catch { /* user cancelled */ return }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank')
  }

  const flagComment = async (commentId: string) => {
    if (!portalUser) { router.push(`/portal/login?next=/projects/${id}`); return }
    const reason = window.prompt('Why are you flagging this comment? (sent to the committee for review)')
    if (reason === null) return
    const supabase = createClient()
    const { error } = await supabase.rpc('flag_project_comment', { p_comment_id: commentId, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Flagged for staff review')
  }

  if (loading) return <div className="text-center py-20 text-dp-on-surface-variant font-sans">{tr('action.loading')}</div>
  if (!project) return <div className="text-center py-20 text-dp-on-surface-variant font-sans">{tr('x.projectNotFound')}</div>

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <Link href="/projects" className="inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold hover:underline mb-6"><ArrowLeft size={16} /> {tr('x.allProjects')}</Link>

      <div className="mb-8">
        <span className="bg-dp-primary-container text-dp-on-primary-container px-3 py-1 rounded font-sans text-[12px] font-semibold uppercase tracking-[0.05em]">{project.category}</span>
        <h1 className="font-heading text-[28px] md:text-[32px] font-bold text-dp-primary mt-3">{project.title}</h1>
        {project.location && <p className="flex items-center gap-1 text-dp-on-surface-variant font-sans text-[15px] mt-1"><MapPin size={15} /> {project.location}</p>}
        <p className="font-sans text-[16px] text-dp-on-surface-variant mt-4 leading-[26px]">{project.description}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('home.budget')}</p>
          <p className="font-heading text-[20px] font-bold text-dp-primary">Rs. {fmt(project.budget_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('x.verifiedRaised')}</p>
          <p className="font-heading text-[20px] font-bold text-dp-secondary">Rs. {fmt(totalVerified)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('x.announced')}</p>
          <p className="font-heading text-[20px] font-bold text-amber-600">Rs. {fmt(totalAnnounced)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('home.spent')}</p>
          <p className="font-heading text-[20px] font-bold text-dp-error">Rs. {fmt(totalExpenses)}</p>
        </div>
      </div>

      {channels.length > 0 && (
        <div className="mb-8" dir={isUrdu ? 'rtl' : 'ltr'}>
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide mb-1.5" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('receivedVia')}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {channels.map((c) => (
              <p key={c.payment_method} className="font-sans text-[13.5px] text-dp-on-surface-variant">
                <span className="capitalize font-semibold text-dp-on-surface">{c.payment_method}</span>: Rs. {fmt(c.total_pkr)}
              </p>
            ))}
          </div>
        </div>
      )}

      {project.status === 'announced' ? (
        <div className="bg-slate-100 border border-slate-300 rounded-lg p-6 mb-8 flex items-center gap-3">
          <Clock size={22} className="text-slate-500 shrink-0" />
          <div>
            <p className="font-heading text-[17px] font-bold text-slate-700">{tr('x.awaitingPledgeConfirm')}</p>
            <p className="font-sans text-[13px] text-slate-600 mt-0.5">
              The proposer's self-commitment hasn't been confirmed yet — voting, donations, and pledges open automatically once staff confirm the payment.
            </p>
          </div>
        </div>
      ) : project.status === 'upcoming' ? (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-6 mb-8">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <p className="font-heading text-[24px] font-bold text-blue-900">{votes.length} / {project.vote_target ?? '—'} Votes</p>
              {project.minimum_monthly_commitment_pkr && (
                <p className="font-sans text-[13px] text-blue-700 mt-1">Proposer committed Rs. {fmt(project.minimum_monthly_commitment_pkr)}/month once launched.</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={shareProject} className="flex items-center gap-2 border-2 border-blue-600 text-blue-700 px-4 py-3 rounded-lg font-sans font-semibold hover:bg-blue-600 hover:text-white transition-all cursor-pointer">
                <Share2 size={16} /> {tr('x.shareForVotes')}
              </button>
              <button onClick={castVote} disabled={voting || !!myVoteId} className={`flex items-center gap-2 px-6 py-3 rounded-lg font-sans font-semibold transition-all disabled:opacity-100 ${myVoteId ? 'bg-blue-100 text-blue-700 border-2 border-blue-600 cursor-default' : 'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer disabled:opacity-50'}`}>
                <Vote size={16} /> {myVoteId ? '✓ Voted' : 'Vote for Project'}
              </button>
            </div>
          </div>
          {votes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {votes.map((v) => (
                <div key={v.id} title={v.username ?? undefined} className="flex items-center gap-1.5 bg-white border border-blue-100 rounded-full ps-1 pe-3 py-1">
                  {v.avatar_url ? <Image src={v.avatar_url} alt="" width={24} height={24} className="w-6 h-6 rounded-full object-cover" /> : <div className="w-6 h-6 rounded-full bg-blue-200 flex items-center justify-center text-[10px] font-bold text-blue-800">{(v.username ?? '?').charAt(0).toUpperCase()}</div>}
                  <span className="font-sans text-[12px] font-semibold text-blue-900">{v.username}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 mb-8">
          <Link href={portalUser ? `/portal/donate?project=${id}` : `/donate/submit?project=${id}`} className="flex items-center gap-2 bg-dp-secondary text-white px-6 py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all">
            <HeartHandshake size={16} /> {tr('x.donateNowBtn')}
          </Link>
          <button onClick={() => (portalUser ? setShowAnnounce(true) : router.push(`/portal/login?next=/projects/${id}`))} className="flex items-center gap-2 border-2 border-dp-primary text-dp-primary px-6 py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary hover:text-white transition-all cursor-pointer">
            <Megaphone size={16} /> {tr('x.announcePledge')}
          </button>
          <button onClick={() => (portalUser ? setShowVolunteer(true) : router.push(`/portal/login?next=/projects/${id}`))} className="flex items-center gap-2 border-2 border-dp-secondary text-dp-secondary px-6 py-3 rounded-lg font-sans font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
            <HandHeart size={16} /> {tr('x.volunteerForProject')}
          </button>
        </div>
      )}

      {project.funding_model === 'recurring_support' && project.status !== 'announced' && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-8">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <p className="font-sans text-[13.5px] font-bold text-dp-primary flex items-center gap-2"><Users size={16} className="text-dp-secondary" /> {tr('x.monthlySponsorship')}</p>
            <span className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full uppercase ${project.monthly_operating_cost_pkr && monthlySponsored >= project.monthly_operating_cost_pkr ? 'bg-dp-secondary text-white' : 'bg-amber-100 text-amber-700'}`}>
              {project.monthly_operating_cost_pkr && monthlySponsored >= project.monthly_operating_cost_pkr ? 'Fully Sponsored' : 'Needs More Monthly Sponsors'}
            </span>
          </div>
          <p className="font-sans text-[14px] text-dp-on-surface-variant">
            Rs. {fmt(monthlySponsored)} / Rs. {fmt(project.monthly_operating_cost_pkr ?? 0)} committed per month
          </p>
          <div className="h-2 w-full bg-dp-surface-container-low rounded-full overflow-hidden mt-2">
            <div className="h-full bg-dp-secondary" style={{ width: `${project.monthly_operating_cost_pkr ? Math.min(100, (monthlySponsored / project.monthly_operating_cost_pkr) * 100) : 0}%` }} />
          </div>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">
            This ongoing cost (e.g. staff/instructor salary) is separate from the one-time budget above — set up a recurring monthly donation from your portal to sponsor it.
          </p>
        </div>
      )}

      {/* Announced (left) / Confirmed (right) — always both visible side by
          side, no tab-switching, per your ask. Headings follow the site's
          display_language setting. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div dir={isUrdu ? 'rtl' : 'ltr'}>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('announcedSub')}</p>
          <div className="bg-white rounded-lg border border-dp-outline-variant divide-y divide-dp-outline-variant">
            {announced.length === 0 && <p className="p-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('noAnnounced')}</p>}
            {announced.map((d) => (
              <div key={d.id} className="flex items-center justify-between px-5 py-3.5">
                <div>
                  <span className="font-sans text-[14px] font-semibold">{d.name}</span>
                  <span className="ms-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 uppercase">{d.payment_status === 'pledged' ? 'Pledged' : 'Awaiting Verification'}</span>
                </div>
                <span className="font-sans text-[14px] font-bold text-amber-600">Rs. {fmt(d.amount_pkr)}</span>
              </div>
            ))}
          </div>
        </div>
        <div dir={isUrdu ? 'rtl' : 'ltr'}>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('confirmedSub')}</p>
          <div className="bg-white rounded-lg border border-dp-outline-variant divide-y divide-dp-outline-variant">
            {verified.length === 0 && <p className="p-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('noConfirmed')}</p>}
            {verified.map((d) => (
              <div key={d.id} className="flex items-center justify-between px-5 py-3.5">
                <span className="font-sans text-[14px] font-semibold flex items-center gap-2"><CheckCircle size={14} className="text-dp-secondary" /> {d.name}</span>
                <span className="font-sans text-[14px] font-bold text-dp-secondary">Rs. {fmt(d.amount_pkr)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-8">
        <p className="font-sans text-[14px] font-bold text-dp-on-surface mb-2" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('expensesHeading')}</p>
        <div className="bg-white rounded-lg border border-dp-outline-variant divide-y divide-dp-outline-variant">
          {expenses.length === 0 && <p className="p-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('noExpenses')}</p>}
          {expenses.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-5 py-3.5">
              <span className="font-sans text-[14px] flex items-center gap-2"><Receipt size={14} className="text-dp-error" /> {e.particular}</span>
              <div className="text-end">
                <p className="font-sans text-[14px] font-bold text-dp-error">Rs. {fmt(e.debit)}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{new Date(e.entry_date).toLocaleDateString('en-GB')}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Discussion — always visible, per your ask (no tab to switch to). */}
      <div>
        <p className="font-sans text-[14px] font-bold text-dp-on-surface mb-2" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('discussionHeading')}</p>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
          <textarea value={newComment} onChange={(e) => setNewComment(e.target.value)} rows={2} placeholder={portalUser ? 'Share your thoughts...' : 'Log in to join the discussion'}
            disabled={!portalUser} className="input-field resize-none mb-2" />
          <button onClick={() => postComment()} disabled={postingComment || !portalUser} className="px-5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {postingComment ? 'Posting...' : 'Post Comment'}
          </button>
        </div>
        <div className="space-y-3">
          {comments.length === 0 && <p className="text-center font-sans text-[14px] text-dp-on-surface-variant py-6">{tr('x.noComments')}</p>}
          {comments.filter((c) => !c.parent_comment_id).map((c) => (
            <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <CommentBody c={c} myLikes={myLikes} toggleLike={toggleLike} flagComment={flagComment} onReply={() => setReplyingTo(replyingTo === c.id ? null : c.id)} />
              {replyingTo === c.id && (
                <div className="mt-3 ps-11 flex gap-2">
                  <input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Write a reply..." className="input-field flex-1" />
                  <button onClick={() => postComment(c.id)} disabled={postingComment} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{tr('x.reply')}</button>
                </div>
              )}
              {comments.filter((r) => r.parent_comment_id === c.id).map((r) => (
                <div key={r.id} className="mt-3 ps-11 border-s-2 border-dp-outline-variant">
                  <div className="ps-3">
                    <CommentBody c={r} myLikes={myLikes} toggleLike={toggleLike} flagComment={flagComment} />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {showAnnounce && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowAnnounce(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-4">{tr('x.announcePledge')}</h2>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">No payment needed now — your name shows in Announced until you pay. Pay anytime from your portal.</p>
            <input type="number" min={1} value={announceAmount || ''} onChange={(e) => setAnnounceAmount(+e.target.value)} placeholder="Amount (PKR)" className="input-field mb-4" />
            <button onClick={submitAnnounce} disabled={announcing} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {announcing ? 'Announcing...' : 'Announce Pledge'}
            </button>
          </div>
        </div>
      )}

      {showVolunteer && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowVolunteer(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{tr('x.volunteerForProject')}</h2>
              <button onClick={() => setShowVolunteer(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">Your name shows publicly as a volunteer for this project. The committee will reach out with details.</p>
            <textarea value={volunteerMessage} onChange={(e) => setVolunteerMessage(e.target.value)} rows={3} placeholder="Your skills, availability, etc. (optional)" className="input-field resize-none mb-4" />
            <button onClick={submitVolunteer} disabled={volunteering} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {volunteering ? 'Submitting...' : 'Volunteer'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CommentBody({ c, myLikes, toggleLike, flagComment, onReply }: {
  c: CommentRow; myLikes: Set<string>; toggleLike: (id: string) => void; flagComment: (id: string) => void; onReply?: () => void
}) {
  const { t: tr, isUrdu } = useLocale()
  if (c.comment_type === 'system') {
    return (
      <p className="font-sans text-[13px] text-dp-on-surface-variant italic flex items-center gap-2">
        <HeartHandshake size={13} className="text-dp-secondary shrink-0" /> {c.content}
        <span className="text-[11px]">· {new Date(c.created_at).toLocaleDateString('en-GB')}</span>
      </p>
    )
  }
  return (
    <div className="flex items-start gap-3">
      {c.avatar_url ? <Image src={c.avatar_url} alt="" width={32} height={32} className="w-8 h-8 rounded-full object-cover shrink-0" /> : <div className="w-8 h-8 rounded-full bg-dp-secondary-container flex items-center justify-center text-[12px] font-bold text-dp-on-secondary-container shrink-0">{(c.username ?? '?').charAt(0).toUpperCase()}</div>}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-sans text-[13.5px] font-bold text-dp-on-surface">{c.username}</span>
          <DonorBadge tier={c.badge_tier} isUrdu={isUrdu} size="xs" />
          <span className="font-sans text-[11px] text-dp-on-surface-variant">{new Date(c.created_at).toLocaleDateString('en-GB')}</span>
        </div>
        <p className="font-sans text-[14px] text-dp-on-surface mt-1">{c.content}</p>
        <div className="flex items-center gap-4 mt-2">
          <button onClick={() => toggleLike(c.id)} className={`flex items-center gap-1 text-[12px] font-sans font-semibold cursor-pointer ${myLikes.has(c.id) ? 'text-dp-secondary' : 'text-dp-on-surface-variant hover:text-dp-secondary'}`}>
            <ThumbsUp size={13} /> {c.like_count > 0 ? c.like_count : ''} Like
          </button>
          {onReply && (
            <button onClick={onReply} className="text-[12px] font-sans font-semibold text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">{tr('x.reply')}</button>
          )}
          <button onClick={() => flagComment(c.id)} className="flex items-center gap-1 text-[12px] font-sans font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
            <Flag size={12} /> {tr('x.flag')}
          </button>
        </div>
      </div>
    </div>
  )
}
