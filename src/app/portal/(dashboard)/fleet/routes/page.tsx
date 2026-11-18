'use client'

// 2026-11-18: Route library (design-first plan, screen 6, part 2) —
// from safar_admin_dashboard-1.html's "Routes & stops" view. The
// mockup's own "Fare configuration" panel is a stage-pricing +
// minimum-fare-threshold model dhab-pari doesn't have (confirmed —
// no per-stop stage-fare table exists anywhere in this app); building
// that literally would mean fabricating a feature. dhab-pari's real
// fare system is fixed-per-seat vs flex-total (driver's own choice,
// already shipped) — this page's fare panel reflects THAT real
// system's actual counts, in the mockup's panel shape, not invented
// numbers. Route editing itself stays on the existing, already-solid
// per-vehicle editor (my-vehicle/routes, with its real RouteStopsEditor
// and fixed/flex fare modes) — this page only adds the fleet-wide
// browsable list that was missing, linking into that real editor.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ChevronLeft, Milestone, Search, Receipt } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStatusPill } from '@/components/portal/FleetPanel'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
interface RouteRow {
  id: string; vehicle_id: string; origin: string; destination: string; is_active: boolean
  fare_mode: string; fare_per_seat_pkr: number; total_fare_pkr: number | null; is_two_way: boolean
}
function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function FleetRoutesPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [routes, setRoutes] = useState<RouteRow[]>([])
  const [stopCounts, setStopCounts] = useState<Record<string, number>>({})
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (!user) return
    const load = async () => {
      const { data: v } = await supabase.rpc('my_fleet_vehicles')
      const fleetVehicles = (v ?? []) as FleetVehicle[]
      setVehicles(fleetVehicles)
      const vehicleIds = fleetVehicles.map((x) => x.id)
      if (vehicleIds.length > 0) {
        const { data: r } = await supabase.from('vehicle_routes')
          .select('id, vehicle_id, origin, destination, is_active, fare_mode, fare_per_seat_pkr, total_fare_pkr, is_two_way')
          .in('vehicle_id', vehicleIds)
        const routeRows = (r ?? []) as RouteRow[]
        setRoutes(routeRows)
        if (routeRows.length > 0) {
          const { data: stops } = await supabase.from('route_stops').select('route_id').in('route_id', routeRows.map((x) => x.id))
          const counts: Record<string, number> = {}
          for (const s of (stops ?? []) as { route_id: string }[]) counts[s.route_id] = (counts[s.route_id] ?? 0) + 1
          setStopCounts(counts)
        }
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const vehicleFor = (id: string) => vehicles.find((v) => v.id === id)
  const q = searchQuery.trim().toLowerCase()
  const filteredRoutes = routes.filter((r) => !q || r.origin.toLowerCase().includes(q) || r.destination.toLowerCase().includes(q) || (vehicleFor(r.vehicle_id)?.vehicle_number ?? '').toLowerCase().includes(q))
  const fixedCount = routes.filter((r) => r.fare_mode === 'fixed').length
  const flexCount = routes.filter((r) => r.fare_mode === 'flex').length
  const twoWayCount = routes.filter((r) => r.is_two_way).length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><Milestone size={17} /> {t('mv.routeLibraryHeading')}</h1>
      </div>

      <FleetPanel>
        <FleetPanelHead icon={<Milestone size={14} />} title={t('mv.routeLibraryHeading')} description={t('mv.panelDesc.routeLibrary')}
          action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{routes.length}</span>} />
        {routes.length > 0 && (
          <div className="relative p-3 pb-0">
            <Search size={13} className="absolute top-1/2 -translate-y-1/2 start-[22px] text-[#94a3b8]" />
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={t('mv.searchRoutesPlaceholder')}
              className="w-full ps-8 pe-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
          </div>
        )}
        {routes.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noRoutesYetHint')}</p>
        ) : filteredRoutes.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noMatchingRoutesHint')}</p>
        ) : (
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {filteredRoutes.map((r) => {
              const v = vehicleFor(r.vehicle_id)
              return (
                <div key={r.id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-sans text-[13px] font-bold text-[#1e293b]">{r.origin} → {r.destination}</p>
                    <FleetStatusPill tone={r.is_active ? 'green' : 'gray'}>{r.is_active ? t('mv.counterStatusActiveLabel') : t('mk.inactive')}</FleetStatusPill>
                  </div>
                  <p className="font-sans text-[11px] text-[#64748b] mt-0.5">
                    {v?.vehicle_number || v?.vehicle_type || '—'} · {stopCounts[r.id] ?? 0} {t('mv.stopsCountSuffix')}
                    {r.is_two_way && ` · ${t('mv.twoWayBadgeLabel')}`}
                  </p>
                  <p className="font-sans text-[11px] text-[#166534] font-semibold mt-0.5 ltr-num">
                    {r.fare_mode === 'flex' ? `${t('mp.flexModeLabel')} · ₨${fmt(r.total_fare_pkr ?? 0)} ${t('mp.totalSuffix')}` : `₨${fmt(r.fare_per_seat_pkr)} ${t('mk.perSeat')}`}
                  </p>
                  <Link href={`/portal/my-vehicle/routes?vehicle=${r.vehicle_id}&route=${r.id}`} className="font-sans text-[10.5px] font-semibold text-[#166534] mt-1.5 inline-block">{t('mv.manageRouteLink')} →</Link>
                </div>
              )
            })}
          </div>
        )}
      </FleetPanel>

      {/* 2026-11-18: the mockup's Fare configuration panel shows a
          stage-pricing/minimum-fare-threshold model dhab-pari doesn't
          have — fabricating that would be a fake feature. This shows
          dhab-pari's REAL fare system (fixed-per-seat vs flex-total,
          driver's own choice) with its real counts instead. */}
      <FleetPanel>
        <FleetPanelHead icon={<Receipt size={14} />} title={t('mv.fareConfigHeading')} description={t('mv.panelDesc.fareConfig')} />
        <FleetPanelBody>
          <div className="flex flex-col gap-1.5">
            <p className="font-sans text-[11.5px] text-[#1e293b] flex items-center justify-between">
              <span>{t('mv.fareModeFixedCountLabel')}</span><span className="font-bold ltr-num">{fixedCount}</span>
            </p>
            <p className="font-sans text-[11.5px] text-[#1e293b] flex items-center justify-between">
              <span>{t('mv.fareModeFlexCountLabel')}</span><span className="font-bold ltr-num">{flexCount}</span>
            </p>
            <p className="font-sans text-[11.5px] text-[#1e293b] flex items-center justify-between pt-1.5 border-t border-[#f1f5f9]">
              <span>{t('mv.twoWayRoutesCountShortLabel')}</span><span className="font-bold ltr-num">{twoWayCount} / {routes.length}</span>
            </p>
          </div>
          <p className="font-sans text-[10.5px] text-[#64748b] leading-relaxed bg-[#f8f6ee] rounded-lg p-2.5 mt-2.5">{t('mv.fareModeExplainer')}</p>
        </FleetPanelBody>
      </FleetPanel>
    </div>
  )
}
