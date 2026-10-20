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
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { MapPin, Signpost, CheckCircle2, XCircle, Ban, Clock, Plus, Megaphone } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FairPriceHint } from '@/components/mobility/FairPriceHint'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { fetchRoadRoute, type RoadRoute } from '@/lib/roadRoute'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

const DAYS = [0, 1, 2, 3, 4, 5, 6]
const emptyRouteForm = {
  origin: '', origin_ur: '', destination: '', destination_ur: '',
  classification: 'intercity', fare_mode: 'fixed', total_fare_pkr: '' as string | number,
  departure_time: '', days_of_week: [] as number[], distance_km: '' as string,
}

interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface Route { id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; fare_mode: string; fare_per_seat_pkr: number; total_fare_pkr: number | null; is_active: boolean }
interface RouteIlan { id: string; vehicle_route_id: string; status: string; is_paused: boolean; ends_at: string; created_at: string }

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
  const [ilansByRoute, setIlansByRoute] = useState<Record<string, RouteIlan>>({})
  const [actionId, setActionId] = useState<string | null>(null)
  const [closingRouteId, setClosingRouteId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyRouteForm)
  const [posting, setPosting] = useState(false)
  // Real gap found live, 2026-10-20: this form's distance_km was a bare
  // guessed number the driver typed in — no map, no real coordinates
  // ever reached create_vehicle_route_self's own p_origin_lat/lng
  // params even though the RPC has long supported them. Mirrors the
  // same map-pick + OSRM-road-distance pattern just added to the Home
  // screen's quick-publish panel.
  const [originPoint, setOriginPoint] = useState<PickedLocation | null>(null)
  const [destPoint, setDestPoint] = useState<PickedLocation | null>(null)
  const [showOriginPicker, setShowOriginPicker] = useState(false)
  const [showDestPicker, setShowDestPicker] = useState(false)
  const [routePath, setRoutePath] = useState<RoadRoute | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)

  const reload = async (id: string) => {
    const [{ data: rts }, { data: b }] = await Promise.all([
      supabase.from('vehicle_routes').select('id, origin, origin_ur, destination, destination_ur, fare_mode, fare_per_seat_pkr, total_fare_pkr, is_active')
        .eq('vehicle_id', id).order('created_at', { ascending: false }),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
        .eq('vehicle_routes.vehicle_id', id).order('created_at', { ascending: false }).limit(20),
    ])
    setRoutes(rts ?? [])
    setBookings((b ?? []) as unknown as Booking[])

    if (rts && rts.length > 0) {
      const { data: ilans } = await supabase.from('commercial_ilans')
        .select('id, vehicle_route_id, status, is_paused, ends_at, created_at')
        .in('vehicle_route_id', rts.map((r) => r.id)).order('created_at', { ascending: false })
      // Only the most recent ilan per route matters for the card's status —
      // older rejected/cancelled/expired ones from a previous "run again" don't.
      const latest: Record<string, RouteIlan> = {}
      for (const i of (ilans ?? []) as RouteIlan[]) {
        if (!latest[i.vehicle_route_id]) latest[i.vehicle_route_id] = i
      }
      setIlansByRoute(latest)
    } else setIlansByRoute({})
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

  useEffect(() => {
    if (!originPoint || !destPoint) { setRoutePath(null); return }
    setRouteLoading(true)
    let cancelled = false
    fetchRoadRoute({ lat: originPoint.lat, lng: originPoint.lng }, { lat: destPoint.lat, lng: destPoint.lng }).then((r) => {
      if (cancelled) return
      setRoutePath(r)
      setForm((f) => ({ ...f, distance_km: String(Math.round(r.distanceKm)) }))
      setRouteLoading(false)
    })
    return () => { cancelled = true }
  }, [originPoint?.lat, originPoint?.lng, destPoint?.lat, destPoint?.lng])

  const postRoute = async () => {
    if (!vehicleId || !form.origin.trim() || !form.destination.trim()) { toast.error(t('mk.nameRequired')); return }
    if (form.days_of_week.length === 0) { toast.error(t('mv.pickAtLeastOneDayError')); return }
    const distanceKm = form.distance_km ? Number(form.distance_km) : null
    const totalFare = form.total_fare_pkr ? Number(form.total_fare_pkr) : null
    // A distance lets the backend compute the fair fare on its own
    // (and reject anything typed above it) — only require a manually
    // typed total fare when no distance is given at all.
    if (!distanceKm && (!totalFare || totalFare <= 0)) { toast.error(t('mv.enterTotalFareError')); return }
    setPosting(true)
    const { data, error } = await supabase.rpc('create_vehicle_route_self', {
      p_vehicle_id: vehicleId,
      p_origin: form.origin, p_origin_ur: form.origin_ur || null,
      p_destination: form.destination, p_destination_ur: form.destination_ur || null,
      p_classification: form.classification, p_fare_mode: form.fare_mode, p_total_fare_pkr: totalFare,
      p_departure_time: form.departure_time || null, p_days_of_week: form.days_of_week,
      p_distance_km: distanceKm,
      p_origin_lat: originPoint?.lat ?? null, p_origin_lng: originPoint?.lng ?? null,
      p_destination_lat: destPoint?.lat ?? null, p_destination_lng: destPoint?.lng ?? null,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.routePosted'))
    setShowForm(false)
    const routeId = data as string
    const originLabel = form.origin
    const destinationLabel = form.destination
    setForm(emptyRouteForm)
    setOriginPoint(null)
    setDestPoint(null)
    setRoutePath(null)
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
          {showOriginPicker ? (
            <LocationPickerSheet
              title={t('mv.pickOriginOnMapBtn')}
              initial={originPoint}
              inline
              onClose={() => setShowOriginPicker(false)}
              onConfirm={(loc) => { setOriginPoint(loc); setShowOriginPicker(false) }}
            />
          ) : showDestPicker ? (
            <LocationPickerSheet
              title={t('mv.pickDestinationOnMapBtn')}
              initial={destPoint}
              defaultCenter={originPoint ? [originPoint.lat, originPoint.lng] : undefined}
              inline
              onClose={() => setShowDestPicker(false)}
              onConfirm={(loc) => { setDestPoint(loc); setShowDestPicker(false) }}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setShowOriginPicker(true)} className="flex items-center gap-1.5 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[12px] font-semibold text-start cursor-pointer">
                  <MapPin size={13} className="shrink-0 text-[#166534]" />
                  <span className={`truncate ${originPoint ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{originPoint ? originPoint.label : t('mv.pickOriginOnMapBtn')}</span>
                </button>
                <button type="button" onClick={() => setShowDestPicker(true)} className="flex items-center gap-1.5 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[12px] font-semibold text-start cursor-pointer">
                  <MapPin size={13} className="shrink-0 text-[#D4AF37]" />
                  <span className={`truncate ${destPoint ? 'text-[#1e293b]' : 'text-[#94a3b8]'}`}>{destPoint ? destPoint.label : t('mv.pickDestinationOnMapBtn')}</span>
                </button>
              </div>
              <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">{t('mv.routeMapPointsHint')}</p>
              {originPoint && destPoint && (
                <LeafletMap
                  pins={[{ lat: originPoint.lat, lng: originPoint.lng, color: '#166534' }, { lat: destPoint.lat, lng: destPoint.lng, color: '#D4AF37' }]}
                  route={routePath?.path}
                  height={140} className="rounded-xl"
                />
              )}
              {originPoint && destPoint && (
                <p className="font-sans text-[10.5px] text-[#64748b] -mt-1">{routeLoading ? t('action.loading') : routePath ? `🛣️ ${Math.round(routePath.distanceKm)} km` : ''}</p>
              )}

              <div>
                <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('cm.distanceKmOptionalLabel')}</label>
                <input type="number" value={form.distance_km} onChange={(e) => setForm((f) => ({ ...f, distance_km: e.target.value }))} placeholder={t('cm.distanceKmPlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </div>
            </>
          )}
          <input type="number" value={form.total_fare_pkr} onChange={(e) => setForm((f) => ({ ...f, total_fare_pkr: e.target.value }))} placeholder={t('mv.totalFarePlaceholder')} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          <FairPriceHint flow="route" distanceKm={form.distance_km ? Number(form.distance_km) : null} />
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
          {routes.map((r) => {
            const ilan = ilansByRoute[r.id]
            const ilanLive = ilan && ilan.status === 'approved' && !ilan.is_paused && new Date(ilan.ends_at).getTime() > Date.now()
            const ilanPending = ilan && ilan.status === 'pending_approval'
            const ilanPaused = ilan && ilan.status === 'approved' && ilan.is_paused && new Date(ilan.ends_at).getTime() > Date.now()
            const ilanHref = `/portal/my-vehicle/ilan?route=${r.id}&origin=${encodeURIComponent(isUrdu && r.origin_ur ? r.origin_ur : r.origin)}&destination=${encodeURIComponent(isUrdu && r.destination_ur ? r.destination_ur : r.destination)}`
            return (
              <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3">
                <div className="flex items-center justify-between gap-3">
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
                {r.is_active && (
                  <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
                    {ilanLive ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><Megaphone size={12} /> {t('il.adIsRunningLabel')}</span>
                    ) : ilanPending ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock size={12} /> {t('il.statusPending')}</span>
                    ) : ilanPaused ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Ban size={12} /> {t('il.pausedBadge')}</span>
                    ) : (
                      <span className="text-[11px] text-[#94a3b8]">{t('il.noAdRunningLabel')}</span>
                    )}
                    {ilanPaused ? (
                      <Link href="/portal/my-vehicle/ilan" className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-sans font-semibold cursor-pointer border border-[#166534] text-[#166534]">
                        <Megaphone size={12} /> {t('il.manageAdBtn')}
                      </Link>
                    ) : !ilanLive && !ilanPending && (
                      <Link href={ilanHref} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-sans font-semibold cursor-pointer border border-[#166534] text-[#166534]">
                        <Megaphone size={12} /> {ilan ? t('il.runAdAgainBtn') : t('il.runAdBtn')}
                      </Link>
                    )}
                  </div>
                )}
              </div>
            )
          })}
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
