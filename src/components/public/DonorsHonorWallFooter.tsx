'use client'

import Link from 'next/link'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Real report, 2026-09-25: the "Total Raised" badge above the honor wall
// table was a hardcoded "1.2M" and the "View All ... Donors" button below it
// had no href at all — neither was ever wired to donors_public. Both are
// small client islands (same reason T.tsx is one: this page is a cached
// Server Component with revalidate, so real i18n text has to resolve in the
// browser) fed real numbers from the server fetch in page.tsx.
export function TotalRaisedBadge({ amount }: { amount: number }) {
  const { t } = useLocale()
  return (
    <span className="px-4 py-1 bg-dp-secondary-container text-dp-on-secondary-container rounded-full text-[14px] font-sans font-bold tracking-[0.05em] shrink-0">
      {t('x.totalRaisedLabel')}: {Math.round(amount).toLocaleString()}
    </span>
  )
}

export function ViewAllDonorsLink({ count }: { count: number }) {
  const { t } = useLocale()
  return (
    <Link href="/donate/donors" className="text-dp-secondary font-bold hover:underline font-sans cursor-pointer inline-block">
      {t('x.viewAllDonors').replace('{count}', count.toLocaleString())}
    </Link>
  )
}
