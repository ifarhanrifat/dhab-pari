import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Heart } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'
import { T } from '@/components/i18n/T'
import { AllDonorsTable } from '@/components/public/AllDonorsTable'

export const metadata: Metadata = {
  title: 'All Donors',
  description: `The complete, transparent record of every verified contribution to ${SITE.name}.`,
}

export const revalidate = 300

export default async function AllDonorsPage() {
  const supabase = await createClient()
  const [{ data: donorTotals }, { data: settings }] = await Promise.all([
    // donors_public_totals() (migration 511) — real lifetime total per
    // donor identity, not one row per donation. See donate/page.tsx's own
    // copy of this same reasoning.
    supabase.rpc('donors_public_totals'),
    // Same site-wide "Accounts Display Language" convention every other
    // bilingual public page reads (site_settings.display_language) — this
    // page has no signed-in user to read a per-user preference from.
    supabase.from('site_settings').select('key, value').eq('key', 'display_language').maybeSingle(),
  ])

  const isUrdu = settings?.value === 'ur'
  const rows = [...(donorTotals ?? [])].sort((a, b) => b.total_pkr - a.total_pkr)
  const totalRaised = rows.reduce((sum, d) => sum + Number(d.total_pkr), 0)

  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-10 py-8" dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/donate" className="inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold hover:underline mb-6">
        <ArrowLeft size={16} /> <T k="x.backToDonate" />
      </Link>

      <div className="flex flex-col md:flex-row justify-between items-end mb-8 gap-4">
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center justify-center p-3 bg-dp-secondary-container rounded-full text-dp-on-secondary-container">
            <Heart size={24} />
          </div>
          <div style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
            <h1 className="font-heading text-[24px] md:text-[28px] font-bold leading-[32px] text-dp-primary section-title">
              <T k="x.allDonorsTitle" />
            </h1>
            <p className="text-dp-on-surface-variant font-sans text-[14px] mt-0.5">
              <T k="x.allDonorsSubtitle" />
            </p>
          </div>
        </div>
        <span className="px-4 py-1 bg-dp-secondary-container text-dp-on-secondary-container rounded-full text-[14px] font-sans font-bold tracking-[0.05em] shrink-0">
          <T k="x.totalRaisedLabel" />: <span dir="ltr" className="inline-block">{Math.round(totalRaised).toLocaleString()} ({rows.length})</span>
        </span>
      </div>

      <AllDonorsTable donors={rows} isUrdu={isUrdu} />
    </div>
  )
}
