'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { normalizePakPhone, nodeToPdfBlob, nodeToPngBlob, printBlob, downloadBlob, getPreferredFormat, setPreferredFormat, type ReceiptFormat } from '@/lib/receiptExport'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'
import { MultiImageUpload } from '@/components/admin/MultiImageUpload'
import { AgendaMinutesDocument, type AgendaMinutesData } from '@/components/admin/AgendaMinutesDocument'
import {
  CalendarClock, PlusCircle, X, ChevronDown, ChevronUp, CheckCircle2, MessageCircle,
  Printer, Download, Lightbulb, ListChecks, AlertTriangle, User, FileText, Sparkles, Loader2, Globe2, Reply,
  Siren, Copy, MessageSquareWarning, Vote,
} from 'lucide-react'

type Category = 'miscellaneous' | 'donation_projects' | 'medical' | 'tree_plantation' | 'water_supply'
const CATEGORY_ORDER: Category[] = ['miscellaneous', 'donation_projects', 'medical', 'tree_plantation', 'water_supply']
const CATEGORY_LABEL: Record<Category, string> = {
  miscellaneous: 'Miscellaneous', donation_projects: 'Donation & Projects', medical: 'Medical',
  tree_plantation: 'Tree Plantation', water_supply: 'Water Supply',
}

interface Meeting {
  id: string; meeting_date: string; title: string | null; run_by_admin_user_id: string
  agenda_photo_urls: string[] | null; created_at: string
}
interface CommitteeMember {
  id: string; name: string; position: string; phone: string | null
  admin_user_id: string | null; proxy_admin_user_id: string | null; uses_smartphone: boolean
}
interface AdminUserOpt { id: string; full_name: string }
interface AgendaItem {
  id: string; meeting_id: string; kind: 'task' | 'suggestion'; text_ur: string; display_order: number
  due_date: string | null; status: 'pending' | 'in_progress' | 'done'; done_at: string | null
  done_by_admin_user_id: string | null; raised_by_committee_member_id: string | null; raised_by_name: string | null
  raised_by_mobile: string | null; source_suggestion_id: string | null; carried_from_item_id: string | null
  carry_count: number; notes: string | null; category: Category | null
  reply_text: string | null; replied_at: string | null; replied_by_admin_user_id: string | null
  is_emergency: boolean; created_by_admin_user_id: string | null
}
interface Assignee { id: string; agenda_item_id: string; committee_member_id: string }
interface ComplaintHistoryEntry {
  id: string; complaint_number: string | null; complainant_name: string | null; sector: string | null
  complaint_text: string; status: 'open' | 'awaiting_verification' | 'verified'
  incharge_name: string | null; resolved_by_name: string | null; resolved_at: string | null; created_at: string
}
interface WebsiteSuggestion { id: string; name: string | null; mobile: string | null; message: string; created_at: string }
interface ReadyProposal { id: string; title: string; description: string | null; voteCount: number; vote_target: number | null; minimum_monthly_commitment_pkr: number | null }
interface ProjectDiscussionComment { username: string | null; content: string; comment_type: string; created_at: string }
interface ProjectDiscussion { id: string; title: string; status: string; vote_count: number; vote_target: number | null; comments: ProjectDiscussionComment[] }
interface ExtractedPoint { text: string; include: boolean; due_date: string; committee_member_ids: string[]; category: Category }

const emptyMeetingForm = { meeting_date: new Date().toISOString().slice(0, 10), title: '', run_by_admin_user_id: '', agenda_photo_urls: [] as string[] }
const emptyTaskForm = { text_ur: '', due_date: '', committee_member_ids: [] as string[], category: 'miscellaneous' as Category }
const emptySuggestionForm = { text_ur: '', raised_by_committee_member_id: '' }

export default function MeetingsAgendaPage() {
  const supabase = createClient()
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [members, setMembers] = useState<CommitteeMember[]>([])
  const [adminUsers, setAdminUsers] = useState<AdminUserOpt[]>([])
  const [items, setItems] = useState<AgendaItem[]>([])
  const [assignees, setAssignees] = useState<Assignee[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [branding, setBranding] = useState<Partial<BrandingSettings>>({})
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [printMeetingId, setPrintMeetingId] = useState<string | null>(null)
  const [format, setFormat] = useState<ReceiptFormat>(getPreferredFormat())
  const docRef = useRef<HTMLDivElement>(null)

  const [showMeetingForm, setShowMeetingForm] = useState(false)
  const [meetingForm, setMeetingForm] = useState(emptyMeetingForm)
  const [savingMeeting, setSavingMeeting] = useState(false)

  const [taskMeetingId, setTaskMeetingId] = useState<string | null>(null)
  const [taskForm, setTaskForm] = useState(emptyTaskForm)
  const [savingTask, setSavingTask] = useState(false)

  const [suggestionMeetingId, setSuggestionMeetingId] = useState<string | null>(null)
  const [suggestionForm, setSuggestionForm] = useState(emptySuggestionForm)
  const [savingSuggestion, setSavingSuggestion] = useState(false)

  const [extractMeetingId, setExtractMeetingId] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractedPoints, setExtractedPoints] = useState<ExtractedPoint[]>([])
  const [savingExtracted, setSavingExtracted] = useState(false)

  const [importMeetingId, setImportMeetingId] = useState<string | null>(null)
  const [websiteSuggestions, setWebsiteSuggestions] = useState<WebsiteSuggestion[]>([])
  const [readyProposals, setReadyProposals] = useState<ReadyProposal[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)

  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [savingReply, setSavingReply] = useState<string | null>(null)

  const [emergencyMeetingId, setEmergencyMeetingId] = useState<string | null>(null)
  const [emergencyText, setEmergencyText] = useState('')
  const [savingEmergency, setSavingEmergency] = useState(false)

  const [complaints, setComplaints] = useState<ComplaintHistoryEntry[]>([])
  const [showResolvedComplaints, setShowResolvedComplaints] = useState(false)
  const [complaintsOpen, setComplaintsOpen] = useState(false)

  const [projectDiscussions, setProjectDiscussions] = useState<ProjectDiscussion[]>([])
  const [projectDiscussionsOpen, setProjectDiscussionsOpen] = useState(false)

  const load = async () => {
    const [meetingsRes, membersRes, adminUsersRes, itemsRes, assigneesRes, userRes, complaintsRes] = await Promise.all([
      supabase.from('agenda_meetings').select('*').order('meeting_date', { ascending: false }),
      supabase.from('committee_members').select('id, name, position, phone, admin_user_id, proxy_admin_user_id, uses_smartphone').order('display_order'),
      supabase.from('admin_users').select('id, full_name').eq('is_active', true).order('full_name'),
      supabase.from('agenda_items').select('*').order('display_order'),
      supabase.from('agenda_item_assignees').select('*'),
      supabase.auth.getUser(),
      // Cross-meeting reference, not scoped to one meeting_id — committee
      // members should see "what's the state of all complaints" during
      // discussion, not just ones raised in a specific past meeting.
      supabase.from('complaints').select('id, complaint_number, complainant_name, sector, complaint_text, status, assigned_to, resolved_by, resolved_at, created_at').order('created_at', { ascending: false }),
    ])
    setMeetings(meetingsRes.data ?? [])
    setMembers(membersRes.data ?? [])
    setAdminUsers(adminUsersRes.data ?? [])
    setItems(itemsRes.data ?? [])
    setAssignees(assigneesRes.data ?? [])
    if (userRes.data.user) {
      const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', userRes.data.user.id).single()
      setCurrentUserId(me?.id ?? null)
    }
    const adminList = adminUsersRes.data ?? []
    const nameFor = (id: string | null) => adminList.find((a) => a.id === id)?.full_name ?? null
    setComplaints((complaintsRes.data ?? []).map((c) => ({
      ...c, incharge_name: nameFor(c.assigned_to), resolved_by_name: nameFor(c.resolved_by),
    })))

    // Same cross-meeting live-join idea as complaints above, but for
    // proposals still being decided (upcoming = voting, reviewing =
    // committee deciding budget) — so the committee sees the community's
    // votes and comments verbatim during discussion, not a stale import.
    const { data: discussionProjects } = await supabase
      .from('projects').select('id, title, status, vote_target')
      .in('status', ['upcoming', 'reviewing']).order('created_at', { ascending: false })
    if (discussionProjects && discussionProjects.length > 0) {
      const ids = discussionProjects.map((p) => p.id)
      const [commentsRes, votesRes] = await Promise.all([
        supabase.from('project_comments_public').select('project_id, username, content, comment_type, created_at').in('project_id', ids).order('created_at', { ascending: true }),
        supabase.from('project_votes').select('project_id').in('project_id', ids),
      ])
      const voteCounts: Record<string, number> = {}
      for (const v of votesRes.data ?? []) voteCounts[v.project_id] = (voteCounts[v.project_id] ?? 0) + 1
      const commentsByProject: Record<string, ProjectDiscussionComment[]> = {}
      for (const c of commentsRes.data ?? []) {
        if (!commentsByProject[c.project_id]) commentsByProject[c.project_id] = []
        commentsByProject[c.project_id].push(c)
      }
      setProjectDiscussions(discussionProjects.map((p) => ({
        id: p.id, title: p.title, status: p.status, vote_target: p.vote_target,
        vote_count: voteCounts[p.id] ?? 0, comments: commentsByProject[p.id] ?? [],
      })))
    } else {
      setProjectDiscussions([])
    }

    setLoading(false)
  }
  useEffect(() => { load(); fetchBrandingSettings().then(setBranding) }, [])

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.name ?? 'Unknown'
  const adminName = (id: string | null) => adminUsers.find((a) => a.id === id)?.full_name ?? null
  const itemsFor = (meetingId: string, kind: 'task' | 'suggestion') => items.filter((i) => i.meeting_id === meetingId && i.kind === kind)
  const assigneesFor = (itemId: string) => assignees.filter((a) => a.agenda_item_id === itemId).map((a) => a.committee_member_id)

  // Who actually acts for a member: their own login if set, else their fixed
  // proxy, else whoever is running this meeting — mirrors resolve_agenda_assignee().
  const resolveAssignee = (committeeMemberId: string, meeting: Meeting) => {
    const m = members.find((x) => x.id === committeeMemberId)
    return m?.admin_user_id || m?.proxy_admin_user_id || meeting.run_by_admin_user_id
  }
  const canMarkDone = (item: AgendaItem, meeting: Meeting) => {
    if (!currentUserId) return false
    return assigneesFor(item.id).some((cmId) => resolveAssignee(cmId, meeting) === currentUserId)
  }

  const openNewMeeting = () => {
    setMeetingForm({ ...emptyMeetingForm, run_by_admin_user_id: currentUserId ?? '' })
    setShowMeetingForm(true)
  }

  const saveMeeting = async () => {
    if (!meetingForm.meeting_date || !meetingForm.run_by_admin_user_id) { toast.error('Meeting date and who is running it are required'); return }
    setSavingMeeting(true)
    const { data: meeting, error } = await supabase.from('agenda_meetings').insert({
      meeting_date: meetingForm.meeting_date, title: meetingForm.title || null,
      run_by_admin_user_id: meetingForm.run_by_admin_user_id, agenda_photo_urls: meetingForm.agenda_photo_urls.length ? meetingForm.agenda_photo_urls : null,
    }).select('id').single()
    if (error || !meeting) { toast.error(error?.message ?? 'Failed to create meeting'); setSavingMeeting(false); return }

    const { data: carried, error: carryErr } = await supabase.rpc('carry_forward_meeting', { p_new_meeting_id: meeting.id })
    setSavingMeeting(false)
    setShowMeetingForm(false)
    if (carryErr) toast.error(`Meeting created, but carry-forward failed: ${carryErr.message}`)
    else toast.success(carried > 0 ? `Meeting created — ${carried} unfinished task(s) carried forward` : 'Meeting created')
    setExpanded(meeting.id)
    load()
  }

  const openAddTask = (meetingId: string) => { setTaskForm(emptyTaskForm); setTaskMeetingId(meetingId) }
  const saveTask = async () => {
    if (!taskMeetingId) return
    if (!taskForm.text_ur.trim()) { toast.error('Enter the agenda point'); return }
    if (taskForm.committee_member_ids.length === 0) { toast.error('Assign to at least one member'); return }
    setSavingTask(true)
    const { data: item, error } = await supabase.from('agenda_items').insert({
      meeting_id: taskMeetingId, kind: 'task', text_ur: taskForm.text_ur.trim(), due_date: taskForm.due_date || null,
      category: taskForm.category,
    }).select('id').single()
    if (error || !item) { toast.error(error?.message ?? 'Failed to add task'); setSavingTask(false); return }
    const { error: assignErr } = await supabase.from('agenda_item_assignees')
      .insert(taskForm.committee_member_ids.map((cmId) => ({ agenda_item_id: item.id, committee_member_id: cmId })))
    setSavingTask(false)
    if (assignErr) { toast.error(assignErr.message); return }
    toast.success('Task allocated')
    setTaskMeetingId(null)
    load()
  }

  const openAddSuggestion = (meetingId: string) => { setSuggestionForm(emptySuggestionForm); setSuggestionMeetingId(meetingId) }
  const saveSuggestion = async () => {
    if (!suggestionMeetingId) return
    if (!suggestionForm.text_ur.trim()) { toast.error('Enter the suggestion'); return }
    setSavingSuggestion(true)
    const { error } = await supabase.from('agenda_items').insert({
      meeting_id: suggestionMeetingId, kind: 'suggestion', text_ur: suggestionForm.text_ur.trim(),
      raised_by_committee_member_id: suggestionForm.raised_by_committee_member_id || null,
    })
    setSavingSuggestion(false)
    if (error) { toast.error(error.message); return }
    toast.success('Suggestion recorded')
    setSuggestionMeetingId(null)
    load()
  }

  // AI extraction is correction-only: it drafts editable Urdu text, nothing
  // is written to the database until "Save Selected" below is clicked.
  const openExtract = async (meeting: Meeting) => {
    if (!meeting.agenda_photo_urls?.length) return
    setExtractMeetingId(meeting.id)
    setExtracting(true)
    setExtractedPoints([])
    try {
      const res = await fetch('/api/admin/agenda/extract', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoUrls: meeting.agenda_photo_urls }),
      })
      const body = await res.json()
      if (!res.ok) { toast.error(body.error ?? 'AI extraction failed'); setExtractMeetingId(null); return }
      if (!body.points?.length) { toast.error('No agenda points detected in the photo(s)'); setExtractMeetingId(null); return }
      setExtractedPoints(body.points.map((text: string) => ({ text, include: true, due_date: '', committee_member_ids: [], category: 'miscellaneous' as Category })))
    } catch {
      toast.error('Could not reach the AI extraction service')
      setExtractMeetingId(null)
    } finally {
      setExtracting(false)
    }
  }
  const updateExtracted = (i: number, patch: Partial<ExtractedPoint>) => {
    setExtractedPoints((prev) => prev.map((p, idx) => idx === i ? { ...p, ...patch } : p))
  }
  const saveExtractedPoints = async () => {
    if (!extractMeetingId) return
    const toSave = extractedPoints.filter((p) => p.include && p.text.trim())
    if (toSave.length === 0) { toast.error('Include at least one point'); return }
    if (toSave.some((p) => p.committee_member_ids.length === 0)) { toast.error('Assign every included point to at least one member'); return }
    setSavingExtracted(true)
    for (const p of toSave) {
      const { data: item, error } = await supabase.from('agenda_items').insert({
        meeting_id: extractMeetingId, kind: 'task', text_ur: p.text.trim(), due_date: p.due_date || null, category: p.category,
      }).select('id').single()
      if (error || !item) { toast.error(error?.message ?? 'Failed to save a point'); continue }
      await supabase.from('agenda_item_assignees').insert(p.committee_member_ids.map((cmId) => ({ agenda_item_id: item.id, committee_member_id: cmId })))
    }
    setSavingExtracted(false)
    toast.success(`${toSave.length} point(s) added`)
    setExtractMeetingId(null)
    load()
  }

  const openImportSuggestions = async (meetingId: string) => {
    setImportMeetingId(meetingId)
    setLoadingSuggestions(true)
    // Queried fresh rather than filtered against the `items` React state —
    // that state can still be mid-fetch right after a page load/reload,
    // which would let an already-imported suggestion slip through and get
    // duplicated (no DB-level uniqueness on source_suggestion_id).
    const [suggestionsRes, importedRes, upcomingRes, importedProjectsRes] = await Promise.all([
      supabase.from('suggestions').select('id, name, mobile, message, created_at').eq('type', 'suggestion').order('created_at', { ascending: false }),
      supabase.from('agenda_items').select('source_suggestion_id').not('source_suggestion_id', 'is', null),
      supabase.from('projects').select('id, title, description, vote_target, minimum_monthly_commitment_pkr').eq('status', 'upcoming'),
      supabase.from('agenda_items').select('source_project_id').not('source_project_id', 'is', null),
    ])
    const alreadyImported = new Set((importedRes.data ?? []).map((i) => i.source_suggestion_id))
    setWebsiteSuggestions((suggestionsRes.data ?? []).filter((s) => !alreadyImported.has(s.id)))

    const alreadyImportedProjects = new Set((importedProjectsRes.data ?? []).map((i) => i.source_project_id))
    const upcoming = (upcomingRes.data ?? []).filter((p) => !alreadyImportedProjects.has(p.id))
    if (upcoming.length > 0) {
      const { data: voteRows } = await supabase.from('project_votes').select('project_id').in('project_id', upcoming.map((p) => p.id))
      const counts: Record<string, number> = {}
      for (const v of voteRows ?? []) counts[v.project_id] = (counts[v.project_id] ?? 0) + 1
      setReadyProposals(
        upcoming
          .filter((p) => p.vote_target != null && (counts[p.id] ?? 0) >= p.vote_target)
          .map((p) => ({ id: p.id, title: p.title, description: p.description, voteCount: counts[p.id] ?? 0, vote_target: p.vote_target, minimum_monthly_commitment_pkr: p.minimum_monthly_commitment_pkr }))
      )
    } else {
      setReadyProposals([])
    }
    setLoadingSuggestions(false)
  }
  const importSuggestion = async (s: WebsiteSuggestion) => {
    if (!importMeetingId) return
    const { error } = await supabase.from('agenda_items').insert({
      meeting_id: importMeetingId, kind: 'suggestion', text_ur: s.message, raised_by_name: s.name || 'Anonymous',
      raised_by_mobile: s.mobile || null, source_suggestion_id: s.id,
    })
    if (error) { toast.error(error.message); return }
    await supabase.from('suggestions').update({ status: 'actioned' }).eq('id', s.id)
    setWebsiteSuggestions((prev) => prev.filter((x) => x.id !== s.id))
    toast.success('Added to agenda')
    load()
  }
  // Vote-threshold-reached proposals — surfaced for committee discussion
  // only. Approving/setting a budget still happens via the existing admin
  // Projects page (status upcoming -> ongoing); importing here doesn't
  // decide anything on its own.
  const importProposal = async (p: ReadyProposal) => {
    if (!importMeetingId) return
    const text = `${p.title} — ${p.voteCount}/${p.vote_target} votes reached.${p.description ? ` ${p.description}` : ''}${p.minimum_monthly_commitment_pkr ? ` Proposer committed Rs. ${p.minimum_monthly_commitment_pkr}/month.` : ''}`
    const { error } = await supabase.from('agenda_items').insert({
      meeting_id: importMeetingId, kind: 'task', category: 'donation_projects', text_ur: text, source_project_id: p.id,
    })
    if (error) { toast.error(error.message); return }
    setReadyProposals((prev) => prev.filter((x) => x.id !== p.id))
    toast.success('Added to agenda')
    load()
  }

  const markDone = async (item: AgendaItem) => {
    const { error } = await supabase.rpc('mark_agenda_item_done', { p_item_id: item.id })
    if (error) { toast.error(error.message); return }
    toast.success('Marked done')
    load()
  }

  const sendWhatsApp = (item: AgendaItem, meeting: Meeting, committeeMemberId: string) => {
    const member = members.find((m) => m.id === committeeMemberId)
    if (!member) return
    const actingProxy = !member.admin_user_id && member.proxy_admin_user_id
    const phone = member.phone
    const intl = phone ? normalizePakPhone(phone) : null
    if (!intl) { toast.error(`No phone number on file for ${member.name}`); return }
    const lines = [
      `*Dhab Pari Committee — Meeting Task*`,
      actingProxy ? `For: ${member.name} (via you as proxy)` : `Dear ${member.name},`,
      item.text_ur,
      item.due_date ? `Due: ${new Date(item.due_date).toLocaleDateString('en-GB')}` : '',
      meeting.title ? `Meeting: ${meeting.title}` : '',
    ].filter(Boolean).join('\n')
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(lines)}`, '_blank')
  }

  // Emergency job: an ad-hoc urgent task raised outside the normal per-meeting
  // allocation flow, broadcast to every committee member at once. Reuses
  // agenda_item_assignees/mark_agenda_item_done/the assignment notification
  // trigger completely unchanged — "broadcast to everyone" is just "assign
  // every committee member," which those already handle correctly.
  const openEmergencyJob = () => { setEmergencyText(''); setEmergencyMeetingId(meetings[0]?.id ?? null) }
  const raiseEmergencyJob = async () => {
    if (!emergencyMeetingId || !currentUserId) return
    if (!emergencyText.trim()) { toast.error('Enter the job description'); return }
    setSavingEmergency(true)
    const { data: item, error } = await supabase.from('agenda_items').insert({
      meeting_id: emergencyMeetingId, kind: 'task', text_ur: emergencyText.trim(),
      is_emergency: true, created_by_admin_user_id: currentUserId,
    }).select('id').single()
    if (error || !item) { toast.error(error?.message ?? 'Failed to raise emergency job'); setSavingEmergency(false); return }
    const { error: assignErr } = await supabase.from('agenda_item_assignees')
      .insert(members.map((m) => ({ agenda_item_id: item.id, committee_member_id: m.id })))
    setSavingEmergency(false)
    if (assignErr) { toast.error(assignErr.message); return }
    toast.success('Emergency job broadcast to all members')
    setEmergencyMeetingId(null)
    load()
  }

  const sendEmergencyWhatsApp = (item: AgendaItem, committeeMemberId: string) => {
    const member = members.find((m) => m.id === committeeMemberId)
    if (!member) return
    const actingProxy = !member.admin_user_id && member.proxy_admin_user_id
    const intl = member.phone ? normalizePakPhone(member.phone) : null
    if (!intl) { toast.error(`No phone number on file for ${member.name}`); return }
    const lines = [
      `*🚨 Dhab Pari Committee — Emergency Job*`,
      actingProxy ? `For: ${member.name} (via you as proxy)` : `Dear ${member.name},`,
      item.text_ur,
      `Called by: ${adminName(item.created_by_admin_user_id) ?? 'Committee'}`,
    ].join('\n')
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(lines)}`, '_blank')
  }

  const copyEmergencyMessage = async (item: AgendaItem) => {
    const lines = [
      `🚨 Dhab Pari Committee — Emergency Job`,
      item.text_ur,
      `Called by: ${adminName(item.created_by_admin_user_id) ?? 'Committee'}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(lines)
      toast.success('Copied — paste into the committee WhatsApp group')
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  // Reply works the same regardless of origin — a committee-member-raised
  // suggestion had no reply path at all before this, and a website-raised one
  // only had a broken one (/admin/suggestions' old "Send Reply" just logged to
  // notifications_log, a placeholder nothing ever sent from). Saving here also
  // appends to the linked suggestions row (same format that page already
  // used) so the two views don't silently diverge.
  const saveReply = async (item: AgendaItem, text: string) => {
    if (!text.trim() || !currentUserId) return
    setSavingReply(item.id)
    const { error } = await supabase.from('agenda_items').update({
      reply_text: text.trim(), replied_at: new Date().toISOString(), replied_by_admin_user_id: currentUserId,
    }).eq('id', item.id)
    if (error) { toast.error(error.message); setSavingReply(null); return }

    if (item.source_suggestion_id) {
      const { data: src } = await supabase.from('suggestions').select('admin_notes, status').eq('id', item.source_suggestion_id).single()
      const notes = src?.admin_notes
        ? `${src.admin_notes}\n\n--- Reply (${new Date().toLocaleDateString()}) ---\n${text.trim()}`
        : `--- Reply (${new Date().toLocaleDateString()}) ---\n${text.trim()}`
      await supabase.from('suggestions').update({
        admin_notes: notes, status: src?.status === 'actioned' ? 'actioned' : 'reviewed',
      }).eq('id', item.source_suggestion_id)
    }

    setSavingReply(null)
    toast.success('Reply saved')
    load()
  }

  const sendReplyWhatsApp = (item: AgendaItem) => {
    if (!item.reply_text) return
    const phone = item.raised_by_committee_member_id
      ? members.find((m) => m.id === item.raised_by_committee_member_id)?.phone
      : item.raised_by_mobile
    const intl = phone ? normalizePakPhone(phone) : null
    if (!intl) { toast.error('No phone number on file for this suggestion'); return }
    const name = item.raised_by_committee_member_id ? memberName(item.raised_by_committee_member_id) : (item.raised_by_name || 'there')
    const lines = [`*Dhab Pari Committee*`, `Dear ${name}, regarding your suggestion:`, `"${item.text_ur}"`, ``, item.reply_text].join('\n')
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(lines)}`, '_blank')
  }

  const carriedBadge = (item: AgendaItem) => item.carry_count >= 3
    ? <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700"><AlertTriangle size={11} /> Stuck ({item.carry_count}x)</span>
    : item.carry_count > 0
      ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">Carried {item.carry_count}x</span>
      : null

  const statusStyles: Record<AgendaItem['status'], string> = {
    pending: 'bg-gray-100 text-gray-700', in_progress: 'bg-blue-100 text-blue-800', done: 'bg-emerald-100 text-emerald-700',
  }
  const complaintStatusStyles: Record<ComplaintHistoryEntry['status'], string> = {
    open: 'bg-red-100 text-red-700', awaiting_verification: 'bg-amber-100 text-amber-800', verified: 'bg-emerald-100 text-emerald-700',
  }
  const complaintStatusLabel: Record<ComplaintHistoryEntry['status'], string> = {
    open: 'Open', awaiting_verification: 'Resolved — Awaiting Verification', verified: 'Resolved & Verified',
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="font-heading text-[26px] sm:text-[32px] font-bold text-dp-primary flex items-center gap-2.5">
          <CalendarClock size={28} /> Meetings &amp; Agenda
        </h1>
        <div className="flex items-center gap-2">
          {meetings.length > 0 && (
            <button onClick={openEmergencyJob} className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-red-700 transition-all cursor-pointer">
              <Siren size={16} /> Raise Emergency Job
            </button>
          )}
          <button onClick={openNewMeeting} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <PlusCircle size={16} /> New Meeting
          </button>
        </div>
      </div>

      {/* Complaints Status — a cross-meeting reference, not scoped to any one
          meeting, so the committee has the real current state (who's
          incharge, resolved-by-whom) to discuss, not a list that goes stale
          the moment a complaint is handled after this meeting was logged. */}
      {!loading && complaints.length > 0 && (() => {
        const visible = showResolvedComplaints ? complaints : complaints.filter((c) => c.status !== 'verified')
        return (
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-4">
            <button onClick={() => setComplaintsOpen(!complaintsOpen)} className="w-full flex items-center justify-between gap-3 p-4 text-left cursor-pointer hover:bg-dp-surface-container-low transition-all">
              <p className="font-sans text-[14px] font-bold text-dp-on-surface flex items-center gap-2">
                <MessageSquareWarning size={16} className="text-amber-600" /> Complaints Status
                <span className="font-normal text-dp-on-surface-variant text-[12.5px]">({visible.length}{!showResolvedComplaints ? ' open/pending' : ''})</span>
              </p>
              {complaintsOpen ? <ChevronUp size={18} className="shrink-0 text-dp-on-surface-variant" /> : <ChevronDown size={18} className="shrink-0 text-dp-on-surface-variant" />}
            </button>
            {complaintsOpen && (
              <div className="border-t border-dp-outline-variant p-4 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" checked={showResolvedComplaints} onChange={(e) => setShowResolvedComplaints(e.target.checked)} className="accent-dp-secondary" />
                  <span className="font-sans text-[12.5px] text-dp-on-surface-variant">Show resolved &amp; verified too</span>
                </label>
                {visible.length === 0 ? (
                  <p className="font-sans text-[13px] text-dp-on-surface-variant">Nothing open — all complaints are resolved and verified.</p>
                ) : (
                  visible.map((c) => (
                    <div key={c.id} className="border border-dp-outline-variant rounded-lg p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">
                          {c.complaint_number ? `${c.complaint_number} — ` : ''}{c.complainant_name ?? 'Unknown'}{c.sector ? ` (Sector ${c.sector})` : ''}
                        </p>
                        <span className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold shrink-0 ${complaintStatusStyles[c.status]}`}>{complaintStatusLabel[c.status]}</span>
                      </div>
                      <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">{c.complaint_text}</p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                        {c.status === 'verified'
                          ? <>Resolved by <span className="font-semibold">{c.resolved_by_name ?? 'Unknown'}</span>{c.resolved_at ? ` on ${new Date(c.resolved_at).toLocaleDateString('en-GB')}` : ''}</>
                          : <>Incharge: <span className="font-semibold">{c.incharge_name ?? 'Not yet assigned'}</span></>}
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* Project Proposals & Discussions — same cross-meeting live-join idea
          as Complaints Status: shows the community's votes and comments for
          every proposal still in play, verbatim and with names, so the
          committee can decide with full visibility during the meeting. */}
      {!loading && projectDiscussions.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-4">
          <button onClick={() => setProjectDiscussionsOpen(!projectDiscussionsOpen)} className="w-full flex items-center justify-between gap-3 p-4 text-left cursor-pointer hover:bg-dp-surface-container-low transition-all">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface flex items-center gap-2">
              <Vote size={16} className="text-dp-secondary" /> Project Proposals &amp; Discussions
              <span className="font-normal text-dp-on-surface-variant text-[12.5px]">({projectDiscussions.length})</span>
            </p>
            {projectDiscussionsOpen ? <ChevronUp size={18} className="shrink-0 text-dp-on-surface-variant" /> : <ChevronDown size={18} className="shrink-0 text-dp-on-surface-variant" />}
          </button>
          {projectDiscussionsOpen && (
            <div className="border-t border-dp-outline-variant p-4 space-y-3">
              {projectDiscussions.map((p) => (
                <div key={p.id} className="border border-dp-outline-variant rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{p.title}</p>
                    <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold shrink-0 bg-dp-surface-container-low text-dp-on-surface-variant">
                      {p.status === 'upcoming' ? `${p.vote_count}/${p.vote_target ?? '?'} votes` : 'Committee Reviewing'}
                    </span>
                  </div>
                  {p.comments.length === 0 ? (
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5">No comments yet.</p>
                  ) : (
                    <div className="mt-1.5 space-y-1">
                      {p.comments.map((c, i) => (
                        <p key={i} className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          <span className={`font-semibold ${c.comment_type === 'system' ? 'text-dp-secondary' : 'text-dp-on-surface'}`}>{c.username ?? 'Unknown'}:</span> {c.content}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="font-sans text-dp-on-surface-variant py-8 text-center">Loading...</p>
      ) : meetings.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">No meetings logged yet. Start with "New Meeting" after your next committee sitting.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {meetings.map((meeting) => {
            const allTasks = itemsFor(meeting.id, 'task')
            const tasks = allTasks.filter((t) => !t.is_emergency)
            const emergencyJobs = allTasks.filter((t) => t.is_emergency)
            const suggestions = itemsFor(meeting.id, 'suggestion')
            const isOpen = expanded === meeting.id
            const isLatest = meeting.id === meetings[0].id
            return (
              <div key={meeting.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                <button onClick={() => setExpanded(isOpen ? null : meeting.id)} className="w-full flex items-center justify-between gap-3 p-4 text-left cursor-pointer hover:bg-dp-surface-container-low transition-all">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-sans text-[15px] font-bold text-dp-on-surface">
                        {new Date(meeting.meeting_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                        {meeting.title ? ` — ${meeting.title}` : ''}
                      </p>
                      {isLatest && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-dp-secondary-container text-dp-on-secondary-container">Current</span>}
                    </div>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      Run by {adminName(meeting.run_by_admin_user_id) ?? 'Unknown'} · {tasks.filter((t) => t.status === 'done').length}/{tasks.length} tasks done · {suggestions.length} suggestion(s)
                    </p>
                  </div>
                  {isOpen ? <ChevronUp size={18} className="shrink-0 text-dp-on-surface-variant" /> : <ChevronDown size={18} className="shrink-0 text-dp-on-surface-variant" />}
                </button>

                {isOpen && (
                  <div className="border-t border-dp-outline-variant p-4 space-y-5">
                    {meeting.agenda_photo_urls && meeting.agenda_photo_urls.length > 0 && (
                      <div className="grid grid-cols-4 gap-2">
                        {meeting.agenda_photo_urls.map((url, i) => (
                          <a key={i} href={url} target="_blank" rel="noreferrer" className="block rounded-lg overflow-hidden border border-dp-outline-variant aspect-square">
                            <img src={url} alt="Agenda scan" className="w-full h-full object-cover" />
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Tasks */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] flex items-center gap-1.5"><ListChecks size={14} /> Tasks</p>
                        <div className="flex items-center gap-3">
                          {meeting.agenda_photo_urls && meeting.agenda_photo_urls.length > 0 && (
                            <button onClick={() => openExtract(meeting)} className="flex items-center gap-1 text-[12.5px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer">
                              <Sparkles size={13} /> Extract with AI
                            </button>
                          )}
                          <button onClick={() => openAddTask(meeting.id)} className="text-[12.5px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer">+ Add Point</button>
                        </div>
                      </div>
                      {tasks.length === 0 ? (
                        <p className="font-sans text-[13px] text-dp-on-surface-variant">No tasks yet.</p>
                      ) : (
                        <div className="space-y-4">
                          {CATEGORY_ORDER.map((cat) => {
                            const catTasks = tasks.filter((t) => (t.category ?? 'miscellaneous') === cat)
                            if (catTasks.length === 0) return null
                            return (
                              <div key={cat}>
                                <p className="font-sans text-[11px] font-bold text-dp-secondary uppercase tracking-[0.05em] mb-1.5">{CATEGORY_LABEL[cat]}</p>
                                <div className="space-y-2">
                                  {catTasks.map((item) => (
                                    <div key={item.id} className="border border-dp-outline-variant rounded-lg p-3">
                                      <div className="flex items-start justify-between gap-2">
                                        <p className="font-sans text-[14px] text-dp-on-surface flex-1" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{item.text_ur}</p>
                                        <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold ${statusStyles[item.status]}`}>{item.status.replace('_', ' ')}</span>
                                      </div>
                                      <div className="flex items-center flex-wrap gap-1.5 mt-2">
                                        {carriedBadge(item)}
                                        {item.due_date && <span className="text-[11.5px] font-sans text-dp-on-surface-variant">Due {new Date(item.due_date).toLocaleDateString('en-GB')}</span>}
                                      </div>
                                      <div className="flex items-center flex-wrap gap-2 mt-2">
                                        {assigneesFor(item.id).map((cmId) => (
                                          <div key={cmId} className="flex items-center gap-1 bg-dp-surface-container-low rounded-full pl-2 pr-1 py-0.5">
                                            <User size={11} className="text-dp-on-surface-variant" />
                                            <span className="font-sans text-[11.5px] text-dp-on-surface">{memberName(cmId)}</span>
                                            <button onClick={() => sendWhatsApp(item, meeting, cmId)} title="Send WhatsApp reminder" className="p-1 text-green-600 hover:bg-green-50 rounded-full cursor-pointer">
                                              <MessageCircle size={12} />
                                            </button>
                                          </div>
                                        ))}
                                      </div>
                                      {item.status !== 'done' && (currentUserId && canMarkDone(item, meeting) ? (
                                        <button onClick={() => markDone(item)} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                                          <CheckCircle2 size={13} /> Mark Done
                                        </button>
                                      ) : (
                                        <button onClick={() => markDone(item)} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-surface-container-low transition-all cursor-pointer">
                                          <CheckCircle2 size={13} /> Mark Done (admin override)
                                        </button>
                                      ))}
                                      {item.status === 'done' && item.done_by_admin_user_id && (
                                        <p className="font-sans text-[11.5px] text-emerald-700 mt-1.5">Done by {adminName(item.done_by_admin_user_id) ?? 'Unknown'}{item.done_at ? ` on ${new Date(item.done_at).toLocaleDateString('en-GB')}` : ''}</p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/* Suggestions — committee-member-raised first, website-raised last */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] flex items-center gap-1.5"><Lightbulb size={14} /> Suggestions</p>
                        <div className="flex items-center gap-3">
                          <button onClick={() => openImportSuggestions(meeting.id)} className="flex items-center gap-1 text-[12.5px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer">
                            <Globe2 size={13} /> Import from Website
                          </button>
                          <button onClick={() => openAddSuggestion(meeting.id)} className="text-[12.5px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer">+ Add Suggestion</button>
                        </div>
                      </div>
                      {suggestions.length === 0 ? (
                        <p className="font-sans text-[13px] text-dp-on-surface-variant">No suggestions recorded for this meeting.</p>
                      ) : (
                        <div className="space-y-2">
                          {[...suggestions].sort((a, b) => (a.raised_by_committee_member_id ? 0 : 1) - (b.raised_by_committee_member_id ? 0 : 1)).map((s) => {
                            const phone = s.raised_by_committee_member_id ? members.find((m) => m.id === s.raised_by_committee_member_id)?.phone : s.raised_by_mobile
                            return (
                              <div key={s.id} className="border border-dp-outline-variant rounded-lg p-3">
                                <p className="font-sans text-[14px] text-dp-on-surface" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{s.text_ur}</p>
                                {s.raised_by_committee_member_id ? (
                                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">Raised by {memberName(s.raised_by_committee_member_id)}</p>
                                ) : s.raised_by_name ? (
                                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">Raised by {s.raised_by_name} (via website)</p>
                                ) : null}

                                {s.reply_text && (
                                  <div className="mt-2 bg-dp-surface-container-low rounded-lg p-2.5">
                                    <p className="font-sans text-[10.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1">Reply</p>
                                    <p className="font-sans text-[13px] text-dp-on-surface whitespace-pre-wrap">{s.reply_text}</p>
                                  </div>
                                )}

                                <div className="mt-2 flex items-start gap-2">
                                  <textarea
                                    value={replyDrafts[s.id] ?? s.reply_text ?? ''}
                                    onChange={(e) => setReplyDrafts({ ...replyDrafts, [s.id]: e.target.value })}
                                    rows={2} placeholder="Write a reply..."
                                    className="input-field resize-none flex-1 !text-[13px]"
                                  />
                                  <div className="flex flex-col gap-1.5 shrink-0">
                                    <button
                                      disabled={savingReply === s.id}
                                      onClick={() => saveReply(s, replyDrafts[s.id] ?? s.reply_text ?? '')}
                                      className="px-2.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50"
                                    >
                                      <Reply size={12} className="inline mr-1" />Save
                                    </button>
                                    {s.reply_text && (
                                      <button
                                        onClick={() => sendReplyWhatsApp(s)}
                                        disabled={!phone}
                                        title={phone ? 'Send via WhatsApp' : 'No phone number on file'}
                                        className="px-2.5 py-1.5 border border-green-600/40 text-green-700 rounded-lg font-sans text-[11.5px] font-semibold hover:bg-green-50 transition-all cursor-pointer disabled:opacity-40"
                                      >
                                        <MessageCircle size={12} className="inline mr-1" />WhatsApp
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/* Emergency Jobs */}
                    {emergencyJobs.length > 0 && (
                      <div>
                        <p className="font-sans text-[13px] font-bold text-red-700 uppercase tracking-[0.05em] flex items-center gap-1.5 mb-2"><Siren size={14} /> Emergency Jobs</p>
                        <div className="space-y-2">
                          {emergencyJobs.map((item) => (
                            <div key={item.id} className="border border-red-200 bg-red-50/40 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-2">
                                <p className="font-sans text-[14px] text-dp-on-surface flex-1" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>{item.text_ur}</p>
                                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold ${statusStyles[item.status]}`}>{item.status.replace('_', ' ')}</span>
                              </div>
                              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">Called by {adminName(item.created_by_admin_user_id) ?? 'Unknown'}</p>
                              <div className="flex items-center flex-wrap gap-2 mt-2">
                                {assigneesFor(item.id).map((cmId) => (
                                  <div key={cmId} className="flex items-center gap-1 bg-white rounded-full pl-2 pr-1 py-0.5 border border-red-200">
                                    <User size={11} className="text-dp-on-surface-variant" />
                                    <span className="font-sans text-[11.5px] text-dp-on-surface">{memberName(cmId)}</span>
                                    <button onClick={() => sendEmergencyWhatsApp(item, cmId)} title="Send WhatsApp" className="p-1 text-green-600 hover:bg-green-50 rounded-full cursor-pointer">
                                      <MessageCircle size={12} />
                                    </button>
                                  </div>
                                ))}
                                <button onClick={() => copyEmergencyMessage(item)} className="flex items-center gap-1 px-2 py-1 border border-dp-outline-variant rounded-full font-sans text-[11px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">
                                  <Copy size={11} /> Copy for Group
                                </button>
                              </div>
                              {item.status !== 'done' && (currentUserId && canMarkDone(item, meeting) ? (
                                <button onClick={() => markDone(item)} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                                  <CheckCircle2 size={13} /> Mark Done
                                </button>
                              ) : (
                                <button onClick={() => markDone(item)} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-surface-container-low transition-all cursor-pointer">
                                  <CheckCircle2 size={13} /> Mark Done (admin override)
                                </button>
                              ))}
                              {item.status === 'done' && item.done_by_admin_user_id && (
                                <p className="font-sans text-[11.5px] text-emerald-700 mt-1.5">Completed by {adminName(item.done_by_admin_user_id) ?? 'Unknown'}{item.done_at ? ` on ${new Date(item.done_at).toLocaleDateString('en-GB')}` : ''}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <button onClick={() => setPrintMeetingId(meeting.id)} className="inline-flex items-center gap-2 text-[12.5px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer">
                      <FileText size={14} /> View / Print Minutes
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* New Meeting modal */}
      {showMeetingForm && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setShowMeetingForm(false)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">New Meeting</h2>
              <button onClick={() => setShowMeetingForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Meeting Date</label>
                <input type="date" value={meetingForm.meeting_date} onChange={(e) => setMeetingForm({ ...meetingForm, meeting_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Title (optional)</label>
                <input value={meetingForm.title} onChange={(e) => setMeetingForm({ ...meetingForm, title: e.target.value })} className="input-field" placeholder="e.g. Monthly Committee Meeting" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Run By</label>
                <select value={meetingForm.run_by_admin_user_id} onChange={(e) => setMeetingForm({ ...meetingForm, run_by_admin_user_id: e.target.value })} className="input-field">
                  <option value="">Select...</option>
                  {adminUsers.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                </select>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">Default fallback assignee for members with no login or proxy set.</p>
              </div>
              <MultiImageUpload bucket="attachments" label="Agenda Scan (reference photo, optional)" max={4} currentUrls={meetingForm.agenda_photo_urls} onUpload={(urls) => setMeetingForm({ ...meetingForm, agenda_photo_urls: urls })} />
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setShowMeetingForm(false)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={savingMeeting} onClick={saveMeeting} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {savingMeeting ? 'Creating...' : 'Create Meeting'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Task modal */}
      {taskMeetingId && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setTaskMeetingId(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">Add Agenda Point</h2>
              <button onClick={() => setTaskMeetingId(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Point (Urdu)</label>
                <textarea value={taskForm.text_ur} onChange={(e) => setTaskForm({ ...taskForm, text_ur: e.target.value })} rows={3} className="input-field resize-none" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }} />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Category</label>
                <select value={taskForm.category} onChange={(e) => setTaskForm({ ...taskForm, category: e.target.value as Category })} className="input-field">
                  {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Due Date (optional)</label>
                <input type="date" value={taskForm.due_date} onChange={(e) => setTaskForm({ ...taskForm, due_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Assign To</label>
                <div className="space-y-1.5 max-h-48 overflow-y-auto border border-dp-outline-variant rounded-lg p-2">
                  {members.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 cursor-pointer px-1.5 py-1 rounded hover:bg-dp-surface-container-low">
                      <input
                        type="checkbox"
                        checked={taskForm.committee_member_ids.includes(m.id)}
                        onChange={(e) => setTaskForm({
                          ...taskForm,
                          committee_member_ids: e.target.checked
                            ? [...taskForm.committee_member_ids, m.id]
                            : taskForm.committee_member_ids.filter((id) => id !== m.id),
                        })}
                        className="accent-dp-secondary"
                      />
                      <span className="font-sans text-[13.5px] text-dp-on-surface">{m.name}</span>
                      <span className="font-sans text-[11.5px] text-dp-on-surface-variant">({m.position})</span>
                      {!m.uses_smartphone && <span className="px-1.5 py-0.5 rounded-full text-[9.5px] font-bold bg-amber-100 text-amber-800">via proxy</span>}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setTaskMeetingId(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={savingTask} onClick={saveTask} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {savingTask ? 'Saving...' : 'Allocate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Suggestion modal */}
      {suggestionMeetingId && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setSuggestionMeetingId(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">Add Suggestion</h2>
              <button onClick={() => setSuggestionMeetingId(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Suggestion (Urdu)</label>
                <textarea value={suggestionForm.text_ur} onChange={(e) => setSuggestionForm({ ...suggestionForm, text_ur: e.target.value })} rows={3} className="input-field resize-none" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }} />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Raised By (optional)</label>
                <select value={suggestionForm.raised_by_committee_member_id} onChange={(e) => setSuggestionForm({ ...suggestionForm, raised_by_committee_member_id: e.target.value })} className="input-field">
                  <option value="">Not specified</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setSuggestionMeetingId(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={savingSuggestion} onClick={saveSuggestion} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {savingSuggestion ? 'Saving...' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Extraction review modal */}
      {extractMeetingId && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => !savingExtracted && setExtractMeetingId(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2"><Sparkles size={18} className="text-dp-secondary" /> AI Extracted Points</h2>
              <button onClick={() => setExtractMeetingId(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-3">
              {extracting ? (
                <div className="flex items-center justify-center gap-2 py-10 text-dp-on-surface-variant">
                  <Loader2 size={18} className="animate-spin" /> <span className="font-sans text-[13.5px]">Reading the agenda photo(s)...</span>
                </div>
              ) : (
                <>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant">Review and correct each point, then assign it. Nothing is saved until you click "Save Selected" below.</p>
                  {extractedPoints.map((p, i) => (
                    <div key={i} className={`border rounded-lg p-3 ${p.include ? 'border-dp-outline-variant' : 'border-dp-outline-variant opacity-50'}`}>
                      <label className="flex items-center gap-2 mb-2 cursor-pointer">
                        <input type="checkbox" checked={p.include} onChange={(e) => updateExtracted(i, { include: e.target.checked })} className="accent-dp-secondary" />
                        <span className="font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">Include</span>
                      </label>
                      <textarea
                        value={p.text} onChange={(e) => updateExtracted(i, { text: e.target.value })} rows={2}
                        className="input-field resize-none mb-2" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}
                        disabled={!p.include}
                      />
                      <select
                        value={p.category} onChange={(e) => updateExtracted(i, { category: e.target.value as Category })}
                        className="input-field mb-2" disabled={!p.include}
                      >
                        {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                      </select>
                      <input
                        type="date" value={p.due_date} onChange={(e) => updateExtracted(i, { due_date: e.target.value })}
                        className="input-field mb-2" disabled={!p.include}
                      />
                      <div className="space-y-1 max-h-28 overflow-y-auto border border-dp-outline-variant rounded-lg p-1.5">
                        {members.map((m) => (
                          <label key={m.id} className="flex items-center gap-2 cursor-pointer px-1 py-0.5 rounded hover:bg-dp-surface-container-low">
                            <input
                              type="checkbox" disabled={!p.include}
                              checked={p.committee_member_ids.includes(m.id)}
                              onChange={(e) => updateExtracted(i, {
                                committee_member_ids: e.target.checked
                                  ? [...p.committee_member_ids, m.id]
                                  : p.committee_member_ids.filter((id) => id !== m.id),
                              })}
                              className="accent-dp-secondary"
                            />
                            <span className="font-sans text-[12.5px] text-dp-on-surface">{m.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
            {!extracting && (
              <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
                <button onClick={() => setExtractMeetingId(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
                <button disabled={savingExtracted} onClick={saveExtractedPoints} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                  {savingExtracted ? 'Saving...' : 'Save Selected'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import from Website Suggestions modal */}
      {importMeetingId && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setImportMeetingId(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2"><Globe2 size={18} className="text-dp-secondary" /> Import from Website</h2>
              <button onClick={() => setImportMeetingId(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            {!loadingSuggestions && readyProposals.length > 0 && (
              <div className="px-5 pt-4 space-y-2.5">
                <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide">Proposals Ready for Decision</p>
                {readyProposals.map((p) => (
                  <div key={p.id} className="border border-blue-200 bg-blue-50/50 rounded-lg p-3">
                    <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{p.title}</p>
                    <div className="flex items-center justify-between mt-2">
                      <p className="font-sans text-[11.5px] text-blue-700 font-semibold">{p.voteCount}/{p.vote_target} votes reached</p>
                      <button onClick={() => importProposal(p)} className="px-2.5 py-1 bg-dp-secondary text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0">+ Add</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="p-5 space-y-2.5">
              {loadingSuggestions ? (
                <p className="font-sans text-[13.5px] text-dp-on-surface-variant text-center py-6">Loading...</p>
              ) : websiteSuggestions.length === 0 ? (
                <p className="font-sans text-[13.5px] text-dp-on-surface-variant text-center py-6">No new suggestions from the website to import.</p>
              ) : (
                websiteSuggestions.map((s) => (
                  <div key={s.id} className="border border-dp-outline-variant rounded-lg p-3">
                    <p className="font-sans text-[13.5px] text-dp-on-surface">{s.message}</p>
                    <div className="flex items-center justify-between mt-2">
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{s.name || 'Anonymous'}{s.mobile ? ` · ${s.mobile}` : ''} · {new Date(s.created_at).toLocaleDateString('en-GB')}</p>
                      <button onClick={() => importSuggestion(s)} className="px-2.5 py-1 bg-dp-secondary text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0">+ Add</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Raise Emergency Job modal */}
      {emergencyMeetingId && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setEmergencyMeetingId(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-5 py-4 border-b border-dp-outline-variant">
              <Siren size={20} className="text-red-600" />
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">Raise Emergency Job</h2>
            </div>
            <div className="p-5 space-y-4">
              <p className="font-sans text-[12px] text-dp-on-surface-variant">
                This broadcasts to every committee member's WhatsApp (tap-to-send, same as everywhere else) and any of them can mark it done. It's recorded on {meetings.find((m) => m.id === emergencyMeetingId)?.title || 'the current meeting'}'s agenda.
              </p>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Job Description (Urdu)</label>
                <textarea value={emergencyText} onChange={(e) => setEmergencyText(e.target.value)} rows={3} className="input-field resize-none" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }} autoFocus />
              </div>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setEmergencyMeetingId(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={savingEmergency} onClick={raiseEmergencyJob} className="flex-1 px-4 py-3 bg-red-600 text-white rounded-full font-sans text-[14px] font-bold hover:bg-red-700 transition-all cursor-pointer disabled:opacity-50">
                {savingEmergency ? 'Broadcasting...' : 'Broadcast to All'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print / Save Minutes modal */}
      {printMeetingId && (() => {
        const meeting = meetings.find((m) => m.id === printMeetingId)
        if (!meeting) return null
        const allTasks = itemsFor(meeting.id, 'task')
        const tasks = allTasks.filter((t) => !t.is_emergency)
        const emergencyJobs = allTasks.filter((t) => t.is_emergency)
        const suggestions = itemsFor(meeting.id, 'suggestion')
        const docData: AgendaMinutesData = {
          meetingDateLabel: new Date(meeting.meeting_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
          title: meeting.title, runByName: adminName(meeting.run_by_admin_user_id) ?? 'Unknown',
          tasks: tasks.map((t) => ({
            textUr: t.text_ur, dueDate: t.due_date ? new Date(t.due_date).toLocaleDateString('en-GB') : null,
            status: t.status, assigneeNames: assigneesFor(t.id).map(memberName), doneByName: adminName(t.done_by_admin_user_id),
            category: t.category ?? 'miscellaneous',
          })),
          suggestions: suggestions.map((s) => ({
            textUr: s.text_ur,
            raisedByName: s.raised_by_committee_member_id ? memberName(s.raised_by_committee_member_id) : s.raised_by_name,
            isFromWebsite: !s.raised_by_committee_member_id,
            replyText: s.reply_text,
          })),
          emergencyJobs: emergencyJobs.map((e) => ({
            textUr: e.text_ur, status: e.status,
            calledByName: adminName(e.created_by_admin_user_id) ?? 'Unknown',
            completedByName: adminName(e.done_by_admin_user_id),
          })),
          complaints: complaints.filter((c) => c.status !== 'verified').map((c) => ({
            complaintNumber: c.complaint_number, complainantName: c.complainant_name, sector: c.sector,
            text: c.complaint_text, status: c.status, inchargeName: c.incharge_name,
          })),
          projectDiscussions: projectDiscussions.map((p) => ({
            title: p.title, status: p.status, voteCount: p.vote_count, voteTarget: p.vote_target,
            comments: p.comments.map((c) => ({ authorName: c.username, text: c.content, isSystem: c.comment_type === 'system' })),
          })),
        }
        const buildBlob = async () => {
          if (!docRef.current) throw new Error('Document not ready')
          return format === 'pdf' ? nodeToPdfBlob(docRef.current) : nodeToPngBlob(docRef.current)
        }
        const handlePrint = async () => { try { printBlob(await nodeToPdfBlob(docRef.current!)) } catch { toast.error('Could not prepare the document for printing') } }
        const handleDownload = async () => { try { downloadBlob(await buildBlob(), `meeting-minutes-${meeting.meeting_date}.${format === 'pdf' ? 'pdf' : 'png'}`) } catch { toast.error('Could not prepare the document') } }

        return (
          <div className="fixed inset-0 bg-black/50 z-[160] flex items-center justify-center p-4" onClick={() => setPrintMeetingId(null)}>
            <div className="bg-white rounded-lg max-h-[92vh] overflow-y-auto w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-dp-outline-variant">
                <span className="font-sans text-[14px] font-bold text-dp-primary">Meeting Minutes</span>
                <button onClick={() => setPrintMeetingId(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
              </div>
              <div className="p-4 flex justify-center bg-dp-surface-container-low/40">
                <AgendaMinutesDocument ref={docRef} data={docData} branding={branding} />
              </div>
              <div className="flex items-center gap-2 px-4 py-3 border-t border-dp-outline-variant">
                <select value={format} onChange={(e) => { setFormat(e.target.value as ReceiptFormat); setPreferredFormat(e.target.value as ReceiptFormat) }} className="input-field !py-1.5 !text-[13px] max-w-[100px]">
                  <option value="pdf">PDF</option>
                  <option value="png">PNG</option>
                </select>
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer"><Printer size={14} /> Print</button>
                <button onClick={handleDownload} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer ml-auto"><Download size={14} /> Download</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
