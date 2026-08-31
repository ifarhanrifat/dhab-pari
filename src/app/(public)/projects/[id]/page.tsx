'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ArrowLeft, MapPin, HeartHandshake, Megaphone, Receipt, CheckCircle, Vote, ThumbsUp, Flag, Share2, Clock, Users, HandHeart, X, ShieldCheck, Cake } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonorBadge } from '@/components/public/DonorBadge'
import type { DonorBadgeTier } from '@/lib/donorBadges'
import { VideoPlayer } from '@/components/VideoPlayer'
import { Lightbox } from '@/components/public/Lightbox'

interface Project {
  id: string; title: string; display_name: string | null; description: string | null; status: string
  budget_pkr: number | null; category: string | null; location: string | null; location_ur: string | null
  vote_target: number | null; minimum_monthly_commitment_pkr: number | null
  funding_model: string | null; monthly_operating_cost_pkr: number | null
  hide_fees: boolean; intro_video_id: string | null
  before_image_url: string | null; after_image_url: string | null
}
interface AcademyBatch {
  id: string; project_id: string; label: string; label_ur: string | null; schedule_note: string | null; schedule_note_ur: string | null
  age_min: number | null; age_max: number | null
  fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null
  fee_villager_full_pkr: number | null; fee_outsider_full_pkr: number | null
  sibling_discount_pct: number | null; capacity: number | null; spots_left: number | null
}
interface AcademyTrainer { project_id: string; trainer_name: string; trainer_bio: string | null; trainer_bio_ur: string | null; trainer_photo_url: string | null }
interface GalleryPhoto { id: string; url: string; caption: string | null }
interface DonorRow { id: string; name: string; amount_pkr: number; date: string; is_verified: boolean; payment_status: string }
interface ExpenseRow { id: string; entry_date: string; particular: string; debit: number }
interface VoteRow { id: string; username: string | null; avatar_url: string | null }
interface CommentRow {
  id: string; content: string; created_at: string; portal_user_id: string | null; admin_user_id: string | null
  parent_comment_id: string | null; comment_type: string
  username: string | null; avatar_url: string | null; badge_tier: DonorBadgeTier | null; staff_role: string | null; like_count: number
}
// admin_users.role — used to label a staff comment. Kept here rather than
// importing the settings page's own copy, since this is the one small
// mapping a public page needs.
const STAFF_ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin', admin: 'Admin', accountant: 'Accountant',
  water_accountant: 'Water Accountant', donor_accountant: 'Donor Accountant',
  publisher: 'Publisher', viewer: 'Viewer',
}
// Same category set /projects already translates (categoryLabel there) —
// the listing page got it, this detail page never did, so a category
// badge here showed the raw English enum value even in Urdu mode.
const CATEGORY_LABEL_UR: Record<string, string> = {
  infrastructure: 'تعمیرات', water: 'پانی', health: 'صحت', education: 'تعلیم',
  environment: 'ماحولیات', welfare: 'بہبود', sports: 'کھیل', training: 'تربیت', other: 'دیگر',
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
  completedNoMoreDonations: { en: 'This project is complete', ur: 'یہ منصوبہ مکمل ہو چکا ہے' },
  completedNoMoreDonationsSub: { en: "It's no longer accepting new donations or pledges — thank you to everyone who contributed.", ur: 'اب اس کے لیے نئے عطیات یا وعدے قبول نہیں کیے جا رہے — تمام معاونت کرنے والوں کا شکریہ۔' },
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
  const [portalUser, setPortalUser] = useState<{ id: string; full_name: string; username: string | null; display_name: string | null; mobile: string; whatsapp_number: string | null; name_ur: string | null; donor_type: string | null } | null>(null)
  // A staff member browsing the public site under their own /admin session —
  // migration 319. Lets them comment as themselves (name + role), with no
  // separate donor-portal signup. Donations/votes/volunteering stay
  // portal-only; this only ever affects comment authorship.
  const [staffUser, setStaffUser] = useState<{ id: string; full_name: string; role: string } | null>(null)

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
  const [joinableBatchCount, setJoinableBatchCount] = useState(0)
  const [academyBatches, setAcademyBatches] = useState<AcademyBatch[]>([])
  const [trainer, setTrainer] = useState<AcademyTrainer | null>(null)
  const [introVideo, setIntroVideo] = useState<{ video_url: string; title: string } | null>(null)
  const [galleryPhotos, setGalleryPhotos] = useState<GalleryPhoto[]>([])
  const [lightboxIndex, setLightboxIndex] = useState(-1)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [{ data: p }, { data: v }, { data: a }, { data: expenseAcct }, { data: voteRows }, { data: commentRows }] = await Promise.all([
      supabase.from('projects').select('id, title, display_name, description, status, budget_pkr, category, location, location_ur, vote_target, minimum_monthly_commitment_pkr, funding_model, monthly_operating_cost_pkr, hide_fees, intro_video_id, before_image_url, after_image_url').eq('id', id).single(),
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
    if (p?.category === 'sports' || p?.category === 'training') {
      const { count } = await supabase.from('training_batches').select('id', { count: 'exact', head: true })
        .eq('project_id', id).eq('status', 'active')
      setJoinableBatchCount(count ?? 0)

      // Public detail page didn't used to carry any of this — batches,
      // fees, sibling discount, slots, and the trainer's profile only
      // ever rendered on the portal's Academies catalog, which requires
      // logging in. A visitor deciding whether to join shouldn't have to
      // create an account first just to see what the fee is.
      const [{ data: batchRows }, { data: trainerRows }] = await Promise.all([
        supabase.rpc('training_batches_public'),
        supabase.rpc('academy_trainers_public'),
      ])
      setAcademyBatches(((batchRows ?? []) as AcademyBatch[]).filter((b) => b.project_id === id))
      setTrainer(((trainerRows ?? []) as AcademyTrainer[]).find((tn) => tn.project_id === id) ?? null)
    }
    if (p?.intro_video_id) {
      const { data: vid } = await supabase.from('video_content').select('video_url, title').eq('id', p.intro_video_id).maybeSingle()
      setIntroVideo(vid ?? null)
    }
    // Gallery — same rule as before/after: a health/medical project never
    // shows a real photo publicly, even one that's been uploaded.
    if (p?.category !== 'health') {
      const { data: media } = await supabase.from('project_media').select('id, url, caption')
        .eq('project_id', id).eq('type', 'photo').order('display_order')
      setGalleryPhotos(media ?? [])
    }
    const { data: ch } = await supabase.rpc('project_donation_channels_pkr', { p_project_id: id })
    setChannels(ch ?? [])
    setLoading(false)

    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (authUser) {
      const { data: pu } = await supabase.from('portal_users').select('id, full_name, username, display_name, mobile, whatsapp_number, name_ur, donor_type').eq('auth_user_id', authUser.id).maybeSingle()
      setPortalUser(pu ?? null)
      const { data: au } = await supabase.from('admin_users').select('id, full_name, role').eq('auth_user_id', authUser.id).eq('is_active', true).maybeSingle()
      setStaffUser(au ?? null)
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
      name: portalUser.display_name || portalUser.username || portalUser.full_name, name_ur: portalUser.name_ur, phone: portalUser.mobile, whatsapp_number: portalUser.whatsapp_number,
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
    if (!portalUser && !staffUser) { router.push(`/portal/login?next=/projects/${id}`); return }
    const content = parentId ? replyText : newComment
    if (!content.trim()) return
    setPostingComment(true)
    const supabase = createClient()
    // Staff takes priority for comment authorship when both identities
    // exist — donations/votes/volunteering below still use portalUser.
    const { error } = await supabase.from('project_comments').insert({
      project_id: id, content: content.trim(), parent_comment_id: parentId ?? null,
      admin_user_id: staffUser?.id ?? null, portal_user_id: staffUser ? null : (portalUser!.id),
      comment_type: staffUser ? 'staff' : 'user',
    })
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
    const text = `Vote for "${project?.display_name || project?.title}" — help it reach ${project?.vote_target ?? 'the'} votes! ${url}`
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: (project?.display_name || project?.title) ?? 'Vote for this project', text, url }); return } catch { /* user cancelled */ return }
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

  // One combined, clickable set — before/after first (they're a real
  // comparison pair, kept as their own labelled row), then whatever's in
  // the gallery — so the lightbox can step through all of it in order
  // regardless of which thumbnail was clicked first. Never populated at
  // all for health/medical (project.category === 'health' skips both the
  // fetch above and this list) — a real patient's photo is never shown.
  const allImages: { url: string; caption?: string }[] = [
    ...(project.before_image_url ? [{ url: project.before_image_url, caption: tr('pj.beforePhoto') }] : []),
    ...(project.after_image_url ? [{ url: project.after_image_url, caption: tr('pj.afterPhoto') }] : []),
    ...galleryPhotos.map((g) => ({ url: g.url, caption: g.caption ?? undefined })),
  ]
  const beforeIndex = project.before_image_url ? 0 : -1
  const afterIndex = project.after_image_url ? (project.before_image_url ? 1 : 0) : -1
  const galleryStartIndex = (project.before_image_url ? 1 : 0) + (project.after_image_url ? 1 : 0)

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <Link href="/projects" className="inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold hover:underline mb-6"><ArrowLeft size={16} /> {tr('x.allProjects')}</Link>

      <div className="mb-8">
        <span className="bg-dp-primary-container text-dp-on-primary-container px-3 py-1 rounded font-sans text-[12px] font-semibold uppercase tracking-[0.05em]">{isUrdu ? (CATEGORY_LABEL_UR[project.category ?? 'other'] ?? project.category) : project.category}</span>
        <h1 className="font-heading text-[28px] md:text-[32px] font-bold text-dp-primary mt-3">{project.display_name || project.title}</h1>
        {project.location && <p className="flex items-center gap-1 text-dp-on-surface-variant font-sans text-[15px] mt-1"><MapPin size={15} /> {isUrdu ? (project.location_ur || project.location) : project.location}</p>}
        <p className="font-sans text-[16px] text-dp-on-surface-variant mt-4 leading-[26px]">{project.description}</p>
      </div>

      {/* Photos — a health/medical project always uses the fixed generic
          cover (same rule /projects and the home page already follow); a
          real patient's before/after photo is never shown publicly, even
          if one happens to be uploaded. Everyone else shows whichever of
          before/after they actually have, side by side when both exist —
          this page never rendered either at all before, so an uploaded
          photo silently never appeared anywhere except the small listing
          thumbnail. */}
      {project.category === 'health' ? (
        <div className="mb-8 relative w-full h-64 rounded-lg overflow-hidden">
          <Image src="/images/health-project-cover.jpg" alt="" fill sizes="1000px" className="object-cover" />
        </div>
      ) : (
        <>
          {(project.before_image_url || project.after_image_url) && (
            <div className={`grid gap-3 mb-3 ${project.before_image_url && project.after_image_url ? 'grid-cols-2' : 'grid-cols-1'}`} dir={isUrdu ? 'rtl' : 'ltr'}>
              {project.before_image_url && (
                <div>
                  <button type="button" onClick={() => setLightboxIndex(beforeIndex)} className="relative w-full h-56 rounded-lg overflow-hidden bg-dp-surface-container cursor-pointer block">
                    <Image src={project.before_image_url} alt="" fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
                  </button>
                  {project.after_image_url && <p className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide mt-1.5">{tr('pj.beforePhoto')}</p>}
                </div>
              )}
              {project.after_image_url && (
                <div>
                  <button type="button" onClick={() => setLightboxIndex(afterIndex)} className="relative w-full h-56 rounded-lg overflow-hidden bg-dp-surface-container cursor-pointer block">
                    <Image src={project.after_image_url} alt="" fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
                  </button>
                  {project.before_image_url && <p className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide mt-1.5">{tr('pj.afterPhoto')}</p>}
                </div>
              )}
            </div>
          )}
          {galleryPhotos.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 mb-8">
              {galleryPhotos.map((g, i) => (
                <button key={g.id} type="button" onClick={() => setLightboxIndex(galleryStartIndex + i)}
                  className="relative aspect-square rounded-lg overflow-hidden bg-dp-surface-container cursor-pointer block hover:opacity-90 transition-opacity">
                  <Image src={g.url} alt={g.caption ?? ''} fill sizes="200px" className="object-cover" />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {lightboxIndex >= 0 && (
        <Lightbox images={allImages} index={lightboxIndex} onClose={() => setLightboxIndex(-1)} onNavigate={setLightboxIndex} />
      )}

      {introVideo && (
        <div className="mb-8">
          <VideoPlayer url={introVideo.video_url} title={introVideo.title} />
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('home.budget')}</p>
          <p className="font-heading text-[20px] font-bold text-dp-primary">{fmt(project.budget_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('x.verifiedRaised')}</p>
          <p className="font-heading text-[20px] font-bold text-dp-secondary">{fmt(totalVerified)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('x.announced')}</p>
          <p className="font-heading text-[20px] font-bold text-amber-600">{fmt(totalAnnounced)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{tr('home.spent')}</p>
          <p className="font-heading text-[20px] font-bold text-dp-error">{fmt(totalExpenses)}</p>
        </div>
      </div>

      {channels.length > 0 && (
        <div className="mb-8" dir={isUrdu ? 'rtl' : 'ltr'}>
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide mb-1.5" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('receivedVia')}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {channels.map((c) => (
              <p key={c.payment_method} className="font-sans text-[13.5px] text-dp-on-surface-variant">
                <span className="capitalize font-semibold text-dp-on-surface">{c.payment_method}</span>: {fmt(c.total_pkr)}
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
                <p className="font-sans text-[13px] text-blue-700 mt-1">Proposer committed {fmt(project.minimum_monthly_commitment_pkr)}/month once launched.</p>
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
      ) : project.status === 'completed' && project.funding_model !== 'recurring_support' ? (
        // Donations lock the moment a project is marked completed — a
        // one-time build doesn't need more money once it's done. The one
        // exception is recurring_support: a monthly salary/operating cost
        // keeps needing donors regardless of the build's own status.
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 mb-8 flex items-center gap-3">
          <CheckCircle size={22} className="text-emerald-600 shrink-0" />
          <div>
            <p className="font-heading text-[17px] font-bold text-emerald-800">{dt('completedNoMoreDonations')}</p>
            <p className="font-sans text-[13px] text-emerald-700 mt-0.5">{dt('completedNoMoreDonationsSub')}</p>
          </div>
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
          {joinableBatchCount > 0 && (
            <button
              onClick={() => router.push(portalUser ? `/portal/training-programs/join/${id}` : `/portal/login?next=/portal/training-programs/join/${id}`)}
              className="flex items-center gap-2 border-2 border-amber-600 text-amber-700 px-6 py-3 rounded-lg font-sans font-semibold hover:bg-amber-600 hover:text-white transition-all cursor-pointer"
            >
              <Users size={16} /> {tr('x.joinAcademyBtn')}
            </button>
          )}
        </div>
      )}

      {/* Batches, fees, sibling discount, slots — the same real detail the
          portal's Academies catalog shows, now visible to anyone deciding
          whether to join without first creating an account. */}
      {academyBatches.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-8" dir={isUrdu ? 'rtl' : 'ltr'}>
          <p className="font-sans text-[13.5px] font-bold text-dp-primary mb-3">{tr('x.batchesFeesTitle')}</p>
          <div className="space-y-3">
            {academyBatches.map((b) => {
              const ageRange = b.age_min != null || b.age_max != null
                ? b.age_min != null && b.age_max != null ? `${b.age_min}–${b.age_max}` : `${b.age_min ?? b.age_max}+`
                : null
              const full = b.spots_left === 0
              return (
                <div key={b.id} className="border border-dp-outline-variant/60 rounded-lg p-3.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{isUrdu && b.label_ur ? b.label_ur : b.label}</p>
                    {b.capacity != null && (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${full ? 'bg-dp-error/10 text-dp-error' : 'bg-emerald-100 text-emerald-700'}`}>
                        {full ? tr('x.batchFullLabel') : `${b.spots_left} ${tr('x.spotsLeftLabel')}`}
                      </span>
                    )}
                  </div>
                  {(b.schedule_note || ageRange) && (
                    <div className="flex items-center gap-3 mt-1 text-[12.5px] text-dp-on-surface-variant">
                      {b.schedule_note && <span className="flex items-center gap-1"><MapPin size={11} className="shrink-0" /> {isUrdu ? (b.schedule_note_ur || b.schedule_note) : b.schedule_note}</span>}
                      {ageRange && <span className="flex items-center gap-1"><Cake size={11} className="shrink-0" /> {tr('x.agesLabelFull')} {ageRange}</span>}
                    </div>
                  )}
                  {project.hide_fees ? (
                    <p className="mt-2 text-[13px] font-semibold text-dp-on-surface-variant">{tr('x.feeHiddenLabelFull')}</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] font-sans">
                      {(b.fee_villager_monthly_pkr || b.fee_villager_full_pkr) && (
                        <span className="text-dp-on-surface">{tr('x.villagerLabelFull')}: {fmt(b.fee_villager_monthly_pkr || b.fee_villager_full_pkr || 0)}{b.fee_villager_monthly_pkr ? `/${tr('x.perMonthFull')}` : ` ${tr('x.fullCourseFull')}`}</span>
                      )}
                      {(b.fee_outsider_monthly_pkr || b.fee_outsider_full_pkr) && (
                        <span className="text-dp-on-surface-variant">{tr('x.outsiderLabelFull')}: {fmt(b.fee_outsider_monthly_pkr || b.fee_outsider_full_pkr || 0)}{b.fee_outsider_monthly_pkr ? `/${tr('x.perMonthFull')}` : ` ${tr('x.fullCourseFull')}`}</span>
                      )}
                      {!b.fee_villager_monthly_pkr && !b.fee_villager_full_pkr && !b.fee_outsider_monthly_pkr && !b.fee_outsider_full_pkr && (
                        <span className="text-emerald-700 font-semibold">{tr('x.freeLabelFull')}</span>
                      )}
                    </div>
                  )}
                  {!project.hide_fees && b.sibling_discount_pct ? (
                    <p className="mt-1.5 text-[12px] font-semibold text-dp-secondary">{tr('x.siblingDiscountFull').replace('{pct}', String(b.sibling_discount_pct))}</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {trainer && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-8 flex items-center gap-4" dir={isUrdu ? 'rtl' : 'ltr'}>
          {trainer.trainer_photo_url ? (
            <div className="relative w-16 h-16 rounded-full overflow-hidden shrink-0 bg-dp-surface-container">
              <Image src={trainer.trainer_photo_url} alt="" fill sizes="64px" className="object-cover" />
            </div>
          ) : (
            <div className="w-16 h-16 rounded-full bg-dp-secondary-container text-dp-on-secondary-container flex items-center justify-center shrink-0 font-heading text-[22px] font-bold">
              {trainer.trainer_name.charAt(0)}
            </div>
          )}
          <div className="min-w-0">
            <p className="font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-wide">{tr('x.meetYourTrainerFull')}</p>
            <p className="font-sans text-[15px] font-semibold text-dp-on-surface">{trainer.trainer_name}</p>
            {(isUrdu ? trainer.trainer_bio_ur || trainer.trainer_bio : trainer.trainer_bio) && (
              <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">{isUrdu ? trainer.trainer_bio_ur || trainer.trainer_bio : trainer.trainer_bio}</p>
            )}
          </div>
        </div>
      )}

      {project.funding_model === 'recurring_support' && project.status !== 'announced' && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-8" dir={isUrdu ? 'rtl' : 'ltr'}>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <p className="font-sans text-[13.5px] font-bold text-dp-primary flex items-center gap-2"><Users size={16} className="text-dp-secondary" /> {tr('x.monthlySponsorship')}</p>
            <span className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full uppercase ${project.monthly_operating_cost_pkr && monthlySponsored >= project.monthly_operating_cost_pkr ? 'bg-dp-secondary text-white' : 'bg-amber-100 text-amber-700'}`}>
              {project.monthly_operating_cost_pkr && monthlySponsored >= project.monthly_operating_cost_pkr ? tr('x.fullySponsored') : tr('x.needsMoreSponsors')}
            </span>
          </div>
          <p className="font-sans text-[14px] text-dp-on-surface-variant ltr-num">
            {fmt(monthlySponsored)} / {fmt(project.monthly_operating_cost_pkr ?? 0)} {tr('x.committedPerMonth')}
          </p>
          <div className="h-2 w-full bg-dp-surface-container-low rounded-full overflow-hidden mt-2">
            <div className="h-full bg-dp-secondary" style={{ width: `${project.monthly_operating_cost_pkr ? Math.min(100, (monthlySponsored / project.monthly_operating_cost_pkr) * 100) : 0}%` }} />
          </div>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">
            {tr('x.monthlySponsorshipHint')}
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
                <span className="font-sans text-[14px] font-bold text-amber-600">{fmt(d.amount_pkr)}</span>
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
                <span className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(d.amount_pkr)}</span>
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
                <p className="font-sans text-[14px] font-bold text-dp-error">{fmt(e.debit)}</p>
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
          <textarea value={newComment} onChange={(e) => setNewComment(e.target.value)} rows={2}
            placeholder={staffUser ? `Commenting as ${staffUser.full_name} (${STAFF_ROLE_LABEL[staffUser.role] ?? staffUser.role})` : portalUser ? 'Share your thoughts...' : 'Log in to join the discussion'}
            disabled={!portalUser && !staffUser} className="input-field resize-none mb-2" />
          <button onClick={() => postComment()} disabled={postingComment || (!portalUser && !staffUser)} className="px-5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
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
          {c.comment_type === 'staff' ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold font-sans px-1.5 py-0.5 rounded-full bg-dp-primary/10 text-dp-primary whitespace-nowrap">
              <ShieldCheck size={10} /> {c.staff_role ? (STAFF_ROLE_LABEL[c.staff_role] ?? c.staff_role) : 'Staff'}
            </span>
          ) : (
            <DonorBadge tier={c.badge_tier} isUrdu={isUrdu} size="xs" iconOnly />
          )}
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
