'use client'

// Bilateral live location — only while a trip booking is 'confirmed',
// only between the two matched parties (RLS on vehicle_trip_locations
// enforces this regardless of what this page does). Own position comes
// from the browser's Geolocation API and is pinged to the server every
// ~12s (not on every watchPosition event — that fires far too often);
// the other party's position is polled on the same cadence. Genuinely
// free — Leaflet + OpenStreetMap, no Google account, no billing.
//
// Real limitation, not hidden: this only works while this page stays
// open and the phone stays awake. Neither iOS nor Android browsers allow
// reliable background geolocation from a web page — that's a native-app
// capability this deliberately doesn't pretend to have.

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Navigation, AlertTriangle } from 'lucide-react'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Booking {
  id: string; status: string; portal_user_id: string; vehicle_id: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}

export default function TripTrackingPage() {
  const { t, isUrdu } = useLocale()
  const params = useParams<{ bookingId: string }>()
  const router = useRouter()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [booking, setBooking] = useState<Booking | null>(null)
  const [role, setRole] = useState<'driver' | 'rider' | null>(null)
  const [loading, setLoading] = useState(true)
  const [ownPos, setOwnPos] = useState<{ lat: number; lng: number } | null>(null)
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null)
  const [geoError, setGeoError] = useState<string | null>(null)
  const lastPingRef = useRef(0)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicle_trip_bookings').select('id, status, portal_user_id, vehicle_id, vehicle_trip_offers(origin, origin_ur, destination, destination_ur)')
      .eq('id', params.bookingId).single().then(async ({ data }) => {
        setBooking(data as unknown as Booking)
        if (data) {
          if (data.portal_user_id === user.id) setRole('rider')
          else {
            const { data: v } = await supabase.from('vehicles').select('id').eq('id', data.vehicle_id).eq('portal_user_id', user.id).maybeSingle()
            if (v) setRole('driver')
          }
        }
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, params.bookingId])

  // Own position: watch continuously, ping the server at most every ~12s.
  useEffect(() => {
    if (!booking || booking.status !== 'confirmed' || !role || !navigator.geolocation) return
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        setOwnPos({ lat: latitude, lng: longitude })
        const now = Date.now()
        if (now - lastPingRef.current > 12000) {
          lastPingRef.current = now
          supabase.rpc('ping_trip_location', { p_trip_booking_id: booking.id, p_lat: latitude, p_lng: longitude })
        }
      },
      () => setGeoError(t('cm.geoErrorMsg')),
      { enableHighAccuracy: true, maximumAge: 10000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [booking, role]) // eslint-disable-line react-hooks/exhaustive-deps

  // Other party's position: poll.
  useEffect(() => {
    if (!booking || booking.status !== 'confirmed' || !role) return
    const otherRole = role === 'driver' ? 'rider' : 'driver'
    const poll = () => {
      supabase.from('vehicle_trip_locations').select('lat, lng').eq('trip_booking_id', booking.id).eq('role', otherRole).maybeSingle()
        .then(({ data }) => { if (data) setOtherPos({ lat: Number(data.lat), lng: Number(data.lng) }) })
    }
    poll()
    const id = setInterval(poll, 12000)
    return () => clearInterval(id)
  }, [booking, role]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!booking || !role) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const pins = [
    ...(ownPos ? [{ lat: ownPos.lat, lng: ownPos.lng, label: t('cm.youLabel'), color: '#2563eb' }] : []),
    ...(otherPos ? [{ lat: otherPos.lat, lng: otherPos.lng, label: role === 'driver' ? t('cm.riderLabel') : t('cm.driverLabel'), color: '#dc2626' }] : []),
  ]

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13.5px] font-semibold hover:underline cursor-pointer mb-4">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}
      </button>
      <h1 className="font-heading text-[22px] font-bold text-dp-primary flex items-center gap-2 mb-1"><Navigation size={20} /> {t('cm.trackLocationBtn')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
        {booking.vehicle_trip_offers ? `${isUrdu && booking.vehicle_trip_offers.origin_ur ? booking.vehicle_trip_offers.origin_ur : booking.vehicle_trip_offers.origin} → ${isUrdu && booking.vehicle_trip_offers.destination_ur ? booking.vehicle_trip_offers.destination_ur : booking.vehicle_trip_offers.destination}` : ''}
      </p>

      {booking.status !== 'confirmed' ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('cm.tripNotActiveMsg')}</p>
      ) : (
        <>
          {geoError && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 mb-4 flex items-start gap-2">
              <AlertTriangle size={16} className="text-amber-700 shrink-0 mt-0.5" />
              <p className="font-sans text-[13px] text-amber-900">{geoError}</p>
            </div>
          )}
          <LeafletMap pins={pins} height={340} />
          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-3">{t('cm.locationSharingHint')}</p>
          {!otherPos && (
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-2">{role === 'driver' ? t('cm.waitingForRiderLocation') : t('cm.waitingForDriverLocation')}</p>
          )}
        </>
      )}
    </div>
  )
}
