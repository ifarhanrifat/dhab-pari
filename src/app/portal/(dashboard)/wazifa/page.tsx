'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  BookOpen, Send, Plus, Trash2, Printer, HandCoins, RotateCcw, Save, Lock, Info, UserCheck,
  HelpCircle, ChevronDown, TrendingUp, Calendar, ShieldCheck, AlertTriangle, Heart, X, FileText,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { printNodeInPopup } from '@/lib/receiptExport'
import { FileAttachment } from '@/components/admin/FileAttachment'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import Link from 'next/link'

/**
 * The Taleemi Wazifa application.
 *
 * This form is printed and carried to the house. The committee sits in the
 * courtyard and goes through it line by line, so it asks what can actually be
 * checked there — how many brothers and sisters are studying, at which school,
 * what the fee is, who works and whether they are paid by the day or the
 * month, whether there is a long illness in the house.
 *
 * "Siblings studying: 3" is not checkable. Three named children, two at the
 * village school and one travelling to Chakwal, with fees against each, is.
 */

interface FamilyRow {
  full_name: string; relation: string; age: number
  marital_status: string
  is_studying: boolean; institution: string; class_or_year: string
  study_location: string; annual_fee_pkr: number
  is_working: boolean; occupation: string; income_period: string; income_pkr: number
}

interface Decision {
  application_id: string; academic_year: string; programme: string; institution: string
  status: string; attempt: number; decided_on: string | null; decision: string | null
  approved_amount_pkr: number | null; as_loan: boolean | null
  reason: string | null; reason_ur: string | null
  shortfall_note: string | null; can_reapply: boolean | null
}

interface Loan {
  award_id: string; academic_year: string; awarded_amount_pkr: number
  repaid_pkr: number; outstanding: number; next_due_on: string | null; overdue: number
}

interface AcademicRow {
  exam: string; board_university: string; passing_year: number
  obtained_marks: number; total_marks: number
}

interface Dues {
  awards: { award_id: string; academic_year: string; is_loan: boolean
    position: { outstanding: number; next_due_on: string | null; overdue: number } }[]
  due_soon: { id: string; due_on: string; amount: number; status: string }[]
  total_outstanding: number
}

// A snapshot, not a live join (migration 269) — what was actually shown at
// the moment the committee sent it, so a later revision of the award's
// terms never rewrites what somebody already agreed to.
interface WazifaAgreement {
  agreement_id: string; award_id: string; academic_year: string
  awarded_amount_pkr: number; monthly_amount_pkr: number; due_day: number
  terms_text: string; terms_text_ur: string | null
  status: 'pending' | 'signed' | 'superseded'
  student_signed_name: string | null; student_signed_at: string | null
  installment_active: boolean
}

interface StatementEntry { date: string; particular: string; debit: number; credit: number; balance: number }
interface Statement { has_account: boolean; entries: StatementEntry[]; balance: number }

const LEVELS = ['intermediate', 'diploma', 'bachelors', 'masters', 'technical_certificate', 'medical', 'engineering', 'other'] as const
const EXAMS = ['matric', 'fsc', 'fa', 'ics', 'icom', 'dae', 'ba', 'bsc', 'bs', 'bcom', 'masters', 'other'] as const
const RELATIONS = ['father', 'mother', 'brother', 'sister', 'spouse', 'son', 'daughter', 'grandparent', 'other'] as const
const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

const STATUS_TONE: Record<string, string> = {
  submitted: 'bg-amber-100 text-amber-800',
  screening: 'bg-sky-100 text-sky-800',
  interview: 'bg-violet-100 text-violet-800',
  approved: 'bg-emerald-100 text-emerald-800',
  waitlisted: 'bg-slate-100 text-slate-700',
  declined: 'bg-slate-100 text-slate-500',
}

const emptyFamilyRow: FamilyRow = {
  full_name: '', relation: 'brother', age: 0, marital_status: 'single',
  is_studying: false, institution: '', class_or_year: '', study_location: 'village', annual_fee_pkr: 0,
  is_working: false, occupation: '', income_period: 'monthly', income_pkr: 0,
}
const emptyAcademicRow: AcademicRow = {
  exam: 'matric', board_university: '', passing_year: new Date().getFullYear(),
  obtained_marks: 0, total_marks: 1100,
}

export default function PortalWazifaPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const { user: portalUser } = usePortalUser()
  const formRef = useRef<HTMLDivElement>(null)

  const [decisions, setDecisions] = useState<Decision[]>([])
  const [loans, setLoans] = useState<Loan[]>([])
  const [dues, setDues] = useState<Dues | null>(null)
  const [reapplyOf, setReapplyOf] = useState<Decision | null>(null)
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)

  // ── Sponsoring a student — a different visitor to this same page than the
  // one applying above: pick a specific student, or join the shared pool
  // with no name attached, the same pattern Kafalat and Sadqa already use.
  // Every donor lands on "sponsor" by default — the cards, not somebody
  // else's eleven-step application form.
  const [activeTab, setActiveTab] = useState<'sponsor' | 'apply'>('sponsor')
  const [showGuide, setShowGuide] = useState(false)
  const [sponsorPoolId, setSponsorPoolId] = useState<string | null>(null)
  const [sponsorPosition, setSponsorPosition] = useState<{
    required: number; committed: number; donors: number; coverage_percent: number
    suggested_share: number; min_share: number
  } | null>(null)
  const [sponsorStudents, setSponsorStudents] = useState<{
    student_id: string; code: string; full_name: string; institution: string | null
    programme: string | null; level: string | null; awarded_amount: number; is_loan: boolean; already_named: number
    is_zakat_family: boolean
  }[]>([])
  const [sponsorCommitments, setSponsorCommitments] = useState<{
    id: string; pool_id: string; monthly_amount: number; status: string
    named_student: string | null; wazifa_student_id: string | null; months_given: number; total_given: number
  }[]>([])
  const [sponsorAnnouncements, setSponsorAnnouncements] = useState<{
    id: string; pool_id: string; amount: number; is_one_time: boolean; status: string
    named_student: string | null; wazifa_student_id: string | null; has_proof: boolean
  }[]>([])
  const [giving, setGiving] = useState<{ target: (typeof sponsorStudents)[number] | null } | null>(null)
  const [giveForm, setGiveForm] = useState({ amount: 0, recurring: true, funded_by: 'sadqa', show_name_publicly: false })
  const [changingShare, setChangingShare] = useState<(typeof sponsorCommitments)[number] | null>(null)
  const [changeAmount, setChangeAmount] = useState(0)

  // The application already on file, if there is one. A family filling in
  // eleven sections needs to stop halfway and come back — and needs to fix the
  // fee they typed wrong a minute after sending it. Editing stays open until
  // the committee starts reviewing, and closes for good after that, because
  // what they verified in person has to keep matching what is on the record.
  const [showForm, setShowForm] = useState(false)
  // What the form looked like the moment it was opened, so "Close" can tell
  // an untouched visit (no confirmation needed) from one where something was
  // typed and would otherwise vanish silently.
  const openSnapshotRef = useRef<string>('')
  const [savedId, setSavedId] = useState<string | null>(null)
  // Someone who already has an application on file almost certainly came
  // back to check on it, not to browse sponsor cards — land them where
  // they actually need to be, once, the first time it loads.
  useEffect(() => { if (savedId) setActiveTab('apply') }, [savedId])
  const [savedStatus, setSavedStatus] = useState<string | null>(null)
  const [isEditable, setIsEditable] = useState(true)
  const [lockedReason, setLockedReason] = useState<string | null>(null)

  const [form, setForm] = useState({
    applicant_for: 'self',
    applicant_name: '', applicant_relation: '', applicant_phone: '',
    student_full_name: '', student_full_name_ur: '', father_name: '', mother_name: '', gender: 'male', student_phone: '',
    declared_cnic: '', declared_b_form_no: '', declared_dob: '', declared_address: '',
    offered_monthly_contribution_pkr: 0, institution_monthly_fee_pkr: 0,
    father_alive: true, father_occupation: '', mother_occupation: '',
    house_owned: true, land_owned_kanal: 0,
    family_monthly_income_pkr: 0,
    has_long_term_patient: false, patient_relation: '', patient_illness: '', patient_monthly_cost_pkr: 0,
    family_receives_zakat: false, zakat_sources: [] as string[], zakat_monthly_pkr: 0,
    level: 'bachelors', institution: '', programme: '', city: '', admission_status: 'seeking',
    requested_amount_pkr: 0, actual_course_cost_pkr: 0, need_statement: '', achievements: '',
    course_start_date: '', course_end_date: '', admission_fee_pkr: 0, transport_monthly_cost_pkr: 0,
    institute_phone: '', institute_address: '', institute_registration_no: '',
    institute_bank_account_title: '', institute_bank_account_no: '', institute_payment_number: '',
    is_in_hostel: false, hostel_name: '', hostel_room_no: '', hostel_monthly_charges_pkr: 0,
    hostel_phone: '', hostel_beneficiary_name: '', hostel_bank_account_title: '',
    hostel_bank_account_no: '', hostel_payment_number: '',
    repayment_pledge: false, repayment_note: '',
    requested_as: 'loan',
    has_family_business: false, family_business_kind: '', family_business_share_pkr: 0, family_business_note: '',
    loan_terms_accepted: false, loan_terms_signature: '',
  })
  const [docs, setDocs] = useState<{ kind: string; label: string; url: string }[]>([])
  const [loanTerms, setLoanTerms] = useState({ ur: '', en: '' })
  const [minVerifiers, setMinVerifiers] = useState(2)
  const [family, setFamily] = useState<FamilyRow[]>([{ ...emptyFamilyRow }])
  const [academics, setAcademics] = useState<AcademicRow[]>([{ ...emptyAcademicRow }])

  // The agreement a student signs once the committee has decided and fixed
  // a monthly figure, and the read-only statement of everything posted to
  // their own account since — migrations 269/271.
  const [agreements, setAgreements] = useState<WazifaAgreement[]>([])
  const [signing, setSigning] = useState<WazifaAgreement | null>(null)
  // Typing a name is gone — a real signature, witnessed, printed, signed
  // by hand, and uploaded as a photo (migration 293). father/witness1/
  // witness2 each need a name, CNIC and phone; the document itself is
  // the upload proving all of it actually happened on paper.
  const [signForm, setSignForm] = useState({
    father_name: '', father_cnic: '', father_phone: '',
    witness1_name: '', witness1_cnic: '', witness1_phone: '',
    witness2_name: '', witness2_cnic: '', witness2_phone: '',
    document_url: '',
  })
  const [statement, setStatement] = useState<Statement | null>(null)

  const load = useCallback(async () => {
    const [{ data: sum }, { data: dec }, { data: lns }, { data: terms }, { data: saved }, { data: due },
           { data: ags }, { data: stmt }] = await Promise.all([
      supabase.rpc('public_wazifa_summary'),
      supabase.rpc('my_wazifa_decisions'),
      supabase.rpc('my_wazifa_loans'),
      supabase.from('site_settings').select('key, value')
        .in('key', ['wazifa_loan_terms_ur', 'wazifa_loan_terms_en', 'wazifa_min_verifiers']),
      supabase.rpc('my_wazifa_application'),
      supabase.rpc('my_wazifa_dues'),
      supabase.rpc('my_wazifa_agreements'),
      supabase.rpc('my_wazifa_statement'),
    ])
    setDues((due ?? null) as Dues | null)
    setAgreements((ags ?? []) as WazifaAgreement[])
    setStatement((stmt ?? null) as Statement | null)

    if (saved) {
      const a = saved.application as Record<string, unknown>
      const st = saved.student as Record<string, unknown>
      setSavedId(a.id as string)
      setSavedStatus(a.status as string)
      setIsEditable(Boolean(saved.is_editable))
      setLockedReason((saved.locked_reason as string) ?? null)

      setForm((f) => ({
        ...f,
        applicant_for: (a.applicant_for as string) ?? f.applicant_for,
        applicant_name: (a.applicant_name as string) ?? '',
        applicant_relation: (a.applicant_relation as string) ?? '',
        applicant_phone: (a.applicant_phone as string) ?? '',
        student_full_name: (st?.full_name as string) ?? '',
        student_full_name_ur: (st?.full_name_ur as string) ?? '',
        father_name: (st?.father_name as string) ?? '',
        mother_name: (st?.mother_name as string) ?? '',
        gender: (st?.gender as string) ?? f.gender,
        student_phone: (st?.phone as string) ?? '',
        declared_cnic: (a.declared_cnic as string) ?? '',
        declared_b_form_no: (a.declared_b_form_no as string) ?? '',
        declared_dob: (a.declared_dob as string) ?? '',
        declared_address: (a.declared_address as string) ?? '',
        offered_monthly_contribution_pkr: Number(a.offered_monthly_contribution_pkr ?? 0),
        institution_monthly_fee_pkr: Number(a.institution_monthly_fee_pkr ?? 0),
        father_alive: a.father_alive !== false,
        father_occupation: (a.father_occupation as string) ?? '',
        mother_occupation: (a.mother_occupation as string) ?? '',
        house_owned: a.house_owned !== false,
        land_owned_kanal: Number(a.land_owned_kanal ?? 0),
        family_monthly_income_pkr: Number(a.family_monthly_income_pkr ?? 0),
        has_long_term_patient: Boolean(a.has_long_term_patient),
        patient_relation: (a.patient_relation as string) ?? '',
        patient_illness: (a.patient_illness as string) ?? '',
        patient_monthly_cost_pkr: Number(a.patient_monthly_cost_pkr ?? 0),
        family_receives_zakat: Boolean(a.family_receives_zakat),
        zakat_sources: (a.zakat_sources as string[]) ?? [],
        zakat_monthly_pkr: Number(a.zakat_monthly_pkr ?? 0),
        level: (a.level as string) ?? f.level,
        institution: (a.institution as string) ?? '',
        programme: (a.programme as string) ?? '',
        city: (a.city as string) ?? '',
        admission_status: (a.admission_status as string) ?? f.admission_status,
        requested_amount_pkr: Number(a.requested_amount_pkr ?? 0),
        actual_course_cost_pkr: Number(a.actual_course_cost_pkr ?? 0),
        course_start_date: (a.course_start_date as string) ?? '',
        course_end_date: (a.course_end_date as string) ?? '',
        admission_fee_pkr: Number(a.admission_fee_pkr ?? 0),
        transport_monthly_cost_pkr: Number(a.transport_monthly_cost_pkr ?? 0),
        need_statement: (a.need_statement as string) ?? '',
        achievements: (a.achievements as string) ?? '',
        institute_phone: (a.institute_phone as string) ?? '',
        institute_address: (a.institute_address as string) ?? '',
        institute_registration_no: (a.institute_registration_no as string) ?? '',
        institute_bank_account_title: (a.institute_bank_account_title as string) ?? '',
        institute_bank_account_no: (a.institute_bank_account_no as string) ?? '',
        institute_payment_number: (a.institute_payment_number as string) ?? '',
        is_in_hostel: Boolean(a.is_in_hostel),
        hostel_name: (a.hostel_name as string) ?? '',
        hostel_room_no: (a.hostel_room_no as string) ?? '',
        hostel_monthly_charges_pkr: Number(a.hostel_monthly_charges_pkr ?? 0),
        hostel_phone: (a.hostel_phone as string) ?? '',
        hostel_beneficiary_name: (a.hostel_beneficiary_name as string) ?? '',
        hostel_bank_account_title: (a.hostel_bank_account_title as string) ?? '',
        hostel_bank_account_no: (a.hostel_bank_account_no as string) ?? '',
        hostel_payment_number: (a.hostel_payment_number as string) ?? '',
        repayment_pledge: Boolean(a.repayment_pledge),
        repayment_note: (a.repayment_note as string) ?? '',
        requested_as: (a.requested_as as string) ?? f.requested_as,
        has_family_business: Boolean(a.has_family_business),
        family_business_kind: (a.family_business_kind as string) ?? '',
        family_business_share_pkr: Number(a.family_business_share_pkr ?? 0),
        family_business_note: (a.family_business_note as string) ?? '',
        loan_terms_accepted: Boolean(a.loan_terms_accepted),
        loan_terms_signature: (a.loan_terms_signature as string) ?? '',
      }))

      const fam = (saved.family ?? []) as Record<string, unknown>[]
      if (fam.length) {
        setFamily(fam.map((r) => ({
          ...emptyFamilyRow,
          full_name: (r.full_name as string) ?? '',
          relation: (r.relation as string) ?? emptyFamilyRow.relation,
          age: Number(r.age ?? 0),
          marital_status: (r.marital_status as string) ?? emptyFamilyRow.marital_status,
          is_studying: Boolean(r.is_studying),
          institution: (r.institution as string) ?? '',
          class_or_year: (r.class_or_year as string) ?? '',
          study_location: (r.study_location as string) ?? emptyFamilyRow.study_location,
          annual_fee_pkr: Number(r.annual_fee_pkr ?? 0),
          is_working: Boolean(r.is_working),
          occupation: (r.occupation as string) ?? '',
          income_period: (r.income_period as string) ?? emptyFamilyRow.income_period,
          income_pkr: Number(r.income_pkr ?? 0),
        })) as FamilyRow[])
      }

      const acs = (saved.academics ?? []) as Record<string, unknown>[]
      if (acs.length) {
        setAcademics(acs.map((r) => ({
          ...emptyAcademicRow,
          exam: (r.exam as string) ?? emptyAcademicRow.exam,
          board_university: (r.board_university as string) ?? '',
          passing_year: Number(r.passing_year ?? 0),
          obtained_marks: Number(r.obtained_marks ?? 0),
          total_marks: Number(r.total_marks ?? 0),
        })) as AcademicRow[])
      }

      setDocs(((saved.documents ?? []) as Record<string, unknown>[]).map((d) => ({
        kind: (d.kind as string) ?? 'other',
        label: (d.label as string) ?? '',
        url: (d.url as string) ?? '',
      })))
    }
    setSummary((sum ?? {}) as Record<string, number>)
    setDecisions((dec ?? []) as Decision[])
    setLoans((lns ?? []) as Loan[])
    const tm = Object.fromEntries(((terms ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]))
    setLoanTerms({ ur: tm.wazifa_loan_terms_ur ?? '', en: tm.wazifa_loan_terms_en ?? '' })
    setMinVerifiers(Number(tm.wazifa_min_verifiers ?? 2))
  }, [supabase])

  useEffect(() => { load() }, [load])

  const loadSponsorship = useCallback(async () => {
    const { data: pool } = await supabase.from('support_pools').select('id').eq('code', 'POOL-WZF').single()
    const pid = (pool as { id: string } | null)?.id ?? null
    setSponsorPoolId(pid)
    const [{ data: pos }, { data: students }, { data: myC }, { data: myA }] = await Promise.all([
      pid ? supabase.rpc('pool_position', { p_pool_id: pid }) : Promise.resolve({ data: null }),
      supabase.rpc('wazifa_students_for_naming'),
      supabase.rpc('my_pool_commitments'),
      supabase.rpc('my_pool_announcements'),
    ])
    setSponsorPosition((pos ?? null) as typeof sponsorPosition)
    setSponsorStudents((students ?? []) as typeof sponsorStudents)
    setSponsorCommitments(((myC ?? []) as typeof sponsorCommitments).filter((c) => c.pool_id === pid))
    setSponsorAnnouncements(((myA ?? []) as typeof sponsorAnnouncements).filter((a) => a.pool_id === pid))
  }, [supabase])

  useEffect(() => { loadSponsorship() }, [loadSponsorship])

  // A donor can hold several independent standing commitments at once — one
  // per named student, plus optionally one to the shared pool — so whether
  // "monthly" is already taken only ever means something against a specific
  // target, never the whole page at once.
  const commitmentFor = (target: (typeof sponsorStudents)[number] | null) =>
    sponsorCommitments.find((c) => c.status === 'active' && (target ? c.wazifa_student_id === target.student_id : !c.wazifa_student_id))

  const openGive = (target: (typeof sponsorStudents)[number] | null) => {
    const existing = commitmentFor(target)
    setGiveForm({
      amount: existing?.monthly_amount ?? (target ? Math.max(target.awarded_amount - target.already_named, sponsorPosition?.min_share ?? 1000) : (sponsorPosition?.suggested_share ?? 2000)),
      recurring: !existing, funded_by: 'sadqa', show_name_publicly: false,
    })
    setGiving({ target })
  }

  const submitGive = async () => {
    if (!giving || !sponsorPoolId) return
    if (sponsorPosition && giveForm.amount < sponsorPosition.min_share) {
      toast.error(t('pool.minimumIs').replace('{amt}', fmt(sponsorPosition.min_share))); return
    }
    setBusy(true)
    const { error } = await supabase.rpc('pool_announce', {
      p_pool_id: sponsorPoolId, p_amount: giveForm.amount, p_recurring: giveForm.recurring,
      p_funded_by: giveForm.funded_by, p_show_name_publicly: giveForm.show_name_publicly,
      p_wazifa_student_id: giving.target?.student_id ?? null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.announced'))
    setGiving(null)
    loadSponsorship()
  }

  const submitChangeShare = async () => {
    if (!changingShare) return
    setBusy(true)
    const { error } = await supabase.rpc('pool_change_my_share', { p_commitment_id: changingShare.id, p_monthly_amount: changeAmount })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.shareChanged'))
    setChangingShare(null)
    loadSponsorship()
  }

  // The real thing now: father/guardian and two witnesses, each named
  // with a CNIC and phone, plus a photo of the document they all
  // actually signed by hand (migration 293). wazifa_submit_witnessed_
  // agreement() checks ownership itself and rejects a missing upload or
  // a missing name — this only needs to catch it early enough to point
  // at what's still blank.
  const submitSign = async () => {
    if (!signing) return
    if (!signForm.document_url) { toast.error(t('pwz.ag.mustUpload')); return }
    if (!signForm.father_name.trim() || !signForm.witness1_name.trim() || !signForm.witness2_name.trim()) {
      toast.error(t('pwz.ag.mustNameAll')); return
    }
    setBusy(true)
    const { error } = await supabase.rpc('wazifa_submit_witnessed_agreement', {
      p_agreement_id: signing.agreement_id,
      p_father_name: signForm.father_name.trim(), p_father_cnic: signForm.father_cnic.trim() || null, p_father_phone: signForm.father_phone.trim() || null,
      p_witness1_name: signForm.witness1_name.trim(), p_witness1_cnic: signForm.witness1_cnic.trim() || null, p_witness1_phone: signForm.witness1_phone.trim() || null,
      p_witness2_name: signForm.witness2_name.trim(), p_witness2_cnic: signForm.witness2_cnic.trim() || null, p_witness2_phone: signForm.witness2_phone.trim() || null,
      p_signed_document_url: signForm.document_url,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pwz.ag.signed'))
    setSigning(null)
    setSignForm({ father_name: '', father_cnic: '', father_phone: '', witness1_name: '', witness1_cnic: '', witness1_phone: '',
      witness2_name: '', witness2_cnic: '', witness2_phone: '', document_url: '' })
    load()
  }

  const stopSponsoring = async (c: (typeof sponsorCommitments)[number]) => {
    if (!confirm(t('pool.leaveConfirm'))) return
    const { error } = await supabase.rpc('pool_leave', { p_commitment_id: c.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.left'))
    loadSponsorship()
  }

  const withdrawSponsorAnnouncement = async (a: (typeof sponsorAnnouncements)[number]) => {
    if (!confirm(t('pool.withdrawConfirm'))) return
    const { error } = await supabase.rpc('pool_cancel_announcement', { p_payment_id: a.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.withdrawn'))
    loadSponsorship()
  }

  // Monthly figure, whether the family is paid by the day or the month.
  const monthlyIncome = family
    .filter((f) => f.is_working)
    .reduce((s, f) => s + (f.income_period === 'daily' ? f.income_pkr * 26
      : f.income_period === 'weekly' ? f.income_pkr * 4.33 : f.income_pkr), 0)
  const familyEducationCost = family.filter((f) => f.is_studying).reduce((s, f) => s + (f.annual_fee_pkr || 0), 0)

  const setFamilyRow = (i: number, patch: Partial<FamilyRow>) => {
    const next = [...family]; next[i] = { ...next[i], ...patch }; setFamily(next)
  }
  const setAcademicRow = (i: number, patch: Partial<AcademicRow>) => {
    const next = [...academics]; next[i] = { ...next[i], ...patch }; setAcademics(next)
  }

  const printForm = () => {
    if (!formRef.current) return
    const ok = printNodeInPopup(formRef.current, t('pwz.title'))
    if (!ok) toast.error(t('pwz.err.popup'))
  }

  const submit = async (asDraft = false) => {
    if (!portalUser) { toast.error(t('pwz.err.login')); return }
    // A draft is a half-finished thought and is saved as it stands. Only a
    // real submission has to be complete — refusing to save an incomplete
    // draft would defeat the entire point of having drafts.
    if (!form.student_full_name.trim()) { toast.error(t('pwz.err.studentName')); return }
    if (!asDraft) {
      if (!form.institution.trim() || !form.programme.trim()) { toast.error(t('pwz.err.required')); return }
      if (!form.need_statement.trim()) { toast.error(t('pwz.err.statement')); return }
    }
    // The real agreement — amount, schedule, and every signature it needs —
    // only exists once the committee has decided (Phase 2). Nothing to
    // accept or sign at application time any more.
    setBusy(true)

    // The student is the subject of the record, not whoever held the pen. A
    // father applying for his son creates the son's record and signs it as
    // the applicant, so next year the son's history is already there.
    const { data: existing } = await supabase.from('wazifa_students')
      .select('id').eq('portal_user_id', portalUser.id).maybeSingle()

    let studentId = existing?.id
    // Identity fields the zakat-family check reads at screening — father's
    // and mother's name in particular (migration 275) — so a correction on
    // a later save has to actually reach wazifa_students, not just the
    // application row. Insert once, then keep both in sync on every save.
    const studentFields = {
      full_name: form.student_full_name.trim(),
      full_name_ur: form.student_full_name_ur || null,
      cnic: form.declared_cnic || null,
      b_form_no: form.declared_b_form_no || null,
      date_of_birth: form.declared_dob || null,
      address: form.declared_address || null,
      father_name: form.father_name || null,
      mother_name: form.mother_name || null,
      phone: form.student_phone || portalUser.mobile || null,
      gender: form.gender,
      is_orphan: !form.father_alive,
      household_monthly_income_pkr: monthlyIncome || form.family_monthly_income_pkr,
      siblings_studying: family.filter((f) => f.is_studying).length,
    }
    if (!studentId) {
      const { data: created, error } = await supabase.from('wazifa_students').insert({
        ...studentFields, portal_user_id: portalUser.id, status: 'applicant',
      }).select('id').single()
      if (error) { setBusy(false); toast.error(friendlyError(error)); return }
      studentId = created.id
    } else {
      await supabase.from('wazifa_students').update(studentFields).eq('id', studentId)
    }

    const year = `${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`
    const payload = {
      student_id: studentId, academic_year: year,
      applicant_for: 'self',
      applicant_name: null,
      applicant_relation: null,
      applicant_phone: form.applicant_phone || portalUser.mobile || null,
      level: form.level, institution: form.institution.trim(),
      programme: form.programme.trim(), city: form.city || null,
      admission_status: form.admission_status,
      requested_amount_pkr: form.requested_amount_pkr,
      actual_course_cost_pkr: form.actual_course_cost_pkr || null,
      course_start_date: form.course_start_date || null,
      course_end_date: form.course_end_date || null,
      admission_fee_pkr: form.admission_fee_pkr || 0,
      transport_monthly_cost_pkr: form.transport_monthly_cost_pkr || 0,
      need_statement: form.need_statement.trim(),
      achievements: form.achievements || null,
      institute_phone: form.institute_phone || null,
      institute_address: form.institute_address || null,
      institute_registration_no: form.institute_registration_no || null,
      institute_bank_account_title: form.institute_bank_account_title || null,
      institute_bank_account_no: form.institute_bank_account_no || null,
      institute_payment_number: form.institute_payment_number || null,
      is_in_hostel: form.is_in_hostel,
      hostel_name: form.is_in_hostel ? (form.hostel_name || null) : null,
      hostel_room_no: form.is_in_hostel ? (form.hostel_room_no || null) : null,
      hostel_monthly_charges_pkr: form.is_in_hostel ? (form.hostel_monthly_charges_pkr || 0) : 0,
      hostel_phone: form.is_in_hostel ? (form.hostel_phone || null) : null,
      hostel_beneficiary_name: form.is_in_hostel ? (form.hostel_beneficiary_name || null) : null,
      hostel_bank_account_title: form.is_in_hostel ? (form.hostel_bank_account_title || null) : null,
      hostel_bank_account_no: form.is_in_hostel ? (form.hostel_bank_account_no || null) : null,
      hostel_payment_number: form.is_in_hostel ? (form.hostel_payment_number || null) : null,
      family_monthly_income_pkr: monthlyIncome || form.family_monthly_income_pkr,
      father_alive: form.father_alive,
      father_occupation: form.father_occupation || null,
      mother_occupation: form.mother_occupation || null,
      house_owned: form.house_owned,
      land_owned_kanal: form.land_owned_kanal || null,
      has_long_term_patient: form.has_long_term_patient,
      patient_relation: form.patient_relation || null,
      patient_illness: form.patient_illness || null,
      patient_monthly_cost_pkr: form.patient_monthly_cost_pkr || 0,
      family_receives_zakat: form.family_receives_zakat,
      zakat_sources: form.zakat_sources.length > 0 ? form.zakat_sources : null,
      zakat_monthly_pkr: form.zakat_monthly_pkr || 0,
      requested_as: form.requested_as,
      declared_cnic: form.declared_cnic || null,
      declared_b_form_no: form.declared_b_form_no || null,
      declared_dob: form.declared_dob || null,
      declared_address: form.declared_address || null,
      // No longer solicited on the form — the committee pays the full
      // monthly cost while the student studies, verified by a monthly
      // phone call instead of a co-payment (see pwz.s.share below).
      offered_monthly_contribution_pkr: 0,
      institution_monthly_fee_pkr: form.institution_monthly_fee_pkr || 0,
      repayment_pledge: form.requested_as !== 'grant',
      repayment_note: form.repayment_note || null,
      has_family_business: form.has_family_business,
      family_business_kind: form.family_business_kind || null,
      family_business_share_pkr: form.family_business_share_pkr || 0,
      family_business_note: form.family_business_note || null,
      loan_terms_accepted: form.requested_as !== 'grant' ? form.loan_terms_accepted : false,
      loan_terms_accepted_at: form.requested_as !== 'grant' && form.loan_terms_accepted ? new Date().toISOString() : null,
      loan_terms_signature: form.requested_as !== 'grant' ? (form.loan_terms_signature || null) : null,
      // A second attempt is linked to the first, so the committee can see
      // that this family has been here before and what changed.
      supersedes_application_id: reapplyOf?.application_id ?? null,
      attempt: reapplyOf ? (reapplyOf.attempt ?? 1) + 1 : 1,
      status: asDraft ? 'draft' : 'submitted',
    }

    // Re-saving an application that is still open updates it in place, so the
    // committee sees one form per applicant rather than a pile of near-
    // duplicates, and the id the documents hang off does not change.
    let app: { id: string } | null = null
    let appErr: unknown = null
    if (savedId && isEditable) {
      const { error } = await supabase.from('wazifa_applications')
        .update(payload).eq('id', savedId)
      appErr = error
      app = error ? null : { id: savedId }
    } else {
      const { data, error } = await supabase.from('wazifa_applications')
        .insert(payload).select('id').single()
      appErr = error
      app = data
    }
    if (appErr || !app) { setBusy(false); toast.error(friendlyError(appErr)); return }

    const familyRows = family.filter((f) => f.full_name.trim()).map((f) => ({
      application_id: app.id, full_name: f.full_name.trim(), relation: f.relation,
      age: f.age || null, marital_status: f.marital_status,
      is_studying: f.is_studying,
      institution: f.is_studying ? (f.institution || null) : null,
      class_or_year: f.is_studying ? (f.class_or_year || null) : null,
      study_location: f.is_studying ? f.study_location : null,
      annual_fee_pkr: f.is_studying ? f.annual_fee_pkr : 0,
      is_working: f.is_working,
      occupation: f.is_working ? (f.occupation || null) : null,
      income_period: f.is_working ? f.income_period : null,
      income_pkr: f.is_working ? f.income_pkr : 0,
    }))
    // Replaced wholesale rather than appended, so deleting a sibling in the
    // form actually deletes them instead of leaving a ghost row behind.
    await supabase.from('wazifa_family_members').delete().eq('application_id', app.id)
    if (familyRows.length > 0) await supabase.from('wazifa_family_members').insert(familyRows)

    const academicRows = academics.filter((a) => a.total_marks > 0 && a.obtained_marks > 0).map((a) => ({
      application_id: app.id, exam: a.exam,
      board_university: a.board_university || null,
      passing_year: a.passing_year || null,
      obtained_marks: a.obtained_marks, total_marks: a.total_marks,
    }))
    await supabase.from('wazifa_academic_records').delete().eq('application_id', app.id)
    if (academicRows.length > 0) await supabase.from('wazifa_academic_records').insert(academicRows)

    // Documents a verifier has already ticked off are protected by RLS and
    // simply will not delete, which is the intended behaviour.
    await supabase.from('wazifa_documents').delete().eq('application_id', app.id)
    if (docs.length > 0) {
      await supabase.from('wazifa_documents').insert(
        docs.map((d) => ({
          application_id: app.id, kind: d.kind, label: d.label || null,
          url: d.url, uploaded_by_portal_user_id: portalUser.id,
        }))
      )
    }

    await supabase.rpc('wazifa_sync_merit', { p_application_id: app.id })

    setBusy(false)
    toast.success(asDraft ? t('pwz.ok.draftSaved')
      : reapplyOf ? t('pwz.ok.reapplied') : t('pwz.ok.submitted'))
    setReapplyOf(null)
    // A save is the new baseline — closing right after no longer asks
    // "discard your changes?" about changes that are already on record.
    openSnapshotRef.current = JSON.stringify({ form, family, academics })
    load()
  }

  // Opening snapshots what's on screen so Close can tell whether anything
  // actually changed; closing asks first only when something did.
  const openForm = () => {
    openSnapshotRef.current = JSON.stringify({ form, family, academics })
    setShowForm(true)
  }
  const closeForm = () => {
    const dirty = JSON.stringify({ form, family, academics }) !== openSnapshotRef.current
    if (dirty && !confirm(t('pwz.closeConfirm'))) return
    setShowForm(false)
  }

  const label = 'block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5'
  const section = 'bg-white border border-dp-outline-variant rounded-lg p-5 sm:p-6 mb-4'
  const heading = 'font-heading text-[18px] font-bold text-dp-primary mb-1'

  // Every section carries its number, so a form this long reads as a sequence
  // with an end rather than an unbroken wall. The number is also what a
  // committee member says on the phone: "section four, the brothers".
  const StepHead = ({ n, title, help, urdu }: { n: number; title: string; help?: string; urdu?: string }) => (
    <div className="mb-4 pb-3 border-b border-dp-outline-variant">
      <div className="flex items-start gap-3">
        <span className="shrink-0 w-7 h-7 rounded-full bg-dp-secondary text-white flex items-center justify-center font-sans text-[13px] font-bold mt-0.5">
          {n}
        </span>
        <div className="min-w-0">
          <h2 className={heading}>{title}</h2>
          {urdu && (
            <p className="font-sans text-[13px] text-dp-on-surface leading-relaxed mt-1"
              style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>{urdu}</p>
          )}
          {help && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1 leading-relaxed">{help}</p>}
        </div>
      </div>
    </div>
  )

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
            <BookOpen size={24} className="text-dp-secondary" /> {t('pwz.title')}
          </h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pwz.blurb')}</p>
        </div>
        <button onClick={printForm}
          className="flex items-center gap-1.5 px-3.5 py-2.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer print:hidden">
          <Printer size={15} /> {t('pwz.print')}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6 print:hidden">
        {([
          ['students_supported', 'wz.card.supported'],
          ['graduated', 'wz.card.graduated'],
          ['applications_open', 'wz.card.open'],
        ] as const).map(([key, lbl]) => (
          <div key={key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t(lbl)}</p>
            <p className="font-heading text-[22px] font-bold text-dp-primary">{summary[key] ?? 0}</p>
          </div>
        ))}
      </div>

      {/* ── Two tabs, two different visitors ─────────────────────────────
          A donor browsing to sponsor a named student and someone actually
          applying for themselves were sharing one page, and the donor had
          to scroll past an eleven-step application form meant for someone
          else entirely to get to the cards. "Sponsor a student" — every
          donor's default — is its own tab now; everything about applying
          (this student's own application, status, agreement, statement,
          the form itself) lives in "Apply for Taleemi Wazifa", opened on
          purpose, not stumbled into. */}
      <div className="flex gap-2 mb-6 print:hidden border-b border-dp-outline-variant">
        {(['sponsor', 'apply'] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 font-sans text-[14px] font-semibold border-b-2 -mb-px transition-all cursor-pointer ${
              activeTab === tab ? 'border-dp-secondary text-dp-secondary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-primary'}`}>
            {tab === 'sponsor' ? t('pwz.tab.sponsor') : t('pwz.tab.apply')}
          </button>
        ))}
      </div>

      {activeTab === 'apply' && (
      <>
      {/* ── My Application — always here, at the top, whether there is one
          yet or not. Small View/Print, not two big buttons and a second
          screen to get to them: this is a status card, not a second copy
          of the form.
          Once the committee has actually decided, "My applications" below
          carries the full picture (amount, qarz-e-hasana note, the
          committee's own reason) — repeating the institution/programme/
          status here too just showed the same application twice on one
          page (migration 285's audit). So once decided, this shrinks to
          the one thing it alone can do: open the actual form to view or
          print it. */}
      <div className="mb-6 print:hidden">
        {savedId ? (
          decisions.find((d) => d.application_id === savedId)?.decision ? (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg px-5 py-3">
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('pwz.seeApplicationBelow')}</p>
              <div className="flex gap-2 shrink-0">
                <button onClick={openForm}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface font-sans text-[12.5px] font-bold rounded-lg hover:text-dp-primary cursor-pointer">
                  <FileText size={13} /> {t('pwz.viewApplication')}
                </button>
                <button onClick={() => { openForm(); setTimeout(printForm, 300) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface font-sans text-[12.5px] font-bold rounded-lg hover:text-dp-primary cursor-pointer">
                  <Printer size={13} /> {t('pwz.print')}
                </button>
              </div>
            </div>
          ) : (
          <div className="bg-white border border-dp-outline-variant rounded-lg px-5 py-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                <h2 className="font-heading text-[15px] font-bold text-dp-primary">{t('pwz.savedTitle')}</h2>
                <span className="px-2 py-0.5 rounded-full bg-dp-surface-container-low font-sans text-[11px] font-bold text-dp-on-surface">
                  {t(`pwz.status.${savedStatus ?? 'draft'}`)}
                </span>
              </div>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                {form.institution || t('pwz.noInstitutionYet')}{form.programme ? ` · ${form.programme}` : ''}
              </p>
              {!isEditable && lockedReason && (
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 flex items-start gap-1.5">
                  <Lock size={12} className="shrink-0 mt-0.5" /> {lockedReason}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              {isEditable && (
                <button onClick={openForm}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-primary text-white font-sans text-[12.5px] font-bold rounded-lg hover:opacity-90 cursor-pointer">
                  {t('pwz.continueEditing')}
                </button>
              )}
              <button onClick={openForm}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface font-sans text-[12.5px] font-bold rounded-lg hover:text-dp-primary cursor-pointer">
                <FileText size={13} /> {t('pwz.viewApplication')}
              </button>
              <button onClick={() => { openForm(); setTimeout(printForm, 300) }}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface font-sans text-[12.5px] font-bold rounded-lg hover:text-dp-primary cursor-pointer">
                <Printer size={13} /> {t('pwz.print')}
              </button>
            </div>
          </div>
          )
        ) : (
          <button onClick={openForm}
            className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-dp-outline-variant hover:border-dp-secondary text-dp-primary py-4 rounded-lg font-sans font-semibold transition-colors cursor-pointer">
            <Plus size={17} /> {t('pwz.startApplication')}
          </button>
        )}
      </div>
      </>
      )}

      {activeTab === 'sponsor' && (
      <>
      {/* ── Sponsoring a student — a different visitor to this page than
          the one applying below: name a specific student, or join the
          shared pool with no name attached. */}
      <div className="mb-6 print:hidden">
        <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-1 flex items-center gap-2">
          <HandCoins size={18} className="text-dp-secondary" /> {t('pwz.sponsor.title')}
        </h2>
        <p className="font-sans text-[13px] text-dp-on-surface-variant mb-3 leading-relaxed">{t('pwz.sponsor.blurb')}</p>

        <button onClick={() => setShowGuide((v) => !v)}
          className="w-full flex items-center justify-between gap-2 bg-white border border-dp-outline-variant rounded-lg px-4 py-3 mb-3 hover:border-dp-secondary transition-all cursor-pointer">
          <span className="flex items-center gap-2 font-sans text-[13px] font-bold text-dp-primary">
            <HelpCircle size={16} /> {t('pool.howTitle')}
          </span>
          <ChevronDown size={16} className={`text-dp-on-surface-variant transition-transform ${showGuide ? 'rotate-180' : ''}`} />
        </button>

        {showGuide && (
          <section className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-3">
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
              {[
                { icon: HandCoins, k: 'what' },
                { icon: TrendingUp, k: 'amount' },
                { icon: Calendar, k: 'when' },
                { icon: X, k: 'stop' },
                { icon: AlertTriangle, k: 'short' },
                { icon: ShieldCheck, k: 'privacy' },
              ].map(({ icon: Icon, k }) => (
                <div key={k} className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-dp-surface-container-low flex items-center justify-center shrink-0 mt-0.5">
                    <Icon size={16} className="text-dp-secondary" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-heading text-[14px] font-bold text-dp-primary mb-1">{t(`pool.how.${k}.q`)}</h3>
                    <p className="font-sans text-[15px] leading-[2] text-dp-on-surface mb-1"
                      style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                      {t(`pool.how.${k}.aUr`)}
                    </p>
                    <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">{t(`pool.how.${k}.a`)}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-dp-outline-variant bg-dp-surface-container-low px-5 py-4 flex items-start gap-2.5">
              <ShieldCheck size={17} className="text-dp-secondary shrink-0 mt-0.5" />
              <div>
                <p className="font-sans text-[15px] leading-[2] text-dp-on-surface font-bold"
                  style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                  {t('pool.promiseUr')}
                </p>
                <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">{t('pool.promise')}</p>
              </div>
            </div>
          </section>
        )}

        {(sponsorCommitments.length > 0 || sponsorAnnouncements.filter((a) => a.status === 'announced').length > 0) && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-3">
            <h3 className="font-heading text-[13.5px] font-bold text-dp-primary mb-2.5">{t('pool.mine')}</h3>
            <div className="space-y-2">
              {sponsorCommitments.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-dp-outline-variant last:border-0 pb-2 last:pb-0">
                  <div>
                    <p className="font-sans text-[13px] font-bold text-dp-on-surface">
                      Rs {fmt(c.monthly_amount)}/{t('pkf.month')}
                      <span className="font-normal text-dp-on-surface-variant"> · {c.named_student ? t('pkf.namedFor').replace('{name}', c.named_student) : t('pkf.sharedGiving')}</span>
                    </p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">
                      {t('pool.givenSoFar').replace('{months}', String(c.months_given)).replace('{total}', fmt(c.total_given))}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button onClick={() => { setChangeAmount(c.monthly_amount); setChangingShare(c) }}
                      className="font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer">{t('pool.changeAmount')}</button>
                    <button onClick={() => stopSponsoring(c)}
                      className="font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer">{t('pool.stopGiving')}</button>
                  </div>
                </div>
              ))}
              {sponsorAnnouncements.filter((a) => a.status === 'announced').map((a) => (
                <div key={a.id} className="border-b border-dp-outline-variant last:border-0 pb-3 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div>
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface">
                        Rs {fmt(a.amount)}
                        <span className="font-normal text-dp-on-surface-variant"> · {a.named_student ? t('pkf.namedFor').replace('{name}', a.named_student) : t('pkf.sharedGiving')}</span>
                      </p>
                      <p className="font-sans text-[11px] text-amber-700 font-semibold">{t('pool.status.announced')} — {t('pool.awaitingConfirmation')}</p>
                    </div>
                    <button onClick={() => withdrawSponsorAnnouncement(a)}
                      className="font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer shrink-0">{t('pool.withdraw')}</button>
                  </div>
                  <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 print:hidden">
                    {a.has_proof ? (
                      <p className="font-sans text-[11.5px] text-dp-secondary font-semibold">{t('pool.proofAttached')}</p>
                    ) : (
                      <Link href="/portal/statement" className="font-sans text-[12px] font-bold text-dp-secondary hover:underline">
                        {t('pool.payOnStatement')}
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Named cards only — one per student, no unnamed "join the shared
            pool" option. A donor picks who they're giving to, the same way
            Kafalat already works, rather than a pool with nobody's face on
            it. */}
        {/* Brought up to the same weight Kafalat's card already has —
            a face (an initial, absent a photo field), how much of this
            student's need is already covered, and what's left — instead
            of a name and an institution with nothing to weigh a decision
            against (migration 285's audit). */}
        {sponsorStudents.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {sponsorStudents.map((s) => {
              const pct = s.awarded_amount > 0 ? Math.min((s.already_named / s.awarded_amount) * 100, 100) : 0
              const remaining = Math.max(s.awarded_amount - s.already_named, 0)
              return (
                <div key={s.student_id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                  <div className="flex items-start gap-2.5 mb-2.5">
                    <div className="w-9 h-9 rounded-full bg-dp-secondary/15 text-dp-secondary flex items-center justify-center font-heading text-[15px] font-bold shrink-0">
                      {s.full_name.trim().charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface leading-tight">{s.full_name}</p>
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant">
                        {[s.institution, s.programme].filter(Boolean).join(' · ')}
                        {s.is_loan && <span className="ms-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold align-middle">{t('pwz.sponsor.loan')}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="h-1.5 w-full bg-dp-surface-container rounded-full overflow-hidden mb-1.5">
                    <div className="h-full bg-dp-secondary" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mb-2.5">
                    {remaining > 0 ? t('pwz.sponsor.remaining').replace('{amt}', fmt(remaining)) : t('pwz.sponsor.fullySponsored')}
                  </p>
                  <button onClick={() => openGive(s)}
                    className="w-full flex items-center justify-center gap-1.5 bg-dp-secondary text-white py-1.5 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    <Heart size={13} /> {s.already_named > 0 ? t('pkf.joinShare') : t('pkf.sponsor')}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      </>
      )}

      {activeTab === 'apply' && (
      <>
      {/* ── One line that speaks to the person, not the process ─────────
          Everything else on this page is status: submitted, screening,
          approved, an amount, a due date. This is the one place that says
          why any of it matters — and it changes with where the student
          actually stands, because the same sentence read every visit stops
          meaning anything by the third time. A due instalment is framed as
          the next student's turn, never as a debt collector's line — the
          whole point of qarz-e-hasana is that repaying it is what lets it
          reach someone else. */}
      {(() => {
        const soonest = dues?.due_soon?.[0]
        const overdueCount = dues?.awards?.reduce((s, a) => s + (a.position?.overdue ?? 0), 0) ?? 0
        const hasActiveAward = (dues?.awards?.length ?? 0) > 0
        const pendingDecision = decisions.find((d) => ['submitted', 'screening', 'interview'].includes(d.status))
        const declinedReapply = decisions.find((d) => d.status === 'declined' && d.can_reapply)

        let mottoUr = '', motto = '', tone = 'bg-dp-primary'
        if (soonest) {
          tone = overdueCount > 0 ? 'bg-amber-700' : 'bg-dp-primary'
          mottoUr = t('pwz.mood.dueUr')
            .replace('{amt}', fmt(soonest.amount)).replace('{date}', new Date(soonest.due_on).toLocaleDateString())
          motto = t('pwz.mood.due')
            .replace('{amt}', fmt(soonest.amount)).replace('{date}', new Date(soonest.due_on).toLocaleDateString())
        } else if (hasActiveAward) {
          mottoUr = t('pwz.mood.activeUr'); motto = t('pwz.mood.active')
        } else if (pendingDecision) {
          mottoUr = t('pwz.mood.pendingUr'); motto = t('pwz.mood.pending')
        } else if (declinedReapply) {
          mottoUr = t('pwz.mood.declinedUr'); motto = t('pwz.mood.declined')
        } else if (!savedId) {
          mottoUr = t('pwz.mood.inviteUr'); motto = t('pwz.mood.invite')
        } else {
          return null
        }

        return (
          <div className={`${tone} text-white rounded-lg px-5 py-4 mb-6 print:hidden`}>
            <p className="font-sans text-[17px] leading-[2] font-bold"
              style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
              {mottoUr}
            </p>
            <p className="font-sans text-[13.5px] leading-relaxed opacity-90 mt-1">{motto}</p>
          </div>
        )
      })()}

      {/* ── What the committee decided ───────────────────────────────── */}
      {decisions.length > 0 && (
        <div className="mb-6 print:hidden">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-3">{t('pwz.myApplications')}</h2>
          <div className="space-y-3">
            {decisions.map((d) => {
              const approved = d.decision === 'approved_full' || d.decision === 'approved_partial'
              return (
                <div key={d.application_id} className={`bg-white border rounded-lg px-4 py-4 ${approved ? 'border-emerald-300' : d.decision === 'declined' ? 'border-dp-outline-variant' : 'border-dp-outline-variant'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                    <div>
                      <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{d.programme}</p>
                      <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                        {d.institution} · {d.academic_year}
                        {d.attempt > 1 && <span className="ms-2">· {t('pwz.attempt')} {d.attempt}</span>}
                      </p>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-[11.5px] font-bold ${STATUS_TONE[d.status] ?? 'bg-slate-100'}`}>
                      {d.decision ? t(`pwz.decision.${d.decision}`) : t(`pwz.status.${d.status}`)}
                    </span>
                  </div>

                  {approved && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-3 mb-2">
                      <p className="font-sans text-[12px] font-semibold text-emerald-900">{t('pwz.awardedAmount')}</p>
                      <p className="font-heading text-[26px] font-bold text-emerald-800 leading-tight">
                        Rs {fmt(d.approved_amount_pkr ?? 0)}
                      </p>
                      {d.as_loan && (
                        <p className="font-sans text-[12px] text-emerald-900 mt-1 font-semibold">{t('pwz.awardIsLoan')}</p>
                      )}
                      {d.decision === 'approved_partial' && d.shortfall_note && (
                        <p className="font-sans text-[12.5px] text-emerald-900 mt-1.5">{d.shortfall_note}</p>
                      )}
                    </div>
                  )}

                  {/* The reason, in Urdu first — it is the part the family
                      will actually read, and the part that tells them what to
                      fix before trying again. */}
                  {(d.reason_ur || d.reason) && (
                    <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3">
                      <p className="font-sans text-[11.5px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-1.5">
                        {t('pwz.committeeSaid')}
                      </p>
                      {d.reason_ur && (
                        <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed"
                          style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                          {d.reason_ur}
                        </p>
                      )}
                      {d.reason && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{d.reason}</p>}
                    </div>
                  )}

                  {d.can_reapply && (
                    <div className="mt-3">
                      <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-2">{t('pwz.canReapply')}</p>
                      <button onClick={() => { setReapplyOf(d); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }) }}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                        <RotateCcw size={14} /> {t('pwz.reapply')}
                      </button>
                    </div>
                  )}

                  {d.decided_on && (
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">
                      {t('pwz.decidedOn')} {new Date(d.decided_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── A loan being repaid ───────────────────────────────────────── */}
      {loans.length > 0 && (
        <div className="mb-6 print:hidden">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-3">{t('pwz.myLoan')}</h2>
          <div className="space-y-2.5">
            {loans.map((l) => (
              <div key={l.award_id} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                  <p className="font-sans text-[13px] text-dp-on-surface-variant">{l.academic_year} · {t('pwz.qarzBadge')}</p>
                  {l.overdue > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold">
                      {l.overdue} {t('pwz.overdue')}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pwz.loanAwarded')}</p>
                    <p className="font-heading text-[19px] font-bold text-dp-primary">Rs {fmt(l.awarded_amount_pkr)}</p>
                  </div>
                  <div>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pwz.loanRepaid')}</p>
                    <p className="font-heading text-[19px] font-bold text-emerald-700">Rs {fmt(l.repaid_pkr)}</p>
                  </div>
                  <div>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pwz.loanOutstanding')}</p>
                    <p className="font-heading text-[19px] font-bold text-dp-primary">Rs {fmt(l.outstanding)}</p>
                  </div>
                </div>
                <div className="h-2 w-full bg-dp-surface-container rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-600"
                    style={{ width: `${Math.min((l.repaid_pkr / Math.max(l.awarded_amount_pkr, 1)) * 100, 100)}%` }} />
                </div>
                {l.next_due_on && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-2">
                    {t('pwz.nextDue')} {new Date(l.next_due_on).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </p>
                )}
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('pwz.loanNoInterest')}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── The agreement — waiting for a signature, or already signed ──
          The one step between "the committee decided" and "the monthly
          instalment actually starts." Nothing here is editable — the terms
          were fixed when the committee sent it (migration 269). */}
      {agreements.length > 0 && (
        <div className="mb-6 print:hidden">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-3">{t('pwz.ag.heading')}</h2>
          <div className="space-y-3">
            {agreements.map((ag) => (
              <div key={ag.agreement_id}
                className={`bg-white border rounded-lg px-4 py-4 ${ag.status === 'pending' ? 'border-amber-300' : 'border-emerald-300'}`}>
                <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{ag.academic_year}</p>
                  <span className={`px-2.5 py-1 rounded-full text-[11.5px] font-bold ${
                    ag.status === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}>
                    {ag.status === 'pending' ? t('pwz.ag.awaiting') : t('pwz.ag.signedBadge')}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pwz.ag.monthly')}</p>
                    <p className="font-heading text-[19px] font-bold text-dp-primary">Rs {fmt(ag.monthly_amount_pkr)}</p>
                  </div>
                  <div>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pwz.ag.dueDay')}</p>
                    <p className="font-heading text-[19px] font-bold text-dp-primary">{ag.due_day}</p>
                  </div>
                </div>
                {ag.status === 'pending' ? (
                  <button onClick={() => { setSigning(ag); setSignForm({ father_name: '', father_cnic: '', father_phone: '',
                      witness1_name: '', witness1_cnic: '', witness1_phone: '', witness2_name: '', witness2_cnic: '', witness2_phone: '', document_url: '' }) }}
                    className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    <UserCheck size={15} /> {t('pwz.ag.reviewAndSign')}
                  </button>
                ) : (
                  <p className="font-sans text-[12px] text-dp-on-surface-variant">
                    {t('pwz.ag.signedBy')} {ag.student_signed_name}
                    {ag.student_signed_at ? ` · ${new Date(ag.student_signed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}
                    {!ag.installment_active && ` · ${t('pwz.ag.waitingActivation')}`}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── The statement — every debit and credit on his own account,
          the same copy of the ledger a donor accountant would have of
          him (migration 271). Read-only, printable, nothing to act on. */}
      {statement?.has_account && (
        <div className="mb-6 print:hidden">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('pwz.stmt.heading')}</h2>
            <p className="font-sans text-[13px] font-semibold text-dp-on-surface-variant">
              {t('pwz.stmt.balance')}: <span className="text-dp-primary font-bold">Rs {fmt(statement.balance)}</span>
            </p>
          </div>
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-x-auto">
            {statement.entries.length === 0 ? (
              <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('pwz.stmt.empty')}</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-dp-outline-variant bg-dp-surface-container-low">
                    <th className="text-start font-sans font-bold text-dp-on-surface-variant px-4 py-2.5 text-[11.5px] uppercase tracking-[0.04em]">{t('pwz.stmt.date')}</th>
                    <th className="text-start font-sans font-bold text-dp-on-surface-variant px-4 py-2.5 text-[11.5px] uppercase tracking-[0.04em]">{t('pwz.stmt.particular')}</th>
                    <th className="text-end font-sans font-bold text-dp-on-surface-variant px-4 py-2.5 text-[11.5px] uppercase tracking-[0.04em]">{t('pwz.stmt.debit')}</th>
                    <th className="text-end font-sans font-bold text-dp-on-surface-variant px-4 py-2.5 text-[11.5px] uppercase tracking-[0.04em]">{t('pwz.stmt.credit')}</th>
                    <th className="text-end font-sans font-bold text-dp-on-surface-variant px-4 py-2.5 text-[11.5px] uppercase tracking-[0.04em]">{t('pwz.stmt.balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.entries.map((e, i) => (
                    <tr key={i} className="border-b border-dp-outline-variant last:border-b-0">
                      <td className="px-4 py-2.5 text-dp-on-surface-variant whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(e.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </td>
                      <td className="px-4 py-2.5 text-dp-on-surface">{e.particular}</td>
                      <td className="px-4 py-2.5 text-end text-dp-on-surface" style={{ fontVariantNumeric: 'tabular-nums' }}>{e.debit > 0 ? fmt(e.debit) : ''}</td>
                      <td className="px-4 py-2.5 text-end text-emerald-700" style={{ fontVariantNumeric: 'tabular-nums' }}>{e.credit > 0 ? fmt(e.credit) : ''}</td>
                      <td className="px-4 py-2.5 text-end font-semibold text-dp-on-surface" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Reapplying: say so at the top of the form, so nobody fills in a
          second application without realising it is a second application. */}
      {reapplyOf && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-dp-secondary/10 border border-dp-secondary/30 rounded-lg px-4 py-3 mb-4 print:hidden">
          <p className="font-sans text-[13px] font-semibold text-dp-primary">
            {t('pwz.reapplyingFor')} {reapplyOf.programme} · {t('pwz.attempt')} {(reapplyOf.attempt ?? 1) + 1}
          </p>
          <button onClick={() => setReapplyOf(null)}
            className="font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">
            {t('action.cancel')}
          </button>
        </div>
      )}

      {/* ── The application already on file ────────────────────────────
          Shown before the form, because somebody coming back wants to know
          where their application stands — not a blank eleven-section form. */}
      {/* My Application now lives once, at the top of the page — see above. */}

      {/* ══════ The form itself — this whole block is what prints ══════ */}
      <div ref={formRef} className={showForm ? '' : 'hidden print:block'}>
        {/* A way back out, from the top, before anyone has to scroll past
            eleven sections to find it. */}
        {showForm && (
          <div className="print:hidden flex items-center justify-between bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-2.5 mb-4 sticky top-0 z-10">
            <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface-variant">
              {savedId ? t('pwz.savedTitle') : t('pwz.startApplication')}
            </p>
            <button onClick={closeForm} type="button"
              className="flex items-center gap-1.5 font-sans text-[12.5px] font-bold text-dp-on-surface hover:text-dp-primary cursor-pointer">
              {t('pwz.close')} <X size={16} />
            </button>
          </div>
        )}
        <div className="hidden print:block mb-4">
          <h2 className="font-heading text-[22px] font-bold">{t('pwz.printHeading')}</h2>
          <p className="font-sans text-[12px]">{t('pwz.printSubheading')}</p>
        </div>

        {/* ── Whose application this is ──────────────────────────────────
            The student applies for themselves, from their own account. A
            father applying for his son leaves the son with no way to see what
            he owes, no reminder when an instalment falls due, and no record he
            can carry to the next committee — while the father keeps getting
            alerts about somebody else's education. The account has to belong
            to the person the money follows. */}
        <div className={section}>
          <StepHead n={1} title={t('pwz.s.whoFor')} urdu={t('pwz.whoForUrdu')} help={t('pwz.whoForEnglish')} />

          <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3.5">
            <UserCheck size={17} className="text-dp-secondary shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-sans text-[15px] leading-[2] text-dp-on-surface font-bold"
                style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                {t('pwz.selfOnlyUr')}
              </p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed mt-1">
                {t('pwz.selfOnly')}
              </p>
              <p className="font-sans text-[12.5px] text-dp-on-surface mt-2">
                <span className="font-semibold">{t('pwz.applyingAs')}</span>{' '}
                {portalUser?.full_name ?? '—'}
                {portalUser?.mobile ? ` · ${portalUser.mobile}` : ''}
              </p>
            </div>
          </div>
        </div>

        {/* ── The student ───────────────────────────────────────────────── */}
        <div className={section}>
          <StepHead n={2} title={t('pwz.s.student')} help={t('pwz.s.studentHelp')} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className={label}>{t('pwz.f.studentFullName')}</label>
              <input value={form.student_full_name} onChange={(e) => setForm({ ...form, student_full_name: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('nr.f.fatherHusband')}</label>
              <input value={form.father_name} onChange={(e) => setForm({ ...form, father_name: e.target.value })} className="input-field" />
            </div>
          </div>

          {/* Both parents' names, so a household already on the zakat
              register can be matched at screening (migration 275) — that
              register is kept by household head, not always the father. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className={label}>{t('pwz.f.motherName')}</label>
              <input value={form.mother_name} onChange={(e) => setForm({ ...form, mother_name: e.target.value })} className="input-field" />
            </div>
          </div>

          {/* The verification sheet asks a committee member to confirm the
              CNIC "matches the form". Until now there was nothing on the form
              to match it against. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <div>
              <label className={label}>{t('pwz.f.cnic')}</label>
              <input value={form.declared_cnic} onChange={(e) => setForm({ ...form, declared_cnic: e.target.value })}
                placeholder="37301-1234567-8" className="input-field" />
            </div>
            <div>
              <label className={label}>{t('pwz.f.bForm')}</label>
              <input value={form.declared_b_form_no} onChange={(e) => setForm({ ...form, declared_b_form_no: e.target.value })} className="input-field" />
              <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('pwz.f.bFormHint')}</p>
            </div>
            <div>
              <label className={label}>{t('kf.f.dob')}</label>
              <input type="date" value={form.declared_dob} onChange={(e) => setForm({ ...form, declared_dob: e.target.value })} className="input-field" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className={label}>{t('g.nameUrdu')}</label>
              <input value={form.student_full_name_ur} onChange={(e) => setForm({ ...form, student_full_name_ur: e.target.value })}
                className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
            </div>
            <div>
              <label className={label}>{t('nr.f.address')}</label>
              <input value={form.declared_address} onChange={(e) => setForm({ ...form, declared_address: e.target.value })} className="input-field" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className={label}>{t('kf.f.gender')}</label>
              <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input-field">
                <option value="male">{t('kf.boy')}</option>
                <option value="female">{t('kf.girl')}</option>
              </select>
            </div>
            <div>
              <label className={label}>{t('a.phone')}</label>
              <input value={form.student_phone} onChange={(e) => setForm({ ...form, student_phone: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('pwz.f.fatherAlive')}</label>
              <select value={form.father_alive ? 'yes' : 'no'} onChange={(e) => setForm({ ...form, father_alive: e.target.value === 'yes' })} className="input-field">
                <option value="yes">{t('pwz.yes')}</option>
                <option value="no">{t('pwz.f.fatherDeceased')}</option>
              </select>
            </div>
            <div>
              <label className={label}>{t('pwz.f.houseOwned')}</label>
              <select value={form.house_owned ? 'yes' : 'no'} onChange={(e) => setForm({ ...form, house_owned: e.target.value === 'yes' })} className="input-field">
                <option value="yes">{t('pwz.f.ownHouse')}</option>
                <option value="no">{t('pwz.f.rentedHouse')}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            <div>
              <label className={label}>{t('pwz.f.fatherOccupation')}</label>
              <input value={form.father_occupation} onChange={(e) => setForm({ ...form, father_occupation: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('pwz.f.motherOccupation')}</label>
              <input value={form.mother_occupation} onChange={(e) => setForm({ ...form, mother_occupation: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('pwz.f.landKanal')}</label>
              <input type="number" min={0} step="0.5" value={form.land_owned_kanal || ''}
                onChange={(e) => setForm({ ...form, land_owned_kanal: +e.target.value })} className="input-field" />
            </div>
          </div>
        </div>

        {/* ── The household, person by person ───────────────────────────── */}
        <div className={section}>
          <StepHead n={3} title={t('pwz.s.family')} urdu={t('pwz.familyUrdu')} help={t('pwz.familyEnglish')} />

          <div className="space-y-3">
            {family.map((f, i) => (
              <div key={i} className="border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline">
                    {t('pwz.person')} {i + 1}
                  </span>
                  {family.length > 1 && (
                    <button onClick={() => setFamily(family.filter((_, x) => x !== i))}
                      className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer print:hidden">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-2.5">
                  <div className="col-span-2">
                    <label className={label}>{t('a.name')}</label>
                    <input value={f.full_name} onChange={(e) => setFamilyRow(i, { full_name: e.target.value })} className="input-field !py-2" />
                  </div>
                  <div>
                    <label className={label}>{t('pwz.f.relation')}</label>
                    <select value={f.relation} onChange={(e) => setFamilyRow(i, { relation: e.target.value })} className="input-field !py-2">
                      {RELATIONS.map((r) => <option key={r} value={r}>{t(`es.rel.${r}`)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={label}>{t('pwz.f.age')}</label>
                    <input type="number" min={0} value={f.age || ''} onChange={(e) => setFamilyRow(i, { age: +e.target.value })} className="input-field !py-2" />
                  </div>
                </div>

                <div className="mb-2.5">
                  <label className={label}>{t('pwz.f.maritalStatus')}</label>
                  <select value={f.marital_status} onChange={(e) => setFamilyRow(i, { marital_status: e.target.value })} className="input-field !py-2">
                    {['single', 'married', 'widowed', 'divorced'].map((m) => (
                      <option key={m} value={m}>{t(`pwz.marital.${m}`)}</option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2 cursor-pointer font-sans text-[13px] mb-2">
                  <input type="checkbox" checked={f.is_studying} onChange={(e) => setFamilyRow(i, { is_studying: e.target.checked })} className="accent-dp-secondary" />
                  {t('pwz.f.isStudying')}
                </label>
                {f.is_studying && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-2.5 ps-6">
                    <div className="col-span-2">
                      <label className={label}>{t('pwz.f.schoolName')}</label>
                      <input value={f.institution} onChange={(e) => setFamilyRow(i, { institution: e.target.value })} className="input-field !py-2" />
                    </div>
                    <div>
                      <label className={label}>{t('pwz.f.classYear')}</label>
                      <input value={f.class_or_year} onChange={(e) => setFamilyRow(i, { class_or_year: e.target.value })} className="input-field !py-2" />
                    </div>
                    <div>
                      <label className={label}>{t('kf.f.schoolLocation')}</label>
                      <select value={f.study_location} onChange={(e) => setFamilyRow(i, { study_location: e.target.value })} className="input-field !py-2">
                        <option value="village">{t('kf.loc.village')}</option>
                        <option value="chakwal">{t('kf.loc.chakwal')}</option>
                        <option value="other">{t('kf.loc.other')}</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className={label}>{t('pwz.f.annualFee')}</label>
                      <input type="number" min={0} value={f.annual_fee_pkr || ''}
                        onChange={(e) => setFamilyRow(i, { annual_fee_pkr: +e.target.value })} className="input-field !py-2" />
                    </div>
                  </div>
                )}

                <label className="flex items-center gap-2 cursor-pointer font-sans text-[13px] mb-2">
                  <input type="checkbox" checked={f.is_working} onChange={(e) => setFamilyRow(i, { is_working: e.target.checked })} className="accent-dp-secondary" />
                  {t('pwz.f.isWorking')}
                </label>
                {f.is_working && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 ps-6">
                    <div>
                      <label className={label}>{t('pwz.f.occupation')}</label>
                      <input value={f.occupation} onChange={(e) => setFamilyRow(i, { occupation: e.target.value })} className="input-field !py-2" />
                    </div>
                    <div>
                      <label className={label}>{t('pwz.f.incomePeriod')}</label>
                      <select value={f.income_period} onChange={(e) => setFamilyRow(i, { income_period: e.target.value })} className="input-field !py-2">
                        <option value="daily">{t('pwz.period.daily')}</option>
                        <option value="weekly">{t('pwz.period.weekly')}</option>
                        <option value="monthly">{t('pwz.period.monthly')}</option>
                      </select>
                    </div>
                    <div>
                      <label className={label}>{t('pwz.f.incomeAmount')}</label>
                      <input type="number" min={0} value={f.income_pkr || ''}
                        onChange={(e) => setFamilyRow(i, { income_pkr: +e.target.value })} className="input-field !py-2" />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <button onClick={() => setFamily([...family, { ...emptyFamilyRow }])}
            className="mt-3 flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer print:hidden">
            <Plus size={15} /> {t('pwz.addPerson')}
          </button>

          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 bg-dp-surface-container-low rounded-lg px-4 py-3">
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pwz.totalMonthlyIncome')}</p>
              <p className="font-heading text-[19px] font-bold text-dp-primary">Rs {fmt(monthlyIncome)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pwz.familyEducationCost')}</p>
              <p className="font-heading text-[19px] font-bold text-dp-primary">Rs {fmt(familyEducationCost)}</p>
            </div>
          </div>
        </div>

        {/* ── Joint income ─────────────────────────────────────────────── */}
        <div className={section}>
          <StepHead n={4} title={t('pwz.s.business')} urdu={t('pwz.businessUrdu')} help={t('pwz.businessEnglish')} />

          <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px] mb-3">
            <input type="checkbox" checked={form.has_family_business}
              onChange={(e) => setForm({ ...form, has_family_business: e.target.checked })} className="accent-dp-secondary" />
            {t('pwz.f.hasBusiness')}
          </label>

          {form.has_family_business && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className={label}>{t('pwz.f.businessKind')}</label>
                  <input value={form.family_business_kind}
                    onChange={(e) => setForm({ ...form, family_business_kind: e.target.value })}
                    placeholder={t('pwz.f.businessPlaceholder')} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('pwz.f.businessShare')}</label>
                  <input type="number" min={0} value={form.family_business_share_pkr || ''}
                    onChange={(e) => setForm({ ...form, family_business_share_pkr: +e.target.value })} className="input-field" />
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pwz.f.businessShareHint')}</p>
                </div>
              </div>
              <div>
                <label className={label}>{t('pwz.f.businessNote')}</label>
                <textarea value={form.family_business_note}
                  onChange={(e) => setForm({ ...form, family_business_note: e.target.value })}
                  rows={2} className="input-field resize-none" />
              </div>
            </>
          )}
        </div>

        {/* ── Illness in the house ──────────────────────────────────────── */}
        <div className={section}>
          <StepHead n={5} title={t('pwz.s.health')} urdu={t('pwz.healthUrdu')} help={t('pwz.healthEnglish')} />

          <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px] mb-3">
            <input type="checkbox" checked={form.has_long_term_patient}
              onChange={(e) => setForm({ ...form, has_long_term_patient: e.target.checked })} className="accent-dp-secondary" />
            {t('pwz.f.hasPatient')}
          </label>

          {form.has_long_term_patient && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={label}>{t('pwz.f.patientRelation')}</label>
                <input value={form.patient_relation} onChange={(e) => setForm({ ...form, patient_relation: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.illness')}</label>
                <input value={form.patient_illness} onChange={(e) => setForm({ ...form, patient_illness: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.medicineCost')}</label>
                <input type="number" min={0} value={form.patient_monthly_cost_pkr || ''}
                  onChange={(e) => setForm({ ...form, patient_monthly_cost_pkr: +e.target.value })} className="input-field" />
              </div>
            </div>
          )}
        </div>

        {/* ── Help already being received ───────────────────────────────── */}
        <div className={section}>
          <StepHead n={6} title={t('pwz.s.zakat')} urdu={t('pwz.zakatUrdu')} help={t('pwz.zakatEnglish')} />

          <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px] mb-3">
            <input type="checkbox" checked={form.family_receives_zakat}
              onChange={(e) => setForm({ ...form, family_receives_zakat: e.target.checked })} className="accent-dp-secondary" />
            {t('pwz.f.receivesZakat')}
          </label>

          {form.family_receives_zakat && (
            <>
              <label className={label}>{t('pwz.f.zakatFrom')}</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                {(['committee', 'government', 'mosque', 'other'] as const).map((src) => (
                  <label key={src} className="flex items-center gap-2 cursor-pointer font-sans text-[13px]">
                    <input type="checkbox" checked={form.zakat_sources.includes(src)}
                      onChange={(e) => setForm({
                        ...form,
                        zakat_sources: e.target.checked
                          ? [...form.zakat_sources, src]
                          : form.zakat_sources.filter((x) => x !== src),
                      })}
                      className="accent-dp-secondary" />
                    {t(`pwz.zsrc.${src}`)}
                  </label>
                ))}
              </div>
              <div className="max-w-xs">
                <label className={label}>{t('pwz.f.zakatMonthly')}</label>
                <input type="number" min={0} value={form.zakat_monthly_pkr || ''}
                  onChange={(e) => setForm({ ...form, zakat_monthly_pkr: +e.target.value })} className="input-field" />
              </div>
            </>
          )}
        </div>

        {/* ── Academic record ───────────────────────────────────────────── */}
        <div className={section}>
          <StepHead n={7} title={t('pwz.s.academics')} help={t('pwz.academicsHelp')} />

          <div className="space-y-3">
            {academics.map((a, i) => {
              const pct = a.total_marks > 0 ? Math.round((a.obtained_marks / a.total_marks) * 1000) / 10 : 0
              return (
                <div key={i} className="border border-dp-outline-variant rounded-lg p-3.5">
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 items-end">
                    <div>
                      <label className={label}>{t('pwz.f.exam')}</label>
                      <select value={a.exam} onChange={(e) => setAcademicRow(i, { exam: e.target.value })} className="input-field !py-2">
                        {EXAMS.map((e2) => <option key={e2} value={e2}>{t(`pwz.exam.${e2}`)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={label}>{t('pwz.f.board')}</label>
                      <input value={a.board_university} onChange={(e) => setAcademicRow(i, { board_university: e.target.value })} className="input-field !py-2" />
                    </div>
                    <div>
                      <label className={label}>{t('pwz.f.year')}</label>
                      <input type="number" value={a.passing_year || ''} onChange={(e) => setAcademicRow(i, { passing_year: +e.target.value })} className="input-field !py-2" />
                    </div>
                    <div>
                      <label className={label}>{t('pwz.f.obtained')}</label>
                      <input type="number" min={0} value={a.obtained_marks || ''} onChange={(e) => setAcademicRow(i, { obtained_marks: +e.target.value })} className="input-field !py-2" />
                    </div>
                    <div>
                      <label className={label}>{t('pwz.f.total')}</label>
                      <input type="number" min={0} value={a.total_marks || ''} onChange={(e) => setAcademicRow(i, { total_marks: +e.target.value })} className="input-field !py-2" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="font-sans text-[13px] font-semibold text-dp-secondary">{pct > 0 ? `${pct}%` : ''}</span>
                    {academics.length > 1 && (
                      <button onClick={() => setAcademics(academics.filter((_, x) => x !== i))}
                        className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer print:hidden">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <button onClick={() => setAcademics([...academics, { ...emptyAcademicRow }])}
            className="mt-3 flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer print:hidden">
            <Plus size={15} /> {t('pwz.addExam')}
          </button>
        </div>

        {/* ── What they want to study ───────────────────────────────────── */}
        <div className={section}>
          <StepHead n={8} title={t('pwz.s.study')} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className={label}>{t('wz.f.level')}</label>
              <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} className="input-field">
                {LEVELS.map((l) => <option key={l} value={l}>{t(`wz.level.${l}`)}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>{t('wz.f.programme')}</label>
              <input value={form.programme} onChange={(e) => setForm({ ...form, programme: e.target.value })}
                placeholder={t('pwz.f.programmePlaceholder')} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('wz.f.institution')}</label>
              <input value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('wz.f.city')}</label>
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="input-field" />
            </div>
          </div>

          {/* Enough for the committee to pay the institute directly, and
              enough to call and ask if he is still there — the same
              details power both (migration 274). */}
          <div className="border border-dp-outline-variant rounded-lg p-3.5 mb-3">
            <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2.5">{t('pwz.f.instituteDetails')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <div>
                <label className={label}>{t('pwz.f.institutePhone')}</label>
                <input value={form.institute_phone} onChange={(e) => setForm({ ...form, institute_phone: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.instituteRegNo')}</label>
                <input value={form.institute_registration_no} onChange={(e) => setForm({ ...form, institute_registration_no: e.target.value })} className="input-field" />
              </div>
            </div>
            <div className="mb-3">
              <label className={label}>{t('pwz.f.instituteAddress')}</label>
              <input value={form.institute_address} onChange={(e) => setForm({ ...form, institute_address: e.target.value })} className="input-field" />
            </div>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2">{t('pwz.f.instituteBankHint')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={label}>{t('pwz.f.bankAccountTitle')}</label>
                <input value={form.institute_bank_account_title} onChange={(e) => setForm({ ...form, institute_bank_account_title: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.bankAccountNo')}</label>
                <input value={form.institute_bank_account_no} onChange={(e) => setForm({ ...form, institute_bank_account_no: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.paymentNumber')}</label>
                <input value={form.institute_payment_number} onChange={(e) => setForm({ ...form, institute_payment_number: e.target.value })} className="input-field" />
              </div>
            </div>
          </div>

          {/* Hostel details — only asked when it applies. */}
          <label className="flex items-center gap-2 cursor-pointer font-sans text-[13px] font-semibold text-dp-on-surface mb-3">
            <input type="checkbox" checked={form.is_in_hostel}
              onChange={(e) => setForm({ ...form, is_in_hostel: e.target.checked })} className="accent-dp-secondary" />
            {t('pwz.f.isInHostel')}
          </label>
          {form.is_in_hostel && (
            <div className="border border-dp-outline-variant rounded-lg p-3.5 mb-3">
              <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2.5">{t('pwz.f.hostelDetails')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <div>
                  <label className={label}>{t('pwz.f.hostelName')}</label>
                  <input value={form.hostel_name} onChange={(e) => setForm({ ...form, hostel_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('pwz.f.hostelRoomNo')}</label>
                  <input value={form.hostel_room_no} onChange={(e) => setForm({ ...form, hostel_room_no: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('pwz.f.hostelPhone')}</label>
                  <input value={form.hostel_phone} onChange={(e) => setForm({ ...form, hostel_phone: e.target.value })} className="input-field" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className={label}>{t('pwz.f.hostelCharges')}</label>
                  <input type="number" min={0} value={form.hostel_monthly_charges_pkr || ''}
                    onChange={(e) => setForm({ ...form, hostel_monthly_charges_pkr: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('pwz.f.hostelBeneficiary')}</label>
                  <input value={form.hostel_beneficiary_name} onChange={(e) => setForm({ ...form, hostel_beneficiary_name: e.target.value })} className="input-field" />
                </div>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2">{t('pwz.f.instituteBankHint')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className={label}>{t('pwz.f.bankAccountTitle')}</label>
                  <input value={form.hostel_bank_account_title} onChange={(e) => setForm({ ...form, hostel_bank_account_title: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('pwz.f.bankAccountNo')}</label>
                  <input value={form.hostel_bank_account_no} onChange={(e) => setForm({ ...form, hostel_bank_account_no: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('pwz.f.paymentNumber')}</label>
                  <input value={form.hostel_payment_number} onChange={(e) => setForm({ ...form, hostel_payment_number: e.target.value })} className="input-field" />
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>{t('pwz.f.admissionStatus')}</label>
              <select value={form.admission_status} onChange={(e) => setForm({ ...form, admission_status: e.target.value })} className="input-field">
                <option value="seeking">{t('pwz.adm.seeking')}</option>
                <option value="admitted">{t('pwz.adm.admitted')}</option>
                <option value="enrolled">{t('pwz.adm.enrolled')}</option>
                <option value="deferred">{t('pwz.adm.deferred')}</option>
              </select>
            </div>
            <div>
              <label className={label}>{t('wz.f.requested')}</label>
              <input type="number" min={0} value={form.requested_amount_pkr || ''}
                onChange={(e) => setForm({ ...form, requested_amount_pkr: +e.target.value })} className="input-field" />
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pwz.f.requestedHint')}</p>
            </div>
            <div>
              <label className={label}>{t('pwz.f.actualCourseCost')}</label>
              <input type="number" min={0} value={form.actual_course_cost_pkr || ''}
                onChange={(e) => setForm({ ...form, actual_course_cost_pkr: +e.target.value })} className="input-field" />
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pwz.f.actualCourseCostHint')}</p>
            </div>
            <div>
              <label className={label}>{t('pwz.f.courseStart')}</label>
              <input type="date" value={form.course_start_date}
                onChange={(e) => setForm({ ...form, course_start_date: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('pwz.f.courseEnd')}</label>
              <input type="date" value={form.course_end_date}
                onChange={(e) => setForm({ ...form, course_end_date: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className={label}>{t('pwz.f.admissionFee')}</label>
              <input type="number" min={0} value={form.admission_fee_pkr || ''}
                onChange={(e) => setForm({ ...form, admission_fee_pkr: +e.target.value })} className="input-field" />
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pwz.f.admissionFeeHint')}</p>
            </div>
          </div>

          {/* ── The monthly cost, and how the committee stays satisfied the
              student is still enrolled — the committee pays this in full,
              every month, direct to the institution or the student;
              nothing comes back the other way until the course is over.
              Seriousness is checked with a monthly phone call (the same
              check-in log the admin "Verify" action already keeps, with
              every number on file), not a co-payment — that check-in and
              the actual repayment afterward are what replace the old
              "pay a share while studying" idea this box used to ask for. */}
          <div className="mt-4 border-2 border-dp-secondary/40 bg-dp-secondary/5 rounded-lg p-4">
            <p className="font-sans text-[14px] font-bold text-dp-on-surface mb-1">{t('pwz.s.share')}</p>
            <p className="font-sans text-[13px] text-dp-on-surface leading-relaxed mb-1"
              style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
              {t('pwz.shareUrdu')}
            </p>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3 leading-relaxed">{t('pwz.shareEnglish')}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={label}>{t('pwz.f.instituteMonthlyFee')}</label>
                <input type="number" min={0} value={form.institution_monthly_fee_pkr || ''}
                  onChange={(e) => setForm({ ...form, institution_monthly_fee_pkr: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.transportMonthly')}</label>
                <input type="number" min={0} value={form.transport_monthly_cost_pkr || ''}
                  onChange={(e) => setForm({ ...form, transport_monthly_cost_pkr: +e.target.value })} className="input-field" />
              </div>
            </div>

            {/* What the committee will actually be paying out each month —
                tuition, hostel if applicable, and transport together, in
                full, not a figure with a co-payment subtracted from it. */}
            {(() => {
              const totalMonthly = form.institution_monthly_fee_pkr
                + (form.is_in_hostel ? form.hostel_monthly_charges_pkr : 0)
                + form.transport_monthly_cost_pkr
              return totalMonthly > 0 ? (
                <div className="mt-3 bg-white rounded-lg px-3.5 py-2.5 space-y-1">
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                    {t('pwz.f.realMonthlyCost')} <strong className="text-dp-on-surface">Rs {fmt(totalMonthly)}</strong>
                  </p>
                  <p className="font-sans text-[13px] text-dp-on-surface">
                    {t('pwz.f.committeeWouldPay')} <strong>Rs {fmt(totalMonthly)}</strong>/{t('pkf.month')}
                  </p>
                </div>
              ) : null
            })()}
          </div>

          <div className="hidden">
          </div>

          <div className="mt-3">
            <label className={label}>{t('pwz.f.statement')}</label>
            <textarea value={form.need_statement} onChange={(e) => setForm({ ...form, need_statement: e.target.value })}
              rows={4} placeholder={t('pwz.f.statementPlaceholder')} className="input-field resize-none" />
          </div>

          <div className="mt-3">
            <label className={label}>{t('pwz.f.achievements')}</label>
            <textarea value={form.achievements} onChange={(e) => setForm({ ...form, achievements: e.target.value })}
              rows={2} className="input-field resize-none" />
          </div>
        </div>

        {/* ── Documents ────────────────────────────────────────────────── */}
        <div className={section}>
          <StepHead n={9} title={t('pwz.s.documents')} urdu={t('pwz.documentsUrdu')} help={t('pwz.documentsEnglish')} />

          <div className="space-y-3">
            {docs.map((d, i) => (
              <div key={i} className="border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <select value={d.kind}
                    onChange={(e) => { const n = [...docs]; n[i] = { ...d, kind: e.target.value }; setDocs(n) }}
                    className="input-field !py-2 max-w-[260px]">
                    {(['cnic', 'b_form', 'matric_dmc', 'fsc_dmc', 'degree', 'admission_letter',
                       'fee_challan', 'income_proof', 'medical', 'other'] as const).map((k) => (
                      <option key={k} value={k}>{t(`pwz.doc.${k}`)}</option>
                    ))}
                  </select>
                  <button onClick={() => setDocs(docs.filter((_, x) => x !== i))}
                    className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer print:hidden">
                    <Trash2 size={14} />
                  </button>
                </div>
                <FileAttachment
                  label={t('pwz.doc.upload')}
                  currentUrl={d.url || undefined}
                  onUpload={(url) => { const n = [...docs]; n[i] = { ...d, url }; setDocs(n) }}
                />
              </div>
            ))}
          </div>

          <button onClick={() => setDocs([...docs, { kind: 'matric_dmc', label: '', url: '' }])}
            className="mt-3 flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer print:hidden">
            <Plus size={15} /> {t('pwz.doc.add')}
          </button>

          {/* Said plainly, because a family without a scanner should not
              think that rules them out. */}
          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-3 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 leading-relaxed">
            {t('pwz.doc.noScannerNote')}
          </p>
        </div>

        {/* ── Qarz-e-Hasana — a notice now, not a signature ─────────────────
            The actual agreement, with the real amount and schedule, only
            exists once the committee has decided — asking for a binding
            signature here meant signing something before the numbers it's
            about even existed. That agreement, with the family's, the
            witnesses', and the student's own signatures, now happens once
            the committee has decided (Phase 2 of this redesign) — this is
            just telling the applicant what to expect. */}
        <div className={section}>
          <StepHead n={10} title={t('pwz.s.qarz')} urdu={t('pwz.qarzUrdu')} help={t('pwz.qarzEnglish')} />
          <div className="flex items-start gap-2.5 px-4 py-3.5 rounded-lg border-2 border-emerald-500 bg-emerald-50">
            <HandCoins size={17} className="text-emerald-700 shrink-0 mt-0.5" />
            <span className="font-sans text-[13px] text-emerald-900 leading-relaxed">{t('pwz.as.loanHelp')}</span>
          </div>
          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-3">{t('pwz.f.repaymentNoPressure')}</p>
        </div>

        {/* ── For office use ────────────────────────────────────────────
            Only ever printed. The committee member fills this in by hand at
            the house, and the same questions in the same order appear on the
            admin screen where the marks are typed back in — so the paper and
            the record cannot drift apart. */}
        <div className="hidden print:block border-2 border-black rounded p-4 mb-4" style={{ breakInside: 'avoid' }}>
          <h2 className="font-heading text-[17px] font-bold mb-1">{t('pwz.v.printTitle')}</h2>
          <p className="font-sans text-[11px] mb-3">{t('pwz.v.printSubtitle')}</p>

          <table className="w-full border-collapse text-[11.5px] font-sans">
            <thead>
              <tr>
                <th className="border border-black p-1.5 text-start w-[46%]">{t('pwz.v.checkItem')}</th>
                <th className="border border-black p-1.5 w-[9%]">{t('pwz.v.yes')}</th>
                <th className="border border-black p-1.5 w-[9%]">{t('pwz.v.no')}</th>
                <th className="border border-black p-1.5 w-[9%]">{t('pwz.v.na')}</th>
                <th className="border border-black p-1.5 text-start">{t('pwz.v.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {([
                'cnic', 'documents', 'marks', 'admission', 'challan',
                'home', 'household', 'income', 'siblings', 'illness', 'zakat',
              ] as const).map((k) => (
                <tr key={k}>
                  <td className="border border-black p-1.5">{t(`pwz.v.item.${k}`)}</td>
                  <td className="border border-black p-1.5 h-7" />
                  <td className="border border-black p-1.5" />
                  <td className="border border-black p-1.5" />
                  <td className="border border-black p-1.5" />
                </tr>
              ))}
            </tbody>
          </table>

          {/* The three numbers a verifier is expected to come back with. */}
          <div className="grid grid-cols-3 gap-3 mt-3">
            {(['obtainedMarks', 'totalMarks', 'grade'] as const).map((k) => (
              <div key={k}>
                <p className="font-sans text-[11px] mb-1">{t(`pwz.v.${k}`)}</p>
                <div className="border-b border-black h-6" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            {(['observedIncome', 'verifiedCost'] as const).map((k) => (
              <div key={k}>
                <p className="font-sans text-[11px] mb-1">{t(`pwz.v.${k}`)}</p>
                <div className="border-b border-black h-6" />
              </div>
            ))}
          </div>

          <p className="font-sans text-[11px] mt-3 mb-1">{t('pwz.v.recommendation')}</p>
          <div className="flex gap-4 font-sans text-[11.5px]">
            {(['full', 'partial', 'decline', 'defer'] as const).map((k) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="inline-block w-3.5 h-3.5 border border-black" /> {t(`pwz.v.rec.${k}`)}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <p className="font-sans text-[11px] mb-1">{t('pwz.v.recommendedAmount')}</p>
              <div className="border-b border-black h-6" />
            </div>
            <div>
              <p className="font-sans text-[11px] mb-1">{t('pwz.v.relationship')}</p>
              <div className="border-b border-black h-6" />
            </div>
          </div>

          <p className="font-sans text-[11px] mt-3 mb-1">{t('pwz.v.notes')}</p>
          <div className="border-b border-black h-6 mb-2" />
          <div className="border-b border-black h-6" />

          {/* Three signature lines, because two or more members go together
              and all sign the same sheet. Only one of them will later type it
              up; the others are named on the screen rather than asked to log
              in and repeat themselves. */}
          <p className="font-sans text-[11px] mt-5 mb-2 font-semibold">{t('pwz.v.signBlock')}</p>
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((n) => (
              <div key={n}>
                <div className="border-b border-black h-7" />
                <p className="font-sans text-[10.5px] mt-1">{t('pwz.v.signVerifier')} {n}</p>
                <div className="border-b border-black h-6 mt-3" />
                <p className="font-sans text-[10.5px] mt-1">{t('pwz.v.printName')}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div>
              <div className="border-b border-black h-6" />
              <p className="font-sans text-[10.5px] mt-1">{t('pwz.v.signDate')}</p>
            </div>
            <div>
              <div className="border-b border-black h-6" />
              <p className="font-sans text-[10.5px] mt-1">{t('pwz.v.enteredBy')}</p>
            </div>
          </div>
        </div>

        {/* ── Declaration, for the printed sheet ────────────────────────── */}
        <div className={`${section} print:break-inside-avoid`}>
          <StepHead n={11} title={t('pwz.s.declaration')} />
          <p className="font-sans text-[13px] text-dp-on-surface leading-relaxed mb-4"
            style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
            {t('pwz.declarationUrdu')}
          </p>
          {/* One line per verifier this committee actually requires
              (wazifa_min_verifiers), not two fixed lines — a village that
              asks for three signatures gets three blank lines to fill in
              by hand, not a single "committee" line standing in for all
              of them. */}
          <div className="grid grid-cols-2 gap-8 mt-8">
            <div>
              <div className="border-b border-dp-outline h-8" />
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{t('pwz.signApplicant')}</p>
            </div>
            {Array.from({ length: Math.max(minVerifiers, 1) }).map((_, i) => (
              <div key={i}>
                <div className="border-b border-dp-outline h-8" />
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                  {t('pwz.signVerifier')} {minVerifiers > 1 ? i + 1 : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {isEditable ? (
        <div className="print:hidden space-y-3">
          {savedStatus === 'submitted' && (
            <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3">
              <Info size={16} className="text-dp-secondary shrink-0 mt-0.5" />
              <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">
                {t('pwz.stillEditable')}
              </p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            {/* Saving without sending, so a form this long can be filled in
                over several sittings instead of one. */}
            <button disabled={busy} onClick={() => submit(true)}
              className="flex-1 flex items-center justify-center gap-2 border-2 border-dp-outline-variant text-dp-primary py-3 rounded-lg font-sans font-semibold hover:border-dp-secondary transition-all cursor-pointer disabled:opacity-50">
              <Save size={16} /> {busy ? t('action.saving') : t('pwz.saveDraft')}
            </button>
            <button disabled={busy} onClick={() => submit(false)}
              className="flex-1 flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Send size={16} /> {busy ? t('action.saving')
                : savedStatus === 'submitted' ? t('pwz.saveChanges') : t('pwz.submit')}
            </button>
          </div>
          <button disabled={busy} onClick={closeForm} type="button"
            className="w-full text-center font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:text-dp-primary cursor-pointer disabled:opacity-50">
            {t('pwz.close')}
          </button>
        </div>
      ) : (
        /* Locked. The reason is spelled out rather than left as a greyed-out
           button, because "why can I not change this?" is the next question
           and a disabled control never answers it. */
        <div className="print:hidden space-y-3">
          <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3.5">
            <Lock size={17} className="text-dp-secondary shrink-0 mt-0.5" />
            <div>
              <p className="font-sans text-[13.5px] font-bold text-dp-primary mb-0.5">
                {t('pwz.lockedTitle')}
              </p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">
                {lockedReason ?? t('pwz.lockedGeneric')} {t('pwz.lockedHelp')}
              </p>
            </div>
          </div>
          <button onClick={closeForm} type="button"
            className="w-full text-center font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:text-dp-primary cursor-pointer">
            {t('pwz.close')}
          </button>
        </div>
      )}
      </>
      )}

      {/* ── Give — named or shared, same form ────────────────────────── */}
      {giving && sponsorPosition && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 print:hidden" onClick={() => setGiving(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">
                {giving.target ? t('pwz.sponsor.giveForTitle') : t('pool.joinTitle')}
              </h2>
              <button onClick={() => setGiving(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            {giving.target && (
              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
                <p className="font-sans text-[15px] font-bold">{giving.target.full_name}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                  {[giving.target.institution, giving.target.programme].filter(Boolean).join(' · ')}
                </p>
              </div>
            )}

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pool.monthlyAmount')}</label>
            <input type="number" min={sponsorPosition.min_share} value={giveForm.amount || ''}
              onChange={(e) => setGiveForm({ ...giveForm, amount: +e.target.value })} className="input-field mb-1" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">
              {t('pool.minimumIs').replace('{amt}', fmt(sponsorPosition.min_share))}
            </p>

            <div className="flex gap-2 mb-1">
              {([['recurring', true, 'pool.recurringMonthly'], ['one_time', false, 'pool.oneTime']] as const).map(([key, val, label]) => (
                <button key={key} disabled={!!commitmentFor(giving.target) && val} onClick={() => setGiveForm({ ...giveForm, recurring: val })}
                  className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all ${giveForm.recurring === val ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'} ${commitmentFor(giving.target) && val ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                  {t(label)}
                </button>
              ))}
            </div>
            {commitmentFor(giving.target) ? (
              <p className="font-sans text-[11px] text-dp-on-surface-variant mb-3">{t('pkf.alreadyMonthlyHint')}</p>
            ) : <div className="mb-4" />}

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pool.fundedBy')}</label>
            <select value={giveForm.funded_by} onChange={(e) => setGiveForm({ ...giveForm, funded_by: e.target.value })} className="input-field mb-1.5">
              <option value="sadqa">{t('pool.fundedBy.sadqa')}</option>
              <option value="general">{t('pool.fundedBy.general')}</option>
            </select>
            {/* No reclaimable option here on purpose — a gift into this
                fund is a donation, full stop, the same as Akhuwat and
                every long-running qard-al-hasan fund actually does it
                (migration 286). What the student pays back still funds
                the next student; it just never routes back to one named
                original giver, so there is nothing here to promise a
                donor and later be unable to keep. */}
            <div className="mb-3.5" />

            <label className="flex items-start gap-2 cursor-pointer font-sans text-[12.5px] mb-5">
              <input type="checkbox" checked={giveForm.show_name_publicly}
                onChange={(e) => setGiveForm({ ...giveForm, show_name_publicly: e.target.checked })} className="accent-dp-secondary mt-0.5" />
              <span>{t('pool.showNamePublicly')} <span className="block text-dp-on-surface-variant">{t('pool.showNamePubliclyHint')}</span></span>
            </label>

            <button disabled={busy || giveForm.amount < sponsorPosition.min_share} onClick={submitGive}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Heart size={16} /> {busy ? t('action.saving') : t('pool.confirmAnnounce')}
            </button>
          </div>
        </div>
      )}

      {/* ── Change my standing amount ────────────────────────────────── */}
      {changingShare && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 print:hidden" onClick={() => setChangingShare(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pool.changeTitle')}</h2>
              <button onClick={() => setChangingShare(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <input type="number" min={1} value={changeAmount || ''}
              onChange={(e) => setChangeAmount(+e.target.value)} className="input-field mb-4" />
            <button disabled={busy} onClick={submitChangeShare}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── The witnessed agreement — a real document now, not a typed
          name (migration 293). Print it, get it signed by hand by the
          student, the father/guardian, and two witnesses, attach CNIC
          photocopies, and upload one photo of the whole signed packet.
          A staff member checks it before anything is activated. */}
      {signing && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 print:hidden" onClick={() => setSigning(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{t('pwz.ag.reviewAndSign')}</h2>
              <button onClick={() => setSigning(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4 grid grid-cols-2 gap-3">
              <div>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('pwz.ag.monthly')}</p>
                <p className="font-sans text-[15px] font-bold text-dp-primary">Rs {fmt(signing.monthly_amount_pkr)}</p>
              </div>
              <div>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('pwz.ag.dueDay')}</p>
                <p className="font-sans text-[15px] font-bold text-dp-primary">{signing.due_day}</p>
              </div>
            </div>

            {signing.terms_text_ur && (
              <p className="font-sans text-[14.5px] leading-[2] text-dp-on-surface mb-3"
                style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                {signing.terms_text_ur}
              </p>
            )}
            <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed mb-4">{signing.terms_text}</p>

            <button onClick={printForm} type="button"
              className="w-full flex items-center justify-center gap-1.5 border border-dp-outline-variant text-dp-on-surface rounded-lg py-2 font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer mb-4">
              <Printer size={14} /> {t('pwz.ag.printThis')}
            </button>

            <p className="font-sans text-[12px] text-dp-on-surface-variant leading-relaxed mb-4 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
              {t('pwz.ag.witnessedHelp')}
            </p>

            <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2">{t('pwz.ag.fatherSection')}</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <input placeholder={t('pwz.ag.name')} value={signForm.father_name}
                onChange={(e) => setSignForm({ ...signForm, father_name: e.target.value })} className="input-field" />
              <input placeholder={t('pwz.ag.cnic')} value={signForm.father_cnic}
                onChange={(e) => setSignForm({ ...signForm, father_cnic: e.target.value })} className="input-field" />
              <input placeholder={t('pwz.ag.phone')} value={signForm.father_phone}
                onChange={(e) => setSignForm({ ...signForm, father_phone: e.target.value })} className="input-field" />
            </div>

            <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2">{t('pwz.ag.witness1Section')}</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <input placeholder={t('pwz.ag.name')} value={signForm.witness1_name}
                onChange={(e) => setSignForm({ ...signForm, witness1_name: e.target.value })} className="input-field" />
              <input placeholder={t('pwz.ag.cnic')} value={signForm.witness1_cnic}
                onChange={(e) => setSignForm({ ...signForm, witness1_cnic: e.target.value })} className="input-field" />
              <input placeholder={t('pwz.ag.phone')} value={signForm.witness1_phone}
                onChange={(e) => setSignForm({ ...signForm, witness1_phone: e.target.value })} className="input-field" />
            </div>

            <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2">{t('pwz.ag.witness2Section')}</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <input placeholder={t('pwz.ag.name')} value={signForm.witness2_name}
                onChange={(e) => setSignForm({ ...signForm, witness2_name: e.target.value })} className="input-field" />
              <input placeholder={t('pwz.ag.cnic')} value={signForm.witness2_cnic}
                onChange={(e) => setSignForm({ ...signForm, witness2_cnic: e.target.value })} className="input-field" />
              <input placeholder={t('pwz.ag.phone')} value={signForm.witness2_phone}
                onChange={(e) => setSignForm({ ...signForm, witness2_phone: e.target.value })} className="input-field" />
            </div>

            <div className="mb-5">
              <DonationReceiptUpload bucket="wazifa_agreement_documents" label={t('pwz.ag.uploadLabel')}
                onUpload={(path) => setSignForm({ ...signForm, document_url: path })} />
            </div>

            <button disabled={busy || !signForm.document_url || !signForm.father_name.trim() || !signForm.witness1_name.trim() || !signForm.witness2_name.trim()}
              onClick={submitSign}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <UserCheck size={16} /> {busy ? t('action.saving') : t('pwz.ag.signButton')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
