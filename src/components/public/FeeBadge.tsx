'use client'

import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * "Fee — from Rs. X/mo" or "Free" for a sports/training card — same
 * wording /projects already uses (feeBadgeLabel there), just pulled out
 * so the home page's server-rendered card grid can show it too via this
 * one small client island, the same seam <T> uses for plain text.
 */
export function FeeBadge({ free, cheapestVillagerMonthly }: { free: boolean; cheapestVillagerMonthly: number | null }) {
  const { isUrdu } = useLocale()
  if (free) {
    return <span className="bg-emerald-100 text-emerald-800 text-[10px] font-extrabold px-2 py-1 rounded uppercase tracking-wider shrink-0">{isUrdu ? 'مفت' : 'Free'}</span>
  }
  if (cheapestVillagerMonthly) {
    return (
      <span className="bg-blue-100 text-blue-800 text-[10px] font-extrabold px-2 py-1 rounded uppercase tracking-wider shrink-0">
        {isUrdu ? `فیس — Rs. ${cheapestVillagerMonthly.toLocaleString()} سے/ماہ` : `Fee — from Rs. ${cheapestVillagerMonthly.toLocaleString()}/mo`}
      </span>
    )
  }
  return null
}
