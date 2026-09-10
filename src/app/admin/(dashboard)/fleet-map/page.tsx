'use client'

// Fleet-wide live map for the committee (486), per the v2 design
// handoff (§2.5 item 3): "You had per-vehicle GPS but no committee view
// of it." Reuses the same LeafletMap/OSM component already proven on
// the rider Nearby and adda-board screens — no new mapping code, just
// a new, unfiltered, admin-only source of pins (admin_fleet_locations).

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Phone, Radio, Truck } from 'lucide-react'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface FleetPin {
  source: 'trip' | 'hourly'; ref_id: string; owner_name: string; owner_mobile: string | null
  vehicle_type: string; vehicle_number: string | null; context: string; lat: number; lng: number; updated_at: string
}

export default function AdminFleetMapPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [pins, setPins] = useState<FleetPin[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const { data } = await supabase.rpc('admin_fleet_locations_guarded')
    setPins((data ?? []) as FleetPin[])
    setLoading(false)
  }
  useEffect(() => {
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('fm.noAccessMessage')}</p></div>
  }

  const mapPins: MapPin[] = pins.map((p) => ({
    lat: p.lat, lng: p.lng, emoji: p.source === 'hourly' ? '🚖' : '🚐',
    popupHtml: `<strong>${p.owner_name}</strong><br/>${p.vehicle_type}${p.vehicle_number ? ` · ${p.vehicle_number}` : ''}<br/>${p.context}`,
  }))

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><Radio size={26} /> {t('fm.pageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('fm.pageSubtitle')}</p>
      </div>

      {loading ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : pins.length === 0 ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('fm.noVehiclesLive')}</p>
      ) : (
        <>
          <LeafletMap pins={mapPins} height={420} className="rounded-lg border border-dp-outline-variant mb-4" />
          <div className="space-y-2">
            {pins.map((p) => (
              <div key={`${p.source}-${p.ref_id}`} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Truck size={15} className="text-dp-secondary shrink-0" />
                  <div className="min-w-0">
                    <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{p.owner_name} <span className="font-normal text-dp-on-surface-variant">· {p.vehicle_type}{p.vehicle_number ? ` · ${p.vehicle_number}` : ''}</span></p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant truncate">{p.context}</p>
                    <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('fm.lastPing')}: {new Date(p.updated_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>
                {p.owner_mobile && (
                  <a href={`tel:${p.owner_mobile}`} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-dp-secondary-container/50 text-dp-secondary hover:bg-dp-secondary hover:text-white transition-colors">
                    <Phone size={15} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
