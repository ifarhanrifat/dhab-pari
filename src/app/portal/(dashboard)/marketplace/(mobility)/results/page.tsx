'use client'

// Unified destination-search results screen (Phase 1 of the vehicle-
// marketplace rebuild, 2026-10-19). Real ask: "if there is any adda
// vehical is going to the same destination then the adda vehicals will
// be display under it... and if there is any shared car going to that
// destination then the car will be display and then there will be full
// booking cataogry... vehical catagory wise like any professional app."
//
// Three sections, in that fixed order:
// 1. Adda vans going here — vehicle_trip_offers rows spawned by an adda
//    check-in (migration 415: every check-in gets a real trip offer),
//    tagged source='adda' by browse_open_trip_offers (698).
// 2. Shared rides going here — freeform one-off trip offers
//    (source='shared') plus the fixed weekly Routes, each badged so a
//    rider can tell a one-off trip from a standing weekly route.
// 3. Browse by vehicle type — a plain grid into the existing
//    hourly/shadi/rental/machinery/tractor/loader screens; no booking
//    logic here, this phase doesn't touch those screens.
//
// Booking itself reuses the exact same RPC (book_trip_offer, with its
// one-way/return half-price split) the Shared Ride screen already has
// — no second booking path, no second source of truth for fare/seats.

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Bus, Users, Car, Clock, Star } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface TripRow {
  id: string; vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; avg_rating: number | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; departure_time_estimate: string | null
  seats_available: number; listed_fare_per_seat_pkr: number; trip_type: string
  source: 'adda' | 'shared'; adda_name: string | null; adda_name_ur: string | null; queue_position: number | null
}
interface RouteRow {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_per_seat_pkr: number; vehicle_id: string; owner_name: string
}

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

function fmtTime(t: string | null, isUrdu: boolean) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const hour12 = h % 12 === 0 ? 12 : h % 12
  const suffix = isUrdu ? (h < 12 ? 'صبح' : h < 17 ? 'دوپہر' : 'شام') : (h < 12 ? 'AM' : 'PM')
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`
}

// Phase 6: emoji converged onto the mockup's own service-belt taxonomy
// (💍 Wedding Fleet, 🚗 Car Rental, 🏗️ Machinery, 🚜 Tractor & Farm,
// 🚚 Loader — exact matches; hourly has no belt equivalent, 🕒 picked
// to match the Lucide Clock it replaces).
const CATEGORY_GRID = [
  { href: '/portal/marketplace/hourly', emoji: '🕒', titleKey: 'vp.hourlyPageTitle', bg: '#e0f2fe', fg: '#0369a1' },
  { href: '/portal/marketplace/shadi', emoji: '💍', titleKey: 'vp.shadiPageTitle', bg: '#fce7f3', fg: '#be185d' },
  { href: '/portal/marketplace/rental', emoji: '🚗', titleKey: 'vp.rentalPageTitle', bg: '#f3e8ff', fg: '#6d28d9' },
  { href: '/portal/marketplace/machinery', emoji: '🏗️', titleKey: 'vp.machineryPageTitle', bg: '#fef3c7', fg: '#92400e' },
  { href: '/portal/marketplace/tractor', emoji: '🚜', titleKey: 'vp.tractorPageTitle', bg: '#dcfce7', fg: '#166534' },
  { href: '/portal/marketplace/loader', emoji: '🚚', titleKey: 'vp.loaderPageTitle', bg: '#fee2e2', fg: '#b91c1c' },
] as const

export default function ResultsPage() {
  return (
    <Suspense fallback={<div className="text-center py-12"><LoadingDots /></div>}>
      <ResultsPageInner />
    </Suspense>
  )
}

function ResultsPageInner() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const searchParams = useSearchParams()
  const toId = searchParams.get('to')
  const fromLat = searchParams.get('from_lat')
  const fromLng = searchParams.get('from_lng')
  const fromName = searchParams.get('from_name')

  const [city, setCity] = useState<City | null>(null)
  const [tripOffers, setTripOffers] = useState<TripRow[]>([])
  const [routes, setRoutes] = useState<RouteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function reload(c: City) {
    const [{ data: trips, error: tripsErr }, { data: routeRows, error: routesErr }] = await Promise.all([
      supabase.rpc('browse_open_trip_offers', { p_city_key: c.name }),
      supabase.rpc('routes_to_destination', { p_city_name: c.name }),
    ])
    if (tripsErr) toast.error(friendlyError(tripsErr, undefined, isUrdu))
    if (routesErr) toast.error(friendlyError(routesErr, undefined, isUrdu))
    setTripOffers((trips as TripRow[]) || [])
    setRoutes((routeRows as RouteRow[]) || [])
  }

  useEffect(() => {
    if (!toId) { setLoading(false); return }
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('id', toId).maybeSingle().then(async ({ data: c }) => {
      setCity(c)
      if (c) await reload(c)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toId])

  async function bookTrip(trip: TripRow, leg: 'oneway' | 'return') {
    setBusyId(trip.id)
    const { error } = await supabase.rpc('book_trip_offer', { p_trip_offer_id: trip.id, p_seats_requested: 1, p_leg: leg })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.tripBookedToast'))
    if (city) reload(city)
  }

  const nm = (en: string, ur: string | null) => (isUrdu && ur ? ur : en)

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  const addaTrips = tripOffers.filter((o) => o.source === 'adda')
  const sharedTrips = tripOffers.filter((o) => o.source === 'shared')

  return (
    <div className="flex flex-col gap-3">
      <Link href="/portal/marketplace/travel" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#005A36]">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mb.navHome')}
      </Link>

      {!city ? (
        <p className="text-center py-10 text-[#64748b] text-[14px]">{t('mb.noDestinationYet')}</p>
      ) : (
        <>
          <div>
            <p className="font-bold text-[18px] text-[#005A36]">{isUrdu && city.name_ur ? city.name_ur : city.name}</p>
            <p className="text-[12px] text-[#64748b]">{t('mb.resultsHeading')}</p>
          </div>

          {(() => {
            const pins: LeafletPin[] = []
            if (fromLat && fromLng) pins.push({ lat: Number(fromLat), lng: Number(fromLng), label: fromName ?? undefined, color: '#005A36' })
            if (city.lat != null && city.lng != null) pins.push({ lat: city.lat, lng: city.lng, label: isUrdu && city.name_ur ? city.name_ur : city.name, color: '#D4AF37' })
            return pins.length > 0 ? <LeafletMap pins={pins} height={190} className="rounded-2xl" /> : null
          })()}

          <div className="bg-[#005A36] rounded-2xl p-3 flex flex-col gap-1">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-white/75">{t('mb.pricesAreEstimates')}</p>
          </div>

          {/* Section 1 — Adda vans going here */}
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-extrabold text-[#1e293b] flex items-center gap-1.5"><Bus size={14} className="text-[#166534]" /> {t('mb.addaGoingHereHeading')}</p>
            {addaTrips.length === 0 ? (
              <p className="text-[12px] text-[#94a3b8] py-1">{t('mb.noAddaGoingHere')}</p>
            ) : (
              addaTrips.map((trip) => (
                <TripCard key={trip.id} trip={trip} busy={busyId === trip.id} onBook={bookTrip} nm={nm} t={t} isUrdu={isUrdu} />
              ))
            )}
          </div>

          {/* Section 2 — Shared rides going here (one-off trips + weekly routes) */}
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-extrabold text-[#1e293b] flex items-center gap-1.5"><Users size={14} className="text-[#0369a1]" /> {t('mb.sharedGoingHereHeading')}</p>
            {sharedTrips.length === 0 && routes.length === 0 ? (
              <p className="text-[12px] text-[#94a3b8] py-1">{t('vp.noOpenTripsToCity')}</p>
            ) : (
              <>
                {sharedTrips.map((trip) => (
                  <TripCard key={trip.id} trip={trip} busy={busyId === trip.id} onBook={bookTrip} nm={nm} t={t} isUrdu={isUrdu} />
                ))}
                {routes.map((r) => (
                  <Link key={r.id} href={`/portal/marketplace/route/${r.id}`} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3">
                    <span className="shrink-0 w-9 h-9 rounded-xl bg-[#dcfce7] flex items-center justify-center"><Bus size={17} className="text-[#166534]" /></span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[13px] font-bold text-[#1e293b]">{nm(r.origin, r.origin_ur)} → {nm(r.destination, r.destination_ur)}</span>
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#dcfce7] text-[#166534]">{t('mb.weeklyRouteBadge')}</span>
                      </div>
                      <p className="text-[11px] text-[#64748b] mt-0.5">{r.owner_name}</p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="font-extrabold text-[14px] text-[#005A36]">{fmt(r.fare_per_seat_pkr)}</p>
                      <p className="text-[9px] text-[#64748b]">{t('mk.perSeat')}</p>
                    </div>
                  </Link>
                ))}
              </>
            )}
          </div>

          {/* Section 3 — Browse by vehicle type */}
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-extrabold text-[#1e293b]">{t('mb.categoryBrowseHeading')}</p>
            <div className="grid grid-cols-3 gap-2">
              {CATEGORY_GRID.map(({ href, emoji, titleKey, bg }) => (
                <Link key={href} href={href} className="flex flex-col items-center gap-1.5 p-3 rounded-2xl border border-[#e5e2d0] bg-white text-center">
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center text-[17px]" style={{ background: bg }}>{emoji}</span>
                  <span className="text-[10.5px] font-bold text-[#1e293b] leading-tight">{t(titleKey)}</span>
                </Link>
              ))}
            </div>
          </div>

          <Link href="/portal/marketplace/commute" className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3">
            <span className="shrink-0 w-9 h-9 rounded-xl bg-[#e0f2fe] flex items-center justify-center"><Users size={17} className="text-[#0369a1]" /></span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-[#1e293b]">{t('vp.commutePageTitle')}</p>
              <p className="text-[11px] text-[#64748b] mt-0.5">{t('vp.commuteCardHint')}</p>
            </div>
          </Link>

          <Link href="/portal/marketplace/order-city" className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3">
            <span className="shrink-0 w-9 h-9 rounded-xl bg-[#f3e8ff] flex items-center justify-center"><Car size={17} className="text-[#6d28d9]" /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[13px] font-bold text-[#1e293b]">{t('vp.dispatchPageTitle')}</p>
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#f3e8ff] text-[#6d28d9]">{t('mb.negotiableTag')}</span>
              </div>
              <p className="text-[11px] text-[#64748b] mt-0.5">{t('vp.orderCityCardHint')}</p>
            </div>
          </Link>
        </>
      )}
    </div>
  )
}

function TripCard({ trip, busy, onBook, nm, t, isUrdu }: {
  trip: TripRow; busy: boolean; onBook: (trip: TripRow, leg: 'oneway' | 'return') => void
  nm: (en: string, ur: string | null) => string; t: (k: string) => string; isUrdu: boolean
}) {
  const ok = trip.seats_available >= 1
  const depTime = fmtTime(trip.departure_time_estimate, isUrdu)
  const isReturn = trip.trip_type === 'return'
  const onewayFare = isReturn ? Math.round(trip.listed_fare_per_seat_pkr / 2) : trip.listed_fare_per_seat_pkr
  return (
    <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3 space-y-2">
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
          {trip.source === 'adda' && trip.adda_name && (
            <p className="text-[10.5px] text-[#64748b]">{t('mb.svc.adda')} · {nm(trip.adda_name, trip.adda_name_ur)}{trip.queue_position ? ` · #${trip.queue_position}` : ''}</p>
          )}
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
          <button disabled={!ok || busy} onClick={() => onBook(trip, 'oneway')}
            className="flex-1 rounded-xl py-2 text-[11px] font-bold text-white cursor-pointer disabled:opacity-50 ltr-num"
            style={{ background: ok ? '#166534' : '#94a3b8' }}>
            {ok ? t('vp.bookOneWayBtn').replace('{price}', fmt(onewayFare)) : t('vp.notEnoughSeats')}
          </button>
          <button disabled={!ok || busy} onClick={() => onBook(trip, 'return')}
            className="flex-1 rounded-xl py-2 text-[11px] font-bold cursor-pointer border border-[#166534] text-[#166534] disabled:opacity-50 ltr-num">
            {t('vp.bookReturnBtn').replace('{price}', fmt(trip.listed_fare_per_seat_pkr))}
          </button>
        </div>
      ) : (
        <button disabled={!ok || busy} onClick={() => onBook(trip, 'oneway')}
          className="w-full rounded-xl py-2 text-[11.5px] font-bold text-white cursor-pointer disabled:opacity-50 ltr-num"
          style={{ background: ok ? '#166534' : '#94a3b8' }}>
          {ok ? t('vp.bookAtListedPriceBtn').replace('{price}', fmt(trip.listed_fare_per_seat_pkr)) : t('vp.notEnoughSeats')}
        </button>
      )}
    </div>
  )
}
