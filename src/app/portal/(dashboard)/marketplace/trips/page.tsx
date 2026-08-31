'use client'

// Rider side of the one-off return-trip ride-share: browse what's open,
// propose a fare, accept a driver's counter or withdraw. No fixed price
// like a scheduled route booking — every trip here is negotiated.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, MapPin, Navigation, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface TripOffer {
  id: string; trip_type: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; departure_time_estimate: string | null; seats_available: number; listed_fare_per_seat_pkr: number
  vehicles: { owner_name: string; vehicle_type: string } | null
}
interface MyFareOffer {
  id: string; trip_offer_id: string; seats_requested: number; proposed_fare_per_seat_pkr: number; counter_fare_per_seat_pkr: number | null; status: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface MyTripBooking {
  id: string; seats: number; total_amount_pkr: number; status: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; travel_date: string } | null
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function TripsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [offers, setOffers] = useState<TripOffer[]>([])
  const [myOffers, setMyOffers] = useState<MyFareOffer[]>([])
  const [myBookings, setMyBookings] = useState<MyTripBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [proposing, setProposing] = useState<string | null>(null)
  const [seatsForm, setSeatsForm] = useState<Record<string, number>>({})
  const [fareForm, setFareForm] = useState<Record<string, number>>({})
  const [actionId, setActionId] = useState<string | null>(null)

  const reload = async () => {
    const [{ data: o }, { data: mo }, { data: mb }] = await Promise.all([
      supabase.from('vehicle_trip_offers').select('*, vehicles(owner_name, vehicle_type)').eq('status', 'open').order('travel_date'),
      supabase.from('vehicle_trip_fare_offers').select('id, trip_offer_id, seats_requested, proposed_fare_per_seat_pkr, counter_fare_per_seat_pkr, status, vehicle_trip_offers(origin, origin_ur, destination, destination_ur)')
        .in('status', ['pending', 'countered']).order('created_at', { ascending: false }),
      supabase.from('vehicle_trip_bookings').select('id, seats, total_amount_pkr, status, vehicle_trip_offers(origin, origin_ur, destination, destination_ur, travel_date)')
        .order('created_at', { ascending: false }).limit(20),
    ])
    setOffers(((o ?? []) as unknown as TripOffer[]).filter((x) => new Date(x.travel_date) >= new Date(new Date().toDateString())))
    setMyOffers((mo ?? []) as unknown as MyFareOffer[])
    setMyBookings((mb ?? []) as unknown as MyTripBooking[])
    setLoading(false)
  }
  useEffect(() => { if (user) reload() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const propose = async (tripId: string) => {
    const seats = seatsForm[tripId] ?? 1
    const fare = fareForm[tripId]
    if (!fare || fare <= 0) { toast.error(t('cm.enterFareOffer')); return }
    setProposing(tripId)
    const { error } = await supabase.rpc('propose_trip_fare', { p_trip_offer_id: tripId, p_seats_requested: seats, p_proposed_fare_per_seat_pkr: fare })
    setProposing(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.fareOfferSentToast'))
    reload()
  }

  const acceptCounter = async (fareOfferId: string) => {
    setActionId(fareOfferId)
    const { error } = await supabase.rpc('accept_trip_fare_counter', { p_fare_offer_id: fareOfferId })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.fareAcceptedToast'))
    reload()
  }
  const withdraw = async (fareOfferId: string) => {
    setActionId(fareOfferId)
    const { error } = await supabase.rpc('withdraw_trip_fare_offer', { p_fare_offer_id: fareOfferId })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    reload()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/marketplace" className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13.5px] font-semibold hover:underline mb-4">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}
      </Link>
      <h1 className="font-heading text-[24px] font-bold text-dp-primary mb-1">{t('cm.tripsPageTitle')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('cm.tripsPageSubtitle')}</p>

      {(myOffers.length > 0 || myBookings.length > 0) && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.myFareOffersHeading')}</p>
          <div className="space-y-2">
            {myOffers.map((fo) => (
              <div key={fo.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{fo.vehicle_trip_offers ? `${isUrdu && fo.vehicle_trip_offers.origin_ur ? fo.vehicle_trip_offers.origin_ur : fo.vehicle_trip_offers.origin} → ${isUrdu && fo.vehicle_trip_offers.destination_ur ? fo.vehicle_trip_offers.destination_ur : fo.vehicle_trip_offers.destination}` : '—'}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{t('cm.yourOffer')} {fmt(fo.proposed_fare_per_seat_pkr)}/{t('mk.seatsLabel')} × <span className="ltr-num">{fo.seats_requested}</span></p>
                {fo.status === 'pending' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold mt-1"><Clock size={11} /> {t('cm.awaitingDriverStatus')}</span>}
                {fo.status === 'countered' && (
                  <div className="mt-2 pt-2 border-t border-dp-outline-variant/60">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">{t('cm.driverCountered')} <span className="font-bold text-dp-secondary">{fmt(fo.counter_fare_per_seat_pkr ?? 0)}</span>/{t('mk.seatsLabel')}</p>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <button onClick={() => withdraw(fo.id)} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('cm.declineBtn')}</button>
                      <button onClick={() => acceptCounter(fo.id)} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.acceptBtn')}</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {myBookings.map((tb) => (
              <div key={tb.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{tb.vehicle_trip_offers ? `${isUrdu && tb.vehicle_trip_offers.origin_ur ? tb.vehicle_trip_offers.origin_ur : tb.vehicle_trip_offers.origin} → ${isUrdu && tb.vehicle_trip_offers.destination_ur ? tb.vehicle_trip_offers.destination_ur : tb.vehicle_trip_offers.destination}` : '—'}</p>
                  <p className="font-sans text-[13.5px] font-bold text-dp-secondary">{fmt(tb.total_amount_pkr)}</p>
                </div>
                <div className="flex items-center justify-between gap-2 mt-1.5">
                  {tb.status === 'completed' ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('cm.tripCompletedStatus')}</span>
                  ) : tb.status === 'confirmed' ? (
                    <Link href={`/portal/marketplace/trip/${tb.id}`} className="inline-flex items-center gap-1 text-dp-secondary text-[12px] font-semibold hover:underline"><Navigation size={12} /> {t('cm.trackLocationBtn')}</Link>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold"><XCircle size={11} /> {tb.status}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.openTripsHeading')}</p>
        {offers.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('cm.noOpenTrips')}</p>}
        <div className="space-y-3">
          {offers.map((o) => (
            <div key={o.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-sans text-[14.5px] font-bold text-dp-on-surface flex items-center gap-1.5">
                  <MapPin size={14} className="text-dp-secondary shrink-0" /> {isUrdu && o.origin_ur ? o.origin_ur : o.origin} → {isUrdu && o.destination_ur ? o.destination_ur : o.destination}
                </p>
                <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${o.trip_type === 'return' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>{o.trip_type === 'return' ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}</span>
              </div>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{o.vehicles?.owner_name} · {o.vehicles?.vehicle_type} · {new Date(o.travel_date).toLocaleDateString('en-GB')}{o.departure_time_estimate ? ` · ${o.departure_time_estimate.slice(0, 5)}` : ''}</p>
              <p className="font-sans text-[13.5px] font-bold text-dp-secondary mt-1">{fmt(o.listed_fare_per_seat_pkr)} <span className="font-normal text-dp-on-surface-variant text-[11.5px]">{t('cm.askingPerSeat')}</span> · <span className="font-normal text-dp-on-surface-variant text-[11.5px] ltr-num">{o.seats_available} {t('mk.seatsLabel')}</span></p>

              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-dp-outline-variant/60">
                <input type="number" min={1} max={o.seats_available} value={seatsForm[o.id] ?? 1} onChange={(e) => setSeatsForm({ ...seatsForm, [o.id]: +e.target.value })} className="input-field w-16 !py-2 !text-[13px]" />
                <input type="number" value={fareForm[o.id] ?? ''} onChange={(e) => setFareForm({ ...fareForm, [o.id]: +e.target.value })} placeholder={t('cm.yourFareOfferPlaceholder')} className="input-field flex-1 !py-2 !text-[13px]" />
                <button onClick={() => propose(o.id)} disabled={proposing === o.id} className="shrink-0 px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('cm.proposeFareBtn')}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
