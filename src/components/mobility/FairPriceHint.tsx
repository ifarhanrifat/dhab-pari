'use client'

// Phase 2 of the vehicle-marketplace rebuild: "nothing is manual for
// the vehicals to set fare on there own, but if any vehical want to
// put less fare... they can offer less rate." This shows the driver
// the backend-computed ceiling live as they type a distance, on both
// the Routes and Shared-trip posting forms — the matching RPCs
// (create_vehicle_route_self / place_trip_offer, migration 699) reject
// anything typed above this number server-side.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function FairPriceHint({ flow, distanceKm }: { flow: 'route' | 'trip_share'; distanceKm: number | null }) {
  const { t } = useLocale()
  const supabase = createClient()
  const [fair, setFair] = useState<number | null>(null)

  useEffect(() => {
    if (!distanceKm || distanceKm <= 0) { setFair(null); return }
    let cancelled = false
    supabase.rpc('fare_band_for', { p_flow: flow, p_km: distanceKm }).then(({ data }) => {
      if (!cancelled) setFair((data as { fair?: number } | null)?.fair ?? null)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, distanceKm])

  if (fair == null) return null
  return (
    <p className="font-sans text-[11.5px] text-[#166534] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg px-2.5 py-1.5 mt-1">
      {t('mv.fairPriceHint').replace('{price}', fmt(fair))}
    </p>
  )
}
