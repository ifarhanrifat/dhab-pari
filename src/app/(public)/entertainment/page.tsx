import type { Metadata } from 'next'
import { BookOpen, Trophy, Smile } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Community Corner',
  description: `Poetry, sports updates, and kids activities from ${SITE.name} village.`,
}
import Link from 'next/link'
import { SITE } from '@/lib/constants'
import { T } from '@/components/i18n/T'

export default function EntertainmentPage() {
  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="text-center mb-12 max-w-3xl mx-auto">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
          <T k="x.communityCorner" />
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px]">
          Poetry, sports updates, and kids activities from the village.
        </p>
      </div>

      {/* Poetry Section */}
      <section className="mb-16">
        <div className="flex items-center gap-3 mb-6">
          <BookOpen size={24} className="text-dp-secondary" />
          <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary section-title">
            Poetry / شاعری
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[
            {
              title: 'گاؤں کی صبح',
              author: 'ملک ارشد',
              lines: 'فجر کی اذان گونجے، چڑیوں کی چہچہاہٹ\nکھیتوں سے آئے خوشبو، گاؤں کی ہے فطرت',
            },
            {
              title: 'پانی کی قدر',
              author: 'حاجی رشید',
              lines: 'پانی ہے تو زندگی ہے، ہر قطرے کی قدر کرو\nبچوں کو بھی سکھاؤ، پانی کو ضائع نہ کرو',
            },
          ].map((poem, i) => (
            <div
              key={i}
              className="bg-white border border-dp-outline-variant rounded-lg p-6 hover:border-dp-secondary transition-all"
            >
              <h3
                className="text-dp-primary text-[20px] font-bold mb-3"
                style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2', direction: 'rtl' }}
              >
                {poem.title}
              </h3>
              <div
                className="text-dp-on-surface text-[18px] mb-4 whitespace-pre-line"
                style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5', direction: 'rtl' }}
              >
                {poem.lines}
              </div>
              <p
                className="text-dp-on-surface-variant text-[14px] font-sans border-t border-dp-outline-variant pt-3"
                style={{ direction: 'rtl', fontFamily: 'var(--font-urdu), serif' }}
              >
                — {poem.author}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Sports Updates */}
      <section className="mb-16">
        <div className="flex items-center gap-3 mb-6">
          <Trophy size={24} className="text-amber-600" />
          <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary section-title">
            <T k="x.sportsUpdates" />
          </h2>
        </div>
        <div className="space-y-4">
          {[
            { title: 'Cricket Tournament 2024', detail: 'Sector A vs Sector B — Final on Friday at village ground', status: 'Upcoming' },
            { title: 'Kabaddi Championship', detail: `${SITE.name} team won against Mirpur village (32-28)`, status: 'Won' },
            { title: 'Football League', detail: 'Youth league registration open — 8 teams confirmed', status: 'Open' },
            { title: 'Annual Athletics Day', detail: 'Scheduled for 15th March — track events, tug of war, relay races', status: 'Planning' },
          ].map((item, i) => (
            <div
              key={i}
              className={`bg-white border border-dp-outline-variant rounded-lg p-5 flex items-center justify-between hover:border-dp-secondary transition-all ${i % 2 === 1 ? 'bg-dp-surface-container-low' : ''}`}
            >
              <div>
                <h3 className="font-sans text-[16px] font-bold text-dp-on-surface">{item.title}</h3>
                <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{item.detail}</p>
              </div>
              <span className={`px-3 py-1 rounded-full text-[12px] font-bold font-sans shrink-0 ${
                item.status === 'Won' ? 'bg-dp-secondary-container text-dp-on-secondary-container' :
                item.status === 'Upcoming' ? 'bg-amber-100 text-amber-800' :
                item.status === 'Open' ? 'bg-blue-100 text-blue-700' :
                'bg-dp-surface-container text-dp-on-surface-variant'
              }`}>
                {item.status}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Kids Corner */}
      <section className="mb-16">
        <div className="flex items-center gap-3 mb-6">
          <Smile size={24} className="text-pink-500" />
          <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary section-title">
            <T k="x.kidsCorner" />
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { emoji: '🎨', title: 'Drawing Competition', desc: 'Monthly art competition for kids under 12. Submit at the village office.' },
            { emoji: '📖', title: 'Story Time', desc: 'Every Saturday at the community hall — folk tales and moral stories in Urdu.' },
            { emoji: '🏃', title: 'Mini Sports Day', desc: 'Running races, sack race, and musical chairs for kids every month.' },
          ].map((item, i) => (
            <div
              key={i}
              className="bg-white border border-dp-outline-variant rounded-lg p-6 text-center hover:border-dp-secondary transition-all"
            >
              <span className="text-[48px] block mb-4">{item.emoji}</span>
              <h3 className="font-sans text-[18px] font-bold text-dp-on-surface mb-2">{item.title}</h3>
              <p className="text-dp-on-surface-variant font-sans text-[14px]">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <div className="bg-dp-primary-container text-white rounded-lg p-8 text-center">
        <h3 className="font-heading text-[24px] font-bold leading-[32px] mb-2">
          <T k="x.talentToShare" />
        </h3>
        <p className="opacity-90 font-sans text-[16px] mb-6">
          Submit your poetry, sports results, or kids&apos; activities for the community page.
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
