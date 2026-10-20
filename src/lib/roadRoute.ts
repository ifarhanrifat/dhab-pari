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

function haversineKm(a: LatLng, b: LatLng): number {
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
