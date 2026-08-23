// Donor Badges — migration 310. Water-themed tiers rather than generic
// bronze/silver/gold, since Dhab Pari is a water committee: the badge
// should read as an earned honor, not a gamification sticker, for the
// doctors and PhD scholars among the village's donors as much as anyone.
//
// spring/stream/river/ocean are earned by lifetime confirmed giving
// (thresholds live in site_settings — badge_tier1_amount..badge_tier4_amount,
// admin-editable). wellspring is never earned by amount — it's granted by
// hand from /admin/donor-badges, reserved for committee members: the source
// the whole system flows from, not a bigger number than everyone else's.
//
// This file is the one place every surface (portal badge card, project
// comments, proposer credit, blog bylines, admin donor list) agrees on
// what a tier is called and how it looks — same role as
// welfareCardContent.ts / portalGuideContent.ts play for their own features.

import { Droplet, Waves, Anchor, Sailboat, Crown, type LucideIcon } from 'lucide-react'

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
  labelEn: string // "Chashma — Spring"
  labelUr: string // "چشمہ"
  icon: LucideIcon
  // Tailwind classes for the compact pill shown next to a name.
  pillClass: string
}

export const DONOR_BADGE_INFO: Record<DonorBadgeTier, BadgeInfo> = {
  spring: {
    nameEn: 'Spring', nameUr: 'چشمہ', labelEn: 'Chashma — Spring', labelUr: 'چشمہ',
    icon: Droplet, pillClass: 'bg-sky-100 text-sky-700',
  },
  stream: {
    nameEn: 'Stream', nameUr: 'نہر', labelEn: 'Nahar — Stream', labelUr: 'نہر',
    icon: Waves, pillClass: 'bg-cyan-100 text-cyan-700',
  },
  river: {
    nameEn: 'River', nameUr: 'دریا', labelEn: 'Darya — River', labelUr: 'دریا',
    icon: Anchor, pillClass: 'bg-blue-100 text-blue-700',
  },
  ocean: {
    nameEn: 'Ocean', nameUr: 'سمندر', labelEn: 'Samandar — Ocean', labelUr: 'سمندر',
    icon: Sailboat, pillClass: 'bg-indigo-100 text-indigo-700',
  },
  wellspring: {
    nameEn: 'Wellspring', nameUr: 'سرچشمہ', labelEn: 'Sarchashma — Wellspring', labelUr: 'سرچشمہ',
    icon: Crown, pillClass: 'bg-amber-100 text-amber-800',
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
