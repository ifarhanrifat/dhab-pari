'use client'

// Shared by /portal/my-shop and /portal/my-vehicle — same announce-style
// top-up for either seller kind, calling place_shop_wallet_topup or
// place_vehicle_wallet_topup (migration 394) depending on `kind`. Staff
// still confirms it (verifies the payment actually landed) before it's
// credited — same reconciliation discipline as every other payment here.

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface Props {
  kind: 'shop' | 'vehicle'
  sellerId: string
  onClose: () => void
  onSubmitted: () => void
}

export function WalletTopupModal({ kind, sellerId, onClose, onSubmitted }: Props) {
  const { t } = useLocale()
  const supabase = createClient()
  const [amount, setAmount] = useState(0)
  const [method, setMethod] = useState('cash')
  const [proofPath, setProofPath] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (amount <= 0) { toast.error(t('cm.enterTopupAmount')); return }
    if (!proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setSubmitting(true)
    const { error } = kind === 'shop'
      ? await supabase.rpc('place_shop_wallet_topup', { p_shop_id: sellerId, p_amount: amount, p_method: method, p_proof_url: proofPath })
      : await supabase.rpc('place_vehicle_wallet_topup', { p_vehicle_id: sellerId, p_amount: amount, p_method: method, p_proof_url: proofPath })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.topupSubmittedToast'))
    onSubmitted()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('cm.topupWalletBtn')}</h2>
          <button onClick={onClose} className="cursor-pointer"><X size={20} /></button>
        </div>
        <p className="font-sans text-[13px] text-dp-on-surface-variant mb-3">{t('cm.topupHint')}</p>
        <div className="space-y-3">
          <div>
            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.topupAmountLabel')}</label>
            <input type="number" value={amount || ''} onChange={(e) => setAmount(+e.target.value)} className="input-field" placeholder="0" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="input-field">
              <option value="cash">{t('w.cash')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
              <option value="bank">{t('a.bank')}</option>
            </select>
          </div>
          <DonationReceiptUpload onUpload={setProofPath} />
          <button onClick={submit} disabled={submitting} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {submitting ? t('mp.placingOrder') : t('cm.topupWalletBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}
