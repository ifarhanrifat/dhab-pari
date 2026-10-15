'use client'

// Shared Ride browse screen — the design's own v.rShared (city grid,
// then a seat-stepper + ride list for the picked city). The Home
// screen's "Shared Ride" tile used to hard-route to the unrelated old
// weekly commute-matcher (marketplace/commute); this is the real
// screen, backed by the one-off trip-offer negotiation backend
// (vehicle_trip_offers/vehicle_trip_fare_offers/vehicle_trip_bookings,
// migration 400+) that already powers the driver's own "publish a
// ride" panel on my-vehicle/page.tsx — nothing new on the write side,
// just the rider-facing read + the two new browse RPCs (660).

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, Star, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

interface CityRow { city_key: string; destination: string; destination_ur: string | null; ride_count: number }
interface TripRow {
  id: string; vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; avg_rating: number | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; departure_time_estimate: string | null
  seats_available: number; listed_fare_per_seat_pkr: number
}
interface MyFareOffer {
  id: string; trip_offer_id: string; seats_requested: number; proposed_fare_per_seat_pkr: number
  counter_fare_per_seat_pkr: number | null; status: string
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function SharedRidePage() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [cities, setCities] = useState<CityRow[]>([])
  const [cityKey, setCityKey] = useState<string | null>(null)
  const [trips, setTrips] = useState<TripRow[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [seats, setSeats] = useState(1)
  const [myOffers, setMyOffers] = useState<Record<string, MyFareOffer>>({})
  const [offerSheetTrip, setOfferSheetTrip] = useState<TripRow | null>(null)
  const [offerAmount, setOfferAmount] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  async function loadMyOffers() {
    if (!user) return
    const { data } = await supabase.from('vehicle_trip_fare_offers')
      .select('id, trip_offer_id, seats_requested, proposed_fare_per_seat_pkr, counter_fare_per_seat_pkr, status')
      .eq('portal_user_id', user.id).in('status', ['pending', 'countered', 'accepted'])
    const byTripOffer: Record<string, MyFareOffer> = {}
    for (const row of data || []) byTripOffer[row.trip_offer_id] = row
    setMyOffers(byTripOffer)
  }

  useEffect(() => {
    supabase.rpc('open_trip_destinations').then(({ data, error }) => {
      if (error) toast.error(friendlyError(error, undefined, isUrdu))
      setCities((data as CityRow[]) || [])
      setLoading(false)
    })
    loadMyOffers()
  }, [user?.id])

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

  async function sendOffer(trip: TripRow, farePerSeat: number) {
    setBusyId(trip.id)
    const { error } = await supabase.rpc('propose_trip_fare', {
      p_trip_offer_id: trip.id, p_seats_requested: seats, p_proposed_fare_per_seat_pkr: farePerSeat,
    })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.offerSentToast'))
    setOfferSheetTrip(null); setOfferAmount('')
    loadMyOffers()
  }

  async function acceptCounter(offer: MyFareOffer) {
    setBusyId(offer.trip_offer_id)
    const { error } = await supabase.rpc('accept_trip_fare_counter', { p_fare_offer_id: offer.id })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.offerStatusAccepted'))
    loadMyOffers()
    if (cityKey) supabase.rpc('browse_open_trip_offers', { p_city_key: cityKey }).then(({ data }) => setTrips((data as TripRow[]) || []))
  }

  async function withdrawOffer(offer: MyFareOffer) {
    setBusyId(offer.trip_offer_id)
    const { error } = await supabase.rpc('withdraw_trip_fare_offer', { p_fare_offer_id: offer.id })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    loadMyOffers()
  }

  const nm = (en: string, ur: string | null) => (isUrdu && ur ? ur : en)

  if (loading) return <div className="flex justify-center py-16"><LoadingDots /></div>

  return (
    <div className="p-3.5 pb-24 space-y-3">
      <div className="flex items-center gap-2">
        {cityKey && (
          <button onClick={() => setCityKey(null)} className="cursor-pointer text-[#166534]"><ChevronLeft size={18} /></button>
        )}
        <div>
          <h1 className="font-sans text-[16px] font-extrabold text-[#1e293b]">{t('vp.sharedRideHeading')}</h1>
          <p className="text-[11px] text-[#64748b]">{cityKey ? nm(trips[0]?.destination ?? '', trips[0]?.destination_ur ?? null) : t('vp.sharedRideCitiesHint')}</p>
        </div>
      </div>

      {!cityKey && (
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

      {cityKey && (
        <>
          <div className="flex items-center justify-between bg-white border border-[#e5e2d0] rounded-2xl p-3">
            <span className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#1e293b]"><Users size={14} /> {t('vp.seatsLabel')}</span>
            <div className="flex items-center gap-3">
              <button onClick={() => setSeats((s) => Math.max(1, s - 1))} className="w-7 h-7 rounded-full bg-[#F9F9F6] border border-[#e5e2d0] font-bold cursor-pointer">−</button>
              <span className="font-sans text-[14px] font-extrabold w-4 text-center ltr-num">{seats}</span>
              <button onClick={() => setSeats((s) => Math.min(6, s + 1))} className="w-7 h-7 rounded-full bg-[#F9F9F6] border border-[#e5e2d0] font-bold cursor-pointer">+</button>
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
                const mine = myOffers[trip.id]
                return (
                  <div key={trip.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-sans text-[13.5px] font-extrabold text-[#1e293b]">{trip.owner_name}</p>
                        <p className="text-[10.5px] text-[#64748b]">
                          {trip.vehicle_type}{trip.vehicle_number ? ` · ${trip.vehicle_number}` : ''}
                          {trip.avg_rating != null && <> · <Star size={9} className="inline -mt-0.5 fill-amber-400 text-amber-400" /> {trip.avg_rating}</>}
                        </p>
                        <p className="text-[10.5px] text-[#64748b]">{nm(trip.origin, trip.origin_ur)} → {nm(trip.destination, trip.destination_ur)}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-sans text-[13px] font-extrabold text-[#166534] ltr-num">{fmt(trip.listed_fare_per_seat_pkr)}<span className="text-[9.5px] font-semibold text-[#64748b]">{t('vp.perSeatLabel')}</span></p>
                        <p className="text-[9.5px] text-[#64748b] ltr-num">{t('vp.seatsLeftLabel').replace('{n}', String(trip.seats_available))}</p>
                      </div>
                    </div>

                    {mine && mine.status === 'pending' && (
                      <div className="flex items-center justify-between bg-[#F9F9F6] rounded-xl px-2.5 py-1.5">
                        <span className="text-[10.5px] font-semibold text-[#64748b]">{t('vp.offerStatusPending')}</span>
                        <button disabled={busyId === trip.id} onClick={() => withdrawOffer(mine)} className="text-[10.5px] font-bold text-rose-600 cursor-pointer disabled:opacity-50">{t('vp.withdrawOfferBtn')}</button>
                      </div>
                    )}
                    {mine && mine.status === 'countered' && (
                      <div className="flex items-center justify-between bg-amber-50 rounded-xl px-2.5 py-1.5">
                        <span className="text-[10.5px] font-semibold text-amber-800 ltr-num">{t('vp.offerStatusCountered').replace('{price}', fmt(mine.counter_fare_per_seat_pkr ?? 0))}</span>
                        <button disabled={busyId === trip.id} onClick={() => acceptCounter(mine)} className="text-[10.5px] font-bold text-[#166534] cursor-pointer disabled:opacity-50 ltr-num">{t('vp.acceptCounterBtn').replace('{price}', fmt(mine.counter_fare_per_seat_pkr ?? 0))}</button>
                      </div>
                    )}
                    {mine && mine.status === 'accepted' && (
                      <div className="bg-emerald-50 rounded-xl px-2.5 py-1.5 text-center text-[10.5px] font-bold text-emerald-700">{t('vp.offerStatusAccepted')}</div>
                    )}

                    {!mine && (
                      <div className="flex items-center gap-2">
                        <button disabled={!ok || busyId === trip.id} onClick={() => sendOffer(trip, trip.listed_fare_per_seat_pkr)}
                          className="flex-1 rounded-xl py-2 text-[11.5px] font-bold text-white cursor-pointer disabled:opacity-50 ltr-num"
                          style={{ background: ok ? '#166534' : '#94a3b8' }}>
                          {ok ? t('vp.bookAtListedPriceBtn').replace('{price}', fmt(trip.listed_fare_per_seat_pkr * seats)) : t('vp.notEnoughSeats')}
                        </button>
                        {ok && (
                          <button onClick={() => { setOfferSheetTrip(trip); setOfferAmount(String(trip.listed_fare_per_seat_pkr)) }}
                            className="rounded-xl px-2.5 py-2 text-[10.5px] font-bold text-[#166534] border border-[#166534] cursor-pointer">
                            {t('vp.offerYourOwnPriceBtn')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {offerSheetTrip && (
        <MobilityBottomSheet title={t('vp.offerYourOwnPriceBtn')} onClose={() => setOfferSheetTrip(null)}>
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-semibold text-[#64748b]">{t('vp.yourOfferLabel')}</label>
              <input type="number" value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)}
                className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px] bg-white mt-1 ltr-num" />
            </div>
            <button disabled={busyId === offerSheetTrip.id || !Number(offerAmount)}
              onClick={() => sendOffer(offerSheetTrip, Number(offerAmount))}
              className="w-full rounded-xl py-2.5 text-[12.5px] font-bold text-white cursor-pointer disabled:opacity-50" style={{ background: '#166534' }}>
              {t('vp.shSendOfferBtn')}
            </button>
          </div>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
