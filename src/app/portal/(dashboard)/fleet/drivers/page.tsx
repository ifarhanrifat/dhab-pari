'use client'

// 875: registration-number-first driver roster — real spec given live:
// "fleet will show with there registration number and not with the driver
// names, driver will have separate list with there status, list on
// travelling drivers will be labled on travel and free drivers will be
// labled as free and on there avialable on which station". Read-only by
// design: no allotment/dispatch write action here — the standing
// instruction is to leave driver-handover/assignment exactly as it
// already works (fleet_vehicle_schedule's substitute system), not to add
// a second one.

import { useEffect, useState } from 'react'
import { IdCard, Phone, MessageCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { normalizePakPhone } from '@/lib/receiptExport'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

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

      {roster.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noVehiclesYetHint')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {roster.map((r) => (
            <div key={r.vehicle_id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-sans text-[14.5px] font-extrabold text-[#1e293b] ltr-num">{r.vehicle_number ?? '—'}</p>
                  <p className="font-sans text-[12px] text-[#64748b]">{r.owner_name}{r.vehicle_type ? ` · ${r.vehicle_type}` : ''}</p>
                </div>
                <span className="shrink-0 px-2 py-1 rounded-full font-sans text-[10px] font-bold"
                  style={{ background: r.status === 'on_trip' ? '#EFF6FF' : '#F0FDF4', color: r.status === 'on_trip' ? '#1d4ed8' : '#166534' }}>
                  {r.status === 'on_trip' ? t('mv.onTripLabel') : t('mv.freeLabel')}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#f1f5f9]">
                <span className="font-sans text-[11.5px] text-[#64748b]">
                  {r.status === 'on_trip' && r.active_route
                    ? `${r.active_route.origin} → ${r.active_route.destination}`
                    : r.free_at_station ? `${t('mv.freeAtLabel')}: ${r.free_at_station}` : ''}
                </span>
                {r.owner_mobile && (
                  <div className="flex items-center gap-2 shrink-0">
                    <a href={`tel:${r.owner_mobile}`} className="p-1 text-[#64748b]"><Phone size={13} /></a>
                    <a href={`https://wa.me/${normalizePakPhone(r.owner_mobile)}`} target="_blank" rel="noopener noreferrer" className="p-1 text-[#166534]"><MessageCircle size={13} /></a>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
