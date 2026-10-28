'use client'

// Unified destination-search results screen (Phase 1 of the vehicle-
// marketplace rebuild, 2026-10-19). Real ask: "if there is any adda
// vehical is going to the same destination then the adda vehicals will
// be display under it... and if there is any shared car going to that
// destination then the car will be display and then there will be full
// booking cataogry... vehical catagory wise like any professional app."
//
// Two sections, in that fixed order:
// 1. Adda vans going here — vehicle_trip_offers rows spawned by an adda
//    check-in (migration 415: every check-in gets a real trip offer),
//    tagged source='adda' by browse_open_trip_offers (698).
// 2. Shared rides going here — freeform one-off trip offers
//    (source='shared') plus the fixed weekly Routes, each badged so a
//    rider can tell a one-off trip from a standing weekly route.
//
// A third "browse by vehicle type" grid (hourly/shadi/rental/machinery/
// tractor/loader) used to repeat here too — real ask, 2026-10-26: "no
// need to display the catagories again when we have all the catagories
// running at the top." Removed; the home page's own auto-scrolling
// category belt is the one place that list lives now.
//
// Booking itself reuses the exact same RPC (book_trip_offer, with its
// one-way/return half-price split) the Shared Ride screen already has
// — no second booking path, no second source of truth for fare/seats.

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Bus, Users, Car, Clock, Star, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { fetchRoadRoute } from '@/lib/roadRoute'
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface TripRow {
  id: string; vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; avg_rating: number | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; departure_time_estimate: string | null
  seats_available: number; listed_fare_per_seat_pkr: number; trip_type: string
  source: 'adda' | 'shared'; adda_name: string | null; adda_name_ur: string | null; queue_position: number | null
  outbound_open: boolean; return_seats_available: number | null; outbound_arrived_at: string | null
}
interface RouteRow {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_per_seat_pkr: number; vehicle_id: string; owner_name: string
}
interface VehicleCategory { id: string; key: string; name: string; name_ur: string | null; emoji: string; base_fare_pkr: number; per_km_pkr: number; category_group: 'passenger' | 'equipment' }
// Real ask, 2026-10-28: "it should need to replace with the cars,
// bikes, machinery, loading etc so when user will select the cars so
// only all kind of cars and SUVs etc will appear and not machines and
// loading" — the flat category grid used to mix passenger types (car
// tiers, bike, rickshaw, van) with goods/equipment types (tractor,
// loader, machinery) with no way to tell them apart. category_group
// (756) now drives a real Travel/Machinery split instead of a frontend
// guess. Equipment categories don't go through the point-to-point
// ride-dispatch sheet at all — they already have their own dedicated
// site-based booking pages, same ones the home belt links to.
const EQUIPMENT_HREF: Record<string, string> = { tractor: '/portal/marketplace/tractor', loader: '/portal/marketplace/loader', machinery: '/portal/marketplace/machinery' }
// Real ask, 2026-10-28: the tiered cascade (751) — own village online-
// in-city (one-way) vs own village active-but-not-nearby (two-way) vs
// a neighbouring tenant's fleet (via marketplace_share_agreements) vs,
// if truly nothing anywhere, falling back to a different vehicle TYPE
// from the rider's own village. Who actually gets notified and what
// fare gets charged are decoupled — this quote is only ever a preview.
interface RideQuote {
  online_in_city: number; active_total: number; base_fare_pkr: number; village_detour_pkr: number; total_with_village_pkr: number
  cross_tenant: { tenant_id: string; tenant_name: string; active_count: number; detour_pkr: number } | null
}
interface DispatchRequest { id: string; status: string; fare_pkr: number; tier_used: string | null; matched_tenant_name: string | null; trip_offer_id: string | null }
interface CategoryOption { id: string; name: string; name_ur: string | null; emoji: string; fare_pkr: number; active_count: number }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

function fmtTime(t: string | null, isUrdu: boolean) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const hour12 = h % 12 === 0 ? 12 : h % 12
  const suffix = isUrdu ? (h < 12 ? 'صبح' : h < 17 ? 'دوپہر' : 'شام') : (h < 12 ? 'AM' : 'PM')
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`
}

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
  const [vehicleView, setVehicleView] = useState<'passenger' | 'equipment'>('passenger')

  // Real ask, 2026-10-27: "no regular rides are listed like catagory
  // wise list... when user will chose one catagory then the request
  // will go to all the catagory drivers" — Adda/Shared above only ever
  // show a SPECIFIC driver's already-posted offer. This is the third,
  // original option this page's own header comment always named but
  // never actually built: pick a vehicle category, see its real rate
  // card for this exact distance, and broadcast to every online driver
  // of that category (create_ride_dispatch_request, 746).
  const [pickup, setPickup] = useState<PickedLocation | null>(
    fromLat && fromLng ? { lat: Number(fromLat), lng: Number(fromLng), label: fromName ?? '' } : null
  )
  const [showPickupPicker, setShowPickupPicker] = useState(false)
  const [categories, setCategories] = useState<VehicleCategory[]>([])
  const [distanceKm, setDistanceKm] = useState<number | null>(null)

  // Real ask, 2026-10-28: "when i send the request of the ride to a car
  // then its navigated to a page rather then a popup style window...
  // atleast we should try to match it according to a native app" —
  // the whole create→wait→accepted flow now lives in one bottom sheet,
  // never a route change. Closing it before a driver accepts cancels
  // the request outright (cancel_ride_dispatch_request) rather than
  // leaving an abandoned 'open' row behind — on top of the 20-minute
  // auto-expiry cron (748), this is the deliberate-exit path.
  const [sheetCategory, setSheetCategory] = useState<VehicleCategory | null>(null)
  const [quote, setQuote] = useState<RideQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [activeRequest, setActiveRequest] = useState<DispatchRequest | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [fallbackOptions, setFallbackOptions] = useState<CategoryOption[] | null>(null)
  const [loadingFallback, setLoadingFallback] = useState(false)
  const [selectedFallback, setSelectedFallback] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase.from('vehicle_categories').select('id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, category_group').eq('is_active', true).order('display_order').then(({ data }) => setCategories((data ?? []) as VehicleCategory[]))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pickup || !city?.lat || !city?.lng) { setDistanceKm(null); return }
    fetchRoadRoute(pickup, { lat: city.lat, lng: city.lng }).then((r) => setDistanceKm(r.distanceKm)).catch(() => setDistanceKm(null))
  }, [pickup, city?.lat, city?.lng])

  const openCategorySheet = async (c: VehicleCategory) => {
    if (!pickup || distanceKm == null) return
    setSheetCategory(c)
    setQuote(null)
    setActiveRequest(null)
    setBookingId(null)
    setQuoting(true)
    const { data, error } = await supabase.rpc('ride_dispatch_quote', { p_category_id: c.id, p_pickup_lat: pickup.lat, p_pickup_lng: pickup.lng, p_distance_km: distanceKm })
    setQuoting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); setSheetCategory(null); return }
    setQuote(data as RideQuote)
  }

  const sendRequest = async (categoryIds?: string[]) => {
    if (!pickup || !city || !sheetCategory || distanceKm == null) return
    setRequesting(true)
    const { data, error } = await supabase.rpc('create_ride_dispatch_request', {
      p_category_id: sheetCategory.id, p_pickup_label: pickup.label || t('mb.fromPlaceholder'), p_pickup_lat: pickup.lat, p_pickup_lng: pickup.lng,
      p_dropoff_label: isUrdu && city.name_ur ? city.name_ur : city.name, p_dropoff_lat: city.lat, p_dropoff_lng: city.lng, p_distance_km: distanceKm,
      p_category_ids: categoryIds && categoryIds.length > 0 ? categoryIds : null,
      p_include_cross_tenant: true,
    })
    setRequesting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setActiveRequest({ id: data as string, status: 'open', fare_pkr: 0, tier_used: null, matched_tenant_name: null, trip_offer_id: null })
  }

  // The last resort: own village has nothing (not even the two-way
  // fallback) AND no neighbouring tenant does either — offer a
  // different vehicle TYPE from the rider's own village instead.
  useEffect(() => {
    if (!quote || !sheetCategory || distanceKm == null || quote.online_in_city > 0 || quote.active_total > 0 || quote.cross_tenant) {
      setFallbackOptions(null); setSelectedFallback(new Set())
      return
    }
    setLoadingFallback(true)
    supabase.rpc('ride_dispatch_category_options', { p_exclude_category_id: sheetCategory.id, p_distance_km: distanceKm })
      .then(({ data }) => { setFallbackOptions((data ?? []) as CategoryOption[]); setLoadingFallback(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, sheetCategory?.id, distanceKm])

  const toggleFallback = (id: string) => setSelectedFallback((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  useRealtimeRefresh(
    'ride_dispatch_requests',
    activeRequest?.status === 'open' ? activeRequest.id : null,
    () => { supabase.rpc('ride_dispatch_request_detail', { p_request_id: activeRequest!.id }).then(({ data }) => { if (data) setActiveRequest(data as DispatchRequest) }) },
    15000
  )

  useEffect(() => {
    if (activeRequest?.status !== 'accepted' || !activeRequest.trip_offer_id) return
    supabase.from('vehicle_trip_bookings').select('id').eq('trip_offer_id', activeRequest.trip_offer_id).maybeSingle()
      .then(({ data }) => { if (data) setBookingId(data.id) })
  }, [activeRequest?.status, activeRequest?.trip_offer_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeSheet = async () => {
    if (activeRequest?.status === 'open') {
      if (!window.confirm(t('mb.confirmCancelRideRequest'))) return
      await supabase.rpc('cancel_ride_dispatch_request', { p_request_id: activeRequest.id })
    }
    setSheetCategory(null); setQuote(null); setActiveRequest(null); setBookingId(null)
    setFallbackOptions(null); setSelectedFallback(new Set())
  }

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

  // Same standalone one-way return booking as the Shared Ride screen —
  // see its own comment (shared/page.tsx) for the full context.
  async function bookReturnOnly(trip: TripRow) {
    setBusyId(trip.id)
    const { error } = await supabase.rpc('book_trip_return_only_seat', { p_trip_offer_id: trip.id })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.tripBookedToast'))
    if (city) reload(city)
  }

  const nm = (en: string, ur: string | null) => (isUrdu && ur ? ur : en)

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  if (showPickupPicker) {
    return (
      <LocationPickerSheet
        title={t('mb.fromPlaceholder')}
        initial={pickup}
        defaultCenter={city?.lat && city?.lng ? [city.lat, city.lng] : undefined}
        onClose={() => setShowPickupPicker(false)}
        onConfirm={(loc) => { setPickup(loc); setShowPickupPicker(false) }}
      />
    )
  }

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

          {/* Adda vans going here — only shown when there actually is one */}
          {addaTrips.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] font-extrabold text-[#1e293b] flex items-center gap-1.5"><Bus size={14} className="text-[#166534]" /> {t('mb.addaGoingHereHeading')}</p>
              {addaTrips.map((trip) => (
                <TripCard key={trip.id} trip={trip} busy={busyId === trip.id} onBook={bookTrip} onBookReturnOnly={bookReturnOnly} nm={nm} t={t} isUrdu={isUrdu} />
              ))}
            </div>
          )}

          {/* Shared rides going here (one-off trips + weekly routes) — only shown when there's at least one */}
          {(sharedTrips.length > 0 || routes.length > 0) && (
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] font-extrabold text-[#1e293b] flex items-center gap-1.5"><Users size={14} className="text-[#0369a1]" /> {t('mb.sharedGoingHereHeading')}</p>
              {sharedTrips.map((trip) => (
                <TripCard key={trip.id} trip={trip} busy={busyId === trip.id} onBook={bookTrip} onBookReturnOnly={bookReturnOnly} nm={nm} t={t} isUrdu={isUrdu} />
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
            </div>
          )}

          <div className="border-t border-[#e5e2d0] pt-3 flex flex-col gap-2.5">
            <div>
              <p className="text-[13px] font-extrabold text-[#1e293b]">{t('mb.requestAnyDriverHeading')}</p>
              <p className="text-[11.5px] text-[#64748b] mt-0.5">{t('mb.requestAnyDriverHint')}</p>
            </div>

            <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-[#f2f1e8]">
              {([['passenger', t('mb.vehicleViewTravel')], ['equipment', t('mb.vehicleViewMachinery')]] as const).map(([key, label]) => {
                const on = vehicleView === key
                return (
                  <button key={key} onClick={() => setVehicleView(key)}
                    className="rounded-[9px] py-1.5 text-[12.5px] font-bold cursor-pointer"
                    style={{ background: on ? '#166534' : 'transparent', color: on ? '#fff' : '#64748b', boxShadow: on ? '0 1px 2px rgba(0,0,0,.1)' : 'none' }}>
                    {label}
                  </button>
                )
              })}
            </div>

            {vehicleView === 'passenger' && !pickup ? (
              <button onClick={() => setShowPickupPicker(true)} className="w-full border border-dashed border-[#e5e2d0] rounded-xl py-2.5 text-[12.5px] font-semibold text-[#166534] cursor-pointer">
                {t('mb.setPickupToSeeRatesBtn')}
              </button>
            ) : vehicleView === 'passenger' ? (
              <>
                <button onClick={() => setShowPickupPicker(true)} className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#64748b] cursor-pointer w-fit">
                  📍 {pickup!.label || t('mb.fromPlaceholder')} · <span className="text-[#166534] underline">{t('action.edit')}</span>
                </button>
                {distanceKm == null ? (
                  <div className="flex justify-center py-4"><Loader2 size={18} className="animate-spin text-[#166534]" /></div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {categories.filter((c) => c.category_group === 'passenger').map((c) => {
                      const fare = Math.round(c.base_fare_pkr + c.per_km_pkr * distanceKm)
                      return (
                        <button key={c.id} onClick={() => openCategorySheet(c)}
                          className="flex flex-col items-start gap-1 bg-white border border-[#e5e2d0] rounded-2xl p-3 text-start cursor-pointer hover:border-[#166534]">
                          <span className="text-[20px]">{c.emoji}</span>
                          <span className="text-[12.5px] font-bold text-[#1e293b]">{isUrdu && c.name_ur ? c.name_ur : c.name}</span>
                          <span className="font-extrabold text-[15px] text-[#166534] ltr-num">{fmt(fare)}</span>
                          <span className="text-[10px] text-[#94a3b8] ltr-num">{distanceKm.toFixed(1)} km</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {categories.filter((c) => c.category_group === 'equipment').map((c) => (
                  <Link key={c.id} href={EQUIPMENT_HREF[c.key] ?? '/portal/marketplace'}
                    className="flex flex-col items-start gap-1 bg-white border border-[#e5e2d0] rounded-2xl p-3 text-start cursor-pointer hover:border-[#166534]">
                    <span className="text-[20px]">{c.emoji}</span>
                    <span className="text-[12.5px] font-bold text-[#1e293b]">{isUrdu && c.name_ur ? c.name_ur : c.name}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

        </>
      )}

      {sheetCategory && (
        <MobilityBottomSheet
          title={`${sheetCategory.emoji} ${isUrdu && sheetCategory.name_ur ? sheetCategory.name_ur : sheetCategory.name}`}
          onClose={closeSheet}
          // Real ask, 2026-10-28: "when there is no driver around is too
          // small it should be display on half or 75% of the screen" —
          // only the no-immediate-driver states (village/cross-village/
          // pick-another-type) get the taller floor; the plain "N online,
          // tap to send" case stays its natural compact size.
          minHeight={!activeRequest && quote && quote.online_in_city === 0 ? '60vh' : undefined}
        >
          {quoting ? (
            <div className="flex justify-center py-8"><Loader2 size={22} className="animate-spin text-[#166534]" /></div>
          ) : !activeRequest ? (
            quote && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between bg-[#F9F9F6] rounded-xl p-3">
                  <span className="text-[12.5px] text-[#64748b]">{t('mb.fareForTripLabel')}</span>
                  <span className="font-extrabold text-[18px] text-[#166534] ltr-num">{fmt(quote.base_fare_pkr)}</span>
                </div>

                {quote.online_in_city > 0 ? (
                  <>
                    <p className="text-[12px] text-[#166534] font-semibold flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#166534] animate-pulse" /> {t('mb.driversOnlineNote').replace('{n}', String(quote.online_in_city))}
                    </p>
                    <button onClick={() => sendRequest()} disabled={requesting} className="w-full bg-[#166534] text-white rounded-xl py-3 font-bold text-[14px] cursor-pointer disabled:opacity-50">
                      {requesting ? t('action.saving') : t('mb.sendRideRequestBtn').replace('{price}', fmt(quote.base_fare_pkr))}
                    </button>
                  </>
                ) : quote.active_total > 0 ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex flex-col gap-2">
                    <p className="text-[12.5px] font-bold text-amber-800">{t('mb.noDriverHereNote')}</p>
                    <p className="text-[12px] text-amber-800">{t('mb.askVillageDriverNote')}</p>
                    <div className="flex flex-col gap-1 text-[12px] bg-white rounded-lg p-2.5">
                      <div className="flex justify-between"><span className="text-[#64748b]">{t('mb.tripFareLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(quote.base_fare_pkr)}</span></div>
                      <div className="flex justify-between"><span className="text-[#64748b]">{t('mb.villageDetourFeeLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(quote.village_detour_pkr)}</span></div>
                      <div className="flex justify-between font-bold pt-1 border-t border-[#f1f5f9]"><span className="text-[#1e293b]">{t('vp.totalLabel')}</span><span className="ltr-num text-[#166534]">{fmt(quote.total_with_village_pkr)}</span></div>
                    </div>
                    <button onClick={() => sendRequest()} disabled={requesting} className="w-full bg-[#166534] text-white rounded-xl py-3 font-bold text-[14px] cursor-pointer disabled:opacity-50">
                      {requesting ? t('action.saving') : t('mb.callVillageDriverBtn').replace('{price}', fmt(quote.total_with_village_pkr))}
                    </button>
                  </div>
                ) : quote.cross_tenant ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex flex-col gap-2">
                    <p className="text-[12.5px] font-bold text-amber-800">
                      {t('mb.crossVillageAvailableNote')
                        .replace('{type}', isUrdu && sheetCategory?.name_ur ? sheetCategory.name_ur : sheetCategory?.name ?? '')
                        .replace('{n}', String(quote.cross_tenant.active_count))
                        .replace('{village}', quote.cross_tenant.tenant_name)}
                    </p>
                    <div className="flex flex-col gap-1 text-[12px] bg-white rounded-lg p-2.5">
                      <div className="flex justify-between"><span className="text-[#64748b]">{t('mb.tripFareLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(quote.base_fare_pkr)}</span></div>
                      <div className="flex justify-between"><span className="text-[#64748b]">{t('mb.villageDetourFeeLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(quote.cross_tenant.detour_pkr)}</span></div>
                      <div className="flex justify-between font-bold pt-1 border-t border-[#f1f5f9]"><span className="text-[#1e293b]">{t('vp.totalLabel')}</span><span className="ltr-num text-[#166534]">{fmt(quote.base_fare_pkr + quote.cross_tenant.detour_pkr)}</span></div>
                    </div>
                    <button onClick={() => sendRequest()} disabled={requesting} className="w-full bg-[#166534] text-white rounded-xl py-3 font-bold text-[14px] cursor-pointer disabled:opacity-50">
                      {requesting ? t('action.saving') : t('mb.callNearbyVillageBtn').replace('{village}', quote.cross_tenant.tenant_name).replace('{price}', fmt(quote.base_fare_pkr + quote.cross_tenant.detour_pkr))}
                    </button>
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex flex-col gap-2.5">
                    <p className="text-[12.5px] font-bold text-amber-800">
                      {t('mb.noDriverAnywhereNote').replace('{type}', isUrdu && sheetCategory?.name_ur ? sheetCategory.name_ur : sheetCategory?.name ?? '')}
                    </p>
                    {loadingFallback ? (
                      <div className="flex justify-center py-3"><Loader2 size={18} className="animate-spin text-amber-700" /></div>
                    ) : (fallbackOptions ?? []).length === 0 ? (
                      <p className="text-[12px] text-amber-800">{t('mb.rideRequestCancelledNote')}</p>
                    ) : (
                      <>
                        <div className="flex flex-col gap-1.5">
                          {fallbackOptions!.map((c) => {
                            const checked = selectedFallback.has(c.id)
                            return (
                              <label key={c.id} className="flex items-center gap-2.5 bg-white rounded-lg p-2.5 cursor-pointer border" style={{ borderColor: checked ? '#166534' : '#f1f5f9' }}>
                                <input type="checkbox" checked={checked} onChange={() => toggleFallback(c.id)} className="accent-[#166534] cursor-pointer" />
                                <span className="text-[17px]">{c.emoji}</span>
                                <span className="flex-1 text-[12.5px] font-semibold text-[#1e293b]">{isUrdu && c.name_ur ? c.name_ur : c.name}</span>
                                <span className="text-[13px] font-extrabold text-[#166534] ltr-num">{fmt(c.fare_pkr)}</span>
                              </label>
                            )
                          })}
                        </div>
                        <button onClick={() => sendRequest(Array.from(selectedFallback))} disabled={requesting || selectedFallback.size === 0}
                          className="w-full bg-[#166534] text-white rounded-xl py-3 font-bold text-[14px] cursor-pointer disabled:opacity-50">
                          {requesting ? t('action.saving') : t('mb.sendToSelectedBtn').replace('{n}', String(selectedFallback.size))}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          ) : activeRequest.status === 'open' ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <Loader2 size={26} className="animate-spin text-[#166534]" />
              <p className="font-bold text-[14px] text-[#1e293b]">{t('mb.waitingForDriverHeading')}</p>
              <p className="text-[12.5px] text-[#64748b]">{t('mb.waitingForDriverHint')}</p>
            </div>
          ) : activeRequest.status === 'accepted' ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <span className="text-[28px]">✅</span>
              <p className="font-bold text-[14px] text-[#166534]">{t('mb.rideAcceptedHeading')}</p>
              {activeRequest.tier_used?.startsWith('cross_tenant') && activeRequest.matched_tenant_name && (
                <p className="text-[12px] text-[#64748b]">{t('mb.acceptedFromVillageNote').replace('{village}', activeRequest.matched_tenant_name)}</p>
              )}
              <p className="font-extrabold text-[16px] text-[#166534] ltr-num">{fmt(activeRequest.fare_pkr)}</p>
              {bookingId && (
                <Link href={`/portal/marketplace/trip/${bookingId}`} onClick={closeSheet} className="mt-1 px-4 py-2 bg-[#166534] text-white rounded-xl text-[13px] font-bold">
                  {t('cm.trackLocationBtn')}
                </Link>
              )}
            </div>
          ) : (
            <p className="text-center text-[12.5px] text-[#64748b] py-6">{t('mb.rideRequestCancelledNote')}</p>
          )}
        </MobilityBottomSheet>
      )}
    </div>
  )
}

function TripCard({ trip, busy, onBook, onBookReturnOnly, nm, t, isUrdu }: {
  trip: TripRow; busy: boolean; onBook: (trip: TripRow, leg: 'oneway' | 'return') => void
  onBookReturnOnly: (trip: TripRow) => void
  nm: (en: string, ur: string | null) => string; t: (k: string) => string; isUrdu: boolean
}) {
  const ok = trip.seats_available >= 1
  const depTime = fmtTime(trip.departure_time_estimate, isUrdu)
  const isReturn = trip.trip_type === 'return'
  const onewayFare = isReturn ? Math.round(trip.listed_fare_per_seat_pkr / 2) : trip.listed_fare_per_seat_pkr
  const isAdda = trip.source === 'adda'
  return (
    <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3 space-y-2">
      {/* Real ask, 2026-10-21: "check what the screen displays when both
          destinations have been selected... add that layout" — the
          reference puts the price first and biggest, with the vehicle
          type + a tinted icon on the other side, instead of owner/
          vehicle details first and the price as an afterthought on the
          right. Booking logic/RPCs below are untouched — this is the
          same card, same data, rearranged to match. */}
      <div className="flex items-start justify-between gap-2">
        <div className="shrink-0">
          <p className="font-sans text-[18px] font-extrabold text-[#166534] ltr-num leading-none">{fmt(onewayFare)}</p>
          <p className="text-[10.5px] text-[#64748b] mt-1">{t('vp.perSeatLabel')}</p>
          {isReturn && <p className="text-[9.5px] text-[#64748b] ltr-num mt-0.5">{t('vp.returnFareLabel')} {fmt(trip.listed_fare_per_seat_pkr)}</p>}
        </div>
        <div className="flex items-start gap-2 text-end">
          <div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              <p className="font-sans text-[12.5px] font-extrabold text-[#1e293b]">{trip.owner_name}</p>
              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${isReturn ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>
                {isReturn ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}
              </span>
            </div>
            <p className="text-[10.5px] text-[#64748b]">
              {trip.vehicle_type}{trip.vehicle_number ? ` · ${trip.vehicle_number}` : ''}
              {trip.avg_rating != null && <> · <Star size={9} className="inline -mt-0.5 fill-amber-400 text-amber-400" /> {trip.avg_rating}</>}
            </p>
            <p className="text-[10.5px] text-[#64748b]">{nm(trip.origin, trip.origin_ur)} → {nm(trip.destination, trip.destination_ur)}</p>
            {isAdda && trip.adda_name && (
              <p className="text-[10.5px] text-[#64748b]">{t('mb.svc.adda')} · {nm(trip.adda_name, trip.adda_name_ur)}{trip.queue_position ? ` · #${trip.queue_position}` : ''}</p>
            )}
            {depTime && (
              <p className="text-[10.5px] text-[#64748b] flex items-center gap-1 mt-0.5 justify-end"><Clock size={10} /> {t('vp.departureLabel')} <span className="ltr-num font-semibold text-[#1e293b]">{depTime}</span></p>
            )}
          </div>
          <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: isAdda ? '#dcfce7' : '#e0f2fe' }}>
            {isAdda ? <Bus size={16} className="text-[#166534]" /> : <Car size={16} className="text-[#0369a1]" />}
          </span>
        </div>
      </div>

      <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ltr-num ${trip.seats_available <= 1 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'}`}>
        <Users size={10} /> {t('vp.seatsLeftLabel').replace('{n}', String(trip.seats_available))}
      </span>

      {!trip.outbound_open && isReturn && (trip.return_seats_available ?? 0) > 0 ? (
        <>
          <p className="flex items-center gap-1.5 font-sans text-[11px] font-bold text-[#166534] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg px-2.5 py-1.5">
            🔄 {trip.outbound_arrived_at ? t('mv.atDestinationNote') : t('mv.returnSeatsOpenNote').replace('{n}', String(trip.return_seats_available))}
          </p>
          <button disabled={busy} onClick={() => onBookReturnOnly(trip)}
            className="w-full rounded-xl py-2 text-[11.5px] font-bold text-white cursor-pointer disabled:opacity-50 bg-[#166534] ltr-num">
            {t('mv.bookReturnSeatBtn')} — {fmt(Math.round(trip.listed_fare_per_seat_pkr / 2))}
          </button>
        </>
      ) : isReturn ? (
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
          className={`w-full rounded-xl py-2 text-[11.5px] font-bold cursor-pointer disabled:opacity-50 ltr-num ${isAdda && ok ? 'text-[#1e293b]' : 'text-white'}`}
          style={{ background: !ok ? '#94a3b8' : isAdda ? '#D4AF37' : '#166534' }}>
          {ok ? t('vp.bookAtListedPriceBtn').replace('{price}', fmt(trip.listed_fare_per_seat_pkr)) : t('vp.notEnoughSeats')}
        </button>
      )}
    </div>
  )
}
