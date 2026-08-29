'use client'

import Link from 'next/link'
import { Scale, GraduationCap, BookOpen, Gift, ArrowRight, ShieldCheck, Info } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * The four welfare appeals, on the home page.
 *
 * Deliberately still: no entrance animation and no counting figures. Movement
 * on a page like this reads as a marketing device, and a village committee
 * asking for zakat is better served looking plain and steady than looking
 * like it is selling something.
 *
 * The card still does two jobs at once. The figures answer "is this real?",
 * which is why nobody gives to a page of promises. The motto answers "why
 * should I care?", which is why nobody gives to a page of statistics either.
 *
 * The Urdu motto is the headline rather than a translation underneath it. Most
 * of the people who read this page read Urdu first, and a village committee's
 * appeal that leads in English is an appeal aimed past its own village.
 *
 * Colours come from the site palette rather than a per-card scheme, so these
 * sit inside the page instead of on top of it.
 */

interface Props {
  needs: Record<string, number>
  kafalat: Record<string, number>
  wazifa: Record<string, number>
  sadqaWorking: number
  sadqaTotal: number
  // Card copy — migration 307, admin-editable from Settings → Donors &
  // Projects → Welfare Cards. Keyed like `zakat_body_en`. A field falls back
  // to its old messages.ts text if the settings row is ever missing/blank,
  // so nothing breaks — it just means nobody has customised it yet.
  content: Record<string, string>
}

const fmt = (n: number) => Number(n || 0).toLocaleString()

export function WelfareCards({ needs, kafalat, wazifa, sadqaWorking, sadqaTotal, content }: Props) {
  const { t, isUrdu } = useLocale()

  // field is e.g. 'tab', 'motto', 'body' — resolved to `{card}_{field}_en` or
  // `{card}_{field}_ur` depending on the visitor's own language toggle.
  const get = (card: string, field: string, fallbackKey: string) =>
    (content[`${card}_${field}_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t(fallbackKey)
  // headline_ur has no _en counterpart — it's always the Urdu line, by design
  // (see the render below), regardless of which language is selected.
  const headline = (card: string, fallbackKey: string) =>
    (content[`${card}_headline_ur`] || '').trim() || t(fallbackKey)

  const cards = [
    {
      key: 'zakat',
      icon: Scale,
      href: '/portal/zakat',
      title: get('zakat', 'tab', 'hw.zakat.tab'),
      leftValue: needs.verified_households ?? 0,
      leftLabel: get('zakat', 'stat1', 'hw.zakat.stat1'),
      rightValue: needs.widow_headed ?? 0,
      rightLabel: get('zakat', 'stat2', 'hw.zakat.stat2'),
      mottoUr: headline('zakat', 'hw.zakat.mottoUr'),
      motto: get('zakat', 'motto', 'hw.zakat.motto'),
      body: get('zakat', 'body', 'hw.zakat.body'),
      how: get('zakat', 'how', 'hw.zakat.how'),
      cta: get('zakat', 'cta', 'hw.zakat.cta'),
    },
    {
      key: 'kafalat',
      icon: GraduationCap,
      href: '/portal/kafalat',
      title: get('kafalat', 'tab', 'hw.kafalat.tab'),
      leftValue: kafalat.active_children ?? 0,
      leftLabel: get('kafalat', 'stat1', 'hw.kafalat.stat1'),
      rightValue: kafalat.awaiting_sponsor ?? 0,
      rightLabel: get('kafalat', 'stat2', 'hw.kafalat.stat2'),
      mottoUr: headline('kafalat', 'hw.kafalat.mottoUr'),
      motto: get('kafalat', 'motto', 'hw.kafalat.motto'),
      body: get('kafalat', 'body', 'hw.kafalat.body'),
      how: get('kafalat', 'how', 'hw.kafalat.how'),
      cta: get('kafalat', 'cta', 'hw.kafalat.cta'),
    },
    {
      key: 'wazifa',
      icon: BookOpen,
      href: '/portal/wazifa',
      title: get('wazifa', 'tab', 'hw.wazifa.tab'),
      leftValue: wazifa.students_supported ?? 0,
      leftLabel: get('wazifa', 'stat1', 'hw.wazifa.stat1'),
      rightValue: wazifa.graduated ?? 0,
      rightLabel: get('wazifa', 'stat2', 'hw.wazifa.stat2'),
      mottoUr: headline('wazifa', 'hw.wazifa.mottoUr'),
      motto: get('wazifa', 'motto', 'hw.wazifa.motto'),
      body: get('wazifa', 'body', 'hw.wazifa.body'),
      how: get('wazifa', 'how', 'hw.wazifa.how'),
      cta: get('wazifa', 'cta', 'hw.wazifa.cta'),
    },
    {
      key: 'esal',
      icon: Gift,
      href: '/sadqa-jariya',
      title: get('esal', 'tab', 'hw.esal.tab'),
      leftValue: sadqaWorking,
      leftLabel: get('esal', 'stat1', 'hw.esal.stat1'),
      rightValue: sadqaTotal,
      rightLabel: get('esal', 'stat2', 'hw.esal.stat2'),
      mottoUr: headline('esal', 'hw.esal.mottoUr'),
      motto: get('esal', 'motto', 'hw.esal.motto'),
      body: get('esal', 'body', 'hw.esal.body'),
      how: get('esal', 'how', 'hw.esal.how'),
      cta: get('esal', 'cta', 'hw.esal.cta'),
    },
  ]

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title flex items-center gap-3">
          <ShieldCheck size={26} /> {t('home.welfare')}
        </h2>
        <Link href="/welfare"
          className="text-dp-secondary font-bold hover:underline flex items-center text-[14px] font-sans tracking-[0.05em]">
          {t('home.howItWorks')} <ArrowRight size={16} className="ms-1" />
        </Link>
      </div>

      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6 max-w-2xl leading-relaxed">
        {t('home.welfareBlurb')}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {cards.map((c) => (
          <Link key={c.key} href={c.href}
            className="group block h-full bg-white border border-dp-outline-variant hover:border-dp-secondary rounded-lg overflow-hidden transition-colors">

            {/* ── The head: name in the middle, a figure in each corner ────
                Left is the reach, right is the gap still open. Side by side
                they say more than either alone: this many carried, this many
                still waiting. The name is one short phrase and does not wrap. */}
            <div className="bg-dp-primary text-white px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="text-start shrink-0">
                  <p className="font-heading text-[26px] font-bold leading-none">{fmt(c.leftValue)}</p>
                  <p className="font-sans text-[11px] font-semibold opacity-80 mt-1 leading-tight max-w-[104px]">
                    {c.leftLabel}
                  </p>
                </div>

                <div className="flex-1 min-w-0 text-center pt-1">
                  <c.icon size={20} className="mx-auto opacity-90 mb-1.5" />
                  {/* leading-tight (1.25) clips Nastaliq's taller glyphs against
                      overflow-hidden — the single-line-truncation this needs —
                      cutting the bottom off every Urdu title. Urdu gets a much
                      taller line-height instead, matching the ratio the rest of
                      the app already uses for this same face (globals.css). */}
                  <p className={`font-heading text-[16px] font-bold whitespace-nowrap overflow-hidden text-ellipsis ${isUrdu ? 'leading-[2] pb-0.5' : 'leading-tight'}`}>
                    {c.title}
                  </p>
                </div>

                <div className="text-end shrink-0">
                  <p className="font-heading text-[26px] font-bold leading-none">{fmt(c.rightValue)}</p>
                  <p className="font-sans text-[11px] font-semibold opacity-80 mt-1 leading-tight max-w-[104px] ms-auto">
                    {c.rightLabel}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-5">
              {/* Urdu leads: this page is read by the village first. */}
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

      {/* The promise, where a worried family reads it before deciding whether
          to put their name down at all. */}
      <div className="mt-5 flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3.5">
        <ShieldCheck size={17} className="text-dp-secondary shrink-0 mt-0.5" />
        <div>
          <p className="font-sans text-[13.5px] text-dp-on-surface leading-[1.9] mb-1"
            style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
            {t('hw.privacyUr')}
          </p>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">
            {t('home.welfarePrivacy')}
          </p>
        </div>
      </div>
    </section>
  )
}
