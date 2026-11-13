'use client'

// 875: solo-driver parity for the counter officer's "Find a booking" +
// Board workflow (fleet/bookings/page.tsx) — a driver with no fleet at
// all couldn't reach that fleet-scoped search before. Backed by
// vehicle_search_bookings (vehicle-scoped, not fleet-scoped).

import { useEffect, useState } from 'react'
import { Search, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

interface FoundTicket {
  id: string; source: 'manual' | 'app'; passenger_name: string; passenger_mobile: string | null
  origin: string; destination: string; travel_date: string; seats: number; amount_pkr: number
  ticket_no: string | null; boarded_at: string | null
}

function today() { return new Date().toISOString().slice(0, 10) }

export function TicketBoardSheet({ vehicleId, onClose }: { vehicleId: string; onClose: () => void }) {
  const { t } = useLocale()
  const supabase = createClient()
  const [query, setQuery] = useState('')
  const [date, setDate] = useState(today())
  const [results, setResults] = useState<FoundTicket[]>([])
  const [searching, setSearching] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const runSearch = async () => {
    setSearching(true)
    const { data, error } = await supabase.rpc('vehicle_search_bookings', { p_vehicle_id: vehicleId, p_query: query || null, p_travel_date: date || null })
    setSearching(false)
    if (error) { toast.error(friendlyError(error)); return }
    setResults((data ?? []) as FoundTicket[])
  }

  useEffect(() => { runSearch() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const board = async (r: FoundTicket) => {
    setBusyId(r.id)
    const { error } = r.source === 'manual'
      ? await supabase.rpc('board_manual_ticket', { p_id: r.id })
      : await supabase.rpc('board_ride_bookings', { p_booking_ids: [r.id] })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.boardedToast'))
    runSearch()
  }

  return (
    <MobilityBottomSheet title={t('mv.findBookingHeading')} onClose={onClose}>
      <div className="flex flex-col gap-2.5">
        <div className="flex gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
          <div className="relative flex-1">
            <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder={t('mv.searchByNameMobilePlaceholder')} className="w-full ps-9 pe-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          <button onClick={runSearch} disabled={searching} className="px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
            {searching ? t('action.loading') : t('mv.searchBtn')}
          </button>
        </div>

        {results.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.noBookingsFoundHint')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {results.map((r) => (
              <div key={`${r.source}-${r.id}`} className="border border-[#e5e2d0] rounded-lg px-3 py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">{r.passenger_name}</p>
                  <p className="font-sans text-[10.5px] text-[#94a3b8]">{r.origin} → {r.destination} · {r.seats} {t('mv.seatsSuffix')} · <span className="ltr-num">{r.travel_date}</span></p>
                  <p className="font-sans text-[10.5px] text-[#94a3b8] ltr-num">{r.ticket_no ? `#${r.ticket_no}` : ''}{r.boarded_at ? ` · ${t('mv.boardedLabel')}` : ''}</p>
                </div>
                {!r.boarded_at && (
                  <button onClick={() => board(r)} disabled={busyId === r.id} className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                    <UserCheck size={13} /> {t('mv.boardBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </MobilityBottomSheet>
  )
}
