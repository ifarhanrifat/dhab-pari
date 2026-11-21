'use client'

// 875: registration-number-first driver roster — real spec given live:
// "fleet will show with there registration number and not with the driver
// names, driver will have separate list with there status, list on
// travelling drivers will be labled on travel and free drivers will be
// labled as free and on there avialable on which station". Read-only by
// design: this page answers "who's free right now," a different
// question from forward-looking assignment planning — that now lives
// at /portal/fleet/roster (942's Job Calendar: plan ahead which driver
// covers each route, record leave, see conflicts), which explicitly
// reversed this comment's earlier "don't add a second allotment system"
// instruction after a direct, specific ask — same as 879 reversing an
// earlier driver-shuffle rule. route_run_substitutions (the same-day
// emergency swap this comment originally meant) is untouched.

import { useEffect, useState } from 'react'
import { IdCard, Phone, MessageCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { normalizePakPhone } from '@/lib/receiptExport'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetStatusPill } from '@/components/portal/FleetPanel'

interface RosterRow {
  vehicle_id: string; vehicle_number: string | null; owner_name: string; owner_mobile: string | null; vehicle_type: string
  status: 'on_trip' | 'free'
  active_route: { origin: string; destination: string; started_at: string } | null
  free_at_station: string | null
}

export default function FleetDriversPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [roster, setRoster] = useState<RosterRow[]>([])

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      setFleetId(f?.fleet_id ?? null)
      if (f) {
        const { data } = await supabase.rpc('fleet_driver_roster', { p_fleet_id: f.fleet_id })
        setRoster((data ?? []) as RosterRow[])
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><IdCard size={19} /> {t('mv.driverRosterHeading')}</h1>

      <FleetPanel>
        <FleetPanelHead icon={<IdCard size={14} />} title={t('mv.driverRosterHeading')} description={t('mv.panelDesc.drivers')}
          action={<>
            <FleetStatusPill tone="blue">{roster.filter((r) => r.status === 'on_trip').length} {t('mv.onTripLabel')}</FleetStatusPill>
            <FleetStatusPill tone="green">{roster.filter((r) => r.status === 'free').length} {t('mv.freeLabel')}</FleetStatusPill>
          </>} />
        {roster.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noVehiclesYetHint')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] bg-[#F9F9F6] border-b border-[#f1f5f9]">
                    <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.vehicleColumnLabel')}</th>
                    <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.freeAtLabel')}</th>
                    <th className="px-3.5 py-1.5 text-end whitespace-nowrap">{t('w.status')}</th>
                    <th className="px-3.5 py-1.5 text-end" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {roster.map((r) => (
                    <tr key={r.vehicle_id} className="border-t border-[#f1f5f9] align-middle">
                      <td className="px-3.5 py-2.5">
                        <p className="font-sans text-[14px] font-extrabold text-[#1e293b] ltr-num whitespace-nowrap">{r.vehicle_number ?? '—'}</p>
                        <p className="font-sans text-[11.5px] text-[#64748b] whitespace-nowrap">{r.owner_name}{r.vehicle_type ? ` · ${r.vehicle_type}` : ''}</p>
                      </td>
                      <td className="px-3.5 py-2.5 font-sans text-[11.5px] text-[#64748b] whitespace-nowrap">
                        {r.status === 'on_trip' && r.active_route
                          ? `${r.active_route.origin} → ${r.active_route.destination}`
                          : r.free_at_station ? r.free_at_station : ''}
                      </td>
                      <td className="px-3.5 py-2.5 text-end">
                        <FleetStatusPill tone={r.status === 'on_trip' ? 'blue' : 'green'}>
                          {r.status === 'on_trip' ? t('mv.onTripLabel') : t('mv.freeLabel')}
                        </FleetStatusPill>
                      </td>
                      <td className="px-3.5 py-2.5 text-end">
                        {r.owner_mobile && (
                          <div className="flex items-center justify-end gap-2">
                            <a href={`tel:${r.owner_mobile}`} className="p-1 text-[#64748b]"><Phone size={13} /></a>
                            <a href={`https://wa.me/${normalizePakPhone(r.owner_mobile)}`} target="_blank" rel="noopener noreferrer" className="p-1 text-[#166534]"><MessageCircle size={13} /></a>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </FleetPanel>
    </div>
  )
}
