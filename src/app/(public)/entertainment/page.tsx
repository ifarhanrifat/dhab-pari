import type { Metadata } from 'next'
import { Trophy, Sparkles, MessageSquarePlus, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { SITE } from '@/lib/constants'
import { T } from '@/components/i18n/T'

export const metadata: Metadata = {
  title: 'Community Corner',
  description: `Sports and community talent from ${SITE.name} village.`,
}

// Real gap, 2026-10-06: this page used to show fabricated Urdu poems (with
// invented named authors), fabricated sports results, and a fabricated
// "Kids Corner" — none of it read from any table. Same problem as
// /education: harmless on one village's own site, but it would show the
// exact same fake poems and scores on every other village's site, word
// for word. Replaced with links to the real, data-backed systems this app
// already has for exactly this content (village_events filtered to
// category=sports, and the Talent Showcase) instead of inventing a
// second, unbacked version of either.
export default function EntertainmentPage() {
  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="text-center mb-12 max-w-3xl mx-auto">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
          <T k="x.communityCorner" />
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px]">
          Sports, talent, and community life from the village.
        </p>
      </div>

      <section className="mb-6">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center gap-5">
          <div className="w-14 h-14 shrink-0 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center">
            <Trophy size={28} />
          </div>
          <div className="flex-1">
            <h2 className="font-heading text-[22px] font-bold leading-[30px] text-dp-primary mb-1.5">
              <T k="x.sportsUpdates" />
            </h2>
            <p className="text-dp-on-surface-variant font-sans text-[14.5px] leading-[22px]">
              Tournaments, matches, and athletics days — the same village events calendar the committee keeps up to date, filtered to sports.
            </p>
          </div>
          <Link href="/sports" className="shrink-0 inline-flex items-center gap-1.5 bg-dp-primary text-white px-5 py-2.5 rounded-lg font-sans text-[14px] font-semibold hover:brightness-110 transition-all">
            View Sports Calendar <ArrowRight size={15} />
          </Link>
        </div>
      </section>

      <section className="mb-10">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center gap-5">
          <div className="w-14 h-14 shrink-0 rounded-lg bg-pink-100 text-pink-600 flex items-center justify-center">
            <Sparkles size={28} />
          </div>
          <div className="flex-1">
            <h2 className="font-heading text-[22px] font-bold leading-[30px] text-dp-primary mb-1.5">Talent Showcase</h2>
            <p className="text-dp-on-surface-variant font-sans text-[14.5px] leading-[22px]">
              Poetry, art, Quran recitation, and other talent submitted by villagers themselves — admin-reviewed before it goes up.
            </p>
          </div>
          <Link href="/talent" className="shrink-0 inline-flex items-center gap-1.5 bg-dp-primary text-white px-5 py-2.5 rounded-lg font-sans text-[14px] font-semibold hover:brightness-110 transition-all">
            View Talent Showcase <ArrowRight size={15} />
          </Link>
        </div>
      </section>

      <div className="bg-dp-primary-container text-white rounded-lg p-8 text-center">
        <div className="inline-flex items-center justify-center p-2.5 bg-white/15 rounded-full mb-3">
          <MessageSquarePlus size={22} />
        </div>
        <h3 className="font-heading text-[22px] font-bold leading-[30px] mb-2">
          <T k="x.talentToShare" />
        </h3>
        <p className="opacity-90 font-sans text-[15px] mb-6 max-w-xl mx-auto">
          Have an idea for a community event or activity? Suggest it to the committee.
        </p>
        <Link
          href="/suggestions"
          className="inline-block bg-dp-secondary-fixed text-dp-on-secondary-fixed px-8 py-3 rounded-lg font-sans font-semibold hover:scale-105 transition-transform"
        >
          <T k="x.submitContent" />
        </Link>
      </div>
    </div>
  )
}
