import * as SunCalc from 'suncalc'

// Real ask, 2026-09-29: point the phone at the sky and get guided to the
// moon. This is the sensor+astronomy approach every real "find the
// stars/moon" app uses (Star Walk, SkyView, etc.) -- calculate where the
// moon actually is from the visitor's location and the current time, then
// compare that to which way the phone is pointing. Nobody's camera is
// actually "seeing" the moon in the pixels; we're telling you where to
// look, the same way a paper star chart would.

export interface MoonTarget {
  // Compass bearing to the moon, 0-360, 0 = true north, clockwise —
  // matches a phone compass heading's own convention.
  azimuth: number
  // Degrees above the horizon. Negative means the moon is below the
  // horizon right now -- no amount of pointing the phone will find it.
  altitude: number
  illumination: number
  phaseLabel: string
}

const PHASES = [
  'newMoon', 'waxingCrescent', 'firstQuarter', 'waxingGibbous',
  'fullMoon', 'waningGibbous', 'lastQuarter', 'waningCrescent',
]

export function getMoonTarget(date: Date, lat: number, lng: number): MoonTarget {
  const pos = SunCalc.getMoonPosition(date, lat, lng)
  const illum = SunCalc.getMoonIllumination(date)
  // SunCalc's azimuth is measured from south, clockwise, in radians --
  // converting to a standard 0=north compass bearing is a flat +180°.
  const azimuth = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360
  const altitude = pos.altitude * 180 / Math.PI
  const phaseIdx = Math.round(illum.phase * 8) % 8
  return { azimuth, altitude, illumination: illum.fraction, phaseLabel: PHASES[phaseIdx] }
}

// Shortest signed distance from `b` to `a` on a 0-360 circle -- e.g.
// angularDiff(10, 350) is 20, not -340.
export function angularDiff(a: number, b: number): number {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}
