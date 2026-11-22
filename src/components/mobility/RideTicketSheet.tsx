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
//
// 2026-11-22, same day: real ask after seeing this in use — "until the
// driver starts his route, tapping the floating button should only
// show the ticket and a message that the bus will depart, plus (if
// unconfirmed) a real payment-confirmation button, not the whole route
// browsing page." This is that whole pre-departure view now: ticket +
// departure line + (if unconfirmed) a Pay Now flow that shows the bus
// service's own bank/EasyPaisa details (950) and takes a payment
// screenshot, reusing submit_booking_payment_proof (870) exactly as
// the old RequestWaitingSheet did — just inside this lighter sheet
// instead of a modal that looked like a live, waiting-on-a-stranger
// dispatch request.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Ticket as TicketIcon, X, Landmark, CreditCard } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

export interface RideTicketInfo {
  bookingId: string
  vehicleId: string
  ticketNo: string
  origin: string
  destination: string
  travelDate: string
  departureTime?: string | null
  seats: number
  seatNumbers?: number[] | null
  amountPkr: number
  boardLabel?: string | null
  paymentConfirmed: boolean
  isPerOrder: boolean
}

interface PaymentInfo {
  service_name: string; logo_url: string | null; bank_account_title: string | null; bank_name: string | null; bank_account_number: string | null
  easypaisa_number: string | null; easypaisa_account_title: string | null; has_payment_info: boolean
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function RideTicketSheet({ info, onClose, onPaid }: { info: RideTicketInfo; onClose: () => void; onPaid?: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [qr, setQr] = useState('')
  const [showPay, setShowPay] = useState(false)
  const [payInfo, setPayInfo] = useState<PaymentInfo | null>(null)
  const [payMethod, setPayMethod] = useState('bank')
  const [proofPath, setProofPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    QRCode.toDataURL(info.ticketNo, { margin: 1, width: 180 }).then(setQr)
  }, [info.ticketNo])

  const openPay = async () => {
    setShowPay(true)
    if (!payInfo) {
      const { data } = await supabase.rpc('vehicle_payment_info', { p_vehicle_id: info.vehicleId })
      setPayInfo(data as PaymentInfo | null)
    }
  }

  const submitProof = async () => {
    if (!proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('submit_booking_payment_proof', { p_booking_id: info.bookingId, p_method: payMethod, p_proof_url: proofPath })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('rw.paymentProofSentToast'))
    setSubmitted(true)
    setShowPay(false)
    onPaid?.()
  }

  const departsLine = info.departureTime
    ? t('mv.busDepartsMessage').replace('{destination}', info.destination).replace('{date}', info.travelDate).replace('{time}', info.departureTime.slice(0, 5))
    : t('mv.busDepartsMessageNoTime').replace('{destination}', info.destination).replace('{date}', info.travelDate)

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

          <p className="font-sans text-[13px] font-semibold text-[#1e293b] text-center bg-[#F0FDF4] border border-[#bbf7d0] rounded-xl px-3 py-2.5"><bdi>{departsLine}</bdi></p>

          <span className={`self-center font-sans text-[11px] font-bold uppercase tracking-[0.05em] px-3 py-1 rounded-full ${info.paymentConfirmed || submitted ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {info.paymentConfirmed ? t('mv.seatConfirmedInGroupNote') : submitted ? t('rw.paymentProofSentHint') : t('mv.seatPendingDriverNote')}
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

          {!info.paymentConfirmed && !submitted && (
            <div className="rounded-2xl bg-amber-50 border border-amber-200 p-3.5 flex flex-col gap-2.5">
              <p className="font-sans text-[12px] text-amber-800">{t('mv.seatNeedsDriverConfirmNote')}</p>
              {info.isPerOrder ? (
                <p className="font-sans text-[11.5px] text-amber-900 bg-white/60 rounded-lg px-2.5 py-2">{t('cm.payDirectlyNote')}</p>
              ) : !showPay ? (
                <button onClick={openPay} className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-amber-700 text-white font-sans text-[12.5px] font-bold cursor-pointer">
                  <CreditCard size={14} /> {t('rw.payNowToConfirmBtn')}
                </button>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {!payInfo ? (
                    <p className="font-sans text-[12px] text-amber-800">{t('action.loading')}</p>
                  ) : !payInfo.has_payment_info ? (
                    <p className="font-sans text-[12px] text-amber-900">{t('mv.noPaymentInfoYetHint')}</p>
                  ) : (
                    <div className="bg-white rounded-xl border border-amber-200 p-3 flex items-center gap-2.5">
                      {payInfo.logo_url ? (
                        <img src={payInfo.logo_url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                      ) : (
                        <span className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center shrink-0"><Landmark size={16} className="text-amber-700" /></span>
                      )}
                      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                        <p className="font-sans text-[12.5px] font-bold text-[#1e293b] truncate"><bdi>{payInfo.service_name}</bdi></p>
                        {payInfo.bank_account_number && <p className="font-sans text-[11px] text-[#64748b]">{payInfo.bank_name} · <span className="ltr-num">{payInfo.bank_account_number}</span> · {payInfo.bank_account_title}</p>}
                        {payInfo.easypaisa_number && <p className="font-sans text-[11px] text-[#64748b]">{t('mv.easypaisaLabel')} · <span className="ltr-num">{payInfo.easypaisa_number}</span> · {payInfo.easypaisa_account_title}</p>}
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block font-sans text-[11px] font-semibold text-[#92400e] mb-1">{t('w.paymentMethod')}</label>
                    <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="input-field">
                      <option value="bank">{t('a.bank')}</option>
                      <option value="easypaisa">{t('w.easypaisa')}</option>
                      <option value="jazzcash">{t('w.jazzcash')}</option>
                      <option value="cash">{t('w.cash')}</option>
                    </select>
                  </div>
                  <DonationReceiptUpload onUpload={setProofPath} />
                  <div className="flex gap-2">
                    <button onClick={submitProof} disabled={submitting} className="flex-1 py-2 rounded-lg bg-[#92400e] text-white font-sans text-[12px] font-bold cursor-pointer disabled:opacity-50">{submitting ? t('action.loading') : t('rw.submitPaymentProofBtn')}</button>
                    <button onClick={() => setShowPay(false)} className="flex-1 py-2 rounded-lg border border-[#fde68a] font-sans text-[12px] font-semibold text-[#92400e] cursor-pointer">{t('action.cancel')}</button>
                  </div>
                </div>
              )}
            </div>
          )}

          <button onClick={onClose} className="h-[48px] rounded-2xl bg-[#166534] text-white font-sans text-[14px] font-bold cursor-pointer">{t('action.close')}</button>
        </div>
      </div>
    </div>
  )
}
