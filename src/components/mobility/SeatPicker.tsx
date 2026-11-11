'use client'

// Seat-number picker for van-kind (van/bus/coaster/hiace) route
// bookings (845/846) — cars/SUVs never render this, they keep the
// plain seat-count stepper. Grid is derived client-side (seatGrid.ts),
// "taken" comes from route_seat_status() so a seat already held by
// another live booking or an active monthly subscription greys out
// before the rider can even try to tap it — the real collision is
// still enforced server-side (a unique constraint) since two riders
// could race the same free seat between this fetch and the booking
// call.

import { seatGrid } from '@/lib/seatGrid'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface SeatPickerProps {
  totalSeats: number
  takenSeatNumbers: number[]
  seatsNeeded: number
  selected: number[]
  onChange: (seats: number[]) => void
}

export function SeatPicker({ totalSeats, takenSeatNumbers, seatsNeeded, selected, onChange }: SeatPickerProps) {
  const { t } = useLocale()
  const taken = new Set(takenSeatNumbers)
  const grid = seatGrid(totalSeats)
  const rows = Math.max(0, ...grid.map((s) => s.row))

  const toggle = (n: number) => {
    if (taken.has(n)) return
    if (selected.includes(n)) { onChange(selected.filter((s) => s !== n)); return }
    if (selected.length >= seatsNeeded) { onChange([...selected.slice(1), n]); return }
    onChange([...selected, n])
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="font-sans text-[11.5px] font-bold text-[#64748b]">{t('mv.seatPickerLabel').replace('{n}', String(seatsNeeded))}</p>
      <div className="flex flex-col gap-1.5 items-center">
        {Array.from({ length: rows }, (_, i) => i + 1).map((row) => (
          <div key={row} className="flex gap-1.5">
            {grid.filter((s) => s.row === row).map((s) => {
              const isTaken = taken.has(s.seatNumber)
              const isSelected = selected.includes(s.seatNumber)
              return (
                <button key={s.seatNumber} type="button" disabled={isTaken} onClick={() => toggle(s.seatNumber)}
                  className="w-9 h-9 rounded-lg font-sans text-[11px] font-bold cursor-pointer disabled:cursor-not-allowed flex items-center justify-center border"
                  style={{
                    background: isTaken ? '#f1f5f9' : isSelected ? '#166534' : '#fff',
                    color: isTaken ? '#94a3b8' : isSelected ? '#fff' : '#334155',
                    borderColor: isTaken ? '#e2e8f0' : isSelected ? '#166534' : '#e5e2d0',
                  }}>
                  {s.seatNumber}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 font-sans text-[10px] text-[#64748b] justify-center">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm border border-[#e5e2d0] bg-white inline-block" /> {t('mv.seatFreeLabel')}</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-[#166534] inline-block" /> {t('mv.seatSelectedLabel')}</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-[#f1f5f9] border border-[#e2e8f0] inline-block" /> {t('mv.seatTakenLabel')}</span>
      </div>
    </div>
  )
}
