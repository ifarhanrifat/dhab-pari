import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getCurrentPositionOnce } from '@/hooks/useLiveLocation'

// Real bug found live, 2026-11-03: a driver's own location never showed
// up on an incoming ride-dispatch request (no distance badge, no driver
// pin, no route on the map — my_pending_ride_dispatch_requests, 779,
// reads it straight off vehicles.current_lat/lng). Two causes, together:
//
// 1. This hook used plain navigator.geolocation, which the Capacitor
//    Android shell does not reliably expose the way a real mobile
//    browser does — every OTHER live-location path in this app
//    (useLiveLocation.ts, getCurrentPositionOnce) already learned this
//    and goes through @capacitor/geolocation instead, which wraps the
//    native plugin on Android and falls back to the browser API on web.
//    This was the one remaining caller still on the raw web API.
// 2. It was only ever mounted on the driver's Home tab (my-vehicle/
//    page.tsx) — the instant they navigated to Jobs/Earnings/Vehicle,
//    the interval was torn down and the fix went stale for the rest of
//    the session, exactly like PendingRequestOverlay would if it weren't
//    mounted at the layout level. Moved to my-vehicle/layout.tsx so it
//    runs on every driver screen, the same way.
//
// Interval tightened from 30 minutes to 3 — the whole point of this fix
// is that a request's distance badge should reflect roughly where the
// driver actually is right now, not half an hour ago. Still a periodic
// refresh, not continuous tracking (that stays reserved for the
// opt-in, battery-heavier per-trip live-share feature).
export function useVehicleLocationRefresh(vehicleId: string | null, isOnline: boolean) {
  const supabase = createClient()

  useEffect(() => {
    if (!vehicleId || !isOnline) return
    let cancelled = false

    const refresh = async () => {
      try {
        const pos = await getCurrentPositionOnce()
        if (cancelled) return
        await supabase.rpc('set_vehicle_online_status', {
          p_vehicle_id: vehicleId, p_is_online: true, p_lat: pos.lat, p_lng: pos.lng,
        })
      } catch { /* denied/unavailable — leave the last known fix on file untouched */ }
    }

    refresh() // catches a fix that already went stale while this screen was closed
    const id = setInterval(refresh, 3 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, isOnline])
}
