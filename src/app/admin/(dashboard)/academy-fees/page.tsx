'use client'

// Fee-charging sports/training academies — enroll a student, see their fee
// status, and record a payment. Academies themselves are just `projects`
// rows (category='sports'/'training', migration 366) — everything about
// the card/comments/ledger-account side of "being a project" is already
// handled by the existing projects infrastructure; this page is only the
// new piece, the roster/fee layer on top.
//
// Works unmodified for both a full accountant (sees every academy, via
// training_enrollments_admin's manage_parties-gated RLS) and a scoped
// trainer (role='viewer', can_collect_payments, assigned_training_program_ids
// — sees only their own academy's roster via training_enrollments_trainer,
// migration 367). The query is identical either way; RLS does the narrowing.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Users, PlusCircle, X, HandCoins, CheckCircle2, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Academy { id: string; title: string; display_name: string | null; category: string }
interface Charge { id: string; charge_no: number; due_on: string; amount_pkr: number; paid_pkr: number; status: string }
interface Enrollment {
  id: string; student_name: string; guardian_name: string | null; guardian_whatsapp_number: string | null
  participant_type: string; fee_type: string; fee_amount_pkr: number; discount_pct: number | null
  discount_reason: string | null; status: string
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const emptyEnroll = {
  student_name: '', student_name_ur: '', guardian_name: '', guardian_whatsapp_number: '',
  address: '', sector: '', participant_type: 'villager', fee_type: 'monthly',
  discount_pct: '', discount_reason: '',
}

export default function AcademyFeesPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [academies, setAcademies] = useState<Academy[]>([])
  const [selected, setSelected] = useState<Academy | null>(null)
  const [enrollments, setEnrollments] = useState<Enrollment[]>([])
  const [charges, setCharges] = useState<Record<string, Charge[]>>({})
  const [loading, setLoading] = useState(true)
  const [showEnroll, setShowEnroll] = useState(false)
  const [form, setForm] = useState(emptyEnroll)
  const [saving, setSaving] = useState(false)
  const [payFor, setPayFor] = useState<{ chargeId: string; remaining: number; studentName: string } | null>(null)
  const [payAmount, setPayAmount] = useState(0)
  const [payMethod, setPayMethod] = useState('cash')

  const loadAcademies = async () => {
    setLoading(true)
    const { data } = await supabase.from('projects').select('id, title, display_name, category')
      .in('category', ['sports', 'training']).order('created_at', { ascending: false })
    setAcademies(data ?? [])
    setLoading(false)
  }
  useEffect(() => { loadAcademies() }, [])

  const loadRoster = async (academy: Academy) => {
    setSelected(academy)
    const { data: rows } = await supabase.from('training_enrollments')
      .select('id, student_name, guardian_name, guardian_whatsapp_number, participant_type, fee_type, fee_amount_pkr, discount_pct, discount_reason, status')
      .eq('project_id', academy.id).eq('status', 'active').order('student_name')
    setEnrollments(rows ?? [])
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

  const enroll = async () => {
    if (!selected) return
    if (!form.student_name.trim() || !form.guardian_whatsapp_number.trim()) {
      toast.error(t('af.requiredFields')); return
    }
    setSaving(true)
    const { error } = await supabase.rpc('enroll_in_training_program', {
      p_project_id: selected.id, p_student_name: form.student_name, p_student_name_ur: form.student_name_ur || null,
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
            <button onClick={() => setShowEnroll(true)} className="flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary">
              <PlusCircle size={15} /> {t('af.enrollBtn')}
            </button>
          </div>

          <div className="space-y-3">
            {enrollments.length === 0 && <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('af.noStudents')}</p>}
            {enrollments.map((e) => (
              <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="font-sans text-[15px] font-semibold text-dp-on-surface flex items-center gap-2">
                      <Users size={15} className="text-dp-on-surface-variant" /> {e.student_name}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${e.participant_type === 'villager' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                        {t(e.participant_type === 'villager' ? 'af.villager' : 'af.outsider')}
                      </span>
                    </p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                      {e.guardian_name} · {e.guardian_whatsapp_number} · Rs. {fmt(e.fee_amount_pkr)}/{t(e.fee_type === 'monthly' ? 'af.perMonth' : 'af.fullCourse')}
                      {e.discount_pct ? ` · ${e.discount_pct}% ${t('af.discount')}${e.discount_reason ? ` (${e.discount_reason})` : ''}` : ''}
                    </p>
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

      {/* Enroll modal */}
      {showEnroll && selected && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowEnroll(false)}>
          <div className="bg-white rounded-lg max-w-[520px] w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-[18px] font-bold text-dp-primary">{t('af.enrollBtn')}</h3>
              <button onClick={() => setShowEnroll(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
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
    </div>
  )
}
