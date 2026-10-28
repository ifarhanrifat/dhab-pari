import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

// The other half of the 30-minute freshness window the tiered ride-
// dispatch cascade (751) relies on to trust is_online as "in the city
// right now" — set_vehicle_online_status (683) only ever captured one
// fix at the moment a driver flipped online, which goes stale the
// instant they actually move. Re-fetches a fix and re-saves it on the
// same RPC (p_is_online stays true — this never changes online status
// itself) every 30 minutes while the vehicle is online, best-effort
// exactly like the original toggle: a denied/unavailable location
// just means this tick does nothing, never surfaced to the driver.
export function useVehicleLocationRefresh(vehicleId: string | null, isOnline: boolean) {
  const supabase = createClient()

  useEffect(() => {
    if (!vehicleId || !isOnline || typeof navigator === 'undefined' || !navigator.geolocation) return

    const refresh = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          supabase.rpc('set_vehicle_online_status', {
            p_vehicle_id: vehicleId, p_is_online: true, p_lat: pos.coords.latitude, p_lng: pos.coords.longitude,
          })
        },
        () => { /* denied/unavailable — leave the last known fix on file untouched */ },
        { timeout: 10000, maximumAge: 0 }
      )
    }

    refresh() // catches a fix that already went stale while this page was closed
    const id = setInterval(refresh, 30 * 60 * 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, isOnline])
}
