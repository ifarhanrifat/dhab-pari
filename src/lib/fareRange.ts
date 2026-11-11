// One rule for every rider-facing fare CARD (the pre-match tile, before
// a specific driver/vehicle is known): show a range around the
// committee's figure, never one exact number, using the category's own
// fare_spread_pct (833). Point-to-point tiles did this inline first; the
// Hourly, Rental and loading tiles now share the same arithmetic so no
// two cards can drift. Rounded to the nearest Rs 10 so the band reads as
// an estimate. The booking sheet that follows always quotes the exact
// figure — this is display-only and never feeds a charge.

export const DEFAULT_FARE_SPREAD = 0.25

export function fareRange(fare: number, spread: number | null | undefined): { min: number; max: number } {
  const s = spread == null || Number.isNaN(Number(spread)) ? DEFAULT_FARE_SPREAD : Number(spread)
  return {
    min: Math.round(fare * (1 - s) / 10) * 10,
    max: Math.round(fare * (1 + s) / 10) * 10,
  }
}
