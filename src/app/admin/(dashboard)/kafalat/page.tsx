'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { GraduationCap, X, Plus, Save, ShieldAlert, UserPlus, Bus, Printer } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Kafalat — sponsoring a school child.
 *
 * Two things are load-bearing here and neither is obvious from the outside.
 *
 * Safeguarding: nothing on this screen is ever public. Children are shown to
 * sponsors by first name behind a login, and the ledger only ever sees the
 * code. A village site that publishes a poor child's photograph and full name
 * does that child real damage in a place where everyone knows everyone.
 *
 * Transport: it is the line that decides whether a village child continues.
 * Nothing for the school here; about Rs 4,000 a month for the run into
 * Chakwal, which is more than the school fee. Building the package from lines
 * rather than one number is what makes that visible.
 */

interface Measuring {
  academic_year: string; account_code: string
  required: number; confirmed: number; outstanding: number
  months_remaining: number; monthly_target: number; children_active: number
}

interface Child {
  id: string; code: string; first_name: string; first_name_ur: string | null
  full_name: string; guardian_name: string; guardian_phone: string | null
  gender: string | null; date_of_birth: string | null
  is_orphan: boolean; orphan_type: string | null
  school_name: string | null; current_class: string | null
  school_location: string; status: string
  guardian_consent_signed: boolean; photo_consent: boolean; do_not_display: boolean
  roll_no: string | null; section: string | null; uniform_mode: string
  created_at: string
}

interface DisbursementQueue {
  uniforms: {
    id: string; child_code: string; child_name: string; guardian: string
    guardian_phone: string | null; issue_no: number; scheduled_on: string
    amount: number; uniform_mode: string
  }[]
  disbursements: {
    id: string; child_code: string; child_name: string; guardian: string
    guardian_phone: string | null; category: string; month: string; amount: number
  }[]
}

interface ReverificationDue {
  child_id: string; code: string; name: string; guardian: string
  guardian_phone: string | null; current_class: string | null
  joined_on: string | null; last_verified: string | null
}

interface PackageLine {
  id: string; child_id: string; academic_year: string; category: string
  description: string | null; annual_amount_pkr: number
}

// What kafalat_sponsor_breakdown() returns per child — who has actually
// named this child and given, replacing kafalat_shares (which nothing ever
// wrote to and nothing ever confirmed a payment against).
interface Sponsor {
  name: string | null; is_anonymous: boolean; recurring: boolean; total_given: number
}

// What kafalat_children_for_naming() gives, for the same "how much of this
// child's requirement is covered" figure the donor portal shows.
interface NamingInfo { this_year_requirement: number; already_named: number }

interface Nomination {
  id: string; child_name: string; guardian_name: string | null
  approximate_age: number | null; gender: string | null
  address_hint: string | null; reason: string; status: string; created_at: string
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const CATEGORIES = ['school_fee', 'uniform', 'books', 'transport', 'pocket_money', 'medical', 'exam_fee', 'tuition', 'other'] as const
const currentAcademicYear = () => {
  // The Punjab school year runs April to March, so a date in January still
  // belongs to the session that started last April.
  const d = new Date()
  const start = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

const emptyChild = {
  first_name: '', first_name_ur: '', full_name: '', guardian_name: '',
  guardian_relation: 'father', guardian_phone: '', address: '',
  date_of_birth: '', gender: 'male', is_orphan: false, orphan_type: '',
  school_id: '', school_name: '', current_class: '', school_location: 'village',
  guardian_consent_signed: false, photo_consent: false,
  roll_no: '', section: '', uniform_mode: 'staggered',
}

export default function KafalatPage() {
  const { t } = useLocale()
  const supabase = createClient()

  const [children, setChildren] = useState<Child[]>([])
  const [lines, setLines] = useState<PackageLine[]>([])
  const [sponsors, setSponsors] = useState<Record<string, Sponsor[]>>({})
  const [naming, setNaming] = useState<Record<string, NamingInfo>>({})
  const [nominations, setNominations] = useState<Nomination[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [measuring, setMeasuring] = useState<Measuring | null>(null)
  const [schools, setSchools] = useState<{ id: string; name: string; kind: string; location: string; monthly_fee_pkr: number; months_charged: number }[]>([])
  // What the chosen school actually charges for the class typed in, so the
  // committee sees the real number before the package is built rather than
  // after the challan arrives.
  const [feePreview, setFeePreview] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'children' | 'nominations' | 'operations' | 'reverify'>('children')
  const [queue, setQueue] = useState<DisbursementQueue | null>(null)
  const [dueList, setDueList] = useState<ReverificationDue[]>([])
  const [reverifyTarget, setReverifyTarget] = useState<ReverificationDue | null>(null)
  const [reverifyForm, setReverifyForm] = useState({
    home_visited: 'yes', household_matches: 'yes', household_note: '',
    father_employment_changed: false, father_employment_note: '',
    siblings_employment_changed: false, siblings_employment_note: '',
    income_verified: 'yes', observed_monthly_income_pkr: 0,
    school_continuing: 'yes', current_class: '', attendance_note: '',
    co_verifier_names: '', recommendation: 'continue', recommended_note: '', overall_note: '',
  })
  const [issuingUniform, setIssuingUniform] = useState<DisbursementQueue['uniforms'][number] | null>(null)
  const [uniformForm, setUniformForm] = useState({ received_by: '', signed_note: '', method: 'cash' })
  const [payingDisbursement, setPayingDisbursement] = useState<DisbursementQueue['disbursements'][number] | null>(null)
  const [disbursementForm, setDisbursementForm] = useState({ method: 'cash', signed_by: '', driver_name: '', signed_note: '' })
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyChild)
  const [busy, setBusy] = useState(false)
  const [packageChild, setPackageChild] = useState<Child | null>(null)
  const [editLines, setEditLines] = useState<{ category: string; annual_amount_pkr: number }[]>([])

  // Ending a sponsorship reverses whatever of this year's requirement is
  // still owed, so the measuring account stops being measured against a
  // child who is no longer here — a raw status update would leave the pool
  // asking donors for money against a child that already left.
  const [endTarget, setEndTarget] = useState<Child | null>(null)
  const [endForm, setEndForm] = useState({ status: 'graduated', reason: '' })

  const endSponsorship = async () => {
    if (!endTarget) return
    setBusy(true)
    const { error } = await supabase.rpc('kafalat_end_child', {
      p_child_id: endTarget.id, p_status: endForm.status, p_reason: endForm.reason || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.ended'))
    setEndTarget(null)
    setEndForm({ status: 'graduated', reason: '' })
    load()
  }

  const load = useCallback(async () => {
    const [{ data: cs }, { data: ls }, { data: breakdown }, { data: named }, { data: ns }, { data: sum }, { data: sch }, { data: meas }] = await Promise.all([
      supabase.from('kafalat_children').select('*').order('created_at', { ascending: false }),
      supabase.from('kafalat_package_lines').select('*'),
      supabase.rpc('kafalat_sponsor_breakdown'),
      supabase.rpc('kafalat_children_for_naming'),
      supabase.from('kafalat_nominations').select('*').order('created_at', { ascending: false }),
      supabase.rpc('public_kafalat_summary'),
      supabase.from('schools').select('id, name, kind, location, monthly_fee_pkr, months_charged')
        .eq('is_active', true).order('location').order('name'),
      supabase.rpc('kafalat_measuring_position'),
    ])
    setChildren((cs ?? []) as Child[])
    setLines((ls ?? []) as PackageLine[])
    setSponsors((breakdown ?? {}) as Record<string, Sponsor[]>)
    setNaming(Object.fromEntries(
      ((named ?? []) as (NamingInfo & { id: string })[]).map((n) => [n.id, n]),
    ))
    setNominations((ns ?? []) as Nomination[])
    setSummary((sum ?? {}) as Record<string, number>)
    setSchools((sch ?? []) as { id: string; name: string; kind: string; location: string; monthly_fee_pkr: number; months_charged: number }[])
    setMeasuring((meas ?? null) as Measuring | null)
    setLoading(false)
  }, [supabase])

  const loadOperations = useCallback(async () => {
    const [{ data: q }, { data: due }] = await Promise.all([
      supabase.rpc('kafalat_disbursement_queue'),
      supabase.rpc('kafalat_reverification_due'),
    ])
    setQueue((q ?? null) as DisbursementQueue | null)
    setDueList((due ?? []) as ReverificationDue[])
  }, [supabase])

  useEffect(() => { if (tab === 'operations' || tab === 'reverify') loadOperations() }, [tab, loadOperations])

  const issueUniform = async () => {
    if (!issuingUniform) return
    if (!uniformForm.received_by.trim()) { toast.error(t('kf.err.receivedByRequired')); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('kafalat_issue_uniform', {
      p_issue_id: issuingUniform.id, p_received_by: uniformForm.received_by,
      p_signed_note: uniformForm.signed_note || null, p_method: uniformForm.method,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { voucher_no: string }
    toast.success(t('kf.ok.uniformIssued').replace('{v}', r.voucher_no))
    setIssuingUniform(null)
    setUniformForm({ received_by: '', signed_note: '', method: 'cash' })
    loadOperations()
  }

  const skipUniform = async (id: string) => {
    const reason = prompt(t('kf.skipReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('kafalat_skip_uniform', { p_issue_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.skipped'))
    loadOperations()
  }

  const payDisbursement = async () => {
    if (!payingDisbursement) return
    if (payingDisbursement.category === 'transport' && !disbursementForm.driver_name.trim()) {
      toast.error(t('kf.err.driverRequired')); return
    }
    setBusy(true)
    const { data, error } = await supabase.rpc('kafalat_pay_disbursement', {
      p_disbursement_id: payingDisbursement.id, p_method: disbursementForm.method,
      p_signed_by: disbursementForm.signed_by || null,
      p_driver_name: disbursementForm.driver_name || null,
      p_signed_note: disbursementForm.signed_note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { voucher_no: string }
    toast.success(t('kf.ok.disbursementPaid').replace('{v}', r.voucher_no))
    setPayingDisbursement(null)
    setDisbursementForm({ method: 'cash', signed_by: '', driver_name: '', signed_note: '' })
    loadOperations()
  }

  const skipDisbursement = async (id: string) => {
    const reason = prompt(t('kf.skipReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('kafalat_skip_disbursement', { p_disbursement_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.skipped'))
    loadOperations()
  }

  const printRegister = async () => {
    const { data, error } = await supabase.rpc('kafalat_register')
    if (error) { toast.error(friendlyError(error)); return }
    const reg = data as { academic_year: string
      children: { code: string; name: string; roll_no: string | null; section: string | null
        guardian: string; guardian_phone: string | null; current_class: string | null
        school_name: string | null; school_location: string; fee_annual: number
        transport_annual: number; uniform_mode: string
        uniform_status: { issue_no: number; status: string; scheduled_on: string }[] | null }[] }
    const win = window.open('', '_blank')
    if (!win) return
    const rows = reg.children.map((c) => `
      <tr>
        <td>${c.code}</td><td>${c.name}</td><td>${c.roll_no ?? ''}</td><td>${c.section ?? ''}</td>
        <td>${c.current_class ?? ''}</td><td>${c.school_name ?? ''}</td>
        <td>${c.guardian}${c.guardian_phone ? ' · ' + c.guardian_phone : ''}</td>
        <td>Rs ${fmt(c.fee_annual)}</td>
        <td>Rs ${fmt(c.transport_annual)}</td>
        <td style="min-width:120px;border-bottom:1px solid #000">&nbsp;</td>
      </tr>`).join('')
    win.document.write(`<html><head><title>${t('kf.registerTitle')} — ${reg.academic_year}</title>
      <style>
        body{font-family:sans-serif;padding:24px;font-size:12px}
        h1{font-size:18px} table{width:100%;border-collapse:collapse;margin-top:12px}
        th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:11.5px}
        th{background:#f3f3f3}
      </style></head><body>
      <h1>${t('kf.registerTitle')} — ${reg.academic_year}</h1>
      <p>${new Date().toLocaleDateString()}</p>
      <table><thead><tr>
        <th>Code</th><th>Name</th><th>${t('kf.rollNo')}</th><th>${t('kf.section')}</th>
        <th>${t('kf.class')}</th><th>School</th><th>${t('kf.guardian')}</th>
        <th>${t('kf.f.feeAnnual')}</th><th>${t('kf.f.transportAnnual')}</th><th>${t('kf.driverSignature')}</th>
      </tr></thead><tbody>${rows}</tbody></table>
      </body></html>`)
    win.document.close()
    win.print()
  }

  const openReverify = (d: ReverificationDue) => {
    setReverifyForm({
      home_visited: 'yes', household_matches: 'yes', household_note: '',
      father_employment_changed: false, father_employment_note: '',
      siblings_employment_changed: false, siblings_employment_note: '',
      income_verified: 'yes', observed_monthly_income_pkr: 0,
      school_continuing: 'yes', current_class: d.current_class ?? '', attendance_note: '',
      co_verifier_names: '', recommendation: 'continue', recommended_note: '', overall_note: '',
    })
    setReverifyTarget(d)
  }

  const submitReverify = async () => {
    if (!reverifyTarget) return
    setBusy(true)
    const { data, error } = await supabase.rpc('kafalat_record_reverification', {
      p_child_id: reverifyTarget.child_id,
      p_home_visited: reverifyForm.home_visited,
      p_household_matches: reverifyForm.household_matches,
      p_household_note: reverifyForm.household_note || null,
      p_father_employment_changed: reverifyForm.father_employment_changed,
      p_father_employment_note: reverifyForm.father_employment_note || null,
      p_siblings_employment_changed: reverifyForm.siblings_employment_changed,
      p_siblings_employment_note: reverifyForm.siblings_employment_note || null,
      p_income_verified: reverifyForm.income_verified,
      p_observed_monthly_income_pkr: reverifyForm.observed_monthly_income_pkr || null,
      p_school_continuing: reverifyForm.school_continuing,
      p_current_class: reverifyForm.current_class || null,
      p_attendance_note: reverifyForm.attendance_note || null,
      p_co_verifier_names: reverifyForm.co_verifier_names
        ? reverifyForm.co_verifier_names.split(',').map((s) => s.trim()).filter(Boolean) : null,
      p_recommendation: reverifyForm.recommendation,
      p_recommended_note: reverifyForm.recommended_note || null,
      p_overall_note: reverifyForm.overall_note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { verifiers: number; note?: string }
    if (r.verifiers < 2) {
      toast.warning(r.note ?? t('kf.reverify.needSecond'))
    } else {
      toast.success(t('kf.ok.reverified'))
    }
    setReverifyTarget(null)
    loadOperations()
    load()
  }

  useEffect(() => { load() }, [load])

  const packageTotal = (childId: string) =>
    lines.filter((l) => l.child_id === childId).reduce((s, l) => s + Number(l.annual_amount_pkr || 0), 0)

  // Against the same measuring-account requirement the pool divides among
  // donors, not the package total — a child can be fully named while their
  // package total and this year's requirement differ (mid-year joiners,
  // rate-card changes).
  const committed = (childId: string) => {
    const n = naming[childId]
    if (!n || n.this_year_requirement <= 0) return 0
    return Math.min(100, Math.round((n.already_named / n.this_year_requirement) * 100))
  }

  const previewFee = async (schoolId: string, currentClass: string) => {
    if (!schoolId) { setFeePreview(null); return }
    const { data } = await supabase.rpc('school_fee_for_class', {
      p_school_id: schoolId, p_class: currentClass || null,
    })
    setFeePreview((data ?? null) as Record<string, unknown> | null)
  }

  const addChild = async () => {
    if (!form.first_name.trim() || !form.full_name.trim() || !form.guardian_name.trim()) {
      toast.error(t('kf.err.required')); return
    }
    setBusy(true)
    const { data, error } = await supabase.from('kafalat_children').insert({
      ...form,
      school_id: form.school_id || null,
      first_name_ur: form.first_name_ur || null,
      guardian_phone: form.guardian_phone || null,
      address: form.address || null,
      date_of_birth: form.date_of_birth || null,
      orphan_type: form.is_orphan ? (form.orphan_type || 'father_deceased') : null,
      school_name: form.school_name || null,
      current_class: form.current_class || null,
      guardian_consent_at: form.guardian_consent_signed ? new Date().toISOString() : null,
      status: 'verified',
    }).select('id').single()
    if (error) { setBusy(false); toast.error(friendlyError(error)); return }

    // Prefills the package from the committee's own figures, with the
    // transport line following where the child actually studies.
    await supabase.rpc('kafalat_default_package', {
      p_child_id: data.id, p_academic_year: currentAcademicYear(),
    })
    setBusy(false)
    toast.success(t('kf.ok.added'))
    setShowForm(false)
    setForm(emptyChild)
    load()
  }

  const openPackage = (c: Child) => {
    const existing = lines.filter((l) => l.child_id === c.id)
    setEditLines(
      CATEGORIES.map((cat) => ({
        category: cat,
        annual_amount_pkr: Number(existing.find((l) => l.category === cat)?.annual_amount_pkr ?? 0),
      }))
    )
    setPackageChild(c)
  }

  const savePackage = async () => {
    if (!packageChild) return
    setBusy(true)
    const year = currentAcademicYear()
    await supabase.from('kafalat_package_lines').delete().eq('child_id', packageChild.id).eq('academic_year', year)
    const rows = editLines.filter((l) => l.annual_amount_pkr > 0).map((l) => ({
      child_id: packageChild.id, academic_year: year,
      category: l.category, annual_amount_pkr: l.annual_amount_pkr,
    }))
    const { error } = rows.length > 0
      ? await supabase.from('kafalat_package_lines').insert(rows)
      : { error: null }
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.packageSaved'))
    setPackageChild(null)
    load()
  }

  const activate = async (c: Child) => {
    if (!c.guardian_consent_signed) { toast.error(t('kf.err.consentFirst')); return }
    // Runs the rate card and posts the year's requirement to the measuring
    // account in the same breath approval happens — a raw status update here
    // would leave the pool figure exactly where it was before this child ever
    // existed, the same class of bug the "cash received" button had.
    const { data, error } = await supabase.rpc('kafalat_approve_child', { p_child_id: c.id })
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { this_year_requirement: number; months_remaining: number }
    toast.success(t('kf.ok.activated').replace('{amt}', fmt(r.this_year_requirement)).replace('{n}', String(r.months_remaining)))
    load()
  }

  const reviewNomination = async (n: Nomination, status: string) => {
    const { error } = await supabase.from('kafalat_nominations')
      .update({ status, reviewed_at: new Date().toISOString() }).eq('id', n.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.nominationReviewed'))
    load()
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <GraduationCap size={26} className="text-dp-secondary" /> {t('kf.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('kf.blurb')}</p>
        </div>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <UserPlus size={16} /> {t('kf.addChild')}
        </button>
      </div>

      <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-5">
        <ShieldAlert size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('kf.safeguardingNotice')}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {([
          ['active_children', 'kf.card.active'],
          ['fully_sponsored', 'kf.card.full'],
          ['partly_sponsored', 'kf.card.partial'],
          ['awaiting_sponsor', 'kf.card.waiting'],
        ] as const).map(([key, label]) => (
          <div key={key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t(label)}</p>
            <p className="font-heading text-[24px] font-bold text-dp-primary">{summary[key] ?? 0}</p>
          </div>
        ))}
      </div>

      {/* ── The measuring account ──────────────────────────────────────
          What every registered child needs for the rest of this academic
          year, against what has been confirmed so far — the same figure
          Mushtarka Kafalat's pool divides among donors. A requirement
          register, not a fund: it holds no money of its own. */}
      {measuring && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-heading text-[14px] font-bold text-dp-primary">
              {t('kf.measuring.title')} {measuring.academic_year}
            </h3>
            <span className="font-mono text-[11px] text-dp-on-surface-variant">{measuring.account_code}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { v: fmt(measuring.required), l: t('kf.measuring.required') },
              { v: fmt(measuring.confirmed), l: t('kf.measuring.confirmed') },
              { v: fmt(measuring.outstanding), l: t('kf.measuring.outstanding') },
              { v: fmt(measuring.monthly_target), l: t('kf.measuring.monthlyTarget') },
            ].map((s) => (
              <div key={s.l}>
                <p className="font-heading text-[18px] font-bold text-dp-primary">{s.v}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{s.l}</p>
              </div>
            ))}
          </div>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">
            {t('kf.measuring.monthsLeft').replace('{n}', String(measuring.months_remaining))}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {([
          ['children', `${t('kf.tab.children')} (${children.length})`],
          ['nominations', `${t('kf.tab.nominations')} (${nominations.filter((n) => n.status === 'new').length})`],
          ['operations', `${t('kf.tab.operations')}${queue ? ` (${queue.uniforms.length + queue.disbursements.length})` : ''}`],
          ['reverify', `${t('kf.tab.reverify')}${dueList.length ? ` (${dueList.length})` : ''}`],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === key ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && tab === 'children' && (
        <div className="space-y-3">
          {children.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.empty')}</p>
            </div>
          )}
          {children.map((c) => {
            const total = packageTotal(c.id)
            const pct = committed(c.id)
            const childSponsors = sponsors[c.id] ?? []
            return (
              <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-mono text-[11.5px] text-dp-on-surface-variant">{c.code}</span>
                      <span className="font-sans text-[15px] font-bold text-dp-on-surface">{c.first_name}</span>
                      <span className="font-sans text-[13px] text-dp-on-surface-variant">({c.full_name})</span>
                      {c.is_orphan && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('kf.orphan')}</span>}
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${c.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                        {t(`kf.status.${c.status}`)}
                      </span>
                      {!c.guardian_consent_signed && (
                        <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10.5px] font-bold">{t('kf.noConsent')}</span>
                      )}
                    </div>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {c.current_class && `${t('kf.class')} ${c.current_class} · `}
                      {c.roll_no && `${t('kf.rollNo')} ${c.roll_no}${c.section ? '/' + c.section : ''} · `}
                      {c.school_name}
                      <span className="inline-flex items-center gap-1 ms-2">
                        <Bus size={12} /> {t(`kf.loc.${c.school_location}`)}
                      </span>
                    </p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                      {t('kf.guardian')}: {c.guardian_name}{c.guardian_phone ? ` · ${c.guardian_phone}` : ''}
                    </p>

                    <div className="mt-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-sans text-[13px] font-semibold text-dp-on-surface">Rs {fmt(total)}/{t('es.year')}</span>
                        <span className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          · {pct}% {t('kf.sponsored')}{pct < 100 && ` · ${100 - pct}% ${t('kf.remaining')}`}
                        </span>
                      </div>
                      <div className="h-2 w-full max-w-xs bg-dp-surface-container rounded-full overflow-hidden">
                        <div className="h-full bg-dp-secondary" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      {childSponsors.length > 0 && (
                        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">
                          {childSponsors.map((s) =>
                            `${s.is_anonymous ? t('f.anonymousDonor') : s.name} — Rs ${fmt(s.total_given)}${s.recurring ? `/${t('pkf.month')}` : ''}`,
                          ).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button onClick={() => openPackage(c)}
                      className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                      {t('kf.editPackage')}
                    </button>
                    {c.status !== 'active' && (
                      <button onClick={() => activate(c)}
                        className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer whitespace-nowrap">
                        {t('kf.activate')}
                      </button>
                    )}
                    {c.status === 'active' && (
                      <button onClick={() => setEndTarget(c)}
                        className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                        {t('kf.endSponsorship')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && tab === 'nominations' && (
        <div className="space-y-3">
          {nominations.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.noNominations')}</p>
            </div>
          )}
          {nominations.map((n) => (
            <div key={n.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">
                  {n.child_name}
                  {n.approximate_age && <span className="font-normal text-dp-on-surface-variant"> · {n.approximate_age} {t('kf.years')}</span>}
                </p>
                {n.guardian_name && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('kf.guardian')}: {n.guardian_name}</p>}
                {n.address_hint && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{n.address_hint}</p>}
                <p className="font-sans text-[13px] text-dp-on-surface mt-1.5 italic">{n.reason}</p>
              </div>
              {n.status === 'new' ? (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => reviewNomination(n, 'screening')}
                    className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    {t('kf.startScreening')}
                  </button>
                  <button onClick={() => reviewNomination(n, 'declined')}
                    className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                    {t('es.decline')}
                  </button>
                </div>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-bold shrink-0">{t(`kf.nstatus.${n.status}`)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Operations: uniforms and monthly disbursements ──────────────
          The paper this actually produces — issue a uniform, pay a driver,
          print the register to carry to a school gate. */}
      {!loading && tab === 'operations' && (
        <div className="space-y-6">
          <button onClick={printRegister}
            className="flex items-center gap-2 px-4 py-2 bg-dp-primary text-white rounded-lg font-sans text-[13px] font-semibold hover:opacity-90 cursor-pointer">
            <Printer size={15} /> {t('kf.printRegister')}
          </button>

          <div>
            <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-2">{t('kf.uniformsDue')}</h3>
            {(!queue || queue.uniforms.length === 0) ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('kf.nothingDue')}</p>
            ) : (
              <div className="space-y-2">
                {queue.uniforms.map((u) => (
                  <div key={u.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
                        {u.child_name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{u.child_code}</span>
                        {' · '}{t('kf.uniformIssue')} {u.issue_no}/2
                      </p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {u.guardian}{u.guardian_phone ? ` · ${u.guardian_phone}` : ''} · Rs {fmt(u.amount)}
                        {' · '}{t(`kf.uniform.${u.uniform_mode}`)}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { setUniformForm({ received_by: '', signed_note: '', method: u.uniform_mode === 'cash' ? 'cash' : 'cash' }); setIssuingUniform(u) }}
                        className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.issue')}
                      </button>
                      <button onClick={() => skipUniform(u.id)}
                        className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.skip')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-2">{t('kf.disbursementsDue')}</h3>
            {(!queue || queue.disbursements.length === 0) ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('kf.nothingDue')}</p>
            ) : (
              <div className="space-y-2">
                {queue.disbursements.map((d) => (
                  <div key={d.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
                        {d.child_name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{d.child_code}</span>
                        {' · '}{t(`kf.cat.${d.category}`)}
                      </p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {d.guardian}{d.guardian_phone ? ` · ${d.guardian_phone}` : ''} · Rs {fmt(d.amount)}
                        {' · '}{new Date(d.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { setDisbursementForm({ method: 'cash', signed_by: '', driver_name: '', signed_note: '' }); setPayingDisbursement(d) }}
                        className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.pay')}
                      </button>
                      <button onClick={() => skipDisbursement(d.id)}
                        className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.skip')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Annual re-verification ───────────────────────────────────────
          A father finds work, a brother finishes his own studies — none of
          that shows up on its own. Once a year the committee goes back and
          asks, with the same weight as the first visit: two names, one
          form, one decision. */}
      {!loading && tab === 'reverify' && (
        <div className="space-y-3">
          {dueList.length === 0 ? (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.reverify.allDone')}</p>
            </div>
          ) : dueList.map((d) => (
            <div key={d.child_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">
                  {d.name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{d.code}</span>
                </p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                  {t('kf.guardian')}: {d.guardian}{d.guardian_phone ? ` · ${d.guardian_phone}` : ''}
                  {d.current_class ? ` · ${t('kf.class')} ${d.current_class}` : ''}
                </p>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">
                  {d.last_verified ? t('kf.reverify.lastChecked').replace('{y}', d.last_verified) : t('kf.reverify.neverChecked')}
                </p>
              </div>
              <button onClick={() => openReverify(d)}
                className="px-3.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer shrink-0">
                {t('kf.reverify.recordVisit')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Add a child ─────────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('kf.addChild')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.firstName')}</label>
                  <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} className="input-field" />
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('kf.f.firstNameHint')}</p>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
                  <input value={form.first_name_ur} onChange={(e) => setForm({ ...form, first_name_ur: e.target.value })}
                    className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.fullName')}</label>
                  <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardian')}</label>
                  <input value={form.guardian_name} onChange={(e) => setForm({ ...form, guardian_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardianRelation')}</label>
                  <select value={form.guardian_relation} onChange={(e) => setForm({ ...form, guardian_relation: e.target.value })} className="input-field">
                    {['mother', 'father', 'grandparent', 'uncle', 'aunt', 'sibling', 'other'].map((r) => (
                      <option key={r} value={r}>{t(`kf.grel.${r}`)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.phone')}</label>
                  <input value={form.guardian_phone} onChange={(e) => setForm({ ...form, guardian_phone: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.dob')}</label>
                  <input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.gender')}</label>
                  <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input-field">
                    <option value="male">{t('kf.boy')}</option>
                    <option value="female">{t('kf.girl')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.class')}</label>
                  <input value={form.current_class}
                    onChange={(e) => { setForm({ ...form, current_class: e.target.value }); previewFee(form.school_id, e.target.value) }}
                    className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.schoolLocation')}</label>
                  <select value={form.school_location} onChange={(e) => setForm({ ...form, school_location: e.target.value })} className="input-field">
                    <option value="village">{t('kf.loc.village')}</option>
                    <option value="chakwal">{t('kf.loc.chakwal')}</option>
                    <option value="other">{t('kf.loc.other')}</option>
                  </select>
                </div>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant -mt-2">{t('kf.f.transportHint')}</p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.rollNo')}</label>
                  <input value={form.roll_no} onChange={(e) => setForm({ ...form, roll_no: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.section')}</label>
                  <input value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.uniformMode')}</label>
                  <select value={form.uniform_mode} onChange={(e) => setForm({ ...form, uniform_mode: e.target.value })} className="input-field">
                    <option value="both">{t('kf.uniform.both')}</option>
                    <option value="staggered">{t('kf.uniform.staggered')}</option>
                    <option value="cash">{t('kf.uniform.cash')}</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.school')}</label>
                <select value={form.school_id}
                  onChange={(e) => {
                    const sc = schools.find((x) => x.id === e.target.value)
                    setForm({
                      ...form, school_id: e.target.value,
                      school_name: sc?.name ?? form.school_name,
                      // The school knows where it is; the child's location
                      // follows from it rather than being asked twice.
                      school_location: sc?.location ?? form.school_location,
                    })
                    previewFee(e.target.value, form.current_class)
                  }}
                  className="input-field">
                  <option value="">{t('kf.f.schoolNotListed')}</option>
                  {schools.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.name} — {t(`sc.kind.${sc.kind}`)}{Number(sc.monthly_fee_pkr) > 0 ? ` · Rs ${fmt(sc.monthly_fee_pkr)}/${t('sc.month')}` : ''}
                    </option>
                  ))}
                </select>

                {!form.school_id && (
                  <input value={form.school_name} onChange={(e) => setForm({ ...form, school_name: e.target.value })}
                    placeholder={t('kf.f.schoolTypeName')} className="input-field mt-2" />
                )}

                {feePreview && (
                  <div className="mt-2 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">
                      {t('kf.f.feeForClass')} <strong>Rs {fmt(Number(feePreview.monthly_fee ?? 0))}</strong>/{t('sc.month')}
                      {' × '}{String(feePreview.months_charged ?? 12)}
                      {' = '}<strong>Rs {fmt(Number(feePreview.annual_fee ?? 0) + Number(feePreview.annual_charges ?? 0))}</strong>/{t('es.year')}
                      {feePreview.tier ? ` · ${String(feePreview.tier)}` : ''}
                    </p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('kf.f.feePreviewHint')}</p>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
                <input type="checkbox" checked={form.is_orphan} onChange={(e) => setForm({ ...form, is_orphan: e.target.checked })} className="accent-dp-secondary" />
                {t('kf.f.isOrphan')}
              </label>
              {form.is_orphan && (
                <select value={form.orphan_type} onChange={(e) => setForm({ ...form, orphan_type: e.target.value })} className="input-field">
                  <option value="father_deceased">{t('kf.orphan.father')}</option>
                  <option value="mother_deceased">{t('kf.orphan.mother')}</option>
                  <option value="both_deceased">{t('kf.orphan.both')}</option>
                </select>
              )}

              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 space-y-2">
                <p className="font-sans text-[12.5px] font-bold text-dp-on-surface">{t('kf.consentHeading')}</p>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={form.guardian_consent_signed}
                    onChange={(e) => setForm({ ...form, guardian_consent_signed: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  <span>{t('kf.f.consentSigned')}</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={form.photo_consent}
                    onChange={(e) => setForm({ ...form, photo_consent: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  <span>{t('kf.f.photoConsent')}</span>
                </label>
              </div>

              <button disabled={busy} onClick={addChild}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {busy ? t('action.saving') : t('kf.addChild')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── The package, line by line ───────────────────────────────────── */}
      {packageChild && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPackageChild(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('kf.packageTitle')}</h2>
              <button onClick={() => setPackageChild(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {packageChild.code} · {packageChild.first_name} · {currentAcademicYear()}
            </p>

            <div className="space-y-2 mb-4">
              {editLines.map((l, idx) => (
                <div key={l.category} className="grid grid-cols-[1fr_140px] gap-2 items-center">
                  <label className="font-sans text-[13.5px] text-dp-on-surface">{t(`kf.cat.${l.category}`)}</label>
                  <input type="number" min={0} value={l.annual_amount_pkr || ''}
                    onChange={(e) => {
                      const next = [...editLines]
                      next[idx] = { ...l, annual_amount_pkr: +e.target.value }
                      setEditLines(next)
                    }}
                    className="input-field !py-2 text-end tabular-nums" />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-dp-outline-variant pt-3 mb-4">
              <span className="font-sans text-[13px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant">{t('kf.annualTotal')}</span>
              <span className="font-heading text-[22px] font-bold text-dp-primary">
                Rs {fmt(editLines.reduce((s, l) => s + (l.annual_amount_pkr || 0), 0))}
              </span>
            </div>

            <button disabled={busy} onClick={savePackage}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Plus size={16} /> {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {endTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEndTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('kf.endTitle')}</h2>
              <button onClick={() => setEndTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {t('kf.endBlurb').replace('{name}', endTarget.first_name)}
            </p>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.endReason')}</label>
            <select value={endForm.status} onChange={(e) => setEndForm({ ...endForm, status: e.target.value })}
              className="input-field mb-3">
              <option value="graduated">{t('kf.status.graduated')}</option>
              <option value="left_village">{t('kf.status.left_village')}</option>
              <option value="withdrawn">{t('kf.status.withdrawn')}</option>
            </select>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.note')}</label>
            <textarea value={endForm.reason} rows={2}
              onChange={(e) => setEndForm({ ...endForm, reason: e.target.value })} className="input-field mb-4" />

            <button disabled={busy} onClick={endSponsorship}
              className="w-full bg-dp-primary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? t('action.saving') : t('kf.confirmEnd')}
            </button>
          </div>
        </div>
      )}

      {/* ── Handing over a uniform ────────────────────────────────────── */}
      {issuingUniform && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setIssuingUniform(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[17px] font-bold text-dp-primary">{t('kf.issueTitle')}</h2>
              <button onClick={() => setIssuingUniform(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {issuingUniform.child_name} · {t('kf.uniformIssue')} {issuingUniform.issue_no}/2 · Rs {fmt(issuingUniform.amount)}
            </p>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.receivedBy')}</label>
            <input value={uniformForm.received_by} onChange={(e) => setUniformForm({ ...uniformForm, received_by: e.target.value })}
              placeholder={issuingUniform.guardian} className="input-field mb-3" />

            {issuingUniform.uniform_mode === 'cash' && (
              <>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.method')}</label>
                <select value={uniformForm.method} onChange={(e) => setUniformForm({ ...uniformForm, method: e.target.value })} className="input-field mb-3">
                  <option value="cash">{t('pool.method.cash')}</option>
                  <option value="bank">{t('pool.method.bank')}</option>
                </select>
              </>
            )}

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.note')}</label>
            <textarea value={uniformForm.signed_note} rows={2}
              onChange={(e) => setUniformForm({ ...uniformForm, signed_note: e.target.value })} className="input-field mb-4" />

            <button disabled={busy} onClick={issueUniform}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? t('action.saving') : t('kf.confirmIssue')}
            </button>
          </div>
        </div>
      )}

      {/* ── Paying a monthly disbursement ────────────────────────────────
          Transport insists on a driver's name; pocket money does not need
          one, since it goes to the guardian who is already on file. */}
      {payingDisbursement && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayingDisbursement(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[17px] font-bold text-dp-primary">{t('kf.payTitle')}</h2>
              <button onClick={() => setPayingDisbursement(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {payingDisbursement.child_name} · {t(`kf.cat.${payingDisbursement.category}`)} · Rs {fmt(payingDisbursement.amount)}
            </p>

            {payingDisbursement.category === 'transport' && (
              <>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.driverName')}</label>
                <input value={disbursementForm.driver_name}
                  onChange={(e) => setDisbursementForm({ ...disbursementForm, driver_name: e.target.value })} className="input-field mb-3" />
              </>
            )}

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.method')}</label>
            <select value={disbursementForm.method} onChange={(e) => setDisbursementForm({ ...disbursementForm, method: e.target.value })} className="input-field mb-3">
              <option value="cash">{t('pool.method.cash')}</option>
              <option value="bank">{t('pool.method.bank')}</option>
              <option value="jazzcash">JazzCash</option>
              <option value="easypaisa">EasyPaisa</option>
            </select>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.receivedBy')}</label>
            <input value={disbursementForm.signed_by}
              onChange={(e) => setDisbursementForm({ ...disbursementForm, signed_by: e.target.value })} className="input-field mb-3" />

            <button disabled={busy} onClick={payDisbursement}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? t('action.saving') : t('kf.confirmPay')}
            </button>
          </div>
        </div>
      )}

      {/* ── The annual re-verification visit ─────────────────────────────
          A committee member types this up after the visit. The signatures —
          the verifier's and the co-signer's — are on the paper form, not in
          this database; only the names go here. */}
      {reverifyTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setReverifyTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('kf.reverify.title')}</h2>
              <button onClick={() => setReverifyTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {reverifyTarget.name} · {reverifyTarget.code}
            </p>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.homeVisited')}</label>
                  <select value={reverifyForm.home_visited} onChange={(e) => setReverifyForm({ ...reverifyForm, home_visited: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.householdMatches')}</label>
                  <select value={reverifyForm.household_matches} onChange={(e) => setReverifyForm({ ...reverifyForm, household_matches: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option><option value="na">{t('g.na')}</option>
                  </select>
                </div>
              </div>
              <textarea placeholder={t('kf.reverify.householdNote')} value={reverifyForm.household_note} rows={2}
                onChange={(e) => setReverifyForm({ ...reverifyForm, household_note: e.target.value })} className="input-field" />

              <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-2.5">
                <p className="font-sans text-[12.5px] font-bold text-dp-on-surface">{t('kf.reverify.whatChanged')}</p>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={reverifyForm.father_employment_changed}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, father_employment_changed: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  {t('kf.reverify.fatherEmploymentChanged')}
                </label>
                {reverifyForm.father_employment_changed && (
                  <input value={reverifyForm.father_employment_note} placeholder={t('kf.f.note')}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, father_employment_note: e.target.value })} className="input-field !py-2" />
                )}
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={reverifyForm.siblings_employment_changed}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, siblings_employment_changed: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  {t('kf.reverify.siblingsEmploymentChanged')}
                </label>
                {reverifyForm.siblings_employment_changed && (
                  <input value={reverifyForm.siblings_employment_note} placeholder={t('kf.f.note')}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, siblings_employment_note: e.target.value })} className="input-field !py-2" />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.incomeVerified')}</label>
                  <select value={reverifyForm.income_verified} onChange={(e) => setReverifyForm({ ...reverifyForm, income_verified: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option><option value="na">{t('g.na')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.observedIncome')}</label>
                  <input type="number" min={0} value={reverifyForm.observed_monthly_income_pkr || ''}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, observed_monthly_income_pkr: +e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.schoolContinuing')}</label>
                  <select value={reverifyForm.school_continuing} onChange={(e) => setReverifyForm({ ...reverifyForm, school_continuing: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.class')}</label>
                  <input value={reverifyForm.current_class}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, current_class: e.target.value })} className="input-field" />
                </div>
              </div>

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.coVerifiers')}</label>
                <input value={reverifyForm.co_verifier_names} placeholder={t('kf.reverify.coVerifiersPlaceholder')}
                  onChange={(e) => setReverifyForm({ ...reverifyForm, co_verifier_names: e.target.value })} className="input-field" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('kf.reverify.coVerifiersHint')}</p>
              </div>

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.recommendation')}</label>
                <select value={reverifyForm.recommendation} onChange={(e) => setReverifyForm({ ...reverifyForm, recommendation: e.target.value })} className="input-field">
                  <option value="continue">{t('kf.reverify.rec.continue')}</option>
                  <option value="adjust">{t('kf.reverify.rec.adjust')}</option>
                  <option value="graduate">{t('kf.reverify.rec.graduate')}</option>
                  <option value="end">{t('kf.reverify.rec.end')}</option>
                </select>
              </div>
              {reverifyForm.recommendation !== 'continue' && (
                <textarea placeholder={t('kf.reverify.recommendationNote')} value={reverifyForm.recommended_note} rows={2}
                  onChange={(e) => setReverifyForm({ ...reverifyForm, recommended_note: e.target.value })} className="input-field" />
              )}

              <textarea placeholder={t('kf.reverify.overallNote')} value={reverifyForm.overall_note} rows={2}
                onChange={(e) => setReverifyForm({ ...reverifyForm, overall_note: e.target.value })} className="input-field" />

              <button disabled={busy} onClick={submitReverify}
                className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
                {busy ? t('action.saving') : t('kf.reverify.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
