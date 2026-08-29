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

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Users, PlusCircle, X, HandCoins, CheckCircle2, Clock, Pencil, UserMinus, Layers, UserCheck, UserX, Bell } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Academy { id: string; title: string; display_name: string | null; category: string }
interface Batch {
  id: string; label: string; label_ur: string | null; schedule_note: string | null; status: string
  fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null
  fee_villager_full_pkr: number | null; fee_outsider_full_pkr: number | null
  capacity: number | null; age_min: number | null; age_max: number | null
  session_days: number[] | null; session_time: string | null; sibling_discount_pct: number | null
}
interface Charge { id: string; charge_no: number; due_on: string; amount_pkr: number; paid_pkr: number; status: string }
interface Enrollment {
  id: string; student_name: string; guardian_name: string | null; guardian_whatsapp_number: string | null
  address: string | null; sector: string | null; batch_id: string | null
  participant_type: string; fee_type: string; fee_amount_pkr: number; discount_pct: number | null
  discount_reason: string | null; status: string
}
interface PendingRequest {
  id: string; student_name: string; student_age: number | null
  guardian_name: string | null; guardian_whatsapp_number: string | null
  address: string | null; sector: string | null; participant_type: string
  fee_type: string; fee_amount_pkr: number; batch_label: string | null; requested_at: string
}

const DAY_KEYS = ['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat']

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const emptyEnroll = {
  batch_id: '', student_name: '', student_name_ur: '', guardian_name: '', guardian_whatsapp_number: '',
  address: '', sector: '', participant_type: 'villager', fee_type: 'monthly',
  discount_pct: '', discount_reason: '',
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
  const [villageSectors, setVillageSectors] = useState<string[]>([])
  const [selected, setSelected] = useState<Academy | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [enrollments, setEnrollments] = useState<Enrollment[]>([])
  const [charges, setCharges] = useState<Record<string, Charge[]>>({})
  const [requests, setRequests] = useState<PendingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [showEnroll, setShowEnroll] = useState(false)
  const [form, setForm] = useState(emptyEnroll)
  const [saving, setSaving] = useState(false)
  const [payFor, setPayFor] = useState<{ chargeId: string; remaining: number; studentName: string } | null>(null)
  const [payAmount, setPayAmount] = useState(0)
  const [payMethod, setPayMethod] = useState('cash')
  const [editing, setEditing] = useState<Enrollment | null>(null)
  const [editForm, setEditForm] = useState({ guardian_name: '', guardian_whatsapp_number: '', address: '', sector: '', fee_amount_pkr: 0, discount_reason: '' })
  const [showBatchForm, setShowBatchForm] = useState(false)
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null)
  const [batchForm, setBatchForm] = useState(emptyBatch)

  const loadAcademies = async () => {
    setLoading(true)
    const [{ data }, { data: sectorRows }] = await Promise.all([
      supabase.from('projects').select('id, title, display_name, category')
        .in('category', ['sports', 'training']).order('created_at', { ascending: false }),
      supabase.from('sectors').select('name'),
    ])
    setAcademies(data ?? [])
    setVillageSectors((sectorRows ?? []).map((s) => s.name))
    setLoading(false)
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
        .select('id, student_name, guardian_name, guardian_whatsapp_number, address, sector, batch_id, participant_type, fee_type, fee_amount_pkr, discount_pct, discount_reason, status')
        .eq('project_id', academy.id).eq('status', 'active').order('student_name'),
      supabase.rpc('training_enrollment_requests', { p_project_id: academy.id }),
    ])
    setBatches(batchRows ?? [])
    setEnrollments(rows ?? [])
    setRequests((reqRows ?? []) as PendingRequest[])
    if (rows && rows.length > 0) {
      const { data: chargeRows } = await supabase.from('training_fee_charges')
        .select('id, enrollment_id, charge_no, due_on, amount_pkr, paid_pkr, status')
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

  const openEnroll = () => {
    setForm({ ...emptyEnroll, batch_id: batches[0]?.id ?? '' })
    setShowEnroll(true)
  }

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
    toast.success(`${t('af.paymentRecorded')} — ${(data as { voucher_no: string })?.voucher_no ?? ''}`)
    setPayFor(null); setPayAmount(0)
    if (selected) loadRoster(selected)
  }

  const openEdit = (e: Enrollment) => {
    setEditing(e)
    setEditForm({
      guardian_name: e.guardian_name ?? '', guardian_whatsapp_number: e.guardian_whatsapp_number ?? '',
      address: e.address ?? '', sector: e.sector ?? '', fee_amount_pkr: e.fee_amount_pkr, discount_reason: e.discount_reason ?? '',
    })
  }

  const saveEdit = async () => {
    if (!editing) return
    setSaving(true)
    const { error } = await supabase.from('training_enrollments').update({
      guardian_name: editForm.guardian_name || null, guardian_whatsapp_number: editForm.guardian_whatsapp_number || null,
      address: editForm.address || null, sector: editForm.sector || null,
      fee_amount_pkr: editForm.fee_amount_pkr, discount_reason: editForm.discount_reason || null,
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
      <div className="flex items-center gap-2 mb-6">
        <HandCoins size={24} className="text-dp-secondary" />
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('af.pageTitle')}</h1>
      </div>

      {!selected ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {loading && <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('af.loading')}</p>}
          {!loading && academies.length === 0 && (
            <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('af.noAcademies')}</p>
          )}
          {academies.map((a) => (
            <button key={a.id} onClick={() => loadRoster(a)}
              className="text-left bg-white border border-dp-outline-variant rounded-lg p-5 hover:border-dp-secondary transition-colors cursor-pointer">
              <p className="font-sans text-[16px] font-semibold text-dp-primary">{a.display_name || a.title}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant uppercase mt-1">{a.category}</p>
            </button>
          ))}
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
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
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
                        c.status === 'paid' ? 'bg-emerald-50 text-emerald-700' : c.status === 'part_paid' ? 'bg-amber-50 text-amber-700' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                        {c.status === 'paid' ? <CheckCircle2 size={13} /> : <Clock size={13} />}
                        {new Date(c.due_on).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} — Rs. {fmt(c.amount_pkr)}
                        {c.status !== 'paid' && (
                          <button
                            onClick={() => { setPayFor({ chargeId: c.id, remaining: c.amount_pkr - c.paid_pkr, studentName: e.student_name }); setPayAmount(c.amount_pkr - c.paid_pkr) }}
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
            <div className="space-y-3">
              <select value={form.batch_id} onChange={(e) => setForm({ ...form, batch_id: e.target.value })} className="input-field">
                {batches.map((b) => <option key={b.id} value={b.id}>{isUrdu && b.label_ur ? b.label_ur : b.label}</option>)}
              </select>
              <input value={form.student_name} onChange={(e) => setForm({ ...form, student_name: e.target.value })} placeholder={t('af.studentName')} className="input-field" />
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
              <div className="grid grid-cols-2 gap-3">
                <input type="number" value={form.discount_pct} onChange={(e) => setForm({ ...form, discount_pct: e.target.value })} placeholder={t('af.discountPct')} className="input-field" />
                <input value={form.discount_reason} onChange={(e) => setForm({ ...form, discount_reason: e.target.value })} placeholder={t('af.discountReason')} className="input-field" />
              </div>
              <button onClick={enroll} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                {saving ? t('af.saving') : t('af.enrollBtn')}
              </button>
            </div>
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
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">Rs. {t(editing.fee_type === 'monthly' ? 'af.perMonth' : 'af.fullCourse')}</label>
                <input type="number" value={editForm.fee_amount_pkr || ''} onChange={(e) => setEditForm({ ...editForm, fee_amount_pkr: +e.target.value })} className="input-field" />
              </div>
              <input value={editForm.discount_reason} onChange={(e) => setEditForm({ ...editForm, discount_reason: e.target.value })} placeholder={t('af.discountReason')} className="input-field" />
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
