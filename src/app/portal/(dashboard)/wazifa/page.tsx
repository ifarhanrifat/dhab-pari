'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { BookOpen, Send } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Applying for a Taleemi Wazifa.
 *
 * The application asks for marks and for income because the fund is limited
 * and has to choose between people. Saying so on the form is fairer than
 * pretending the choice is not being made — and it tells an applicant with
 * strong marks and no money that they are exactly who this is for.
 */

interface MyApplication {
  id: string; academic_year: string; level: string; institution: string
  programme: string; status: string; requested_amount_pkr: number
  merit_score: number | null; need_score: number | null; total_score: number | null
}

const LEVELS = ['intermediate', 'diploma', 'bachelors', 'masters', 'technical_certificate', 'medical', 'engineering', 'other'] as const
const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

const STATUS_TONE: Record<string, string> = {
  submitted: 'bg-amber-100 text-amber-800',
  screening: 'bg-sky-100 text-sky-800',
  interview: 'bg-violet-100 text-violet-800',
  approved: 'bg-emerald-100 text-emerald-800',
  waitlisted: 'bg-slate-100 text-slate-700',
  declined: 'bg-slate-100 text-slate-500',
}

export default function PortalWazifaPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const { user: portalUser } = usePortalUser()

  const [mine, setMine] = useState<MyApplication[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    father_name: '', gender: 'male', is_orphan: false,
    household_monthly_income_pkr: 0, siblings_studying: 0,
    level: 'bachelors', institution: '', programme: '', city: '',
    admission_status: 'seeking',
    last_exam_name: '', last_exam_marks: 0, last_exam_total: 0,
    requested_amount_pkr: 0, need_statement: '', achievements: '',
  })

  const load = useCallback(async () => {
    const [{ data: apps }, { data: sum }] = await Promise.all([
      supabase.from('wazifa_applications')
        .select('id, academic_year, level, institution, programme, status, requested_amount_pkr, merit_score, need_score, total_score')
        .order('created_at', { ascending: false }),
      supabase.rpc('public_wazifa_summary'),
    ])
    setMine((apps ?? []) as MyApplication[])
    setSummary((sum ?? {}) as Record<string, number>)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const submit = async () => {
    if (!portalUser) { toast.error(t('pwz.err.login')); return }
    if (!form.institution.trim() || !form.programme.trim()) { toast.error(t('pwz.err.required')); return }
    if (!form.need_statement.trim()) { toast.error(t('pwz.err.statement')); return }
    setBusy(true)

    // One student row per person, reused across years so their history stays
    // in one place rather than becoming a new applicant every session.
    const { data: existing } = await supabase.from('wazifa_students')
      .select('id').eq('portal_user_id', portalUser.id).maybeSingle()

    let studentId = existing?.id
    if (!studentId) {
      const { data: created, error } = await supabase.from('wazifa_students').insert({
        full_name: portalUser.full_name,
        father_name: form.father_name || null,
        phone: portalUser.mobile ?? null,
        gender: form.gender,
        is_orphan: form.is_orphan,
        household_monthly_income_pkr: form.household_monthly_income_pkr,
        siblings_studying: form.siblings_studying,
        portal_user_id: portalUser.id,
        status: 'applicant',
      }).select('id').single()
      if (error) { setBusy(false); toast.error(friendlyError(error)); return }
      studentId = created.id
    }

    const year = `${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`
    const percent = form.last_exam_total > 0
      ? Math.round((form.last_exam_marks / form.last_exam_total) * 10000) / 100
      : null

    const { error: appErr } = await supabase.from('wazifa_applications').insert({
      student_id: studentId, academic_year: year,
      level: form.level, institution: form.institution.trim(),
      programme: form.programme.trim(), city: form.city || null,
      admission_status: form.admission_status,
      last_exam_name: form.last_exam_name || null,
      last_exam_marks: form.last_exam_marks || null,
      last_exam_total: form.last_exam_total || null,
      last_exam_percent: percent,
      requested_amount_pkr: form.requested_amount_pkr,
      need_statement: form.need_statement.trim(),
      achievements: form.achievements || null,
      status: 'submitted',
    })
    setBusy(false)
    if (appErr) { toast.error(friendlyError(appErr)); return }
    toast.success(t('pwz.ok.submitted'))
    load()
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <BookOpen size={24} className="text-dp-secondary" /> {t('pwz.title')}
        </h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pwz.blurb')}</p>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {([
          ['students_supported', 'wz.card.supported'],
          ['graduated', 'wz.card.graduated'],
          ['applications_open', 'wz.card.open'],
        ] as const).map(([key, label]) => (
          <div key={key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t(label)}</p>
            <p className="font-heading text-[22px] font-bold text-dp-primary">{summary[key] ?? 0}</p>
          </div>
        ))}
      </div>

      {/* ── My applications ─────────────────────────────────────────────── */}
      {mine.length > 0 && (
        <div className="mb-6">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-3">{t('pwz.myApplications')}</h2>
          <div className="space-y-2.5">
            {mine.map((a) => (
              <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">{a.programme}</p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {a.institution} · {t(`wz.level.${a.level}`)} · {a.academic_year}
                    </p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                      {t('wz.requested')} Rs {fmt(a.requested_amount_pkr)}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_TONE[a.status] ?? 'bg-slate-100'}`}>
                    {t(`pwz.status.${a.status}`)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Apply ───────────────────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-5">
        <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-1">{t('pwz.applyTitle')}</h2>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-5">{t('pwz.applyHelp')}</p>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.fatherHusband')}</label>
              <input value={form.father_name} onChange={(e) => setForm({ ...form, father_name: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.gender')}</label>
              <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input-field">
                <option value="male">{t('kf.boy')}</option>
                <option value="female">{t('kf.girl')}</option>
              </select>
            </div>
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.siblings')}</label>
              <input type="number" min={0} value={form.siblings_studying || ''}
                onChange={(e) => setForm({ ...form, siblings_studying: +e.target.value })} className="input-field" />
            </div>
          </div>

          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.f.income')}</label>
            <input type="number" min={0} value={form.household_monthly_income_pkr || ''}
              onChange={(e) => setForm({ ...form, household_monthly_income_pkr: +e.target.value })} className="input-field" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pwz.f.incomeHint')}</p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
            <input type="checkbox" checked={form.is_orphan} onChange={(e) => setForm({ ...form, is_orphan: e.target.checked })} className="accent-dp-secondary" />
            {t('pwz.f.isOrphan')}
          </label>

          <div className="border-t border-dp-outline-variant pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.level')}</label>
                <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} className="input-field">
                  {LEVELS.map((l) => <option key={l} value={l}>{t(`wz.level.${l}`)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.programme')}</label>
                <input value={form.programme} onChange={(e) => setForm({ ...form, programme: e.target.value })}
                  placeholder={t('pwz.f.programmePlaceholder')} className="input-field" />
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

            <div className="mt-3">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.f.admissionStatus')}</label>
              <select value={form.admission_status} onChange={(e) => setForm({ ...form, admission_status: e.target.value })} className="input-field">
                <option value="seeking">{t('pwz.adm.seeking')}</option>
                <option value="admitted">{t('pwz.adm.admitted')}</option>
                <option value="enrolled">{t('pwz.adm.enrolled')}</option>
                <option value="deferred">{t('pwz.adm.deferred')}</option>
              </select>
            </div>
          </div>

          <div className="border-t border-dp-outline-variant pt-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="sm:col-span-2">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.lastExam')}</label>
              <input value={form.last_exam_name} onChange={(e) => setForm({ ...form, last_exam_name: e.target.value })}
                placeholder="Matric / FSc / BA" className="input-field" />
            </div>
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.f.marks')}</label>
              <input type="number" min={0} value={form.last_exam_marks || ''}
                onChange={(e) => setForm({ ...form, last_exam_marks: +e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.f.outOf')}</label>
              <input type="number" min={0} value={form.last_exam_total || ''}
                onChange={(e) => setForm({ ...form, last_exam_total: +e.target.value })} className="input-field" />
            </div>
          </div>

          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('wz.f.requested')}</label>
            <input type="number" min={0} value={form.requested_amount_pkr || ''}
              onChange={(e) => setForm({ ...form, requested_amount_pkr: +e.target.value })} className="input-field" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pwz.f.requestedHint')}</p>
          </div>

          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.f.statement')}</label>
            <textarea value={form.need_statement} onChange={(e) => setForm({ ...form, need_statement: e.target.value })}
              rows={4} placeholder={t('pwz.f.statementPlaceholder')} className="input-field resize-none" />
          </div>

          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pwz.f.achievements')}</label>
            <textarea value={form.achievements} onChange={(e) => setForm({ ...form, achievements: e.target.value })}
              rows={2} className="input-field resize-none" />
          </div>

          <button disabled={busy} onClick={submit}
            className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
            <Send size={16} /> {busy ? t('action.saving') : t('pwz.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
