'use client'

// 2026-11-19: real bug fix — "Listed stop" boarding mode opened a map.
// Re-read the real reference (SAFAR_Admin_Dashboard_Professional_
// Booking-4.html) line by line: for "At a listed route stop," the
// boarding field is a plain <select> of named stops — the map is
// reserved for "Map pickup" (free GPS pin) only, never for this.
// Replaces StopMapPicker (a Leaflet map with snap-to-nearest-pin) for
// this specific use — that map UI stays wrong for terminal stops no
// matter how it's tuned, the real design here is just a list.
//
// Also the real terminal model (918): a stop can now be linked to a
// real fleet_counters row (city + optional name, "for when a city has
// more than one counter" per its own comment) with a scheduled
// arrival/departure — shown right on each row when set, exactly the
// "terminals with city names, complete stay time" shape asked for.

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

export interface PickableStop {
  id: string; label: string; label_ur: string | null; lat: number; lng: number
  counter_id?: string | null; arrival_time?: string | null; departure_time?: string | null
  terminal_city?: string | null; terminal_name?: string | null
}

function fmtTime(t?: string | null) {
  if (!t) return null
  const [h, m] = t.split(':')
  const hour = Number(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${m} ${ampm}`
}

export function TerminalStopPicker({ stops, value, onChange, originLabel, onClose }: {
  stops: PickableStop[]; value: string | null; onChange: (stopId: string | null) => void; originLabel: string; onClose: () => void
}) {
  const { t, isUrdu } = useLocale()

  const pick = (id: string | null) => { onChange(id); onClose() }

  return (
    <MobilityBottomSheet title={t('mv.boardingStopLabel')} onClose={onClose}>
      <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.pickListedStopHint')}</p>
      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={() => pick(null)}
          className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border cursor-pointer text-start ${
            value === null ? 'border-[#166534] bg-[#F0FDF4]' : 'border-[#e5e2d0]'
          }`}>
          <span className="font-sans text-[13px] font-bold text-[#1e293b]">{originLabel}</span>
          <span className="font-sans text-[10.5px] font-bold text-[#166534]">{t('mv.routeOriginLabel')}</span>
        </button>
        {stops.map((s) => {
          const isTerminal = !!s.terminal_city
          const title = isTerminal ? `${s.terminal_city}${s.terminal_name ? ` · ${s.terminal_name}` : ''}` : (isUrdu && s.label_ur ? s.label_ur : s.label)
          const arr = fmtTime(s.arrival_time); const dep = fmtTime(s.departure_time)
          return (
            <button key={s.id} type="button" onClick={() => pick(s.id)}
              className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border cursor-pointer text-start ${
                value === s.id ? 'border-[#166534] bg-[#F0FDF4]' : 'border-[#e5e2d0]'
              }`}>
              <div className="min-w-0">
                <span className="font-sans text-[13px] font-bold text-[#1e293b] block truncate">{title}</span>
                {isTerminal && s.terminal_name && <span className="font-sans text-[10.5px] text-[#64748b] block truncate">{s.label}</span>}
              </div>
              {(arr || dep) && (
                <span className="shrink-0 font-sans text-[10px] font-bold text-[#64748b] ltr-num text-end">
                  {arr && <span className="block">{t('mv.stopArrivesLabel')} {arr}</span>}
                  {dep && <span className="block">{t('mv.stopDepartsLabel')} {dep}</span>}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </MobilityBottomSheet>
  )
}
