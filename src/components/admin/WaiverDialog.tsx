'use client'

import { useState } from 'react'
import { HeartHandshake } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Mirrors ReverseVoucherDialog.tsx exactly — same shape, same reason-
// required discipline — but calls one of the four waive_* RPCs
// (migration 438) instead of reverse_voucher. Every screen that lists a
// pending bill/wazifa instalment/academy fee wants the same "the
// committee decided to forgive this" action; this is only the UI.
export type WaiverKind = 'bill' | 'wazifa_repayment' | 'wazifa_charge' | 'academy_fee'

const RPC_BY_KIND: Record<WaiverKind, string> = {
  bill: 'waive_bill',
  wazifa_repayment: 'waive_wazifa_repayment',
  wazifa_charge: 'waive_wazifa_installment_charge',
  academy_fee: 'waive_academy_fee_charge',
}

interface WaiverDialogProps {
  recordId: string | null
  kind: WaiverKind | null
  label: string
  onClose: () => void
  onWaived: () => void
}

export function WaiverDialog({ recordId, kind, label, onClose, onWaived }: WaiverDialogProps) {
  const { t, isUrdu } = useLocale()
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const supabase = createClient()

  if (!recordId || !kind) return null

  const close = () => { if (submitting) return; setReason(''); onClose() }

  const submit = async () => {
    if (!reason.trim()) { toast.error(t('tx.waiverReasonRequired')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc(RPC_BY_KIND[kind], { p_reason: reason.trim(), ...(kind === 'bill' ? { p_bill_id: recordId } : { p_id: recordId }) })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tx.waivedToast'))
    setReason('')
    onWaived()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={close}>
      <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center shrink-0">
            <HeartHandshake size={19} />
          </div>
          <h2 className="font-sans text-[17px] font-bold text-dp-on-surface">{t('tx.waiverTitle')}</h2>
        </div>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-1">{t('tx.waiverExplain')}</p>
        <p className="font-sans text-[13px] font-semibold text-dp-on-surface mb-4">{label}</p>
        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('tx.waiverReasonLabel')}</label>
        <textarea
          value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus
          placeholder={t('tx.waiverReasonPlaceholder')} className="input-field resize-none mb-5"
        />
        <div className="flex gap-3">
          <button onClick={close} disabled={submitting} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container transition-all cursor-pointer disabled:opacity-50">
            {t('action.cancel')}
          </button>
          <button onClick={submit} disabled={submitting} className="flex-1 px-4 py-2 bg-violet-600 text-white rounded-lg font-sans text-[14px] font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-50">
            {submitting ? t('tx.waiving') : t('tx.waiverConfirmBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}
