'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { CalendarClock, MapPin, CheckCircle2, HandCoins, Clock } from 'lucide-react'
import { PortalHelp } from '@/components/portal/PortalHelp'
import Link from 'next/link'

interface Program {
  id: string; title: string; title_ur: string | null; description: string | null; description_ur: string | null
  location: string | null; start_date: string | null; capacity: number | null
  category: string; status: string
  eligibility: string | null; eligibility_ur: string | null; requirements: string | null; requirements_ur: string | null
}
// my_training_fees() (366) — a fee-charging academy (category='sports'/
// 'training', a real project) a child of this account is enrolled in.
// Nothing here records a payment directly — that RPC is admin/trainer-only
// (real cash needs real ledger discipline); this is a read-only summary
// with a link straight into the normal Donate flow, pre-selecting the
// academy, exactly the same "pick a project, pay, upload the slip" path
// every other donation already goes through.
interface MyFee {
  enrollment_id: string; project_id: string; program_title: string; student_name: string
  fee_type: string; monthly_amount_pkr: number; total_paid: number; total_overdue: number
  due_soon: { id: string; due_on: string; amount: number; paid: number; status: string }[]
}

export default function PortalTrainingProgramsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const [rows, setRows] = useState<Program[]>([])
  const [myRegs, setMyRegs] = useState<Record<string, string>>({})
  const [myFees, setMyFees] = useState<MyFee[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = async () => {
    const { data } = await supabase.from('training_programs').select('*').in('status', ['upcoming', 'ongoing']).order('start_date')
    setRows((data ?? []) as Program[])
    if (user) {
      const { data: regs } = await supabase.from('training_program_registrations').select('training_program_id, status').eq('portal_user_id', user.id)
      setMyRegs(Object.fromEntries((regs ?? []).map((r) => [r.training_program_id, r.status])))
      const { data: fees } = await supabase.rpc('my_training_fees')
      setMyFees((fees ?? []) as MyFee[])
    }
    setLoading(false)
  }
  useEffect(() => { if (!userLoading) load() }, [userLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  const register = async (programId: string) => {
    setBusyId(programId)
    const { error } = await supabase.rpc('register_for_training_program', { p_training_program_id: programId })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tp.registeredToast'))
    load()
  }

  const cancel = async (programId: string) => {
    setBusyId(programId)
    const { error } = await supabase.from('training_program_registrations').update({ status: 'cancelled' }).eq('training_program_id', programId).eq('portal_user_id', user!.id)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tp.cancelledToast'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><CalendarClock size={22} className="text-dp-secondary" /> {t('tp.title')} <PortalHelp pageKey="trainingPrograms" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('tp.portalBlurb')}</p>
      </div>

      {myFees.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-3 flex items-center gap-1.5"><HandCoins size={15} /> {t('tp.myFees')}</p>
          <div className="space-y-3">
            {myFees.map((f) => (
              <div key={f.enrollment_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{f.student_name} — {f.program_title}</p>
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
        </div>
      )}

      {loading ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('action.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('tp.none')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const status = myRegs[r.id]
            const isRegistered = status === 'registered' || status === 'attended'
            return (
              <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{isUrdu && r.title_ur ? r.title_ur : r.title}</p>
                    {r.description && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{isUrdu && r.description_ur ? r.description_ur : r.description}</p>}
                    {r.eligibility && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1"><strong className="text-dp-on-surface">{t('tp.eligibilityColon')}</strong> {isUrdu && r.eligibility_ur ? r.eligibility_ur : r.eligibility}</p>}
                    {r.requirements && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5"><strong className="text-dp-on-surface">{t('tp.requirementsColon')}</strong> {isUrdu && r.requirements_ur ? r.requirements_ur : r.requirements}</p>}
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      {r.location && <span className="font-sans text-[12px] text-dp-on-surface-variant flex items-center gap-1"><MapPin size={12} /> {r.location}</span>}
                      {r.start_date && <span className="font-sans text-[12px] text-dp-on-surface-variant">{r.start_date}</span>}
                    </div>
                  </div>
                  {isRegistered ? (
                    <button onClick={() => cancel(r.id)} disabled={busyId === r.id} className="flex items-center gap-1.5 border border-emerald-600 text-emerald-700 px-3 py-1.5 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-emerald-50 transition-all disabled:opacity-50 shrink-0">
                      <CheckCircle2 size={13} /> {t('tp.registeredCancel')}
                    </button>
                  ) : (
                    <button onClick={() => register(r.id)} disabled={busyId === r.id} className="bg-dp-secondary text-white px-4 py-1.5 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 shrink-0">
                      {t('tp.register')}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
