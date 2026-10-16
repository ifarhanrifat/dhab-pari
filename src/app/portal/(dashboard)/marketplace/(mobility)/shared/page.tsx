'use client'

// Shared Ride browse screen — the design's own v.rShared (city grid,
// then a seat-stepper + ride list for the picked city). The Home
// screen's "Shared Ride" tile used to hard-route to the unrelated old
// weekly commute-matcher (marketplace/commute); this is the real
// screen, backed by the one-off trip-offer backend
// (vehicle_trip_offers/vehicle_trip_bookings) that already powers the
// driver's own "publish a ride" panel on my-vehicle/page.tsx.
//
// 2026-10-17: fares are fixed at the driver's listed price — no
// propose/counter negotiation on this screen any more (book_trip_offer,
// migration 685). The old propose_trip_fare/respond_trip_fare_offer
// negotiation RPCs/table are untouched in the backend (a few real
// pending/accepted rows from before this change still need the
// driver's own trips page to resolve them), this screen just stops
// creating new ones.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, Star, Users, Clock, CheckCircle2, Ban, CalendarClock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface CityRow { city_key: string; destination: string; destination_ur: string | null; ride_count: number }
interface TripRow {
  id: string; vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; avg_rating: number | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; departure_time_estimate: string | null
  seats_available: number; listed_fare_per_seat_pkr: number; trip_type: string
}
interface BookingRow {
  id: string; status: string; seats: number; leg: string; agreed_fare_per_seat_pkr: number; total_amount_pkr: number
  cancellation_reason: string | null; owner_name: string; vehicle_type: string; vehicle_number: string | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  travel_date: string; departure_time_estimate: string | null; trip_type: string
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

function fmtTime(t: string | null, isUrdu: boolean) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const hour12 = h % 12 === 0 ? 12 : h % 12
  const suffix = isUrdu ? (h < 12 ? 'صبح' : h < 17 ? 'دوپہر' : 'شام') : (h < 12 ? 'AM' : 'PM')
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`
}

export default function SharedRidePage() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'browse' | 'bookings'>('browse')
  const [cities, setCities] = useState<CityRow[]>([])
  const [cityKey, setCityKey] = useState<string | null>(null)
  const [trips, setTrips] = useState<TripRow[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [seats, setSeats] = useState(1)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [myBookings, setMyBookings] = useState<BookingRow[]>([])
  const [bookingsFilter, setBookingsFilter] = useState<'upcoming' | 'completed' | 'cancelled'>('upcoming')

  function loadMyBookings() {
    supabase.rpc('my_trip_bookings').then(({ data, error }) => {
      if (error) toast.error(friendlyError(error, undefined, isUrdu))
      setMyBookings((data as BookingRow[]) || [])
    })
  }

  useEffect(() => {
    supabase.rpc('open_trip_destinations').then(({ data, error }) => {
      if (error) toast.error(friendlyError(error, undefined, isUrdu))
      setCities((data as CityRow[]) || [])
      setLoading(false)
    })
    loadMyBookings()
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function openCity(c: CityRow) {
    setCityKey(c.city_key)
    setSeats(1)
    setListLoading(true)
    supabase.rpc('browse_open_trip_offers', { p_city_key: c.city_key }).then(({ data, error }) => {
      if (error) toast.error(friendlyError(error, undefined, isUrdu))
      setTrips((data as TripRow[]) || [])
      setListLoading(false)
    })
  }

  async function bookTrip(trip: TripRow, leg: 'oneway' | 'return') {
    setBusyId(trip.id)
    const { error } = await supabase.rpc('book_trip_offer', { p_trip_offer_id: trip.id, p_seats_requested: seats, p_leg: leg })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.tripBookedToast'))
    if (cityKey) {
      setListLoading(true)
      supabase.rpc('browse_open_trip_offers', { p_city_key: cityKey }).then(({ data }) => {
        setTrips((data as TripRow[]) || [])
        setListLoading(false)
      })
    }
    loadMyBookings()
  }

  async function cancelBooking(b: BookingRow) {
    if (!window.confirm(t('mp.confirmCancelConfirmedHint'))) return
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setBusyId(b.id)
    const { error } = await supabase.rpc('cancel_trip_booking', { p_trip_booking_id: b.id, p_reason: reason || null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingCancelledToast'))
    loadMyBookings()
  }

  const nm = (en: string, ur: string | null) => (isUrdu && ur ? ur : en)

  // The seat stepper is shared across every ride listed for this city —
  // never let it climb past the most seats any of them actually has, so
  // a 4-seat vehicle can't be stepped up to 6 and shown as unbookable.
  const maxSeatsHere = trips.length > 0 ? Math.max(...trips.map((t) => t.seats_available)) : 6

  if (loading) return <div className="flex justify-center py-16"><LoadingDots /></div>

  return (
    <div className="p-3.5 pb-24 space-y-3">
      <div className="flex items-center gap-2">
        {cityKey && tab === 'browse' && (
          <button onClick={() => setCityKey(null)} className="cursor-pointer text-[#166534]"><ChevronLeft size={18} /></button>
        )}
        <div>
          <h1 className="font-sans text-[16px] font-extrabold text-[#1e293b]">{t('vp.sharedRideHeading')}</h1>
          <p className="text-[11px] text-[#64748b]">
            {tab === 'bookings' ? t('vp.myBookingsTab') : cityKey ? nm(trips[0]?.destination ?? '', trips[0]?.destination_ur ?? null) : t('vp.sharedRideCitiesHint')}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 bg-[#F9F9F6] border border-[#e5e2d0] rounded-xl p-1">
        <button onClick={() => setTab('browse')}
          className="flex-1 rounded-lg py-1.5 text-[12px] font-bold cursor-pointer"
          style={{ background: tab === 'browse' ? '#166534' : 'transparent', color: tab === 'browse' ? '#fff' : '#64748b' }}>
          {t('vp.browseTab')}
        </button>
        <button onClick={() => setTab('bookings')}
          className="flex-1 rounded-lg py-1.5 text-[12px] font-bold cursor-pointer"
          style={{ background: tab === 'bookings' ? '#166534' : 'transparent', color: tab === 'bookings' ? '#fff' : '#64748b' }}>
          {t('vp.myBookingsTab')}
        </button>
      </div>

      {tab === 'bookings' && (
        <>
          <div className="flex items-center gap-1.5">
            {(['upcoming', 'completed', 'cancelled'] as const).map((f) => (
              <button key={f} onClick={() => setBookingsFilter(f)}
                className="px-3 py-1 rounded-full text-[11px] font-bold cursor-pointer border"
                style={{ background: bookingsFilter === f ? '#166534' : '#fff', color: bookingsFilter === f ? '#fff' : '#64748b', borderColor: bookingsFilter === f ? '#166534' : '#e5e2d0' }}>
                {t(`vp.bookingsFilter.${f}`)}
              </button>
            ))}
          </div>

          {(() => {
            const filtered = myBookings.filter((b) =>
              bookingsFilter === 'upcoming' ? b.status === 'confirmed' : bookingsFilter === 'completed' ? b.status === 'completed' : b.status === 'cancelled')
            if (filtered.length === 0) return <p className="text-center text-[12.5px] text-[#64748b] py-10">{t('cm.noBookingsYet')}</p>
            return (
              <div className="space-y-2.5">
                {filtered.map((b) => {
                  const depTime = fmtTime(b.departure_time_estimate, isUrdu)
                  const badge =
                    b.status === 'confirmed' ? { icon: <CalendarClock size={11} />, cls: 'bg-emerald-50 text-emerald-700', label: t('mp.confirmedStatus') } :
                    b.status === 'completed' ? { icon: <CheckCircle2 size={11} />, cls: 'bg-sky-50 text-sky-700', label: t('cm.tripCompletedStatus') } :
                    { icon: <Ban size={11} />, cls: 'bg-rose-50 text-rose-600', label: t('mp.cancelledStatus') }
                  return (
                    <div key={b.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="font-sans text-[13px] font-extrabold text-[#1e293b]">{nm(b.origin, b.origin_ur)} → {nm(b.destination, b.destination_ur)}</p>
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${b.leg === 'return' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>
                              {b.leg === 'return' ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}
                            </span>
                          </div>
                          <p className="text-[10.5px] text-[#64748b]">{b.owner_name} · {b.vehicle_type}{b.vehicle_number ? ` · ${b.vehicle_number}` : ''}</p>
                          <p className="text-[10.5px] text-[#64748b] ltr-num">{new Date(b.travel_date).toLocaleDateString('en-GB')}{depTime ? ` · ${depTime}` : ''} · {b.seats} {t('vp.seatsLabel')}</p>
                          {b.status === 'cancelled' && b.cancellation_reason && (
                            <p className="text-[10.5px] text-rose-600 mt-0.5">{b.cancellation_reason}</p>
                          )}
                        </div>
                        <div className="text-right shrink-0 space-y-1">
                          <p className="font-sans text-[13px] font-extrabold text-[#166534] ltr-num">{fmt(b.total_amount_pkr)}</p>
                          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.icon} {badge.label}</span>
                        </div>
                      </div>
                      {b.status === 'confirmed' && (
                        <button onClick={() => cancelBooking(b)} disabled={busyId === b.id}
                          className="w-full rounded-xl py-1.5 text-[11px] font-bold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">
                          {t('mp.cancelBookingBtn')}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </>
      )}

      {tab === 'browse' && !cityKey && (
        cities.length === 0 ? (
          <p className="text-center text-[12.5px] text-[#64748b] py-10">{t('vp.noOpenTripsAnywhere')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {cities.map((c) => (
              <button key={c.city_key} onClick={() => openCity(c)}
                className="flex flex-col items-start gap-1 p-3 rounded-2xl border border-[#e5e2d0] bg-white text-left cursor-pointer hover:border-[#166534]">
                <span className="text-[13.5px] font-bold text-[#1e293b]">🏙️ {nm(c.destination, c.destination_ur)}</span>
                <span className="text-[10.5px] text-[#64748b] ltr-num">{t('vp.ridesCountLabel').replace('{n}', String(c.ride_count))}</span>
              </button>
            ))}
          </div>
        )
      )}

      {tab === 'browse' && cityKey && (
        <>
          <div className="flex items-center justify-between bg-white border border-[#e5e2d0] rounded-2xl p-3">
            <span className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#1e293b]"><Users size={14} /> {t('vp.seatsLabel')}</span>
            <div className="flex items-center gap-3">
              <button onClick={() => setSeats((s) => Math.max(1, s - 1))} className="w-7 h-7 rounded-full bg-[#F9F9F6] border border-[#e5e2d0] font-bold cursor-pointer">−</button>
              <span className="font-sans text-[14px] font-extrabold w-4 text-center ltr-num">{seats}</span>
              <button onClick={() => setSeats((s) => Math.min(maxSeatsHere, s + 1))} className="w-7 h-7 rounded-full bg-[#F9F9F6] border border-[#e5e2d0] font-bold cursor-pointer">+</button>
            </div>
          </div>

          {listLoading ? (
            <div className="flex justify-center py-10"><LoadingDots /></div>
          ) : trips.length === 0 ? (
            <p className="text-center text-[12.5px] text-[#64748b] py-10">{t('vp.noOpenTripsToCity')}</p>
          ) : (
            <div className="space-y-2.5">
              {trips.map((trip) => {
                const ok = trip.seats_available >= seats
                const depTime = fmtTime(trip.departure_time_estimate, isUrdu)
                const isReturn = trip.trip_type === 'return'
                const onewayFare = isReturn ? Math.round(trip.listed_fare_per_seat_pkr / 2) : trip.listed_fare_per_seat_pkr
                return (
                  <div key={trip.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="font-sans text-[13.5px] font-extrabold text-[#1e293b]">{trip.owner_name}</p>
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${isReturn ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>
                            {isReturn ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}
                          </span>
                        </div>
                        <p className="text-[10.5px] text-[#64748b]">
                          {trip.vehicle_type}{trip.vehicle_number ? ` · ${trip.vehicle_number}` : ''}
                          {trip.avg_rating != null && <> · <Star size={9} className="inline -mt-0.5 fill-amber-400 text-amber-400" /> {trip.avg_rating}</>}
                        </p>
                        <p className="text-[10.5px] text-[#64748b]">{nm(trip.origin, trip.origin_ur)} → {nm(trip.destination, trip.destination_ur)}</p>
                        {depTime && (
                          <p className="text-[10.5px] text-[#64748b] flex items-center gap-1 mt-0.5"><Clock size={10} /> {t('vp.departureLabel')} <span className="ltr-num font-semibold text-[#1e293b]">{depTime}</span></p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-sans text-[13px] font-extrabold text-[#166534] ltr-num">{fmt(onewayFare)}<span className="text-[9.5px] font-semibold text-[#64748b]">{t('vp.perSeatLabel')}</span></p>
                        {isReturn && <p className="text-[9.5px] text-[#64748b] ltr-num">{t('vp.returnFareLabel')} {fmt(trip.listed_fare_per_seat_pkr)}</p>}
                        <span className={`inline-flex items-center gap-1 mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ltr-num ${trip.seats_available <= 1 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'}`}>
                          <Users size={10} /> {t('vp.seatsLeftLabel').replace('{n}', String(trip.seats_available))}
                        </span>
                      </div>
                    </div>

                    {isReturn ? (
                      <div className="flex items-center gap-2">
                        <button disabled={!ok || busyId === trip.id} onClick={() => bookTrip(trip, 'oneway')}
                          className="flex-1 rounded-xl py-2 text-[11px] font-bold text-white cursor-pointer disabled:opacity-50 ltr-num"
                          style={{ background: ok ? '#166534' : '#94a3b8' }}>
                          {ok ? t('vp.bookOneWayBtn').replace('{price}', fmt(onewayFare * seats)) : t('vp.notEnoughSeats')}
                        </button>
                        <button disabled={!ok || busyId === trip.id} onClick={() => bookTrip(trip, 'return')}
                          className="flex-1 rounded-xl py-2 text-[11px] font-bold cursor-pointer border border-[#166534] text-[#166534] disabled:opacity-50 ltr-num">
                          {t('vp.bookReturnBtn').replace('{price}', fmt(trip.listed_fare_per_seat_pkr * seats))}
                        </button>
                      </div>
                    ) : (
                      <button disabled={!ok || busyId === trip.id} onClick={() => bookTrip(trip, 'oneway')}
                        className="w-full rounded-xl py-2 text-[11.5px] font-bold text-white cursor-pointer disabled:opacity-50 ltr-num"
                        style={{ background: ok ? '#166534' : '#94a3b8' }}>
                        {ok ? t('vp.bookAtListedPriceBtn').replace('{price}', fmt(trip.listed_fare_per_seat_pkr * seats)) : t('vp.notEnoughSeats')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
