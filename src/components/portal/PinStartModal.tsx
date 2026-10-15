'use client'

// Shared "ask the rider for their 4-digit PIN before starting" modal —
// ported from dhab-pari-mobility.html's sheetPin (start_t/pin_ask), the
// one confirmation that the vehicle actually showing up is the one the
// rider booked. Used by both my-vehicle/hourly and my-vehicle/equipment;
// the real check happens server-side in start_hourly_trip/
// start_equipment_job (652), this is just the entry UI.

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Props {
  onConfirm: (pin: string) => void
  onClose: () => void
  busy?: boolean
}

export function PinStartModal({ onConfirm, onClose, busy }: Props) {
  const { t, isUrdu } = useLocale()
  const [pin, setPin] = useState('')

  return (
    <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-xs" onClick={(e) => e.stopPropagation()} dir={isUrdu ? 'rtl' : 'ltr'}>
        <h2 className="font-sans text-[15px] font-bold text-[#1e293b] mb-1.5">{t('vp.pinStartTitle')}</h2>
        <p className="font-sans text-[12.5px] text-[#64748b] mb-3">{t('vp.pinAskHint')}</p>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          maxLength={4}
          autoFocus
          placeholder="••••"
          className="w-full text-center tracking-[0.5em] font-bold text-[22px] ltr-num border border-[#e5e2d0] rounded-xl py-2.5 mb-3"
        />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 border border-[#e5e2d0] rounded-xl font-sans text-[13px] font-semibold cursor-pointer">{t('action.cancel')}</button>
          <button onClick={() => onConfirm(pin)} disabled={busy || pin.length !== 4}
            className="flex-1 py-2.5 bg-[#005A36] text-white rounded-xl font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} {t('vp.pinStartTitle')}
          </button>
        </div>
      </div>
    </div>
  )
}
