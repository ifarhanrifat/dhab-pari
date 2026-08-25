'use client'

import Link from 'next/link'
import { Users, School, CalendarClock, Sparkles, ArrowRight, Info } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * The mentorship/career program, on the home page — same visual language
 * as WelfareCards right down the page: a dark stat header, an Urdu motto
 * leading the body, an "how this works" info strip, and a plain text CTA.
 * Consistency matters more here than novelty; a visitor who trusts the
 * welfare cards should recognise this as the same committee, not a
 * different product bolted on.
 */

interface Props {
  mentorsAvailable: number
  institutes: number
  trainingProgramsOpen: number
  talentShowcased: number
}

const fmt = (n: number) => Number(n || 0).toLocaleString()

export function CareerCards({ mentorsAvailable, institutes, trainingProgramsOpen, talentShowcased }: Props) {
  const { t, isUrdu } = useLocale()

  const cards = [
    {
      key: 'mentors',
      icon: Users,
      href: '/portal/mentors',
      title: t('cc.mentors.title'),
      value: mentorsAvailable,
      valueLabel: t('cc.mentors.valueLabel'),
      mottoUr: t('cc.mentors.mottoUr'),
      motto: t('cc.mentors.motto'),
      body: t('cc.mentors.body'),
      how: t('cc.mentors.how'),
      cta: t('cc.mentors.cta'),
    },
    {
      key: 'institutes',
      icon: School,
      href: '/portal/institutes',
      title: t('cc.institutes.title'),
      value: institutes,
      valueLabel: t('cc.institutes.valueLabel'),
      mottoUr: t('cc.institutes.mottoUr'),
      motto: t('cc.institutes.motto'),
      body: t('cc.institutes.body'),
      how: t('cc.institutes.how'),
      cta: t('cc.institutes.cta'),
    },
    {
      key: 'training',
      icon: CalendarClock,
      href: '/portal/training-programs',
      title: t('cc.training.title'),
      value: trainingProgramsOpen,
      valueLabel: t('cc.training.valueLabel'),
      mottoUr: t('cc.training.mottoUr'),
      motto: t('cc.training.motto'),
      body: t('cc.training.body'),
      how: t('cc.training.how'),
      cta: t('cc.training.cta'),
    },
    {
      key: 'talent',
      icon: Sparkles,
      href: '/talent',
      title: t('cc.talent.title'),
      value: talentShowcased,
      valueLabel: t('cc.talent.valueLabel'),
      mottoUr: t('cc.talent.mottoUr'),
      motto: t('cc.talent.motto'),
      body: t('cc.talent.body'),
      how: t('cc.talent.how'),
      cta: t('cc.talent.cta'),
    },
  ]

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title flex items-center gap-3">
          <Sparkles size={26} /> {t('cc.sectionTitle')}
        </h2>
        <Link href="/portal/mentors"
          className="text-dp-secondary font-bold hover:underline flex items-center text-[14px] font-sans tracking-[0.05em]">
          {t('cc.howItWorks')} <ArrowRight size={16} className="ms-1" />
        </Link>
      </div>

      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6 max-w-2xl leading-relaxed">
        {t('cc.sectionBlurb')}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {cards.map((c) => (
          <Link key={c.key} href={c.href}
            className="group block h-full bg-white border border-dp-outline-variant hover:border-dp-secondary rounded-lg overflow-hidden transition-colors">

            <div className="bg-dp-primary text-white px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <c.icon size={20} className="opacity-90 mb-1.5" />
                  <p className="font-heading text-[16px] font-bold leading-tight">{c.title}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-heading text-[26px] font-bold leading-none">{fmt(c.value)}</p>
                  <p className="font-sans text-[11px] font-semibold opacity-80 mt-1 leading-tight max-w-[104px] ms-auto">
                    {c.valueLabel}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-5">
              <p className="font-sans text-[18px] leading-[2] text-dp-primary font-bold mb-1"
                style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                {c.mottoUr}
              </p>
              <p className="font-heading text-[16px] font-bold text-dp-secondary leading-snug mb-3">
                {c.motto}
              </p>

              <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed mb-4">
                {c.body}
              </p>

              <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 mb-4">
                <Info size={14} className="text-dp-on-surface-variant shrink-0 mt-0.5" />
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">
                  {c.how}
                </p>
              </div>

              <span className="inline-flex items-center gap-1.5 font-sans text-[13.5px] font-bold text-dp-secondary group-hover:underline">
                {c.cta}
                <ArrowRight size={15} className={isUrdu ? 'rotate-180' : ''} />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
