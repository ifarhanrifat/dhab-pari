'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Calculator, Scale, Wheat, Info } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Zakat and Ushr calculator.
 *
 * Most people who owe zakat do not pay the right amount, not out of
 * unwillingness but because nobody ever sat down and worked it out with them.
 * This does the arithmetic in front of them.
 *
 * Two decisions worth knowing about:
 *
 * The nisab is taken from SILVER, not gold. Silver's threshold is far lower,
 * so more people cross it and more zakat reaches the poor — which is why it is
 * the majority recommendation for anyone holding mixed assets. Both are shown
 * so nobody has to take that on trust.
 *
 * Ushr defaults to 10%, not 5%, because Chakwal is barani — rain-fed. Land
 * watered by rain owes the full tenth; land watered by tubewell or canal owes
 * half. Getting this backwards halves what the fund should receive.
 */

const NISAB_GOLD_GRAMS = 87.48
const NISAB_SILVER_GRAMS = 612.36
// Five wasq, the threshold below which no ushr is due on produce.
const USHR_NISAB_KG = 653

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export function ZakatCalculator({ compact = false }: { compact?: boolean }) {
  const { t } = useLocale()
  const [tab, setTab] = useState<'zakat' | 'ushr'>('zakat')
  const [goldRate, setGoldRate] = useState(0)
  const [silverRate, setSilverRate] = useState(0)
  const [rateSource, setRateSource] = useState<{ sources: string[]; fetchedAt: string } | null>(null)
  const [rateError, setRateError] = useState(false)
  // Anyone who knows today's Chakwal sarafa rate can overrule the feed. A
  // local rate from the bazaar beats an international spot price for someone
  // valuing the bangles in their own house.
  const [manualRates, setManualRates] = useState(false)

  const [z, setZ] = useState({
    goldGrams: 0, silverGrams: 0, cash: 0, bank: 0,
    savings: 0, businessStock: 0, receivables: 0,
    debts: 0, bills: 0,
  })

  const [u, setU] = useState({
    produceKg: 0, pricePerKg: 0, irrigation: 'rain' as 'rain' | 'artificial',
  })

  useEffect(() => {
    // The committee's own figures win if it has entered any — a rate agreed
    // in a meeting is a deliberate decision and should not be overwritten by
    // a feed. Otherwise today's rate is fetched.
    createClient().from('site_settings').select('key, value')
      .in('key', ['zakat_gold_rate_pkr', 'zakat_silver_rate_pkr'])
      .then(async ({ data }) => {
        const m = Object.fromEntries((data ?? []).map((r) => [r.key, Number(r.value) || 0]))
        if ((m.zakat_gold_rate_pkr ?? 0) > 0 || (m.zakat_silver_rate_pkr ?? 0) > 0) {
          setGoldRate(m.zakat_gold_rate_pkr ?? 0)
          setSilverRate(m.zakat_silver_rate_pkr ?? 0)
          return
        }
        try {
          const res = await fetch('/api/metal-rates')
          if (!res.ok) { setRateError(true); return }
          const r = await res.json()
          setGoldRate(r.goldPkrPerGram)
          setSilverRate(r.silverPkrPerGram)
          setRateSource({ sources: r.sources, fetchedAt: r.fetchedAt })
        } catch {
          setRateError(true)
        }
      })
  }, [])

  const zakat = useMemo(() => {
    const goldValue = z.goldGrams * goldRate
    const silverValue = z.silverGrams * silverRate
    const assets = goldValue + silverValue + z.cash + z.bank + z.savings + z.businessStock + z.receivables
    const liabilities = z.debts + z.bills
    const net = Math.max(assets - liabilities, 0)

    const nisabGold = NISAB_GOLD_GRAMS * goldRate
    const nisabSilver = NISAB_SILVER_GRAMS * silverRate
    // The lower of the two, which is silver whenever a rate is known for it.
    const candidates = [nisabGold, nisabSilver].filter((x) => x > 0)
    const nisab = candidates.length > 0 ? Math.min(...candidates) : 0

    const due = nisab > 0 && net >= nisab ? net * 0.025 : 0
    return { goldValue, silverValue, assets, liabilities, net, nisabGold, nisabSilver, nisab, due }
  }, [z, goldRate, silverRate])

  const ushr = useMemo(() => {
    const value = u.produceKg * u.pricePerKg
    const rate = u.irrigation === 'rain' ? 0.10 : 0.05
    const aboveNisab = u.produceKg >= USHR_NISAB_KG
    return { value, rate, aboveNisab, due: aboveNisab ? value * rate : 0 }
  }, [u])

  const ratesMissing = goldRate === 0 && silverRate === 0

  const num = (v: number, set: (n: number) => void, ph?: string) => (
    <input type="number" min={0} value={v || ''} onChange={(e) => set(+e.target.value)}
      placeholder={ph} className="input-field text-end tabular-nums" />
  )
  const label = 'block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5'

  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-dp-outline-variant">
        <h2 className="font-heading text-[20px] font-bold text-dp-primary flex items-center gap-2">
          <Calculator size={20} className="text-dp-secondary" /> {t('zc.title')}
        </h2>
        {!compact && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{t('zc.blurb')}</p>}
      </div>

      <div className="flex gap-2 px-5 pt-4">
        {([
          ['zakat', 'zc.tab.zakat', Scale],
          ['ushr', 'zc.tab.ushr', Wheat],
        ] as const).map(([key, lbl, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === key ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            <Icon size={15} /> {t(lbl)}
          </button>
        ))}
      </div>

      {tab === 'zakat' && (
        <div className="mx-5 mt-4">
          {rateError && ratesMissing ? (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 mb-2">
              <Info size={15} className="text-amber-700 shrink-0 mt-0.5" />
              <p className="font-sans text-[12.5px] text-amber-900">{t('zc.ratesUnavailable')}</p>
            </div>
          ) : null}

          <div className="bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <p className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline">{t('zc.todaysRates')}</p>
              <button onClick={() => setManualRates(!manualRates)}
                className="font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer">
                {manualRates ? t('zc.useFeed') : t('zc.enterOwnRates')}
              </button>
            </div>

            {manualRates ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('zc.goldPerGram')}</label>
                  <input type="number" min={0} value={goldRate || ''} onChange={(e) => setGoldRate(+e.target.value)}
                    className="input-field !py-2 text-end tabular-nums" />
                </div>
                <div>
                  <label className="block font-sans text-[12px] text-dp-on-surface-variant mb-1">{t('zc.silverPerGram')}</label>
                  <input type="number" min={0} step="0.01" value={silverRate || ''} onChange={(e) => setSilverRate(+e.target.value)}
                    className="input-field !py-2 text-end tabular-nums" />
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <p className="font-sans text-[13px] text-dp-on-surface">
                  {t('zc.goldPerGram')}: <strong>Rs {fmt(goldRate)}</strong>
                </p>
                <p className="font-sans text-[13px] text-dp-on-surface">
                  {t('zc.silverPerGram')}: <strong>Rs {silverRate ? silverRate.toFixed(2) : '—'}</strong>
                </p>
              </div>
            )}

            {/* Where the numbers came from, named. A zakat figure worked out
                from an unattributed rate is a number nobody should act on. */}
            {rateSource && !manualRates && (
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2 leading-relaxed">
                {t('zc.rateSource')} <strong>{rateSource.sources.join(', ')}</strong>
                {' · '}
                {new Date(rateSource.fetchedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                {' — '}{t('zc.notOurRate')}
              </p>
            )}
          </div>
        </div>
      )}

      {tab === 'zakat' ? (
        <div className="p-5">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('zc.zakatHelp')}</p>

          <h3 className="font-sans text-[13px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-3">{t('zc.whatYouHave')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
            <div>
              <label className={label}>{t('zc.f.goldGrams')}</label>
              {num(z.goldGrams, (n) => setZ({ ...z, goldGrams: n }))}
              {goldRate > 0 && z.goldGrams > 0 && (
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">= Rs {fmt(zakat.goldValue)}</p>
              )}
            </div>
            <div>
              <label className={label}>{t('zc.f.silverGrams')}</label>
              {num(z.silverGrams, (n) => setZ({ ...z, silverGrams: n }))}
              {silverRate > 0 && z.silverGrams > 0 && (
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">= Rs {fmt(zakat.silverValue)}</p>
              )}
            </div>
            <div>
              <label className={label}>{t('zc.f.cash')}</label>
              {num(z.cash, (n) => setZ({ ...z, cash: n }))}
            </div>
            <div>
              <label className={label}>{t('zc.f.bank')}</label>
              {num(z.bank, (n) => setZ({ ...z, bank: n }))}
            </div>
            <div>
              <label className={label}>{t('zc.f.savings')}</label>
              {num(z.savings, (n) => setZ({ ...z, savings: n }))}
            </div>
            <div>
              <label className={label}>{t('zc.f.businessStock')}</label>
              {num(z.businessStock, (n) => setZ({ ...z, businessStock: n }))}
            </div>
            <div className="sm:col-span-2">
              <label className={label}>{t('zc.f.receivables')}</label>
              {num(z.receivables, (n) => setZ({ ...z, receivables: n }))}
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('zc.f.receivablesHint')}</p>
            </div>
          </div>

          <h3 className="font-sans text-[13px] font-bold uppercase tracking-[0.06em] text-dp-outline mb-3">{t('zc.whatYouOwe')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
            <div>
              <label className={label}>{t('zc.f.debts')}</label>
              {num(z.debts, (n) => setZ({ ...z, debts: n }))}
            </div>
            <div>
              <label className={label}>{t('zc.f.bills')}</label>
              {num(z.bills, (n) => setZ({ ...z, bills: n }))}
            </div>
          </div>

          <div className="bg-dp-surface-container-low rounded-lg p-4">
            <div className="flex items-center justify-between py-1 font-sans text-[13.5px]">
              <span className="text-dp-on-surface-variant">{t('zc.totalAssets')}</span>
              <span className="font-semibold tabular-nums">Rs {fmt(zakat.assets)}</span>
            </div>
            <div className="flex items-center justify-between py-1 font-sans text-[13.5px]">
              <span className="text-dp-on-surface-variant">{t('zc.totalLiabilities')}</span>
              <span className="font-semibold tabular-nums">− Rs {fmt(zakat.liabilities)}</span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-t border-dp-outline-variant mt-1.5 font-sans text-[14px]">
              <span className="font-semibold">{t('zc.netWealth')}</span>
              <span className="font-bold tabular-nums">Rs {fmt(zakat.net)}</span>
            </div>

            <div className="mt-3 pt-3 border-t border-dp-outline-variant">
              <div className="flex items-center justify-between py-0.5 font-sans text-[12.5px] text-dp-on-surface-variant">
                <span>{t('zc.nisabSilver')}</span>
                <span className="tabular-nums">Rs {fmt(zakat.nisabSilver)}</span>
              </div>
              <div className="flex items-center justify-between py-0.5 font-sans text-[12.5px] text-dp-on-surface-variant">
                <span>{t('zc.nisabGold')}</span>
                <span className="tabular-nums">Rs {fmt(zakat.nisabGold)}</span>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('zc.nisabNote')}</p>
            </div>

            <div className={`mt-4 rounded-lg px-4 py-3.5 ${zakat.due > 0 ? 'bg-dp-secondary/10' : 'bg-white border border-dp-outline-variant'}`}>
              {zakat.due > 0 ? (
                <>
                  <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface-variant">{t('zc.youOwe')}</p>
                  <p className="font-heading text-[30px] font-bold text-dp-primary leading-tight">Rs {fmt(zakat.due)}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{t('zc.twoPointFive')}</p>
                </>
              ) : (
                <p className="font-sans text-[13.5px] text-dp-on-surface-variant">
                  {zakat.net > 0 ? t('zc.belowNisab') : t('zc.enterValues')}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-5">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('zc.ushrHelp')}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div>
              <label className={label}>{t('zc.f.produceKg')}</label>
              {num(u.produceKg, (n) => setU({ ...u, produceKg: n }))}
            </div>
            <div>
              <label className={label}>{t('zc.f.pricePerKg')}</label>
              {num(u.pricePerKg, (n) => setU({ ...u, pricePerKg: n }))}
            </div>
          </div>

          <label className={label}>{t('zc.f.irrigation')}</label>
          <div className="space-y-2 mb-5">
            {([
              ['rain', 'zc.irr.rain', 'zc.irr.rainHelp'],
              ['artificial', 'zc.irr.artificial', 'zc.irr.artificialHelp'],
            ] as const).map(([value, lbl, help]) => (
              <label key={value} className={`flex items-start gap-2.5 px-3.5 py-3 rounded-lg border-2 cursor-pointer transition-all ${u.irrigation === value ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant'}`}>
                <input type="radio" name="irrigation" checked={u.irrigation === value}
                  onChange={() => setU({ ...u, irrigation: value })} className="accent-dp-secondary mt-0.5" />
                <span>
                  <span className="block font-sans text-[13.5px] font-semibold text-dp-on-surface">{t(lbl)}</span>
                  <span className="block font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t(help)}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="bg-dp-surface-container-low rounded-lg p-4">
            <div className="flex items-center justify-between py-1 font-sans text-[13.5px]">
              <span className="text-dp-on-surface-variant">{t('zc.produceValue')}</span>
              <span className="font-semibold tabular-nums">Rs {fmt(ushr.value)}</span>
            </div>
            <div className="flex items-center justify-between py-1 font-sans text-[13.5px]">
              <span className="text-dp-on-surface-variant">{t('zc.ushrRate')}</span>
              <span className="font-semibold tabular-nums">{(ushr.rate * 100).toFixed(0)}%</span>
            </div>

            <div className={`mt-3 rounded-lg px-4 py-3.5 ${ushr.due > 0 ? 'bg-dp-secondary/10' : 'bg-white border border-dp-outline-variant'}`}>
              {ushr.due > 0 ? (
                <>
                  <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface-variant">{t('zc.ushrDue')}</p>
                  <p className="font-heading text-[30px] font-bold text-dp-primary leading-tight">Rs {fmt(ushr.due)}</p>
                </>
              ) : (
                <p className="font-sans text-[13.5px] text-dp-on-surface-variant">
                  {u.produceKg > 0 && !ushr.aboveNisab ? t('zc.belowUshrNisab') : t('zc.enterValues')}
                </p>
              )}
            </div>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2.5">{t('zc.ushrNisabNote')}</p>
          </div>
        </div>
      )}

      <div className="px-5 pb-5">
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-relaxed mb-3">{t('zc.disclaimer')}</p>
        <p className="font-sans text-[11.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zc.crossCheck')}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {([
            ['Zakat & Ushr Department, Punjab', 'https://zakat.punjab.gov.pk/'],
            ['Alkhidmat Foundation', 'https://alkhidmat.org/zakat'],
            ['Saylani Welfare', 'https://saylaniwelfare.com/'],
          ] as const).map(([label, href]) => (
            <a key={href} href={href} target="_blank" rel="noopener noreferrer"
              className="font-sans text-[11.5px] text-dp-secondary hover:underline">
              {label} ↗
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
