'use client'

// 2026-11-16: dedicated "Live fleet map" screen (SAFAR-reference network
// map page). The dashboard keeps its own small map toggle untouched; this
// is the deeper view: KPI row, full-height map, a selected-vehicle detail
// panel and an "active vehicle feed" table beneath it.
//
// Frontend-only. Reuses the existing `my_managed_fleet`,
// `fleet_vehicle_locations` (server-side filtered to pings in the last
// 5 minutes) and `my_fleet_vehicles` RPCs — no new RPCs, no migrations.
// Only real data is shown: identity, route/context, position and a
// client-computed freshness label from `updated_at`. There is NO speed,
// passenger count, ETA or crew data anywhere in the app yet, so none of
// those appear here (no "--" placeholders either).
//
// LeafletMap has no tap callback, so "selected vehicle" is driven from the
// feed table rows below the map, not from the map pins themselves.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Radio, RefreshCw, Bus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetStatusPill } from '@/components/portal/FleetPanel'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface LiveLocation {
  source: 'trip' | 'hourly' | 'route'
  ref_id: string
  owner_name: string
  vehicle_type: string
  vehicle_number: string | null
  context: string
  lat: number
  lng: number
  updated_at: string
}

/** Seconds since `iso`, clamped at 0 (clock skew between device and server). */
function ageSeconds(iso: string, now: number) {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
}

/** Green <60s, amber 1-3min, gray 3-5min (the RPC never returns anything older than 5min). */
function freshnessTone(secs: number): 'green' | 'amber' | 'gray' {
  if (secs < 60) return 'green'
  if (secs < 180) return 'amber'
  return 'gray'
}

export default function FleetLiveMapPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [locations, setLocations] = useState<LiveLocation[]>([])
  const [totalVehicles, setTotalVehicles] = useState(0)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Ticks every 15s so the "Xs ago" labels drift honestly between fetches.
  const [now, setNow] = useState(() => Date.now())

  const loadLocations = async (fid: string) => {
    const { data, error } = await supabase.rpc('fleet_vehicle_locations', { p_fleet_id: fid })
    if (error) { toast.error(friendlyError(error)); return }
    setLocations((data ?? []) as LiveLocation[])
    setLastRefreshed(new Date())
    setNow(Date.now())
  }

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; name: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    if (f) {
      const [{ data: fleetVehicles }] = await Promise.all([
        supabase.rpc('my_fleet_vehicles'),
        loadLocations(f.fleet_id),
      ])
      setTotalVehicles(((fleetVehicles ?? []) as unknown[]).length)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  const refresh = async () => {
    if (!fleetId || refreshing) return
    setRefreshing(true)
    await loadLocations(fleetId)
    setRefreshing(false)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  if (!fleetId) {
    return (
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <p className="font-sans text-[13px] text-[#64748b]">{t('mv.noFleetYetHint')}</p>
      </div>
    )
  }

  const selected = locations.find((l) => l.ref_id === selectedId) ?? null
  const pins = locations.map((p): MapPin => ({
    lat: p.lat, lng: p.lng,
    label: `${p.vehicle_number || p.vehicle_type} · ${p.context}`,
    color: '#166534', emoji: '🚐', isVehicle: true,
    openPopup: p.ref_id === selectedId,
  }))

  const agoLabel = (secs: number) =>
    secs < 60
      ? t('mv.updatedSecondsAgo').replace('{n}', String(secs))
      : t('mv.updatedMinutesAgo').replace('{n}', String(Math.floor(secs / 60)))

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Radio size={19} /> {t('mv.liveMapHeading')}</h1>

      <div className="grid grid-cols-2 gap-2">
        <FleetStat label={t('mv.transmittingNowLabel')} icon={<Radio size={12} />}
          value={`${locations.length} / ${totalVehicles}`} foot={t('mv.vehiclesLabel')} />
        <FleetStat label={t('mv.lastRefreshedLabel')} icon={<RefreshCw size={12} />}
          value={lastRefreshed ? lastRefreshed.toLocaleTimeString() : '—'} valueClassName="text-[#1e293b]" />
      </div>

      <FleetPanel>
        <FleetPanelHead icon={<Radio size={14} />} title={t('mv.liveMapHeading')} description={t('mv.liveMapFreshNote')}
          action={
            <button type="button" onClick={refresh} disabled={refreshing}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#F0FDF4] text-[#166534] font-sans text-[11px] font-bold disabled:opacity-50">
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> {t('action.refresh', 'Refresh')}
            </button>
          } />
        <FleetPanelBody className="p-2">
          {locations.length === 0 && (
            <p className="font-sans text-[11.5px] text-[#94a3b8] text-center pb-1.5">{t('mv.noLiveVehiclesHint')}</p>
          )}
          <LeafletMap pins={pins} height={320} className="rounded-xl" />
        </FleetPanelBody>
      </FleetPanel>

      {selected && (() => {
        const secs = ageSeconds(selected.updated_at, now)
        return (
          <FleetPanel>
            <FleetPanelHead icon={<Bus size={14} />}
              title={<span className="ltr-num">{selected.vehicle_number || selected.vehicle_type}</span>}
              description={`${selected.owner_name}${selected.vehicle_type ? ` · ${selected.vehicle_type}` : ''}`}
              action={<FleetStatusPill tone={freshnessTone(secs)}>{agoLabel(secs)}</FleetStatusPill>} />
            <FleetPanelBody className="px-3.5 py-2.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              <div className="min-w-0">
                <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#94a3b8]">{t('mv.routeContextLabel')}</p>
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] break-words">{selected.context || '—'}</p>
              </div>
              <div className="min-w-0">
                <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#94a3b8]">{t('mv.lastUpdateLabel')}</p>
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] ltr-num">{new Date(selected.updated_at).toLocaleString()}</p>
              </div>
              <div className="min-w-0">
                <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#94a3b8]">{t('mv.positionLabel')}</p>
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] ltr-num">{selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}</p>
              </div>
            </FleetPanelBody>
          </FleetPanel>
        )
      })()}

      <FleetPanel>
        <FleetPanelHead icon={<Bus size={14} />} title={t('mv.activeVehicleFeedHeading')} description={t('mv.liveMapFreshNote')}
          action={<FleetStatusPill tone={locations.length > 0 ? 'green' : 'gray'}>{locations.length} {t('mv.liveLabel')}</FleetStatusPill>} />
        {locations.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noLiveVehiclesHint')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] bg-[#F9F9F6] border-b border-[#f1f5f9]">
                  <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.vehicleColumnLabel')}</th>
                  <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.routeContextLabel')}</th>
                  <th className="px-3.5 py-1.5 text-end whitespace-nowrap">{t('mv.lastUpdateLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((l) => {
                  const secs = ageSeconds(l.updated_at, now)
                  const isSel = l.ref_id === selectedId
                  return (
                    <tr key={`${l.source}-${l.ref_id}`} onClick={() => setSelectedId(isSel ? null : l.ref_id)}
                      className={`border-t border-[#f1f5f9] align-middle cursor-pointer ${isSel ? 'bg-[#F0FDF4]' : 'hover:bg-[#F9F9F6]'}`}>
                      <td className="px-3.5 py-2.5">
                        <p className="font-sans text-[14px] font-extrabold text-[#1e293b] ltr-num whitespace-nowrap">{l.vehicle_number ?? '—'}</p>
                        <p className="font-sans text-[11.5px] text-[#64748b] whitespace-nowrap">{l.owner_name}{l.vehicle_type ? ` · ${l.vehicle_type}` : ''}</p>
                      </td>
                      <td className="px-3.5 py-2.5 font-sans text-[11.5px] text-[#64748b]">{l.context || ''}</td>
                      <td className="px-3.5 py-2.5 text-end">
                        <FleetStatusPill tone={freshnessTone(secs)}>{agoLabel(secs)}</FleetStatusPill>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </FleetPanel>
    </div>
  )
}
