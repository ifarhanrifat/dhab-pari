'use client'

// 861: real ask — "that model of seat layout which is displaying on a
// page make it appear when rider and manager will click on available
// seat and it will appear on a popup" — the seat grid no longer sits
// permanently inline; this is a compact trigger (shows the current
// selection, or a prompt to pick one) that opens the actual SeatPicker
// inside the app's existing MobilityBottomSheet popup shell (the same
// shell every other booking form already uses), so every call site
// that used to render <SeatPicker ... /> directly now renders this
// instead, with identical props.

import { useState } from 'react'
import { Armchair, ChevronRight } from 'lucide-react'
import { SeatPicker } from '@/components/mobility/SeatPicker'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface SeatPickerFieldProps {
  totalSeats: number
  takenSeatNumbers: number[]
  seatsNeeded: number
  selected: number[]
  onChange: (seats: number[]) => void
  isSleeper?: boolean
}

export function SeatPickerField(props: SeatPickerFieldProps) {
  const { t, isUrdu } = useLocale()
  const [open, setOpen] = useState(false)
  const { selected, seatsNeeded } = props
  const complete = selected.length === seatsNeeded

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border font-sans text-[13px] cursor-pointer"
        style={{ borderColor: complete ? '#166534' : '#e5e2d0', background: complete ? '#F0FDF4' : '#fff' }}>
        <Armchair size={17} style={{ color: complete ? '#166534' : '#94a3b8' }} />
        <span className="flex-1 text-start" style={{ color: complete ? '#166534' : '#64748b', fontWeight: complete ? 700 : 500 }}>
          {selected.length > 0
            ? t('mv.seatsSelectedSummary').replace('{list}', [...selected].sort((a, b) => a - b).join(', '))
            : t('mv.tapToChooseSeatsLabel')}
        </span>
        <ChevronRight size={15} className={isUrdu ? 'rotate-180' : ''} style={{ color: '#94a3b8' }} />
      </button>

      {open && (
        <MobilityBottomSheet title={t('mv.chooseSeatsTitle')} onClose={() => setOpen(false)}>
          <SeatPicker {...props} />
          <button type="button" onClick={() => setOpen(false)}
            className="mt-3 w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50"
            disabled={!complete}>
            {t('mv.confirmSeatsBtn')}
          </button>
        </MobilityBottomSheet>
      )}
    </>
  )
}
