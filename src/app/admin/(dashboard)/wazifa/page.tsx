'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { BookOpen, X, Award, Calculator, HandCoins, Plus, Save, ClipboardCheck, Gavel, CalendarClock, Users } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

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
  const [tab, setTab] = useState<'applications' | 'awards'>('applications')
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
  const [familyCheck, setFamilyCheck] = useState<Record<string, { code: string; name?: string; status: string; awarded?: number }[]> | null>(null)
  const [instalmentForm, setInstalmentForm] = useState({ purpose: 'admission_fee', description: '', due_on: '', amount: 0 })

  const load = useCallback(async () => {
    const [{ data: st }, { data: ap }, { data: aw }, { data: ins }, { data: sum }, { data: vf }, { data: dc },
           { data: docs }, { data: cm }, { data: minV }] = await Promise.all([
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
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

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

  const payInstalment = async (i: Instalment) => {
    setBusy(true)
    const { data, error } = await supabase.rpc('wazifa_pay_instalment', {
      p_instalment_id: i.id, p_method: 'bank', p_note: null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const d = data as { receipt_no: string }
    toast.success(`${t('wz.ok.paid')} ${d.receipt_no}`)
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
                    <button onClick={() => setInstalmentTarget(aw)}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
                      <Plus size={14} /> {t('wz.addInstalment')}
                    </button>
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
                            <button disabled={busy} onClick={() => payInstalment(i)}
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
