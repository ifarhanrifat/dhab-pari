'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { BookOpen, X, Award, Calculator, HandCoins, Plus, Save } from 'lucide-react'
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

interface Instalment {
  id: string; award_id: string; purpose: string; description: string | null
  due_on: string | null; amount_pkr: number; pay_to: string
  status: string; paid_on: string | null; receipt_no: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const LEVELS = ['intermediate', 'diploma', 'bachelors', 'masters', 'technical_certificate', 'medical', 'engineering', 'other'] as const
const PURPOSES = ['admission_fee', 'semester_fee', 'hostel', 'transport', 'books', 'equipment', 'exam_fee', 'stipend', 'other'] as const

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
  const [instalmentForm, setInstalmentForm] = useState({ purpose: 'admission_fee', description: '', due_on: '', amount: 0 })

  const load = useCallback(async () => {
    const [{ data: st }, { data: ap }, { data: aw }, { data: ins }, { data: sum }] = await Promise.all([
      supabase.from('wazifa_students').select('*').order('created_at', { ascending: false }),
      supabase.from('wazifa_applications').select('*').order('total_score', { ascending: false, nullsFirst: false }),
      supabase.from('wazifa_awards').select('*').order('created_at', { ascending: false }),
      supabase.from('wazifa_instalments').select('*').order('due_on'),
      supabase.rpc('public_wazifa_summary'),
    ])
    setStudents((st ?? []) as Student[])
    setApplications((ap ?? []) as Application[])
    setAwards((aw ?? []) as AwardRow[])
    setInstalments((ins ?? []) as Instalment[])
    setSummary((sum ?? {}) as Record<string, number>)
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const studentOf = (id: string) => students.find((s) => s.id === id)

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
                    <span className="px-2 py-0.5 rounded bg-dp-surface-container-low text-[11.5px] font-semibold">
                      {t('wz.merit')} {a.merit_score ?? '—'}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-dp-surface-container-low text-[11.5px] font-semibold">
                      {t('wz.need')} {a.need_score ?? '—'}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-dp-secondary/10 text-dp-secondary text-[11.5px] font-bold">
                      {t('wz.score')} {a.total_score ?? '—'}
                    </span>
                  </div>
                </div>

                <button onClick={() => { setAwardTarget(a); setAwardForm({ amount: a.requested_amount_pkr, funded_by: 'sadqa', condition: '' }) }}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0">
                  <Award size={15} /> {t('wz.award')}
                </button>
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
                  </div>
                  <button onClick={() => setInstalmentTarget(aw)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer shrink-0">
                    <Plus size={14} /> {t('wz.addInstalment')}
                  </button>
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
