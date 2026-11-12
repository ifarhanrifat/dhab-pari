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
//
// 861: redesigned to a real coach layout (2+2 economy / 2+1 business /
// 2+1 sleeper berths, an aisle gap, a driver-cabin header) after
// researching Daewoo Express and Faisal Movers' actual seating classes
// — the old version was a flat 4-per-row number grid with no aisle,
// nothing like a real bus. See seatGrid.ts's own header for the
// research this is built on.

import { Armchair, BedSingle, BusFront } from 'lucide-react'
import { seatGrid, resolveSeatLayout, rowSpecFor, type SeatPosition } from '@/lib/seatGrid'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface SeatPickerProps {
  totalSeats: number
  takenSeatNumbers: number[]
  seatsNeeded: number
  selected: number[]
  onChange: (seats: number[]) => void
  isSleeper?: boolean
}

function seatColor(isTaken: boolean, isSelected: boolean) {
  if (isTaken) return { fg: '#94a3b8', bg: '#f1f5f9', border: '#e2e8f0' }
  if (isSelected) return { fg: '#fff', bg: '#166534', border: '#166534' }
  return { fg: '#475569', bg: '#fff', border: '#cbd5e1' }
}

function SeatButton({ pos, isTaken, isSelected, onTap }: { pos: SeatPosition; isTaken: boolean; isSelected: boolean; onTap: () => void }) {
  const c = seatColor(isTaken, isSelected)
  return (
    <button type="button" disabled={isTaken} onClick={onTap} aria-label={String(pos.seatNumber)}
      className="relative w-11 h-11 rounded-lg cursor-pointer disabled:cursor-not-allowed flex flex-col items-center justify-center border transition-colors"
      style={{ background: c.bg, borderColor: c.border }}>
      <Armchair size={20} strokeWidth={2} style={{ color: c.fg }} />
      <span className="absolute bottom-0.5 inset-x-0 text-center font-sans text-[8px] font-bold leading-none" style={{ color: c.fg }}>
        {pos.seatNumber}
      </span>
    </button>
  )
}

function BerthButton({ pos, isTaken, isSelected, onTap, label }: { pos: SeatPosition; isTaken: boolean; isSelected: boolean; onTap: () => void; label: string }) {
  const c = seatColor(isTaken, isSelected)
  return (
    <button type="button" disabled={isTaken} onClick={onTap} aria-label={String(pos.seatNumber)}
      className="relative w-16 h-7 rounded-md cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-1 border transition-colors"
      style={{ background: c.bg, borderColor: c.border }}>
      <BedSingle size={14} strokeWidth={2} style={{ color: c.fg }} />
      <span className="font-sans text-[9px] font-bold leading-none" style={{ color: c.fg }}>{label}{pos.seatNumber}</span>
    </button>
  )
}

export function SeatPicker({ totalSeats, takenSeatNumbers, seatsNeeded, selected, onChange, isSleeper = false }: SeatPickerProps) {
  const { t } = useLocale()
  const taken = new Set(takenSeatNumbers)
  const layout = resolveSeatLayout(totalSeats, isSleeper)
  const { left, right } = rowSpecFor(layout)
  const grid = seatGrid(totalSeats, layout)
  const rows = Math.max(0, ...grid.map((s) => s.row))

  const toggle = (n: number) => {
    if (taken.has(n)) return
    if (selected.includes(n)) { onChange(selected.filter((s) => s !== n)); return }
    if (selected.length >= seatsNeeded) { onChange([...selected.slice(1), n]); return }
    onChange([...selected, n])
  }

  const seatAt = (row: number, side: 'left' | 'right', slot: number, deck?: 'lower' | 'upper') =>
    grid.find((s) => s.row === row && s.side === side && s.slot === slot && (deck ? s.deck === deck : true))

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-sans text-[11.5px] font-bold text-[#64748b]">{t('mv.seatPickerLabel').replace('{n}', String(seatsNeeded))}</p>

      {/* Driver cabin, same end of the coach every row below reads from. */}
      <div className="flex items-center gap-1.5 self-end pe-1 opacity-60">
        <BusFront size={14} className="text-[#64748b]" />
        <span className="font-sans text-[9px] font-semibold text-[#94a3b8] uppercase tracking-wide">{t('mv.driverCabinLabel')}</span>
      </div>

      <div className="flex flex-col gap-2 items-center bg-[#F9F9F6] rounded-xl p-3 border border-[#e5e2d0]">
        {Array.from({ length: rows }, (_, i) => i + 1).map((row) => {
          const leftSlots = Array.from({ length: left }, (_, i) => i)
          const rightSlots = Array.from({ length: right }, (_, i) => i)
          return (
            <div key={row} className="flex items-center gap-2.5">
              <span className="w-4 text-end font-sans text-[9px] font-bold text-[#cbd5e1]">{row}</span>
              <div className="flex gap-1.5">
                {leftSlots.map((slot) => {
                  if (layout === 'sleeper_2x1') {
                    const lower = seatAt(row, 'left', slot, 'lower')
                    const upper = seatAt(row, 'left', slot, 'upper')
                    return (
                      <div key={slot} className="flex flex-col gap-1">
                        {upper && <BerthButton pos={upper} isTaken={taken.has(upper.seatNumber)} isSelected={selected.includes(upper.seatNumber)} onTap={() => toggle(upper.seatNumber)} label="U" />}
                        {lower && <BerthButton pos={lower} isTaken={taken.has(lower.seatNumber)} isSelected={selected.includes(lower.seatNumber)} onTap={() => toggle(lower.seatNumber)} label="L" />}
                      </div>
                    )
                  }
                  const s = seatAt(row, 'left', slot)
                  return s ? <SeatButton key={slot} pos={s} isTaken={taken.has(s.seatNumber)} isSelected={selected.includes(s.seatNumber)} onTap={() => toggle(s.seatNumber)} /> : <div key={slot} className="w-11 h-11" />
                })}
              </div>
              {/* Aisle */}
              <div className="w-5" />
              <div className="flex gap-1.5">
                {rightSlots.map((slot) => {
                  if (layout === 'sleeper_2x1') {
                    const lower = seatAt(row, 'right', slot, 'lower')
                    const upper = seatAt(row, 'right', slot, 'upper')
                    return (
                      <div key={slot} className="flex flex-col gap-1">
                        {upper && <BerthButton pos={upper} isTaken={taken.has(upper.seatNumber)} isSelected={selected.includes(upper.seatNumber)} onTap={() => toggle(upper.seatNumber)} label="U" />}
                        {lower && <BerthButton pos={lower} isTaken={taken.has(lower.seatNumber)} isSelected={selected.includes(lower.seatNumber)} onTap={() => toggle(lower.seatNumber)} label="L" />}
                      </div>
                    )
                  }
                  const s = seatAt(row, 'right', slot)
                  return s ? <SeatButton key={slot} pos={s} isTaken={taken.has(s.seatNumber)} isSelected={selected.includes(s.seatNumber)} onTap={() => toggle(s.seatNumber)} /> : <div key={slot} className="w-11 h-11" />
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-3 font-sans text-[10px] text-[#64748b] justify-center flex-wrap">
        <span className="flex items-center gap-1"><Armchair size={13} style={{ color: seatColor(false, false).fg }} /> {t('mv.seatFreeLabel')}</span>
        <span className="flex items-center gap-1"><Armchair size={13} style={{ color: '#166534' }} /> {t('mv.seatSelectedLabel')}</span>
        <span className="flex items-center gap-1"><Armchair size={13} style={{ color: '#94a3b8' }} /> {t('mv.seatTakenLabel')}</span>
      </div>
    </div>
  )
}
