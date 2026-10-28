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
import { Loader2, AlertTriangle, Users, CheckCircle2, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Detail {
  booking_id: string; role: 'driver' | 'rider'; status: string; trip_offer_id: string
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  pickup_lat: number | null; pickup_lng: number | null; pickup_label: string | null
  dest_lat: number | null; dest_lng: number | null
  pin: string | null
}

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
  const lastPingRef = useRef(0)

  const reload = () => {
    supabase.rpc('trip_booking_lifecycle_detail', { p_trip_booking_id: bookingId }).then(({ data }) => {
      setDetail((data as Detail) ?? null)
      setLoading(false)
    })
  }
  useRealtimeRefresh('vehicle_trip_bookings', bookingId, reload)

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
  const pins = [
    ...(ownPos ? [{ lat: ownPos.lat, lng: ownPos.lng, label: t('cm.youLabel'), color: '#2563eb' }] : []),
    ...(otherPos
      ? [{ lat: otherPos.lat, lng: otherPos.lng, label: detail.role === 'driver' ? t('cm.riderLabel') : t('cm.driverLabel'), color: '#dc2626' }]
      : detail.role === 'driver' && detail.pickup_lat != null && detail.pickup_lng != null
        ? [{ lat: detail.pickup_lat, lng: detail.pickup_lng, label: detail.pickup_label ?? originLabel, color: '#dc2626' }]
        : []),
  ]

  return (
    <MobilityBottomSheet title={`${originLabel} → ${destLabel}`} onClose={onClose} minHeight="70vh">
      <div className="flex flex-col gap-3">
        {(detail.status === 'confirmed' || detail.status === 'in_progress') && (
          <>
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

            <LeafletMap pins={pins} height={220} className="rounded-xl" />
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
              <button onClick={completeRide} disabled={busy}
                className="w-full py-3 rounded-xl text-[14px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50 flex items-center justify-center gap-1.5 mt-1">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={16} />} {t('cm.completeRideBtn')}
              </button>
            )}

            <Link href={`/portal/marketplace/trip-group/${detail.trip_offer_id}`}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-[13px] font-sans font-bold cursor-pointer border border-[#166534] text-[#166534]">
              <Users size={14} /> {t('cm.openGroupChatBtn')}
            </Link>
          </>
        )}

        {detail.status === 'completed' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 size={28} className="text-[#166534]" />
            <p className="font-sans text-[14px] font-bold text-[#166534]">{t('cm.tripCompletedStatus')}</p>
          </div>
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
