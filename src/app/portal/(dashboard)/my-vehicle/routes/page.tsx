'use client'

// My Routes + Bookings — its own screen, matching the design zip's
// "ROUTE BOOKINGS" screen (this used to be a section embedded on the
// driver dashboard, moved out per direct instruction). Route/schedule
// creation itself stays staff-managed (unlike a shop's own catalog) —
// this is what a per_order driver actually needs day to day: closing a
// route he no longer runs, and confirming/rejecting/cancelling bookings.
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Jobs tab's route rows or the Home screen's quick link.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Signpost, CheckCircle2, XCircle, Ban, Clock, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

const DAYS = [0, 1, 2, 3, 4, 5, 6]
const emptyRouteForm = {
  origin: '', origin_ur: '', destination: '', destination_ur: '',
  classification: 'intercity', fare_mode: 'fixed', total_fare_pkr: '' as string | number,
  departure_time: '', days_of_week: [] as number[],
}

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
  const router = useRouter()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [commissionMode, setCommissionMode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [routes, setRoutes] = useState<Route[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [actionId, setActionId] = useState<string | null>(null)
  const [closingRouteId, setClosingRouteId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyRouteForm)
  const [posting, setPosting] = useState(false)

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
  const toggleDay = (d: number) => {
    setForm((f) => ({ ...f, days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter((x) => x !== d) : [...f.days_of_week, d].sort() }))
  }

  const postRoute = async () => {
    if (!vehicleId || !form.origin.trim() || !form.destination.trim()) { toast.error(t('mk.nameRequired')); return }
    if (form.days_of_week.length === 0) { toast.error(t('mv.pickAtLeastOneDayError')); return }
    const totalFare = Number(form.total_fare_pkr)
    if (!totalFare || totalFare <= 0) { toast.error(t('mv.enterTotalFareError')); return }
    setPosting(true)
    const { data, error } = await supabase.rpc('create_vehicle_route_self', {
      p_vehicle_id: vehicleId,
      p_origin: form.origin, p_origin_ur: form.origin_ur || null,
      p_destination: form.destination, p_destination_ur: form.destination_ur || null,
      p_classification: form.classification, p_fare_mode: form.fare_mode, p_total_fare_pkr: totalFare,
      p_departure_time: form.departure_time || null, p_days_of_week: form.days_of_week,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.routePosted'))
    setShowForm(false)
    const routeId = data as string
    const originLabel = form.origin
    const destinationLabel = form.destination
    setForm(emptyRouteForm)
    if (vehicleId) reload(vehicleId)
    if (confirm(t('mv.advertiseThisRidePrompt'))) {
      router.push(`/portal/my-vehicle/ilan?route=${routeId}&origin=${encodeURIComponent(originLabel)}&destination=${encodeURIComponent(destinationLabel)}`)
    }
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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicleId) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Signpost size={19} /> {t('mp.myRoutesHeading')}</h1>
        <button onClick={() => setShowForm((v) => !v)} className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-semibold cursor-pointer">
          <Plus size={14} /> {t('mv.postRouteBtn')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5 flex flex-col gap-2.5">
          <p className="font-sans text-[13px] font-bold text-[#1e293b]">{t('mv.postRouteHeading')}</p>
          <div className="grid grid-cols-2 gap-2">
            <input value={form.origin} onChange={(e) => setForm((f) => ({ ...f, origin: e.target.value }))} placeholder={t('mv.originPlaceholder')} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            <input value={form.origin_ur} onChange={(e) => setForm((f) => ({ ...f, origin_ur: e.target.value }))} placeholder={t('mv.originUrPlaceholder')} dir="rtl" className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            <input value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))} placeholder={t('mv.destinationPlaceholder')} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            <input value={form.destination_ur} onChange={(e) => setForm((f) => ({ ...f, destination_ur: e.target.value }))} placeholder={t('mv.destinationUrPlaceholder')} dir="rtl" className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select value={form.classification} onChange={(e) => setForm((f) => ({ ...f, classification: e.target.value }))} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
              <option value="intercity">{t('mv.classification.intercity')}</option>
              <option value="out_of_city">{t('mv.classification.out_of_city')}</option>
            </select>
            <select value={form.fare_mode} onChange={(e) => setForm((f) => ({ ...f, fare_mode: e.target.value }))} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
              <option value="fixed">{t('mv.fareMode.fixed')}</option>
              <option value="flex">{t('mv.fareMode.flex')}</option>
            </select>
          </div>
          <input type="number" value={form.total_fare_pkr} onChange={(e) => setForm((f) => ({ ...f, total_fare_pkr: e.target.value }))} placeholder={t('mv.totalFarePlaceholder')} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.departureTimeLabel')}</label>
            <input type="time" value={form.departure_time} onChange={(e) => setForm((f) => ({ ...f, departure_time: e.target.value }))} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.daysOfWeekLabel')}</label>
            <div className="flex gap-1.5 flex-wrap">
              {DAYS.map((d) => (
                <button key={d} type="button" onClick={() => toggleDay(d)} className={`px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer ${form.days_of_week.includes(d) ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                  {t(`mv.dayShort.${d}`)}
                </button>
              ))}
            </div>
          </div>
          <button onClick={postRoute} disabled={posting} className="mt-1 px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {t('mv.postRouteSubmitBtn')}
          </button>
        </div>
      )}

      {routes.length === 0 && !showForm && <p className="font-sans text-[13px] text-[#94a3b8] text-center py-6">{t('mv.noRoutesYet')}</p>}

      {routes.length > 0 && (
        <div className="flex flex-col gap-2">
          {routes.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
              <div className="min-w-0">
                <p className="font-sans text-[13.5px] font-semibold text-[#1e293b] truncate flex items-center gap-1"><Signpost size={12} className="shrink-0 text-[#166534]" /> {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
                <p className="font-sans text-[12px] text-[#64748b] mt-0.5">
                  {r.fare_mode === 'flex' ? `${t('mp.flexModeLabel')} · ${fmt(r.total_fare_pkr ?? 0)} ${t('mp.totalSuffix')}` : `${fmt(r.fare_per_seat_pkr)} ${t('mk.perSeat')}`}
                  {!r.is_active && ` · ${t('mp.routeClosedLabel')}`}
                </p>
              </div>
              {r.is_active && (
                <button onClick={() => closeRoute(r.id)} disabled={closingRouteId === r.id} className="shrink-0 px-2.5 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">
                  {t('mp.closeRouteBtn')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div>
        <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('mp.bookingsHeading')}</p>
        {bookings.length === 0 && <p className="font-sans text-[13px] text-[#94a3b8] text-center py-6">{t('cm.noBookingsYet')}</p>}
        <div className="flex flex-col gap-2">
          {bookings.map((b) => (
            <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate flex items-center gap-1">
                    <MapPin size={12} className="shrink-0 text-[#166534]" />
                    {b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—'}
                  </p>
                  <p className="font-sans text-[12px] text-[#64748b] mt-0.5">{new Date(b.travel_date).toLocaleDateString('en-GB')} · {b.seats} {t('mk.seatsLabel')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[14px] font-bold text-[#166534]">{fmt(b.total_amount_pkr)}</p>
                  {b.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>}
                  {b.status === 'rejected' && <span className="inline-flex items-center gap-1 text-[#b91c1c] text-[11px] font-bold" title={b.rejected_reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>}
                  {b.status === 'cancelled' && <span className="inline-flex items-center gap-1 text-[#64748b] text-[11px] font-bold"><Ban size={11} /> {t('mp.cancelledStatus')}</span>}
                  {b.status === 'announced' && commissionMode !== 'per_order' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>}
                </div>
              </div>
              {b.status === 'announced' && commissionMode === 'per_order' && (
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-[#f1f5f9]">
                  <span className="font-sans text-[11px] text-[#64748b]">{t('cm.markFulfilledHint')}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => cancelBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b] disabled:opacity-50">{t('mp.rejectBtn')}</button>
                    <button onClick={() => fulfillBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{t('cm.markFulfilledBtn')}</button>
                  </div>
                </div>
              )}
              {b.status === 'confirmed' && (
                <div className="flex items-center justify-end gap-2 mt-2.5 pt-2.5 border-t border-[#f1f5f9]">
                  <button onClick={() => cancelConfirmedBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">{t('mp.cancelBookingBtn')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
