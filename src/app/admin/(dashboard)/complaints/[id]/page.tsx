'use client'

import { useEffect, useState, use as usePromise } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft, Clock, MapPin, Phone, User, CheckCircle2, RotateCcw, CalendarPlus,
  MessageCircle, Send, Image as ImageIcon, Mic as MicIcon, UserPlus, Link2, Receipt,
} from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { FileAttachment } from '@/components/admin/FileAttachment'
import { VoiceRecorder } from '@/components/admin/VoiceRecorder'
import { normalizePakPhone } from '@/lib/receiptExport'

interface Complaint {
  id: string; complaint_number: string; system: string; complainant_name: string | null
  phone: string | null; sector: string | null; complaint_text: string; status: string
  assigned_to: string | null; deadline_at: string; created_at: string
  consumer_id: string | null; waiver_active: boolean; waiver_type: string | null; waiver_percent: number | null
}
interface ConsumerOption { consumer_id: string; name: string; mobile: string }
interface WaivedBill {
  id: string; bill_number: string; month: number; year: number; amount_pkr: number
  discount_amount: number | null; paid_amount: number | null; waiver_voucher_id: string; waiver_type: string; waiver_percent: number | null
}
interface Update {
  id: string; author_id: string | null; kind: string; body: string | null
  photo_url: string | null; voice_url: string | null; created_at: string
}
interface Me { id: string; role: string; can_verify_complaints: boolean }

const statusLabels: Record<string, string> = { open: 'Open', awaiting_verification: 'Awaiting Verification', verified: 'Verified' }
const statusColors: Record<string, string> = {
  open: 'bg-amber-100 text-amber-800', awaiting_verification: 'bg-blue-100 text-blue-800', verified: 'bg-emerald-100 text-emerald-800',
}
const kindStyle: Record<string, string> = {
  assigned: 'text-dp-secondary', resolved: 'text-emerald-700', reopened: 'text-dp-error', deadline_extended: 'text-amber-700',
}

function deadlineText(deadline: string, status: string) {
  if (status === 'verified') return null
  const hrs = Math.round((new Date(deadline).getTime() - Date.now()) / 3600000)
  if (hrs <= 0) return { text: 'Overdue', tone: 'text-dp-error' }
  if (hrs < 24) return { text: `${hrs}h left`, tone: 'text-amber-700' }
  return { text: `${Math.round(hrs / 24)}d left`, tone: 'text-dp-on-surface-variant' }
}

export default function ComplaintDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params)
  const supabase = createClient()

  const [complaint, setComplaint] = useState<Complaint | null>(null)
  const [updates, setUpdates] = useState<Update[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [handlers, setHandlers] = useState<{ admin_user_id: string }[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const [commentBody, setCommentBody] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [voiceUrl, setVoiceUrl] = useState('')
  const [posting, setPosting] = useState(false)

  const [showResolve, setShowResolve] = useState(false)
  const [resolveNote, setResolveNote] = useState('')
  const [showExtend, setShowExtend] = useState(false)
  const [extendDays, setExtendDays] = useState(2)
  const [extendNote, setExtendNote] = useState('')
  const [showVerifyDecision, setShowVerifyDecision] = useState<'verify' | 'reopen' | null>(null)
  const [verifyNote, setVerifyNote] = useState('')
  const [assignTo, setAssignTo] = useState('')
  const [busy, setBusy] = useState(false)

  const [consumerInfo, setConsumerInfo] = useState<ConsumerOption | null>(null)
  const [outstanding, setOutstanding] = useState(0)
  const [waivedBills, setWaivedBills] = useState<WaivedBill[]>([])
  const [waiverVouchers, setWaiverVouchers] = useState<Record<string, { voucher_no: string | null; status: string }>>({})
  const [linkConsumers, setLinkConsumers] = useState<ConsumerOption[]>([])
  const [linkQuery, setLinkQuery] = useState('')
  const [waiverType, setWaiverType] = useState<'full' | 'percent'>('full')
  const [waiverPercent, setWaiverPercent] = useState(50)
  const [waiverBusy, setWaiverBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: meRow } = await supabase.from('admin_users').select('id, role, can_verify_complaints').eq('auth_user_id', user.id).single()
      setMe(meRow)
    }
    const { data: c } = await supabase.from('complaints').select('*').eq('id', id).single()
    if (!c) { setLoading(false); return }
    setComplaint(c)

    const [{ data: updatesData }, { data: roster }, { data: handlersData }] = await Promise.all([
      supabase.from('complaint_updates').select('*').eq('complaint_id', id).order('created_at', { ascending: true }),
      supabase.rpc('get_approvers_roster', { p_system: c.system }),
      supabase.from('complaint_handlers').select('admin_user_id').eq('system', c.system).eq('is_active', true),
    ])
    setUpdates(updatesData ?? [])
    setNames(Object.fromEntries(((roster ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name])))
    setHandlers(handlersData ?? [])

    if (c.system === 'water_supply') {
      if (c.consumer_id) {
        const [{ data: consumerRow }, { data: allBills }] = await Promise.all([
          supabase.from('consumers').select('consumer_id, name, mobile').eq('consumer_id', c.consumer_id).single(),
          supabase.from('bills').select('id, bill_number, month, year, amount_pkr, discount_amount, paid_amount, status, waiver_voucher_id, waiver_type, waiver_percent').eq('consumer_id', c.consumer_id),
        ])
        setConsumerInfo(consumerRow ?? null)
        const bills = allBills ?? []
        const owed = bills.reduce((sum, b) => {
          const net = Math.max(b.amount_pkr - (b.discount_amount ?? 0), 0)
          return sum + Math.max(net - (b.paid_amount ?? 0), 0)
        }, 0)
        setOutstanding(owed)
        const waived = bills.filter((b) => b.waiver_voucher_id) as WaivedBill[]
        setWaivedBills(waived)
        if (waived.length > 0) {
          const { data: vouchers } = await supabase.from('vouchers').select('id, voucher_no, status').in('id', waived.map((b) => b.waiver_voucher_id))
          setWaiverVouchers(Object.fromEntries((vouchers ?? []).map((v) => [v.id, { voucher_no: v.voucher_no, status: v.status }])))
        } else {
          setWaiverVouchers({})
        }
      } else {
        setConsumerInfo(null); setOutstanding(0); setWaivedBills([]); setWaiverVouchers({})
        const { data: consumersData } = await supabase.from('consumers').select('consumer_id, name, mobile').order('name')
        setLinkConsumers(consumersData ?? [])
      }
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const matchingLinkConsumers = (() => {
    const q = linkQuery.trim().toLowerCase()
    if (!q) return []
    return linkConsumers.filter((c) => c.name.toLowerCase().includes(q) || c.consumer_id.toLowerCase().includes(q) || c.mobile?.includes(q)).slice(0, 8)
  })()

  const linkConsumer = async (consumerId: string) => {
    setBusy(true)
    const { error } = await supabase.from('complaints').update({ consumer_id: consumerId }).eq('id', id)
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Linked to consumer')
    setLinkQuery('')
    load()
  }

  const applyWaiver = async () => {
    setWaiverBusy(true)
    const { error } = await supabase.rpc('set_complaint_waiver', {
      p_complaint_id: id, p_active: true, p_waiver_type: waiverType,
      p_waiver_percent: waiverType === 'percent' ? waiverPercent : null,
    })
    setWaiverBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Bill waiver applied')
    load()
  }

  const clearWaiver = async () => {
    setWaiverBusy(true)
    const { error } = await supabase.rpc('set_complaint_waiver', { p_complaint_id: id, p_active: false, p_waiver_type: null, p_waiver_percent: null })
    setWaiverBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Bill waiver cleared')
    load()
  }

  const postComment = async () => {
    if (!commentBody.trim() && !photoUrl && !voiceUrl) { toast.error('Write something or attach a photo/voice message'); return }
    setPosting(true)
    const { error } = await supabase.from('complaint_updates').insert({
      complaint_id: id, kind: 'comment', body: commentBody.trim() || null,
      photo_url: photoUrl || null, voice_url: voiceUrl || null,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setCommentBody(''); setPhotoUrl(''); setVoiceUrl('')
    load()
  }

  const assign = async (adminUserId: string) => {
    if (!adminUserId) return
    setBusy(true)
    const { error } = await supabase.from('complaints').update({ assigned_to: adminUserId }).eq('id', id)
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Assigned')
    setAssignTo('')
    load()
  }

  const resolve = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('mark_complaint_resolved', { p_complaint_id: id, p_note: resolveNote || null })
    setBusy(false)
    setShowResolve(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Marked resolved — awaiting verification')
    setResolveNote('')
    load()
  }

  const extend = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('extend_complaint_deadline', { p_complaint_id: id, p_days: extendDays, p_note: extendNote || null })
    setBusy(false)
    setShowExtend(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`Deadline extended by ${extendDays} day(s)`)
    setExtendNote('')
    load()
  }

  const decideVerification = async () => {
    if (!showVerifyDecision) return
    setBusy(true)
    const fn = showVerifyDecision === 'verify' ? 'verify_complaint' : 'reopen_complaint'
    const { error } = await supabase.rpc(fn, { p_complaint_id: id, p_note: verifyNote || null })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); setShowVerifyDecision(null); return }
    toast.success(showVerifyDecision === 'verify' ? 'Verified and closed' : 'Sent back to handler')
    setVerifyNote('')
    setShowVerifyDecision(null)
    load()
  }

  const notifyComplainantViaWhatsApp = () => {
    if (!complaint?.phone) return
    const intl = normalizePakPhone(complaint.phone)
    if (!intl) { toast.error('No usable phone number on this complaint'); return }
    const msg = encodeURIComponent(`Dhab Pari — your complaint ${complaint.complaint_number} has been resolved. Thank you for your patience.`)
    window.open(`https://wa.me/${intl}?text=${msg}`, '_blank')
  }

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>
  if (!complaint) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Complaint not found.</div>

  const canVerify = me && (me.role === 'super_admin' || me.can_verify_complaints)
  const isHandler = me && handlers.some((h) => h.admin_user_id === me.id)
  const dl = deadlineText(complaint.deadline_at, complaint.status)

  return (
    <>
      <Link href="/admin/complaints" className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13px] font-semibold hover:underline mb-4">
        <ArrowLeft size={14} /> Back to Complaints
      </Link>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-heading text-[20px] font-bold text-dp-primary">{complaint.complaint_number}</span>
              <span className={`px-2 py-0.5 rounded-full font-sans text-[11px] font-bold uppercase tracking-wide ${statusColors[complaint.status]}`}>{statusLabels[complaint.status]}</span>
            </div>
            <div className="flex flex-wrap gap-3 font-sans text-[13px] text-dp-on-surface-variant">
              {complaint.complainant_name && <span className="flex items-center gap-1"><User size={13} /> {complaint.complainant_name}</span>}
              {complaint.phone && <span className="flex items-center gap-1"><Phone size={13} /> {complaint.phone}</span>}
              {complaint.sector && <span className="flex items-center gap-1"><MapPin size={13} /> {complaint.sector}</span>}
            </div>
          </div>
          {dl && <span className={`flex items-center gap-1 font-sans text-[13px] font-semibold ${dl.tone}`}><Clock size={14} /> {dl.text}</span>}
        </div>
        <p className="font-sans text-[15px] text-dp-on-surface bg-dp-surface-container-low/50 rounded-lg px-4 py-3">{complaint.complaint_text}</p>

        <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-dp-outline-variant flex-wrap">
          <p className="font-sans text-[13px] text-dp-on-surface-variant">
            Assigned to: <span className="font-semibold text-dp-on-surface">{complaint.assigned_to ? (names[complaint.assigned_to] ?? 'Someone') : 'Unassigned'}</span>
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {complaint.status !== 'verified' && (
              <select
                value={assignTo}
                onChange={(e) => { setAssignTo(e.target.value); assign(e.target.value) }}
                disabled={busy}
                className="input-field !py-1.5 !text-[12.5px] max-w-[180px]"
              >
                <option value="">{complaint.assigned_to ? 'Reassign to...' : 'Assign to...'}</option>
                {handlers.map((h) => <option key={h.admin_user_id} value={h.admin_user_id}>{names[h.admin_user_id] ?? h.admin_user_id}</option>)}
              </select>
            )}
            {isHandler && me && complaint.assigned_to !== me.id && complaint.status !== 'verified' && (
              <button onClick={() => assign(me.id)} disabled={busy} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">
                <UserPlus size={13} /> Assign to Me
              </button>
            )}
            {complaint.status === 'open' && (
              <>
                <button onClick={() => setShowExtend(true)} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">
                  <CalendarPlus size={13} /> Extend Deadline
                </button>
                <button onClick={() => setShowResolve(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                  <CheckCircle2 size={13} /> Mark Resolved
                </button>
              </>
            )}
            {complaint.status === 'awaiting_verification' && canVerify && (
              <>
                <button onClick={() => setShowVerifyDecision('reopen')} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-error text-dp-error rounded-lg font-sans text-[12.5px] font-semibold hover:bg-red-50 transition-all cursor-pointer">
                  <RotateCcw size={13} /> Send Back
                </button>
                <button onClick={() => setShowVerifyDecision('verify')} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                  <CheckCircle2 size={13} /> Verify &amp; Close
                </button>
              </>
            )}
            {complaint.status === 'verified' && complaint.phone && (
              <button onClick={notifyComplainantViaWhatsApp} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#25d366] text-white rounded-lg font-sans text-[12.5px] font-semibold hover:opacity-90 transition-all cursor-pointer">
                <MessageCircle size={13} /> Notify Complainant
              </button>
            )}
          </div>
        </div>
      </div>

      {complaint.system === 'water_supply' && (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-6 mb-6">
          <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-4 flex items-center gap-2"><Link2 size={16} /> Consumer &amp; Bill Waiver</h2>

          {!consumerInfo ? (
            <div className="relative">
              <p className="font-sans text-[13px] text-dp-on-surface-variant mb-2">Not linked to a consumer yet — link one to enable bill waivers.</p>
              <input
                value={linkQuery} onChange={(e) => setLinkQuery(e.target.value)} disabled={busy}
                placeholder="Search by name, consumer no., or mobile..." className="input-field max-w-sm"
              />
              {matchingLinkConsumers.length > 0 && (
                <div className="absolute z-10 mt-1 w-full max-w-sm bg-white border border-dp-outline-variant rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {matchingLinkConsumers.map((c) => (
                    <button
                      key={c.consumer_id} type="button" onClick={() => linkConsumer(c.consumer_id)}
                      className="w-full text-left px-3 py-2 hover:bg-dp-surface-container-low font-sans text-[13px] cursor-pointer"
                    >
                      <strong>{c.consumer_id}</strong> — {c.name} {c.mobile && <span className="text-dp-on-surface-variant">· {c.mobile}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
                <div>
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{consumerInfo.consumer_id} — {consumerInfo.name}</p>
                  {consumerInfo.mobile && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{consumerInfo.mobile}</p>}
                </div>
                <div className="text-right">
                  <p className="font-sans text-[11px] uppercase tracking-wide text-dp-on-surface-variant">Outstanding</p>
                  <p className={`font-sans text-[16px] font-bold ${outstanding > 0 ? 'text-dp-error' : 'text-emerald-700'}`}>Rs. {outstanding.toLocaleString()}</p>
                </div>
                <Link href={`/admin/billing?consumer=${consumerInfo.consumer_id}`} className="text-dp-secondary font-sans text-[12.5px] font-semibold hover:underline">View Billing →</Link>
              </div>

              {complaint.status !== 'verified' && canVerify && (
                <div className="bg-dp-surface-container-low/60 rounded-lg p-4 mb-4">
                  {complaint.waiver_active ? (
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <p className="font-sans text-[13px] text-dp-on-surface">
                        Waiver active: <span className="font-bold">{complaint.waiver_type === 'full' ? 'Full' : `${complaint.waiver_percent}%`}</span> — applied automatically to the pending bill and every future bill while this complaint stays open.
                      </p>
                      <button disabled={waiverBusy} onClick={clearWaiver} className="px-3 py-1.5 border border-dp-error text-dp-error rounded-lg font-sans text-[12.5px] font-semibold hover:bg-red-50 transition-all cursor-pointer disabled:opacity-50 shrink-0">
                        Clear Waiver
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-end gap-3 flex-wrap">
                      <div>
                        <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Waiver Type</label>
                        <select value={waiverType} onChange={(e) => setWaiverType(e.target.value as 'full' | 'percent')} className="input-field !py-1.5 !text-[13px]">
                          <option value="full">Full</option>
                          <option value="percent">Custom %</option>
                        </select>
                      </div>
                      {waiverType === 'percent' && (
                        <div>
                          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">Percent</label>
                          <input type="number" min={1} max={100} value={waiverPercent} onChange={(e) => setWaiverPercent(+e.target.value)} className="input-field !py-1.5 !text-[13px] w-24" />
                        </div>
                      )}
                      <button disabled={waiverBusy} onClick={applyWaiver} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                        {waiverBusy ? 'Applying...' : 'Apply Waiver'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {waivedBills.length > 0 && (
                <div>
                  <p className="font-sans text-[12px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2">Bills Waived Through This Complaint</p>
                  <div className="space-y-1.5">
                    {waivedBills.map((b) => {
                      const v = waiverVouchers[b.waiver_voucher_id]
                      return (
                        <div key={b.id} className="flex items-center justify-between px-3 py-2 bg-dp-surface-container-low/50 rounded-lg font-sans text-[12.5px]">
                          <span className="flex items-center gap-1.5"><Receipt size={12} className="text-dp-on-surface-variant" /> {b.bill_number} — {b.month}/{b.year}</span>
                          <span className="text-dp-on-surface-variant">{b.waiver_type === 'full' ? 'Full waiver' : `${b.waiver_percent}% waiver`}</span>
                          <span className={`font-semibold ${v?.status === 'pending' ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {v?.voucher_no ?? 'Pending #'}{v?.status === 'pending' ? ' — Awaiting Approval' : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showResolve && (
        <Modal title="Mark Resolved" onClose={() => setShowResolve(false)}>
          <textarea value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} rows={3} placeholder="What was done to fix it? (optional)" className="input-field resize-none mb-4" />
          <button disabled={busy} onClick={resolve} className="w-full bg-emerald-600 text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-emerald-700 transition-all cursor-pointer disabled:opacity-50">Submit for Verification</button>
        </Modal>
      )}
      {showExtend && (
        <Modal title="Extend Deadline" onClose={() => setShowExtend(false)}>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Extend by (days)</label>
          <input type="number" min={1} value={extendDays} onChange={(e) => setExtendDays(+e.target.value)} className="input-field mb-4" />
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Reason (optional)</label>
          <textarea value={extendNote} onChange={(e) => setExtendNote(e.target.value)} rows={2} className="input-field resize-none mb-4" />
          <button disabled={busy} onClick={extend} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">Extend</button>
        </Modal>
      )}
      {showVerifyDecision && (
        <Modal title={showVerifyDecision === 'verify' ? 'Verify & Close' : 'Send Back'} onClose={() => setShowVerifyDecision(null)}>
          <textarea value={verifyNote} onChange={(e) => setVerifyNote(e.target.value)} rows={3} placeholder={showVerifyDecision === 'verify' ? 'Verification note (optional)' : 'Why is this not resolved? (optional)'} className="input-field resize-none mb-4" />
          <button
            disabled={busy}
            onClick={decideVerification}
            className={`w-full py-2.5 rounded-lg font-sans font-semibold transition-all cursor-pointer disabled:opacity-50 text-white ${showVerifyDecision === 'verify' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-dp-error hover:opacity-90'}`}
          >
            {showVerifyDecision === 'verify' ? 'Confirm Verified' : 'Send Back to Handler'}
          </button>
        </Modal>
      )}

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-4">Status &amp; Conversation</h2>
        <div className="space-y-4 mb-6">
          {updates.length === 0 ? (
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant text-center py-6">No updates yet.</p>
          ) : (
            updates.map((u) => (
              <div key={u.id} className={u.kind === 'comment' ? 'flex gap-3' : ''}>
                {u.kind === 'comment' ? (
                  <div className="flex-1 min-w-0 bg-dp-surface-container-low/50 rounded-lg px-4 py-3">
                    <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface mb-1">
                      {u.author_id ? (names[u.author_id] ?? 'Staff') : 'System'} <span className="font-normal text-dp-on-surface-variant">· {new Date(u.created_at).toLocaleString('en-GB')}</span>
                    </p>
                    {u.body && <p className="font-sans text-[13.5px] text-dp-on-surface whitespace-pre-wrap">{u.body}</p>}
                    {u.photo_url && (
                      <a href={u.photo_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[12.5px] font-semibold hover:underline">
                        <ImageIcon size={13} /> View photo
                      </a>
                    )}
                    {u.voice_url && (
                      <div className="mt-2 flex items-center gap-2">
                        <MicIcon size={13} className="text-dp-on-surface-variant shrink-0" />
                        <audio src={u.voice_url} controls className="h-8" />
                      </div>
                    )}
                  </div>
                ) : (
                  <p className={`font-sans text-[12.5px] font-semibold text-center ${kindStyle[u.kind] ?? 'text-dp-on-surface-variant'}`}>
                    {u.body} <span className="font-normal text-dp-on-surface-variant">· {new Date(u.created_at).toLocaleString('en-GB')}</span>
                  </p>
                )}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-dp-outline-variant pt-4 space-y-3">
          <textarea value={commentBody} onChange={(e) => setCommentBody(e.target.value)} rows={3} placeholder="Post a status update or comment..." className="input-field resize-none" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FileAttachment label="Photo (optional)" currentUrl={photoUrl || null} onUpload={setPhotoUrl} />
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Voice Message (optional)</label>
              <VoiceRecorder onUpload={setVoiceUrl} />
              {voiceUrl && <p className="font-sans text-[11.5px] text-emerald-700 mt-1">Voice message attached — ready to post.</p>}
            </div>
          </div>
          <button disabled={posting} onClick={postComment} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
            <Send size={14} /> {posting ? 'Posting...' : 'Post Update'}
          </button>
        </div>
      </div>
    </>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}
