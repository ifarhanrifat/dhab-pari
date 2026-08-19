'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  BookOpen, X, Award, Calculator, HandCoins, Plus, Save, ClipboardCheck, Gavel, CalendarClock, Users, FileText, Printer, Ban, RotateCcw,
  HelpCircle, ChevronDown, Phone, AlertTriangle, Wallet, Info, Pencil, Send, UserCheck, ShieldCheck, PhoneCall, Briefcase, StopCircle,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { printNodeInPopup } from '@/lib/receiptExport'

/**
 * Taleemi Wazifa — help for students who cannot pay to carry on.
 *
 * Kafalat keeps a child in school. This is the next problem: the boy or girl
 * who did well at matric or FSc and stops there because the family cannot
 * find the admission fee. In a village that is where most of the talent is
 * lost — not at primary, but at the step into Chakwal or Rawalpindi.
 *
 * A limited fund has to choose between applicants, so the ranking is by a
 * written formula (merit and need, weighted in Settings) rather than by whose
 * family the committee happens to know better.
 */

interface Student {
  id: string; code: string; full_name: string; father_name: string | null; mother_name: string | null
  phone: string | null; gender: string | null; is_orphan: boolean
  household_monthly_income_pkr: number | null; siblings_studying: number
  status: string; created_at: string
  is_zakat_family: boolean; zakat_match_register_id: string | null
  employment_status?: string
}

interface Application {
  id: string; student_id: string; academic_year: string
  level: string; institution: string; programme: string; city: string | null
  admission_status: string; last_exam_name: string | null
  last_exam_percent: number | null; requested_amount_pkr: number
  need_statement: string | null; status: string
  merit_score: number | null; need_score: number | null; total_score: number | null
  declared_cnic: string | null
  institute_phone: string | null; is_in_hostel: boolean; hostel_name: string | null; hostel_phone: string | null
  offered_monthly_contribution_pkr: number
  offered_contribution_status: 'pending' | 'approved' | 'declined'
  actual_course_cost_pkr?: number | null; family_monthly_capacity_pkr?: number | null
}

interface AwardRow {
  id: string; application_id: string; student_id: string; academic_year: string
  awarded_amount_pkr: number; funded_by: string; status: string
  student_monthly_contribution_pkr?: number; installment_due_day?: number | null
  installment_active?: boolean; is_loan?: boolean; repaid_pkr?: number
  installment_basis?: string | null; installment_percentage?: number | null
  installment_start_date?: string | null; installment_end_date?: string | null
  installment_pay_to?: string | null
  contributed_pkr?: number; written_off_pkr?: number
  plan_type?: 'collect_now' | 'disburse_then_settle'
  disbursement_monthly_pkr?: number | null; disbursement_start_date?: string | null; disbursement_end_date?: string | null
  disbursement_due_day?: number | null; disbursement_pay_to?: string | null; disbursement_active?: boolean
  disbursed_pkr?: number; settlement_trigger?: 'course_end' | 'employment' | 'none' | null
}

interface ZakatCandidate {
  register_id: string; code: string; head_name: string; father_husband_name: string | null
  asnaf_category: string; phone: string | null; address: string | null; match_strength: number
}

interface InterimGrant {
  id: string; award_id: string; months_awarded: number; monthly_amount_pkr: number
  pay_to: string; status: string; started_on: string; stopped_reason: string | null
}

interface CheckIn {
  id: string; award_id: string; method: string; confirmed: boolean; note: string | null; checked_on: string
}

// A snapshot of what was actually sent, not a live join (migration 269) —
// so admin's own read matches exactly what the student saw and signed.
interface AgreementRow {
  id: string; award_id: string; monthly_amount_pkr: number; due_day: number
  status: 'pending' | 'signed' | 'superseded'
  student_signed_name: string | null; student_signed_at: string | null
}

interface Verification {
  id: string; application_id: string; admin_user_id: string; visited_on: string
  recommendation: string | null; recommended_amount_pkr: number | null
  overall_note: string | null; relationship: string
  verified_obtained_marks: number | null; verified_total_marks: number | null
  observed_monthly_income_pkr: number | null; verified_annual_cost_pkr: number | null
}

interface DecisionRow {
  id: string; application_id: string; decision: string; approved_amount_pkr: number
  as_loan: boolean; funded_by: string; reason: string | null; decided_on: string
}

interface DocRow {
  id: string; application_id: string; kind: string; label: string | null
  url: string; original_seen: boolean; seen_at: string | null
}

interface Instalment {
  id: string; award_id: string; purpose: string; description: string | null
  due_on: string | null; amount_pkr: number; pay_to: string
  status: string; paid_on: string | null; receipt_no: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const LEVELS = ['intermediate', 'diploma', 'bachelors', 'masters', 'technical_certificate', 'medical', 'engineering', 'other'] as const
const PURPOSES = ['admission_fee', 'semester_fee', 'hostel', 'transport', 'books', 'equipment', 'exam_fee', 'stipend', 'other'] as const

// The same eleven checks as the printed block, in the same order, so a
// committee member typing up a sheet reads down the page rather than hunting.
const CHECKS = [
  ['cnic_seen', 'cnic_note', 'cnic'],
  ['documents_seen', 'documents_note', 'documents'],
  ['marks_verified', 'marks_note', 'marks'],
  ['admission_letter_seen', 'admission_note', 'admission'],
  ['fee_challan_seen', 'fee_challan_note', 'challan'],
  ['home_visited', 'home_note', 'home'],
  ['household_matches', 'household_note', 'household'],
  ['income_verified', 'income_note', 'income'],
  ['siblings_education_verified', 'siblings_note', 'siblings'],
  ['illness_verified', 'illness_note', 'illness'],
  ['zakat_status_verified', 'zakat_note', 'zakat'],
] as const

const emptyVerification: Record<string, string | number> = Object.fromEntries([
  ...CHECKS.flatMap(([a, n]) => [[a, 'yes'], [n, '']]),
  ['visited_on', new Date().toISOString().slice(0, 10)],
  ['verified_obtained_marks', 0], ['verified_total_marks', 0], ['verified_grade', ''],
  ['observed_monthly_income_pkr', 0], ['verified_annual_cost_pkr', 0],
  ['recommendation', 'full'], ['recommended_amount_pkr', 0],
  ['overall_note', ''], ['relationship', 'none'],
])

const emptyStudent = {
  full_name: '', full_name_ur: '', father_name: '', mother_name: '', phone: '', gender: 'male',
  is_orphan: false, household_monthly_income_pkr: 0, siblings_studying: 0,
  level: 'bachelors', institution: '', programme: '', city: '',
  last_exam_name: '', last_exam_percent: 0, requested_amount_pkr: 0, need_statement: '',
  // Only a parent applies for a child, in person, at the house — a walk-in
  // paper form recorded here is the one place applicant_for/relation are
  // actually set (the portal itself only ever submits 'self', migration 227).
  applicant_for: 'self', applicant_relation: '',
}

export default function WazifaPage() {
  const { t } = useLocale()
  const supabase = createClient()

  const [students, setStudents] = useState<Student[]>([])
  const [applications, setApplications] = useState<Application[]>([])
  const [awards, setAwards] = useState<AwardRow[]>([])
  const [instalments, setInstalments] = useState<Instalment[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'applications' | 'awards' | 'collections'>('applications')
  const [showGuide, setShowGuide] = useState(false)

  // ── Collections: shortfall, lapsed donors, announced pledges awaiting
  // confirmation — folded in from what used to be a separate /admin/pools
  // screen, the same as Kafalat and Sadqa, scoped to just POOL-WZF.
  const [collPoolId, setCollPoolId] = useState<string | null>(null)
  const [collPosition, setCollPosition] = useState<{
    committed: number; donors: number; coverage_percent: number
    received_this_month: number; reserve_months: number; reserve_target_months: number
  } | null>(null)
  const [collShortMonths, setCollShortMonths] = useState<{
    pool_month_id: string; pool_code: string; month: string; required: number; received: number; remaining: number
  }[]>([])
  const [collLapsed, setCollLapsed] = useState<{ commitment_id: string; pool_code: string; name: string; phone: string | null; amount: number }[]>([])
  const [collCovers, setCollCovers] = useState<{ month: string; pool_code: string; amount: number; voucher_no: string | null }[]>([])
  const [collUnrestricted, setCollUnrestricted] = useState(0)
  const [collAnnouncements, setCollAnnouncements] = useState<{
    id: string; pool_code: string; donor_name: string | null; donor_phone: string | null
    amount: number; is_one_time: boolean; month: string; proof_url: string | null
    payment_batch_id: string | null
  }[]>([])
  const [collBatchSummary, setCollBatchSummary] = useState<Record<string, { count: number; total: number }>>({})
  const [collCovering, setCollCovering] = useState<(typeof collShortMonths)[number] | null>(null)
  const [collCoverAmount, setCollCoverAmount] = useState(0)
  const [collCoverNote, setCollCoverNote] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyStudent)
  const [busy, setBusy] = useState(false)
  const [awardTarget, setAwardTarget] = useState<Application | null>(null)
  const [awardForm, setAwardForm] = useState({ amount: 0, funded_by: 'sadqa', condition: '' })
  const [instalmentTarget, setInstalmentTarget] = useState<AwardRow | null>(null)
  const [verifications, setVerifications] = useState<Verification[]>([])
  const [decisionsByApp, setDecisionsByApp] = useState<Record<string, DecisionRow>>({})
  const [verifyTarget, setVerifyTarget] = useState<Application | null>(null)
  const [vForm, setVForm] = useState<Record<string, string | number>>({ ...emptyVerification })
  const [decideTarget, setDecideTarget] = useState<Application | null>(null)
  const [dForm, setDForm] = useState({
    decision: 'approved_full', amount: 0, as_loan: false, funded_by: 'sadqa',
    reason: '', reason_ur: '', internal_note: '', shortfall_note: '',
    // The whole installment plan, set in the same action as the decision —
    // no separate visit to the Awards tab needed afterward (migration 278).
    // Standard track only; a zakat-family award uses interim support
    // instead (migration 276), set once screening confirms the match.
    set_plan: false, installment_basis: 'full', installment_percentage: 50,
    installment_start_date: '', installment_end_date: '', installment_due_day: 10, installment_pay_to: 'student',
    // "Pay while studying, then settle" (migration 287) — the other shape
    // a plan can take. plan_kind picks which one set_plan actually sets;
    // the fields above stay for collect_now, these are only read when
    // plan_kind is disburse_then_settle.
    plan_kind: 'collect_now' as 'collect_now' | 'disburse_then_settle',
    disbursement_monthly: 0, disbursement_start_date: '', disbursement_end_date: '',
    disbursement_due_day: 10, disbursement_pay_to: 'student',
    settlement_monthly: 0, settlement_trigger: 'course_end' as 'course_end' | 'employment' | 'none', settlement_due_day: 10,
  })
  const [planTarget, setPlanTarget] = useState<AwardRow | null>(null)
  const [planForm, setPlanForm] = useState({ starts_on: '', instalments: 12 })
  const [repayTarget, setRepayTarget] = useState<AwardRow | null>(null)
  const [repayForm, setRepayForm] = useState({ amount: 0, method: 'cash', note: '' })
  // Reported, never enforced. A second brother may be perfectly deserving —
  // the committee should decide that knowingly rather than the software
  // deciding it silently.
  const [documents, setDocuments] = useState<DocRow[]>([])
  const [committee, setCommittee] = useState<{ id: string; full_name: string }[]>([])
  const [coVerifiers, setCoVerifiers] = useState<string[]>([])
  const [coNames, setCoNames] = useState('')
  const [minVerifiers, setMinVerifiers] = useState(2)
  // The whole application as the family submitted it, fetched on demand so
  // the committee can read and print exactly what was signed.
  const [sheet, setSheet] = useState<Record<string, unknown> | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [payTarget, setPayTarget] = useState<Instalment | null>(null)
  const [payForm, setPayForm] = useState({ method: 'bank', challan_no: '', school_id: '', note: '' })
  const [contribTarget, setContribTarget] = useState<AwardRow | null>(null)
  const [contribForm, setContribForm] = useState({ amount: 0, method: 'cash', note: '' })
  const [writeOffTarget, setWriteOffTarget] = useState<AwardRow | null>(null)
  const [writeOffForm, setWriteOffForm] = useState({ amount: 0, reason: '' })
  const [schools, setSchools] = useState<{ id: string; name: string }[]>([])
  const [familyCheck, setFamilyCheck] = useState<Record<string, { code: string; name?: string; status: string; awarded?: number }[]> | null>(null)
  const [instalmentForm, setInstalmentForm] = useState({ purpose: 'admission_fee', description: '', due_on: '', amount: 0 })

  // Committee-fixed monthly instalment: set the figure, send the agreement,
  // activate once signed (migration 269/270). Three small steps instead of
  // one wide modal, because each is a different person's decision at a
  // different time — the committee sets it, the student signs it, the
  // committee activates it.
  const [agreements, setAgreements] = useState<AgreementRow[]>([])
  const [installmentCharges, setInstallmentCharges] = useState<
    { id: string; award_id: string; due_on: string; amount_pkr: number; paid_pkr: number; status: string }[]
  >([])
  // The disbursement half of a "pay while studying, then settle" plan
  // (migration 287) — the monthly job raises these, releasing the actual
  // cash stays a deliberate action, same shape as payChargeTarget below.
  const [disbursementCharges, setDisbursementCharges] = useState<
    { id: string; award_id: string; due_on: string; amount_pkr: number; paid_pkr: number; status: string }[]
  >([])
  const [payDisbursementTarget, setPayDisbursementTarget] = useState<{ id: string; award_id: string; amount_pkr: number; due_on: string } | null>(null)
  const [payDisbursementForm, setPayDisbursementForm] = useState({ method: 'cash' })
  const [planAwardTarget, setPlanAwardTarget] = useState<AwardRow | null>(null)
  const [planAwardForm, setPlanAwardForm] = useState({
    basis: 'full', percentage: 50, start_date: '', end_date: '', due_day: 10, pay_to: 'student',
  })

  // Zakat-track machinery: screening's zakat-family check, the interim
  // grant that funds a confirmed zakat family while studying, and the
  // check-in log that decides whether it keeps running (migration 275-277).
  const [interimGrants, setInterimGrants] = useState<InterimGrant[]>([])
  const [checkIns, setCheckIns] = useState<CheckIn[]>([])
  const [repaymentSchedule, setRepaymentSchedule] = useState<
    { id: string; award_id: string; due_on: string; amount_pkr: number; paid_pkr: number; status: string }[]
  >([])
  const [screenTarget, setScreenTarget] = useState<Application | null>(null)
  const [screenCandidates, setScreenCandidates] = useState<ZakatCandidate[]>([])
  const [screenLoading, setScreenLoading] = useState(false)
  const [grantTarget, setGrantTarget] = useState<AwardRow | null>(null)
  const [grantForm, setGrantForm] = useState({ months: 3, monthly_amount: 0, pay_to: 'institution' })
  const [stopGrantTarget, setStopGrantTarget] = useState<InterimGrant | null>(null)
  const [stopGrantReason, setStopGrantReason] = useState('')
  const [checkInTarget, setCheckInTarget] = useState<AwardRow | null>(null)
  const [checkInForm, setCheckInForm] = useState({ method: 'phone_institute', confirmed: true, note: '' })
  const [employTarget, setEmployTarget] = useState<Student | null>(null)
  const [employForm, setEmployForm] = useState({ monthly_amount: 0, note: '' })
  // A charge the automated plan already raised (migration 278) — recording
  // a payment against it is the one thing still done by hand, because
  // money changing hands is the one thing that should be.
  const [payChargeTarget, setPayChargeTarget] = useState<{ id: string; award_id: string; amount_pkr: number; paid_pkr: number; due_on: string } | null>(null)
  const [payChargeForm, setPayChargeForm] = useState({ amount: 0, method: 'cash' })
  // Monthly cash, or several months at once — the same one voucher either
  // way (migration 282).
  // The full calendar for one award — every month paid, due, or not yet
  // reached — so "which months are outstanding" is a screen, not a
  // question the accountant has to hold in their head (migration 289).
  const [calendarTarget, setCalendarTarget] = useState<AwardRow | null>(null)
  const [calendarMonths, setCalendarMonths] = useState<
    { month: string; charge_id: string | null; amount: number; paid_pkr: number; status: string; due_on: string }[]
  >([])
  const [calendarSelected, setCalendarSelected] = useState<Set<string>>(new Set())
  const [calendarMethod, setCalendarMethod] = useState('cash')
  const [calendarLoading, setCalendarLoading] = useState(false)

  const load = useCallback(async () => {
    const [{ data: st }, { data: ap }, { data: aw }, { data: ins }, { data: sum }, { data: vf }, { data: dc },
           { data: docs }, { data: cm }, { data: minV }, { data: sch }, { data: ags }, { data: charges },
           { data: grants }, { data: checks }, { data: repay }, { data: dcharges }] = await Promise.all([
      supabase.from('wazifa_students').select('*').order('created_at', { ascending: false }),
      supabase.from('wazifa_applications').select('*').order('total_score', { ascending: false, nullsFirst: false }),
      supabase.from('wazifa_awards').select('*').order('created_at', { ascending: false }),
      supabase.from('wazifa_instalments').select('*').order('due_on'),
      supabase.rpc('public_wazifa_summary'),
      supabase.from('wazifa_verifications').select('*'),
      supabase.from('wazifa_decisions').select('*').order('created_at', { ascending: false }),
      supabase.from('wazifa_documents').select('*').order('created_at'),
      supabase.from('admin_users').select('id, full_name').eq('is_active', true).order('full_name'),
      supabase.from('site_settings').select('value').eq('key', 'wazifa_min_verifiers').maybeSingle(),
      supabase.from('schools').select('id, name').eq('is_active', true).order('name'),
      supabase.from('wazifa_agreements').select('id, award_id, monthly_amount_pkr, due_day, status, student_signed_name, student_signed_at')
        .order('sent_at', { ascending: false }),
      supabase.from('wazifa_installment_charges').select('id, award_id, due_on, amount_pkr, paid_pkr, status')
        .order('due_on', { ascending: false }),
      supabase.from('wazifa_interim_grant').select('*').order('created_at', { ascending: false }),
      supabase.from('wazifa_check_ins').select('*').order('checked_on', { ascending: false }),
      supabase.from('wazifa_repayment_schedule').select('id, award_id, due_on, amount_pkr, paid_pkr, status'),
      supabase.from('wazifa_disbursement_charges').select('id, award_id, due_on, amount_pkr, paid_pkr, status')
        .order('due_on', { ascending: false }),
    ])
    setStudents((st ?? []) as Student[])
    setApplications((ap ?? []) as Application[])
    setAwards((aw ?? []) as AwardRow[])
    setInstalments((ins ?? []) as Instalment[])
    setAgreements((ags ?? []) as AgreementRow[])
    setInstallmentCharges((charges ?? []) as typeof installmentCharges)
    setInterimGrants((grants ?? []) as InterimGrant[])
    setCheckIns((checks ?? []) as CheckIn[])
    setRepaymentSchedule((repay ?? []) as typeof repaymentSchedule)
    setDisbursementCharges((dcharges ?? []) as typeof disbursementCharges)
    setSummary((sum ?? {}) as Record<string, number>)
    setVerifications((vf ?? []) as Verification[])
    const dmap: Record<string, DecisionRow> = {}
    for (const d of (dc ?? []) as DecisionRow[]) if (!dmap[d.application_id]) dmap[d.application_id] = d
    setDecisionsByApp(dmap)
    setDocuments((docs ?? []) as DocRow[])
    setCommittee((cm ?? []) as { id: string; full_name: string }[])
    setMinVerifiers(Number(minV?.value ?? 2))
    setSchools((sch ?? []) as { id: string; name: string }[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const loadCollections = useCallback(async () => {
    const { data: pool } = await supabase.from('support_pools').select('id').eq('code', 'POOL-WZF').single()
    const pid = (pool as { id: string } | null)?.id ?? null
    setCollPoolId(pid)
    const [{ data: pos }, { data: short }, { data: ann }] = await Promise.all([
      pid ? supabase.rpc('pool_position', { p_pool_id: pid }) : Promise.resolve({ data: null }),
      supabase.rpc('pool_shortfall_queue'),
      supabase.rpc('pool_announcement_queue'),
    ])
    setCollPosition((pos ?? null) as typeof collPosition)
    const s = short as { unrestricted_available: number; months: typeof collShortMonths; lapsed: typeof collLapsed; covers: typeof collCovers } | null
    setCollUnrestricted(s?.unrestricted_available ?? 0)
    setCollShortMonths((s?.months ?? []).filter((m) => m.pool_code === 'POOL-WZF'))
    setCollLapsed((s?.lapsed ?? []).filter((l) => l.pool_code === 'POOL-WZF'))
    setCollCovers((s?.covers ?? []).filter((c) => c.pool_code === 'POOL-WZF'))
    const wzfAnnouncements = ((ann ?? []) as typeof collAnnouncements).filter((a) => a.pool_code === 'POOL-WZF')
    setCollAnnouncements(wzfAnnouncements)
    const batchIds = Array.from(new Set(wzfAnnouncements.filter((a) => a.payment_batch_id).map((a) => a.payment_batch_id as string)))
    if (batchIds.length > 0) {
      const { data: bs } = await supabase.rpc('payment_batch_summary', { p_batch_ids: batchIds })
      setCollBatchSummary((bs ?? {}) as Record<string, { count: number; total: number }>)
    } else {
      setCollBatchSummary({})
    }

  }, [supabase])

  // Loaded on mount, not gated on the tab being open — see the matching
  // note on /admin/kafalat for why a badge that only knows its own count
  // after you've already opened the tab is not a useful badge.
  useEffect(() => { loadCollections() }, [loadCollections])

  const confirmCollAnnouncement = async (a: { id: string; amount: number }) => {
    const entered = prompt(t('pool.confirmAmountPrompt').replace('{amt}', fmt(a.amount)), String(a.amount))
    if (entered === null) return
    const confirmedAmount = Number(entered)
    if (!confirmedAmount || confirmedAmount <= 0) { toast.error(t('pool.confirmAmountInvalid')); return }
    setBusy(true)
    const { error } = await supabase.rpc('pool_confirm_payment', {
      p_payment_id: a.id, p_confirmed_amount: confirmedAmount !== a.amount ? confirmedAmount : null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(confirmedAmount < a.amount ? t('pool.ok.confirmedPartial').replace('{amt}', fmt(confirmedAmount)) : t('pool.ok.confirmed'))
    loadCollections()
  }

  // pool_payments.proof_url is a path in the same private donation_receipts
  // bucket a general pledge's slip lives in (both now upload through
  // /portal/statement) — never a plain public URL, so it needs a signed
  // link minted per view, the same way /admin/donors already does it.
  const [viewingProofId, setViewingProofId] = useState<string | null>(null)
  const viewProof = async (id: string, path: string) => {
    setViewingProofId(id)
    const { data, error } = await supabase.storage.from('donation_receipts').createSignedUrl(path, 300)
    setViewingProofId(null)
    if (error || !data?.signedUrl) { toast.error('Could not open the payment screenshot'); return }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  const declineCollAnnouncement = async (id: string) => {
    const reason = prompt(t('pool.declineReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('pool_decline_announcement', { p_payment_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.ok.declined'))
    loadCollections()
  }

  const openCollCover = (m: (typeof collShortMonths)[number]) => {
    setCollCoverAmount(m.remaining)
    setCollCoverNote('')
    setCollCovering(m)
  }

  const submitCollCover = async () => {
    if (!collCovering) return
    setBusy(true)
    const { data, error } = await supabase.rpc('pool_cover_shortfall', {
      p_pool_month_id: collCovering.pool_month_id, p_amount: collCoverAmount, p_note: collCoverNote || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.covered').replace('{v}', (data as { voucher_no: string })?.voucher_no ?? ''))
    setCollCovering(null)
    loadCollections()
  }

  const startRenewal = async (aw: AwardRow) => {
    if (!confirm(t('wz.startRenewalConfirm'))) return
    const { error } = await supabase.rpc('wazifa_start_renewal', { p_award_id: aw.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ok.renewalStarted'))
    load()
  }

  // Three separate, small actions rather than one form — the figure, the
  // agreement, and the activation each happen at a different moment and are
  // each somebody else's decision (migration 269/270).
  const latestAgreementFor = (awardId: string) => agreements.find((a) => a.award_id === awardId)

  // The one place a standard-track plan is set or revised — same function
  // the decision form uses inline (migration 278/284), so there is only
  // ever one way this figure gets computed and one place an agreement
  // gets (re-)sent from.
  const saveInstalmentPlan = async () => {
    if (!planAwardTarget || !planAwardForm.start_date || !planAwardForm.end_date) {
      toast.error(t('wz.ins.err.dates')); return
    }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_set_installment_plan', {
      p_award_id: planAwardTarget.id, p_basis: planAwardForm.basis,
      p_percentage: planAwardForm.basis === 'percentage' ? planAwardForm.percentage : null,
      p_start_date: planAwardForm.start_date, p_end_date: planAwardForm.end_date,
      p_due_day: planAwardForm.due_day, p_pay_to: planAwardForm.pay_to,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ins.planSaved'))
    setPlanAwardTarget(null)
    load()
  }

  const activateAward = async (aw: AwardRow) => {
    if (!confirm(t('wz.ins.activateConfirm'))) return
    const { error } = await supabase.rpc('wazifa_activate_award', { p_award_id: aw.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ins.activated'))
    load()
  }

  // ── Screening: the zakat-family check, run as part of the same action
  // that moves the application off "just submitted" (migration 275). ─────
  const openScreen = async (a: Application) => {
    setScreenTarget(a)
    setScreenCandidates([])
    setScreenLoading(true)
    const { data, error } = await supabase.rpc('wazifa_screen_application', { p_application_id: a.id })
    setScreenLoading(false)
    if (error) { toast.error(friendlyError(error)); setScreenTarget(null); return }
    setScreenCandidates(((data as { candidates: ZakatCandidate[] })?.candidates) ?? [])
    load()
  }
  const confirmZakatMatch = async (studentId: string, registerId: string | null) => {
    const { error } = await supabase.rpc('wazifa_confirm_zakat_match', { p_student_id: studentId, p_register_id: registerId })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(registerId ? t('wz.zakat.matched') : t('wz.zakat.cleared'))
    setScreenTarget(null)
    load()
  }

  // ── The interim grant — zakat-track only, 1-12 months, stoppable
  // (migration 276). Paying a raised month reuses the existing pay flow
  // (setPayTarget), since a month is an ordinary wazifa_instalment. ───────
  const startGrant = async () => {
    if (!grantTarget || grantForm.monthly_amount <= 0) { toast.error(t('wz.err.amount')); return }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_start_interim_grant', {
      p_award_id: grantTarget.id, p_months: grantForm.months,
      p_monthly_amount: grantForm.monthly_amount, p_pay_to: grantForm.pay_to,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.grant.started'))
    setGrantTarget(null)
    load()
  }
  const stopGrant = async () => {
    if (!stopGrantTarget || !stopGrantReason.trim()) { toast.error(t('wz.grant.reasonRequired')); return }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_stop_interim_grant', {
      p_grant_id: stopGrantTarget.id, p_reason: stopGrantReason.trim(),
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.grant.stopped'))
    setStopGrantTarget(null)
    setStopGrantReason('')
    load()
  }

  // ── A check-in — a phone call, written down, independent of who got
  // paid (migration 277). ──────────────────────────────────────────────
  const submitCheckIn = async () => {
    if (!checkInTarget) return
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_record_check_in', {
      p_award_id: checkInTarget.id, p_method: checkInForm.method,
      p_confirmed: checkInForm.confirmed, p_note: checkInForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.checkin.saved'))
    setCheckInTarget(null)
    setCheckInForm({ method: 'phone_institute', confirmed: true, note: '' })
    load()
  }

  // ── The one button that turns on repayment — already existed
  // (wazifa_mark_employed, migration 235), never had a button until now. ──
  const submitMarkEmployed = async () => {
    if (!employTarget || employForm.monthly_amount <= 0) { toast.error(t('wz.err.amount')); return }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_mark_employed', {
      p_student_id: employTarget.id, p_monthly_amount: employForm.monthly_amount,
      p_employer_note: employForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.employ.started'))
    setEmployTarget(null)
    load()
  }

  // ── The applicant's own "I can pay from my pocket" offer — approved,
  // declined, or reallocated to a figure the committee thinks is more
  // realistic, all in the same action (migration 279). ────────────────────
  const [reallocateTarget, setReallocateTarget] = useState<Application | null>(null)
  const [reallocateAmount, setReallocateAmount] = useState(0)
  const decideOffer = async (app: Application, decision: 'approved' | 'declined', revisedAmount?: number) => {
    const { error } = await supabase.rpc('wazifa_decide_offered_contribution', {
      p_application_id: app.id, p_decision: decision, p_revised_amount: revisedAmount ?? null,
    })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(decision === 'approved' ? t('wz.offer.approved') : t('wz.offer.declined'))
    setReallocateTarget(null)
    load()
  }

  // ── Recording a payment against a charge the automated plan already
  // raised (wazifa_installment_charges, migration 270/278). This is the
  // one manual step left in the whole standard-track flow — money
  // changing hands is the one thing that should stay a deliberate click. ──
  const submitPayCharge = async () => {
    if (!payChargeTarget || payChargeForm.amount <= 0) { toast.error(t('wz.err.amount')); return }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_pay_installment_charge', {
      p_charge_id: payChargeTarget.id, p_amount: payChargeForm.amount, p_method: payChargeForm.method,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ins.paySuccess'))
    setPayChargeTarget(null)
    load()
  }

  // ── Releasing a month's support to a student on the disburse-then-
  // settle plan (migration 287) — same "raised automatically, paid on a
  // deliberate click" shape as submitPayCharge, opposite direction. ──────
  const submitPayDisbursement = async () => {
    if (!payDisbursementTarget) return
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_pay_disbursement_charge', {
      p_charge_id: payDisbursementTarget.id, p_method: payDisbursementForm.method,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ins.paySuccess'))
    setPayDisbursementTarget(null)
    load()
  }

  // The one manual step on the "settle once employed" trigger — nobody
  // can put a date on it in advance, so an admin confirming it is the
  // date (migration 287).
  const triggerSettlement = async (aw: AwardRow) => {
    if (!confirm(t('wz.plan.confirmTrigger'))) return
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_trigger_settlement', { p_award_id: aw.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.plan.triggered'))
    load()
  }

  // Opens the calendar — every month from the plan's start, real status
  // per month (paid / due / not yet reached), nothing inferred or hidden
  // behind a running total (migration 289).
  const openCalendar = async (aw: AwardRow) => {
    setCalendarTarget(aw)
    setCalendarSelected(new Set())
    setCalendarMethod('cash')
    setCalendarLoading(true)
    const { data, error } = await supabase.rpc('wazifa_award_calendar', { p_award_id: aw.id })
    setCalendarLoading(false)
    if (error) { toast.error(friendlyError(error)); setCalendarTarget(null); return }
    setCalendarMonths(((data as { months?: typeof calendarMonths })?.months) ?? [])
  }
  const toggleCalendarMonth = (month: string, status: string) => {
    if (status === 'paid') return
    const next = new Set(calendarSelected)
    if (next.has(month)) next.delete(month); else next.add(month)
    setCalendarSelected(next)
  }
  const calendarSelectedTotal = calendarMonths
    .filter((m) => calendarSelected.has(m.month))
    .reduce((s, m) => s + (m.amount - m.paid_pkr), 0)
  const submitCalendarPay = async () => {
    if (!calendarTarget || calendarSelected.size === 0) return
    setBusy(true)
    const { data, error } = await supabase.rpc('wazifa_pay_specific_months', {
      p_award_id: calendarTarget.id, p_months: Array.from(calendarSelected), p_method: calendarMethod,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const months = (data as { months?: string[] })?.months ?? []
    toast.success(t('wz.cal.paySuccess').replace('{months}', months.join(', ')))
    setCalendarTarget(null)
    load()
  }

  const studentOf = (id: string) => students.find((s) => s.id === id)
  // One typed-up row, several signatures on the paper. The count is the
  // person who entered it plus everyone they named.
  const verificationCount = (appId: string) => {
    const v = verifications.find((x) => x.application_id === appId) as (Verification & {
      co_verifier_ids?: string[]; co_verifier_names?: string[] }) | undefined
    if (!v) return 0
    return 1 + (v.co_verifier_ids?.length ?? 0) + (v.co_verifier_names?.length ?? 0)
  }
  const docsOf = (appId: string) => documents.filter((d) => d.application_id === appId)
  const myVerification = (appId: string) => verifications.find((v) => v.application_id === appId)

  const addApplicant = async () => {
    if (!form.full_name.trim() || !form.institution.trim() || !form.programme.trim()) {
      toast.error(t('wz.err.required')); return
    }
    // Only a father or mother, in person — no other relation is recorded
    // as the one applying for a child (migration 274).
    if (form.applicant_for === 'own_child' && !['father', 'mother'].includes(form.applicant_relation)) {
      toast.error(t('wz.err.applicantRelation')); return
    }
    setBusy(true)
    const { data: student, error } = await supabase.from('wazifa_students').insert({
      full_name: form.full_name, full_name_ur: form.full_name_ur || null,
      father_name: form.father_name || null, mother_name: form.mother_name || null, phone: form.phone || null,
      gender: form.gender, is_orphan: form.is_orphan,
      household_monthly_income_pkr: form.household_monthly_income_pkr,
      siblings_studying: form.siblings_studying,
    }).select('id').single()
    if (error) { setBusy(false); toast.error(friendlyError(error)); return }

    const year = `${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`
    const { data: app, error: appErr } = await supabase.from('wazifa_applications').insert({
      student_id: student.id, academic_year: year,
      level: form.level, institution: form.institution, programme: form.programme,
      city: form.city || null, last_exam_name: form.last_exam_name || null,
      last_exam_percent: form.last_exam_percent || null,
      requested_amount_pkr: form.requested_amount_pkr,
      need_statement: form.need_statement || null,
      applicant_for: form.applicant_for,
      applicant_relation: form.applicant_for === 'own_child' ? form.applicant_relation : null,
      status: 'submitted',
    }).select('id').single()
    if (appErr) { setBusy(false); toast.error(friendlyError(appErr)); return }

    // Scored immediately so the list can be ranked the moment it is opened.
    await supabase.rpc('wazifa_score_application', { p_application_id: app.id })
    setBusy(false)
    toast.success(t('wz.ok.added'))
    setShowForm(false)
    setForm(emptyStudent)
    load()
  }

  const rescoreAll = async () => {
    setBusy(true)
    for (const a of applications.filter((x) => ['submitted', 'screening', 'verified', 'interview'].includes(x.status))) {
      await supabase.rpc('wazifa_score_application', { p_application_id: a.id })
    }
    setBusy(false)
    toast.success(t('wz.ok.rescored'))
    load()
  }

  const openSheet = async (a: Application) => {
    const { data, error } = await supabase.rpc('wazifa_application_sheet', { p_application_id: a.id })
    if (error) { toast.error(friendlyError(error)); return }
    setSheet(data as Record<string, unknown>)
  }

  const printSheet = () => {
    if (!sheetRef.current) return
    if (!printNodeInPopup(sheetRef.current, t('wz.applicationTitle'))) toast.error(t('pwz.err.popup'))
  }

  const payInstalmentNow = async () => {
    if (!payTarget) return
    setBusy(true)
    const { data, error } = await supabase.rpc('wazifa_pay_instalment', {
      p_instalment_id: payTarget.id, p_method: payForm.method,
      p_note: payForm.note || null,
      p_challan_no: payForm.challan_no || null,
      p_school_id: payForm.school_id || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`${t('wz.ok.paid')} ${(data as { voucher_no: string }).voucher_no}`)
    setPayTarget(null)
    load()
  }

  const takeContribution = async () => {
    if (!contribTarget || contribForm.amount <= 0) { toast.error(t('wz.err.amount')); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('wazifa_record_contribution', {
      p_award_id: contribTarget.id, p_amount: contribForm.amount,
      p_method: contribForm.method, p_for_month: new Date().toISOString().slice(0, 10),
      p_note: contribForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`${t('wz.ok.repaid')} ${(data as { voucher_no: string }).voucher_no}`)
    setContribTarget(null)
    setContribForm({ amount: 0, method: 'cash', note: '' })
    load()
  }

  const writeOff = async () => {
    if (!writeOffTarget) return
    if (!writeOffForm.reason.trim()) { toast.error(t('wz.writeOffReason')); return }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_write_off_loan', {
      p_award_id: writeOffTarget.id, p_amount: writeOffForm.amount, p_reason: writeOffForm.reason.trim(),
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ok.decided'))
    setWriteOffTarget(null)
    setWriteOffForm({ amount: 0, reason: '' })
    load()
  }

  const markDocSeen = async (docId: string, seen: boolean) => {
    const { error } = await supabase.rpc('wazifa_mark_document_seen', {
      p_document_id: docId, p_seen: seen,
    })
    if (error) { toast.error(friendlyError(error)); return }
    setDocuments(documents.map((d) => d.id === docId ? { ...d, original_seen: seen } : d))
  }

  const runFamilyCheck = async (a: Application) => {
    const st = studentOf(a.student_id)
    const { data, error } = await supabase.rpc('wazifa_family_check', {
      p_father_name: st?.father_name ?? null,
      p_phone: st?.phone ?? null,
      p_cnic: null,
    })
    if (error) { toast.error(friendlyError(error)); return }
    setFamilyCheck(data as Record<string, { code: string; name?: string; status: string; awarded?: number }[]>)
  }

  const saveVerification = async () => {
    if (!verifyTarget) return
    const { data: me } = await supabase.rpc('current_admin_user_id')
    if (!me) { toast.error(t('wz.err.notAdmin')); return }
    setBusy(true)
    const { error } = await supabase.from('wazifa_verifications').upsert({
      application_id: verifyTarget.id, admin_user_id: me, ...vForm,
      co_verifier_ids: coVerifiers.length > 0 ? coVerifiers : null,
      co_verifier_names: coNames.trim()
        ? coNames.split(',').map((x) => x.trim()).filter(Boolean) : null,
    }, { onConflict: 'application_id,admin_user_id' })
    if (!error) {
      // A visit that turned up different marks corrects the record, and the
      // score is recomputed from the corrected figure rather than the claim.
      const obtained = Number(vForm.verified_obtained_marks) || 0
      const total = Number(vForm.verified_total_marks) || 0
      if (obtained > 0 && total > 0) {
        await supabase.from('wazifa_applications').update({
          last_exam_marks: obtained, last_exam_total: total,
          last_exam_percent: Math.round((obtained / total) * 10000) / 100,
        }).eq('id', verifyTarget.id)
        await supabase.rpc('wazifa_score_application', { p_application_id: verifyTarget.id })
      }
      // Verified is its own state, between "somebody has been" and "the
      // committee has decided" — otherwise a visited application sits in the
      // same bucket as one nobody has looked at.
      await supabase.from('wazifa_applications').update({ status: 'verified' })
        .eq('id', verifyTarget.id).in('status', ['submitted', 'screening'])
    }
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ok.verified'))
    setVerifyTarget(null)
    setVForm({ ...emptyVerification })
    setCoVerifiers([])
    setCoNames('')
    load()
  }

  const recordDecision = async () => {
    if (!decideTarget) return
    const settingCollectNow = dForm.set_plan && dForm.plan_kind === 'collect_now'
    const settingDisburseThenSettle = dForm.set_plan && dForm.plan_kind === 'disburse_then_settle'
    if (settingCollectNow && (!dForm.installment_start_date || !dForm.installment_end_date)) {
      toast.error(t('wz.ins.err.dates')); return
    }
    if (settingDisburseThenSettle && (!dForm.disbursement_start_date || !dForm.disbursement_end_date || dForm.disbursement_monthly <= 0)) {
      toast.error(t('wz.ins.err.dates')); return
    }
    setBusy(true)
    const { data, error } = await supabase.rpc('wazifa_record_decision', {
      p_application_id: decideTarget.id,
      p_decision: dForm.decision,
      p_amount: dForm.amount,
      p_as_loan: dForm.as_loan,
      p_funded_by: dForm.funded_by,
      p_reason: dForm.reason || null,
      p_reason_ur: dForm.reason_ur || null,
      p_internal_note: dForm.internal_note || null,
      p_meeting_id: null,
      p_shortfall_note: dForm.shortfall_note || null,
      // The collect-now plan is set in this same call (migration 278).
      // Disburse-then-settle (migration 287) is a second call right below
      // instead — it needed three more parameters than collect-now ever
      // did, and wazifa_record_decision already carries the scars of one
      // round of "just add another optional param here" (the dead
      // pre-284 overload cleaned up in migration 285); it doesn't need a
      // second one.
      p_installment_basis: settingCollectNow ? dForm.installment_basis : null,
      p_installment_percentage: settingCollectNow && dForm.installment_basis === 'percentage' ? dForm.installment_percentage : null,
      p_installment_start_date: settingCollectNow ? dForm.installment_start_date : null,
      p_installment_end_date: settingCollectNow ? dForm.installment_end_date : null,
      p_installment_due_day: settingCollectNow ? dForm.installment_due_day : null,
      p_installment_pay_to: settingCollectNow ? dForm.installment_pay_to : 'student',
    })
    if (error) { setBusy(false); toast.error(friendlyError(error)); return }

    if (settingDisburseThenSettle) {
      const awardId = (data as { award_id?: string } | null)?.award_id
      if (awardId) {
        const { error: planError } = await supabase.rpc('wazifa_set_disbursement_settlement_plan', {
          p_award_id: awardId,
          p_disbursement_monthly: dForm.disbursement_monthly,
          p_disbursement_start: dForm.disbursement_start_date,
          p_disbursement_end: dForm.disbursement_end_date,
          p_disbursement_due_day: dForm.disbursement_due_day,
          p_disbursement_pay_to: dForm.disbursement_pay_to,
          p_settlement_monthly: dForm.settlement_trigger === 'none' ? null : dForm.settlement_monthly,
          p_settlement_trigger: dForm.settlement_trigger,
          p_settlement_due_day: dForm.settlement_due_day,
        })
        if (planError) {
          setBusy(false)
          toast.error(friendlyError(planError))
          toast.error(t('wz.ok.decided'))
          setDecideTarget(null)
          load()
          return
        }
      }
    }

    setBusy(false)
    toast.success(dForm.set_plan ? t('wz.ok.decidedWithPlan') : t('wz.ok.decided'))
    setDecideTarget(null)
    load()
  }

  const generatePlan = async () => {
    if (!planTarget) return
    if (!planForm.starts_on) { toast.error(t('wz.err.startDate')); return }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_generate_repayment_plan', {
      p_award_id: planTarget.id,
      p_starts_on: planForm.starts_on,
      p_instalments: planForm.instalments,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ok.planMade'))
    setPlanTarget(null)
    load()
  }

  const recordRepayment = async () => {
    if (!repayTarget) return
    if (repayForm.amount <= 0) { toast.error(t('wz.err.amount')); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('wazifa_record_repayment', {
      p_award_id: repayTarget.id, p_amount: repayForm.amount,
      p_method: repayForm.method, p_note: repayForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const d = data as { receipt_no: string }
    toast.success(`${t('wz.ok.repaid')} ${d.receipt_no}`)
    setRepayTarget(null)
    setRepayForm({ amount: 0, method: 'cash', note: '' })
    load()
  }

  const grantAward = async () => {
    if (!awardTarget) return
    if (awardForm.amount <= 0) { toast.error(t('wz.err.amount')); return }
    setBusy(true)
    const { error } = await supabase.from('wazifa_awards').insert({
      application_id: awardTarget.id, student_id: awardTarget.student_id,
      academic_year: awardTarget.academic_year,
      awarded_amount_pkr: awardForm.amount, funded_by: awardForm.funded_by,
      continuation_condition: awardForm.condition || null,
    })
    if (!error) {
      await supabase.from('wazifa_applications').update({ status: 'approved' }).eq('id', awardTarget.id)
      await supabase.from('wazifa_students').update({ status: 'awarded' }).eq('id', awardTarget.student_id)
    }
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ok.awarded'))
    setAwardTarget(null)
    setAwardForm({ amount: 0, funded_by: 'sadqa', condition: '' })
    load()
  }

  const addInstalment = async () => {
    if (!instalmentTarget) return
    if (instalmentForm.amount <= 0) { toast.error(t('wz.err.amount')); return }
    setBusy(true)
    const { error } = await supabase.from('wazifa_instalments').insert({
      award_id: instalmentTarget.id, purpose: instalmentForm.purpose,
      description: instalmentForm.description || null,
      due_on: instalmentForm.due_on || null, amount_pkr: instalmentForm.amount,
      // The trigger overrides this to 'student' on a zakat-funded award,
      // because tamleek requires the money to become the student's before it
      // becomes the university's.
      pay_to: instalmentTarget.funded_by === 'zakat' ? 'student' : 'institution',
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ok.instalmentAdded'))
    setInstalmentTarget(null)
    setInstalmentForm({ purpose: 'admission_fee', description: '', due_on: '', amount: 0 })
    load()
  }

// 'verified' (migration 216) sat between "somebody has been" and "the
// committee has decided" — the committee's own queue to work from, per
// that migration's own comment — but was never added here, so a verified
// application simply disappeared from this tab the moment a verifier
// recorded their visit, with no decision ever possible on it.
const open = applications.filter((a) => ['submitted', 'screening', 'verified', 'interview', 'waitlisted'].includes(a.status))

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <BookOpen size={26} className="text-dp-secondary" /> {t('wz.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('wz.blurb')}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowGuide((v) => !v)}
            className="flex items-center gap-1.5 px-3.5 py-2.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13.5px] font-semibold hover:border-dp-secondary transition-all cursor-pointer">
            <HelpCircle size={16} /> {t('wz.guide.toggle')}
            <ChevronDown size={14} className={`transition-transform ${showGuide ? 'rotate-180' : ''}`} />
          </button>
          <button onClick={rescoreAll} disabled={busy}
            className="flex items-center gap-1.5 px-3.5 py-2.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer disabled:opacity-50">
            <Calculator size={15} /> {t('wz.rescore')}
          </button>
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <Plus size={16} /> {t('wz.addApplicant')}
          </button>
        </div>
      </div>

      {showGuide && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5 space-y-4">
          {([
            ['applications', 'wz.guide.applications'],
            ['awards', 'wz.guide.awards'],
            ['loans', 'wz.guide.loans'],
            ['collections', 'wz.guide.collections'],
          ] as const).map(([key, base]) => (
            <div key={key}>
              <h4 className="font-heading text-[13.5px] font-bold text-dp-primary mb-1">{t(`${base}.title`)}</h4>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t(`${base}.body`)}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {([
          ['students_supported', 'wz.card.supported'],
          ['applications_open', 'wz.card.open'],
          ['girls', 'wz.card.girls'],
          ['graduated', 'wz.card.graduated'],
        ] as const).map(([key, label]) => (
          <div key={key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t(label)}</p>
            <p className="font-heading text-[24px] font-bold text-dp-primary">{summary[key] ?? 0}</p>
          </div>
        ))}
      </div>

      {/* ── This month's instalment collection — the accountant's worklist,
          not a separate report page. Computed client-side from what load()
          already fetched; no new query. */}
      {(installmentCharges.length > 0 || repaymentSchedule.length > 0) && (() => {
        const now = new Date()
        const monthCharges = installmentCharges.filter((c) => {
          const d = new Date(c.due_on)
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
        })
        const collected = monthCharges.reduce((s, c) => s + Number(c.paid_pkr), 0)
        const due = monthCharges.reduce((s, c) => s + Number(c.amount_pkr), 0)
        // Standard-track instalments overdue, and zakat-track repayments
        // overdue (migration 235) — two different tables, one worklist,
        // since an accountant does not think in tables, only in "who is
        // behind." No penalty is computed or implied here — a committee
        // decides what, if anything, follows from being on this list.
        const overdue = installmentCharges.filter((c) => c.status !== 'paid' && new Date(c.due_on) < now)
        const overdueAmt = overdue.reduce((s, c) => s + (Number(c.amount_pkr) - Number(c.paid_pkr)), 0)
        const repayOverdue = repaymentSchedule.filter((r) => r.status !== 'paid' && new Date(r.due_on) < now)
        const repayOverdueAmt = repayOverdue.reduce((s, r) => s + (Number(r.amount_pkr) - Number(r.paid_pkr)), 0)
        return (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-5">
            <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
              <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('wz.ins.report.dueThisMonth')}</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">Rs {fmt(due)}</p>
            </div>
            <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
              <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('wz.ins.report.collected')}</p>
              <p className="font-heading text-[22px] font-bold text-emerald-700">Rs {fmt(collected)}</p>
            </div>
            <div className={`bg-white border rounded-lg px-4 py-3 ${overdue.length > 0 ? 'border-dp-error' : 'border-dp-outline-variant'}`}>
              <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('wz.ins.report.overdue')}</p>
              <p className={`font-heading text-[22px] font-bold ${overdue.length > 0 ? 'text-dp-error' : 'text-dp-primary'}`}>
                Rs {fmt(overdueAmt)} <span className="text-[13px] font-sans font-semibold text-dp-on-surface-variant">({overdue.length})</span>
              </p>
            </div>
            <div className={`bg-white border rounded-lg px-4 py-3 ${repayOverdue.length > 0 ? 'border-dp-error' : 'border-dp-outline-variant'}`}>
              <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('wz.ins.report.repayOverdue')}</p>
              <p className={`font-heading text-[22px] font-bold ${repayOverdue.length > 0 ? 'text-dp-error' : 'text-dp-primary'}`}>
                Rs {fmt(repayOverdueAmt)} <span className="text-[13px] font-sans font-semibold text-dp-on-surface-variant">({repayOverdue.length})</span>
              </p>
            </div>
          </div>
        )
      })()}

      <div className="flex flex-wrap gap-2 mb-4">
        {([
          ['applications', `${t('wz.tab.applications')} (${open.length})`],
          ['awards', `${t('wz.tab.awards')} (${awards.length})`],
          ['collections', `${t('wz.tab.collections')}${(collAnnouncements.length + collLapsed.length + collShortMonths.length) ? ` (${collAnnouncements.length + collLapsed.length + collShortMonths.length})` : ''}`],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === key ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && tab === 'applications' && (
        <div className="space-y-3">
          {open.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('wz.noApplications')}</p>
            </div>
          )}
          {open.map((a) => {
            const s = studentOf(a.student_id)
            return (
              <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-mono text-[11.5px] text-dp-on-surface-variant">{s?.code}</span>
                    <span className="font-sans text-[15px] font-bold text-dp-on-surface">{s?.full_name}</span>
                    {s?.is_orphan && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('kf.orphan')}</span>}
                    {s?.gender === 'female' && <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 text-[10.5px] font-bold">{t('wz.girl')}</span>}
                    {s?.is_zakat_family && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10.5px] font-bold">{t('wz.zakat.badge')}</span>}
                  </div>
                  <p className="font-sans text-[13.5px] text-dp-on-surface">
                    {t(`wz.level.${a.level}`)} · {a.programme} · <span className="text-dp-on-surface-variant">{a.institution}{a.city ? `, ${a.city}` : ''}</span>
                  </p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                    {a.last_exam_name && `${a.last_exam_name}: ${a.last_exam_percent ?? '—'}% · `}
                    {t('wz.requested')} Rs {fmt(a.requested_amount_pkr)}
                  </p>
                  {a.need_statement && <p className="font-sans text-[12.5px] text-dp-on-surface mt-1.5 italic">{a.need_statement}</p>}

                  {/* ── "I can pay this much myself" — its own decision,
                      separate from the award itself (migration 278/279). */}
                  {a.offered_monthly_contribution_pkr > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 bg-dp-secondary/5 border border-dp-secondary/20 rounded-lg px-3 py-2">
                      <span className="font-sans text-[12.5px] text-dp-on-surface">
                        {t('wz.offer.label')} <strong>Rs {fmt(a.offered_monthly_contribution_pkr)}</strong>/{t('pkf.month')}
                        {a.offered_contribution_status !== 'pending' && (
                          <span className={`ms-2 px-2 py-0.5 rounded-full text-[10.5px] font-bold ${
                            a.offered_contribution_status === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                            {a.offered_contribution_status === 'approved' ? t('wz.offer.approvedBadge') : t('wz.offer.declinedBadge')}
                          </span>
                        )}
                      </span>
                      {a.offered_contribution_status === 'pending' && (
                        <div className="flex gap-1.5 ms-auto">
                          <button onClick={() => decideOffer(a, 'approved')}
                            className="flex items-center gap-1 px-2.5 py-1 bg-emerald-600 text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                            {t('wz.offer.approve')}
                          </button>
                          <button onClick={() => { setReallocateTarget(a); setReallocateAmount(a.offered_monthly_contribution_pkr) }}
                            className="flex items-center gap-1 px-2.5 py-1 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[11.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                            <Pencil size={11} /> {t('wz.offer.reallocate')}
                          </button>
                          <button onClick={() => decideOffer(a, 'declined')}
                            className="flex items-center gap-1 px-2.5 py-1 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[11.5px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                            {t('wz.offer.decline')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 mt-2">
                    {verificationCount(a.id) > 0 ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11.5px] font-bold">
                        {verificationCount(a.id)} {t('wz.verifiedBy')}
                        {' / '}{minVerifiers}
                        {verifications.find((v) => v.application_id === a.id)?.recommendation &&
                          ` · ${t(`wz.rec.${verifications.find((v) => v.application_id === a.id)!.recommendation}`)}`}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[11.5px] font-bold">
                        {t('wz.notVerified')}
                      </span>
                    )}
                    <span className="px-2 py-0.5 rounded bg-dp-surface-container-low text-[11.5px] font-semibold">
                      {t('wz.merit')} {a.merit_score ?? '—'}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-dp-surface-container-low text-[11.5px] font-semibold">
                      {t('wz.need')} {a.need_score ?? '—'}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-dp-secondary/10 text-dp-secondary text-[11.5px] font-bold">
                      {t('wz.score')} {a.total_score ?? '—'}
                    </span>
                    {decisionsByApp[a.id] && (
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11.5px] font-bold">
                        {t(`pwz.decision.${decisionsByApp[a.id].decision}`)}
                        {decisionsByApp[a.id].approved_amount_pkr > 0 && ` — Rs ${fmt(decisionsByApp[a.id].approved_amount_pkr)}`}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  {/* Verification first, decision second. The order is the
                      point: a committee deciding before anybody has stood in
                      the courtyard is deciding on a claim. */}
                  <button onClick={() => openSheet(a)}
                    className="flex items-center gap-1.5 px-3.5 py-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                    <FileText size={15} /> {t('wz.viewApplication')}
                  </button>
                  {/* Screening runs the zakat-family check as part of moving
                      the application off "just submitted" — the one thing
                      that decides which of the two tracks this award ends
                      up on (migration 275). */}
                  <button onClick={() => openScreen(a)}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all cursor-pointer whitespace-nowrap ${
                      s?.is_zakat_family ? 'border border-emerald-600 text-emerald-700' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:text-dp-primary'}`}>
                    <ShieldCheck size={15} /> {a.status === 'submitted' ? t('wz.screen.button') : t('wz.screen.recheck')}
                  </button>
                  <button onClick={() => runFamilyCheck(a)}
                    className="flex items-center gap-1.5 px-3.5 py-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                    <Users size={15} /> {t('wz.familyCheck')}
                  </button>
                  <button onClick={() => {
                      const v = verifications.find((x) => x.application_id === a.id) as (Verification & {
                        co_verifier_ids?: string[]; co_verifier_names?: string[] }) | undefined
                      setVerifyTarget(a)
                      setVForm({ ...emptyVerification, recommended_amount_pkr: a.requested_amount_pkr })
                      setCoVerifiers(v?.co_verifier_ids ?? [])
                      setCoNames((v?.co_verifier_names ?? []).join(', '))
                    }}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all cursor-pointer whitespace-nowrap ${myVerification(a.id) ? 'border border-dp-outline-variant text-dp-on-surface-variant' : 'bg-dp-secondary text-white hover:bg-dp-primary'}`}>
                    <ClipboardCheck size={15} /> {myVerification(a.id) ? t('wz.editVerification') : t('wz.enterVerification')}
                  </button>
                  <button
                    disabled={verificationCount(a.id) < minVerifiers}
                    title={verificationCount(a.id) < minVerifiers ? t('wz.verifyFirst') : undefined}
                    onClick={() => {
                      const v = verifications.find((x) => x.application_id === a.id)
                      setDecideTarget(a)
                      setDForm({
                        decision: 'approved_full',
                        amount: Number(v?.recommended_amount_pkr) || a.requested_amount_pkr,
                        as_loan: false, funded_by: 'sadqa',
                        reason: '', reason_ur: '', internal_note: '', shortfall_note: '',
                        set_plan: false, installment_basis: 'full', installment_percentage: 50,
                        installment_start_date: '', installment_end_date: '', installment_due_day: 10, installment_pay_to: 'student',
                        plan_kind: 'disburse_then_settle', disbursement_monthly: 0,
                        disbursement_start_date: '', disbursement_end_date: '', disbursement_due_day: 10, disbursement_pay_to: 'student',
                        // The family's own proven monthly capacity, carried
                        // straight from the application — the whole point
                        // being that this figure is not recomputed, it's
                        // what they already showed they could sustain.
                        // "What the student can manage themselves" — already
                        // asked on the application form (offered_monthly_
                        // contribution_pkr) for the running-share purpose;
                        // it's the same proven figure this plan wants, so
                        // it's reused rather than asking the family the
                        // same question under a second name.
                        settlement_monthly: Number(a.family_monthly_capacity_pkr || a.offered_monthly_contribution_pkr) || 0,
                        settlement_trigger: 'course_end', settlement_due_day: 10,
                      })
                    }}
                    className="flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                    <Gavel size={15} /> {t('wz.decide')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && tab === 'awards' && (
        <div className="space-y-3">
          {awards.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('wz.noAwards')}</p>
            </div>
          )}
          {awards.map((aw) => {
            const s = studentOf(aw.student_id)
            // The automated plan (migration 278/284) tracks what it has
            // collected in contributed_pkr and wazifa_installment_charges,
            // not in this instalments/wazifa_instalments list — that table
            // is for the zakat track's one-off costs (interim grant
            // admission fees etc.), a genuinely different thing. Reading
            // it for a standard-track award's "paid so far" is why that
            // figure sat at Rs 0 forever no matter what was actually paid
            // (migration 285).
            const isDisburseThenSettle = aw.plan_type === 'disburse_then_settle'
            const onPlan = !!aw.installment_basis || isDisburseThenSettle
            const mine = instalments.filter((i) => i.award_id === aw.id)
            const paid = onPlan
              ? Number(aw.contributed_pkr ?? 0)
              : mine.filter((i) => i.status === 'paid').reduce((x, i) => x + Number(i.amount_pkr), 0)
            // A disburse-then-settle plan's "total to settle" is what was
            // actually paid out — not a percentage of the award, which
            // this plan never used (migration 287).
            const planTotal = isDisburseThenSettle
              ? Number(aw.disbursed_pkr ?? 0)
              : aw.installment_basis === 'percentage'
                ? Math.round(aw.awarded_amount_pkr * (aw.installment_percentage ?? 100) / 100)
                : aw.awarded_amount_pkr
            return (
              <div key={aw.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11.5px] text-dp-on-surface-variant">{s?.code}</span>
                      <span className="font-sans text-[15px] font-bold text-dp-on-surface">{s?.full_name}</span>
                      <span className="px-2 py-0.5 rounded-full bg-dp-surface-container-low text-[11px] font-bold">{t(`wz.funded.${aw.funded_by}`)}</span>
                    </div>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                      {aw.academic_year} · {t('wz.awarded')} <strong>Rs {fmt(aw.awarded_amount_pkr)}</strong> · {t('wz.paidSoFar')} Rs {fmt(paid)}
                    </p>
                    {aw.funded_by === 'zakat' && (
                      <p className="font-sans text-[12px] text-amber-700 mt-1">{t('wz.zakatRouting')}</p>
                    )}
                    {aw.is_loan && onPlan && (
                      // Standard track: nothing was ever "lent" to be
                      // "returned" — the plan owes from day one, so this
                      // reads as progress against the plan total (the
                      // qarz-e-hasana share of the award, not the full
                      // amount — half of it on a 50% plan) rather than the
                      // old Lent/Returned framing that only fits the
                      // zakat/pre-278 loan shape below.
                      <p className="font-sans text-[12.5px] text-emerald-700 mt-1 font-semibold">
                        {t('pwz.qarzBadge')} · {t('wz.planPaidOf').replace('{paid}', fmt(paid)).replace('{total}', fmt(planTotal))}
                      </p>
                    )}
                    {aw.is_loan && !onPlan && (
                      <p className="font-sans text-[12.5px] text-emerald-700 mt-1 font-semibold">
                        {t('pwz.qarzBadge')} · {t('pwz.loanRepaid')} Rs {fmt(Number(aw.repaid_pkr ?? 0))}
                        {' · '}{t('pwz.loanOutstanding')} Rs {fmt(aw.awarded_amount_pkr - Number(aw.repaid_pkr ?? 0))}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {/* A new academic year — the same student, verified
                        again rather than assumed. Pre-fills a draft from
                        this award's own application, so the student edits
                        what changed instead of starting from nothing. */}
                    <button onClick={() => startRenewal(aw)}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                      <RotateCcw size={14} /> {t('wz.startRenewal')}
                    </button>
                    {/* ── Everything below here only applies to the
                        zakat track (interim support, one-off costs, and
                        post-employment repayment — migration 235/276) or
                        to a loan that predates the automated plan. A
                        standard-track award now runs entirely on the
                        instalment plan further down this card — showing
                        these too was exactly the "why so many options"
                        confusion; they're either the wrong tool for that
                        award or already superseded. */}
                    {studentOf(aw.student_id)?.is_zakat_family && (
                      <button onClick={() => setInstalmentTarget(aw)}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
                        <Plus size={14} /> {t('wz.addInstalment')}
                      </button>
                    )}
                    {/* The student's own voluntary top-up — only once the
                        committee has approved (or reallocated) the figure
                        they offered on the application (migration 279).
                        Not the plan's own committee-fixed instalment,
                        which pays itself via the charges below. */}
                    {applications.find((a) => a.id === aw.application_id)?.offered_contribution_status === 'approved' && (
                      <button onClick={() => { setContribTarget(aw); setContribForm({ amount: Number(applications.find((a) => a.id === aw.application_id)?.offered_monthly_contribution_pkr ?? 0), method: 'cash', note: '' }) }}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-emerald-600 text-emerald-700 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-600 hover:text-white transition-all cursor-pointer">
                        <HandCoins size={14} /> {t('wz.contribution')}
                      </button>
                    )}
                    {/* Post-employment repayment only — the standard
                        track's own repayment is the instalment plan, not
                        this. Only a qarz-e-hasana has anything to repay at
                        all; a grant shows none of these. */}
                    {aw.is_loan && studentOf(aw.student_id)?.is_zakat_family && (
                      <>
                        <button onClick={() => { setPlanTarget(aw); setPlanForm({ starts_on: '', instalments: 12 }) }}
                          className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                          <CalendarClock size={14} /> {t('wz.plan.button')}
                        </button>
                        <button onClick={() => { setRepayTarget(aw); setRepayForm({ amount: 0, method: 'cash', note: '' }) }}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                          <HandCoins size={14} /> {t('wz.takeRepayment')}
                        </button>
                        <button onClick={() => { setWriteOffTarget(aw); setWriteOffForm({ amount: 0, reason: '' }) }}
                          className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                          <Ban size={14} /> {t('wz.writeOff')}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {mine.length > 0 && (
                  <div className="border-t border-dp-outline-variant pt-3 space-y-2">
                    {mine.map((i) => (
                      <div key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-sans text-[13.5px] font-semibold">{t(`wz.purpose.${i.purpose}`)}</span>
                          {i.due_on && <span className="font-sans text-[12px] text-dp-on-surface-variant ms-2">{new Date(i.due_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                          <span className="font-sans text-[12px] text-dp-on-surface-variant ms-2">→ {t(`wz.payTo.${i.pay_to}`)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-sans text-[13.5px] font-semibold tabular-nums">Rs {fmt(i.amount_pkr)}</span>
                          {i.status === 'paid' ? (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold">{i.receipt_no}</span>
                          ) : (
                            <button disabled={busy} onClick={() => { setPayTarget(i); setPayForm({ method: 'bank', challan_no: '', school_id: '', note: '' }) }}
                              className="flex items-center gap-1 px-2.5 py-1 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer disabled:opacity-50">
                              <HandCoins size={13} /> {t('wz.pay')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── The fixed monthly instalment — standard track only.
                    A confirmed zakat family gets the interim-grant block
                    below instead; the two never both apply to one award. */}
                {!studentOf(aw.student_id)?.is_zakat_family && (() => {
                  const monthly = Number(aw.student_monthly_contribution_pkr ?? 0)
                  const dueDay = aw.installment_due_day ?? null
                  const ag = latestAgreementFor(aw.id)
                  return (
                    <div className="border-t border-dp-outline-variant pt-3 mt-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="font-sans text-[12.5px] text-dp-on-surface-variant">
                        {monthly > 0 ? (
                          <>
                            {t('wz.ins.fixed')} <strong className="text-dp-on-surface">Rs {fmt(monthly)}</strong> · {t('wz.ins.dueDay')} {dueDay ?? '—'}
                            {aw.installment_active ? (
                              <span className="ms-2 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold">{t('wz.ins.active')}</span>
                            ) : ag?.status === 'signed' ? (
                              <span className="ms-2 px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 text-[11px] font-bold">{t('wz.ins.readyToActivate')}</span>
                            ) : ag?.status === 'pending' ? (
                              <span className="ms-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold">{t('wz.ins.awaitingSignature')}</span>
                            ) : (
                              <span className="ms-2 px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant text-[11px] font-bold">{t('wz.ins.notSent')}</span>
                            )}
                          </>
                        ) : (
                          <span>{t('wz.ins.notSet')}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {/* Only before it's live — setting or revising the
                            plan already sends the agreement itself
                            (migration 278/284), so there is nothing left
                            for a separate "Send Agreement" button to do,
                            and once active this is a bigger decision than
                            a quick edit (see wz.ins.revise's own note). */}
                        {!aw.installment_active && (
                          <button onClick={() => { setPlanAwardTarget(aw)
                              setPlanAwardForm({
                                basis: aw.installment_basis ?? 'full', percentage: aw.installment_percentage ?? 50,
                                start_date: aw.installment_start_date ?? '', end_date: aw.installment_end_date ?? '',
                                due_day: dueDay || 10, pay_to: aw.installment_pay_to ?? 'student',
                              }) }}
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                            <Pencil size={13} /> {monthly > 0 ? t('wz.ins.revise') : t('wz.ins.setPlan')}
                          </button>
                        )}
                        {ag?.status === 'signed' && !aw.installment_active && !isDisburseThenSettle && (
                          <button onClick={() => activateAward(aw)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                            <UserCheck size={13} /> {t('wz.ins.activate')}
                          </button>
                        )}
                        {isDisburseThenSettle && aw.settlement_trigger === 'employment' && !aw.installment_active && (
                          <button onClick={() => triggerSettlement(aw)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                            <UserCheck size={13} /> {t('wz.plan.markEmployed')}
                          </button>
                        )}
                      </div>

                      {/* ── The disbursement half: what's due to go out to
                          the student this month, while they're still
                          studying (migration 287). ──────────────────────── */}
                      {isDisburseThenSettle && (
                        <div className="mt-2.5">
                          <p className="font-sans text-[12px] text-dp-on-surface-variant">
                            {t('wz.plan.supportGiven')} <strong className="text-dp-on-surface">Rs {fmt(aw.disbursed_pkr ?? 0)}</strong>
                            {aw.disbursement_monthly_pkr ? ` · Rs ${fmt(aw.disbursement_monthly_pkr)}/${t('pkf.month')}` : ''}
                            {aw.settlement_trigger === 'employment' && !aw.installment_active && (
                              <span className="ms-1.5 text-amber-700 font-semibold">· {t('wz.plan.awaitingEmployment')}</span>
                            )}
                          </p>
                          {disbursementCharges.filter((c) => c.award_id === aw.id && c.status !== 'paid').length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-2">
                              {disbursementCharges.filter((c) => c.award_id === aw.id && c.status !== 'paid').map((c) => (
                                <button key={c.id} onClick={() => setPayDisbursementTarget(c)}
                                  className="flex items-center gap-1.5 px-2.5 py-1 border border-emerald-600 text-emerald-700 rounded-lg font-sans text-[11.5px] font-semibold hover:bg-emerald-600 hover:text-white transition-all cursor-pointer">
                                  <HandCoins size={12} />
                                  {t('wz.plan.release')} {new Date(c.due_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · Rs {fmt(c.amount_pkr - c.paid_pkr)}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Charges the automated plan has already raised —
                          recording a payment is the one manual step left
                          in this whole flow. */}
                      {installmentCharges.filter((c) => c.award_id === aw.id && c.status !== 'paid').length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {installmentCharges.filter((c) => c.award_id === aw.id && c.status !== 'paid').map((c) => (
                            <button key={c.id} onClick={() => { setPayChargeTarget(c); setPayChargeForm({ amount: c.amount_pkr - c.paid_pkr, method: 'cash' }) }}
                              className="flex items-center gap-1.5 px-2.5 py-1 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[11.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
                              <HandCoins size={12} />
                              {new Date(c.due_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · Rs {fmt(c.amount_pkr - c.paid_pkr)}
                            </button>
                          ))}
                        </div>
                      )}
                      {aw.installment_active && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          {/* Replaces the old "pay N months in advance"
                              button — that one picked the next N unpaid
                              months silently; this shows every month and
                              which ones are already settled, and pays only
                              whichever get ticked (migration 289). */}
                          <button onClick={() => openCalendar(aw)}
                            className="flex items-center gap-1.5 px-2.5 py-1 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[11.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                            <CalendarClock size={12} /> {t('wz.cal.button')}
                          </button>
                          {/* Whether he's still actually studying is a
                              separate question from whether he's been paid
                              — the same check-in log the zakat track uses
                              (migration 277), not tied to any one track. */}
                          <button onClick={() => setCheckInTarget(aw)}
                            className="flex items-center gap-1.5 px-2.5 py-1 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[11.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                            <PhoneCall size={12} /> {t('wz.checkin.record')}
                          </button>
                        </div>
                      )}
                      {checkIns.filter((c) => c.award_id === aw.id).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {checkIns.filter((c) => c.award_id === aw.id).slice(0, 3).map((c) => (
                            <span key={c.id} className={`px-2 py-0.5 rounded text-[11px] font-semibold ${c.confirmed ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-dp-error'}`}>
                              {new Date(c.checked_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {t(`wz.checkin.method.${c.method}`)} · {c.confirmed ? t('wz.checkin.ok') : t('wz.checkin.notOk')}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* ── Zakat track: interim support while studying, then
                    repayment once employed (migration 235/276). ─────────── */}
                {studentOf(aw.student_id)?.is_zakat_family && (() => {
                  const student = studentOf(aw.student_id)!
                  const activeGrant = interimGrants.find((g) => g.award_id === aw.id && g.status === 'active')
                  const lastGrant = interimGrants.filter((g) => g.award_id === aw.id).sort((a, b) => a.id < b.id ? 1 : -1)[0]
                  const raisedMonths = instalments.filter((i) => i.award_id === aw.id && (i as Instalment & { interim_grant_id?: string }).interim_grant_id === activeGrant?.id).length
                  const myCheckIns = checkIns.filter((c) => c.award_id === aw.id).slice(0, 3)
                  return (
                    <div className="border-t border-dp-outline-variant pt-3 mt-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          {activeGrant ? (
                            <>
                              {t('wz.grant.running')} <strong className="text-dp-on-surface">Rs {fmt(activeGrant.monthly_amount_pkr)}/mo</strong>
                              {' · '}{raisedMonths}/{activeGrant.months_awarded} {t('wz.grant.monthsRaised')}
                              {' · '}{t(`wz.payTo.${activeGrant.pay_to}`)}
                            </>
                          ) : lastGrant?.status === 'stopped' ? (
                            <span className="text-dp-error">{t('wz.grant.wasStopped')}: {lastGrant.stopped_reason}</span>
                          ) : lastGrant?.status === 'completed' ? (
                            <span>{t('wz.grant.completed')}</span>
                          ) : (
                            <span>{t('wz.grant.none')}</span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {!activeGrant && student.employment_status !== 'employed' && (
                            <button onClick={() => { setGrantTarget(aw); setGrantForm({ months: 3, monthly_amount: 0, pay_to: 'institution' }) }}
                              className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
                              <Plus size={13} /> {t('wz.grant.start')}
                            </button>
                          )}
                          {activeGrant && (
                            <button onClick={() => { setStopGrantTarget(activeGrant); setStopGrantReason('') }}
                              className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-error text-dp-error rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-error hover:text-white transition-all cursor-pointer">
                              <StopCircle size={13} /> {t('wz.grant.stop')}
                            </button>
                          )}
                          <button onClick={() => setCheckInTarget(aw)}
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                            <PhoneCall size={13} /> {t('wz.checkin.record')}
                          </button>
                          {student.employment_status !== 'employed' ? (
                            <button onClick={() => { setEmployTarget(student); setEmployForm({ monthly_amount: 0, note: '' }) }}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                              <Briefcase size={13} /> {t('wz.employ.button')}
                            </button>
                          ) : (
                            <span className="px-2.5 py-1.5 rounded-lg bg-emerald-100 text-emerald-800 text-[12.5px] font-bold">
                              {t('wz.employ.badge')} · {t('pwz.loanRepaid')} Rs {fmt(Number(aw.repaid_pkr ?? 0))}
                            </span>
                          )}
                        </div>
                      </div>
                      {myCheckIns.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {myCheckIns.map((c) => (
                            <span key={c.id} className={`px-2 py-0.5 rounded text-[11px] font-semibold ${c.confirmed ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-dp-error'}`}>
                              {new Date(c.checked_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {t(`wz.checkin.method.${c.method}`)} · {c.confirmed ? t('wz.checkin.ok') : t('wz.checkin.notOk')}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Collections: shortfall, lapsed donors, and pledges awaiting
          confirmation — folded in from what used to be a separate
          /admin/pools screen, scoped to just Wazifa's shared pool. */}
      {!loading && tab === 'collections' && (
        <div className="space-y-6">

          {collPosition && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { v: fmt(collPosition.committed), l: t('pool.pledged') },
                  { v: String(collPosition.donors), l: t('pool.donors') },
                  { v: `${collPosition.coverage_percent}%`, l: t('kf.collections.coverage') },
                  { v: fmt(collPosition.received_this_month), l: t('kf.collections.receivedThisMonth') },
                ].map((s) => (
                  <div key={s.l}>
                    <p className="font-heading text-[17px] font-bold text-dp-primary">{s.v}</p>
                    <p className="font-sans text-[11px] text-dp-on-surface-variant">{s.l}</p>
                  </div>
                ))}
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant flex items-center gap-1.5">
                <Wallet size={12} />
                {t('pool.reserve').replace('{n}', String(collPosition.reserve_months)).replace('{target}', String(collPosition.reserve_target_months))}
              </p>
            </div>
          )}

          {collAnnouncements.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <HandCoins size={16} /> {t('pool.queueTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.queueBlurb')}</p>
              <div className="space-y-2">
                {collAnnouncements.map((a) => (
                  <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{a.donor_name ?? '—'}</p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {a.donor_phone && <a href={`tel:${a.donor_phone}`} className="text-dp-secondary hover:underline">{a.donor_phone}</a>}
                        {' · '}Rs {fmt(a.amount)} · {a.is_one_time ? t('pool.oneTime') : t('pool.recurringMonthly')}
                      </p>
                      {a.payment_batch_id && collBatchSummary[a.payment_batch_id]?.count > 1 && (
                        <span title="Sent as one payment along with other pledges — some may be on other Collections tabs or /admin/donors"
                          className="inline-block mt-1 text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-amber-100 text-amber-800">
                          Part of Rs {collBatchSummary[a.payment_batch_id].total.toLocaleString()} · {collBatchSummary[a.payment_batch_id].count} items
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {a.proof_url && (
                        <button onClick={() => viewProof(a.id, a.proof_url!)} disabled={viewingProofId === a.id}
                          className="font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer disabled:opacity-50">
                          {viewingProofId === a.id ? '...' : t('pool.viewProof')}
                        </button>
                      )}
                      <button onClick={() => confirmCollAnnouncement(a)} disabled={busy}
                        className="bg-dp-secondary text-white font-sans text-[12px] font-bold px-3 py-1.5 rounded-lg disabled:opacity-50 cursor-pointer">
                        {t('pool.confirmThis')}
                      </button>
                      <button onClick={() => declineCollAnnouncement(a.id)}
                        className="font-sans text-[12px] font-bold text-dp-on-surface-variant hover:underline cursor-pointer">
                        {t('pool.declineThis')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {collLapsed.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <Phone size={16} /> {t('pool.lapsedTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.lapsedBlurb')}</p>
              <div className="space-y-2">
                {collLapsed.map((l) => (
                  <div key={l.commitment_id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{l.name}</p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {l.phone && <a href={`tel:${l.phone}`} className="text-dp-secondary hover:underline">{l.phone}</a>}
                      {' · '}Rs {fmt(l.amount)}/{t('pkf.month')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {collShortMonths.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <AlertTriangle size={16} /> {t('pool.shortTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.shortBlurb').replace('{amt}', fmt(collUnrestricted))}</p>
              <div className="space-y-2">
                {collShortMonths.map((m) => (
                  <div key={m.pool_month_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-center gap-4">
                    <div className="flex-1 min-w-[200px]">
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {new Date(m.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                        {' · '}{t('pool.neededReceived').replace('{req}', fmt(m.required)).replace('{recd}', fmt(m.received))}
                      </p>
                    </div>
                    <p className="font-heading text-[18px] font-bold text-dp-secondary">{fmt(m.remaining)}</p>
                    <button onClick={() => openCollCover(m)}
                      className="bg-dp-primary text-white font-sans text-[12.5px] font-bold px-4 py-2 rounded-lg hover:opacity-90 cursor-pointer">
                      {t('pool.coverIt')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {collCovers.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <RotateCcw size={16} /> {t('pool.coversTitle')}
              </h3>
              <div className="space-y-2">
                {collCovers.map((c, i) => (
                  <div key={i} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">{new Date(c.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface">Rs {fmt(c.amount)}</p>
                    <p className="font-mono text-[11.5px] text-dp-secondary">{c.voucher_no ?? '—'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {collAnnouncements.length === 0 && collLapsed.length === 0 && collShortMonths.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.collections.allClear')}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Decline a qarz-e-hasana request ──────────────────────────── */}
      {/* ── Committee covers a shortfall ──────────────────────────────── */}
      {collCovering && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setCollCovering(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pool.coverTitle')}</h2>
              <button onClick={() => setCollCovering(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <Info size={15} className="text-dp-secondary shrink-0 mt-0.5" />
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('pool.coverExplain')}</p>
            </div>
            <label className="block font-sans text-[12.5px] font-bold text-dp-primary mb-1.5">{t('pool.coverAmount')}</label>
            <input type="number" min={1} max={collCovering.remaining} value={collCoverAmount}
              onChange={(e) => setCollCoverAmount(Number(e.target.value))} className="input-field mb-1.5" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-3.5">{t('pool.availableIs').replace('{amt}', fmt(collUnrestricted))}</p>
            <label className="block font-sans text-[12.5px] font-bold text-dp-primary mb-1.5">{t('pool.coverNote')}</label>
            <textarea value={collCoverNote} onChange={(e) => setCollCoverNote(e.target.value)} rows={2} className="input-field mb-4" />
            <button onClick={submitCollCover} disabled={busy}
              className="w-full bg-dp-primary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer">
              {busy ? t('action.saving') : t('pool.confirmCover')}
            </button>
          </div>
        </div>
      )}

      {/* ── The application exactly as it was submitted, printable ────────
          The committee prints this, carries it to the house, and marks the
          verification block on the back. Reading it on screen and reading it
          on paper have to be the same act. */}
      {sheet && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setSheet(null)}>
          <div className="bg-white rounded-lg w-full max-w-3xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-dp-outline-variant px-6 py-4 flex items-center justify-between print:hidden">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.applicationTitle')}</h2>
              <div className="flex items-center gap-2">
                <button onClick={printSheet}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                  <Printer size={15} /> {t('wz.printApplication')}
                </button>
                <button onClick={() => setSheet(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
              </div>
            </div>

            <div ref={sheetRef} className="p-6">
              {(() => {
                const app = (sheet.application ?? {}) as Record<string, unknown>
                const stu = (sheet.student ?? {}) as Record<string, unknown>
                const fam = (sheet.family ?? []) as Record<string, unknown>[]
                const acad = (sheet.academics ?? []) as Record<string, unknown>[]
                const dcs = (sheet.documents ?? []) as Record<string, unknown>[]
                const row = (k: string, v: unknown) => v === null || v === undefined || v === '' ? null : (
                  <div key={k} className="flex gap-2 py-1 border-b border-dp-outline-variant/50">
                    <span className="font-sans text-[12px] text-dp-on-surface-variant w-[46%] shrink-0">{k}</span>
                    <span className="font-sans text-[13px] text-dp-on-surface font-semibold">{String(v)}</span>
                  </div>
                )
                return (
                  <>
                    <h1 className="font-heading text-[22px] font-bold text-dp-primary mb-1">{String(stu.full_name ?? '')}</h1>
                    <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">
                      {String(stu.code ?? '')} · {String(app.programme ?? '')} · {String(app.institution ?? '')}
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                      {row(t('pwz.f.cnic'), stu.cnic)}
                      {row(t('pwz.f.bForm'), stu.b_form_no)}
                      {row(t('kf.f.dob'), stu.date_of_birth)}
                      {row(t('nr.f.address'), stu.address)}
                      {row(t('a.phone'), stu.phone)}
                      {row(t('nr.f.fatherHusband'), stu.father_name)}
                      {row(t('pwz.f.applicantName'), app.applicant_name)}
                      {row(t('pwz.f.applicantRelation'), app.applicant_relation)}
                      {row(t('wz.f.requested'), app.requested_amount_pkr)}
                      {row(t('pwz.f.instituteMonthlyFee'), app.institution_monthly_fee_pkr)}
                      {row(t('pwz.f.myShare'), app.offered_monthly_contribution_pkr)}
                      {row(t('pwz.f.income'), sheet.monthly_income)}
                      {row(t('pwz.familyEducationCost'), sheet.family_education_cost)}
                      {row(t('pwz.f.hasPatient'), app.has_long_term_patient ? '✓' : null)}
                      {row(t('pwz.f.illness'), app.patient_illness)}
                      {row(t('pwz.f.medicineCost'), app.patient_monthly_cost_pkr)}
                      {row(t('pwz.f.receivesZakat'), app.family_receives_zakat ? '✓' : null)}
                      {row(t('pwz.f.businessKind'), app.family_business_kind)}
                      {row(t('pwz.f.businessShare'), app.family_business_share_pkr)}
                      {row(t('pwz.terms.signature'), app.loan_terms_signature)}
                    </div>

                    {app.need_statement ? (
                      <div className="mt-4">
                        <p className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-1">{t('pwz.f.statement')}</p>
                        <p className="font-sans text-[13px] text-dp-on-surface leading-relaxed">{String(app.need_statement)}</p>
                      </div>
                    ) : null}

                    {fam.length > 0 && (
                      <div className="mt-5">
                        <p className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-2">{t('pwz.s.family')}</p>
                        <table className="w-full border-collapse text-[12.5px] font-sans">
                          <thead><tr className="bg-dp-surface-container-low">
                            <th className="border border-dp-outline-variant p-1.5 text-start">{t('a.name')}</th>
                            <th className="border border-dp-outline-variant p-1.5">{t('pwz.f.relation')}</th>
                            <th className="border border-dp-outline-variant p-1.5">{t('pwz.f.age')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-start">{t('pwz.f.schoolName')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-end">{t('pwz.f.annualFee')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-start">{t('pwz.f.occupation')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-end">{t('pwz.f.incomeAmount')}</th>
                          </tr></thead>
                          <tbody>
                            {fam.map((f, i) => (
                              <tr key={i}>
                                <td className="border border-dp-outline-variant p-1.5">{String(f.full_name ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-center">{String(f.relation ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-center">{String(f.age ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5">{String(f.institution ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-end">{f.annual_fee_pkr ? fmt(Number(f.annual_fee_pkr)) : ''}</td>
                                <td className="border border-dp-outline-variant p-1.5">{String(f.occupation ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-end">
                                  {f.income_pkr ? `${fmt(Number(f.income_pkr))} / ${String(f.income_period ?? '')}` : ''}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {acad.length > 0 && (
                      <div className="mt-5">
                        <p className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-2">{t('pwz.s.academics')}</p>
                        <table className="w-full border-collapse text-[12.5px] font-sans">
                          <thead><tr className="bg-dp-surface-container-low">
                            <th className="border border-dp-outline-variant p-1.5 text-start">{t('pwz.f.exam')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-start">{t('pwz.f.board')}</th>
                            <th className="border border-dp-outline-variant p-1.5">{t('pwz.f.year')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-end">{t('pwz.f.obtained')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-end">{t('pwz.f.total')}</th>
                            <th className="border border-dp-outline-variant p-1.5 text-end">%</th>
                          </tr></thead>
                          <tbody>
                            {acad.map((r, i) => (
                              <tr key={i}>
                                <td className="border border-dp-outline-variant p-1.5">{String(r.exam ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5">{String(r.board_university ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-center">{String(r.passing_year ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-end">{String(r.obtained_marks ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-end">{String(r.total_marks ?? '')}</td>
                                <td className="border border-dp-outline-variant p-1.5 text-end font-semibold">{String(r.percent ?? '')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {dcs.length > 0 && (
                      <div className="mt-5">
                        <p className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-2">{t('wz.v.documents')}</p>
                        <ul className="font-sans text-[12.5px] text-dp-on-surface">
                          {dcs.map((d, i) => (
                            <li key={i}>· {t(`pwz.doc.${String(d.kind)}`)} {d.original_seen ? `— ${t('wz.v.originalSeen')}` : ''}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── Paying an institution ────────────────────────────────────────
          The money goes to the school against its challan, never through the
          student — except on a zakat-funded award, where tamleek requires it
          to become theirs first. */}
      {payTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.pay')}</h2>
              <button onClick={() => setPayTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {t(`wz.purpose.${payTarget.purpose}`)} · Rs {fmt(payTarget.amount_pkr)} · → {t(`wz.payTo.${payTarget.pay_to}`)}
            </p>

            {payTarget.pay_to === 'institution' && (
              <>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.payToInstitution')}</label>
                <select value={payForm.school_id} onChange={(e) => setPayForm({ ...payForm, school_id: e.target.value })} className="input-field mb-3">
                  <option value="">—</option>
                  {schools.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                </select>

                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.challan')}</label>
                <input value={payForm.challan_no} onChange={(e) => setPayForm({ ...payForm, challan_no: e.target.value })} className="input-field mb-1.5" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-3">{t('wz.f.challanHint')}</p>
              </>
            )}

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className="input-field mb-4">
              <option value="bank">{t('a.bank')}</option>
              <option value="cash">{t('w.cash')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
            </select>

            <button disabled={busy} onClick={payInstalmentNow}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <HandCoins size={16} /> {busy ? t('action.saving') : t('wz.pay')}
            </button>
          </div>
        </div>
      )}

      {/* ── The student's own monthly share ─────────────────────────────── */}
      {/* ── Fix the monthly figure and due day ─────────────────────────── */}
      {/* Setting or revising a standard-track plan — the one place this
          happens outside the decision form itself, and the same function
          either way (wazifa_set_installment_plan), which sends the
          agreement on its own. There is no separate "send agreement"
          action any more — it was never anything but this same call. */}
      {planAwardTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPlanAwardTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.ins.setPlan')}</h2>
              <button onClick={() => setPlanAwardTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="flex gap-2 mb-3">
              {(['full', 'percentage'] as const).map((b) => (
                <button key={b} type="button" onClick={() => setPlanAwardForm({ ...planAwardForm, basis: b })}
                  className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all cursor-pointer ${
                    planAwardForm.basis === b ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                  {b === 'full' ? t('wz.ins.basisFull') : t('wz.ins.basisPercentage')}
                </button>
              ))}
            </div>
            {planAwardForm.basis === 'percentage' && (
              <>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.percentage')}</label>
                <input type="number" min={1} max={100} value={planAwardForm.percentage || ''}
                  onChange={(e) => setPlanAwardForm({ ...planAwardForm, percentage: +e.target.value })} className="input-field mb-3" />
              </>
            )}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.startDate')}</label>
                <input type="date" value={planAwardForm.start_date}
                  onChange={(e) => setPlanAwardForm({ ...planAwardForm, start_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.endDate')}</label>
                <input type="date" value={planAwardForm.end_date}
                  onChange={(e) => setPlanAwardForm({ ...planAwardForm, end_date: e.target.value })} className="input-field" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-1">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.dueDay')}</label>
                <input type="number" min={1} max={28} value={planAwardForm.due_day || ''}
                  onChange={(e) => setPlanAwardForm({ ...planAwardForm, due_day: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.grant.payTo')}</label>
                <select value={planAwardForm.pay_to} onChange={(e) => setPlanAwardForm({ ...planAwardForm, pay_to: e.target.value })} className="input-field">
                  <option value="institution">{t('wz.payTo.institution')}</option>
                  <option value="student">{t('wz.payTo.student')}</option>
                  <option value="hostel">{t('wz.payTo.hostel')}</option>
                </select>
              </div>
            </div>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('wz.ins.autoSendHint')}</p>
            <button disabled={busy} onClick={saveInstalmentPlan}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── Screening: the zakat-family check ────────────────────────── */}
      {screenTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setScreenTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.screen.title')}</h2>
              <button onClick={() => setScreenTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('wz.screen.help')}</p>

            {screenLoading ? (
              <p className="font-sans text-dp-on-surface-variant text-[13px]">{t('action.loading')}</p>
            ) : screenCandidates.length === 0 ? (
              <div className="bg-dp-surface-container-low rounded-lg px-4 py-3.5 mb-3">
                <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('wz.screen.noMatch')}</p>
              </div>
            ) : (
              <div className="space-y-2 mb-4">
                {screenCandidates.map((c) => (
                  <div key={c.register_id} className="border border-dp-outline-variant rounded-lg px-3.5 py-3 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{c.head_name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{c.code}</span></p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {c.father_husband_name && `${c.father_husband_name} · `}{c.asnaf_category}
                        {c.phone ? ` · ${c.phone}` : ''}
                      </p>
                    </div>
                    <button onClick={() => confirmZakatMatch(studentOf(screenTarget.student_id)!.id, c.register_id)}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                      <ShieldCheck size={13} /> {t('wz.screen.thisIsThem')}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {studentOf(screenTarget.student_id)?.is_zakat_family && (
              <button onClick={() => confirmZakatMatch(studentOf(screenTarget.student_id)!.id, null)}
                className="w-full flex items-center justify-center gap-2 border border-dp-outline-variant text-dp-on-surface-variant py-2 rounded-lg font-sans text-[13px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                {t('wz.screen.clearMatch')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Start the interim grant ──────────────────────────────────── */}
      {grantTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setGrantTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.grant.start')}</h2>
              <button onClick={() => setGrantTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.grant.months')}</label>
            <input type="number" min={1} max={12} value={grantForm.months || ''}
              onChange={(e) => setGrantForm({ ...grantForm, months: +e.target.value })} className="input-field mb-3" />
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.grant.monthlyAmount')}</label>
            <input type="number" min={1} value={grantForm.monthly_amount || ''}
              onChange={(e) => setGrantForm({ ...grantForm, monthly_amount: +e.target.value })} className="input-field mb-3" />
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.grant.payTo')}</label>
            <select value={grantForm.pay_to} onChange={(e) => setGrantForm({ ...grantForm, pay_to: e.target.value })} className="input-field mb-4">
              <option value="institution">{t('wz.payTo.institution')}</option>
              <option value="student">{t('wz.payTo.student')}</option>
              <option value="hostel">{t('wz.payTo.hostel')}</option>
            </select>
            <button disabled={busy} onClick={startGrant}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {busy ? t('action.saving') : t('wz.grant.start')}
            </button>
          </div>
        </div>
      )}

      {/* ── Stop it — a reason is required, the whole point of this being
          a plan instead of a lump sum handed over at once ─────────────── */}
      {stopGrantTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setStopGrantTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.grant.stop')}</h2>
              <button onClick={() => setStopGrantTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('wz.grant.stopHelp')}</p>
            <textarea value={stopGrantReason} onChange={(e) => setStopGrantReason(e.target.value)}
              rows={3} placeholder={t('wz.grant.stopReasonPlaceholder')} className="input-field mb-4" />
            <button disabled={busy} onClick={stopGrant}
              className="w-full flex items-center justify-center gap-2 bg-dp-error text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-50">
              <StopCircle size={16} /> {busy ? t('action.saving') : t('wz.grant.stop')}
            </button>
          </div>
        </div>
      )}

      {/* ── Record a check-in ────────────────────────────────────────── */}
      {checkInTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setCheckInTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.checkin.record')}</h2>
              <button onClick={() => setCheckInTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.checkin.method')}</label>
            <select value={checkInForm.method} onChange={(e) => setCheckInForm({ ...checkInForm, method: e.target.value })} className="input-field mb-3">
              <option value="phone_institute">{t('wz.checkin.method.phone_institute')}</option>
              <option value="phone_hostel">{t('wz.checkin.method.phone_hostel')}</option>
              <option value="phone_student">{t('wz.checkin.method.phone_student')}</option>
              <option value="visit">{t('wz.checkin.method.visit')}</option>
            </select>
            <div className="flex gap-2 mb-3">
              {([[true, 'wz.checkin.ok'], [false, 'wz.checkin.notOk']] as const).map(([val, label]) => (
                <button key={String(val)} onClick={() => setCheckInForm({ ...checkInForm, confirmed: val })}
                  className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all cursor-pointer ${
                    checkInForm.confirmed === val ? (val ? 'bg-emerald-600 text-white' : 'bg-dp-error text-white') : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                  {t(label)}
                </button>
              ))}
            </div>
            <textarea value={checkInForm.note} onChange={(e) => setCheckInForm({ ...checkInForm, note: e.target.value })}
              rows={2} placeholder={t('wz.checkin.notePlaceholder')} className="input-field mb-4" />
            <button disabled={busy} onClick={submitCheckIn}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── Mark employed — the one button that turns repayment on ──────── */}
      {employTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEmployTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.employ.title')}</h2>
              <button onClick={() => setEmployTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('wz.employ.help')}</p>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.employ.monthlyAmount')}</label>
            <input type="number" min={1} value={employForm.monthly_amount || ''}
              onChange={(e) => setEmployForm({ ...employForm, monthly_amount: +e.target.value })} className="input-field mb-3" />
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.employ.note')}</label>
            <input value={employForm.note} onChange={(e) => setEmployForm({ ...employForm, note: e.target.value })} className="input-field mb-4" />
            <button disabled={busy} onClick={submitMarkEmployed}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-emerald-700 transition-all cursor-pointer disabled:opacity-50">
              <Briefcase size={16} /> {busy ? t('action.saving') : t('wz.employ.button')}
            </button>
          </div>
        </div>
      )}

      {/* ── Reallocate the applicant's own offer to a different figure ──── */}
      {reallocateTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setReallocateTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.offer.reallocate')}</h2>
              <button onClick={() => setReallocateTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
              {t('wz.offer.reallocateHint')} Rs {fmt(reallocateTarget.offered_monthly_contribution_pkr)}.
            </p>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.employ.monthlyAmount')}</label>
            <input type="number" min={1} value={reallocateAmount || ''}
              onChange={(e) => setReallocateAmount(+e.target.value)} className="input-field mb-4" />
            <button disabled={busy || reallocateAmount <= 0} onClick={() => decideOffer(reallocateTarget, 'approved', reallocateAmount)}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-emerald-700 transition-all cursor-pointer disabled:opacity-50">
              {busy ? t('action.saving') : t('wz.offer.approveAtThisAmount')}
            </button>
          </div>
        </div>
      )}

      {/* ── Recording a payment against an already-raised charge ────────── */}
      {/* ── Several months at once — monthly cash, or 6 months, or a
          year in advance, all in one voucher (migration 282). ─────────── */}
      {/* ── Every month of the plan, real status per month — replaces the
          old "pay N months in advance" button, which paid a real number
          of real months but never said which ones (migration 289). Quick
          picks at the top just tick boxes; nothing is paid until "Pay
          selected" is pressed, and an already-paid month can't be
          selected at all. */}
      {calendarTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setCalendarTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.cal.title')}</h2>
              <button onClick={() => setCalendarTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{studentOf(calendarTarget.student_id)?.full_name}</p>

            {calendarLoading ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant py-8 text-center">{t('action.loading')}</p>
            ) : (
              <>
                <div className="flex gap-2 mb-3">
                  {[3, 6, 12].map((n) => (
                    <button key={n} type="button" onClick={() => {
                        const unpaid = calendarMonths.filter((m) => m.status !== 'paid').slice(0, n).map((m) => m.month)
                        setCalendarSelected(new Set(unpaid))
                      }}
                      className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                      {t('wz.cal.quickNext').replace('{n}', String(n))}
                    </button>
                  ))}
                  <button type="button" onClick={() => setCalendarSelected(new Set())}
                    className="px-3 py-1.5 text-dp-on-surface-variant font-sans text-[12px] hover:text-dp-error transition-all cursor-pointer">
                    {t('wz.cal.clear')}
                  </button>
                </div>

                <div className="overflow-y-auto flex-1 border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant mb-3">
                  {calendarMonths.map((m) => {
                    const label = new Date(m.month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
                    const selected = calendarSelected.has(m.month)
                    const isPaid = m.status === 'paid'
                    return (
                      <label key={m.month}
                        className={`flex items-center justify-between gap-3 px-3.5 py-2.5 ${isPaid ? 'bg-emerald-50 cursor-default' : 'cursor-pointer hover:bg-dp-surface-container-low'}`}>
                        <span className="flex items-center gap-2.5">
                          <input type="checkbox" checked={selected || isPaid} disabled={isPaid}
                            onChange={() => toggleCalendarMonth(m.month, m.status)} className="accent-dp-secondary" />
                          <span className="font-sans text-[13px] font-semibold text-dp-on-surface">{label}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="font-sans text-[12.5px] text-dp-on-surface-variant">Rs {fmt(m.amount)}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold ${
                            isPaid ? 'bg-emerald-100 text-emerald-700'
                            : m.status === 'part_paid' ? 'bg-amber-100 text-amber-700'
                            : m.status === 'upcoming' ? 'bg-dp-surface-container-high text-dp-on-surface-variant'
                            : 'bg-dp-secondary/10 text-dp-secondary'}`}>
                            {t(`wz.cal.status.${m.status}`)}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>

                <div className="flex items-center justify-between mb-3">
                  <select value={calendarMethod} onChange={(e) => setCalendarMethod(e.target.value)} className="input-field !w-auto">
                    <option value="cash">{t('w.cash')}</option>
                    <option value="bank">{t('a.bank')}</option>
                    <option value="jazzcash">{t('w.jazzcash')}</option>
                    <option value="easypaisa">{t('w.easypaisa')}</option>
                  </select>
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface">
                    {calendarSelected.size} {t('wz.cal.monthsSelected')} · Rs {fmt(calendarSelectedTotal)}
                  </p>
                </div>
                <button disabled={busy || calendarSelected.size === 0} onClick={submitCalendarPay}
                  className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                  <HandCoins size={16} /> {busy ? t('action.saving') : t('wz.cal.paySelected')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {payChargeTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayChargeTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.ins.recordPayment')}</h2>
              <button onClick={() => setPayChargeTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
              {t('wz.ins.due')} {new Date(payChargeTarget.due_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              {' · '}{t('wz.ins.remaining')} Rs {fmt(payChargeTarget.amount_pkr - payChargeTarget.paid_pkr)}
            </p>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
            <input type="number" min={1} max={payChargeTarget.amount_pkr - payChargeTarget.paid_pkr} value={payChargeForm.amount || ''}
              onChange={(e) => setPayChargeForm({ ...payChargeForm, amount: +e.target.value })} className="input-field mb-3" />
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={payChargeForm.method} onChange={(e) => setPayChargeForm({ ...payChargeForm, method: e.target.value })} className="input-field mb-4">
              <option value="cash">{t('w.cash')}</option>
              <option value="bank">{t('a.bank')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
            </select>
            <button disabled={busy} onClick={submitPayCharge}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <HandCoins size={16} /> {busy ? t('action.saving') : t('wz.ins.recordPayment')}
            </button>
          </div>
        </div>
      )}

      {payDisbursementTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayDisbursementTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('wz.plan.releaseTitle')}</h2>
              <button onClick={() => setPayDisbursementTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
              {t('wz.ins.due')} {new Date(payDisbursementTarget.due_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              {' · '}Rs {fmt(payDisbursementTarget.amount_pkr)}
            </p>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={payDisbursementForm.method} onChange={(e) => setPayDisbursementForm({ method: e.target.value })} className="input-field mb-4">
              <option value="cash">{t('w.cash')}</option>
              <option value="bank">{t('a.bank')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
            </select>
            <button disabled={busy} onClick={submitPayDisbursement}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-emerald-700 transition-all cursor-pointer disabled:opacity-50">
              <HandCoins size={16} /> {busy ? t('action.saving') : t('wz.plan.releaseTitle')}
            </button>
          </div>
        </div>
      )}

      {contribTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setContribTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.contributionTitle')}</h2>
              <button onClick={() => setContribTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('wz.contributionHint')}</p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
            <input type="number" min={0} value={contribForm.amount || ''}
              onChange={(e) => setContribForm({ ...contribForm, amount: +e.target.value })} className="input-field mb-3" />

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={contribForm.method} onChange={(e) => setContribForm({ ...contribForm, method: e.target.value })} className="input-field mb-4">
              <option value="cash">{t('w.cash')}</option>
              <option value="bank">{t('a.bank')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
            </select>

            <button disabled={busy} onClick={takeContribution}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-emerald-700 transition-all cursor-pointer disabled:opacity-50">
              <HandCoins size={16} /> {busy ? t('action.saving') : t('wz.contribution')}
            </button>
          </div>
        </div>
      )}

      {/* ── Writing off a loan ──────────────────────────────────────────── */}
      {writeOffTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setWriteOffTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.writeOffTitle')}</h2>
              <button onClick={() => setWriteOffTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('wz.writeOffHint')}</p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
            <input type="number" min={0} value={writeOffForm.amount || ''}
              onChange={(e) => setWriteOffForm({ ...writeOffForm, amount: +e.target.value })} className="input-field mb-3" />

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.writeOffReason')}</label>
            <textarea value={writeOffForm.reason} onChange={(e) => setWriteOffForm({ ...writeOffForm, reason: e.target.value })}
              rows={3} className="input-field resize-none mb-4" />

            <button disabled={busy} onClick={writeOff}
              className="w-full flex items-center justify-center gap-2 bg-dp-error text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-50">
              <Ban size={16} /> {busy ? t('action.saving') : t('wz.writeOff')}
            </button>
          </div>
        </div>
      )}

      {/* ── Is this family already being helped? ────────────────────────── */}
      {familyCheck && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setFamilyCheck(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.familyCheckTitle')}</h2>
              <button onClick={() => setFamilyCheck(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('wz.familyCheckHelp')}</p>

            {([
              ['wazifa_students', 'wz.fc.wazifa'],
              ['kafalat_children', 'wz.fc.kafalat'],
              ['needs_register', 'wz.fc.register'],
            ] as const).map(([key, lbl]) => {
              const rows = familyCheck[key] ?? []
              return (
                <div key={key} className="mb-4">
                  <p className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-2">{t(lbl)}</p>
                  {rows.length === 0 ? (
                    <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('wz.fc.none')}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {rows.map((r) => (
                        <div key={r.code} className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          <span className="font-sans text-[13px]">
                            <span className="font-mono text-[12px] font-semibold">{r.code}</span>
                            {r.name && ` · ${r.name}`}
                          </span>
                          <span className="font-sans text-[12px] font-semibold text-dp-on-surface-variant">
                            {r.status}{r.awarded ? ` · Rs ${fmt(r.awarded)}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            <p className="font-sans text-[12px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3.5 py-2.5">
              {t('wz.familyCheckNote')}
            </p>
          </div>
        </div>
      )}

      {/* ── Typing up the verification sheet ────────────────────────────
          The same eleven questions as the printed block, in the same order,
          so somebody working from a marked-up sheet reads straight down. */}
      {verifyTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setVerifyTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.verificationTitle')}</h2>
              <button onClick={() => setVerifyTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {studentOf(verifyTarget.student_id)?.full_name} · {verifyTarget.programme}
            </p>

            <div className="mb-4">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.v.visitedOn')}</label>
              <input type="date" value={String(vForm.visited_on)}
                onChange={(e) => setVForm({ ...vForm, visited_on: e.target.value })} className="input-field max-w-xs" />
            </div>

            {/* ── Who went and signed ────────────────────────────────────
                The signatures are on the paper. Nobody else has to log in
                and re-enter the same findings — they never would, and if
                somebody did it on their behalf that is worse than not
                recording it. Naming them is enough. */}
            <div className="border border-dp-outline-variant rounded-lg p-3.5 mb-5">
              <p className="font-sans text-[13px] font-bold text-dp-on-surface mb-1">{t('wz.v.whoSigned')}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">{t('wz.v.whoSignedHelp')}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
                {committee.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 cursor-pointer font-sans text-[13px]">
                    <input type="checkbox" checked={coVerifiers.includes(m.id)}
                      onChange={(e) => setCoVerifiers(e.target.checked
                        ? [...coVerifiers, m.id]
                        : coVerifiers.filter((x) => x !== m.id))}
                      className="accent-dp-secondary" />
                    {m.full_name}
                  </label>
                ))}
              </div>

              <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.v.otherSigners')}</label>
              <input value={coNames} onChange={(e) => setCoNames(e.target.value)}
                placeholder={t('wz.v.otherSignersPlaceholder')} className="input-field !py-2" />
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('wz.v.otherSignersHint')}</p>

              <div className={`mt-3 rounded-lg px-3 py-2 font-sans text-[12.5px] font-semibold ${1 + coVerifiers.length + (coNames.trim() ? coNames.split(',').filter((x) => x.trim()).length : 0) >= minVerifiers ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>
                {1 + coVerifiers.length + (coNames.trim() ? coNames.split(',').filter((x) => x.trim()).length : 0)} {t('wz.v.ofRequired')} {minVerifiers}
              </div>
            </div>

            {/* ── The documents the family uploaded ──────────────────────
                They send a photograph; this is where somebody confirms they
                held the original. The difference between the two is most of
                what a visit is for. */}
            {docsOf(verifyTarget.id).length > 0 && (
              <div className="border border-dp-outline-variant rounded-lg p-3.5 mb-5">
                <p className="font-sans text-[13px] font-bold text-dp-on-surface mb-1">{t('wz.v.documents')}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">{t('wz.v.documentsHelp')}</p>

                <div className="space-y-2">
                  {docsOf(verifyTarget.id).map((d) => (
                    <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-dp-outline-variant pb-2">
                      <div className="min-w-0">
                        <a href={d.url} target="_blank" rel="noopener noreferrer"
                          className="font-sans text-[13px] font-semibold text-dp-secondary hover:underline">
                          {t(`pwz.doc.${d.kind}`)} ↗
                        </a>
                        {d.original_seen && d.seen_at && (
                          <span className="block font-sans text-[11px] text-emerald-700">
                            {t('wz.v.seenOn')} {new Date(d.seen_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </span>
                        )}
                      </div>
                      <button onClick={() => markDocSeen(d.id, !d.original_seen)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans text-[12px] font-bold cursor-pointer transition-all ${d.original_seen ? 'bg-emerald-600 text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-emerald-500'}`}>
                        <ClipboardCheck size={13} /> {d.original_seen ? t('wz.v.originalSeen') : t('wz.v.markSeen')}
                      </button>
                    </div>
                  ))}
                </div>

                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2.5">
                  {docsOf(verifyTarget.id).filter((d) => d.original_seen).length} / {docsOf(verifyTarget.id).length} {t('wz.v.originalsSeen')}
                </p>
              </div>
            )}

            <div className="space-y-2.5 mb-5">
              {CHECKS.map(([ansKey, noteKey, labelKey]) => (
                <div key={ansKey} className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-start border-b border-dp-outline-variant pb-2.5">
                  <div>
                    <p className="font-sans text-[13.5px] text-dp-on-surface mb-1.5">{t(`pwz.v.item.${labelKey}`)}</p>
                    <input value={String(vForm[noteKey] ?? '')}
                      onChange={(e) => setVForm({ ...vForm, [noteKey]: e.target.value })}
                      placeholder={t('pwz.v.detail')} className="input-field !py-1.5 text-[13px]" />
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {(['yes', 'no', 'na'] as const).map((v) => (
                      <button key={v} onClick={() => setVForm({ ...vForm, [ansKey]: v })}
                        className={`px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-bold cursor-pointer transition-all ${vForm[ansKey] === v ? (v === 'yes' ? 'bg-emerald-600 text-white' : v === 'no' ? 'bg-dp-error text-white' : 'bg-dp-outline text-white') : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                        {t(`pwz.v.${v}`)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <h3 className="font-sans text-[13px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-2">{t('wz.v.whatWasSeen')}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
              {([
                ['verified_obtained_marks', 'pwz.v.obtainedMarks'],
                ['verified_total_marks', 'pwz.v.totalMarks'],
                ['observed_monthly_income_pkr', 'pwz.v.observedIncome'],
                ['verified_annual_cost_pkr', 'pwz.v.verifiedCost'],
              ] as const).map(([k, lbl]) => (
                <div key={k}>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t(lbl)}</label>
                  <input type="number" min={0} value={Number(vForm[k]) || ''}
                    onChange={(e) => setVForm({ ...vForm, [k]: +e.target.value })} className="input-field !py-2" />
                </div>
              ))}
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.v.grade')}</label>
                <input value={String(vForm.verified_grade ?? '')}
                  onChange={(e) => setVForm({ ...vForm, verified_grade: e.target.value })} className="input-field !py-2" />
              </div>
            </div>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('wz.v.marksOverrideHint')}</p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.v.recommendation')}</label>
                <select value={String(vForm.recommendation)} onChange={(e) => setVForm({ ...vForm, recommendation: e.target.value })} className="input-field !py-2">
                  {(['full', 'partial', 'decline', 'defer'] as const).map((r) => (
                    <option key={r} value={r}>{t(`pwz.v.rec.${r}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.v.recommendedAmount')}</label>
                <input type="number" min={0} value={Number(vForm.recommended_amount_pkr) || ''}
                  onChange={(e) => setVForm({ ...vForm, recommended_amount_pkr: +e.target.value })} className="input-field !py-2" />
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.v.relationship')}</label>
                <select value={String(vForm.relationship)} onChange={(e) => setVForm({ ...vForm, relationship: e.target.value })} className="input-field !py-2">
                  {(['none', 'sibling', 'close_relative', 'other', 'parent', 'child', 'spouse'] as const).map((r) => (
                    <option key={r} value={r}>{t(`nr.rel.${r}`)}</option>
                  ))}
                </select>
              </div>
            </div>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.v.notes')}</label>
            <textarea value={String(vForm.overall_note ?? '')} onChange={(e) => setVForm({ ...vForm, overall_note: e.target.value })}
              rows={3} className="input-field resize-none mb-4" />

            <button disabled={busy} onClick={saveVerification}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Save size={16} /> {busy ? t('action.saving') : t('wz.saveVerification')}
            </button>
          </div>
        </div>
      )}

      {/* ── The committee's decision ────────────────────────────────────── */}
      {decideTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setDecideTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.decisionTitle')}</h2>
              <button onClick={() => setDecideTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <p className="font-sans text-[14px] font-semibold">{studentOf(decideTarget.student_id)?.full_name}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                {decideTarget.programme} · {decideTarget.institution} · {t('wz.requested')} Rs {fmt(decideTarget.requested_amount_pkr)}
              </p>
              {myVerification(decideTarget.id) && (
                <p className="font-sans text-[12.5px] text-dp-secondary mt-1 font-semibold">
                  {t('wz.verifierRecommends')} {t(`pwz.v.rec.${myVerification(decideTarget.id)!.recommendation ?? 'full'}`)}
                  {myVerification(decideTarget.id)!.recommended_amount_pkr
                    ? ` — Rs ${fmt(Number(myVerification(decideTarget.id)!.recommended_amount_pkr))}` : ''}
                </p>
              )}
            </div>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-2">{t('wz.d.decision')}</label>
            <div className="space-y-2 mb-4">
              {([
                ['approved_full', 'wz.d.approvedFull'],
                ['approved_partial', 'wz.d.approvedPartial'],
                ['deferred', 'wz.d.deferred'],
                ['declined', 'wz.d.declined'],
              ] as const).map(([value, lbl]) => (
                <label key={value} className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border-2 cursor-pointer transition-all ${dForm.decision === value ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant'}`}>
                  <input type="radio" name="decision" checked={dForm.decision === value}
                    onChange={() => setDForm({ ...dForm, decision: value })} className="accent-dp-secondary" />
                  <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t(lbl)}</span>
                </label>
              ))}
            </div>

            {dForm.decision.startsWith('approved') && (
              <>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.d.amount')}</label>
                    <input type="number" min={0} value={dForm.amount || ''}
                      onChange={(e) => setDForm({ ...dForm, amount: +e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.fundedBy')}</label>
                    <select value={dForm.funded_by} onChange={(e) => setDForm({ ...dForm, funded_by: e.target.value })} className="input-field">
                      <option value="sadqa">{t('wz.funded.sadqa')}</option>
                      <option value="zakat">{t('wz.funded.zakat')}</option>
                      <option value="general">{t('wz.funded.general')}</option>
                      <option value="sponsor">{t('wz.funded.sponsor')}</option>
                    </select>
                  </div>
                </div>

                <label className={`flex items-start gap-2.5 px-3.5 py-3 rounded-lg border-2 cursor-pointer transition-all mb-1.5 ${dForm.as_loan ? 'border-emerald-500 bg-emerald-50' : 'border-dp-outline-variant'}`}>
                  <input type="checkbox" checked={dForm.as_loan}
                    onChange={(e) => setDForm({ ...dForm, as_loan: e.target.checked, funded_by: e.target.checked && dForm.funded_by === 'zakat' ? 'sadqa' : dForm.funded_by })}
                    className="accent-emerald-600 mt-0.5" />
                  <span>
                    <span className="block font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('wz.d.asLoan')}</span>
                    <span className="block font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('wz.d.asLoanHelp')}</span>
                  </span>
                </label>
                {dForm.as_loan && (
                  <p className="font-sans text-[11.5px] text-amber-700 mb-3">{t('wz.d.loanNotZakat')}</p>
                )}

                {dForm.decision === 'approved_partial' && (
                  <div className="mb-3">
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.d.shortfall')}</label>
                    <textarea value={dForm.shortfall_note} onChange={(e) => setDForm({ ...dForm, shortfall_note: e.target.value })}
                      rows={2} placeholder={t('wz.d.shortfallPlaceholder')} className="input-field resize-none" />
                  </div>
                )}

                {/* ── The whole instalment plan, right here — nothing left
                    to set up afterward (migration 278). Zakat-family
                    awards use interim support instead (set at screening),
                    so this only applies otherwise. */}
                {!studentOf(decideTarget.student_id)?.is_zakat_family && (
                  <div className="border-2 border-dp-outline-variant rounded-lg p-3.5 mb-3">
                    <label className="flex items-center gap-2.5 cursor-pointer mb-1">
                      <input type="checkbox" checked={dForm.set_plan}
                        onChange={(e) => setDForm({ ...dForm, set_plan: e.target.checked })} className="accent-dp-secondary" />
                      <span className="font-sans text-[13.5px] font-bold text-dp-on-surface">{t('wz.ins.setPlanNow')}</span>
                    </label>
                    {dForm.set_plan && (
                      <div className="mt-3 space-y-3">
                        <div className="flex gap-2">
                          {(['disburse_then_settle', 'collect_now'] as const).map((k) => (
                            <button key={k} type="button" onClick={() => setDForm({ ...dForm, plan_kind: k })}
                              className={`flex-1 py-2 rounded-lg font-sans text-[12.5px] font-semibold transition-all cursor-pointer ${
                                dForm.plan_kind === k ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                              {k === 'disburse_then_settle' ? t('wz.plan.kindDisburse') : t('wz.plan.kindCollect')}
                            </button>
                          ))}
                        </div>

                        {dForm.plan_kind === 'disburse_then_settle' ? (
                          <>
                            <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('wz.plan.disburseHelp')}</p>
                            {(decideTarget.actual_course_cost_pkr || decideTarget.family_monthly_capacity_pkr || decideTarget.offered_monthly_contribution_pkr) ? (
                              <p className="font-sans text-[12px] text-dp-secondary bg-dp-secondary/10 rounded-lg px-3 py-2">
                                {decideTarget.actual_course_cost_pkr ? `${t('wz.f.actualCourseCost')}: Rs ${fmt(decideTarget.actual_course_cost_pkr)} · ` : ''}
                                {t('wz.f.familyCapacity')}: Rs {fmt(decideTarget.family_monthly_capacity_pkr || decideTarget.offered_monthly_contribution_pkr)}/{t('pkf.month')}
                              </p>
                            ) : null}
                            <p className="font-sans text-[12px] font-bold uppercase tracking-wide text-dp-on-surface-variant">{t('wz.plan.whileStudying')}</p>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.plan.monthlySupport')}</label>
                                <input type="number" min={1} value={dForm.disbursement_monthly || ''}
                                  onChange={(e) => setDForm({ ...dForm, disbursement_monthly: +e.target.value })} className="input-field" />
                              </div>
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.dueDay')}</label>
                                <input type="number" min={1} max={28} value={dForm.disbursement_due_day || ''}
                                  onChange={(e) => setDForm({ ...dForm, disbursement_due_day: +e.target.value })} className="input-field" />
                              </div>
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.startDate')}</label>
                                <input type="date" value={dForm.disbursement_start_date}
                                  onChange={(e) => setDForm({ ...dForm, disbursement_start_date: e.target.value })} className="input-field" />
                              </div>
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.endDate')}</label>
                                <input type="date" value={dForm.disbursement_end_date}
                                  onChange={(e) => setDForm({ ...dForm, disbursement_end_date: e.target.value })} className="input-field" />
                              </div>
                            </div>
                            <div>
                              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.grant.payTo')}</label>
                              <select value={dForm.disbursement_pay_to} onChange={(e) => setDForm({ ...dForm, disbursement_pay_to: e.target.value })} className="input-field">
                                <option value="institution">{t('wz.payTo.institution')}</option>
                                <option value="student">{t('wz.payTo.student')}</option>
                                <option value="hostel">{t('wz.payTo.hostel')}</option>
                              </select>
                            </div>

                            <p className="font-sans text-[12px] font-bold uppercase tracking-wide text-dp-on-surface-variant pt-1">{t('wz.plan.afterwards')}</p>
                            <div className="flex gap-2">
                              {(['course_end', 'employment', 'none'] as const).map((tr) => (
                                <button key={tr} type="button" onClick={() => setDForm({ ...dForm, settlement_trigger: tr })}
                                  disabled={tr !== 'course_end' && !studentOf(decideTarget.student_id)?.is_zakat_family}
                                  className={`flex-1 py-2 rounded-lg font-sans text-[11.5px] font-semibold transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                                    dForm.settlement_trigger === tr ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                                  {t(`wz.plan.trigger.${tr}`)}
                                </button>
                              ))}
                            </div>
                            {dForm.settlement_trigger !== 'none' && (
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.plan.monthlySettlement')}</label>
                                  <input type="number" min={1} value={dForm.settlement_monthly || ''}
                                    onChange={(e) => setDForm({ ...dForm, settlement_monthly: +e.target.value })} className="input-field" />
                                </div>
                                <div>
                                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.dueDay')}</label>
                                  <input type="number" min={1} max={28} value={dForm.settlement_due_day || ''}
                                    onChange={(e) => setDForm({ ...dForm, settlement_due_day: +e.target.value })} className="input-field" />
                                </div>
                              </div>
                            )}
                            {dForm.settlement_trigger === 'employment' && (
                              <p className="font-sans text-[11.5px] text-amber-700">{t('wz.plan.employmentHint')}</p>
                            )}
                            {dForm.disbursement_monthly > 0 && dForm.disbursement_start_date && dForm.disbursement_end_date && (() => {
                              const s = new Date(dForm.disbursement_start_date), e = new Date(dForm.disbursement_end_date)
                              const months = Math.max(1, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1)
                              return (
                                <p className="font-sans text-[13px] text-dp-on-surface bg-dp-secondary/10 rounded-lg px-3.5 py-2.5">
                                  {t('wz.plan.preview')
                                    .replace('{monthly}', fmt(dForm.disbursement_monthly))
                                    .replace('{months}', String(months))
                                    .replace('{total}', fmt(dForm.disbursement_monthly * months))}
                                </p>
                              )
                            })()}
                          </>
                        ) : (
                          <>
                            <div className="flex gap-2">
                              {(['full', 'percentage'] as const).map((b) => (
                                <button key={b} type="button" onClick={() => setDForm({ ...dForm, installment_basis: b })}
                                  className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all cursor-pointer ${
                                    dForm.installment_basis === b ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                                  {b === 'full' ? t('wz.ins.basisFull') : t('wz.ins.basisPercentage')}
                                </button>
                              ))}
                            </div>
                            {dForm.installment_basis === 'percentage' && (
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.percentage')}</label>
                                <input type="number" min={1} max={100} value={dForm.installment_percentage || ''}
                                  onChange={(e) => setDForm({ ...dForm, installment_percentage: +e.target.value })} className="input-field" />
                              </div>
                            )}
                            <div className="grid grid-cols-3 gap-3">
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.startDate')}</label>
                                <input type="date" value={dForm.installment_start_date}
                                  onChange={(e) => setDForm({ ...dForm, installment_start_date: e.target.value })} className="input-field" />
                              </div>
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.endDate')}</label>
                                <input type="date" value={dForm.installment_end_date}
                                  onChange={(e) => setDForm({ ...dForm, installment_end_date: e.target.value })} className="input-field" />
                              </div>
                              <div>
                                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.ins.dueDay')}</label>
                                <input type="number" min={1} max={28} value={dForm.installment_due_day || ''}
                                  onChange={(e) => setDForm({ ...dForm, installment_due_day: +e.target.value })} className="input-field" />
                              </div>
                            </div>
                            <div>
                              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.grant.payTo')}</label>
                              <select value={dForm.installment_pay_to} onChange={(e) => setDForm({ ...dForm, installment_pay_to: e.target.value })} className="input-field">
                                <option value="institution">{t('wz.payTo.institution')}</option>
                                <option value="student">{t('wz.payTo.student')}</option>
                                <option value="hostel">{t('wz.payTo.hostel')}</option>
                              </select>
                            </div>
                            {dForm.amount > 0 && dForm.installment_start_date && dForm.installment_end_date && (() => {
                              const total = dForm.installment_basis === 'full' ? dForm.amount : dForm.amount * dForm.installment_percentage / 100
                              const s = new Date(dForm.installment_start_date), e = new Date(dForm.installment_end_date)
                              const months = Math.max(1, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1)
                              return (
                                <p className="font-sans text-[13px] text-dp-on-surface bg-dp-secondary/10 rounded-lg px-3.5 py-2.5">
                                  {t('wz.ins.preview')} <strong>Rs {fmt(Math.round(total / months))}</strong>/{t('pkf.month')} · {months} {t('wz.ins.monthsLabel')}
                                </p>
                              )
                            })()}
                          </>
                        )}
                        <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('wz.ins.autoSendHint')}</p>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Two boxes on purpose: one the family reads, one they do not. */}
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 mt-3">{t('wz.d.reasonUr')}</label>
            <textarea value={dForm.reason_ur} onChange={(e) => setDForm({ ...dForm, reason_ur: e.target.value })}
              rows={2} className="input-field resize-none mb-1.5"
              style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.d.reason')}</label>
            <textarea value={dForm.reason} onChange={(e) => setDForm({ ...dForm, reason: e.target.value })}
              rows={2} className="input-field resize-none mb-1.5" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-3">{t('wz.d.reasonHint')}</p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.d.internalNote')}</label>
            <textarea value={dForm.internal_note} onChange={(e) => setDForm({ ...dForm, internal_note: e.target.value })}
              rows={2} className="input-field resize-none mb-1.5" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('wz.d.internalHint')}</p>

            <button disabled={busy} onClick={recordDecision}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Gavel size={16} /> {busy ? t('action.saving') : t('wz.d.record')}
            </button>
          </div>
        </div>
      )}

      {/* ── The repayment plan ──────────────────────────────────────────── */}
      {planTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPlanTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.planTitle')}</h2>
              <button onClick={() => setPlanTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {studentOf(planTarget.student_id)?.full_name} · Rs {fmt(planTarget.awarded_amount_pkr)}
            </p>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.plan.startsOn')}</label>
                <input type="date" value={planForm.starts_on}
                  onChange={(e) => setPlanForm({ ...planForm, starts_on: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.plan.instalments')}</label>
                <input type="number" min={1} max={120} value={planForm.instalments || ''}
                  onChange={(e) => setPlanForm({ ...planForm, instalments: +e.target.value })} className="input-field" />
              </div>
            </div>

            <p className="font-sans text-[13px] text-dp-on-surface bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 mb-3">
              {t('wz.plan.each')} <strong>Rs {fmt(Math.floor(planTarget.awarded_amount_pkr / Math.max(planForm.instalments, 1)))}</strong>
            </p>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('wz.plan.startHint')}</p>

            <button disabled={busy} onClick={generatePlan}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <CalendarClock size={16} /> {busy ? t('action.saving') : t('wz.plan.create')}
            </button>
          </div>
        </div>
      )}

      {/* ── Taking a repayment ──────────────────────────────────────────── */}
      {repayTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setRepayTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.repayTitle')}</h2>
              <button onClick={() => setRepayTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {studentOf(repayTarget.student_id)?.full_name} · {t('pwz.qarzBadge')}
            </p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
            <input type="number" min={0} value={repayForm.amount || ''}
              onChange={(e) => setRepayForm({ ...repayForm, amount: +e.target.value })} className="input-field mb-3" />

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={repayForm.method} onChange={(e) => setRepayForm({ ...repayForm, method: e.target.value })} className="input-field mb-3">
              <option value="cash">{t('w.cash')}</option>
              <option value="bank">{t('a.bank')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
            </select>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.notesOptional')}</label>
            <textarea value={repayForm.note} onChange={(e) => setRepayForm({ ...repayForm, note: e.target.value })}
              rows={2} className="input-field resize-none mb-1.5" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('wz.repayHint')}</p>

            <button disabled={busy} onClick={recordRepayment}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <HandCoins size={16} /> {busy ? t('action.saving') : t('wz.repayRecord')}
            </button>
          </div>
        </div>
      )}

      {/* ── New applicant ───────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('wz.addApplicant')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.name')}</label>
                  <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
                  <input value={form.full_name_ur} onChange={(e) => setForm({ ...form, full_name_ur: e.target.value })}
                    className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.fatherHusband')}</label>
                  <input value={form.father_name} onChange={(e) => setForm({ ...form, father_name: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.f.motherName')}</label>
                  <input value={form.mother_name} onChange={(e) => setForm({ ...form, mother_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.applicantFor')}</label>
                  <select value={form.applicant_for}
                    onChange={(e) => setForm({ ...form, applicant_for: e.target.value, applicant_relation: '' })} className="input-field">
                    <option value="self">{t('wz.applicantFor.self')}</option>
                    <option value="own_child">{t('wz.applicantFor.ownChild')}</option>
                  </select>
                </div>
                {form.applicant_for === 'own_child' && (
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.applicantRelation')}</label>
                    <select value={form.applicant_relation}
                      onChange={(e) => setForm({ ...form, applicant_relation: e.target.value })} className="input-field">
                      <option value="">—</option>
                      <option value="father">{t('es.rel.father')}</option>
                      <option value="mother">{t('es.rel.mother')}</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.phone')}</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.gender')}</label>
                  <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input-field">
                    <option value="male">{t('kf.boy')}</option>
                    <option value="female">{t('kf.girl')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.income')}</label>
                  <input type="number" min={0} value={form.household_monthly_income_pkr || ''}
                    onChange={(e) => setForm({ ...form, household_monthly_income_pkr: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.siblings')}</label>
                  <input type="number" min={0} value={form.siblings_studying || ''}
                    onChange={(e) => setForm({ ...form, siblings_studying: +e.target.value })} className="input-field" />
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
                <input type="checkbox" checked={form.is_orphan} onChange={(e) => setForm({ ...form, is_orphan: e.target.checked })} className="accent-dp-secondary" />
                {t('kf.f.isOrphan')}
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.level')}</label>
                  <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} className="input-field">
                    {LEVELS.map((l) => <option key={l} value={l}>{t(`wz.level.${l}`)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.programme')}</label>
                  <input value={form.programme} onChange={(e) => setForm({ ...form, programme: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.institution')}</label>
                  <input value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.city')}</label>
                  <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.lastExam')}</label>
                  <input value={form.last_exam_name} onChange={(e) => setForm({ ...form, last_exam_name: e.target.value })}
                    placeholder="Matric / FSc" className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.percent')}</label>
                  <input type="number" min={0} max={100} value={form.last_exam_percent || ''}
                    onChange={(e) => setForm({ ...form, last_exam_percent: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.requested')}</label>
                  <input type="number" min={0} value={form.requested_amount_pkr || ''}
                    onChange={(e) => setForm({ ...form, requested_amount_pkr: +e.target.value })} className="input-field" />
                </div>
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.needStatement')}</label>
                <textarea value={form.need_statement} onChange={(e) => setForm({ ...form, need_statement: e.target.value })}
                  rows={3} className="input-field resize-none" />
              </div>

              <button disabled={busy} onClick={addApplicant}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {busy ? t('action.saving') : t('wz.submitApplication')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Award ───────────────────────────────────────────────────────── */}
      {awardTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setAwardTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.awardTitle')}</h2>
              <button onClick={() => setAwardTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <p className="font-sans text-[14px] font-semibold">{studentOf(awardTarget.student_id)?.full_name}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{awardTarget.programme} · {awardTarget.institution}</p>
            </div>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.awardAmount')}</label>
            <input type="number" min={0} value={awardForm.amount || ''}
              onChange={(e) => setAwardForm({ ...awardForm, amount: +e.target.value })} className="input-field mb-3" />

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.fundedBy')}</label>
            <select value={awardForm.funded_by} onChange={(e) => setAwardForm({ ...awardForm, funded_by: e.target.value })} className="input-field mb-1.5">
              <option value="sadqa">{t('wz.funded.sadqa')}</option>
              <option value="zakat">{t('wz.funded.zakat')}</option>
              <option value="general">{t('wz.funded.general')}</option>
              <option value="sponsor">{t('wz.funded.sponsor')}</option>
            </select>
            {awardForm.funded_by === 'zakat' && (
              <p className="font-sans text-[11.5px] text-amber-700 mb-3">{t('wz.zakatRouting')}</p>
            )}

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 mt-3">{t('wz.f.condition')}</label>
            <textarea value={awardForm.condition} onChange={(e) => setAwardForm({ ...awardForm, condition: e.target.value })}
              rows={2} placeholder={t('wz.f.conditionPlaceholder')} className="input-field resize-none mb-4" />

            <button disabled={busy} onClick={grantAward}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Award size={16} /> {busy ? t('action.saving') : t('wz.grantAward')}
            </button>
          </div>
        </div>
      )}

      {/* ── Instalment ──────────────────────────────────────────────────── */}
      {instalmentTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setInstalmentTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('wz.addInstalment')}</h2>
              <button onClick={() => setInstalmentTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.purpose')}</label>
            <select value={instalmentForm.purpose} onChange={(e) => setInstalmentForm({ ...instalmentForm, purpose: e.target.value })} className="input-field mb-3">
              {PURPOSES.map((p) => <option key={p} value={p}>{t(`wz.purpose.${p}`)}</option>)}
            </select>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                <input type="number" min={0} value={instalmentForm.amount || ''}
                  onChange={(e) => setInstalmentForm({ ...instalmentForm, amount: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.dueOn')}</label>
                <input type="date" value={instalmentForm.due_on}
                  onChange={(e) => setInstalmentForm({ ...instalmentForm, due_on: e.target.value })} className="input-field" />
              </div>
            </div>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.m.description')}</label>
            <input value={instalmentForm.description} onChange={(e) => setInstalmentForm({ ...instalmentForm, description: e.target.value })} className="input-field mb-4" />

            <button disabled={busy} onClick={addInstalment}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Plus size={16} /> {busy ? t('action.saving') : t('wz.addInstalment')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
