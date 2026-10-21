'use client'

// Cross-vertical "new job" count for the driver Jobs tab badge — the new
// design's driver app has one unified queue (`driverNeeds()` in
// dhab-pari-mobility.html counts every order type needing a response
// into one number shown on the Jobs tab and in the Home "new requests"
// banner), but our real backend still has one read RPC per booking type
// (no single cross-type SQL query exists), so this counts the same way
// Phase 3's rider "My Bookings" aggregator merged types client-side:
// one small poll per type, summed.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'

interface VehicleFlags { offers_hourly: boolean; offers_shadi: boolean; offers_equipment: boolean; offers_rental: boolean; delivers: boolean }

const Ctx = createContext<{ count: number; refresh: () => void }>({ count: 0, refresh: () => {} })

export function useDriverJobsBadge() {
  return useContext(Ctx)
}

export function DriverJobsBadgeProvider({ vehicleId, vehicle, children }: { vehicleId: string; vehicle: VehicleFlags; children: React.ReactNode }) {
  const [count, setCount] = useState(0)
  const supabase = createClient()

  const refresh = useCallback(async () => {
    const calls: Array<Promise<number>> = []
    if (vehicle.offers_hourly) calls.push(Promise.resolve(supabase.rpc('vehicle_hourly_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => ((data ?? []) as { status: string }[]).filter((b) => b.status === 'requested').length)))
    if (vehicle.offers_shadi) calls.push(Promise.resolve(supabase.rpc('vehicle_shadi_requests', { p_vehicle_id: vehicleId }).then(({ data }) => ((data ?? []) as { status: string }[]).filter((r) => r.status === 'requested').length)))
    if (vehicle.offers_equipment) calls.push(Promise.resolve(supabase.rpc('vehicle_equipment_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => ((data ?? []) as { status: string }[]).filter((b) => b.status === 'requested').length)))
    if (vehicle.offers_rental) calls.push(Promise.resolve(supabase.rpc('vehicle_rental_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => ((data ?? []) as { status: string }[]).filter((b) => b.status === 'requested').length)))
    calls.push(
      Promise.resolve(supabase.from('ride_bookings').select('id, vehicle_routes!inner(vehicle_id)', { count: 'exact', head: true }).eq('vehicle_routes.vehicle_id', vehicleId).eq('status', 'announced').then(({ count: c }) => c ?? 0))
    )
    // Adda-based bookings have route_id NULL and adda_queue_entry_id set instead —
    // the !inner join above has nothing to match for those rows, so they need
    // their own count against adda_queue_entries rather than vehicle_routes.
    calls.push(
      Promise.resolve(supabase.from('ride_bookings').select('id, adda_queue_entries!inner(vehicle_id)', { count: 'exact', head: true }).eq('adda_queue_entries.vehicle_id', vehicleId).eq('status', 'announced').then(({ count: c }) => c ?? 0))
    )
    calls.push(Promise.resolve(supabase.rpc('my_dispatch_invitations', { p_vehicle_id: vehicleId }).then(({ data }) => (data ?? []).length)))
    calls.push(Promise.resolve(supabase.rpc('my_city_purchase_invitations', { p_vehicle_id: vehicleId }).then(({ data }) => (data ?? []).length)))
    if (vehicle.delivers) calls.push(Promise.resolve(supabase.rpc('my_shop_delivery_invitations', { p_vehicle_id: vehicleId }).then(({ data }) => (data ?? []).length)))

    const results = await Promise.all(calls)
    setCount(results.reduce((sum, n) => sum + n, 0))
  }, [vehicleId, vehicle.offers_hourly, vehicle.offers_shadi, vehicle.offers_equipment, vehicle.offers_rental, vehicle.delivers]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 20000)
    return () => clearInterval(iv)
  }, [refresh])

  return <Ctx.Provider value={{ count, refresh }}>{children}</Ctx.Provider>
}
