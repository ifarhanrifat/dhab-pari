// Fleet accounting, Phase 2d: every live-position feature in this app
// (route_live_locations, vehicle_trip_offer_locations, fleet_vehicle_
// locations) already treats a position older than 5 minutes as gone
// server-side — nearby_open_trips (415), check_catch_feasibility (850),
// run_route_proximity_alerts (857) all use that same threshold. This is
// the one shared client-side helper for showing "last seen Xm ago"
// instead of silently treating a stale pin as still live, matching that
// same convention rather than inventing a different one per screen.

const STALE_AFTER_MIN = 5

export function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
}

export function isStale(iso: string, thresholdMin: number = STALE_AFTER_MIN): boolean {
  return minutesSince(iso) > thresholdMin
}
