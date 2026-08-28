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
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Layers, Clock, CheckCircle2, Hourglass, XCircle, ArrowRight, Users } from 'lucide-react'
import { PortalHelp } from '@/components/portal/PortalHelp'
import Link from 'next/link'

interface MyFee {
  enrollment_id: string; project_id: string; status: string; program_title: string; batch_label: string | null; student_name: string
  fee_type: string; monthly_amount_pkr: number; total_paid: number; total_overdue: number; rejected_reason: string | null
  due_soon: { id: string; due_on: string; amount: number; paid: number; status: string }[]
}
interface Academy { id: string; title: string; display_name: string | null; category: string }
interface Batch {
  id: string; project_id: string; label: string; label_ur: string | null
  fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null
  fee_villager_full_pkr: number | null; fee_outsider_full_pkr: number | null
  sibling_discount_pct: number | null; capacity: number | null; spots_left: number | null
}

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
  if ((f.due_soon ?? []).length > 0) return <p className="font-sans text-[11.5px] text-amber-700 flex items-center gap-1"><Clock size={10} /> Rs. {fmt(f.due_soon[0].amount)}</p>
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
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [{ data: fees }, { data: acads }, { data: batchRows }] = await Promise.all([
      user ? supabase.rpc('my_training_fees') : Promise.resolve({ data: [] }),
      supabase.from('projects').select('id, title, display_name, category')
        .in('category', ['sports', 'training']).in('status', ['ongoing', 'upcoming']).order('created_at', { ascending: false }),
      supabase.rpc('training_batches_public'),
    ])
    setMyFees((fees ?? []) as MyFee[])
    setAcademies(acads ?? [])
    setBatches((batchRows ?? []) as Batch[])
    setLoading(false)
  }
  useEffect(() => { if (!userLoading) load() }, [userLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  const isVillager = user?.donor_type !== 'outsider'

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
            return (
              <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <p className="font-sans text-[15px] font-bold text-dp-primary">{a.display_name || a.title}</p>

                {academyBatches.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {academyBatches.map((b) => {
                      const monthly = isVillager ? b.fee_villager_monthly_pkr : b.fee_outsider_monthly_pkr
                      const full = isVillager ? b.fee_villager_full_pkr : b.fee_outsider_full_pkr
                      const isFree = !monthly && !full
                      const full_ = b.spots_left === 0
                      return (
                        <div key={b.id} className="flex items-center justify-between gap-2 text-[12.5px] font-sans">
                          <span className="text-dp-on-surface truncate">{isUrdu && b.label_ur ? b.label_ur : b.label}</span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            <span className="text-dp-on-surface-variant">
                              {isFree ? t('tp.freeLabel') : `Rs. ${fmt(monthly || full || 0)}${monthly ? `/${t('af.perMonth')}` : ` ${t('af.fullCourse')}`}`}
                            </span>
                            {b.capacity != null && (
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase ${full_ ? 'bg-dp-error/10 text-dp-error' : 'bg-emerald-100 text-emerald-700'}`}>
                                {full_ ? t('tp.batchFull') : `${b.spots_left} ${t('tp.spotsLeft')}`}
                              </span>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {bestSiblingDiscount > 0 && (
                  <p className="font-sans text-[11.5px] text-dp-secondary font-semibold mt-2">{t('tp.siblingDiscountNote').replace('{pct}', String(bestSiblingDiscount))}</p>
                )}

                {myRowsHere.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-dp-outline-variant space-y-2">
                    {myRowsHere.map((f) => (
                      <div key={f.enrollment_id} className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface flex items-center gap-1"><Users size={11} className="text-dp-on-surface-variant shrink-0" /> {f.student_name}</p>
                          <FeeStatus f={f} t={t} />
                        </div>
                        {f.status === 'active' && (f.due_soon ?? []).length > 0 && (
                          <Link href={`/portal/donate?project=${f.project_id}`} className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[11.5px] font-semibold hover:bg-dp-primary transition-colors shrink-0">
                            {t('tp.payFeeBtn')}
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <Link href={`/portal/training-programs/join/${a.id}`} className="mt-3 flex items-center justify-center gap-1 w-full py-2 border-2 border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-colors">
                  {myRowsHere.length > 0 ? t('tp.bookAnotherBtn') : t('tp.joinBtn')} <ArrowRight size={12} className={isUrdu ? 'rotate-180' : ''} />
                </Link>
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
                {f.status === 'active' && (f.due_soon ?? []).length > 0 && (
                  <Link href={`/portal/donate?project=${f.project_id}`} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-colors">
                    {t('tp.payFeeBtn')}
                  </Link>
                )}
              </div>
            ))}
          </div>
        )
      })()}

      {!loading && academies.length === 0 && myFees.length === 0 && (
        <p className="font-sans text-[13px] text-dp-on-surface-variant mt-4">{t('tp.noneEnrolled')}</p>
      )}
    </div>
  )
}
