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
  returnLeg?: ManualTicketLeg | null
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function ManualTicketDocument({ data }: { data: ManualTicketData }) {
  const [qr, setQr] = useState('')
  const [helplines, setHelplines] = useState<string | null>(null)

  useEffect(() => {
    QRCode.toDataURL(data.ticketNo, { margin: 1, width: 160 }).then(setQr)
    fetchBrandingSettings('marketplace').then((b) => setHelplines(b.helplineNumbers))
  }, [data.ticketNo])

  const mapUrl = data.pickupLat != null && data.pickupLng != null ? `https://www.google.com/maps?q=${data.pickupLat},${data.pickupLng}` : null

  return (
    <div className="p-5 max-w-[420px] mx-auto bg-white text-[#1e293b]">
      <DocumentHeader title="Bus Ticket" subtitle={data.serviceCode ?? undefined} lang="en" />

      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="font-sans text-[10.5px] text-[#64748b] uppercase tracking-[0.06em]">Ticket No.</p>
          <p className="font-mono text-[19px] font-bold ltr-num tracking-wide">{data.ticketNo}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {qr && <img src={qr} alt="QR" width={88} height={88} />}
          <span className={`font-sans text-[9px] font-bold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full ${data.pickupApprovalPending ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
            {data.pickupApprovalPending ? 'Pending Approval' : 'Confirmed'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 text-[12.5px] mb-3">
        <div><p className="text-[#64748b] text-[10.5px]">Passenger</p><p className="font-semibold">{data.passengerName}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Mobile</p><p className="font-semibold ltr-num">{data.passengerMobile ?? '—'}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">From</p><p className="font-semibold">{data.boardStopLabel ?? data.origin}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">To</p><p className="font-semibold">{data.destination}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Travel Date</p><p className="font-semibold ltr-num">{data.travelDate}{data.departureTime ? ` · ${data.departureTime}` : ''}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Seats</p><p className="font-semibold ltr-num">{data.seats}{data.seatNumbers?.length ? ` (#${data.seatNumbers.join(', ')})` : ''}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Bus</p><p className="font-semibold">{data.ownerName}{data.vehicleNumber ? ` · ${data.vehicleNumber}` : ''}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Fare Paid</p><p className="font-semibold ltr-num">₨{fmt(data.amountPkr)}</p></div>
        <div><p className="text-[#64748b] text-[10.5px]">Payment</p><p className="font-semibold">{data.paymentMethod}</p></div>
        {data.bookedAtTerminal && (
          <div><p className="text-[#64748b] text-[10.5px]">Booked At</p><p className="font-semibold">{data.bookedAtTerminal}</p></div>
        )}
        {data.emergencyContactPhone && (
          <div className="col-span-2"><p className="text-[#64748b] text-[10.5px]">Emergency Contact</p><p className="font-semibold ltr-num">{data.emergencyContactPhone}</p></div>
        )}
      </div>

      {mapUrl && (
        <div className="mb-3 p-2.5 rounded-lg bg-[#f8f6ee]">
          <p className="text-[#64748b] text-[10.5px]">Pickup GPS Pin</p>
          <p className="font-semibold ltr-num text-[12px]">{data.pickupLat!.toFixed(5)}, {data.pickupLng!.toFixed(5)}</p>
          <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="font-sans text-[11px] font-bold text-[#166534]">Open pickup pin in map ↗</a>
          {data.pickupApprovalPending && <p className="font-sans text-[10px] text-amber-700 mt-1">Awaiting route / dispatcher approval for this pickup pin.</p>}
        </div>
      )}

      {data.returnLeg && (
        <div className="mb-3 p-2.5 rounded-lg border border-[#e5e2d0]">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">Return Journey · Ticket {data.returnLeg.ticketNo}</p>
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div><p className="text-[#64748b] text-[10px]">From</p><p className="font-semibold">{data.returnLeg.origin}</p></div>
            <div><p className="text-[#64748b] text-[10px]">To</p><p className="font-semibold">{data.returnLeg.destination}</p></div>
            <div><p className="text-[#64748b] text-[10px]">Travel Date</p><p className="font-semibold ltr-num">{data.returnLeg.travelDate}{data.returnLeg.departureTime ? ` · ${data.returnLeg.departureTime}` : ''}</p></div>
            <div><p className="text-[#64748b] text-[10px]">Seats</p><p className="font-semibold ltr-num">{data.returnLeg.seats}{data.returnLeg.seatNumbers?.length ? ` (#${data.returnLeg.seatNumbers.join(', ')})` : ''}</p></div>
            {data.returnLeg.amountPkr != null && (
              <div><p className="text-[#64748b] text-[10px]">Fare</p><p className="font-semibold ltr-num">₨{fmt(data.returnLeg.amountPkr)}</p></div>
            )}
          </div>
          {/* 2026-11-19: real gap — "Fare Paid" above only ever showed
              the outbound leg's amount; the return leg's own fare sat
              right below it with no combined total anywhere on the
              ticket, so the passenger/officer had to add the two
              numbers themselves. */}
          {data.returnLeg.amountPkr != null && (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#e5e2d0]">
              <p className="font-sans text-[11.5px] font-bold text-[#1e293b]">Total Paid</p>
              <p className="font-sans text-[14px] font-bold ltr-num text-[#166534]">₨{fmt(data.amountPkr + data.returnLeg.amountPkr)}</p>
            </div>
          )}
        </div>
      )}

      {helplines && <p className="font-sans text-[11px] text-[#64748b]">Helpline: <span className="ltr-num">{helplines}</span></p>}
      <p className="font-sans text-[10.5px] text-[#94a3b8] mt-1">Present this ticket number, QR code, or your mobile number at boarding.</p>

      <DocumentFooter lang="en" />
    </div>
  )
}
