'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { BellRing, MessageCircle, SkipForward, Clock, AlertTriangle, Heart, CalendarClock, Copy, Megaphone, GraduationCap } from 'lucide-react'
import { normalizePakPhone } from '@/lib/receiptExport'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Reminder {
  id: string; reminder_type: 'bill_weekly' | 'bill_defaulter' | 'donor_recurring' | 'meeting_due' | 'donor_pledge_unpaid' | 'wazifa_repayment_due'
  target_name: string; target_phone: string | null; message: string; amount: number | null
  status: 'pending' | 'sent' | 'skipped'
}

// titleKey/blurbKey are i18n keys (module scope has no useLocale()) —
// resolved via t() at render time.
const sectionMeta = {
  bill_weekly: { titleKey: 'rm.titleBillWeekly', icon: Clock, blurbKey: 'rm.blurbBillWeekly' },
  bill_defaulter: { titleKey: 'rm.titleBillDefaulter', icon: AlertTriangle, blurbKey: 'rm.blurbBillDefaulter' },
  donor_recurring: { titleKey: 'rm.titleDonorRecurring', icon: Heart, blurbKey: 'rm.blurbDonorRecurring' },
  meeting_due: { titleKey: 'rm.titleMeetingDue', icon: CalendarClock, blurbKey: 'rm.blurbMeetingDue' },
  donor_pledge_unpaid: { titleKey: 'rm.titleDonorPledgeUnpaid', icon: Megaphone, blurbKey: 'rm.blurbDonorPledgeUnpaid' },
  wazifa_repayment_due: { titleKey: 'rm.titleWazifaRepayment', icon: GraduationCap, blurbKey: 'rm.blurbWazifaRepayment' },
} as const

export default function RemindersPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const { data } = await supabase.from('reminder_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false })
    setReminders(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (r: Reminder) => {
    if (!r.target_phone) { toast.error(t('rm.noPhoneOnFile')); return }
    const intl = normalizePakPhone(r.target_phone)
    if (!intl) { toast.error(t('rm.invalidPhone')); return }
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(r.message)}`, '_blank')
    const { error } = await supabase.from('reminder_queue').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    setReminders(reminders.filter((x) => x.id !== r.id))
  }

  const skip = async (r: Reminder) => {
    const { error } = await supabase.from('reminder_queue').update({ status: 'skipped' }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    setReminders(reminders.filter((x) => x.id !== r.id))
  }

  const byType = (type: Reminder['reminder_type']) => reminders.filter((r) => r.reminder_type === type)

  const copyForGroup = async (message: string) => {
    try {
      await navigator.clipboard.writeText(message)
      toast.success(t('rm.copiedForGroup'))
    } catch {
      toast.error(t('rm.couldNotCopy'))
    }
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <h1 className="font-heading text-[26px] sm:text-[32px] font-bold text-dp-primary flex items-center gap-2.5 mb-2">
        <BellRing size={28} /> {t('y.reminders')}
      </h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-6">
        {t('rm.subtitle')}
      </p>

      {loading ? (
        <p className="font-sans text-dp-on-surface-variant py-8 text-center"><LoadingDots /></p>
      ) : reminders.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('y.nothingPending')}</p>
        </div>
      ) : (
        (Object.keys(sectionMeta) as (keyof typeof sectionMeta)[]).map((type) => {
          const rows = byType(type)
          if (rows.length === 0) return null
          const meta = sectionMeta[type]
          const Icon = meta.icon
          return (
            <div key={type} className="mb-6">
              <h2 className="font-sans text-[15px] font-bold text-dp-on-surface flex items-center gap-2 mb-1">
                <Icon size={16} /> {t(meta.titleKey)} <span className="font-normal text-dp-on-surface-variant text-[12.5px]">({rows.length})</span>
                {type === 'meeting_due' && (
                  <button onClick={() => copyForGroup(rows[0].message)} className="flex items-center gap-1 px-2 py-1 border border-dp-outline-variant rounded-full font-sans text-[11px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">
                    <Copy size={11} /> {t('mt.copyForGroup')}
                  </button>
                )}
              </h2>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t(meta.blurbKey)}</p>
              <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden divide-y divide-dp-outline-variant">
                {rows.map((r) => (
                  <div key={r.id} className="p-4 flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-sans text-[14px] font-bold text-dp-on-surface">{r.target_name}</p>
                        {r.target_phone && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{r.target_phone}</p>}
                        {r.amount != null && <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{Number(r.amount).toLocaleString()}</p>}
                      </div>
                      <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1 whitespace-pre-line line-clamp-3">{r.message}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => skip(r)} title={t('rm.skipTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><SkipForward size={15} /></button>
                      <button
                        onClick={() => send(r)}
                        disabled={!r.target_phone}
                        className="flex items-center justify-center p-2 bg-[#25d366] text-white rounded-lg hover:opacity-90 transition-all cursor-pointer disabled:opacity-50"
                        title={t('g.send')}
                        aria-label={t('g.send')}
                      >
                        <MessageCircle size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
