'use client'

// The design's callBtn(phone) — a plain tel: link next to the other
// party's name once a booking is accepted. Real gap: the rider side of
// hourly/shadi/equipment fetched the driver's mobile in every read RPC
// already but never rendered it anywhere once a job was confirmed.

import { Phone } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function CallButton({ phone, className }: { phone: string | null; className?: string }) {
  const { t } = useLocale()
  if (!phone) return null
  return (
    <a href={`tel:${phone}`} className={className ?? 'inline-flex items-center gap-1.5 font-sans text-[12px] font-semibold text-[#166534]'}>
      <Phone size={12} /> {t('vp.callBtn')}
    </a>
  )
}
