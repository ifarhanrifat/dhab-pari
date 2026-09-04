'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Scale, GraduationCap, BookOpen, Gift, ShieldCheck, ArrowRight } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ZakatCalculator } from '@/components/welfare/ZakatCalculator'

/**
 * How the welfare side of the committee works, for the two people who need to
 * understand it: somebody who needs help, and somebody deciding whether to
 * give.
 *
 * Written for the first of those. A family that needs help will not read a
 * page written to reassure donors, and the wording that reassures a donor —
 * verification, eligibility, audit — is exactly the wording that makes an
 * anxious family close the tab.
 */

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function WelfarePage() {
  const { t } = useLocale()
  const [needs, setNeeds] = useState<Record<string, number>>({})
  const [kafalat, setKafalat] = useState<Record<string, number>>({})
  const [wazifa, setWazifa] = useState<Record<string, number>>({})

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.rpc('needs_register_summary'),
      supabase.rpc('public_kafalat_summary'),
      supabase.rpc('public_wazifa_summary'),
    ]).then(([{ data: n }, { data: k }, { data: w }]) => {
      setNeeds((n ?? {}) as Record<string, number>)
      setKafalat((k ?? {}) as Record<string, number>)
      setWazifa((w ?? {}) as Record<string, number>)
    })
  }, [])

  const modules = [
    {
      key: 'zakat', icon: Scale, href: '/portal/donate',
      title: t('wf.zakat.title'), lead: t('wf.zakat.lead'),
      forNeedy: t('wf.zakat.forNeedy'), forGiver: t('wf.zakat.forGiver'),
      steps: [t('wf.zakat.s1'), t('wf.zakat.s2'), t('wf.zakat.s3'), t('wf.zakat.s4')],
      stat: `${needs.verified_households ?? 0} ${t('wf.zakat.stat')}`,
    },
    {
      key: 'kafalat', icon: GraduationCap, href: '/portal/kafalat',
      title: t('wf.kafalat.title'), lead: t('wf.kafalat.lead'),
      forNeedy: t('wf.kafalat.forNeedy'), forGiver: t('wf.kafalat.forGiver'),
      steps: [t('wf.kafalat.s1'), t('wf.kafalat.s2'), t('wf.kafalat.s3'), t('wf.kafalat.s4')],
      stat: `${kafalat.active_children ?? 0} ${t('wf.kafalat.stat')}`,
    },
    {
      key: 'wazifa', icon: BookOpen, href: '/portal/wazifa',
      title: t('wf.wazifa.title'), lead: t('wf.wazifa.lead'),
      forNeedy: t('wf.wazifa.forNeedy'), forGiver: t('wf.wazifa.forGiver'),
      steps: [t('wf.wazifa.s1'), t('wf.wazifa.s2'), t('wf.wazifa.s3'), t('wf.wazifa.s4')],
      stat: `${wazifa.students_supported ?? 0} ${t('wf.wazifa.stat')}`,
    },
    {
      key: 'esal', icon: Gift, href: '/sadqa-jariya',
      title: t('wf.esal.title'), lead: t('wf.esal.lead'),
      forNeedy: t('wf.esal.forNeedy'), forGiver: t('wf.esal.forGiver'),
      steps: [t('wf.esal.s1'), t('wf.esal.s2'), t('wf.esal.s3'), t('wf.esal.s4')],
      stat: t('wf.esal.stat'),
    },
  ]

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[44px] text-dp-primary">{t('wf.title')}</h1>
        <p className="font-sans text-[15.5px] text-dp-on-surface-variant mt-2.5 leading-relaxed max-w-2xl">{t('wf.blurb')}</p>
      </div>

      {/* ── The promise that makes the rest possible ────────────────────── */}
      <div className="bg-dp-primary-container/10 border border-dp-outline-variant rounded-lg p-5 mb-10">
        <div className="flex items-start gap-3">
          <ShieldCheck size={22} className="text-dp-secondary shrink-0 mt-0.5" />
          <div>
            <h2 className="font-heading text-[19px] font-bold text-dp-primary mb-1.5">{t('wf.privacy.title')}</h2>
            <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed"
              style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
              {t('wf.privacy.urdu')}
            </p>
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant leading-relaxed mt-2">{t('wf.privacy.english')}</p>
          </div>
        </div>
      </div>

      {/* ── The four modules ────────────────────────────────────────────── */}
      <div className="space-y-6 mb-12">
        {modules.map((m) => (
          // Anchored — committee notes and other pages link straight to a
          // specific module (e.g. /welfare#kafalat) via src/lib/siteFeatureLinks.ts.
          <div key={m.key} id={m.key} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden scroll-mt-24">
            <div className="px-6 py-5 border-b border-dp-outline-variant">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-11 h-11 rounded-full bg-dp-secondary/10 text-dp-secondary flex items-center justify-center shrink-0">
                    <m.icon size={21} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="font-heading text-[23px] font-bold text-dp-primary leading-tight">{m.title}</h2>
                    <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1 leading-relaxed">{m.lead}</p>
                  </div>
                </div>
                <span className="shrink-0 px-3 py-1.5 rounded-full bg-dp-surface-container-low font-sans text-[12.5px] font-semibold text-dp-on-surface">
                  {m.stat}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-dp-outline-variant">
              <div className="px-6 py-5">
                <h3 className="font-sans text-[12px] font-bold uppercase tracking-[0.08em] text-dp-outline mb-2">{t('wf.ifYouNeed')}</h3>
                <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed">{m.forNeedy}</p>
              </div>
              <div className="px-6 py-5">
                <h3 className="font-sans text-[12px] font-bold uppercase tracking-[0.08em] text-dp-outline mb-2">{t('wf.ifYouGive')}</h3>
                <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed">{m.forGiver}</p>
              </div>
            </div>

            <div className="px-6 py-5 border-t border-dp-outline-variant bg-dp-surface-container-low/50">
              <h3 className="font-sans text-[12px] font-bold uppercase tracking-[0.08em] text-dp-outline mb-3">{t('wf.howItWorks')}</h3>
              <ol className="space-y-2">
                {m.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-dp-secondary text-white flex items-center justify-center font-sans text-[11px] font-bold mt-0.5">
                      {i + 1}
                    </span>
                    <span className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed">{s}</span>
                  </li>
                ))}
              </ol>

              <Link href={m.href}
                className="inline-flex items-center gap-1.5 mt-4 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">
                {t('wf.open')} <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        ))}
      </div>

      {/* ── Calculator ──────────────────────────────────────────────────── */}
      <div className="mb-10">
        <h2 className="font-heading text-[26px] font-bold text-dp-primary mb-2">{t('wf.calculator.title')}</h2>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mb-5 max-w-2xl leading-relaxed">{t('wf.calculator.blurb')}</p>
        <ZakatCalculator />
      </div>

      {/* ── How to apply ────────────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
        <h2 className="font-heading text-[22px] font-bold text-dp-primary mb-3">{t('wf.apply.title')}</h2>
        <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed mb-3"
          style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
          {t('wf.apply.urdu')}
        </p>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant leading-relaxed mb-4">{t('wf.apply.english')}</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/portal/login"
            className="px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">
            {t('wf.apply.signIn')}
          </Link>
          <Link href="/contact"
            className="px-4 py-2.5 border border-dp-outline-variant text-dp-on-surface rounded-lg font-sans text-[13.5px] font-semibold hover:border-dp-secondary transition-all">
            {t('wf.apply.contact')}
          </Link>
        </div>
      </div>
    </div>
  )
}
