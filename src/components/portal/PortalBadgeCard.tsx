'use client'

// "My Badge" — the donor's own tier, and a progress bar toward the next
// one, computed from the total already shown on the dashboard so this
// never disagrees with it. See donorBadges.ts / migration 310.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonorBadge } from '@/components/public/DonorBadge'
import {
  EARNED_BADGE_TIERS, BADGE_THRESHOLD_KEYS, DONOR_BADGE_INFO, canFastTrack, type DonorBadgeTier,
} from '@/lib/donorBadges'

const fmt = (n: number) => Number(n || 0).toLocaleString()

export function PortalBadgeCard({ portalUserId, totalDonated }: { portalUserId: string; totalDonated: number }) {
  const { t, isUrdu } = useLocale()
  const [tier, setTier] = useState<DonorBadgeTier | null | undefined>(undefined)
  const [thresholds, setThresholds] = useState<Record<string, number>>({})

  useEffect(() => {
    const supabase = createClient()
    supabase.rpc('donor_badge_tier', { p_portal_user_id: portalUserId }).then(({ data }) => setTier((data ?? null) as DonorBadgeTier | null))
    supabase.from('site_settings').select('key, value').in('key', Object.values(BADGE_THRESHOLD_KEYS)).then(({ data }) => {
      const m: Record<string, number> = {}
      ;((data ?? []) as { key: string; value: string | null }[]).forEach((s) => { m[s.key] = Number(s.value ?? 0) })
      setThresholds(m)
    })
  }, [portalUserId])

  if (tier === undefined) return null // still loading — no flash of "no badge"

  const isManualHonor = tier === 'wellspring'
  const nextTier = !isManualHonor ? EARNED_BADGE_TIERS.find((tr) => totalDonated < (thresholds[BADGE_THRESHOLD_KEYS[tr]] ?? Infinity)) : undefined
  const nextThreshold = nextTier ? (thresholds[BADGE_THRESHOLD_KEYS[nextTier]] ?? 0) : null
  const prevThreshold = (() => {
    if (!nextTier) return 0
    const idx = EARNED_BADGE_TIERS.indexOf(nextTier)
    if (idx === 0) return 0
    return thresholds[BADGE_THRESHOLD_KEYS[EARNED_BADGE_TIERS[idx - 1]]] ?? 0
  })()
  const progressPct = nextThreshold
    ? Math.min(100, Math.max(0, ((totalDonated - prevThreshold) / (nextThreshold - prevThreshold)) * 100))
    : 100

  return (
    <div className="bg-gradient-to-br from-dp-primary to-[#0e3d33] text-white rounded-lg p-6 mb-6 relative overflow-hidden">
      <div className="absolute -top-10 -end-10 w-36 h-36 bg-white/5 rounded-full blur-2xl pointer-events-none" />
      <div className="relative flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[12px] font-sans font-extrabold uppercase tracking-wide opacity-80 mb-1.5">{t('pbc.myBadge')}</p>
          {tier ? (
            <DonorBadge tier={tier} isUrdu={isUrdu} size="md" />
          ) : (
            <p className="font-sans text-[14px] opacity-90">{t('pbc.noBadgeYet')}</p>
          )}
        </div>
        {canFastTrack(tier ?? null) && (
          <span className="text-[11px] font-sans font-semibold bg-white/15 rounded-full px-3 py-1.5">{t('pbc.fastTrackPerk')}</span>
        )}
      </div>

      {!isManualHonor && (
        <div className="relative mt-4">
          {nextTier ? (
            <>
              <div className="flex items-center justify-between text-[12px] font-sans font-semibold mb-1.5 opacity-90">
                <span>{fmt(totalDonated)}</span>
                <span>{t('pbc.toReach')} {isUrdu ? DONOR_BADGE_INFO[nextTier].labelUr : DONOR_BADGE_INFO[nextTier].labelEn} · {fmt(nextThreshold ?? 0)}</span>
              </div>
              <div className="w-full h-2 bg-white/20 rounded-full overflow-hidden">
                <div className="h-full bg-white rounded-full" style={{ width: `${progressPct}%` }} />
              </div>
            </>
          ) : (
            <p className="text-[12.5px] font-sans opacity-90">{t('pbc.topTier')}</p>
          )}
        </div>
      )}
    </div>
  )
}
