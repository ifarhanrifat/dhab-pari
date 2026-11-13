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

  return (
    <div className="p-5 max-w-[420px] mx-auto bg-white text-[#1e293b]">
      <DocumentHeader title="Bus Ticket" subtitle={data.serviceCode ?? undefined} lang="en" />

      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="font-sans text-[10.5px] text-[#64748b] uppercase tracking-[0.06em]">Ticket No.</p>
          <p className="font-mono text-[19px] font-bold ltr-num tracking-wide">{data.ticketNo}</p>
        </div>
        {qr && <img src={qr} alt="QR" width={88} height={88} />}
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
        {data.emergencyContactPhone && (
          <div className="col-span-2"><p className="text-[#64748b] text-[10.5px]">Emergency Contact</p><p className="font-semibold ltr-num">{data.emergencyContactPhone}</p></div>
        )}
      </div>

      {helplines && <p className="font-sans text-[11px] text-[#64748b]">Helpline: <span className="ltr-num">{helplines}</span></p>}
      <p className="font-sans text-[10.5px] text-[#94a3b8] mt-1">Present this ticket number, QR code, or your mobile number at boarding.</p>

      <DocumentFooter lang="en" />
    </div>
  )
}
