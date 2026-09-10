'use client'

// Ported from the v2 design handoff (§2.2): the driver's real gap was
// judging *who is asking* — a request arrived with a name and a number
// and nothing else. Same badge now reused identically on the
// shopkeeper's own order cards, per the handoff's own note that both
// surfaces should judge a requester by the identical rule.
//
// Outsiders are grey, not red — red is this app's own action colour
// (primary buttons, "in progress", "declined"); marking a visitor red
// would read as "reject this," which is unfair to a legitimate
// first-time customer. Grey reads as "unknown — look before you
// accept," which is what it actually means.

import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface TrustFlag { label: string; ok: boolean; value?: number }
export interface Trust { tier: 'verified' | 'partial' | 'outsider'; score: number; flags: TrustFlag[] }

const TIER_STYLE = {
  verified: { color: '#0f7a4d', bg: '#e9f7ef', Icon: ShieldCheck },
  partial: { color: '#9a5714', bg: '#fdf0e2', Icon: ShieldAlert },
  outsider: { color: '#6b6560', bg: '#f0eded', Icon: ShieldQuestion },
} as const

// Compact — a single inline pill, for a request card's header row.
export function TrustPill({ trust }: { trust: Trust | null | undefined }) {
  const { t } = useLocale()
  if (!trust) return null
  const s = TIER_STYLE[trust.tier]
  return (
    <span className="inline-flex items-center gap-1 shrink-0 font-sans text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: s.bg, color: s.color }}>
      <s.Icon size={11} /> {t(`tr.tier.${trust.tier}`)} · <span className="ltr-num">{trust.score}</span>
    </span>
  )
}

// Full — the tier in words plus per-flag pills, for when a driver/shop
// genuinely needs to decide whether to accept, not just glance.
export function TrustStrip({ trust }: { trust: Trust | null | undefined }) {
  const { t } = useLocale()
  if (!trust) return null
  const s = TIER_STYLE[trust.tier]
  return (
    <div className="rounded-lg p-2 mb-2" style={{ background: s.bg }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <s.Icon size={13} style={{ color: s.color }} />
        <span className="font-sans text-[12px] font-bold" style={{ color: s.color }}>{t(`tr.tier.${trust.tier}`)}</span>
        <span className="font-sans text-[10px] font-bold ms-auto ltr-num" style={{ color: s.color }}>{t('tr.trustLabel')} {trust.score}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {trust.flags.map((f) => (
          <span key={f.label} className="font-sans text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: f.ok ? '#e9f7ef' : '#fce3dc', color: f.ok ? '#0f7a4d' : '#b3261e' }}>
            {f.label}{f.value != null ? ` (${f.value})` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
