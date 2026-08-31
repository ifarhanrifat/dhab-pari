'use client'

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Every screen that lists a voucher (All Transactions, an account statement)
// wants the same "undo this, the right way" action — reverse_voucher()
// (migration 207) already does the real work server-side: it mirrors the
// original's own ledger legs, posts a new dated-today entry, links the two
// rows to each other, and writes its own audit_log row. This is only the
// UI: ask for the reason the RPC requires, call it, hand success back so
// the caller can reload its list.
//
// The caller controls "open" purely by whether voucherId is non-null —
// render <ReverseVoucherDialog voucherId={reversing?.id ?? null} .../> and
// there is nothing else to wire up per list.
interface ReverseVoucherDialogProps {
  voucherId: string | null
  voucherLabel: string
  onClose: () => void
  onReversed: () => void
}

export function ReverseVoucherDialog({ voucherId, voucherLabel, onClose, onReversed }: ReverseVoucherDialogProps) {
  const { t, isUrdu } = useLocale()
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const supabase = createClient()

  if (!voucherId) return null

  const close = () => { if (submitting) return; setReason(''); onClose() }

  const submit = async () => {
    if (!reason.trim()) { toast.error(t('tx.reverseReasonRequired')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('reverse_voucher', { p_voucher_id: voucherId, p_reason: reason.trim() })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('tx.reversedToast'))
    setReason('')
    onReversed()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={close}>
      <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center shrink-0">
            <RotateCcw size={19} />
          </div>
          <h2 className="font-sans text-[17px] font-bold text-dp-on-surface">{t('tx.reverseTitle')}</h2>
        </div>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-1">{t('tx.reverseExplain')}</p>
        <p className="font-sans text-[13px] font-semibold text-dp-on-surface mb-4">{voucherLabel}</p>
        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('tx.reverseReasonLabel')}</label>
        <textarea
          value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus
          placeholder={t('tx.reverseReasonPlaceholder')} className="input-field resize-none mb-5"
        />
        <div className="flex gap-3">
          <button onClick={close} disabled={submitting} className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container transition-all cursor-pointer disabled:opacity-50">
            {t('action.cancel')}
          </button>
          <button onClick={submit} disabled={submitting} className="flex-1 px-4 py-2 bg-sky-600 text-white rounded-lg font-sans text-[14px] font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-50">
            {submitting ? t('tx.reversing') : t('tx.reverseConfirmBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}
