'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, useInView } from 'motion/react'
import { Scale, GraduationCap, BookOpen, Gift, ArrowRight, ShieldCheck, Info } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * The four welfare appeals, on the home page.
 *
 * Built the way the appeal sites that actually raise money build them, because
 * the counting stat and the emotive line do different jobs and both are
 * needed. The number answers "is this real?" — the reason nobody gives to a
 * page of promises. The line answers "why should I care?" — the reason nobody
 * gives to a page of statistics either.
 *
 * The Urdu motto is the headline rather than a translation underneath it. Most
 * of the people who read this page read Urdu first, and a village committee's
 * appeal that leads in English is an appeal aimed past its own village.
 *
 * Every card carries its own numbers top-left and top-right, one emotive line,
 * one plain sentence on how to apply, and one way through to the full
 * explanation. Nothing else — a card that tries to say everything gets read as
 * far as the first paragraph.
 */

interface Props {
  needs: Record<string, number>
  kafalat: Record<string, number>
  wazifa: Record<string, number>
  sadqaWorking: number
  sadqaTotal: number
}

/** Counts up when the card scrolls into view — the number earns a glance. */
function Counter({ to, duration = 1100 }: { to: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })
  const [n, setN] = useState(0)

  useEffect(() => {
    if (!inView || to <= 0) { setN(to); return }
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      // Ease-out: fast first, settling at the end, so the eye lands on the
      // final figure rather than watching a linear crawl.
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inView, to, duration])

  return <span ref={ref} className="tabular-nums">{n.toLocaleString()}</span>
}

export function WelfareCards({ needs, kafalat, wazifa, sadqaWorking, sadqaTotal }: Props) {
  const { t, isUrdu } = useLocale()

  const cards = [
    {
      key: 'wazifa',
      icon: BookOpen,
      href: '/portal/wazifa',
      // Each module gets its own colour so a returning visitor recognises the
      // card before reading it.
      tint: 'from-indigo-600 to-indigo-800',
      accent: 'text-indigo-700',
      ring: 'group-hover:border-indigo-400',
      leftValue: wazifa.students_supported ?? 0,
      leftLabel: t('hw.wazifa.stat1'),
      rightValue: wazifa.graduated ?? 0,
      rightLabel: t('hw.wazifa.stat2'),
      mottoUr: t('hw.wazifa.mottoUr'),
      motto: t('hw.wazifa.motto'),
      body: t('hw.wazifa.body'),
      how: t('hw.wazifa.how'),
      cta: t('hw.wazifa.cta'),
    },
    {
      key: 'kafalat',
      icon: GraduationCap,
      href: '/portal/kafalat',
      tint: 'from-emerald-600 to-emerald-800',
      accent: 'text-emerald-700',
      ring: 'group-hover:border-emerald-400',
      leftValue: kafalat.active_children ?? 0,
      leftLabel: t('hw.kafalat.stat1'),
      rightValue: kafalat.awaiting_sponsor ?? 0,
      rightLabel: t('hw.kafalat.stat2'),
      mottoUr: t('hw.kafalat.mottoUr'),
      motto: t('hw.kafalat.motto'),
      body: t('hw.kafalat.body'),
      how: t('hw.kafalat.how'),
      cta: t('hw.kafalat.cta'),
    },
    {
      key: 'zakat',
      icon: Scale,
      href: '/portal/zakat',
      tint: 'from-amber-600 to-amber-800',
      accent: 'text-amber-700',
      ring: 'group-hover:border-amber-400',
      leftValue: needs.verified_households ?? 0,
      leftLabel: t('hw.zakat.stat1'),
      rightValue: needs.widow_headed ?? 0,
      rightLabel: t('hw.zakat.stat2'),
      mottoUr: t('hw.zakat.mottoUr'),
      motto: t('hw.zakat.motto'),
      body: t('hw.zakat.body'),
      how: t('hw.zakat.how'),
      cta: t('hw.zakat.cta'),
    },
    {
      key: 'esal',
      icon: Gift,
      href: '/sadqa-jariya',
      tint: 'from-sky-600 to-sky-800',
      accent: 'text-sky-700',
      ring: 'group-hover:border-sky-400',
      leftValue: sadqaWorking,
      leftLabel: t('hw.esal.stat1'),
      rightValue: sadqaTotal,
      rightLabel: t('hw.esal.stat2'),
      mottoUr: t('hw.esal.mottoUr'),
      motto: t('hw.esal.motto'),
      body: t('hw.esal.body'),
      how: t('hw.esal.how'),
      cta: t('hw.esal.cta'),
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
        {cards.map((c, i) => (
          <motion.div
            key={c.key}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.45, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ y: -4 }}
            className="group"
          >
            <Link href={c.href}
              className={`block h-full bg-white border-2 border-dp-outline-variant ${c.ring} rounded-2xl overflow-hidden transition-colors duration-300 shadow-sm hover:shadow-lg`}>

              {/* ── The coloured head, with a number in each corner ────────
                  Left is the reach, right is the gap still open. Two figures
                  side by side say more than either alone: this many helped,
                  this many still waiting. */}
              <div className={`relative bg-gradient-to-br ${c.tint} text-white px-5 pt-4 pb-6 overflow-hidden`}>
                {/* A soft disc behind the icon so the head is not a flat slab. */}
                <div className="absolute -right-8 -top-10 w-40 h-40 rounded-full bg-white/10" aria-hidden />
                <div className="absolute -left-10 -bottom-14 w-32 h-32 rounded-full bg-black/10" aria-hidden />

                <div className="relative flex items-start justify-between gap-3">
                  <div className="text-start">
                    <p className="font-heading text-[30px] font-bold leading-none">
                      <Counter to={c.leftValue} />
                    </p>
                    <p className="font-sans text-[11.5px] font-semibold opacity-90 mt-1 max-w-[110px] leading-tight">
                      {c.leftLabel}
                    </p>
                  </div>

                  <c.icon size={26} className="opacity-90 shrink-0 mt-1" />

                  <div className="text-end">
                    <p className="font-heading text-[30px] font-bold leading-none">
                      <Counter to={c.rightValue} />
                    </p>
                    <p className="font-sans text-[11.5px] font-semibold opacity-90 mt-1 max-w-[110px] leading-tight ms-auto">
                      {c.rightLabel}
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-5">
                {/* ── The motto ────────────────────────────────────────────
                    Urdu leads. This page is read by the village first, and an
                    appeal that opens in English is aimed past the people it is
                    written for. */}
                <p className="font-sans text-[19px] leading-[2] text-dp-primary font-bold mb-1"
                  style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                  {c.mottoUr}
                </p>
                <p className={`font-heading text-[16.5px] font-bold ${c.accent} leading-snug mb-3`}>
                  {c.motto}
                </p>

                <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed mb-4">
                  {c.body}
                </p>

                {/* ── How to apply ───────────────────────────────────────── */}
                <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 mb-4">
                  <Info size={14} className="text-dp-on-surface-variant shrink-0 mt-0.5" />
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">
                    {c.how}
                  </p>
                </div>

                <span className={`inline-flex items-center gap-1.5 font-sans text-[13.5px] font-bold ${c.accent} group-hover:gap-2.5 transition-all`}>
                  {c.cta}
                  <ArrowRight size={15} className={isUrdu ? 'rotate-180' : ''} />
                </span>
              </div>
            </Link>
          </motion.div>
        ))}
      </div>

      {/* The promise, where a worried family reads it before deciding whether
          to put their name down at all. */}
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.3 }}
        className="mt-5 flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3.5"
      >
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
      </motion.div>
    </section>
  )
}
