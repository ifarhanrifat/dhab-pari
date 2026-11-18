'use client'

// 2026-11-19: Terminal Schedule — the real counterpart to "copy the
// terminal logic from the html file and have a separate sidebar tab
// for it too." Distinct from the existing Terminals directory
// (fleet/counters, which registers a terminal's own location/manager/
// cash office): this answers a different real question — "what comes
// through my terminal, and when" — the mockup's own "Today's
// departures" column, computed for real this time from real data
// (fleet_terminal_schedule, 919), grouped by the fleet's own
// terminals via route_stops.counter_id (918), not a static number.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ChevronLeft, Building2, Search } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetStatusPill } from '@/components/portal/FleetPanel'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface ScheduleRow {
  stop_id: string; counter_id: string; terminal_city: string; terminal_name: string | null
  arrival_time: string | null; departure_time: string | null; stop_order: number
  route_id: string; origin: string; destination: string; is_two_way: boolean; days_of_week: number[]
  vehicle_number: string | null; vehicle_type: string
}

const DAY_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
function fmtTime(t: string | null) {
  if (!t) return null
  const [h, m] = t.split(':')
  const hour = Number(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${m} ${ampm}`
}

export default function FleetTerminalSchedulePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (!user) return
    const load = async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      if (f) {
        const { data } = await supabase.rpc('fleet_terminal_schedule', { p_fleet_id: f.fleet_id })
        setRows((data ?? []) as ScheduleRow[])
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const q = searchQuery.trim().toLowerCase()
  const filtered = rows.filter((r) => !q
    || r.terminal_city.toLowerCase().includes(q) || (r.terminal_name ?? '').toLowerCase().includes(q)
    || r.origin.toLowerCase().includes(q) || r.destination.toLowerCase().includes(q))

  const terminalKeys = Array.from(new Set(filtered.map((r) => `${r.terminal_city}|${r.terminal_name ?? ''}`))).sort()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><Building2 size={17} /> {t('mv.terminalScheduleHeading')}</h1>
      </div>
      <p className="font-sans text-[11px] text-[#64748b] -mt-2">{t('mv.panelDesc.terminalSchedule')}</p>

      {rows.length > 0 && (
        <div className="relative">
          <Search size={13} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#94a3b8]" />
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={t('mv.searchTerminalOrRoutePlaceholder')}
            className="w-full ps-8 pe-2.5 py-2 border border-[#e5e2d0] rounded-lg bg-white font-sans text-[12px]" />
        </div>
      )}

      {rows.length === 0 ? (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noTerminalScheduleHint')}</p>
        </div>
      ) : terminalKeys.length === 0 ? (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noMatchingRoutesHint')}</p>
        </div>
      ) : (
        terminalKeys.map((key) => {
          const [city, name] = key.split('|')
          const entries = filtered.filter((r) => r.terminal_city === city && (r.terminal_name ?? '') === name)
          return (
            <FleetPanel key={key}>
              <FleetPanelHead icon={<Building2 size={14} />} title={name ? `${city} · ${name}` : city}
                description={t('mv.stopsThroughThisTerminalLabel').replace('{n}', String(entries.length))} />
              <div className="flex flex-col divide-y divide-[#f1f5f9]">
                {entries.map((r) => {
                  const arr = fmtTime(r.arrival_time); const dep = fmtTime(r.departure_time)
                  return (
                    <div key={r.stop_id} className="px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-sans text-[12.5px] font-bold text-[#1e293b] truncate">{r.origin} → {r.destination}{r.is_two_way ? ` · ${t('mv.twoWayBadgeLabel')}` : ''}</p>
                        {(arr || dep) && (
                          <FleetStatusPill tone="blue">
                            {arr ? `${t('mv.stopArrivesLabel')} ${arr}` : ''}{arr && dep ? ' · ' : ''}{dep ? `${t('mv.stopDepartsLabel')} ${dep}` : ''}
                          </FleetStatusPill>
                        )}
                      </div>
                      <p className="font-sans text-[11px] text-[#64748b] mt-0.5 ltr-num">
                        {r.vehicle_number || r.vehicle_type} · {r.days_of_week.length === 7 ? t('mv.everyDayLabel') : r.days_of_week.map((d) => DAY_ABBR[d]).join(' ')}
                      </p>
                    </div>
                  )
                })}
              </div>
            </FleetPanel>
          )
        })
      )}
    </div>
  )
}
