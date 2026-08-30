'use client'

// The portal half of self-enrollment (372): pick a batch (age/capacity
// already filtered/shown here so a parent doesn't submit a request that's
// going to be rejected on age grounds or bounce off a full batch), fill
// in the student, and request a seat. Nothing here charges a fee or
// reserves anything final — request_training_enrollment() lands the row
// as 'pending'; a trainer/accountant confirms it from /admin/academy-fees
// before it becomes a real, billable enrollment.

import { useEffect, useState, use as useUnwrap } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ArrowLeft, Users } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import Link from 'next/link'

interface Batch {
  id: string; label: string; label_ur: string | null; schedule_note: string | null
  age_min: number | null; age_max: number | null; session_days: number[] | null; session_time: string | null
  fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null
  fee_villager_full_pkr: number | null; fee_outsider_full_pkr: number | null
  sibling_discount_pct: number | null; capacity: number | null; spots_left: number | null
}

const DAY_KEYS = ['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat']

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function feeFor(b: Batch, participantType: string, feeType: string) {
  if (feeType === 'monthly') return participantType === 'villager' ? (b.fee_villager_monthly_pkr ?? 0) : (b.fee_outsider_monthly_pkr ?? 0)
  return participantType === 'villager' ? (b.fee_villager_full_pkr ?? 0) : (b.fee_outsider_full_pkr ?? 0)
}

export default function JoinAcademyPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = useUnwrap(params)
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [projectTitle, setProjectTitle] = useState('')
  const [batches, setBatches] = useState<Batch[]>([])
  const [hasSibling, setHasSibling] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    batch_id: '', student_name: '', student_name_ur: '', student_age: '',
    guardian_name: '', guardian_whatsapp_number: '', address: '', sector: '',
    participant_type: 'villager', fee_type: 'monthly',
  })
  // Account-history detection (hasSibling below) only ever catches a 2nd
  // child registered from the SAME portal login — it misses an elder
  // sibling with their own account, or a different parent/guardian
  // registering the first child. This is the explicit alternative: the
  // parent names who the sibling is, admin sees the claim (discount_reason)
  // and can still correct it at confirmation if it doesn't check out.
  const [claimSibling, setClaimSibling] = useState(false)
  const [siblingNote, setSiblingNote] = useState('')

  const load = async () => {
    const [{ data: proj }, { data: batchRows }, { data: feeRows }] = await Promise.all([
      supabase.from('projects').select('title, display_name').eq('id', projectId).maybeSingle(),
      supabase.rpc('training_batches_for_join', { p_project_id: projectId }),
      supabase.rpc('my_training_fees'),
    ])
    setProjectTitle(proj ? (proj.display_name || proj.title) : '')
    const rows = (batchRows ?? []) as Batch[]
    setBatches(rows)
    setForm((f) => ({ ...f, batch_id: rows[0]?.id ?? '' }))
    // A 2nd (or later) request from this account qualifies for the
    // sibling discount, regardless of which academy/batch the first one
    // was for — same rule request_training_enrollment() itself applies.
    setHasSibling(((feeRows ?? []) as { status: string }[]).some((f) => f.status === 'pending' || f.status === 'active'))
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Prefill from the signed-in profile once it's loaded — a returning
  // parent shouldn't retype their own name/WhatsApp for every child.
  useEffect(() => {
    if (!userLoading && user) {
      setForm((f) => ({
        ...f,
        guardian_name: f.guardian_name || user.full_name || '',
        guardian_whatsapp_number: f.guardian_whatsapp_number || user.whatsapp_number || user.mobile || '',
        sector: f.sector || user.sector || '',
        participant_type: user.donor_type === 'outsider' ? 'outsider' : 'villager',
      }))
    }
  }, [userLoading, user])

  const selectedBatch = batches.find((b) => b.id === form.batch_id) ?? null
  const isFull = selectedBatch?.spots_left === 0
  const baseFee = selectedBatch ? feeFor(selectedBatch, form.participant_type, form.fee_type) : 0
  const siblingEligible = hasSibling || (claimSibling && siblingNote.trim().length > 0)
  const applicableDiscount = siblingEligible && selectedBatch?.sibling_discount_pct ? selectedBatch.sibling_discount_pct : 0
  const previewFee = applicableDiscount > 0 ? Math.max(0, baseFee - (baseFee * applicableDiscount) / 100) : baseFee

  const submit = async () => {
    if (!form.batch_id) { toast.error(t('tp.pickBatch')); return }
    if (!form.student_name.trim() || !form.guardian_whatsapp_number.trim()) {
      toast.error(t('af.requiredFields')); return
    }
    if (claimSibling && !siblingNote.trim()) { toast.error(t('tp.siblingNameRequired')); return }
    setSaving(true)
    const { error } = await supabase.rpc('request_training_enrollment', {
      p_batch_id: form.batch_id, p_student_name: form.student_name, p_student_name_ur: form.student_name_ur || null,
      p_student_age: form.student_age ? Number(form.student_age) : null,
      p_guardian_name: form.guardian_name || null, p_guardian_whatsapp_number: form.guardian_whatsapp_number,
      p_address: form.address || null, p_sector: form.sector || null,
      p_participant_type: form.participant_type, p_fee_type: form.fee_type,
      p_sibling_note: claimSibling ? siblingNote.trim() : null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tp.requestSubmittedToast'))
    router.push('/portal/training-programs')
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/training-programs" className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13px] font-semibold mb-4 hover:underline">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('tp.backToMyFees')}
      </Link>
      <h1 className="font-heading text-[22px] font-bold text-dp-primary flex items-center gap-2 mb-1">
        <Users size={20} className="text-dp-secondary" /> {projectTitle}
      </h1>
      <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-6">{t('tp.joinFormHint')}</p>

      {loading ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('action.loading')}</p>
      ) : batches.length === 0 ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('af.noBatches')}</p>
      ) : (
        <div className="space-y-4 max-w-[560px]">
          <div>
            <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-2">{t('tp.pickBatch')}</p>
            <div className="space-y-2">
              {batches.map((b) => {
                const full = b.spots_left === 0
                return (
                  <button key={b.id} type="button" disabled={full}
                    onClick={() => setForm({ ...form, batch_id: b.id })}
                    className={`w-full text-left border rounded-lg p-3.5 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      form.batch_id === b.id ? 'border-dp-secondary bg-dp-secondary-container/20' : 'border-dp-outline-variant bg-white'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{isUrdu && b.label_ur ? b.label_ur : b.label}</p>
                      {full ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-error/10 text-dp-error uppercase shrink-0">{t('tp.batchFull')}</span>
                      ) : b.spots_left != null ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">{b.spots_left} {t('tp.spotsLeft')}</span>
                      ) : null}
                    </div>
                    {b.schedule_note && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{b.schedule_note}</p>}
                    <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1 flex flex-wrap gap-x-2">
                      {(b.age_min != null || b.age_max != null) && <span>{t('af.agesLabel')} {b.age_min ?? 0}–{b.age_max ?? '∞'}</span>}
                      {b.session_days && b.session_days.length > 0 && (
                        <span>· {b.session_days.map((d) => t(DAY_KEYS[d])).join(', ')}{b.session_time ? ` @ ${b.session_time.slice(0, 5)}` : ''}</span>
                      )}
                    </p>
                    {!!b.sibling_discount_pct && (
                      <p className="font-sans text-[10.5px] text-dp-on-surface-variant mt-1">{t('tp.siblingDiscountAvailableNote').replace('{pct}', String(b.sibling_discount_pct))}</p>
                    )}
                    {siblingEligible && !!b.sibling_discount_pct && (
                      <p className="font-sans text-[11px] text-dp-secondary font-semibold mt-1">{t('tp.siblingDiscountNote').replace('{pct}', String(b.sibling_discount_pct))}</p>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <input value={form.student_name} onChange={(e) => setForm({ ...form, student_name: e.target.value })} placeholder={t('af.studentName')} className="input-field" />
          <input type="number" value={form.student_age} onChange={(e) => setForm({ ...form, student_age: e.target.value })} placeholder={t('tp.studentAge')} className="input-field" />
          <input value={form.guardian_name} onChange={(e) => setForm({ ...form, guardian_name: e.target.value })} placeholder={t('af.guardianName')} className="input-field" />
          <input value={form.guardian_whatsapp_number} onChange={(e) => setForm({ ...form, guardian_whatsapp_number: e.target.value })} placeholder={t('af.guardianWhatsapp')} className="input-field" />
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={t('z.location')} className="input-field" />
          <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} placeholder={t('w.sector')} className="input-field" />

          {!hasSibling && (
            <div className="border border-dp-outline-variant rounded-lg p-3.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={claimSibling} onChange={(e) => setClaimSibling(e.target.checked)} className="accent-dp-secondary" />
                <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('tp.claimSiblingLabel')}</span>
              </label>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 ms-6">{t('tp.claimSiblingHint')}</p>
              {claimSibling && (
                <input value={siblingNote} onChange={(e) => setSiblingNote(e.target.value)} placeholder={t('tp.siblingNamePlaceholder')}
                  className="input-field mt-2.5" />
              )}
            </div>
          )}

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

          {selectedBatch && (
            <p className="font-sans text-[13px] font-semibold text-dp-primary bg-dp-secondary-container/20 rounded-lg px-3 py-2">
              {t('tp.feePreview')}: {applicableDiscount > 0 && (
                <span className="line-through text-dp-on-surface-variant font-normal me-1.5">Rs. {fmt(baseFee)}</span>
              )}
              Rs. {fmt(previewFee)} / {t(form.fee_type === 'monthly' ? 'af.perMonth' : 'af.fullCourse')}
            </p>
          )}

          <button onClick={submit} disabled={saving || isFull} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
            {saving ? t('af.saving') : t('tp.submitRequestBtn')}
          </button>
        </div>
      )}
    </div>
  )
}
