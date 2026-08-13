'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { BookOpen, Send, Plus, Trash2, Printer, HandCoins, RotateCcw } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { printNodeInPopup } from '@/lib/receiptExport'
import { FileAttachment } from '@/components/admin/FileAttachment'

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
  const [reapplyOf, setReapplyOf] = useState<Decision | null>(null)
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState({
    applicant_for: 'self',
    applicant_name: '', applicant_relation: '', applicant_phone: '',
    student_full_name: '', father_name: '', gender: 'male', student_phone: '',
    father_alive: true, father_occupation: '', mother_occupation: '',
    house_owned: true, land_owned_kanal: 0,
    family_monthly_income_pkr: 0,
    has_long_term_patient: false, patient_relation: '', patient_illness: '', patient_monthly_cost_pkr: 0,
    family_receives_zakat: false, zakat_sources: [] as string[], zakat_monthly_pkr: 0,
    level: 'bachelors', institution: '', programme: '', city: '', admission_status: 'seeking',
    requested_amount_pkr: 0, need_statement: '', achievements: '',
    repayment_pledge: false, repayment_note: '',
    requested_as: 'grant',
    has_family_business: false, family_business_kind: '', family_business_share_pkr: 0, family_business_note: '',
    loan_terms_accepted: false, loan_terms_signature: '',
  })
  const [docs, setDocs] = useState<{ kind: string; label: string; url: string }[]>([])
  const [loanTerms, setLoanTerms] = useState({ ur: '', en: '' })
  const [family, setFamily] = useState<FamilyRow[]>([{ ...emptyFamilyRow }])
  const [academics, setAcademics] = useState<AcademicRow[]>([{ ...emptyAcademicRow }])

  const load = useCallback(async () => {
    const [{ data: sum }, { data: dec }, { data: lns }, { data: terms }] = await Promise.all([
      supabase.rpc('public_wazifa_summary'),
      supabase.rpc('my_wazifa_decisions'),
      supabase.rpc('my_wazifa_loans'),
      supabase.from('site_settings').select('key, value')
        .in('key', ['wazifa_loan_terms_ur', 'wazifa_loan_terms_en']),
    ])
    setSummary((sum ?? {}) as Record<string, number>)
    setDecisions((dec ?? []) as Decision[])
    setLoans((lns ?? []) as Loan[])
    const tm = Object.fromEntries(((terms ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]))
    setLoanTerms({ ur: tm.wazifa_loan_terms_ur ?? '', en: tm.wazifa_loan_terms_en ?? '' })
  }, [supabase])

  useEffect(() => { load() }, [load])

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

  const submit = async () => {
    if (!portalUser) { toast.error(t('pwz.err.login')); return }
    if (!form.student_full_name.trim()) { toast.error(t('pwz.err.studentName')); return }
    if (!form.institution.trim() || !form.programme.trim()) { toast.error(t('pwz.err.required')); return }
    if (!form.need_statement.trim()) { toast.error(t('pwz.err.statement')); return }
    // A loan without an accepted agreement is a promise nobody wrote down.
    if (form.requested_as !== 'grant' && !form.loan_terms_accepted) {
      toast.error(t('pwz.err.termsNotAccepted')); return
    }
    if (form.requested_as !== 'grant' && !form.loan_terms_signature.trim()) {
      toast.error(t('pwz.err.signature')); return
    }
    setBusy(true)

    // The student is the subject of the record, not whoever held the pen. A
    // father applying for his son creates the son's record and signs it as
    // the applicant, so next year the son's history is already there.
    const { data: existing } = await supabase.from('wazifa_students')
      .select('id').eq('full_name', form.student_full_name.trim())
      .eq('portal_user_id', portalUser.id).maybeSingle()

    let studentId = existing?.id
    if (!studentId) {
      const { data: created, error } = await supabase.from('wazifa_students').insert({
        full_name: form.student_full_name.trim(),
        father_name: form.father_name || null,
        phone: form.student_phone || portalUser.mobile || null,
        gender: form.gender,
        is_orphan: !form.father_alive,
        household_monthly_income_pkr: monthlyIncome || form.family_monthly_income_pkr,
        siblings_studying: family.filter((f) => f.is_studying).length,
        portal_user_id: portalUser.id,
        status: 'applicant',
      }).select('id').single()
      if (error) { setBusy(false); toast.error(friendlyError(error)); return }
      studentId = created.id
    }

    const year = `${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`
    const { data: app, error: appErr } = await supabase.from('wazifa_applications').insert({
      student_id: studentId, academic_year: year,
      applicant_for: form.applicant_for,
      applicant_name: form.applicant_for === 'self' ? null : (form.applicant_name || portalUser.full_name),
      applicant_relation: form.applicant_for === 'self' ? null : form.applicant_relation,
      applicant_phone: form.applicant_phone || portalUser.mobile || null,
      level: form.level, institution: form.institution.trim(),
      programme: form.programme.trim(), city: form.city || null,
      admission_status: form.admission_status,
      requested_amount_pkr: form.requested_amount_pkr,
      need_statement: form.need_statement.trim(),
      achievements: form.achievements || null,
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
      status: 'submitted',
    }).select('id').single()
    if (appErr) { setBusy(false); toast.error(friendlyError(appErr)); return }

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
    if (familyRows.length > 0) await supabase.from('wazifa_family_members').insert(familyRows)

    const academicRows = academics.filter((a) => a.total_marks > 0 && a.obtained_marks > 0).map((a) => ({
      application_id: app.id, exam: a.exam,
      board_university: a.board_university || null,
      passing_year: a.passing_year || null,
      obtained_marks: a.obtained_marks, total_marks: a.total_marks,
    }))
    if (academicRows.length > 0) await supabase.from('wazifa_academic_records').insert(academicRows)

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
    toast.success(reapplyOf ? t('pwz.ok.reapplied') : t('pwz.ok.submitted'))
    setReapplyOf(null)
    load()
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

      {/* ══════ The form itself — this whole block is what prints ══════ */}
      <div ref={formRef}>
        <div className="hidden print:block mb-4">
          <h2 className="font-heading text-[22px] font-bold">{t('pwz.printHeading')}</h2>
          <p className="font-sans text-[12px]">{t('pwz.printSubheading')}</p>
        </div>

        {/* ── Who is this application for ───────────────────────────────── */}
        <div className={section}>
          <StepHead n={1} title={t('pwz.s.whoFor')} urdu={t('pwz.whoForUrdu')} help={t('pwz.whoForEnglish')} />

          <div className="space-y-2 mb-4">
            {([
              ['self', 'pwz.for.self'],
              ['own_child', 'pwz.for.ownChild'],
              ['other_family', 'pwz.for.otherFamily'],
            ] as const).map(([value, lbl]) => (
              <label key={value} className={`flex items-start gap-2.5 px-3.5 py-3 rounded-lg border-2 cursor-pointer transition-all ${form.applicant_for === value ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant'}`}>
                <input type="radio" name="applicant_for" checked={form.applicant_for === value}
                  onChange={() => setForm({ ...form, applicant_for: value })} className="accent-dp-secondary mt-0.5" />
                <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t(lbl)}</span>
              </label>
            ))}
          </div>

          {form.applicant_for !== 'self' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={label}>{t('pwz.f.applicantName')}</label>
                <input value={form.applicant_name} onChange={(e) => setForm({ ...form, applicant_name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.applicantRelation')}</label>
                <input value={form.applicant_relation} onChange={(e) => setForm({ ...form, applicant_relation: e.target.value })}
                  placeholder={t('pwz.f.applicantRelationPlaceholder')} className="input-field" />
              </div>
              <div>
                <label className={label}>{t('pwz.f.applicantPhone')}</label>
                <input value={form.applicant_phone} onChange={(e) => setForm({ ...form, applicant_phone: e.target.value })} className="input-field" />
              </div>
            </div>
          )}
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

        {/* ── Qarz-e-Hasana ─────────────────────────────────────────────── */}
        <div className={section}>
          <StepHead n={10} title={t('pwz.s.qarz')} urdu={t('pwz.qarzUrdu')} help={t('pwz.qarzEnglish')} />

          {/* A three-way choice rather than a checkbox. Asking "do you want
              this as a gift or as a loan you will return?" out loud is a
              fairer question than a tickbox somebody scrolls past. */}
          <div className="space-y-2.5 mb-4">
            {([
              ['grant', 'pwz.as.grant', 'pwz.as.grantHelp'],
              ['loan', 'pwz.as.loan', 'pwz.as.loanHelp'],
              ['either', 'pwz.as.either', 'pwz.as.eitherHelp'],
            ] as const).map(([value, lbl, help]) => (
              <label key={value}
                className={`flex items-start gap-2.5 px-4 py-3.5 rounded-lg border-2 cursor-pointer transition-all ${form.requested_as === value ? (value === 'grant' ? 'border-dp-secondary bg-dp-secondary/5' : 'border-emerald-500 bg-emerald-50') : 'border-dp-outline-variant'}`}>
                <input type="radio" name="requested_as" checked={form.requested_as === value}
                  onChange={() => setForm({ ...form, requested_as: value })} className="accent-dp-secondary mt-0.5" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-sans text-[14px] font-bold text-dp-on-surface">
                    {value !== 'grant' && <HandCoins size={15} />} {t(lbl)}
                  </span>
                  <span className="block font-sans text-[12.5px] text-dp-on-surface-variant mt-1 leading-relaxed">{t(help)}</span>
                </span>
              </label>
            ))}
          </div>

          <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4">{t('pwz.f.repaymentNoPressure')}</p>

          {/* ── The agreement ────────────────────────────────────────────
              Shown in full, not behind a link. Somebody is being asked to
              commit to returning money over years; the terms belong on the
              same screen as the box they tick. */}
          {form.requested_as !== 'grant' && (
            <div className="border-2 border-emerald-500 rounded-lg overflow-hidden">
              <div className="bg-emerald-50 px-4 py-3 border-b border-emerald-200">
                <h3 className="font-sans text-[14px] font-bold text-emerald-900">{t('pwz.terms.title')}</h3>
              </div>

              <div className="p-4 max-h-[280px] overflow-y-auto print:max-h-none print:overflow-visible">
                {loanTerms.ur && (
                  <p className="font-sans text-[13.5px] text-dp-on-surface leading-[2.1] whitespace-pre-line"
                    style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                    {loanTerms.ur}
                  </p>
                )}
                {loanTerms.en && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed whitespace-pre-line mt-4 pt-4 border-t border-dp-outline-variant">
                    {loanTerms.en}
                  </p>
                )}
                {!loanTerms.ur && !loanTerms.en && (
                  <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('pwz.terms.notLoaded')}</p>
                )}
              </div>

              <div className="px-4 py-4 border-t border-emerald-200 bg-white">
                <label className="flex items-start gap-2.5 cursor-pointer mb-3">
                  <input type="checkbox" checked={form.loan_terms_accepted}
                    onChange={(e) => setForm({ ...form, loan_terms_accepted: e.target.checked })}
                    className="accent-emerald-600 mt-0.5" />
                  <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('pwz.terms.accept')}</span>
                </label>

                <label className={label}>{t('pwz.terms.signature')}</label>
                <input value={form.loan_terms_signature}
                  onChange={(e) => setForm({ ...form, loan_terms_signature: e.target.value })}
                  placeholder={t('pwz.terms.signaturePlaceholder')} className="input-field max-w-sm" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('pwz.terms.signatureHint')}</p>

                <div className="mt-3">
                  <label className={label}>{t('pwz.f.repaymentNote')}</label>
                  <textarea value={form.repayment_note} onChange={(e) => setForm({ ...form, repayment_note: e.target.value })}
                    rows={2} placeholder={t('pwz.f.repaymentNotePlaceholder')} className="input-field resize-none" />
                </div>
              </div>
            </div>
          )}
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

          <div className="grid grid-cols-2 gap-8 mt-6">
            <div>
              <div className="border-b border-black h-7" />
              <p className="font-sans text-[11px] mt-1">{t('pwz.v.signVerifier')}</p>
            </div>
            <div>
              <div className="border-b border-black h-7" />
              <p className="font-sans text-[11px] mt-1">{t('pwz.v.signDate')}</p>
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
          <div className="grid grid-cols-2 gap-8 mt-8">
            <div>
              <div className="border-b border-dp-outline h-8" />
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{t('pwz.signApplicant')}</p>
            </div>
            <div>
              <div className="border-b border-dp-outline h-8" />
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{t('pwz.signCommittee')}</p>
            </div>
          </div>
        </div>
      </div>

      <button disabled={busy} onClick={submit}
        className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50 print:hidden">
        <Send size={16} /> {busy ? t('action.saving') : t('pwz.submit')}
      </button>
    </div>
  )
}
