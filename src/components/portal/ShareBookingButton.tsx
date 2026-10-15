'use client'

// "Share" action from dhab-pari-mobility.html's order page (actions():
// case 'completed' always offers a share button alongside rate/again) —
// opens WhatsApp with a plain-text summary of the finished booking, the
// same wa.me deep-link pattern already used across this app's public
// pages, just never wired onto a completed booking card before.

import { Share2 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Props {
  title: string
  lines: string[]
  className?: string
}

export function ShareBookingButton({ title, lines, className }: Props) {
  const { t } = useLocale()
  const share = () => {
    const text = [title, ...lines].join('\n')
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener')
  }
  return (
    <button onClick={share} className={className ?? 'inline-flex items-center gap-1.5 font-sans text-[12px] font-semibold text-[#64748b] hover:text-[#166534] cursor-pointer'}>
      <Share2 size={12} /> {t('vp.shareBtn')}
    </button>
  )
}
