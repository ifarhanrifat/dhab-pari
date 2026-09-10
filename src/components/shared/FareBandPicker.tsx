'use client'

// The band picker — ported from the design's own one-off-trip screen,
// which this app previously only gave a one-line text hint for
// ("Suggested: Rs X–Y"). The design's real widget is a fair-value
// display + a min/fair/max progress bar + a row of step chips pulled
// straight from fare_band()'s own `steps` array (484) — tapping a chip
// just fills the amount, it doesn't submit on its own, matching how
// the prototype's chips work (a shortcut into the same input, not a
// separate action).
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface FareBand { min: number; max: number; fair: number; steps: number[] }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function FareBandPicker({ band, value, onChange, ownerLabel }: {
  band: FareBand; value: number | ''; onChange: (v: number) => void; ownerLabel: string
}) {
  const { t } = useLocale()
  const pct = band.max > band.min ? Math.max(0, Math.min(100, ((Number(value) || band.fair) - band.min) / (band.max - band.min) * 100)) : 50

  return (
    <div className="border-2 border-dp-outline-variant rounded-lg p-3 mt-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="font-sans text-[10px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant">{t('cm.bandSetByCommittee')}</p>
        <p className="font-sans text-[10px] font-bold uppercase tracking-[0.05em] text-dp-secondary">{ownerLabel}</p>
      </div>
      <p className="font-heading text-[26px] font-bold text-dp-primary ltr-num">{fmt(Number(value) || band.fair)}</p>

      <div className="relative h-1.5 bg-dp-surface-container-high rounded-full mt-3 mb-1.5">
        <div className="absolute inset-y-0 start-0 bg-dp-secondary rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between font-sans text-[10px] text-dp-on-surface-variant ltr-num">
        <span>{fmt(band.min)} {t('cm.minSuffix')}</span>
        <span>{fmt(band.fair)} {t('cm.fairSuffix')}</span>
        <span>{fmt(band.max)} {t('cm.maxSuffix')}</span>
      </div>

      <div className="flex flex-wrap gap-1.5 mt-3">
        {band.steps.map((s) => (
          <button key={s} type="button" onClick={() => onChange(s)}
            className={`px-2.5 py-1.5 rounded-md font-sans text-[12px] font-semibold cursor-pointer ltr-num transition-colors ${Number(value) === s ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface hover:bg-dp-surface-container-high'}`}>
            {fmt(s)}
          </button>
        ))}
      </div>
    </div>
  )
}
