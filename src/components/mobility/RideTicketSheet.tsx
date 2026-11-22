'use client'

// Real gap reported live, 2026-11-22: "where is my ticket number and
// QR code which I need to give to the terminal during onboard?" — a
// self-service app booking (ride_bookings) never had one at all;
// ticket_no only existed for counter-sold manual tickets. Migration
// 948 gives every ride_bookings row a ticket_no from the same shared
// sequence; this is the rider-facing view of it — a light, dismissible
// sheet (not a blocking "waiting" screen, nothing to wait on here),
// shown right after booking and reachable again any time from "My
// Bookings" so it can be pulled back up at the terminal.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Ticket as TicketIcon, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface RideTicketInfo {
  ticketNo: string
  origin: string
  destination: string
  travelDate: string
  seats: number
  seatNumbers?: number[] | null
  amountPkr: number
  boardLabel?: string | null
  paymentConfirmed: boolean
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function RideTicketSheet({ info, onClose }: { info: RideTicketInfo; onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const [qr, setQr] = useState('')

  useEffect(() => {
    QRCode.toDataURL(info.ticketNo, { margin: 1, width: 180 }).then(setQr)
  }, [info.ticketNo])

  return (
    <div className="fixed inset-0 bg-black/55 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-[400px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[94vh] overflow-y-auto shadow-2xl">
        <div className="relative px-5 pt-7 pb-6 flex flex-col items-center text-center text-white" style={{ backgroundImage: 'linear-gradient(160deg,#0f3d2e,#166534)' }}>
          <button onClick={onClose} aria-label={t('action.cancel')} className="absolute top-3 end-3 w-8 h-8 rounded-full bg-white/15 flex items-center justify-center cursor-pointer"><X size={16} /></button>
          <TicketIcon size={26} />
          <p className="font-sans text-[16px] font-extrabold mt-2">{t('mv.ticketHeading')}</p>
          <p className="font-sans text-[11px] text-white/80 mt-1">{t('mv.ticketPresentHint')}</p>
        </div>

        <div className="px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-3.5">
          <div className="flex flex-col items-center gap-2">
            {qr && <img src={qr} alt="QR" width={140} height={140} className="rounded-lg border border-[#e8eaee]" />}
            <p className="font-mono text-[20px] font-bold tracking-wide ltr-num">{info.ticketNo}</p>
          </div>

          <span className={`self-center font-sans text-[11px] font-bold uppercase tracking-[0.05em] px-3 py-1 rounded-full ${info.paymentConfirmed ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {info.paymentConfirmed ? t('mv.seatConfirmedInGroupNote') : t('mv.seatPendingDriverNote')}
          </span>

          <div className="rounded-2xl border border-[#e8eaee] p-3.5 grid grid-cols-2 gap-2.5 text-[12.5px]">
            <div className="col-span-2"><p className="text-[#64748b] text-[10.5px]">{t('mv.fromToLabel')}</p><p className="font-semibold"><bdi>{info.boardLabel ?? info.origin}</bdi> → <bdi>{info.destination}</bdi></p></div>
            <div><p className="text-[#64748b] text-[10.5px]">{t('mv.travelDateLabel')}</p><p className="font-semibold ltr-num">{info.travelDate}</p></div>
            <div><p className="text-[#64748b] text-[10.5px]">{t('mk.seatsLabel')}</p><p className="font-semibold ltr-num">{info.seats}{info.seatNumbers?.length ? ` (#${info.seatNumbers.join(', ')})` : ''}</p></div>
            <div className="col-span-2 flex items-center justify-between pt-2 mt-1 border-t border-[#e8eaee]">
              <p className="font-sans text-[12.5px] font-bold text-[#0f172a]">{t('mp.cartTotal')}</p>
              <p className="font-sans text-[15px] font-extrabold text-[#166534] ltr-num">₨{fmt(info.amountPkr)}</p>
            </div>
          </div>

          {!info.paymentConfirmed && (
            <p className="font-sans text-[11.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">{t('mv.seatNeedsDriverConfirmNote')}</p>
          )}

          <button onClick={onClose} className="h-[48px] rounded-2xl bg-[#166534] text-white font-sans text-[14px] font-bold cursor-pointer">{t('action.close')}</button>
        </div>
      </div>
    </div>
  )
}
