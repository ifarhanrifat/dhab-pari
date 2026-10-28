'use client'

// The combined view (750): every tenant's drawn village/city circles
// on one map, color-coded per tenant — the actual reason this feature
// lives at the platform level instead of each tenant admin drawing
// blind to their neighbours. Spot an overlap or a gap here before
// approving a marketplace_share_agreements row between two tenants.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { MapPinned } from 'lucide-react'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface ZoneRow {
  id: string; tenant_id: string; tenant_name: string; zone_kind: 'village' | 'city'; area_type: 'circle' | 'polygon'
  city_id: string | null; city_name: string | null; label: string | null
  center_lat: number; center_lng: number; radius_km: number | null; points: { lat: number; lng: number }[] | null
}

const PALETTE = ['#166534', '#1d4ed8', '#b91c1c', '#a16207', '#6d28d9', '#0e7490', '#be185d', '#4d7c0f']

export default function PlatformFleetZonesPage() {
  const supabase = createClient()
  const [zones, setZones] = useState<ZoneRow[] | null>(null)

  useEffect(() => {
    supabase.rpc('platform_all_tenant_zones').then(({ data }) => setZones((data as ZoneRow[]) ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (zones === null) return <div className="flex justify-center py-16"><LoadingDots /></div>

  const tenantIds = Array.from(new Set(zones.map((z) => z.tenant_id)))
  const colorFor = (tenantId: string) => PALETTE[tenantIds.indexOf(tenantId) % PALETTE.length]

  return (
    <div>
      <h1 className="font-heading text-[26px] font-bold text-dp-on-surface flex items-center gap-2 mb-1">
        <MapPinned size={22} /> Fleet Zones — All Tenants
      </h1>
      <p className="text-dp-on-surface-variant text-[13px] font-sans mb-5">
        Every tenant's village and city territory circles on one map. Edit a specific tenant's zones from its own page.
      </p>

      {zones.length === 0 ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant">No zones drawn yet — open a tenant's page to add its first one.</p>
      ) : (
        <>
          <LeafletMap
            pins={[]}
            circles={zones.filter((z) => z.area_type === 'circle').map((z) => ({
              lat: z.center_lat, lng: z.center_lng, radiusKm: z.radius_km ?? 0, color: colorFor(z.tenant_id),
              popupHtml: `<strong>${z.tenant_name}</strong><br/>${z.zone_kind === 'village' ? '🏠 Village' : `🏙️ ${z.city_name}`} · ${z.radius_km} km`,
            }))}
            polygons={zones.filter((z) => z.area_type === 'polygon' && z.points).map((z) => ({
              points: z.points!, color: colorFor(z.tenant_id),
              popupHtml: `<strong>${z.tenant_name}</strong><br/>${z.zone_kind === 'village' ? '🏠 Village' : `🏙️ ${z.city_name}`} (drawn boundary)`,
            }))}
            height={480}
            className="rounded-lg border border-dp-outline-variant mb-4"
          />
          <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant">
            {tenantIds.map((tid) => {
              const tZones = zones.filter((z) => z.tenant_id === tid)
              return (
                <div key={tid} className="flex items-center justify-between gap-3 p-3.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ background: colorFor(tid) }} />
                    <div className="min-w-0">
                      <Link href={`/platform/tenants/${tid}`} className="font-sans text-[13.5px] font-semibold text-dp-on-surface hover:underline truncate">
                        {tZones[0].tenant_name}
                      </Link>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant truncate">
                        {tZones.map((z) => {
                          const size = z.area_type === 'polygon' ? 'boundary' : `${z.radius_km}km`
                          return z.zone_kind === 'village' ? `Village (${size})` : `${z.city_name} (${size})`
                        }).join(' · ')}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
