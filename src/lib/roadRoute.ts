// Real road routing — OSRM's free public demo server (router.project-
// osrm.org, no API key, same no-billing OSM ecosystem as the map tiles
// and Photon geocoding). Confirmed working live, 2026-10-20.
//
// Real gap this fixes: every distance this app ever showed a driver or
// fed into the backend fare ceiling was a straight-line haversine guess
// (times a flat 1.3 fudge factor for road sinuosity) — there was no
// actual route anywhere, which is what "not finding the route, not
// calculating the exact kms" meant. This calls OSRM for the real
// driven-road distance and the real road geometry to draw on the map,
// falling back to the old haversine*1.3 guess only if OSRM itself is
// unreachable — never a hard failure of the booking flow over a map API.

interface LatLng { lat: number; lng: number }

export interface RoadRoute { distanceKm: number; path: LatLng[]; isRealRoute: boolean }

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371, rad = (x: number) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export async function fetchRoadRoute(a: LatLng, b: LatLng): Promise<RoadRoute> {
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`)
    if (res.ok) {
      const data = (await res.json()) as { routes?: Array<{ distance: number; geometry: { coordinates: [number, number][] } }> }
      const route = data.routes?.[0]
      if (route) {
        return {
          distanceKm: route.distance / 1000,
          path: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
          isRealRoute: true,
        }
      }
    }
  } catch {
    // OSRM unreachable — fall through to the straight-line estimate below.
  }
  return { distanceKm: haversineKm(a, b) * 1.3, path: [a, b], isRealRoute: false }
}

export interface RoadRouteAlternative { distanceKm: number; durationMin: number; path: LatLng[] }

// Real roads to a city aren't all the one obvious line a flat map
// shows — OSRM can return several genuinely distinct driven paths
// between the same two points (confirmed live: a real Chakwal-area
// pair returned an 84km/85min option and a separate 104km/95min one).
// Used by the driver's Routes form so he picks the road he actually
// drives, instead of the system guessing one.
export async function fetchRoadRouteAlternatives(a: LatLng, b: LatLng): Promise<RoadRouteAlternative[]> {
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?alternatives=true&overview=full&geometries=geojson`)
    if (res.ok) {
      const data = (await res.json()) as { routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }> }
      const routes = data.routes ?? []
      if (routes.length > 0) {
        return routes.map((r) => ({
          distanceKm: r.distance / 1000,
          durationMin: r.duration / 60,
          path: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
        }))
      }
    }
  } catch {
    // OSRM unreachable — fall through to the straight-line fallback below.
  }
  return [{ distanceKm: haversineKm(a, b) * 1.3, durationMin: (haversineKm(a, b) * 1.3 / 40) * 60, path: [a, b] }]
}

// Shared by the rider's stop board, the driver's own stop editor, and
// the "find a ride near a stop" discovery list — approximate only,
// interpolated proportionally along a chosen road path by each point's
// fractional distance along it, using the path's own real OSRM
// duration. Always an estimate off a static schedule, never a live
// position — labeled "approx." everywhere it's shown for that reason.
export function estimateArrivalTime(path: LatLng[], durationMin: number | null, departureTime: string | null, point: LatLng): string | null {
  if (path.length < 2 || !durationMin || !departureTime) return null
  const cum: number[] = [0]
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversineKm(path[i - 1], path[i]))
  const total = cum[cum.length - 1] || 1
  let bestIdx = 0, bestDist = Infinity
  path.forEach((p, i) => { const d = haversineKm(p, point); if (d < bestDist) { bestDist = d; bestIdx = i } })
  const [h, m] = departureTime.split(':').map(Number)
  const totalMin = h * 60 + m + (cum[bestIdx] / total) * durationMin
  const hh = Math.floor(totalMin / 60) % 24, mm = Math.round(totalMin % 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
