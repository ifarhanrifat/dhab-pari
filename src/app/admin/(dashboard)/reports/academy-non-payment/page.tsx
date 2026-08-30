'use client'

// Same shape as /admin/reports/non-payment (water), just simpler — a
// training fee charge is either paid or it isn't, no "2 consecutive
// months" pattern to detect first. Grouped by academy instead of sector.
//
// RLS does the same narrowing here it does everywhere else in this
// feature: a full accountant sees every academy's overdue students; a
// scoped trainer (training_fee_charges_trainer, migration 367) only ever
// sees their own academy's, with zero extra code in this file.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, Printer, Phone } from 'lucide-react'
import { printNodeInPopup } from '@/lib/receiptExport'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import { dt, type Lang } from '@/lib/docTranslations'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface ChargeRow { id: string; enrollment_id: string; charge_no: number; due_on: string; amount_pkr: number; paid_pkr: number; status: string }
interface EnrollmentRow { id: string; student_name: string; guardian_name: string | null; guardian_whatsapp_number: string | null; project_id: string }
interface ProjectRow { id: string; title: string; display_name: string | null }

interface FlaggedCharge { id: string; charge_no: number; due_on: string; outstanding: number }
interface FlaggedStudent { enrollment: EnrollmentRow; charges: FlaggedCharge[]; totalOutstanding: number }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
const monthName = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

export default function AcademyNonPaymentReportPage() {
  const { t, isUrdu } = useLocale()
  const [charges, setCharges] = useState<ChargeRow[]>([])
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [academyFilter, setAcademyFilter] = useState('')
  const lang: Lang = isUrdu ? 'ur' : 'en'
  const printRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  useEffect(() => {
    setLoading(true)
    Promise.all([
      supabase.from('training_fee_charges').select('id, enrollment_id, charge_no, due_on, amount_pkr, paid_pkr, status').in('status', ['due', 'part_paid']),
      supabase.from('training_enrollments').select('id, student_name, guardian_name, guardian_whatsapp_number, project_id').eq('status', 'active'),
      supabase.from('projects').select('id, title, display_name').in('category', ['sports', 'training']),
    ]).then(([chargesRes, enrollRes, projRes]) => {
      setCharges(chargesRes.data ?? [])
      setEnrollments(enrollRes.data ?? [])
      setProjects(projRes.data ?? [])
      setLoading(false)
    })
  }, [supabase])

  const flagged = useMemo<FlaggedStudent[]>(() => {
    const enrollmentById = Object.fromEntries(enrollments.map((e) => [e.id, e]))
    const today = new Date().toISOString().split('T')[0]
    const chargesByEnrollment: Record<string, ChargeRow[]> = {}
    for (const c of charges) {
      if (!enrollmentById[c.enrollment_id]) continue
      if (c.due_on >= today) continue // not overdue yet, just due-but-not-late
      ;(chargesByEnrollment[c.enrollment_id] ??= []).push(c)
    }
    const result: FlaggedStudent[] = []
    for (const [enrollmentId, eCharges] of Object.entries(chargesByEnrollment)) {
      const flaggedCharges: FlaggedCharge[] = eCharges
        .map((c) => ({ id: c.id, charge_no: c.charge_no, due_on: c.due_on, outstanding: c.amount_pkr - c.paid_pkr }))
        .sort((a, b) => a.due_on.localeCompare(b.due_on))
      result.push({
        enrollment: enrollmentById[enrollmentId],
        charges: flaggedCharges,
        totalOutstanding: flaggedCharges.reduce((s, c) => s + c.outstanding, 0),
      })
    }
    return result.sort((a, b) => b.totalOutstanding - a.totalOutstanding)
  }, [charges, enrollments])

  const projectById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects])
  const academyLabel = (id: string) => { const p = projectById[id]; return p ? (p.display_name || p.title) : '' }

  const filtered = useMemo(
    () => flagged.filter((f) => !academyFilter || f.enrollment.project_id === academyFilter),
    [flagged, academyFilter]
  )

  const byAcademy = useMemo(() => {
    const groups: Record<string, FlaggedStudent[]> = {}
    for (const f of filtered) {
      const key = academyLabel(f.enrollment.project_id) || f.enrollment.project_id
      ;(groups[key] ??= []).push(f)
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, projectById])

  const totalPending = filtered.reduce((s, f) => s + f.totalOutstanding, 0)

  const handlePrint = () => {
    if (printRef.current) printNodeInPopup(printRef.current, dt(lang, 'reportTrainingNonPayment'))
  }

  return (
    <div ref={printRef} dir={lang === 'ur' ? 'rtl' : 'ltr'} style={lang === 'ur' ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
      <DocumentHeader title={dt(lang, 'reportTrainingNonPayment')} className="hidden print:block" />
      <div className="flex items-center justify-between mb-6 print:hidden gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2">
            <AlertTriangle size={24} className="text-amber-600" /> {dt(lang, 'reportTrainingNonPayment')}
          </h1>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{dt(lang, 'trainingNonPaymentSubtitle')}</p>
        </div>
        <button onClick={handlePrint} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <Printer size={15} /> {t('a.print')}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6 print:hidden">
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-1">{dt(lang, 'studentsFlagged')}</p>
          <p className="font-sans text-[20px] font-bold text-dp-primary">{filtered.length}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-1">{dt(lang, 'academiesAffected')}</p>
          <p className="font-sans text-[20px] font-bold text-dp-primary">{byAcademy.length}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-1">{dt(lang, 'totalPendingFees')}</p>
          <p className="font-sans text-[20px] font-bold text-dp-error">{fmtAmount(totalPending)}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4 print:hidden">
        <select value={academyFilter} onChange={(e) => setAcademyFilter(e.target.value)} className="input-field max-w-xs">
          <option value="">{t('af.allAcademies')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.display_name || p.title}</option>)}
        </select>
      </div>

      {loading && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[13.5px]">{t('action.loading')}</p>}
      {!loading && filtered.length === 0 && (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[13.5px]">{dt(lang, 'noStudentsFailedToPay')}</p>
      )}

      {!loading && byAcademy.map(([academy, list]) => (
        <div key={academy} className="mb-6">
          <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-2 flex items-center gap-2">
            {academy}
            <span className="font-sans text-[12px] font-semibold text-dp-on-surface-variant bg-dp-surface-container-low px-2 py-0.5 rounded-full">
              {list.length}
            </span>
          </h2>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden overflow-x-auto">
            <table className="w-full text-start">
              <thead>
                <tr className="bg-dp-surface-container-low/60 border-b border-dp-outline-variant">
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant">{t('af.studentName')}</th>
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant">{dt(lang, 'contact')}</th>
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant">{dt(lang, 'pendingCharges')}</th>
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant text-end">{dt(lang, 'totalOutstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.enrollment.id} className="border-b border-dp-outline-variant last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{f.enrollment.student_name}</p>
                      {f.enrollment.guardian_name && <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{dt(lang, 'guardianLabel')}: {f.enrollment.guardian_name}</p>}
                    </td>
                    <td className="px-4 py-3 font-sans text-[13px] text-dp-on-surface-variant">
                      {f.enrollment.guardian_whatsapp_number ? (
                        <span className="flex items-center gap-1"><Phone size={12} /> <span className="ltr-num">{f.enrollment.guardian_whatsapp_number}</span></span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {f.charges.map((c) => (
                        <div key={c.id} className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          {monthName(c.due_on)} — {fmtAmount(c.outstanding)}{dt(lang, 'dueSuffix')}
                        </div>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-end font-sans text-[14px] font-bold text-dp-error">{fmtAmount(f.totalOutstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
