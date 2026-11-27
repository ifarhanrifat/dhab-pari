'use client'

// Real ask, 2026-11-27: "can the calendar dates not be marked according
// to the available seats and routes during the manual booking phase,
// just like the air ticket is use to do?" — the booking form only ever
// had a plain native <input type="date">, with zero visibility into
// which days are full before tapping one. A real month-grid calendar,
// colored per day, using route_seats_available_range (976) — one round
// trip for the whole visible month instead of one request per day.

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

interface DayAvail { is_running: boolean; available: number | null }

function toISO(d: Date) { return d.toISOString().slice(0, 10) }
function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function addMonths(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth() + n, 1) }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x }

export function AvailabilityCalendarPicker({ routeId, value, onChange, onClose, minDate, title }: {
  routeId: string; value: string; onChange: (date: string) => void; onClose: () => void; minDate?: string; title?: string
}) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const todayIso = toISO(new Date())
  const floor = minDate && minDate > todayIso ? minDate : todayIso

  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date(value || floor)))
  const [avail, setAvail] = useState<Record<string, DayAvail>>({})
  const [loading, setLoading] = useState(false)

  // Grid always shows full weeks (Sun-start), so the visible range can
  // spill a few days into the adjacent months — fetched too, just
  // rendered dim/disabled, same as any real calendar picker.
  const gridStart = useMemo(() => addDays(viewMonth, -viewMonth.getDay()), [viewMonth])
  const gridDays = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart])
  const gridEnd = gridDays[41]

  useEffect(() => {
    setLoading(true)
    supabase.rpc('route_seats_available_range', { p_route_id: routeId, p_start_date: toISO(gridStart), p_end_date: toISO(gridEnd) })
      .then(({ data }) => {
        const map: Record<string, DayAvail> = {}
        for (const row of (data ?? []) as { travel_date: string; is_running: boolean; available: number | null }[]) {
          map[row.travel_date] = { is_running: row.is_running, available: row.available }
        }
        setAvail(map)
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, viewMonth])

  const weekdayLabels = isUrdu
    ? ['اتوار', 'پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ']
    : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
  const monthLabel = viewMonth.toLocaleDateString(isUrdu ? 'ur' : 'en-US', { month: 'long', year: 'numeric' })
  const prevMonth = addMonths(viewMonth, -1)
  const prevMonthLastDay = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0)
  const canGoPrev = toISO(prevMonthLastDay) >= floor

  const pick = (iso: string) => { onChange(iso); onClose() }

  return (
    <MobilityBottomSheet title={title ?? t('mv.pickTravelDateHeading')} onClose={onClose}>
      <div className="flex items-center justify-between mb-2.5">
        <button type="button" onClick={() => setViewMonth((m) => addMonths(m, -1))} disabled={!canGoPrev}
          className="p-1.5 rounded-lg border border-[#e5e2d0] text-[#334155] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">
          <ChevronLeft size={16} />
        </button>
        <p className="font-sans text-[13.5px] font-bold text-[#1e293b] ltr-num">{monthLabel}</p>
        <button type="button" onClick={() => setViewMonth((m) => addMonths(m, 1))}
          className="p-1.5 rounded-lg border border-[#e5e2d0] text-[#334155] cursor-pointer">
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {weekdayLabels.map((w) => (
          <p key={w} className="font-sans text-[10px] font-bold text-[#94a3b8] text-center uppercase">{w}</p>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {gridDays.map((d) => {
          const iso = toISO(d)
          const inMonth = d.getMonth() === viewMonth.getMonth()
          const isPast = iso < floor
          const a = avail[iso]
          const isSelected = iso === value
          const full = !!a && a.is_running && (a.available ?? 0) <= 0
          const notRunning = !!a && !a.is_running
          const disabled = isPast || full || notRunning || (!a && !loading)
          const low = !!a && a.is_running && (a.available ?? 0) > 0 && (a.available ?? 0) <= 4

          return (
            <button key={iso} type="button" disabled={disabled} onClick={() => pick(iso)}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 cursor-pointer disabled:cursor-not-allowed transition-colors ${
                !inMonth || isPast ? 'opacity-25' : ''
              } ${
                isSelected ? 'bg-[#166534] text-white' :
                full || notRunning ? 'bg-[#f1f5f9] text-[#94a3b8]' :
                low ? 'bg-amber-50 text-[#1e293b]' :
                a ? 'bg-[#F0FDF4] text-[#1e293b]' : 'text-[#1e293b]'
              }`}>
              <span className="font-sans text-[12.5px] font-bold ltr-num">{d.getDate()}</span>
              {inMonth && !isPast && (
                <span className={`font-sans text-[8.5px] font-bold ltr-num ${isSelected ? 'text-white/90' : full ? 'text-[#b91c1c]' : notRunning ? 'text-[#94a3b8]' : low ? 'text-amber-700' : 'text-[#166534]'}`}>
                  {!a ? (loading ? '···' : '') : notRunning ? t('mv.calendarNotRunningLabel') : full ? t('mv.calendarFullLabel') : a.available}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-3 mt-3 flex-wrap">
        <span className="flex items-center gap-1 font-sans text-[10.5px] text-[#64748b]"><i className="w-2.5 h-2.5 rounded-sm bg-[#F0FDF4] border border-[#166534] inline-block" /> {t('mv.calendarAvailableLegend')}</span>
        <span className="flex items-center gap-1 font-sans text-[10.5px] text-[#64748b]"><i className="w-2.5 h-2.5 rounded-sm bg-amber-50 border border-amber-400 inline-block" /> {t('mv.calendarLowSeatsLegend')}</span>
        <span className="flex items-center gap-1 font-sans text-[10.5px] text-[#64748b]"><i className="w-2.5 h-2.5 rounded-sm bg-[#f1f5f9] border border-[#e5e2d0] inline-block" /> {t('mv.calendarUnavailableLegend')}</span>
      </div>
    </MobilityBottomSheet>
  )
}
