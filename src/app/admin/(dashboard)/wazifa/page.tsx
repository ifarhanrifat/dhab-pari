'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  BookOpen, X, Award, Calculator, HandCoins, Plus, Save, ClipboardCheck, Gavel, CalendarClock, Users, FileText, Printer, Ban, RotateCcw,
  HelpCircle, ChevronDown, Phone, AlertTriangle, Wallet, Info,
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
  id: string; code: string; full_name: string; father_name: string | null
  phone: string | null; gender: string | null; is_orphan: boolean
  household_monthly_income_pkr: number | null; siblings_studying: number
  status: string; created_at: string
}

interface Application {
  id: string; student_id: string; academic_year: string
  level: string; institution: string; programme: string; city: string | null
  admission_status: string; last_exam_name: string | null
  last_exam_percent: number | null; requested_amount_pkr: number
  need_statement: string | null; status: string
  merit_score: number | null; need_score: number | null; total_score: number | null
}

interface AwardRow {
  id: string; application_id: string; student_id: string; academic_year: string
  awarded_amount_pkr: number; funded_by: string; status: string
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
  full_name: '', full_name_ur: '', father_name: '', phone: '', gender: 'male',
  is_orphan: false, household_monthly_income_pkr: 0, siblings_studying: 0,
  level: 'bachelors', institution: '', programme: '', city: '',
  last_exam_name: '', last_exam_percent: 0, requested_amount_pkr: 0, need_statement: '',
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
  }[]>([])
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

  const load = useCallback(async () => {
    const [{ data: st }, { data: ap }, { data: aw }, { data: ins }, { data: sum }, { data: vf }, { data: dc },
           { data: docs }, { data: cm }, { data: minV }, { data: sch }] = await Promise.all([
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
    ])
    setStudents((st ?? []) as Student[])
    setApplications((ap ?? []) as Application[])
    setAwards((aw ?? []) as AwardRow[])
    setInstalments((ins ?? []) as Instalment[])
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
    setCollAnnouncements(((ann ?? []) as typeof collAnnouncements).filter((a) => a.pool_code === 'POOL-WZF'))
  }, [supabase])

  // Loaded on mount, not gated on the tab being open — see the matching
  // note on /admin/kafalat for why a badge that only knows its own count
  // after you've already opened the tab is not a useful badge.
  useEffect(() => { loadCollections() }, [loadCollections])

  const confirmCollAnnouncement = async (id: string) => {
    setBusy(true)
    const { error } = await supabase.rpc('pool_confirm_payment', { p_payment_id: id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.ok.confirmed'))
    loadCollections()
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
    setBusy(true)
    const { data: student, error } = await supabase.from('wazifa_students').insert({
      full_name: form.full_name, full_name_ur: form.full_name_ur || null,
      father_name: form.father_name || null, phone: form.phone || null,
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
    for (const a of applications.filter((x) => ['submitted', 'screening', 'interview'].includes(x.status))) {
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
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_record_decision', {
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
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('wz.ok.decided'))
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

const open = applications.filter((a) => ['submitted', 'screening', 'interview', 'waitlisted'].includes(a.status))

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
                  </div>
                  <p className="font-sans text-[13.5px] text-dp-on-surface">
                    {t(`wz.level.${a.level}`)} · {a.programme} · <span className="text-dp-on-surface-variant">{a.institution}{a.city ? `, ${a.city}` : ''}</span>
                  </p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                    {a.last_exam_name && `${a.last_exam_name}: ${a.last_exam_percent ?? '—'}% · `}
                    {t('wz.requested')} Rs {fmt(a.requested_amount_pkr)}
                  </p>
                  {a.need_statement && <p className="font-sans text-[12.5px] text-dp-on-surface mt-1.5 italic">{a.need_statement}</p>}

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
            const mine = instalments.filter((i) => i.award_id === aw.id)
            const paid = mine.filter((i) => i.status === 'paid').reduce((x, i) => x + Number(i.amount_pkr), 0)
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
                    {(aw as AwardRow & { is_loan?: boolean; repaid_pkr?: number }).is_loan && (
                      <p className="font-sans text-[12.5px] text-emerald-700 mt-1 font-semibold">
                        {t('pwz.qarzBadge')} · {t('pwz.loanRepaid')} Rs {fmt(Number((aw as AwardRow & { repaid_pkr?: number }).repaid_pkr ?? 0))}
                        {' · '}{t('pwz.loanOutstanding')} Rs {fmt(aw.awarded_amount_pkr - Number((aw as AwardRow & { repaid_pkr?: number }).repaid_pkr ?? 0))}
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
                    <button onClick={() => setInstalmentTarget(aw)}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
                      <Plus size={14} /> {t('wz.addInstalment')}
                    </button>
                    {Number((aw as AwardRow & { student_monthly_contribution_pkr?: number }).student_monthly_contribution_pkr ?? 0) > 0 && (
                      <button onClick={() => { setContribTarget(aw); setContribForm({ amount: Number((aw as AwardRow & { student_monthly_contribution_pkr?: number }).student_monthly_contribution_pkr ?? 0), method: 'cash', note: '' }) }}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-emerald-600 text-emerald-700 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-emerald-600 hover:text-white transition-all cursor-pointer">
                        <HandCoins size={14} /> {t('wz.contribution')}
                      </button>
                    )}
                    {/* Only a qarz-e-hasana has anything to repay. A grant
                        shows neither button, so nobody can start chasing a
                        student who owes nothing. */}
                    {(aw as AwardRow & { is_loan?: boolean }).is_loan && (
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
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {a.proof_url && (
                        <a href={a.proof_url} target="_blank" rel="noreferrer" className="font-sans text-[12px] font-bold text-dp-secondary hover:underline">{t('pool.viewProof')}</a>
                      )}
                      <button onClick={() => confirmCollAnnouncement(a.id)} disabled={busy}
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
