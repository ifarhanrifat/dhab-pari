'use client'

// Real ask, 2026-11-06: "the rider popup should appear even if I'm on
// any other page, not just My Vehicle." PendingRequestOverlay was only
// ever mounted inside my-vehicle/layout.tsx, so it (and its Realtime
// subscription) simply didn't exist in the component tree anywhere else
// in the portal — it couldn't fire while a driver was browsing the
// marketplace, donations, etc., no matter what arrived.
//
// First mounted at the portal dashboard's own shared layout (every
// /portal/(dashboard)/* route) — fixed the my-vehicle-only scoping, but
// a driver browsing the public site (outside /portal entirely) still got
// nothing, same bug, one layer up. Moved to the true app root
// (src/app/layout.tsx, 2026-11-06) so it exists on every single page of
// the site, portal or not. Has its own independent vehicle lookup so
// it's a no-op for a portal user with no vehicle (a rider, or a visitor
// not logged in at all). my-vehicle/layout.tsx's own instance was
// removed earlier (see its own comment) to avoid a duplicate overlay/
// Realtime channel firing for the same driver while on a my-vehicle page.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { DriverJobsBadgeProvider } from '@/components/mobility/DriverJobsBadgeContext'
import { PendingRequestOverlay } from '@/components/mobility/PendingRequestOverlay'

interface Vehicle {
  id: string; commission_mode: string | null; delivers: boolean
  offers_hourly: boolean; offers_shadi: boolean; offers_rental: boolean
  offers_machinery: boolean; offers_tractor: boolean; offers_loader: boolean
}

export function DriverPendingRequestGate() {
  const { user } = usePortalUser()
  const supabase = createClient()
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)

  useEffect(() => {
    if (!user) { setVehicle(null); return }
    let live = true
    supabase.from('vehicles')
      .select('id, commission_mode, delivers, offers_hourly, offers_shadi, offers_rental, offers_machinery, offers_tractor, offers_loader')
      .eq('portal_user_id', user.id).maybeSingle()
      .then(({ data }) => { if (live) setVehicle(data) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  if (!vehicle) return null
  const flags = { ...vehicle, offers_equipment: !!(vehicle.offers_machinery || vehicle.offers_tractor || vehicle.offers_loader) }
  return (
    <DriverJobsBadgeProvider vehicleId={vehicle.id} vehicle={flags}>
      <PendingRequestOverlay vehicleId={vehicle.id} vehicle={flags} />
    </DriverJobsBadgeProvider>
  )
}
