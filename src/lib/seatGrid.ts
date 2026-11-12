// Seat-layout math for van-kind vehicles (845/846) — no backend "layout"
// table, the grid is always derived from the vehicle's own total_seats
// (+ an explicit is_sleeper flag, 861). Seat numbers are 1-indexed, front
// to back, matching real Pakistani intercity coach conventions research
// confirmed for this redesign (861):
//
// - Daewoo Express "Luxury"/"Super Luxury" and Faisal Movers "Executive":
//   40-seat, 2+2 layout (two seats each side of a centre aisle).
// - Daewoo "Gold Class" and Faisal Movers "Business"/"First Class":
//   ~27-30 seat, 2+1 layout (a pair one side, a single seat the other —
//   the single side is the premium/solo-traveller side).
// - Sleeper coaches: 2+1 layout of BERTHS, not seats — a pair of
//   lower/upper berths stacked on one side, a single lower/upper pair on
//   the other, same 2+1 footprint as business class but every seat
//   position holds two decks.
//
// This platform's own real fleet is much smaller (6-32 seats, Coaster/
// Bus/Hiace/small vans) — thresholds below are the same 2+1-under /
// 2+2-over split the research shows, scaled down to this fleet's actual
// sizes rather than full 40-49-seat national-coach numbers.

export type SeatLayoutType = 'economy_2x2' | 'business_2x1' | 'sleeper_2x1'

export function resolveSeatLayout(totalSeats: number, isSleeper: boolean): SeatLayoutType {
  if (isSleeper) return 'sleeper_2x1'
  return totalSeats >= 25 ? 'economy_2x2' : 'business_2x1'
}

export interface SeatPosition {
  seatNumber: number
  row: number
  side: 'left' | 'right'
  /** 0-based position within this row+side (ignoring deck) — e.g. the
   *  left side of an economy row has slots 0 and 1. */
  slot: number
  deck?: 'lower' | 'upper' // sleeper only
}

export interface SeatRowSpec {
  /** seats on the left of the aisle (2 for every layout here) */
  left: number
  /** seats on the right of the aisle (2 for economy, 1 for business/sleeper) */
  right: number
}

export function rowSpecFor(layout: SeatLayoutType): SeatRowSpec {
  return layout === 'economy_2x2' ? { left: 2, right: 2 } : { left: 2, right: 1 }
}

/**
 * Builds the physical seat grid for a layout. For `sleeper_2x1`, each
 * physical slot (2 left + 1 right per row) carries TWO seat numbers — a
 * lower berth and the upper berth stacked above it — so a sleeper row
 * consumes 6 seat numbers per 3 physical slots, matching a real 2+1
 * sleeper coach where every bunk position is double-decked.
 */
export function seatGrid(totalSeats: number, layout: SeatLayoutType = 'economy_2x2'): SeatPosition[] {
  const { left, right } = rowSpecFor(layout)
  const decksPerSlot = layout === 'sleeper_2x1' ? 2 : 1
  const seats: SeatPosition[] = []
  let n = 1
  let row = 1
  while (n <= totalSeats) {
    for (let col = 0; col < left + right; col++) {
      const side: 'left' | 'right' = col < left ? 'left' : 'right'
      const slot = col < left ? col : col - left
      for (let deck = 0; deck < decksPerSlot; deck++) {
        if (n > totalSeats) break
        seats.push({
          seatNumber: n,
          row,
          side,
          slot,
          deck: decksPerSlot > 1 ? (deck === 0 ? 'lower' : 'upper') : undefined,
        })
        n++
      }
    }
    row++
  }
  return seats
}
