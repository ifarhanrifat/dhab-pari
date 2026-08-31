'use client'

// "Academies" — every open sports/training academy as one catalog, fee
// and open-slot info shown right on the card (via training_batches_public(),
// 373) instead of needing a separate click to discover either. Booking a
// batch still goes through the dedicated join form (age-gate/capacity/
// sibling-discount logic all live there, migration 372/373) — this page
// is the browse-and-status layer on top: pick a batch here, land on the
// join form pre-scoped to it, then come back here to see the request's
// status and pay once a fee is actually due (my_training_fees(), which
// now also surfaces pending/rejected requests, not just active
// enrollments) — the same pick-a-project/pay/upload-the-slip path every
// other donation already goes through, nothing new to learn there.

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Layers, Clock, CheckCircle2, Hourglass, XCircle, ArrowRight, Users, MapPin, Cake, HandHeart, Bell, X } from 'lucide-react'
import { PortalHelp } from '@/components/portal/PortalHelp'
import Link from 'next/link'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface MyFee {
  enrollment_id: string; project_id: string; status: string; program_title: string; batch_label: string | null; student_name: string
  fee_type: string; monthly_amount_pkr: number; total_paid: number; total_overdue: number; rejected_reason: string | null
  due_soon: { id: string; due_on: string; amount: number; paid: number; status: string; announced_amount_pkr: number | null }[]
}
interface Academy {
  id: string; title: string; display_name: string | null; category: string
  after_image_url: string | null; before_image_url: string | null
  hide_fees: boolean; funding_model: string | null; monthly_operating_cost_pkr: number | null
  cover_photo_url?: string | null
}
interface Batch {
  id: string; project_id: string; label: string; label_ur: string | null
  schedule_note: string | null; schedule_note_ur: string | null; age_min: number | null; age_max: number | null
  fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null
  fee_villager_full_pkr: number | null; fee_outsider_full_pkr: number | null
  sibling_discount_pct: number | null; capacity: number | null; spots_left: number | null
}
interface Trainer { project_id: string; trainer_name: string; trainer_bio: string | null; trainer_bio_ur: string | null; trainer_photo_url: string | null }
interface FundingRow { raised: number; spent: number }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// A freshly-confirmed monthly enrollment has zero charges until the next
// daily billing run — due_soon being empty then does NOT mean "paid up",
// it means "no bill exists yet". Only total_paid > 0 (or a free program,
// monthly_amount_pkr === 0) is genuinely "nothing owed"; conflating the
// two showed a real student as "paid" the moment they were confirmed,
// with no way to tell the fee simply hadn't been raised yet.
function FeeStatus({ f, t }: { f: MyFee; t: (k: string) => string }) {
  if (f.status === 'pending') return <p className="font-sans text-[11.5px] text-amber-700 flex items-center gap-1"><Hourglass size={10} /> {t('tp.pendingLabel')}</p>
  if (f.status === 'rejected') return <p className="font-sans text-[11.5px] text-dp-error flex items-center gap-1"><XCircle size={10} /> {t('tp.rejectedLabel')}{f.rejected_reason ? ` — ${f.rejected_reason}` : ''}</p>
  // A charge sitting at 'announced' has a payment already submitted and
  // waiting on staff to confirm it against the bank statement — that's
  // not the same as still owing money, and showing it as "due" (which
  // is what it looked like before this existed at all) is exactly the
  // "I paid but it still says I owe" complaint this was built to fix.
  if ((f.due_soon ?? []).length > 0 && f.due_soon[0].status === 'announced') {
    return <p className="font-sans text-[11.5px] text-blue-700 flex items-center gap-1"><Bell size={10} /> {t('tp.paymentAwaitingConfirmation')}</p>
  }
  if ((f.due_soon ?? []).length > 0) return <p className="font-sans text-[11.5px] text-amber-700 flex items-center gap-1"><Clock size={10} /> <span className="ltr-num">{fmt(f.due_soon[0].amount)}</span></p>
  if (f.monthly_amount_pkr > 0 && f.total_paid === 0) return <p className="font-sans text-[11.5px] text-dp-on-surface-variant flex items-center gap-1"><Hourglass size={10} /> {t('tp.awaitingFirstBill')}</p>
  return <p className="font-sans text-[11.5px] text-emerald-700 flex items-center gap-1"><CheckCircle2 size={10} /> {t('tp.feeUpToDate')}</p>
}

export default function PortalTrainingProgramsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const [myFees, setMyFees] = useState<MyFee[]>([])
  const [academies, setAcademies] = useState<Academy[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [trainers, setTrainers] = useState<Trainer[]>([])
  const [funding, setFunding] = useState<Record<string, FundingRow>>({})
  // Paying a specific charge announces it against that exact row
  // (announce_training_fee_payment, 386) instead of a blind donation to
  // the project — that's the whole fix: staff confirming it is what
  // actually marks *this* charge paid, not a separate reconciliation
  // step nobody was doing.
  const [payFor, setPayFor] = useState<{ chargeId: string; remaining: number; studentName: string } | null>(null)
  const [payAmount, setPayAmount] = useState(0)
  const [payMethod, setPayMethod] = useState('bank')
  const [receiptPath, setReceiptPath] = useState('')
  const [submittingPayment, setSubmittingPayment] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [{ data: fees }, { data: acads }, { data: batchRows }, { data: trainerRows }] = await Promise.all([
      user ? supabase.rpc('my_training_fees') : Promise.resolve({ data: [] }),
      supabase.from('projects').select('id, title, display_name, category, after_image_url, before_image_url, hide_fees, funding_model, monthly_operating_cost_pkr')
        .in('category', ['sports', 'training']).in('status', ['ongoing', 'upcoming']).order('created_at', { ascending: false }),
      supabase.rpc('training_batches_public'),
      supabase.rpc('academy_trainers_public'),
    ])
    setMyFees((fees ?? []) as MyFee[])
    setAcademies(acads ?? [])
    setBatches((batchRows ?? []) as Batch[])
    setTrainers((trainerRows ?? []) as Trainer[])
    setLoading(false)

    // A designated cover (383) wins over the after/before fallback here
    // too — the home page and /projects listing already prefer it; this
    // catalog card was the one place still stuck on after_image_url only.
    const academyIds = (acads ?? []).map((a) => a.id)
    if (academyIds.length > 0) {
      const { data: coverRows } = await supabase.from('project_media').select('project_id, url').eq('is_cover', true).in('project_id', academyIds)
      if (coverRows && coverRows.length > 0) {
        const coverByProject: Record<string, string> = {}
        for (const c of coverRows) coverByProject[c.project_id] = c.url
        setAcademies((prev) => prev.map((a) => coverByProject[a.id] ? { ...a, cover_photo_url: coverByProject[a.id] } : a))
      }
    }

    // Real funding position (raised/spent) for recurring_support academies
    // (a trainer's ongoing salary) — same source as the portal dashboard
    // cards: the project's own ledger account, reversal pairs excluded.
    const salaryIds = (acads ?? []).filter((a) => a.funding_model === 'recurring_support').map((a) => a.id)
    if (salaryIds.length > 0) {
      const [{ data: incomeRows }, { data: expenseRows }] = await Promise.all([
        supabase.from('project_income_public').select('project_id, credit').in('project_id', salaryIds),
        supabase.from('project_expenses_public').select('project_id, debit').in('project_id', salaryIds),
      ])
      const computed: Record<string, FundingRow> = {}
      for (const id of salaryIds) computed[id] = { raised: 0, spent: 0 }
      for (const c of incomeRows ?? []) computed[c.project_id].raised += Number(c.credit)
      for (const e of expenseRows ?? []) computed[e.project_id].spent += Number(e.debit)
      setFunding(computed)
    }
  }
  useEffect(() => { if (!userLoading) load() }, [userLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  const isVillager = user?.donor_type !== 'outsider'

  const openPayModal = (f: MyFee) => {
    const due = f.due_soon?.[0]
    if (!due) return
    setPayFor({ chargeId: due.id, remaining: due.amount - due.paid, studentName: f.student_name })
    setPayAmount(due.amount - due.paid)
    setPayMethod('bank')
    setReceiptPath('')
  }

  const submitPayment = async () => {
    if (!payFor || payAmount <= 0 || !receiptPath) { toast.error(t('tp.paymentRequiredFields')); return }
    setSubmittingPayment(true)
    const { error } = await supabase.rpc('announce_training_fee_payment', {
      p_charge_id: payFor.chargeId, p_amount: payAmount, p_method: payMethod, p_proof_url: receiptPath,
    })
    setSubmittingPayment(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tp.paymentAnnouncedToast'))
    setPayFor(null)
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Layers size={22} className="text-dp-secondary" /> {t('tp.academiesTitle')} <PortalHelp pageKey="trainingPrograms" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('tp.portalBlurb')}</p>
      </div>

      {loading ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('action.loading')}</p>
      ) : academies.length === 0 ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('tp.noAcademiesOpen')}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {academies.map((a) => {
            const academyBatches = batches.filter((b) => b.project_id === a.id)
            const myRowsHere = myFees.filter((f) => f.project_id === a.id)
            const bestSiblingDiscount = Math.max(0, ...academyBatches.map((b) => b.sibling_discount_pct ?? 0))
            const trainer = trainers.find((tr) => tr.project_id === a.id)
            const cover = a.cover_photo_url || a.after_image_url || a.before_image_url
            const isSalaryFunded = a.funding_model === 'recurring_support'
            const f = funding[a.id]
            return (
              <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                {cover && (
                  <Link href={`/projects/${a.id}`} className="relative w-full h-32 block">
                    <Image src={cover} alt="" fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
                  </Link>
                )}
                <div className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-sans text-[15px] font-bold text-dp-primary">{a.display_name || a.title}</p>
                  {/* Full gallery + intro video (if this academy has one) live
                      on the public detail page rather than duplicated into
                      this compact card — same content, no second copy. */}
                  <Link href={`/projects/${a.id}`} className="text-[11px] font-sans font-semibold text-dp-secondary hover:underline shrink-0">
                    {t('tp.viewPhotosVideoLink')}
                  </Link>
                </div>

                {academyBatches.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {academyBatches.map((b) => {
                      const monthly = isVillager ? b.fee_villager_monthly_pkr : b.fee_outsider_monthly_pkr
                      const full = isVillager ? b.fee_villager_full_pkr : b.fee_outsider_full_pkr
                      const isFree = !monthly && !full
                      const full_ = b.spots_left === 0
                      const ageRange = b.age_min != null || b.age_max != null
                        ? b.age_min != null && b.age_max != null ? `${b.age_min}–${b.age_max}` : `${b.age_min ?? b.age_max}+`
                        : null
                      return (
                        <div key={b.id} className="text-[12.5px] font-sans border-b border-dp-outline-variant/50 last:border-b-0 pb-2 last:pb-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-dp-on-surface font-semibold truncate">{isUrdu && b.label_ur ? b.label_ur : b.label}</span>
                            {b.capacity != null && (
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase shrink-0 ${full_ ? 'bg-dp-error/10 text-dp-error' : 'bg-emerald-100 text-emerald-700'}`}>
                                {full_ ? t('tp.batchFull') : `${b.spots_left} ${t('tp.spotsLeft')}`}
                              </span>
                            )}
                          </div>
                          {(b.schedule_note || ageRange) && (
                            <div className="flex items-center gap-2.5 mt-0.5 text-[11px] text-dp-on-surface-variant">
                              {b.schedule_note && <span className="flex items-center gap-1"><MapPin size={10} className="shrink-0" /> {isUrdu ? (b.schedule_note_ur || b.schedule_note) : b.schedule_note}</span>}
                              {ageRange && <span className="flex items-center gap-1"><Cake size={10} className="shrink-0" /> {t('tp.agesLabel')} {ageRange}</span>}
                            </div>
                          )}
                          <div className="mt-0.5 text-dp-on-surface-variant">
                            {a.hide_fees
                              ? t('tp.feeHiddenLabel')
                              : isFree ? t('tp.freeLabel') : <><span className="ltr-num">{fmt(monthly || full || 0)}</span>{monthly ? `/${t('af.perMonth')}` : ` ${t('af.fullCourse')}`}</>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {bestSiblingDiscount > 0 && !a.hide_fees && (
                  <p className="font-sans text-[11.5px] text-dp-secondary font-semibold mt-2">{t('tp.siblingDiscountAvailableNote').replace('{pct}', String(bestSiblingDiscount))}</p>
                )}

                {trainer && (
                  <div className="mt-3 pt-3 border-t border-dp-outline-variant flex items-center gap-2.5">
                    {trainer.trainer_photo_url ? (
                      <div className="relative w-9 h-9 rounded-full overflow-hidden shrink-0 bg-dp-surface-container">
                        <Image src={trainer.trainer_photo_url} alt="" fill sizes="36px" className="object-cover" />
                      </div>
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-dp-secondary-container text-dp-on-secondary-container flex items-center justify-center shrink-0 font-heading text-[13px] font-bold">
                        {trainer.trainer_name.charAt(0)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-wide">{t('tp.meetYourTrainer')}</p>
                      <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface truncate">{trainer.trainer_name}</p>
                      {(isUrdu ? trainer.trainer_bio_ur || trainer.trainer_bio : trainer.trainer_bio) && (
                        <p className="font-sans text-[11.5px] text-dp-on-surface-variant line-clamp-2">{isUrdu ? trainer.trainer_bio_ur || trainer.trainer_bio : trainer.trainer_bio}</p>
                      )}
                    </div>
                  </div>
                )}

                {isSalaryFunded && f && (
                  <div className="mt-3 pt-3 border-t border-dp-outline-variant">
                    <div className="flex items-center justify-between gap-1 font-sans text-[11px] text-dp-on-surface-variant mb-2">
                      <span>{t('pj.raisedShort')} <span className="ltr-num">{fmt(f.raised)}</span></span>
                      <span>{t('pj.spentShort')} <span className="ltr-num">{fmt(f.spent)}</span></span>
                    </div>
                    <Link href={`/portal/donate?project=${a.id}`}
                      className="flex items-center justify-center gap-1 w-full py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-colors">
                      <HandHeart size={13} /> {t('p.donateNow')}
                    </Link>
                  </div>
                )}

                {myRowsHere.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-dp-outline-variant space-y-2">
                    {myRowsHere.map((f) => (
                      <div key={f.enrollment_id} className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface flex items-center gap-1"><Users size={11} className="text-dp-on-surface-variant shrink-0" /> {f.student_name}</p>
                          <FeeStatus f={f} t={t} />
                        </div>
                        {f.status === 'active' && (f.due_soon ?? []).length > 0 && f.due_soon[0].status !== 'announced' && (
                          <button onClick={() => openPayModal(f)} className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-dp-primary transition-colors shrink-0 cursor-pointer">
                            {t('tp.payFeeBtn')}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <Link href={`/portal/training-programs/join/${a.id}`} className="mt-3 flex items-center justify-center gap-1 w-full py-2 border-2 border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-colors">
                  {myRowsHere.length > 0 ? t('tp.bookAnotherBtn') : t('tp.joinBtn')} <ArrowRight size={12} className={isUrdu ? 'rotate-180' : ''} />
                </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* An enrollment in an academy that's since left the open list (e.g.
          marked completed) — still shown, so a fee never quietly vanishes
          from view just because the program itself isn't "open" anymore. */}
      {(() => {
        const openIds = new Set(academies.map((a) => a.id))
        const orphaned = myFees.filter((f) => !openIds.has(f.project_id))
        if (orphaned.length === 0) return null
        return (
          <div className="mt-4 space-y-2">
            {orphaned.map((f) => (
              <div key={f.enrollment_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="font-sans text-[14px] font-bold text-dp-on-surface">{f.student_name} — {f.program_title}</p>
                  {f.batch_label && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{f.batch_label}</p>}
                  <FeeStatus f={f} t={t} />
                </div>
                {f.status === 'active' && (f.due_soon ?? []).length > 0 && f.due_soon[0].status !== 'announced' && (
                  <button onClick={() => openPayModal(f)} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-colors cursor-pointer">
                    {t('tp.payFeeBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      })()}

      {!loading && academies.length === 0 && myFees.length === 0 && (
        <p className="font-sans text-[13px] text-dp-on-surface-variant mt-4">{t('tp.noneEnrolled')}</p>
      )}

      {payFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayFor(null)}>
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white rounded-lg max-w-[420px] w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-[18px] font-bold text-dp-primary">{payFor.studentName}</h3>
              <button onClick={() => setPayFor(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('tp.paymentModalHint')}</p>
            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                <input type="number" min={1} max={payFor.remaining} value={payAmount || ''} onChange={(e) => setPayAmount(+e.target.value)} className="input-field" />
              </div>
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="input-field">
                <option value="bank">{t('w.bankTransfer')}</option>
                <option value="jazzcash">JazzCash</option>
                <option value="easypaisa">Easypaisa</option>
              </select>
              <DonationReceiptUpload onUpload={setReceiptPath} />
              <button onClick={submitPayment} disabled={submittingPayment || payAmount <= 0 || !receiptPath} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                {submittingPayment ? t('p.submitting') : t('tp.submitPaymentBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
