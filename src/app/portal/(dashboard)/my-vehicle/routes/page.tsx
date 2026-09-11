'use client'

// My Routes + Bookings — its own screen, matching the design zip's
// "ROUTE BOOKINGS" screen (this used to be a section embedded on the
// driver dashboard, moved out per direct instruction). Route/schedule
// creation itself stays staff-managed (unlike a shop's own catalog) —
// this is what a per_order driver actually needs day to day: closing a
// route he no longer runs, and confirming/rejecting/cancelling bookings.

import { useEffect, useState } from 'react'
import { MapPin, Signpost, CheckCircle2, XCircle, Ban, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface Route { id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; fare_mode: string; fare_per_seat_pkr: number; total_fare_pkr: number | null; is_active: boolean }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleRoutesPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [commissionMode, setCommissionMode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [routes, setRoutes] = useState<Route[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [actionId, setActionId] = useState<string | null>(null)
  const [closingRouteId, setClosingRouteId] = useState<string | null>(null)

  const reload = async (id: string) => {
    const [{ data: rts }, { data: b }] = await Promise.all([
      supabase.from('vehicle_routes').select('id, origin, origin_ur, destination, destination_ur, fare_mode, fare_per_seat_pkr, total_fare_pkr, is_active')
        .eq('vehicle_id', id).order('created_at', { ascending: false }),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
        .eq('vehicle_routes.vehicle_id', id).order('created_at', { ascending: false }).limit(20),
    ])
    setRoutes(rts ?? [])
    setBookings((b ?? []) as unknown as Booking[])
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, commission_mode').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) { setVehicleId(data.id); setCommissionMode(data.commission_mode); await reload(data.id) }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const fulfillBooking = async (id: string) => {
    setActionId(id)
    const { error } = await supabase.rpc('confirm_ride_booking', { p_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingConfirmedToast'))
    if (vehicleId) reload(vehicleId)
  }
  const cancelBooking = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('reject_ride_booking', { p_booking_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingRejectedToast'))
    if (vehicleId) reload(vehicleId)
  }
  const closeRoute = async (routeId: string) => {
    if (!confirm(t('mp.confirmCloseRouteHint'))) return
    setClosingRouteId(routeId)
    const { data, error } = await supabase.rpc('close_vehicle_route', { p_route_id: routeId, p_reason: t('mp.driverCancelledReason') })
    setClosingRouteId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const n = (data as { bookings_cancelled?: number } | null)?.bookings_cancelled ?? 0
    toast.success(n > 0 ? t('mp.routeClosedWithBookingsToast').replace('{n}', String(n)) : t('mp.routeClosedToast'))
    if (vehicleId) reload(vehicleId)
  }
  const cancelConfirmedBooking = async (id: string) => {
    if (!confirm(t('mp.confirmCancelConfirmedHint'))) return
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('cancel_ride_booking', { p_booking_id: id, p_reason: reason || t('mp.driverCancelledReason') })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingCancelledToast'))
    if (vehicleId) reload(vehicleId)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicleId) return null

  return (
    <div>
      {routes.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.myRoutesHeading')}</p>
          <div className="space-y-2">
            {routes.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate flex items-center gap-1"><Signpost size={12} className="shrink-0 text-dp-secondary" /> {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
                    {r.fare_mode === 'flex' ? `${t('mp.flexModeLabel')} · ${fmt(r.total_fare_pkr ?? 0)} ${t('mp.totalSuffix')}` : `${fmt(r.fare_per_seat_pkr)} ${t('mk.perSeat')}`}
                    {!r.is_active && ` · ${t('mp.routeClosedLabel')}`}
                  </p>
                </div>
                {r.is_active && (
                  <button onClick={() => closeRoute(r.id)} disabled={closingRouteId === r.id} className="shrink-0 px-2.5 py-1.5 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-error hover:bg-red-50 disabled:opacity-50">
                    {t('mp.closeRouteBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.bookingsHeading')}</p>
        {bookings.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('cm.noBookingsYet')}</p>}
        <div className="space-y-2">
          {bookings.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate flex items-center gap-1">
                    <MapPin size={12} className="shrink-0 text-dp-secondary" />
                    {b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—'}
                  </p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(b.travel_date).toLocaleDateString('en-GB')} · {b.seats} {t('mk.seatsLabel')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(b.total_amount_pkr)}</p>
                  {b.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>}
                  {b.status === 'rejected' && <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold" title={b.rejected_reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>}
                  {b.status === 'cancelled' && <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[11px] font-bold"><Ban size={11} /> {t('mp.cancelledStatus')}</span>}
                  {b.status === 'announced' && commissionMode !== 'per_order' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>}
                </div>
              </div>
              {b.status === 'announced' && commissionMode === 'per_order' && (
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  <span className="font-sans text-[11px] text-dp-on-surface-variant">{t('cm.markFulfilledHint')}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => cancelBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                    <button onClick={() => fulfillBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.markFulfilledBtn')}</button>
                  </div>
                </div>
              )}
              {b.status === 'confirmed' && (
                <div className="flex items-center justify-end gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  <button onClick={() => cancelConfirmedBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-error hover:bg-red-50 disabled:opacity-50">{t('mp.cancelBookingBtn')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
