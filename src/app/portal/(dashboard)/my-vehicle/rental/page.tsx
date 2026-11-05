'use client'

// The driver's side of the point-to-point rental accept/decline/start/
// end lifecycle (653): requested bookings get Accept/Decline, an
// accepted one gets Start Trip (PIN-gated — the rider shows a 4-digit
// code), an in-progress one gets End Trip, and a completed per_order
// booking gets a Confirm Payment button. No live GPS here: unlike
// hourly, both ends of the trip are fixed at request time, so there's
// no distance to track live — modeled on my-vehicle/hourly/page.tsx
// minus that piece.
//
// 2026-10-30: every one of those steps now happens in the booking's own
// popup (BookingLifecycleSheet) — this page is just the grouped list.

import { useEffect, useState } from 'react'
import { Navigation, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { FarePolicyCard } from '@/components/mobility/FarePolicyCard'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { LifecycleBookingsList } from '@/components/mobility/LifecycleBookingsList'
import { CallButton } from '@/components/portal/CallButton'

function fmt(n: number) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

interface Vehicle { id: string; owner_name: string; commission_mode: string }
interface Booking {
  id: string; from_address: string; to_address: string; trip_type: 'one' | 'return'; wait_hours: number; km: number
  status: string; status_confirmed: boolean; total_amount_pkr: number; customer_name: string
}
interface ReturnOfferBooking { id: string; seats: number; fare_pkr: number; pin: string; rider_name: string; rider_mobile: string | null }
interface ReturnOffer {
  id: string; status: 'pending' | 'activated'; from_address: string; to_address: string
  per_seat_fare_pkr: number; total_seats: number; expected_arrival_at: string; bookings: ReturnOfferBooking[]
}

export default function MyRentalBookingsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [returnOffers, setReturnOffers] = useState<ReturnOffer[]>([])
  const [loading, setLoading] = useState(true)
  const [cancellingOfferId, setCancellingOfferId] = useState<string | null>(null)

  const loadBookings = (vehicleId: string) =>
    supabase.rpc('vehicle_rental_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => setBookings((data ?? []) as Booking[]))
  const loadReturnOffers = (vehicleId: string) =>
    supabase.rpc('vehicle_rental_return_offers', { p_vehicle_id: vehicleId }).then(({ data }) => setReturnOffers((data ?? []) as ReturnOffer[]))

  const cancelReturnOffer = async (offerId: string) => {
    if (!vehicle) return
    if (!window.confirm(t('vp.cancelReturnOfferConfirm'))) return
    setCancellingOfferId(offerId)
    const { error } = await supabase.rpc('cancel_rental_return_offer', { p_offer_id: offerId })
    setCancellingOfferId(null)
    if (error) { alert(error.message); return }
    await loadReturnOffers(vehicle.id)
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, commission_mode').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) await Promise.all([loadBookings(data.id), loadReturnOffers(data.id)])
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (!vehicle || !bookings.some((b) => ['requested', 'accepted', 'in_progress'].includes(b.status))) return
    const id = setInterval(() => loadBookings(vehicle.id), 10000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, bookings])

  useEffect(() => {
    if (!vehicle || returnOffers.length === 0) return
    const id = setInterval(() => loadReturnOffers(vehicle.id), 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, returnOffers.length])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('cm.noVehicleLinked')}</div>

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Navigation size={19} /> {t('vp.myRentalBookingsHeading')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.myRentalBookingsSubtitle')}</p>
      </div>
      <div><FarePolicyCard service="rental" audience="driver" defaultOpen={false} /></div>

      {/* Real ask, 2026-11-03: "why would a driver go one-way... give
          him a reason to want it" — once a long one-way job is
          accepted, riders already heading the opposite way can
          pre-book a discounted seat (796). This is where the driver
          actually sees that demand, both before and after they drop
          off the original rider. */}
      {returnOffers.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <p className="font-sans text-[13px] font-bold text-[#92400e]">{t('vp.returnOffersHeading')}</p>
          {returnOffers.map((o) => (
            <div key={o.id} className="bg-[#FFFBEB] border border-[#fde68a] rounded-2xl p-3.5 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[13px] font-semibold text-[#92400e]">{o.from_address} → {o.to_address}</p>
                <span className="shrink-0 flex items-center gap-1.5">
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[#92400e] text-white">
                    {o.status === 'activated' ? t('vp.returnOfferActiveLabel') : t('vp.returnOfferPendingLabel')}
                  </span>
                  <button onClick={() => cancelReturnOffer(o.id)} disabled={cancellingOfferId === o.id}
                    aria-label={t('vp.cancelReturnOfferBtn')}
                    className="w-6 h-6 rounded-full bg-white border border-[#fde68a] flex items-center justify-center text-[#92400e] disabled:opacity-50 cursor-pointer">
                    <X size={13} />
                  </button>
                </span>
              </div>
              <p className="font-sans text-[11.5px] text-[#92400e]/80 ltr-num">
                {fmt(o.per_seat_fare_pkr)}/{t('mk.perSeat')} · {o.bookings.reduce((s, b) => s + b.seats, 0)}/{o.total_seats} {t('mk.seatsLabel')}
                {o.status === 'pending' && ` · ${new Date(o.expected_arrival_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
              </p>
              {o.bookings.length > 0 && (
                <div className="flex flex-col gap-1.5 pt-1.5 border-t border-[#fde68a]">
                  {o.bookings.map((b) => (
                    <div key={b.id} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="font-sans font-semibold text-[#1e293b]">{b.rider_name} · {b.seats} {t('mk.seatsLabel')}</span>
                      <span className="flex items-center gap-2">
                        {b.rider_mobile && <CallButton phone={b.rider_mobile} className="font-sans text-[11.5px] font-semibold text-[#166534]" />}
                        <span className="font-sans font-bold text-[#166534] ltr-num">PIN {b.pin}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <LifecycleBookingsList
        kind="rental" vehicleId={vehicle.id} commissionMode={vehicle.commission_mode}
        emptyText={t('vp.noRentalBookingsYetHint')}
        onChanged={() => loadBookings(vehicle.id)}
        items={bookings.map((b) => ({
          id: b.id, status: b.status, status_confirmed: b.status_confirmed, customer_name: b.customer_name,
          subtitle: `${b.from_address} → ${b.to_address}`, amount: b.total_amount_pkr,
          meta: `${Math.round(b.km)}km${b.trip_type === 'return' ? ' ↺' : ''}`,
        }))}
      />
    </div>
  )
}
