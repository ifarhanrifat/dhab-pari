// The one badge pill every surface reuses — project comments, the
// proposer's credit on a project card, a donor's blog byline, the portal's
// own "My Badge" card, and the admin donor list. See donorBadges.ts for
// what each tier means and why.

import { DONOR_BADGE_INFO, type DonorBadgeTier } from '@/lib/donorBadges'

export function DonorBadge({
  tier, isUrdu = false, size = 'sm',
}: {
  tier: DonorBadgeTier | null | undefined
  isUrdu?: boolean
  size?: 'xs' | 'sm' | 'md'
}) {
  if (!tier) return null
  const info = DONOR_BADGE_INFO[tier]
  const Icon = info.icon
  const sizing = size === 'xs'
    ? 'text-[9px] px-1.5 py-0.5 gap-0.5'
    : size === 'md'
      ? 'text-[12px] px-2.5 py-1 gap-1.5'
      : 'text-[10px] px-2 py-0.5 gap-1'
  const iconSize = size === 'md' ? 13 : size === 'xs' ? 9 : 11
  return (
    <span
      className={`inline-flex items-center ${sizing} rounded-full font-bold font-sans whitespace-nowrap ${info.pillClass}`}
      title={isUrdu ? info.labelUr : info.labelEn}
    >
      <Icon size={iconSize} />
      {isUrdu ? info.nameUr : info.nameEn}
    </span>
  )
}
