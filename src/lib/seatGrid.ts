// Pure seat-layout math for van-kind vehicles (845/846) — no backend
// "layout" table, the grid is always derived from the vehicle's own
// total_seats + a fixed column count. Seat numbers are 1-indexed, left
// to right, front to back (seat 1 is the front-left-most seat).

export const SEAT_GRID_COLUMNS = 4

export interface SeatPosition { seatNumber: number; row: number; col: number }

export function seatGrid(totalSeats: number, columns: number = SEAT_GRID_COLUMNS): SeatPosition[] {
  const seats: SeatPosition[] = []
  for (let n = 1; n <= totalSeats; n++) {
    seats.push({ seatNumber: n, row: Math.ceil(n / columns), col: ((n - 1) % columns) + 1 })
  }
  return seats
}
