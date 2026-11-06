'use client'

// The live meter for an hourly booking that's underway — the same sums
// end_hourly_trip will bill (base + extra km + overtime from the
// committee's hourly policy, 776), shown to the driver AND the rider so
// neither is surprised by the final bill. Distance comes from the
// booking row the caller already polls; time ticks here.

import { useEffect, useState } from 'react'
import { Clock, Gauge, Receipt, Pause } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useFarePolicy, hourlyOvertime } from '@/lib/farePolicy'

export interface HourlyMeterRow {
  hours: number; started_at: string | null; distance_km: number
  included_km?: number | null; overage_per_km_pkr?: number | null; hourly_rate_pkr?: number | null; base_amount_pkr?: number | null
  paused_at?: string | null; paused_minutes?: number | null
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function HourlyMeter({ row }: { row: HourlyMeterRow }) {
  const { t } = useLocale()
  const policy = useFarePolicy('hourly')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(iv)
  }, [])

  const isPaused = !!row.paused_at
  // Every past pause plus, while one is still open right now, the live
  // open interval too — so the clock visibly freezes the instant the
  // driver pauses rather than jumping only when they resume.
  const pausedMin = Number(row.paused_minutes ?? 0) + (isPaused ? Math.max(0, (now - new Date(row.paused_at!).getTime()) / 60000) : 0)
  const elapsedMin = row.started_at ? Math.max(0, Math.floor((now - new Date(row.started_at).getTime()) / 60000 - pausedMin)) : 0
  const bookedMin = row.hours * 60
  const includedKm = Number(row.included_km ?? 0)
  const extraKm = Math.max(0, Number(row.distance_km ?? 0) - includedKm)
  const extraKmAmount = Math.round(extraKm * Number(row.overage_per_km_pkr ?? 0))
  const rate = Number(row.hourly_rate_pkr ?? (row.base_amount_pkr ?? 0) / Math.max(row.hours, 1))
  const ot = hourlyOvertime(policy, row.hours, row.started_at, rate, now, pausedMin)
  const bill = Number(row.base_amount_pkr ?? rate * row.hours) + extraKmAmount + ot.amount
  const kmLeft = includedKm - Number(row.distance_km ?? 0)
  const minLeft = bookedMin - elapsedMin
  const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.abs(m) % 60).padStart(2, '0')}`

  return (
    <div className="rounded-2xl border border-[#bbf7d0] bg-[#f0fdf4] p-3 flex flex-col gap-2">
      {isPaused && (
        <p className="flex items-center justify-center gap-1.5 font-sans text-[12px] font-bold text-[#b45309] bg-amber-50 border border-amber-200 rounded-lg py-1.5">
          <Pause size={12} /> {t('hm.paused')}
        </p>
      )}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="flex items-center justify-center gap-1 font-sans text-[10.5px] font-semibold text-[#166534]/80"><Clock size={11} /> {t('hm.time')}</p>
          <p className={`font-sans text-[15px] font-extrabold ltr-num ${elapsedMin > bookedMin ? 'text-[#b45309]' : 'text-[#14532d]'}`}>{hm(elapsedMin)}<span className="text-[11px] font-semibold text-[#166534]/70"> / {hm(bookedMin)}</span></p>
        </div>
        <div>
          <p className="flex items-center justify-center gap-1 font-sans text-[10.5px] font-semibold text-[#166534]/80"><Gauge size={11} /> {t('hm.km')}</p>
          <p className={`font-sans text-[15px] font-extrabold ltr-num ${extraKm > 0 ? 'text-[#b45309]' : 'text-[#14532d]'}`}>{fmt(row.distance_km)}<span className="text-[11px] font-semibold text-[#166534]/70"> / {fmt(includedKm)}</span></p>
        </div>
        <div>
          <p className="flex items-center justify-center gap-1 font-sans text-[10.5px] font-semibold text-[#166534]/80"><Receipt size={11} /> {t('hm.bill')}</p>
          <p className="font-sans text-[15px] font-extrabold text-[#14532d]"><span className="ltr-num">₨{fmt(bill)}</span></p>
        </div>
      </div>
      {(extraKm > 0 || ot.minutes > 0) ? (
        <p className="font-sans text-[11.5px] text-[#92400e] text-center">
          {[extraKm > 0 ? t('hm.extraKm').replace('{km}', fmt(extraKm)).replace('{amount}', fmt(extraKmAmount)) : null,
            ot.minutes > 0 ? t('hm.overtime').replace('{min}', String(ot.minutes)).replace('{amount}', fmt(ot.amount)) : null].filter(Boolean).join(' · ')}
        </p>
      ) : (kmLeft <= 3 || (minLeft >= 0 && minLeft <= 15)) ? (
        <p className="font-sans text-[11.5px] text-[#b45309] text-center">{t('hm.nearLimit').replace('{km}', fmt(Math.max(0, kmLeft))).replace('{min}', String(Math.max(0, minLeft)))}</p>
      ) : null}
    </div>
  )
}
