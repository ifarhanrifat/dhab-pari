'use client'

// Real ask, 2026-10-28: "the system works on popup rather then
// navigation screens... keep remaining in the app, navigate to the
// rider place, when reached to that spot the rider will give code to
// driver... vehicle will start and finish the ride on that embedded
// popup screen which will be appear after clicking that green button
// for both rider and driver." One shared popup for both roles instead
// of the driver and rider each having their own disconnected pages.
//
// The live map here is the same genuinely bilateral mechanism
// /portal/marketplace/trip/[bookingId] already used — both parties
// watchPosition their own GPS and ping it (ping_trip_location, 400),
// polling the other's — not the one-way opt-in toggle my-vehicle/trips
// uses for route sharing, which is the wrong mechanism for this. The
// 4-digit PIN-gated start is the same pattern hourly/equipment already
// use (652), just extended to trip bookings (764) — the PIN itself
// never reaches this component at all for a driver (trip_booking_
// lifecycle_detail only includes it in the rider's own copy), so a
// driver genuinely has to ask the rider for it, same discipline 652's
// own comment requires.

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Loader2, AlertTriangle, Users, CheckCircle2, Ban, Maximize2, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { fetchRoadRoute } from '@/lib/roadRoute'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Detail {
  booking_id: string; role: 'driver' | 'rider'; status: string; trip_offer_id: string
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  pickup_lat: number | null; pickup_lng: number | null; pickup_label: string | null
  dest_lat: number | null; dest_lng: number | null
  pin: string | null
  vehicle_id: string; rider_portal_user_id: string
  total_amount_pkr: number
}

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function RideLifecycleSheet({ bookingId, onClose }: { bookingId: string; onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()

  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [ownPos, setOwnPos] = useState<{ lat: number; lng: number } | null>(null)
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [roadPath, setRoadPath] = useState<{ lat: number; lng: number }[] | null>(null)
  const [roadEta, setRoadEta] = useState<{ distanceKm: number; durationMin: number } | null>(null)
  const [driverPhoto, setDriverPhoto] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const lastPingRef = useRef(0)
  const lastRouteFetchRef = useRef('')

  const reload = () => {
    supabase.rpc('trip_booking_lifecycle_detail', { p_trip_booking_id: bookingId }).then(({ data }) => {
      setDetail((data as Detail) ?? null)
      setLoading(false)
    })
  }
  useRealtimeRefresh('vehicle_trip_bookings', bookingId, reload)

  // Real ask, 2026-10-29: "how the rider will verify if this car
  // driver picture is the one which driver have in his profile" — a
  // real photo already exists (captured at registration, 491/740),
  // just never read by anyone but the driver's own profile page and
  // the admin review queue. driver_photo_for_vehicle (768) is a narrow
  // read scoped to a genuine booking match, never a blind lookup.
  useEffect(() => {
    if (!detail || detail.role !== 'rider' || !detail.vehicle_id) return
    supabase.rpc('driver_photo_for_vehicle', { p_vehicle_id: detail.vehicle_id }).then(({ data }) => setDriverPhoto((data as string) ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.role, detail?.vehicle_id])

  const tracking = detail?.status === 'confirmed' || detail?.status === 'in_progress'

  // Own position: watch continuously, ping the server at most every ~12s.
  useEffect(() => {
    if (!tracking || !detail || typeof navigator === 'undefined' || !navigator.geolocation) return
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        setOwnPos({ lat: latitude, lng: longitude })
        const now = Date.now()
        if (now - lastPingRef.current > 12000) {
          lastPingRef.current = now
          supabase.rpc('ping_trip_location', { p_trip_booking_id: bookingId, p_lat: latitude, p_lng: longitude })
        }
      },
      () => setGeoError(t('cm.geoErrorMsg')),
      { enableHighAccuracy: true, maximumAge: 10000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking, detail?.booking_id])

  // Other party's position: poll.
  useEffect(() => {
    if (!tracking || !detail) return
    const otherRole = detail.role === 'driver' ? 'rider' : 'driver'
    const poll = () => {
      supabase.from('vehicle_trip_locations').select('lat, lng').eq('trip_booking_id', bookingId).eq('role', otherRole).maybeSingle()
        .then(({ data }) => { if (data) setOtherPos({ lat: Number(data.lat), lng: Number(data.lng) }) })
    }
    poll()
    const id = setInterval(poll, 12000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking, detail?.booking_id, detail?.role])

  // Real ask, 2026-10-29: "try to set the map the same as its using by
  // google route" + "the rider have no clue how many time the driver
  // will take to reach them" + "for the driver... no actual ride kms
  // like details there" — a real road-snapped path and a real ETA
  // (OSRM, free, no API key — already built and proven live elsewhere
  // in this app, src/lib/roadRoute.ts), not a straight line and not
  // silence, for BOTH legs: driver-to-pickup while still 'confirmed',
  // then driver-to-destination once 'in_progress'. Re-fetched only
  // when the driver's position has actually moved (~100m), not on
  // every 12s GPS tick, to stay well inside OSRM's public demo
  // server's fair-use limits.
  useEffect(() => {
    if (!detail) { setRoadPath(null); setRoadEta(null); return }
    const target = detail.status === 'confirmed'
      ? (detail.pickup_lat != null && detail.pickup_lng != null ? { lat: detail.pickup_lat, lng: detail.pickup_lng } : null)
      : detail.status === 'in_progress'
        ? (detail.dest_lat != null && detail.dest_lng != null ? { lat: detail.dest_lat, lng: detail.dest_lng } : null)
        : null
    const driverPos = detail.role === 'driver' ? ownPos : otherPos
    if (!target || !driverPos) { setRoadPath(null); setRoadEta(null); return }
    const key = `${detail.status}:${driverPos.lat.toFixed(3)},${driverPos.lng.toFixed(3)}`
    if (key === lastRouteFetchRef.current) return
    lastRouteFetchRef.current = key
    fetchRoadRoute(driverPos, target).then((r) => { setRoadPath(r.path); setRoadEta({ distanceKm: r.distanceKm, durationMin: r.durationMin }) })
  }, [detail?.status, detail?.pickup_lat, detail?.pickup_lng, detail?.dest_lat, detail?.dest_lng, detail?.role, ownPos, otherPos])

  const startRide = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('start_trip_booking', { p_trip_booking_id: bookingId, p_pin: pinInput || null })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cm.rideStartedToast'))
    reload()
  }

  const completeRide = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('complete_trip_booking', { p_trip_booking_id: bookingId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cm.rideCompletedToast'))
    reload()
  }

  if (loading) {
    return (
      <MobilityBottomSheet onClose={onClose}>
        <div className="flex justify-center py-8"><LoadingDots /></div>
      </MobilityBottomSheet>
    )
  }
  if (!detail) {
    return (
      <MobilityBottomSheet onClose={onClose}>
        <p className="text-center py-8 text-[13.5px] text-[#64748b]">{t('p.couldNotLoad')}</p>
      </MobilityBottomSheet>
    )
  }

  const originLabel = isUrdu && detail.origin_ur ? detail.origin_ur : detail.origin
  const destLabel = isUrdu && detail.destination_ur ? detail.destination_ur : detail.destination

  // Real ask, 2026-10-29: "the rider map is showing the destination
  // mark on his map only... try to set the map the same as its using
  // by google route" — the rider also needs a fixed pickup landmark
  // while waiting, and once the driver starts the ride, the real
  // road-snapped path (roadPath, from OSRM above) toward the
  // destination instead of two bare dots with no sense of direction.
  const destPin = detail.dest_lat != null && detail.dest_lng != null
    ? { lat: detail.dest_lat, lng: detail.dest_lng, label: destLabel, color: '#166534', emoji: '🏁' } : null
  const pickupPin = detail.pickup_lat != null && detail.pickup_lng != null
    ? { lat: detail.pickup_lat, lng: detail.pickup_lng, label: detail.pickup_label ?? originLabel, color: '#dc2626', emoji: '📍' } : null

  const pins = [
    ...(ownPos
      ? [{ lat: ownPos.lat, lng: ownPos.lng, label: t('cm.youLabel'), color: '#2563eb', emoji: detail.role === 'driver' ? '🚗' : undefined, isVehicle: detail.role === 'driver' }]
      : []),
    ...(otherPos
      ? [{ lat: otherPos.lat, lng: otherPos.lng, label: detail.role === 'driver' ? t('cm.riderLabel') : t('cm.driverLabel'), color: '#dc2626', emoji: detail.role === 'rider' ? '🚗' : undefined, isVehicle: detail.role === 'rider' }]
      : []),
    // Pickup stays visible as a fixed landmark while still heading
    // there; once underway, only the destination flag matters.
    ...(detail.status === 'confirmed' && pickupPin ? [pickupPin] : []),
    ...(detail.status === 'in_progress' && destPin ? [destPin] : []),
  ]
  const route = roadPath ?? undefined

  // Real bug found live, 2026-10-29: with zero live pins (the normal
  // state right after accept, before either side's own GPS has synced
  // yet), LeafletMap's own empty-pins fallback centers on all of
  // Pakistan at zoom 5 — to a viewer that reads as "there's no map
  // here at all", not a map that's just waiting for a pin. Centering
  // on the real pickup/destination point keeps it meaningfully zoomed
  // in the whole time, pins or not.
  const mapCenter: [number, number] | undefined =
    detail.pickup_lat != null && detail.pickup_lng != null ? [detail.pickup_lat, detail.pickup_lng]
    : detail.dest_lat != null && detail.dest_lng != null ? [detail.dest_lat, detail.dest_lng]
    : undefined

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[150] bg-white flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e2d0]" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
          <div className="min-w-0">
            <p className="font-sans text-[13px] font-bold text-[#1e293b] truncate">{originLabel} → {destLabel}</p>
            {roadEta && (
              <p className="font-sans text-[12px] text-[#64748b]">{t('cm.etaAwayLabel').replace('{min}', String(Math.round(roadEta.durationMin))).replace('{km}', roadEta.distanceKm.toFixed(1))}</p>
            )}
          </div>
          <button type="button" onClick={() => setFullscreen(false)} className="shrink-0 p-2 cursor-pointer text-[#1e293b]" aria-label={t('cm.collapseMapBtn')}>
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <LeafletMap pins={pins} route={route} center={mapCenter} height="100%" zoom={15} />
        </div>
      </div>
    )
  }

  return (
    <MobilityBottomSheet title={`${originLabel} → ${destLabel}`} onClose={onClose} minHeight="70vh">
      <div className="flex flex-col gap-3">
        {(detail.status === 'confirmed' || detail.status === 'in_progress') && (
          <>
            {/* Real ask, 2026-10-29: "there is no fare to collect or
                pay from the rider or driver side" — the original
                accept screen always showed the fare prominently;
                trip_booking_lifecycle_detail (764) never returned it
                at all, so the popup that replaced that screen dropped
                it entirely. Cash collected directly by the driver, same
                as every other booking type in this app — both sides
                genuinely need this number on screen the whole time. */}
            <div className="flex items-center justify-between bg-[#F9F9F6] rounded-xl p-3">
              <span className="font-sans text-[12.5px] text-[#64748b]">{t('mb.fareForTripLabel')}</span>
              <span className="font-sans text-[18px] font-extrabold text-[#166534] ltr-num">₨{fmt(detail.total_amount_pkr)}</span>
            </div>

            {geoError && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                <AlertTriangle size={15} className="text-amber-700 shrink-0 mt-0.5" />
                <p className="font-sans text-[12.5px] text-amber-900">{geoError}</p>
              </div>
            )}

            {detail.role === 'rider' && detail.pin && detail.status === 'confirmed' && (
              <div className="bg-[#F0FDF4] border border-[#bbf7d0] rounded-xl p-3.5 text-center">
                <p className="font-sans text-[11.5px] font-semibold text-[#166534] uppercase tracking-[0.05em]">{t('cm.yourPickupCodeHeading')}</p>
                <p className="font-sans text-[28px] font-extrabold text-[#166534] tracking-[0.3em] ltr-num mt-1">{detail.pin}</p>
                <p className="font-sans text-[12px] text-[#64748b] mt-1">{t('cm.yourPickupCodeHint')}</p>
              </div>
            )}

            {detail.role === 'rider' && driverPhoto && (
              <div className="flex items-center gap-3 bg-[#F9F9F6] border border-[#e5e2d0] rounded-xl p-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={driverPhoto} alt="" className="w-12 h-12 rounded-full object-cover shrink-0 border border-[#e5e2d0]" />
                <p className="font-sans text-[11.5px] text-[#64748b]">{t('cm.verifyDriverPhotoHint')}</p>
              </div>
            )}

            {/* Real ask, 2026-10-29: "make this map for the rider full
                page display... zoomed map with zoomed road detail to
                find a real way to the destination just like google is
                helping the driver on the map" — an expand button opens
                the same live map full-viewport instead of the small
                220px embedded one, without leaving the popup paradigm
                (no new page navigation, same live data). */}
            <div className="relative">
              <LeafletMap pins={pins} route={route} center={mapCenter} height={220} className="rounded-xl" />
              <button type="button" onClick={() => setFullscreen(true)}
                className="absolute top-2 right-2 z-[60] bg-white shadow-md rounded-lg p-2 cursor-pointer" aria-label={t('cm.expandMapBtn')}>
                <Maximize2 size={15} className="text-[#1e293b]" />
              </button>
            </div>
            {roadEta && (
              <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">
                {t('cm.etaAwayLabel').replace('{min}', String(Math.round(roadEta.durationMin))).replace('{km}', roadEta.distanceKm.toFixed(1))}
              </p>
            )}
            <p className="font-sans text-[11.5px] text-[#64748b]">{t('cm.locationSharingHint')}</p>
            {!otherPos && (
              <p className="font-sans text-[12px] text-[#64748b]">{detail.role === 'driver' ? t('cm.waitingForRiderLocation') : t('cm.waitingForDriverLocation')}</p>
            )}

            {detail.status === 'in_progress' && (
              <p className="inline-flex items-center justify-center gap-1.5 font-sans text-[12.5px] font-bold text-[#166534] bg-[#F0FDF4] rounded-lg py-2">
                <span className="w-2 h-2 rounded-full bg-[#166534] animate-pulse" /> {t('cm.rideInProgressLabel')}
              </p>
            )}

            {detail.role === 'driver' && detail.status === 'confirmed' && (
              <div className="flex flex-col gap-2 mt-1 pt-3 border-t border-[#f1f5f9]">
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{t('vp.pinAskHint')}</p>
                <input
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  inputMode="numeric" maxLength={4} placeholder="••••"
                  className="w-full text-center tracking-[0.5em] font-bold text-[20px] ltr-num border border-[#e5e2d0] rounded-xl py-2"
                />
                <button onClick={startRide} disabled={busy || pinInput.length !== 4}
                  className="w-full py-3 rounded-xl text-[14px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50 flex items-center justify-center gap-1.5">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : null} {t('cm.startRideBtn')}
                </button>
              </div>
            )}

            {detail.role === 'driver' && detail.status === 'in_progress' && (
              <div className="flex flex-col gap-1.5 mt-1">
                <p className="font-sans text-[12px] text-[#64748b] text-center">{t('cm.collectCashBeforeBtn').replace('{amount}', fmt(detail.total_amount_pkr))}</p>
                <button onClick={completeRide} disabled={busy}
                  className="w-full py-3 rounded-xl text-[14px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50 flex items-center justify-center gap-1.5">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={16} />} {t('cm.completeRideBtn')}
                </button>
              </div>
            )}

            <Link href={`/portal/marketplace/trip-group/${detail.trip_offer_id}`}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-[13px] font-sans font-bold cursor-pointer border border-[#166534] text-[#166534]">
              <Users size={14} /> {t('cm.openGroupChatBtn')}
            </Link>
          </>
        )}

        {detail.status === 'completed' && (
          <>
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle2 size={28} className="text-[#166534]" />
              <p className="font-sans text-[14px] font-bold text-[#166534]">{t('cm.tripCompletedStatus')}</p>
              <p className="font-sans text-[20px] font-extrabold text-[#166534] ltr-num">₨{fmt(detail.total_amount_pkr)}</p>
              <p className="font-sans text-[12px] text-[#64748b]">{detail.role === 'driver' ? t('cm.collectedFromRiderNote') : t('cm.paidToDriverNote')}</p>
            </div>
            {/* Real ask, 2026-10-29: "when ride is completed from both
                end there was no feture appear to give 5 start 4 start
                award to the driver, this thing we have created long ago
                but you failed to find what we have built" — correct:
                submit_rating already covers ref_type='trip_booking'
                (650) and RateAndReport is the exact shared widget every
                other completed-booking screen already uses — just
                never wired in here. */}
            <RateAndReport
              refType="trip_booking" refId={bookingId}
              againstPartyType={detail.role === 'rider' ? 'vehicle' : 'portal_user'}
              againstPartyId={detail.role === 'rider' ? detail.vehicle_id : detail.rider_portal_user_id}
            />
          </>
        )}

        {detail.status === 'cancelled' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Ban size={24} className="text-[#94a3b8]" />
            <p className="font-sans text-[13px] text-[#64748b]">{t('mp.cancelledStatus')}</p>
          </div>
        )}
      </div>
    </MobilityBottomSheet>
  )
}
