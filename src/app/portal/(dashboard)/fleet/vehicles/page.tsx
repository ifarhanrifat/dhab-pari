'use client'

// 864/865: "Bus Management" — a fleet owner/staff member could only ever
// edit the catalog settings (color/model/AC/sleeper/hourly-shadi-rental
// toggles, photos) of a vehicle they personally drive, through any
// screen, confirmed live. This lists every fleet vehicle and links each
// into catalog/page.tsx's now-widened ?vehicle=<id> fetch-by-id path.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Bus, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }

export default function FleetVehiclesPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      setFleetId(f?.fleet_id ?? null)
      if (f) {
        const { data } = await supabase.rpc('my_fleet_vehicles')
        setVehicles((data ?? []) as FleetVehicle[])
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Bus size={19} /> {t('mv.busManagementHeading')}</h1>

      {vehicles.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noVehiclesYetHint')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {vehicles.map((v) => (
            <Link key={v.id} href={`/portal/my-vehicle/catalog?vehicle=${v.id}`} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate">{v.owner_name}</p>
                <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5">{v.vehicle_type}{v.vehicle_number ? ` · ${v.vehicle_number}` : ''}</p>
              </div>
              <ChevronRight size={15} className={`shrink-0 text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
