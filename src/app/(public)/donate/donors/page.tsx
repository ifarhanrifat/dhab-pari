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
  const [{ data: donors }, { data: projectRows }] = await Promise.all([
    // donors_public (migration 116/361) already resolves `name` to the
    // literal 'Anonymous'/'Confidential' string server-side when the donor
    // chose anonymity or the project hides donor names — there's no
    // separate is_anonymous column to select (a real bug, found while
    // building this page: selecting it made the WHOLE query fail silently,
    // same pre-existing bug the /donate honor wall's top-10 table had).
    supabase.from('donors_public').select('id, name, amount_pkr, date, project_id')
      .eq('is_verified', true).order('amount_pkr', { ascending: false }),
    supabase.from('projects').select('id, title, display_name'),
  ])

  const projectTitleById = new Map((projectRows ?? []).map((p) => [p.id, p.display_name || p.title]))
  const rows = (donors ?? []).map((d) => ({
    ...d,
    projectTitle: d.project_id ? (projectTitleById.get(d.project_id) ?? null) : null,
  }))
  const totalRaised = rows.reduce((sum, d) => sum + Number(d.amount_pkr), 0)

  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-10 py-8">
      <Link href="/donate" className="inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold hover:underline mb-6">
        <ArrowLeft size={16} /> <T k="x.backToDonate" />
      </Link>

      <div className="flex flex-col md:flex-row justify-between items-end mb-8 gap-4">
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center justify-center p-3 bg-dp-secondary-container rounded-full text-dp-on-secondary-container">
            <Heart size={24} />
          </div>
          <div>
            <h1 className="font-heading text-[24px] md:text-[28px] font-bold leading-[32px] text-dp-primary section-title">
              <T k="x.allDonorsTitle" />
            </h1>
            <p className="text-dp-on-surface-variant font-sans text-[14px] mt-0.5">
              <T k="x.allDonorsSubtitle" />
            </p>
          </div>
        </div>
        <span className="px-4 py-1 bg-dp-secondary-container text-dp-on-secondary-container rounded-full text-[14px] font-sans font-bold tracking-[0.05em] shrink-0">
          <T k="x.totalRaisedLabel" />: {Math.round(totalRaised).toLocaleString()} ({rows.length})
        </span>
      </div>

      <AllDonorsTable donors={rows} />
    </div>
  )
}
