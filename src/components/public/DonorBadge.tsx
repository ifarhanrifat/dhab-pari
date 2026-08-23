// The one badge every surface reuses — see donorBadges.ts for what each
// tier means. Two display modes, per explicit direction: the full
// icon+name pill only appears on "badges bar" surfaces (the portal's own
// badge card, admin pages); everywhere a name is shown inline with other
// content — comments, blog bylines — pass iconOnly for just the icon.

import { DONOR_BADGE_INFO, type DonorBadgeTier } from '@/lib/donorBadges'

export function DonorBadge({
  tier, isUrdu = false, size = 'sm', iconOnly = false,
}: {
  tier: DonorBadgeTier | null | undefined
  isUrdu?: boolean
  size?: 'xs' | 'sm' | 'md'
  iconOnly?: boolean
}) {
  if (!tier) return null
  const info = DONOR_BADGE_INFO[tier]
  const Icon = info.icon
  const title = isUrdu ? info.labelUr : info.labelEn

  if (iconOnly) {
    const dim = size === 'md' ? 'w-6 h-6' : size === 'xs' ? 'w-4 h-4' : 'w-5 h-5'
    const iconSize = size === 'md' ? 13 : size === 'xs' ? 9 : 11
    return (
      <span
        className={`inline-flex items-center justify-center ${dim} rounded-full shrink-0 ${info.iconRingClass}`}
        title={title}
        aria-label={title}
      >
        <Icon size={iconSize} />
      </span>
    )
  }

  const sizing = size === 'xs'
    ? 'text-[9px] px-1.5 py-0.5 gap-0.5'
    : size === 'md'
      ? 'text-[12px] px-2.5 py-1 gap-1.5'
      : 'text-[10px] px-2 py-0.5 gap-1'
  const iconSize = size === 'md' ? 13 : size === 'xs' ? 9 : 11
  return (
    <span
      className={`inline-flex items-center ${sizing} rounded-full font-bold font-sans whitespace-nowrap ${info.pillClass}`}
      title={title}
    >
      <Icon size={iconSize} />
      {isUrdu ? info.nameUr : info.nameEn}
    </span>
  )
}
