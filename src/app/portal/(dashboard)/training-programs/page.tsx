'use client'

// The old free-workshop browse/register list (training_programs) is
// retired — every training/sports activity, paid or free, is now a real
// project (migration 366/370), visible and joinable as a normal card on
// the public site. This page keeps its route (and the portal sidebar
// entry) but is now purely "My academy fees": a read-only summary, via
// my_training_fees(), of what's due for a child already enrolled by
// staff/a trainer, with a link straight into the normal Donate flow
// (pre-selected project) for self-service payment — the same
// pick-a-project/pay/upload-the-slip path every other donation goes
// through, nothing new to learn.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { HandCoins, Clock, CheckCircle2 } from 'lucide-react'
import { PortalHelp } from '@/components/portal/PortalHelp'
import Link from 'next/link'

interface MyFee {
  enrollment_id: string; project_id: string; program_title: string; batch_label: string | null; student_name: string
  fee_type: string; monthly_amount_pkr: number; total_paid: number; total_overdue: number
  due_soon: { id: string; due_on: string; amount: number; paid: number; status: string }[]
}

export default function PortalTrainingProgramsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const [myFees, setMyFees] = useState<MyFee[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    if (user) {
      const { data: fees } = await supabase.rpc('my_training_fees')
      setMyFees((fees ?? []) as MyFee[])
    }
    setLoading(false)
  }
  useEffect(() => { if (!userLoading) load() }, [userLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HandCoins size={22} className="text-dp-secondary" /> {t('tp.myFees')} <PortalHelp pageKey="trainingPrograms" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('tp.portalBlurb')}</p>
      </div>

      {loading ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('action.loading')}</p>
      ) : myFees.length === 0 ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('tp.noneEnrolled')}</p>
      ) : (
        <div className="space-y-3">
          {myFees.map((f) => (
            <div key={f.enrollment_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{f.student_name} — {f.program_title}</p>
                {f.batch_label && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{f.batch_label}</p>}
                {f.due_soon.length > 0 ? (
                  <p className="font-sans text-[12.5px] text-amber-700 mt-1 flex items-center gap-1"><Clock size={12} /> {t('tp.feeDue')}: Rs. {f.due_soon[0].amount.toLocaleString()}</p>
                ) : (
                  <p className="font-sans text-[12.5px] text-emerald-700 mt-1 flex items-center gap-1"><CheckCircle2 size={12} /> {t('tp.feeUpToDate')}</p>
                )}
              </div>
              {f.due_soon.length > 0 && (
                <Link href={`/portal/donate?project=${f.project_id}`} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-colors">
                  {t('tp.payFeeBtn')}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
