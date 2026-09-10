'use client'

// Filing side of the disputes queue (485) — a small reusable button +
// modal any booking/order screen can drop in once it knows its own
// (kind options, ref_type, ref_id). First wired onto shop delivery
// order tracking; hourly/shadi/trip-offer screens are the obvious next
// places to reuse this, left for a daylight decision on exact wording
// per surface rather than guessed here.

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { AlertTriangle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Props {
  refType: 'shop_order' | 'hourly_booking' | 'shadi_request' | 'trip_offer'
  refId: string
  kindOptions: Array<'fare_dispute' | 'damaged_goods' | 'no_show' | 'shadi_withdrawal' | 'hourly_overage'>
  className?: string
}

export function ReportProblemButton({ refType, refId, kindOptions, className }: Props) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState(kindOptions[0])
  const [claimedAmount, setClaimedAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!note.trim()) { toast.error(friendlyError(new Error(t('dq.notePlaceholder')), undefined, isUrdu)); return }
    setSaving(true)
    const { error } = await supabase.rpc('file_dispute', {
      p_kind: kind, p_ref_type: refType, p_ref_id: refId,
      p_claimed_amount_pkr: claimedAmount ? Number(claimedAmount) : null,
      p_note: note.trim(),
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('dq.submittedToast'))
    setOpen(false); setNote(''); setClaimedAmount('')
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className={className ?? 'inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer'}>
        <AlertTriangle size={13} /> {t('dq.reportProblemBtn')}
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()} dir={isUrdu ? 'rtl' : 'ltr'}>
            <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-3">{t('dq.reportProblemTitle')}</h2>
            <div className="space-y-2.5">
              {kindOptions.length > 1 && (
                <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="input-field">
                  {kindOptions.map((k) => <option key={k} value={k}>{t(`dq.kind.${k}`)}</option>)}
                </select>
              )}
              <input type="number" value={claimedAmount} onChange={(e) => setClaimedAmount(e.target.value)} placeholder={t('dq.claimedAmountPlaceholder')} className="input-field" />
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('dq.notePlaceholder')} className="input-field" rows={3} />
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setOpen(false)} className="flex-1 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer">{t('action.cancel')}</button>
              <button onClick={submit} disabled={saving} className="flex-1 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{saving ? t('action.saving') : t('dq.submitBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
