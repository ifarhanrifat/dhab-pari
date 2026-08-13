'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Scale, ArrowRight, Users } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ZakatCalculator } from '@/components/welfare/ZakatCalculator'

/**
 * The donor's side of Zakat.
 *
 * There is no list of recipients here and there never will be. The whole point
 * of the pool is that the giver does not choose — that is what stops the same
 * visible family receiving everything while others receive nothing. What the
 * giver gets instead is the arithmetic, the counts, and the formula.
 */

interface Round {
  id: string; name: string; name_ur: string | null; fund_type: string
  base_per_household: number; per_dependant_increment: number; formula_note: string | null
  distribution_date: string | null; status: string
  collected_pkr: number; distributed_pkr: number; household_count: number
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function PortalZakatPage() {
  const { t } = useLocale()
  const [round, setRound] = useState<Round | null>(null)
  const [needs, setNeeds] = useState<Record<string, number>>({})

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.from('zakat_rounds').select('*')
        .not('status', 'in', '("closed","cancelled")')
        .order('opened_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.rpc('needs_register_summary'),
    ]).then(([{ data: r }, { data: n }]) => {
      setRound((r ?? null) as Round | null)
      setNeeds((n ?? {}) as Record<string, number>)
    })
  }, [])

  const perHousehold = round && round.household_count > 0
    ? round.collected_pkr / round.household_count
    : 0

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <Scale size={24} className="text-dp-secondary" /> {t('pzk.title')}
        </h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pzk.blurb')}</p>
      </div>

      {/* ── Why you do not pick a recipient ─────────────────────────────── */}
      <div className="bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3.5 mb-5">
        <p className="font-sans text-[13px] text-dp-on-surface leading-relaxed mb-1.5"
          style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
          {t('pzk.whyUrdu')}
        </p>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('pzk.whyEnglish')}</p>
      </div>

      {/* ── Who it reaches ──────────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface flex items-center gap-2 mb-1">
          <Users size={17} className="text-dp-secondary" /> {t('pzk.whoItReaches')}
        </h2>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('pzk.whoItReachesHelp')}</p>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {([
            ['verified_households', 'pzk.stat.households'],
            ['widow_headed', 'pzk.stat.widows'],
            ['with_orphans', 'pzk.stat.orphans'],
            ['with_disabled', 'pzk.stat.disabled'],
          ] as const).map(([key, lbl]) => (
            <div key={key}>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t(lbl)}</p>
              <p className="font-heading text-[24px] font-bold text-dp-primary">{needs[key] ?? 0}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── The current round ───────────────────────────────────────────── */}
      {round && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5">
          <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
            <h2 className="font-heading text-[20px] font-bold text-dp-primary">{round.name}</h2>
            <span className="px-2.5 py-1 rounded-full bg-dp-surface-container-low font-sans text-[12px] font-semibold">
              {t(`zk.status.${round.status}`)}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('zk.collected')}</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">Rs {fmt(round.collected_pkr)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('zk.card.households')}</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">{round.household_count}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pzk.perHousehold')}</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">Rs {fmt(perHousehold)}</p>
            </div>
          </div>

          {/* The formula, published rather than described. */}
          <div className="bg-dp-surface-container-low rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-1.5">{t('zk.formula')}</p>
            <p className="font-sans text-[13px] text-dp-on-surface">
              {t('zk.base')}: <strong>{round.base_per_household}</strong> · {t('zk.perDependant')}: <strong>{round.per_dependant_increment}</strong>
            </p>
            {round.formula_note && (
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5 italic">{round.formula_note}</p>
            )}
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">{t('pzk.formulaFixed')}</p>
          </div>

          {round.distribution_date && (
            <p className="font-sans text-[13px] text-dp-on-surface-variant mt-3">
              {t('zk.distributionOn')} {new Date(round.distribution_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          )}
        </div>
      )}

      <Link href="/portal/donate"
        className="flex items-center justify-center gap-2 w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all mb-8">
        {t('pzk.giveZakat')} <ArrowRight size={16} />
      </Link>

      {/* ── Calculator ──────────────────────────────────────────────────── */}
      <ZakatCalculator />
    </div>
  )
}
