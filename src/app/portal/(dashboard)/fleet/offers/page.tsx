'use client'

// 2026-11-17: dedicated "Offers, services & amenities" screen (SAFAR
// reference's service-packages table). Frontend-only — reuses
// vehicle_routes' own service_class (883) and amenities (886) columns
// directly (that table is publicly readable, see 388's
// "public_read_vehicle_routes" policy), no new RPC, no migration.
//
// Deliberately does NOT include SAFAR's "offer rules"/redemption
// tracking (one-time free meal, return-journey discount, etc.) —
// nothing in this app tracks a redemption event anywhere, so this
// screen shows only what's real: which routes carry which named
// service class and which amenities, not a promotions engine that
// doesn't exist yet.

import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetStat, FleetStatusPill } from '@/components/portal/FleetPanel'

const AMENITIES = ['ac', 'wifi', 'meal', 'charging', 'tv', 'toilet', 'water'] as const

interface RouteOffer {
  id: string; origin: string; destination: string; service_class: string | null; amenities: string[]
  fare_per_seat_pkr: number | null; is_active: boolean
  vehicle: { vehicle_number: string | null; vehicle_type: string | null; owner_name: string } | null
}

export default function FleetOffersPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [routes, setRoutes] = useState<RouteOffer[]>([])

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      setFleetId(f?.fleet_id ?? null)
      if (f) {
        const { data } = await supabase
          .from('vehicle_routes')
          .select('id, origin, destination, service_class, amenities, fare_per_seat_pkr, is_active, vehicle:vehicles!inner(vehicle_number, vehicle_type, owner_name, fleet_id)')
          .eq('vehicle.fleet_id', f.fleet_id)
        setRoutes(((data ?? []) as unknown[]).map((r) => r as unknown as RouteOffer))
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  const activeRoutes = routes.filter((r) => r.is_active)
  const withClass = activeRoutes.filter((r) => r.service_class)
  const amenityUsage = AMENITIES.map((a) => ({ key: a, count: activeRoutes.filter((r) => r.amenities?.includes(a)).length })).filter((x) => x.count > 0)

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Sparkles size={19} /> {t('mv.offersHeading')}</h1>

      <div className="grid grid-cols-2 gap-2">
        <FleetStat label={t('mv.routesWithClassLabel')} icon={<Sparkles size={12} />} value={`${withClass.length} / ${activeRoutes.length}`} foot={t('mv.routesLabel')} />
        <FleetStat label={t('mv.amenitiesInUseLabel')} icon={<Sparkles size={12} />} value={amenityUsage.length} valueClassName="text-[#1e293b]" foot={t('mv.amenityTypesLabel')} />
      </div>

      {amenityUsage.length > 0 && (
        <FleetPanel>
          <FleetPanelHead icon={<Sparkles size={14} />} title={t('mv.amenitiesInUseLabel')} description={t('mv.amenitiesInUseDesc')} />
          <div className="flex flex-wrap gap-1.5 p-3.5">
            {amenityUsage.map((a) => (
              <span key={a.key} className="px-2.5 py-1 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[11.5px] font-semibold">
                {t(`mv.amenity.${a.key}`)} <span className="text-[#94a3b8] ltr-num">· {a.count}</span>
              </span>
            ))}
          </div>
        </FleetPanel>
      )}

      <FleetPanel>
        <FleetPanelHead icon={<Sparkles size={14} />} title={t('mv.servicePackagesHeading')} description={t('mv.servicePackagesDesc')}
          action={<FleetStatusPill tone="green">{activeRoutes.length} {t('mv.routesLabel')}</FleetStatusPill>} />
        {activeRoutes.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noFleetYetHint')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] bg-[#F9F9F6] border-b border-[#f1f5f9]">
                  <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.vehicleColumnLabel')}</th>
                  <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.routeContextLabel')}</th>
                  <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.serviceClassLabel')}</th>
                  <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.amenitiesLabel')}</th>
                  <th className="px-3.5 py-1.5 text-end whitespace-nowrap">{t('mk.totalFareLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {activeRoutes.map((r) => (
                  <tr key={r.id} className="border-t border-[#f1f5f9] align-top">
                    <td className="px-3.5 py-2.5">
                      <p className="font-sans text-[13px] font-extrabold text-[#1e293b] ltr-num whitespace-nowrap">{r.vehicle?.vehicle_number || r.vehicle?.vehicle_type || r.vehicle?.owner_name}</p>
                      <p className="font-sans text-[10.5px] text-[#94a3b8] whitespace-nowrap">{r.vehicle?.vehicle_type}</p>
                    </td>
                    <td className="px-3.5 py-2.5 font-sans text-[11.5px] text-[#64748b] whitespace-nowrap">{r.origin} → {r.destination}</td>
                    <td className="px-3.5 py-2.5">
                      {r.service_class ? (
                        <span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10.5px] font-bold whitespace-nowrap">{t(`mv.serviceClass.${r.service_class}`)}</span>
                      ) : <span className="font-sans text-[11px] text-[#cbd5e1]">—</span>}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {(r.amenities ?? []).length === 0 ? <span className="font-sans text-[11px] text-[#cbd5e1]">—</span> :
                          (r.amenities ?? []).map((a) => (
                            <span key={a} className="px-1.5 py-0.5 rounded-full bg-[#F9F9F6] text-[#64748b] font-sans text-[9.5px] font-bold whitespace-nowrap">{t(`mv.amenity.${a}`)}</span>
                          ))}
                      </div>
                    </td>
                    <td className="px-3.5 py-2.5 text-end font-sans text-[12px] font-semibold text-[#1e293b] ltr-num whitespace-nowrap">{r.fare_per_seat_pkr ? `₨${r.fare_per_seat_pkr.toLocaleString()}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FleetPanel>

      <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-xl p-3">
        <p className="font-sans text-[11px] text-[#64748b]">{t('mv.setClassAmenitiesHint')}</p>
      </div>
    </div>
  )
}
