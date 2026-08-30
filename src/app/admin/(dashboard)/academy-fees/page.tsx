'use client'

// Fee-charging sports/training academies — manage batches (kids/adults,
// day/night, tape/hard ball — as many pricing groups as the academy
// actually needs, migration 370), enroll a student into one, see their
// fee status, and record a payment. Academies themselves are just
// `projects` rows (category='sports'/'training', migration 366) —
// everything about the card/comments/ledger-account side of "being a
// project" is already handled by the existing projects infrastructure;
// this page is only the new piece, the batch/roster/fee layer on top.
//
// Works unmodified for both a full accountant (sees every academy, via
// training_enrollments_admin's manage_parties-gated RLS) and a scoped
// trainer (role='viewer', can_collect_payments, assigned_training_program_ids
// — sees only their own academy's roster via training_enrollments_trainer,
// migration 367). The query is identical either way; RLS does the narrowing.

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Users, PlusCircle, X, HandCoins, CheckCircle2, Clock, Pencil, UserMinus, Layers, UserCheck, UserX, Bell, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SearchableField } from '@/components/admin/SearchablePicker'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { UserCircle2, Printer } from 'lucide-react'
import { printNodeInPopup } from '@/lib/receiptExport'
import { DocumentHeader } from '@/components/admin/DocumentHeader'

interface Academy { id: string; title: string; display_name: string | null; category: string }
interface Batch {
  id: string; label: string; label_ur: string | null; schedule_note: string | null; status: string
  fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null
  fee_villager_full_pkr: number | null; fee_outsider_full_pkr: number | null
  capacity: number | null; age_min: number | null; age_max: number | null
  session_days: number[] | null; session_time: string | null; sibling_discount_pct: number | null
}
interface Charge {
  id: string; charge_no: number; due_on: string; amount_pkr: number; paid_pkr: number; status: string
  announced_amount_pkr: number | null; announced_method: string | null; announced_proof_url: string | null
}
interface Enrollment {
  id: string; student_name: string; student_age: number | null; guardian_name: string | null; guardian_whatsapp_number: string | null
  address: string | null; sector: string | null; batch_id: string | null
  participant_type: string; fee_type: string; fee_amount_pkr: number; discount_pct: number | null
  discount_reason: string | null; status: string
}
interface PendingRequest {
  id: string; student_name: string; student_age: number | null
  guardian_name: string | null; guardian_whatsapp_number: string | null
  address: string | null; sector: string | null; participant_type: string
  fee_type: string; fee_amount_pkr: number; discount_pct: number | null; discount_reason: string | null
  batch_label: string | null; requested_at: string
}
// Whatever openEdit is called with — an active roster row or a still-
// pending request — same fields either way, so the one Edit modal
// covers both: fixing a sibling-discount claim (or its reason) before
// confirming it is exactly the point of admin reviewing that claim at
// all; without this the only way to correct one was rejecting the
// whole request and asking the parent to resubmit.
interface EditableEnrollment {
  id: string; student_name: string; student_age: number | null
  guardian_name: string | null; guardian_whatsapp_number: string | null
  address: string | null; sector: string | null; fee_type: string
  fee_amount_pkr: number; discount_pct: number | null; discount_reason: string | null
}
// One row per academy, from academy_summary_report() (380/381) — fill
// rate, fee-collection rate, and (for a trainer-salary academy) funding
// rate, so the landing grid answers "how are all the academies doing"
// without opening each one.
interface Summary {
  project_id: string; batches_count: number; capacity_total: number; filled_total: number
  fees_charged_total: number; fees_collected_total: number; fees_overdue_total: number
  raised_total: number; spent_total: number; funding_model: string | null; monthly_operating_cost_pkr: number | null
}

const DAY_KEYS = ['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat']

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const emptyEnroll = {
  batch_id: '', student_name: '', student_name_ur: '', student_age: '', guardian_name: '', guardian_whatsapp_number: '',
  address: '', sector: '', participant_type: 'villager', fee_type: 'monthly',
  discount_pct: '', discount_reason: '', sibling_of: '',
}

function feeFor(b: Batch, participantType: string, feeType: string) {
  if (feeType === 'monthly') return participantType === 'villager' ? (b.fee_villager_monthly_pkr ?? 0) : (b.fee_outsider_monthly_pkr ?? 0)
  return participantType === 'villager' ? (b.fee_villager_full_pkr ?? 0) : (b.fee_outsider_full_pkr ?? 0)
}
const emptyBatch = {
  label: '', label_ur: '', schedule_note: '',
  fee_villager_monthly_pkr: 0, fee_outsider_monthly_pkr: 0, fee_villager_full_pkr: 0, fee_outsider_full_pkr: 0,
  capacity: '', age_min: '', age_max: '', session_days: [] as number[], session_time: '', sibling_discount_pct: '',
}

function AcademyFeesInner() {
  const { t, isUrdu } = useLocale()
  const searchParams = useSearchParams()
  const supabase = createClient()
  const [academies, setAcademies] = useState<Academy[]>([])
  const [summary, setSummary] = useState<Record<string, Summary>>({})
  const [villageSectors, setVillageSectors] = useState<string[]>([])
  // Self-service trainer profile — the only screen we know a scoped
  // trainer (role='viewer') can actually reach is this one, so "edit my
  // own bio/photo" lives here rather than a Members page they may not
  // have permission to open at all. Only shown once we know the signed-
  // in admin is actually assigned somewhere (assigned_training_program_ids).
  const [myTrainerProfile, setMyTrainerProfile] = useState<{ id: string; is_trainer: boolean; trainer_bio: string; trainer_bio_ur: string; trainer_photo_url: string } | null>(null)
  const [showMyProfile, setShowMyProfile] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [selected, setSelected] = useState<Academy | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [enrollments, setEnrollments] = useState<Enrollment[]>([])
  const [charges, setCharges] = useState<Record<string, Charge[]>>({})
  const [requests, setRequests] = useState<PendingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [showEnroll, setShowEnroll] = useState(false)
  const [form, setForm] = useState(emptyEnroll)
  const [saving, setSaving] = useState(false)
  const [payFor, setPayFor] = useState<{ chargeId: string; remaining: number; studentName: string; batchId: string | null } | null>(null)
  const [lastReceipt, setLastReceipt] = useState<{ voucherNo: string; studentName: string; batchLabel: string; amount: number; method: string; date: string } | null>(null)
  const receiptRef = useRef<HTMLDivElement>(null)
  const [payAmount, setPayAmount] = useState(0)
  const [payMethod, setPayMethod] = useState('cash')
  const [editing, setEditing] = useState<EditableEnrollment | null>(null)
  const [editForm, setEditForm] = useState({ guardian_name: '', guardian_whatsapp_number: '', address: '', sector: '', fee_amount_pkr: 0, discount_pct: '', discount_reason: '', student_age: '' })
  const [showBatchForm, setShowBatchForm] = useState(false)
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null)
  const [batchForm, setBatchForm] = useState(emptyBatch)

  const loadAcademies = async () => {
    setLoading(true)
    const [{ data }, { data: sectorRows }, { data: summaryRows }] = await Promise.all([
      supabase.from('projects').select('id, title, display_name, category')
        .in('category', ['sports', 'training']).order('created_at', { ascending: false }),
      supabase.from('sectors').select('name'),
      supabase.rpc('academy_summary_report'),
    ])
    setAcademies(data ?? [])
    setVillageSectors((sectorRows ?? []).map((s) => s.name))
    const byId: Record<string, Summary> = {}
    for (const s of (summaryRows ?? []) as Summary[]) byId[s.project_id] = s
    setSummary(byId)
    setLoading(false)

    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (authUser) {
      const { data: me } = await supabase.from('admin_users')
        .select('id, assigned_training_program_ids, trainer_bio, trainer_bio_ur, trainer_photo_url')
        .eq('auth_user_id', authUser.id).maybeSingle()
      if (me && (me.assigned_training_program_ids ?? []).length > 0) {
        setMyTrainerProfile({
          id: me.id, is_trainer: true,
          trainer_bio: me.trainer_bio ?? '', trainer_bio_ur: me.trainer_bio_ur ?? '', trainer_photo_url: me.trainer_photo_url ?? '',
        })
      }
    }
    const preselect = searchParams.get('project')
    if (preselect) {
      const match = (data ?? []).find((a) => a.id === preselect)
      if (match) loadRoster(match)
    }
  }
  useEffect(() => { loadAcademies() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadRoster = async (academy: Academy) => {
    setSelected(academy)
    const [{ data: batchRows }, { data: rows }, { data: reqRows }] = await Promise.all([
      supabase.from('training_batches').select('id, label, label_ur, schedule_note, status, fee_villager_monthly_pkr, fee_outsider_monthly_pkr, fee_villager_full_pkr, fee_outsider_full_pkr, capacity, age_min, age_max, session_days, session_time, sibling_discount_pct')
        .eq('project_id', academy.id).eq('status', 'active').order('created_at'),
      supabase.from('training_enrollments')
        .select('id, student_name, student_age, guardian_name, guardian_whatsapp_number, address, sector, batch_id, participant_type, fee_type, fee_amount_pkr, discount_pct, discount_reason, status')
        .eq('project_id', academy.id).eq('status', 'active').order('student_name'),
      supabase.rpc('training_enrollment_requests', { p_project_id: academy.id }),
    ])
    setBatches(batchRows ?? [])
    setEnrollments(rows ?? [])
    setRequests((reqRows ?? []) as PendingRequest[])
    if (rows && rows.length > 0) {
      const { data: chargeRows } = await supabase.from('training_fee_charges')
        .select('id, enrollment_id, charge_no, due_on, amount_pkr, paid_pkr, status, announced_amount_pkr, announced_method, announced_proof_url')
        .in('enrollment_id', rows.map((r) => r.id)).order('charge_no')
      const grouped: Record<string, Charge[]> = {}
      for (const c of chargeRows ?? []) (grouped[c.enrollment_id] ??= []).push(c)
      setCharges(grouped)
    } else {
      setCharges({})
    }
  }

  const batchLabel = (id: string | null) => {
    const b = batches.find((x) => x.id === id)
    if (!b) return ''
    return isUrdu && b.label_ur ? b.label_ur : b.label
  }

  // A "villager" claim is self-declared at request time — nothing stops
  // someone typing a sector that isn't actually one of the village's own
  // to get the cheaper rate. Not blocked (a genuine resident might just
  // phrase their sector differently, or the list might be incomplete),
  // just flagged here so admin sees it before confirming rather than
  // trusting it silently.
  const sectorMismatch = (participantType: string, sector: string | null) =>
    participantType === 'villager' && villageSectors.length > 0
    && !(sector && villageSectors.some((s) => s.trim().toLowerCase() === sector.trim().toLowerCase()))

  const saveMyProfile = async () => {
    if (!myTrainerProfile) return
    setSavingProfile(true)
    const { error } = await supabase.from('admin_users').update({
      trainer_bio: myTrainerProfile.trainer_bio.trim() || null,
      trainer_bio_ur: myTrainerProfile.trainer_bio_ur.trim() || null,
      trainer_photo_url: myTrainerProfile.trainer_photo_url.trim() || null,
    }).eq('id', myTrainerProfile.id)
    setSavingProfile(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.profileSavedToast'))
    setShowMyProfile(false)
  }

  const openEnroll = () => {
    setForm({ ...emptyEnroll, batch_id: batches[0]?.id ?? '' })
    setShowEnroll(true)
  }

  // Every currently active or pending student at this academy — the
  // sibling picker for a walk-in the trainer/admin is entering directly,
  // rather than typing a name freehand the way the portal's version
  // has to (it can't search the roster the same way staff, standing in
  // front of the roster, can).
  const siblingCandidates = [
    ...enrollments.map((e) => ({ id: e.id, label: `${e.student_name}${e.guardian_name ? ` — ${e.guardian_name}` : ''}` })),
    ...requests.map((r) => ({ id: r.id, label: `${r.student_name}${r.guardian_name ? ` — ${r.guardian_name}` : ''} (${t('af.pendingRequestsHeading')})` })),
  ]

  const enroll = async () => {
    if (!selected) return
    if (!form.batch_id) { toast.error(t('af.pickBatch')); return }
    if (!form.student_name.trim() || !form.guardian_whatsapp_number.trim()) {
      toast.error(t('af.requiredFields')); return
    }
    setSaving(true)
    const { error } = await supabase.rpc('enroll_in_training_program', {
      p_batch_id: form.batch_id, p_student_name: form.student_name, p_student_name_ur: form.student_name_ur || null,
      p_guardian_name: form.guardian_name || null, p_guardian_whatsapp_number: form.guardian_whatsapp_number,
      p_address: form.address || null, p_sector: form.sector || null,
      p_participant_type: form.participant_type, p_fee_type: form.fee_type,
      p_discount_pct: form.discount_pct ? Number(form.discount_pct) : null,
      p_discount_amount_pkr: null, p_discount_reason: form.discount_reason || null,
      p_student_age: form.student_age ? Number(form.student_age) : null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.enrolledToast'))
    setShowEnroll(false); setForm(emptyEnroll)
    loadRoster(selected)
  }

  const recordPayment = async () => {
    if (!payFor || payAmount <= 0) return
    setSaving(true)
    const { data, error } = await supabase.rpc('pay_training_fee_charge', {
      p_charge_id: payFor.chargeId, p_amount: payAmount, p_method: payMethod, p_note: null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    const voucherNo = (data as { voucher_no: string })?.voucher_no ?? ''
    toast.success(`${t('af.paymentRecorded')} — ${voucherNo}`)
    setLastReceipt({
      voucherNo, studentName: payFor.studentName, batchLabel: batchLabel(payFor.batchId),
      amount: payAmount, method: payMethod, date: new Date().toLocaleDateString('en-GB'),
    })
    setPayFor(null); setPayAmount(0)
    if (selected) loadRoster(selected)
  }

  // The receipt upload is a private bucket (a payment screenshot can show
  // account numbers) — same pattern the donors page already uses: a
  // signed URL generated on demand, never stored/rendered as a raw href.
  const viewAnnouncedSlip = async (path: string) => {
    const { data, error } = await supabase.storage.from('donation_receipts').createSignedUrl(path, 300)
    if (error || !data) { toast.error(friendlyError(error)); return }
    window.open(data.signedUrl, '_blank')
  }

  const confirmAnnouncedPayment = async (c: Charge, studentName: string, batchLbl: string) => {
    setSaving(true)
    const { data, error } = await supabase.rpc('confirm_training_fee_announcement', { p_charge_id: c.id })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    const voucherNo = (data as { voucher_no: string })?.voucher_no ?? ''
    toast.success(`${t('af.paymentRecorded')} — ${voucherNo}`)
    setLastReceipt({
      voucherNo, studentName, batchLabel: batchLbl, amount: c.announced_amount_pkr ?? 0,
      method: c.announced_method ?? 'bank', date: new Date().toLocaleDateString('en-GB'),
    })
    if (selected) loadRoster(selected)
  }

  const rejectAnnouncedPayment = async (c: Charge) => {
    const reason = window.prompt(t('af.rejectAnnouncedPrompt')) ?? undefined
    setSaving(true)
    const { error } = await supabase.rpc('reject_training_fee_announcement', { p_charge_id: c.id, p_reason: reason || null })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.rejectedToast'))
    if (selected) loadRoster(selected)
  }

  const printReceipt = () => {
    if (!receiptRef.current) return
    printNodeInPopup(receiptRef.current, t('af.receiptTitle'))
  }

  const openEdit = (e: EditableEnrollment) => {
    setEditing(e)
    setEditForm({
      guardian_name: e.guardian_name ?? '', guardian_whatsapp_number: e.guardian_whatsapp_number ?? '',
      address: e.address ?? '', sector: e.sector ?? '', fee_amount_pkr: e.fee_amount_pkr, discount_reason: e.discount_reason ?? '',
      discount_pct: e.discount_pct != null ? String(e.discount_pct) : '', student_age: e.student_age != null ? String(e.student_age) : '',
    })
  }

  const saveEdit = async () => {
    if (!editing) return
    setSaving(true)
    const { error } = await supabase.from('training_enrollments').update({
      guardian_name: editForm.guardian_name || null, guardian_whatsapp_number: editForm.guardian_whatsapp_number || null,
      address: editForm.address || null, sector: editForm.sector || null,
      fee_amount_pkr: editForm.fee_amount_pkr, discount_reason: editForm.discount_reason || null,
      discount_pct: editForm.discount_pct ? Number(editForm.discount_pct) : null,
      student_age: editForm.student_age ? Number(editForm.student_age) : null,
    }).eq('id', editing.id)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.changesSavedToast'))
    setEditing(null)
    if (selected) loadRoster(selected)
  }

  const withdraw = async (e: Enrollment) => {
    if (!confirm(t('af.withdrawConfirm'))) return
    setSaving(true)
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from('training_enrollments').update({ status: 'withdrawn' }).eq('id', e.id),
      supabase.from('training_fee_charges').update({ status: 'waived' }).eq('enrollment_id', e.id).in('status', ['due', 'part_paid']),
    ])
    setSaving(false)
    if (e1 || e2) { toast.error(friendlyError(e1 ?? e2)); return }
    toast.success(t('af.withdrawnToast'))
    if (selected) loadRoster(selected)
  }

  const confirmRequest = async (r: PendingRequest) => {
    setSaving(true)
    const { error } = await supabase.rpc('confirm_training_enrollment', { p_enrollment_id: r.id })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.confirmedToast'))
    if (selected) loadRoster(selected)
  }

  const rejectRequest = async (r: PendingRequest) => {
    const reason = window.prompt(t('af.rejectReasonPrompt')) ?? undefined
    setSaving(true)
    const { error } = await supabase.rpc('reject_training_enrollment', { p_enrollment_id: r.id, p_reason: reason || null })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.rejectedToast'))
    if (selected) loadRoster(selected)
  }

  const openNewBatch = () => { setEditingBatch(null); setBatchForm(emptyBatch); setShowBatchForm(true) }
  const openEditBatch = (b: Batch) => {
    setEditingBatch(b)
    setBatchForm({
      label: b.label, label_ur: b.label_ur ?? '', schedule_note: b.schedule_note ?? '',
      fee_villager_monthly_pkr: b.fee_villager_monthly_pkr ?? 0, fee_outsider_monthly_pkr: b.fee_outsider_monthly_pkr ?? 0,
      fee_villager_full_pkr: b.fee_villager_full_pkr ?? 0, fee_outsider_full_pkr: b.fee_outsider_full_pkr ?? 0,
      capacity: b.capacity != null ? String(b.capacity) : '', age_min: b.age_min != null ? String(b.age_min) : '',
      age_max: b.age_max != null ? String(b.age_max) : '', session_days: b.session_days ?? [], session_time: b.session_time ?? '',
      sibling_discount_pct: b.sibling_discount_pct != null ? String(b.sibling_discount_pct) : '',
    })
    setShowBatchForm(true)
  }

  const toggleDay = (d: number) => {
    setBatchForm((f) => ({ ...f, session_days: f.session_days.includes(d) ? f.session_days.filter((x) => x !== d) : [...f.session_days, d].sort() }))
  }

  const saveBatch = async () => {
    if (!selected || !batchForm.label.trim()) { toast.error(t('af.requiredFields')); return }
    setSaving(true)
    const payload = {
      label: batchForm.label, label_ur: batchForm.label_ur || null, schedule_note: batchForm.schedule_note || null,
      fee_villager_monthly_pkr: batchForm.fee_villager_monthly_pkr || null, fee_outsider_monthly_pkr: batchForm.fee_outsider_monthly_pkr || null,
      fee_villager_full_pkr: batchForm.fee_villager_full_pkr || null, fee_outsider_full_pkr: batchForm.fee_outsider_full_pkr || null,
      capacity: batchForm.capacity ? Number(batchForm.capacity) : null,
      age_min: batchForm.age_min ? Number(batchForm.age_min) : null, age_max: batchForm.age_max ? Number(batchForm.age_max) : null,
      session_days: batchForm.session_days.length > 0 ? batchForm.session_days : null,
      session_time: batchForm.session_time || null,
      sibling_discount_pct: batchForm.sibling_discount_pct ? Number(batchForm.sibling_discount_pct) : null,
    }
    const { error } = editingBatch
      ? await supabase.from('training_batches').update(payload).eq('id', editingBatch.id)
      : await supabase.from('training_batches').insert({ ...payload, project_id: selected.id })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('af.changesSavedToast'))
    setShowBatchForm(false)
    loadRoster(selected)
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-2 mb-6 flex-wrap">
        <div className="flex items-center gap-2">
          <HandCoins size={24} className="text-dp-secondary" />
          <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('af.pageTitle')}</h1>
        </div>
        {myTrainerProfile && (
          <button onClick={() => setShowMyProfile(true)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold text-dp-on-surface-variant hover:border-dp-secondary cursor-pointer">
            <UserCircle2 size={15} /> {t('af.editMyProfileBtn')}
          </button>
        )}
      </div>

      {showMyProfile && myTrainerProfile && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowMyProfile(false)}>
          <div className="bg-white rounded-lg max-w-[420px] w-full p-6 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-heading text-[18px] font-bold text-dp-primary">{t('af.myTrainerProfileTitle')}</h3>
              <button onClick={() => setShowMyProfile(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('us.trainerProfileHint')}</p>
            <ImageUpload bucket="images" currentUrl={myTrainerProfile.trainer_photo_url} onUpload={(url) => setMyTrainerProfile({ ...myTrainerProfile, trainer_photo_url: url })} label={t('us.trainerPhoto')} />
            <div>
              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('us.trainerBioEn')}</label>
              <textarea value={myTrainerProfile.trainer_bio} onChange={(e) => setMyTrainerProfile({ ...myTrainerProfile, trainer_bio: e.target.value })} rows={3} className="input-field" />
            </div>
            <div>
              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('us.trainerBioUr')}</label>
              <textarea value={myTrainerProfile.trainer_bio_ur} onChange={(e) => setMyTrainerProfile({ ...myTrainerProfile, trainer_bio_ur: e.target.value })} rows={3} dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }} className="input-field" />
            </div>
            <button onClick={saveMyProfile} disabled={savingProfile} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
              {savingProfile ? t('af.saving') : t('af.saveChangesBtn')}
            </button>
          </div>
        </div>
      )}

      {!selected ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {loading && <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('af.loading')}</p>}
          {!loading && academies.length === 0 && (
            <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('af.noAcademies')}</p>
          )}
          {academies.map((a) => {
            const s = summary[a.id]
            const fillPct = s && s.capacity_total > 0 ? Math.min(100, Math.round((s.filled_total / s.capacity_total) * 100)) : null
            const isSalaryFunded = s?.funding_model === 'recurring_support'
            return (
              <button key={a.id} onClick={() => loadRoster(a)}
                className="text-left bg-white border border-dp-outline-variant rounded-lg p-5 hover:border-dp-secondary transition-colors cursor-pointer">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-sans text-[16px] font-semibold text-dp-primary">{a.display_name || a.title}</p>
                  {s && s.fees_overdue_total > 0 && (
                    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-dp-error/10 text-dp-error shrink-0">
                      <AlertTriangle size={10} /> Rs. {fmt(s.fees_overdue_total)} {t('af.overdueLabel')}
                    </span>
                  )}
                </div>
                <p className="font-sans text-[12px] text-dp-on-surface-variant uppercase mt-1">{a.category}</p>

                {s && (
                  <div className="mt-3 space-y-2">
                    {s.capacity_total > 0 && (
                      <div>
                        <div className="flex items-center justify-between text-[11.5px] font-sans text-dp-on-surface-variant mb-1">
                          <span>{t('af.fillRateLabel')}</span>
                          <span className="ltr-num">{s.filled_total}/{s.capacity_total} ({fillPct}%)</span>
                        </div>
                        <div className="h-1.5 bg-dp-surface-container rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${fillPct === 100 ? 'bg-dp-error' : 'bg-dp-secondary'}`} style={{ width: `${fillPct}%` }} />
                        </div>
                      </div>
                    )}
                    {s.fees_charged_total > 0 && (
                      <div className="flex items-center justify-between text-[11.5px] font-sans text-dp-on-surface-variant ltr-num">
                        <span>{t('af.feesCollectedLabel')}</span>
                        <span>Rs. {fmt(s.fees_collected_total)} / {fmt(s.fees_charged_total)}</span>
                      </div>
                    )}
                    {isSalaryFunded && (
                      <div className="flex items-center justify-between text-[11.5px] font-sans text-dp-on-surface-variant ltr-num pt-1 border-t border-dp-outline-variant">
                        <span>{t('af.salaryFundingLabel')}</span>
                        <span>Rs. {fmt(s.raised_total)}{s.monthly_operating_cost_pkr ? ` / ${fmt(s.monthly_operating_cost_pkr)}${t('af.perMonthShort')}` : ''}</span>
                      </div>
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <button onClick={() => setSelected(null)} className="text-dp-secondary font-sans text-[13px] font-semibold cursor-pointer hover:underline">{t('af.backToList')}</button>
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{selected.display_name || selected.title}</h2>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={openNewBatch} className="flex items-center gap-1.5 px-4 py-2 border-2 border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-secondary hover:text-white transition-colors">
                <Layers size={15} /> {t('af.newBatchBtn')}
              </button>
              <button onClick={openEnroll} disabled={batches.length === 0} className="flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                <PlusCircle size={15} /> {t('af.enrollBtn')}
              </button>
            </div>
          </div>

          {/* Batches */}
          <div className="mb-6">
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{t('af.batchesHeading')}</p>
            {batches.length === 0 ? (
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('af.noBatches')}</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {batches.map((b) => (
                  <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-start justify-between gap-2">
                    <div>
                      <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{isUrdu && b.label_ur ? b.label_ur : b.label}</p>
                      {b.schedule_note && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{b.schedule_note}</p>}
                      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                        {t('af.villager')}: Rs. {fmt(b.fee_villager_monthly_pkr ?? 0)}/{t('af.perMonth')} · {t('af.outsider')}: Rs. {fmt(b.fee_outsider_monthly_pkr ?? 0)}/{t('af.perMonth')}
                      </p>
                      {(b.age_min != null || b.age_max != null || b.capacity != null || (b.session_days && b.session_days.length > 0) || b.sibling_discount_pct) && (
                        <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1 flex flex-wrap gap-x-2">
                          {(b.age_min != null || b.age_max != null) && <span>{t('af.agesLabel')} {b.age_min ?? 0}–{b.age_max ?? '∞'}</span>}
                          {b.capacity != null && <span>· {t('af.capacityLabel')}: {b.capacity}</span>}
                          {b.session_days && b.session_days.length > 0 && (
                            <span>· {b.session_days.map((d) => t(DAY_KEYS[d])).join(', ')}{b.session_time ? ` @ ${b.session_time.slice(0, 5)}` : ''}</span>
                          )}
                          {!!b.sibling_discount_pct && <span>· {t('af.siblingDiscountLabel')}: {b.sibling_discount_pct}%</span>}
                        </p>
                      )}
                    </div>
                    <button onClick={() => openEditBatch(b)} title={t('af.editBtn')} className="p-1.5 rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container cursor-pointer shrink-0"><Pencil size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pending join requests — submitted by a portal user via the "Join Academy" flow */}
          {requests.length > 0 && (
            <div className="mb-6">
              <p className="font-sans text-[12px] font-bold text-amber-700 uppercase tracking-[0.05em] mb-2 flex items-center gap-1.5">
                <Bell size={13} /> {t('af.pendingRequestsHeading')} ({requests.length})
              </p>
              <div className="space-y-2">
                {requests.map((r) => (
                  <div key={r.id} className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <p className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-2 flex-wrap">
                        {r.student_name}
                        {r.student_age != null && <span className="text-[11px] font-normal text-dp-on-surface-variant">({r.student_age})</span>}
                        {r.batch_label && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-blue-100 text-blue-700">{r.batch_label}</span>}
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${r.participant_type === 'villager' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                          {t(r.participant_type === 'villager' ? 'af.villager' : 'af.outsider')}
                        </span>
                        {sectorMismatch(r.participant_type, r.sector) && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-dp-error/10 text-dp-error" title={t('af.sectorMismatchHint')}>
                            {t('af.sectorMismatch')}
                          </span>
                        )}
                      </p>
                      <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                        {r.guardian_name} · {r.guardian_whatsapp_number} · Rs. {fmt(r.fee_amount_pkr)}/{t(r.fee_type === 'monthly' ? 'af.perMonth' : 'af.fullCourse')}
                        {r.sector ? ` · ${r.sector}` : ''}
                      </p>
                      {/* Sibling discount claimed on the request — auto-detected
                          (same portal account) is low-risk; a parent-typed claim
                          (383) is exactly what this line exists to let admin check
                          before confirming it. */}
                      {r.discount_pct != null && (
                        <p className="font-sans text-[11.5px] font-semibold text-dp-secondary mt-1">
                          {r.discount_reason?.includes('parent declared') ? <span className="text-amber-700">{t('af.verifyClaim')}: </span> : null}
                          {r.discount_pct}% · {r.discount_reason}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => openEdit(r)} title={t('af.editBtn')} className="p-2 rounded-lg text-amber-800 hover:bg-amber-100 cursor-pointer"><Pencil size={15} /></button>
                      <button onClick={() => confirmRequest(r)} disabled={saving} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-emerald-700 disabled:opacity-50">
                        <UserCheck size={13} /> {t('af.confirmBtn')}
                      </button>
                      <button onClick={() => rejectRequest(r)} disabled={saving} className="flex items-center gap-1 px-3 py-1.5 border border-dp-error text-dp-error rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-error/10 disabled:opacity-50">
                        <UserX size={13} /> {t('af.rejectBtn')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3">
            {enrollments.length === 0 && <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('af.noStudents')}</p>}
            {enrollments.map((e) => (
              <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="font-sans text-[15px] font-semibold text-dp-on-surface flex items-center gap-2 flex-wrap">
                      <Users size={15} className="text-dp-on-surface-variant" /> {e.student_name}
                      {e.student_age != null && <span className="text-[11px] font-normal text-dp-on-surface-variant">({e.student_age})</span>}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${e.participant_type === 'villager' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                        {t(e.participant_type === 'villager' ? 'af.villager' : 'af.outsider')}
                      </span>
                      {e.batch_id && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-blue-100 text-blue-700">{batchLabel(e.batch_id)}</span>
                      )}
                    </p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                      {e.guardian_name} · {e.guardian_whatsapp_number} · Rs. {fmt(e.fee_amount_pkr)}/{t(e.fee_type === 'monthly' ? 'af.perMonth' : 'af.fullCourse')}
                      {e.discount_pct ? ` · ${e.discount_pct}% ${t('af.discount')}${e.discount_reason ? ` (${e.discount_reason})` : ''}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => openEdit(e)} title={t('af.editBtn')} className="p-2 rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container cursor-pointer"><Pencil size={15} /></button>
                    <button onClick={() => withdraw(e)} title={t('af.withdrawBtn')} className="p-2 rounded-lg text-dp-error hover:bg-dp-error/10 cursor-pointer"><UserMinus size={15} /></button>
                  </div>
                </div>
                {(charges[e.id] ?? []).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-dp-outline-variant flex flex-wrap gap-2">
                    {(charges[e.id] ?? []).map((c) => (
                      <div key={c.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold ${
                        c.status === 'paid' ? 'bg-emerald-50 text-emerald-700' : c.status === 'announced' ? 'bg-blue-50 text-blue-700' : c.status === 'part_paid' ? 'bg-amber-50 text-amber-700' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                        {c.status === 'paid' ? <CheckCircle2 size={13} /> : c.status === 'announced' ? <Bell size={13} /> : <Clock size={13} />}
                        {new Date(c.due_on).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} — Rs. {fmt(c.amount_pkr)}
                        {c.status === 'announced' ? (
                          <>
                            <span className="ltr-num">{t('af.paidViaPortalLabel')} Rs. {fmt(c.announced_amount_pkr ?? 0)}</span>
                            {c.announced_proof_url && (
                              <button onClick={() => viewAnnouncedSlip(c.announced_proof_url!)} className="underline cursor-pointer">{t('af.viewSlipLink')}</button>
                            )}
                            <button onClick={() => confirmAnnouncedPayment(c, e.student_name, batchLabel(e.batch_id))} className="underline cursor-pointer text-emerald-700">
                              {t('af.confirmBtn')}
                            </button>
                            <button onClick={() => rejectAnnouncedPayment(c)} className="underline cursor-pointer text-dp-error">
                              {t('af.rejectBtn')}
                            </button>
                          </>
                        ) : c.status !== 'paid' && (
                          <button
                            onClick={() => { setPayFor({ chargeId: c.id, remaining: c.amount_pkr - c.paid_pkr, studentName: e.student_name, batchId: e.batch_id }); setPayAmount(c.amount_pkr - c.paid_pkr) }}
                            className="underline cursor-pointer"
                          >
                            {t('af.collectBtn')}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Batch create/edit modal */}
      {showBatchForm && selected && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowBatchForm(false)}>
          <div className="bg-white rounded-lg max-w-[520px] w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-[18px] font-bold text-dp-primary">{editingBatch ? t('af.editBatchTitle') : t('af.newBatchBtn')}</h3>
              <button onClick={() => setShowBatchForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input value={batchForm.label} onChange={(e) => setBatchForm({ ...batchForm, label: e.target.value })} placeholder={t('af.batchLabelPlaceholder')} className="input-field" />
              <input value={batchForm.label_ur} onChange={(e) => setBatchForm({ ...batchForm, label_ur: e.target.value })} placeholder={t('af.batchLabelUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <input value={batchForm.schedule_note} onChange={(e) => setBatchForm({ ...batchForm, schedule_note: e.target.value })} placeholder={t('af.scheduleNotePlaceholder')} className="input-field" />
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('pj.batchesHint')}</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('pj.feeVillagerMonthly')}</label><input type="number" value={batchForm.fee_villager_monthly_pkr || ''} onChange={(e) => setBatchForm({ ...batchForm, fee_villager_monthly_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('pj.feeOutsiderMonthly')}</label><input type="number" value={batchForm.fee_outsider_monthly_pkr || ''} onChange={(e) => setBatchForm({ ...batchForm, fee_outsider_monthly_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('pj.feeVillagerFull')}</label><input type="number" value={batchForm.fee_villager_full_pkr || ''} onChange={(e) => setBatchForm({ ...batchForm, fee_villager_full_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('pj.feeOutsiderFull')}</label><input type="number" value={batchForm.fee_outsider_full_pkr || ''} onChange={(e) => setBatchForm({ ...batchForm, fee_outsider_full_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
              </div>
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] pt-1">{t('af.slotsHeading')}</p>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant -mt-2">{t('af.slotsHint')}</p>
              <div className="grid grid-cols-3 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('af.capacityLabel')}</label><input type="number" value={batchForm.capacity} onChange={(e) => setBatchForm({ ...batchForm, capacity: e.target.value })} className="input-field" placeholder="∞" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('af.ageMinLabel')}</label><input type="number" value={batchForm.age_min} onChange={(e) => setBatchForm({ ...batchForm, age_min: e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('af.ageMaxLabel')}</label><input type="number" value={batchForm.age_max} onChange={(e) => setBatchForm({ ...batchForm, age_max: e.target.value })} className="input-field" placeholder="∞" /></div>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('af.sessionDaysLabel')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_KEYS.map((key, d) => (
                    <button key={d} type="button" onClick={() => toggleDay(d)}
                      className={`px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer border ${
                        batchForm.session_days.includes(d) ? 'bg-dp-secondary text-white border-dp-secondary' : 'border-dp-outline-variant text-dp-on-surface-variant'}`}>
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('af.sessionTimeLabel')}</label>
                <input type="time" value={batchForm.session_time} onChange={(e) => setBatchForm({ ...batchForm, session_time: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('af.siblingDiscountLabel')}</label>
                <input type="number" min="0" max="100" value={batchForm.sibling_discount_pct} onChange={(e) => setBatchForm({ ...batchForm, sibling_discount_pct: e.target.value })} className="input-field" placeholder="0" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('af.siblingDiscountHint')}</p>
              </div>
              <button onClick={saveBatch} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                {saving ? t('af.saving') : t('af.saveChangesBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enroll modal */}
      {showEnroll && selected && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowEnroll(false)}>
          <div className="bg-white rounded-lg max-w-[520px] w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-[18px] font-bold text-dp-primary">{t('af.enrollBtn')}</h3>
              <button onClick={() => setShowEnroll(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            {(() => {
              const b = batches.find((x) => x.id === form.batch_id) ?? null
              const filled = b ? enrollments.filter((e) => e.batch_id === b.id).length : 0
              const full = b?.capacity != null && filled >= b.capacity
              const ageRange = b && (b.age_min != null || b.age_max != null)
                ? `${b.age_min ?? 0}–${b.age_max ?? '∞'}` : null
              const baseFee = b ? feeFor(b, form.participant_type, form.fee_type) : 0
              const discountPct = form.discount_pct ? Number(form.discount_pct) : 0
              const previewFee = discountPct > 0 ? Math.max(0, baseFee - (baseFee * discountPct) / 100) : baseFee
              return (
                <div className="space-y-3">
                  <select value={form.batch_id} onChange={(e) => setForm({ ...form, batch_id: e.target.value })} className="input-field">
                    {batches.map((x) => <option key={x.id} value={x.id}>{isUrdu && x.label_ur ? x.label_ur : x.label}</option>)}
                  </select>
                  {b && (
                    <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 text-[12px] font-sans text-dp-on-surface-variant space-y-1">
                      <div className="flex flex-wrap gap-x-3">
                        {b.schedule_note && <span>{b.schedule_note}</span>}
                        {ageRange && <span>{t('af.agesLabel')} {ageRange}</span>}
                        {b.capacity != null && (
                          <span className={full ? 'text-dp-error font-semibold' : ''}>
                            {full ? t('tp.batchFull') : `${filled}/${b.capacity} ${t('af.enrolledLabel')}`}
                          </span>
                        )}
                      </div>
                      {full && <p className="text-dp-error text-[11.5px]">{t('af.batchFullOverrideHint')}</p>}
                    </div>
                  )}
                  <input value={form.student_name} onChange={(e) => setForm({ ...form, student_name: e.target.value })} placeholder={t('af.studentName')} className="input-field" />
                  <input type="number" value={form.student_age} onChange={(e) => setForm({ ...form, student_age: e.target.value })} placeholder={t('tp.studentAge')} className="input-field" />
                  <input value={form.guardian_name} onChange={(e) => setForm({ ...form, guardian_name: e.target.value })} placeholder={t('af.guardianName')} className="input-field" />
                  <input value={form.guardian_whatsapp_number} onChange={(e) => setForm({ ...form, guardian_whatsapp_number: e.target.value })} placeholder={t('af.guardianWhatsapp')} className="input-field" />
                  <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={t('z.location')} className="input-field" />
                  <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} placeholder={t('w.sector')} className="input-field" />
                  <div className="grid grid-cols-2 gap-3">
                    <select value={form.participant_type} onChange={(e) => setForm({ ...form, participant_type: e.target.value })} className="input-field">
                      <option value="villager">{t('af.villager')}</option>
                      <option value="outsider">{t('af.outsider')}</option>
                    </select>
                    <select value={form.fee_type} onChange={(e) => setForm({ ...form, fee_type: e.target.value })} className="input-field">
                      <option value="monthly">{t('af.perMonth')}</option>
                      <option value="full_course">{t('af.fullCourse')}</option>
                    </select>
                  </div>
                  {!!b?.sibling_discount_pct && (
                    <div>
                      <SearchableField
                        label={t('af.siblingOfLabel')} value={form.sibling_of}
                        onChange={(id) => {
                          const picked = siblingCandidates.find((c) => c.id === id)
                          setForm({
                            ...form, sibling_of: id,
                            discount_pct: id ? String(b.sibling_discount_pct) : '',
                            discount_reason: id && picked ? t('af.siblingOfReasonPrefix').replace('{name}', picked.label) : '',
                          })
                        }}
                        items={siblingCandidates} placeholder={t('af.siblingOfPlaceholder')} pickerTitle={t('af.siblingOfLabel')}
                        compact
                      />
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('af.applySiblingDiscountBtn').replace('{pct}', String(b.sibling_discount_pct))}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <input type="number" value={form.discount_pct} onChange={(e) => setForm({ ...form, discount_pct: e.target.value })} placeholder={t('af.discountPct')} className="input-field" />
                    <input value={form.discount_reason} onChange={(e) => setForm({ ...form, discount_reason: e.target.value })} placeholder={t('af.discountReason')} className="input-field" />
                  </div>
                  {b && (
                    <p className="font-sans text-[13px] font-semibold text-dp-primary bg-dp-secondary-container/20 rounded-lg px-3 py-2 ltr-num">
                      {t('tp.feePreview')}: {discountPct > 0 && <span className="line-through text-dp-on-surface-variant font-normal me-1.5">Rs. {fmt(baseFee)}</span>}
                      Rs. {fmt(previewFee)} / {t(form.fee_type === 'monthly' ? 'af.perMonth' : 'af.fullCourse')}
                    </p>
                  )}
                  <button onClick={enroll} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                    {saving ? t('af.saving') : t('af.enrollBtn')}
                  </button>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* Collect payment modal */}
      {payFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayFor(null)}>
          <div className="bg-white rounded-lg max-w-[420px] w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-[18px] font-bold text-dp-primary">{payFor.studentName}</h3>
              <button onClick={() => setPayFor(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input type="number" value={payAmount || ''} onChange={(e) => setPayAmount(+e.target.value)} className="input-field" />
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="input-field">
                <option value="cash">{t('af.cash')}</option>
                <option value="bank">{t('af.bank')}</option>
                <option value="jazzcash">JazzCash</option>
                <option value="easypaisa">Easypaisa</option>
              </select>
              <button onClick={recordPayment} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                {saving ? t('af.saving') : t('af.collectBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print receipt — offered right after collecting, instead of the
          only way to get a slip being a trip through All Transactions
          afterward to find the voucher. */}
      {lastReceipt && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setLastReceipt(null)}>
          <div className="bg-white rounded-lg max-w-[380px] w-full p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <CheckCircle2 size={36} className="text-emerald-600 mx-auto mb-2" />
            <p className="font-heading text-[17px] font-bold text-dp-primary">{t('af.paymentRecorded')}</p>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1 ltr-num">{lastReceipt.voucherNo} — Rs. {fmt(lastReceipt.amount)}</p>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setLastReceipt(null)} className="flex-1 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-surface-container">
                {t('af.closeBtn')}
              </button>
              <button onClick={printReceipt} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary">
                <Printer size={14} /> {t('af.printReceiptBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden — only ever rendered into the print popup, never shown on
          screen. Kept simple on purpose: this is a payment slip, not a
          full statement. */}
      <div className="hidden">
        <div ref={receiptRef} className="p-8 max-w-[420px] mx-auto" dir={isUrdu ? 'rtl' : 'ltr'}>
          <DocumentHeader title={t('af.receiptTitle')} />
          {lastReceipt && (
            <div className="font-sans text-[14px] text-dp-on-surface space-y-2 mt-4">
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('af.studentName')}</span><span className="font-semibold">{lastReceipt.studentName}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('af.batchLabel')}</span><span className="font-semibold">{lastReceipt.batchLabel}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('w.date')}</span><span className="font-semibold ltr-num">{lastReceipt.date}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('af.paymentMethodLabel')}</span><span className="font-semibold">{t(lastReceipt.method === 'cash' ? 'af.cash' : lastReceipt.method === 'bank' ? 'af.bank' : lastReceipt.method)}</span></div>
              <div className="flex justify-between border-t border-dp-outline-variant pt-2 mt-2"><span className="text-dp-on-surface-variant">{t('af.voucherNoLabel')}</span><span className="font-semibold ltr-num">{lastReceipt.voucherNo}</span></div>
              <div className="flex justify-between text-[18px] font-bold text-dp-primary border-t border-dp-outline-variant pt-2"><span>{t('w.amount')}</span><span className="ltr-num">Rs. {fmt(lastReceipt.amount)}</span></div>
            </div>
          )}
        </div>
      </div>

      {/* Edit enrollment modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-lg max-w-[480px] w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-[18px] font-bold text-dp-primary">{t('af.editEnrollment')} — {editing.student_name}</h3>
              <button onClick={() => setEditing(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input value={editForm.guardian_name} onChange={(e) => setEditForm({ ...editForm, guardian_name: e.target.value })} placeholder={t('af.guardianName')} className="input-field" />
              <input value={editForm.guardian_whatsapp_number} onChange={(e) => setEditForm({ ...editForm, guardian_whatsapp_number: e.target.value })} placeholder={t('af.guardianWhatsapp')} className="input-field" />
              <input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} placeholder={t('z.location')} className="input-field" />
              <input value={editForm.sector} onChange={(e) => setEditForm({ ...editForm, sector: e.target.value })} placeholder={t('w.sector')} className="input-field" />
              <input type="number" value={editForm.student_age} onChange={(e) => setEditForm({ ...editForm, student_age: e.target.value })} placeholder={t('tp.studentAge')} className="input-field" />
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">Rs. {t(editing.fee_type === 'monthly' ? 'af.perMonth' : 'af.fullCourse')}</label>
                <input type="number" value={editForm.fee_amount_pkr || ''} onChange={(e) => setEditForm({ ...editForm, fee_amount_pkr: +e.target.value })} className="input-field" />
              </div>
              {/* Correcting or clearing this is the whole point of being able to
                  edit a still-pending request — a sibling claim that doesn't
                  check out gets fixed here, not by rejecting the whole thing. */}
              <div className="grid grid-cols-2 gap-3">
                <input type="number" value={editForm.discount_pct} onChange={(e) => setEditForm({ ...editForm, discount_pct: e.target.value })} placeholder={t('af.discountPct')} className="input-field" />
                <input value={editForm.discount_reason} onChange={(e) => setEditForm({ ...editForm, discount_reason: e.target.value })} placeholder={t('af.discountReason')} className="input-field" />
              </div>
              <button onClick={saveEdit} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                {saving ? t('af.saving') : t('af.saveChangesBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function AcademyFeesPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <AcademyFeesInner />
    </Suspense>
  )
}
