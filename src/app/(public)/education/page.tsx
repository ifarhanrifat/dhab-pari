import type { Metadata } from 'next'
import { GraduationCap, HeartHandshake, MessageSquarePlus, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { SITE } from '@/lib/constants'
import { T } from '@/components/i18n/T'

export const metadata: Metadata = {
  title: 'Education Corner',
  description: `Education support programs in ${SITE.name}.`,
}

// Real gap, 2026-10-06: this page used to show three fabricated "Scholarship
// Info Cards" with invented numbers (e.g. "25 students supported") and a
// list of five named students with fabricated achievements, none of it
// backed by any table. Harmless as placeholder copy for one village's own
// site, but it would show the exact same fake Dhab Pari-specific names on
// any other village's site, word for word. Replaced with links to the
// education-support systems this app actually has and actually tracks
// (Kafalat/Wazifa/Zakat, under the real welfare hub) rather than inventing
// a second, unbacked "scholarship" concept next to them.
export default function EducationPage() {
  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="text-center mb-12 max-w-3xl mx-auto">
        <div className="inline-flex items-center justify-center p-3 bg-blue-100 rounded-full text-blue-600 mb-4">
          <GraduationCap size={32} />
        </div>
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
          <T k="x.educationCorner" />
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px]">
          Supporting the next generation of {SITE.name} through sponsorship, stipends, and community support.
        </p>
      </div>

      <section className="mb-10">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center gap-5">
          <div className="w-14 h-14 shrink-0 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
            <HeartHandshake size={28} />
          </div>
          <div className="flex-1">
            <h2 className="font-heading text-[22px] font-bold leading-[30px] text-dp-primary mb-1.5">Kafalat, Wazifa &amp; Zakat</h2>
            <p className="text-dp-on-surface-variant font-sans text-[14.5px] leading-[22px]">
              Sponsor an orphan or student directly (Kafalat), support ongoing education stipends (Taleemi Wazifa), or contribute to the pooled Zakat &amp; Ushr fund. Every program here is run and tracked by the committee — real sponsors, real recipients.
            </p>
          </div>
          <Link href="/welfare" className="shrink-0 inline-flex items-center gap-1.5 bg-dp-primary text-white px-5 py-2.5 rounded-lg font-sans text-[14px] font-semibold hover:brightness-110 transition-all">
            Explore Welfare Programs <ArrowRight size={15} />
          </Link>
        </div>
      </section>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-8 text-center">
        <div className="inline-flex items-center justify-center p-2.5 bg-white rounded-full text-blue-600 mb-3">
          <MessageSquarePlus size={22} />
        </div>
        <h3 className="font-heading text-[22px] font-bold leading-[30px] text-blue-900 mb-2">Have an idea for education in {SITE.name}?</h3>
        <p className="text-blue-700 font-sans text-[15px] mb-6 max-w-xl mx-auto">
          A tuition center, a book drive, a tutoring program — suggest it directly to the committee.
        </p>
        <Link
          href="/suggestions"
          className="inline-block bg-blue-600 text-white px-8 py-3 rounded-lg font-sans font-semibold hover:bg-blue-700 transition-all"
        >
          Submit a Suggestion
        </Link>
      </div>
    </div>
  )
}
