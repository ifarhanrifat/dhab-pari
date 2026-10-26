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

// Real bug, reported live: a trip_share 'return' listing showed and
// enforced the exact same ceiling as a 'oneway' one — the driver's
// listed fare for "there and back" ended up priced the same as a
// single leg, so 4 riders doing a full round trip paid what should
// only cover getting there. The listed fare for a return trip-share is
// the FULL round-trip price (a one-way-only booker automatically pays
// half of it, 693/728) — so its fair ceiling must be double the
// single-leg fair, not the same number. `roundTrip` doubles it here;
// place_trip_offer (737) enforces the same doubling server-side, so
// this stays cosmetic/in-sync, never the actual cap. Routes has no
// such halving concept (each leg is its own full-price booking) so
// its own FairPriceHint usage never passes this — default false.
export function FairPriceHint({ flow, distanceKm, roundTrip }: { flow: 'route' | 'trip_share'; distanceKm: number | null; roundTrip?: boolean }) {
  const { t } = useLocale()
  const supabase = createClient()
  const [fair, setFair] = useState<number | null>(null)

  useEffect(() => {
    if (!distanceKm || distanceKm <= 0) { setFair(null); return }
    let cancelled = false
    supabase.rpc('fare_band_for', { p_flow: flow, p_km: distanceKm }).then(({ data }) => {
      const oneWay = (data as { fair?: number } | null)?.fair ?? null
      if (!cancelled) setFair(oneWay != null ? (roundTrip ? oneWay * 2 : oneWay) : null)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, distanceKm, roundTrip])

  if (fair == null) return null
  return (
    <p className="font-sans text-[11.5px] text-[#166534] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg px-2.5 py-1.5 mt-1">
      {t('mv.fairPriceHint').replace('{price}', fmt(fair))}
    </p>
  )
}
