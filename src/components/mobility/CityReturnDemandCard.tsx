'use client'

// Real ask, 2026-10-27: riders who commute out for work all week can
// now save a recurring "I leave Monday, I'm back Friday" schedule
// (rider_weekly_schedules, 743). Their own identity never surfaces
// here — city_return_demand() only returns an aggregate count per
// city + return day plus a rough seat-availability estimate, so a
// driver deciding where to post or run a route sees real demand
// without any individual rider being identifiable.
//
// Shared between the driver home page and the Routes posting screen
// (both want the exact same list, just in a different slot on the
// page) rather than two copies of the same fetch+render.

import { useEffect, useState } from 'react'
import { Users2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface DemandRow {
  city_id: string; city_name: string; city_name_ur: string | null
  return_day_of_week: number; is_today: boolean
  waiting_riders: number; seats_available: number; chance_pct: number
}

export function CityReturnDemandCard({ limit = 4 }: { limit?: number }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [rows, setRows] = useState<DemandRow[] | null>(null)

  useEffect(() => {
    supabase.rpc('city_return_demand').then(({ data }) => setRows((data as DemandRow[]) ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (rows === null || rows.length === 0) return null

  return (
    <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
      <p className="font-sans text-[12.5px] font-bold text-[#005A36] flex items-center gap-1.5 mb-2"><Users2 size={14} /> {t('mv.cityDemandHeading')}</p>
      <div className="flex flex-col gap-1.5">
        {rows.slice(0, limit).map((r) => (
          <div key={`${r.city_id}-${r.return_day_of_week}`} className="flex items-center justify-between gap-2 text-[12.5px] font-sans">
            <span className="text-[#1e293b] font-semibold truncate">
              📍 {isUrdu && r.city_name_ur ? r.city_name_ur : r.city_name}
              <span className="text-[#64748b] font-normal"> · {r.is_today ? t('mv.returningTodayLabel') : t(`mv.dayShort.${r.return_day_of_week}`)}</span>
            </span>
            <span className="shrink-0 text-end">
              <span className="font-bold text-[#166534] ltr-num">{r.waiting_riders}</span>{' '}
              <span className="text-[#64748b]">{t('mv.ridersWaitingLabel')}</span>{' · '}
              <span className="font-bold ltr-num" style={{ color: r.chance_pct >= 60 ? '#166534' : r.chance_pct >= 30 ? '#92400e' : '#b91c1c' }}>{r.chance_pct}%</span>
            </span>
          </div>
        ))}
      </div>
      <p className="font-sans text-[10.5px] text-[#94a3b8] mt-2">{t('mv.cityDemandHint')}</p>
    </div>
  )
}
