'use client'

// 874: the printable ticket the booking officer hands (or re-prints) for a
// counter-sold seat — ticket number + QR (so boarding can be checked in by
// a scan, not just typing the number) plus everything the rider needs to
// board and everything the driver/other officer needs to verify them.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import { DocumentFooter } from '@/components/admin/DocumentFooter'
import { fetchBrandingSettings } from '@/lib/branding'

export interface ManualTicketLeg {
  ticketNo: string
  origin: string
  destination: string
  travelDate: string
  departureTime: string | null
  seats: number
  seatNumbers: number[] | null
  amountPkr?: number
  discountPct?: number
  discountValue?: number
}

export interface ManualTicketData {
  ticketNo: string
  passengerName: string
  passengerMobile: string | null
  emergencyContactPhone: string | null
  origin: string
  destination: string
  travelDate: string
  departureTime: string | null
  seats: number
  seatNumbers: number[] | null
  amountPkr: number
  ownerName: string
  vehicleNumber: string | null
  serviceCode: string | null
  boardStopLabel: string | null
  paymentMethod: string
  // 2026-11-17: booking wizard Phase B's data, wired onto the ticket
  // itself — a map-pickup pin needs the GPS/map link and a pending-
  // approval note to travel with the ticket, same as the
  // SAFAR_Admin_Dashboard_Professional_Booking-4.html reference does.
  bookedAtTerminal?: string | null
  pickupApprovalPending?: boolean
  pickupLat?: number | null
  pickupLng?: number | null
  discountPct?: number
  discountValue?: number
  returnLeg?: ManualTicketLeg | null
}

function discountLabel(pct?: number, value?: number) {
  if (!pct && !value) return null
  const parts: string[] = []
  if (pct) parts.push(`${pct}%`)
  if (value) parts.push(`₨${fmt(value)}`)
  return parts.join(' + ') + ' off'
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function ManualTicketDocument({ data }: { data: ManualTicketData }) {
  const [qr, setQr] = useState('')
  const [returnQr, setReturnQr] = useState('')
  const [helplines, setHelplines] = useState<string | null>(null)

  useEffect(() => {
    QRCode.toDataURL(data.ticketNo, { margin: 1, width: 150 }).then(setQr)
    fetchBrandingSettings('marketplace').then((b) => setHelplines(b.helplineNumbers))
  }, [data.ticketNo])

  // 2026-11-27: real gap — the return leg already gets its own real
  // ticket number server-side (record_manual_return_booking generates
  // a distinct ticket_no), but this document never generated a QR for
  // it, so there was nothing to scan at return boarding except typing
  // the number by hand.
  useEffect(() => {
    if (!data.returnLeg) { setReturnQr(''); return }
    QRCode.toDataURL(data.returnLeg.ticketNo, { margin: 1, width: 150 }).then(setReturnQr)
  }, [data.returnLeg?.ticketNo]) // eslint-disable-line react-hooks/exhaustive-deps

  const mapUrl = data.pickupLat != null && data.pickupLng != null ? `https://www.google.com/maps?q=${data.pickupLat},${data.pickupLng}` : null

  return (
    <div className="p-5 max-w-[420px] mx-auto bg-white text-[#1e293b]">
      <DocumentHeader title="Bus Ticket" subtitle={data.serviceCode ?? undefined} lang="en" />

      {/* Shared passenger info — one passenger, both legs */}
      <div className="grid grid-cols-2 gap-2.5 text-[12.5px] mb-3">
        <div><p className="text-[#64748b] text-[10.5px]">Passenger</p><p className="font-semibold">{data.passengerName}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Mobile</p><p className="font-semibold ltr-num">{data.passengerMobile ?? '—'}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Bus</p><p className="font-semibold">{data.ownerName}{data.vehicleNumber ? ` · ${data.vehicleNumber}` : ''}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Payment</p><p className="font-semibold">{data.paymentMethod}</p></div>
        {data.bookedAtTerminal && (
          <div><p className="text-[#64748b] text-[10.5px]">Booked At</p><p className="font-semibold">{data.bookedAtTerminal}</p></div>
        )}
        {data.emergencyContactPhone && (
          <div className="col-span-2"><p className="text-[#64748b] text-[10.5px]">Emergency Contact</p><p className="font-semibold ltr-num">{data.emergencyContactPhone}</p></div>
        )}
      </div>

      {/* Real ask, 2026-11-27: "the ticket print should have two
          separate sections, one for departure with qr code and one for
          the return with qr code" — each leg is now its own bordered
          block with its own ticket number, its own QR, and its own seat
          number, instead of one QR up top covering only the outbound
          half. */}
      <div className="mb-3 p-3 rounded-lg border-2 border-[#166534] bg-[#F0FDF4]">
        <div className="flex items-center justify-between mb-2">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.08em] text-[#166534]">Departure · #{data.ticketNo}</p>
          <span className={`font-sans text-[9px] font-bold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full ${data.pickupApprovalPending ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
            {data.pickupApprovalPending ? 'Pending Approval' : 'Confirmed'}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="grid grid-cols-2 gap-2 text-[12px] flex-1">
            <div><p className="text-[#64748b] text-[10px]">From</p><p className="font-semibold">{data.boardStopLabel ?? data.origin}</p></div>
            <div><p className="text-[#64748b] text-[10px]">To</p><p className="font-semibold">{data.destination}</p></div>
            <div><p className="text-[#64748b] text-[10px]">Travel Date</p><p className="font-semibold ltr-num">{data.travelDate}{data.departureTime ? ` · ${data.departureTime}` : ''}</p></div>
            <div><p className="text-[#64748b] text-[10px]">Seats</p><p className="font-semibold ltr-num">{data.seats}{data.seatNumbers?.length ? ` (#${data.seatNumbers.join(', ')})` : ''}</p></div>
            <div><p className="text-[#64748b] text-[10px]">Fare</p><p className="font-semibold ltr-num">₨{fmt(data.amountPkr)}</p></div>
            {discountLabel(data.discountPct, data.discountValue) && (
              <div><p className="text-[#64748b] text-[10px]">Discount</p><p className="font-semibold ltr-num">{discountLabel(data.discountPct, data.discountValue)}</p></div>
            )}
          </div>
          {qr && <img src={qr} alt="Departure QR" width={78} height={78} className="shrink-0" />}
        </div>
        {mapUrl && (
          <div className="mt-2 pt-2 border-t border-[#166534]/20">
            <p className="text-[#64748b] text-[10px]">Pickup GPS Pin</p>
            <p className="font-semibold ltr-num text-[11.5px]">{data.pickupLat!.toFixed(5)}, {data.pickupLng!.toFixed(5)}</p>
            <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="font-sans text-[10.5px] font-bold text-[#166534]">Open pickup pin in map ↗</a>
            {data.pickupApprovalPending && <p className="font-sans text-[10px] text-amber-700 mt-1">Awaiting route / dispatcher approval for this pickup pin.</p>}
          </div>
        )}
      </div>

      {data.returnLeg && (
        <div className="mb-3 p-3 rounded-lg border-2 border-[#1d4ed8] bg-[#EFF6FF]">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.08em] text-[#1d4ed8] mb-2">Return · #{data.returnLeg.ticketNo}</p>
          <div className="flex items-start justify-between gap-3">
            <div className="grid grid-cols-2 gap-2 text-[12px] flex-1">
              <div><p className="text-[#64748b] text-[10px]">From</p><p className="font-semibold">{data.returnLeg.origin}</p></div>
              <div><p className="text-[#64748b] text-[10px]">To</p><p className="font-semibold">{data.returnLeg.destination}</p></div>
              <div><p className="text-[#64748b] text-[10px]">Travel Date</p><p className="font-semibold ltr-num">{data.returnLeg.travelDate}{data.returnLeg.departureTime ? ` · ${data.returnLeg.departureTime}` : ''}</p></div>
              <div><p className="text-[#64748b] text-[10px]">Seats</p><p className="font-semibold ltr-num">{data.returnLeg.seats}{data.returnLeg.seatNumbers?.length ? ` (#${data.returnLeg.seatNumbers.join(', ')})` : ''}</p></div>
              {data.returnLeg.amountPkr != null && (
                <div><p className="text-[#64748b] text-[10px]">Fare</p><p className="font-semibold ltr-num">₨{fmt(data.returnLeg.amountPkr)}</p></div>
              )}
              {discountLabel(data.returnLeg.discountPct, data.returnLeg.discountValue) && (
                <div><p className="text-[#64748b] text-[10px]">Discount</p><p className="font-semibold ltr-num">{discountLabel(data.returnLeg.discountPct, data.returnLeg.discountValue)}</p></div>
              )}
            </div>
            {returnQr && <img src={returnQr} alt="Return QR" width={78} height={78} className="shrink-0" />}
          </div>
          {/* 2026-11-19: real gap — "Fare Paid" above only ever showed
              the outbound leg's amount; the return leg's own fare sat
              right below it with no combined total anywhere on the
              ticket, so the passenger/officer had to add the two
              numbers themselves. */}
          {data.returnLeg.amountPkr != null && (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#1d4ed8]/20">
              <p className="font-sans text-[11.5px] font-bold text-[#1e293b]">Total Paid</p>
              <p className="font-sans text-[14px] font-bold ltr-num text-[#166534]">₨{fmt(data.amountPkr + data.returnLeg.amountPkr)}</p>
            </div>
          )}
        </div>
      )}

      {helplines && <p className="font-sans text-[11px] text-[#64748b]">Helpline: <span className="ltr-num">{helplines}</span></p>}
      <p className="font-sans text-[10.5px] text-[#94a3b8] mt-1">Present the ticket number or QR code for each leg at its own boarding.</p>

      <DocumentFooter lang="en" />
    </div>
  )
}
