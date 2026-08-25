'use client'

// A real dropdown of existing sectors (per explicit request — the old
// text-input-with-datalist let someone type a sector name that half-matched
// an existing one and silently created a duplicate). "Other" still lets a
// genuinely new sector be typed in, since a sector list can't always be
// complete for every village.
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function SectorSelect({
  sectors, value, onChange,
}: {
  sectors: string[]
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useLocale()
  const isKnownSector = value === '' || sectors.includes(value)

  return (
    <div>
      <select
        value={isKnownSector ? value : '__other__'}
        onChange={(e) => onChange(e.target.value === '__other__' ? ' ' : e.target.value)}
        className="input-field"
      >
        <option value="">{t('p.selectSector')}</option>
        {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        <option value="__other__">{t('p.otherSector')}</option>
      </select>
      {!isKnownSector && (
        <input
          value={value.trim() === '' ? '' : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('p.typeSectorName')}
          className="input-field mt-2"
          autoFocus
        />
      )}
    </div>
  )
}
