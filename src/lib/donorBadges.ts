// Donor Badges — migration 310, renamed to a VIP-membership register per
// live feedback (the water-metaphor names read as twee rather than
// prestigious). Internal tier codes (spring/stream/river/ocean/wellspring)
// are unchanged — they're baked into RLS/trigger logic across migrations
// 310-312 and never shown to a user — only the display name/icon/color
// below changed. Renaming the codes themselves would mean another
// migration touching CHECK constraints for a purely cosmetic change.
//
// spring/stream/river/ocean are earned by lifetime confirmed giving
// (thresholds live in site_settings — badge_tier1_amount..badge_tier4_amount,
// admin-editable). wellspring is never earned by amount — it's granted by
// hand from /admin/donor-badges, reserved for committee members.
//
// Two display modes, per explicit direction: the full icon+name only
// appears in the "badges bar" surfaces (the portal's own badge card, and
// admin pages); everywhere a name is shown alongside other content —
// comments, blog bylines — only the icon appears, via DonorBadge's
// iconOnly prop.
//
// This file is the one place every surface agrees on what a tier is
// called and how it looks — same role as welfareCardContent.ts /
// portalGuideContent.ts play for their own features.

import { Medal, Award, Gem, Crown, type LucideIcon } from 'lucide-react'

export const DONOR_BADGE_TIERS = ['spring', 'stream', 'river', 'ocean', 'wellspring'] as const
export type DonorBadgeTier = typeof DONOR_BADGE_TIERS[number]

// The 4 earned tiers, in order, paired with the site_settings key holding
// their PKR threshold — used by both the admin Settings editor and the
// portal's "progress to next badge" bar.
export const EARNED_BADGE_TIERS = ['spring', 'stream', 'river', 'ocean'] as const
export const BADGE_THRESHOLD_KEYS: Record<typeof EARNED_BADGE_TIERS[number], string> = {
  spring: 'badge_tier1_amount',
  stream: 'badge_tier2_amount',
  river: 'badge_tier3_amount',
  ocean: 'badge_tier4_amount',
}

interface BadgeInfo {
  nameEn: string
  nameUr: string
  labelEn: string // full form, e.g. "Silver Member"
  labelUr: string
  icon: LucideIcon
  // Tailwind classes for the full icon+name pill (badges-bar surfaces).
  pillClass: string
  // Tailwind classes for the compact icon-only badge (inline next to a name).
  iconRingClass: string
}

export const DONOR_BADGE_INFO: Record<DonorBadgeTier, BadgeInfo> = {
  spring: {
    nameEn: 'Silver', nameUr: 'چاندی', labelEn: 'Silver Member', labelUr: 'چاندی رکن',
    icon: Medal, pillClass: 'bg-slate-100 text-slate-700',
    iconRingClass: 'bg-slate-100 text-slate-600 ring-1 ring-slate-300',
  },
  stream: {
    nameEn: 'Gold', nameUr: 'سنہری', labelEn: 'Gold Member', labelUr: 'سنہری رکن',
    icon: Medal, pillClass: 'bg-amber-100 text-amber-700',
    iconRingClass: 'bg-amber-100 text-amber-700 ring-1 ring-amber-400',
  },
  river: {
    nameEn: 'Platinum', nameUr: 'پلاٹینم', labelEn: 'Platinum Member', labelUr: 'پلاٹینم رکن',
    icon: Award, pillClass: 'bg-indigo-100 text-indigo-700',
    iconRingClass: 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-400',
  },
  ocean: {
    nameEn: 'Diamond', nameUr: 'ہیرا', labelEn: 'Diamond Member', labelUr: 'ہیرا رکن',
    icon: Gem, pillClass: 'bg-cyan-100 text-cyan-700',
    iconRingClass: 'bg-cyan-100 text-cyan-700 ring-1 ring-cyan-400',
  },
  wellspring: {
    nameEn: 'Royal Patron', nameUr: 'شاہی سرپرست', labelEn: 'Royal Patron', labelUr: 'شاہی سرپرست',
    icon: Crown, pillClass: 'bg-purple-100 text-purple-700',
    iconRingClass: 'bg-purple-100 text-purple-700 ring-1 ring-purple-400',
  },
}

// River, Ocean, and the honorary Wellspring — the tiers migration 311/312
// treat as "trusted": skip-voting project proposals and donor blog
// submissions. Kept here so the frontend's own gating messages/UI checks
// use the exact same list as the database triggers, not a second copy that
// could drift.
export const FAST_TRACK_TIERS: DonorBadgeTier[] = ['river', 'ocean', 'wellspring']

export function canFastTrack(tier: DonorBadgeTier | null): boolean {
  return !!tier && FAST_TRACK_TIERS.includes(tier)
}
