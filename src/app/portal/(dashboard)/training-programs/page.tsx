'use client'

// The old free-workshop browse/register list (training_programs) is
// retired — every training/sports activity, paid or free, is now a real
// project (migration 366/370), visible and joinable as a normal card on
// the public site. This page has two halves now: "Academies you can
// join" (any open sports/training project — Join sends a request via
// request_training_enrollment(), 372) and "My academy fees" (via
// my_training_fees(), now also surfacing pending/rejected requests, not
// just active enrollments), with a link straight into the normal Donate
// flow (pre-selected project) for self-service fee payment — the same
// pick-a-project/pay/upload-the-slip path every other donation goes
// through, nothing new to learn.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { HandCoins, Clock, CheckCircle2, Hourglass, XCircle, ArrowRight } from 'lucide-react'
import { PortalHelp } from '@/components/portal/PortalHelp'
import Link from 'next/link'

interface MyFee {
  enrollment_id: string; project_id: string; status: string; program_title: string; batch_label: string | null; student_name: string
  fee_type: string; monthly_amount_pkr: number; total_paid: number; total_overdue: number; rejected_reason: string | null
  due_soon: { id: string; due_on: string; amount: number; paid: number; status: string }[]
}
interface Academy { id: string; title: string; display_name: string | null; category: string }

export default function PortalTrainingProgramsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const [myFees, setMyFees] = useState<MyFee[]>([])
  const [academies, setAcademies] = useState<Academy[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [{ data: fees }, { data: acads }] = await Promise.all([
      user ? supabase.rpc('my_training_fees') : Promise.resolve({ data: [] }),
      supabase.from('projects').select('id, title, display_name, category')
        .in('category', ['sports', 'training']).in('status', ['ongoing', 'upcoming']).order('created_at', { ascending: false }),
    ])
    setMyFees((fees ?? []) as MyFee[])
    setAcademies(acads ?? [])
    setLoading(false)
  }
  useEffect(() => { if (!userLoading) load() }, [userLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  const joinedProjectIds = new Set(myFees.filter((f) => f.status !== 'rejected').map((f) => f.project_id))

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HandCoins size={22} className="text-dp-secondary" /> {t('tp.myFees')} <PortalHelp pageKey="trainingPrograms" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('tp.portalBlurb')}</p>
      </div>

      {loading ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('action.loading')}</p>
      ) : (
        <>
          {/* Academies open for joining */}
          <div className="mb-8">
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{t('tp.availableAcademies')}</p>
            {academies.length === 0 ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('tp.noAcademiesOpen')}</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {academies.map((a) => (
                  <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-3">
                    <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{a.display_name || a.title}</p>
                    {joinedProjectIds.has(a.id) ? (
                      <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 shrink-0">{t('tp.alreadyJoined')}</span>
                    ) : (
                      <Link href={`/portal/training-programs/join/${a.id}`} className="flex items-center gap-1 px-3.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-colors shrink-0">
                        {t('tp.joinBtn')} <ArrowRight size={13} />
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* My enrollments / requests */}
          <div>
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{t('tp.myFees')}</p>
            {myFees.length === 0 ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('tp.noneEnrolled')}</p>
            ) : (
              <div className="space-y-3">
                {myFees.map((f) => (
                  <div key={f.enrollment_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{f.student_name} — {f.program_title}</p>
                      {f.batch_label && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{f.batch_label}</p>}
                      {f.status === 'pending' ? (
                        <p className="font-sans text-[12.5px] text-amber-700 mt-1 flex items-center gap-1"><Hourglass size={12} /> {t('tp.pendingLabel')}</p>
                      ) : f.status === 'rejected' ? (
                        <p className="font-sans text-[12.5px] text-dp-error mt-1 flex items-center gap-1">
                          <XCircle size={12} /> {t('tp.rejectedLabel')}{f.rejected_reason ? ` — ${f.rejected_reason}` : ''}
                        </p>
                      ) : (f.due_soon ?? []).length > 0 ? (
                        <p className="font-sans text-[12.5px] text-amber-700 mt-1 flex items-center gap-1"><Clock size={12} /> {t('tp.feeDue')}: Rs. {f.due_soon[0].amount.toLocaleString()}</p>
                      ) : (
                        <p className="font-sans text-[12.5px] text-emerald-700 mt-1 flex items-center gap-1"><CheckCircle2 size={12} /> {t('tp.feeUpToDate')}</p>
                      )}
                    </div>
                    {f.status === 'active' && (f.due_soon ?? []).length > 0 && (
                      <Link href={`/portal/donate?project=${f.project_id}`} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-colors">
                        {t('tp.payFeeBtn')}
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
