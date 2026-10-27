'use client'

// Home screen of the new "Dhab Pari Mobility" design — rebuilt here
// (replacing the old marketplace/travel tile-list hub, not the
// top-level /marketplace two-pillar page, which stays untouched so
// Shops access isn't dropped).
//
// Real ask, 2026-10-21: "for the rider on the home page it will be a
// full map on which you will display all the features like start and
// destination, select go home, and then categories at the top, there
// is no need anything else on the home page." Rebuilt around that: a
// large, full-bleed map with the service-category belt floating over
// its top edge and the from/to search card floating over its bottom
// edge (the from/to picker sheets still expand inline inside that same
// card, unchanged) — the adda departure board and the routes list that
// used to fill the rest of this page are gone; both already have a
// real home of their own (the adda tile's own board, the route cards
// already reachable from results/shared).
//
// "Go Home" — confirmed with the user: find a ride BACK to the village
// today, reusing the standalone return-leg booking work (727/728/729)
// rather than inventing a second booking system. The rider says which
// city they're currently in; find_rides_home(city) returns today's
// routes/trip-offers whose return leg goes to this village with a free
// seat, booked at the full one-way fare (board_stop_id omitted —
// they're at the route's own far endpoint, not partway down a
// configured stop).

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { Search, Home as HomeIcon, Loader2, Briefcase } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityServiceTile } from '@/components/mobility/MobilityServiceTile'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { FindRideNearStopSheet } from '@/components/mobility/FindRideNearStopSheet'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'
import { SITE } from '@/lib/constants'

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface Adda { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface GoHomeResult {
  kind: 'route' | 'trip'; id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  approx_fare_pkr: number; seats_available: number; departure_time: string | null; travel_date: string
}

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

// Real ask, 2026-10-21: "catagories must be displaying above the map not
// on the map and must be running like news belt" — moved out of the
// absolute overlay on the map's top edge into its own row above it, and
// made it auto-scroll continuously. Driven by `scrollLeft` in a rAF loop
// rather than a CSS transform/keyframe animation — the exact same choice
// AnnouncementBar's own ticker made (see its header comment) after a
// transform marquee confirmed invisible on a real production Android
// WebView for a wide track; this belt is shorter, but there's no reason
// to risk the same class of bug twice when the proven approach is right
// here to reuse. Paused on touchstart/mouseenter so a rider can actually
// tap a tile instead of it sliding out from under their finger — plain
// text tickers elsewhere never needed that since nothing in them is
// clickable.
function useAutoScrollBelt(rtl: boolean) {
  // A plain useRef here would only ever get checked inside a mount-only
  // effect — and this page gates its whole return behind `if (loading)
  // return <LoadingDots/>` until the cities/addas fetch resolves, so the
  // belt's own div doesn't exist in the tree on that first render. The
  // effect would run once, see a null ref forever, and never start the
  // loop (confirmed live: the belt rendered correctly but sat
  // completely still). A callback ref + state re-runs the effect the
  // instant the real node mounts, whenever that actually happens.
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const pausedRef = useRef(false)

  // Same RTL gotcha AnnouncementBar's own ticker already chased down:
  // Chromium clamps scrollLeft to <= 0 on an RTL-direction container, so
  // the sign of the per-frame write has to match that — and the `dir`
  // this depends on is set explicitly on the container in the JSX below
  // (never left to ambient context), so `rtl` here is always right.
  useEffect(() => {
    if (!node) return
    const contentWidth = node.scrollWidth / 2
    if (contentWidth <= 0) return
    const negative = rtl
    const PIXELS_PER_SECOND = 28
    let pos = 0
    let raf = 0
    let last = performance.now()
    function step(now: number) {
      const dt = (now - last) / 1000
      last = now
      if (!pausedRef.current) {
        pos = (pos + PIXELS_PER_SECOND * dt) % contentWidth
        node!.scrollLeft = negative ? -pos : pos
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [node, rtl])

  useEffect(() => {
    if (!node) return
    const pause = () => { pausedRef.current = true }
    const resume = () => { pausedRef.current = false }
    node.addEventListener('mouseenter', pause)
    node.addEventListener('mouseleave', resume)
    node.addEventListener('touchstart', pause, { passive: true })
    node.addEventListener('touchend', resume)
    return () => {
      node.removeEventListener('mouseenter', pause)
      node.removeEventListener('mouseleave', resume)
      node.removeEventListener('touchstart', pause)
      node.removeEventListener('touchend', resume)
    }
  }, [node])

  return setNode
}

const SERVICES = [
  { key: 'adda', emoji: '🚐', tint: '#dcfce7', href: '/portal/marketplace/adda' },
  { key: 'shared', emoji: '👥', tint: '#e0f2fe', href: '/portal/marketplace/shared' },
  { key: 'rental', emoji: '🚗', tint: '#f3e8ff', href: '/portal/marketplace/rental' },
  { key: 'purchase', emoji: '🛍️', tint: '#ffe4e6', href: '/portal/marketplace/city-purchase' },
  { key: 'parcel', emoji: '📦', tint: '#fef3c7', href: '/portal/marketplace/parcel' },
  { key: 'hourly', emoji: '⏱️', tint: '#e0e7ff', href: '/portal/marketplace/hourly' },
  { key: 'tractor', emoji: '🚜', tint: '#d1fae5', href: '/portal/marketplace/tractor' },
  { key: 'machine', emoji: '🏗️', tint: '#fde68a', href: '/portal/marketplace/machinery' },
  { key: 'wedding', emoji: '💍', tint: '#fce7f3', href: '/portal/marketplace/shadi' },
  { key: 'loading', emoji: '🚚', tint: '#ffedd5', href: '/portal/marketplace/loader' },
] as const

export default function MobilityHomePage() {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const supabase = createClient()
  const beltRef = useAutoScrollBelt(isUrdu)

  const [cities, setCities] = useState<City[]>([])
  const [origin, setOrigin] = useState<{ lat: number; lng: number; name: string; id: string } | null>(null)
  const [toCity, setToCity] = useState<City | null>(null)
  const [loading, setLoading] = useState(true)
  const [destPin, setDestPin] = useState<PickedLocation | null>(null)
  const [showOriginPicker, setShowOriginPicker] = useState(false)
  const [showDestPicker, setShowDestPicker] = useState(false)
  const [showNearStop, setShowNearStop] = useState(false)

  // "Go Home" — a separate small flow inside the same card: pick which
  // city you're currently in, see today's return-leg seats going back
  // to the village, book one directly from here.
  const [showGoHome, setShowGoHome] = useState(false)
  const [goHomeCity, setGoHomeCity] = useState<City | null>(null)
  const [goHomeLoading, setGoHomeLoading] = useState(false)
  const [goHomeResults, setGoHomeResults] = useState<GoHomeResult[] | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
    supabase.from('addas').select('id, name, name_ur, lat, lng').eq('is_active', true).order('name').then(({ data }) => {
      const main: Adda | null = data?.[0] ?? null
      if (main?.lat && main?.lng) setOrigin({ lat: main.lat, lng: main.lng, name: isUrdu && main.name_ur ? main.name_ur : main.name, id: main.id })
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const findVehicles = () => {
    if (!toCity) return
    const params = new URLSearchParams({ to: toCity.id })
    if (origin) { params.set('from_lat', String(origin.lat)); params.set('from_lng', String(origin.lng)); params.set('from_name', origin.name) }
    router.push(`/portal/marketplace/results?${params.toString()}`)
  }

  const pins: LeafletPin[] = []
  if (origin) pins.push({ lat: origin.lat, lng: origin.lng, label: origin.name, color: '#005A36' })
  for (const c of cities) if (c.lat != null && c.lng != null) pins.push({ lat: c.lat, lng: c.lng, label: isUrdu && c.name_ur ? c.name_ur : c.name, color: c.id === toCity?.id ? '#D4AF37' : '#166534' })
  if (destPin) pins.push({ lat: destPin.lat, lng: destPin.lng, label: destPin.label, color: '#D4AF37' })

  const confirmDestPin = (loc: PickedLocation) => {
    setDestPin(loc)
    setShowDestPicker(false)
    const withCoords = cities.filter((c) => c.lat != null && c.lng != null)
    if (withCoords.length === 0) return
    const nearest = withCoords.reduce((best, c) => haversineKm(loc, { lat: c.lat!, lng: c.lng! }) < haversineKm(loc, { lat: best.lat!, lng: best.lng! }) ? c : best)
    setToCity(nearest)
  }

  const openGoHome = () => {
    setShowGoHome(true)
    setGoHomeCity(null)
    setGoHomeResults(null)
  }
  const pickGoHomeCity = async (c: City) => {
    setGoHomeCity(c)
    setGoHomeLoading(true)
    const { data, error } = await supabase.rpc('find_rides_home', { p_city_key: c.name })
    setGoHomeLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setGoHomeResults((data as GoHomeResult[]) ?? [])
  }
  const bookRideHome = async (r: GoHomeResult) => {
    setBookingId(r.id)
    const { data, error } = r.kind === 'route'
      ? await supabase.rpc('book_standalone_return_seat', { p_route_id: r.id, p_travel_date: r.travel_date, p_method: 'cash' })
      : await supabase.rpc('book_trip_return_only_seat', { p_trip_offer_id: r.id })
    setBookingId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const total = (data as { total?: number; fare_per_seat?: number })?.total ?? (data as { fare_per_seat?: number })?.fare_per_seat ?? r.approx_fare_pkr
    toast.success(t('mv.returnSeatBookedToast').replace('{amount}', fmt(total)))
    setShowGoHome(false)
    router.push('/portal/marketplace/trips')
  }

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-0">
      {/* Real ask, 2026-10-21: "catagories must be displaying above the
          map not on the map and must be running like news belt" — its
          own row above the map now, in normal flow, not an overlay on
          top of it, and auto-scrolling continuously (useAutoScrollBelt
          above) instead of a manually-swiped static row. Two back-to-
          back copies of the tile list give the loop a seamless wrap,
          same trick the text tickers elsewhere already use. */}
      <div ref={beltRef} dir={isUrdu ? 'rtl' : 'ltr'} className="-mx-3.5 px-3.5 pb-2.5 overflow-hidden whitespace-nowrap">
        <div className="inline-flex gap-1.5">
          {SERVICES.map((s) => (
            <MobilityServiceTile key={`a-${s.key}`} href={s.href} emoji={s.emoji} tint={s.tint} name={t(`mb.svc.${s.key}`)} />
          ))}
          {SERVICES.map((s) => (
            <MobilityServiceTile key={`b-${s.key}`} href={s.href} emoji={s.emoji} tint={s.tint} name={t(`mb.svc.${s.key}`)} />
          ))}
        </div>
      </div>

      {/* Full-bleed map — breaks out of this layout's own p-3.5 padding
          (see marketplace/(mobility)/layout.tsx) so it genuinely reaches
          the frame's edges instead of sitting as a small inset card. */}
      <div className="-mx-3.5 relative">
        <LeafletMap pins={pins} height="28vh" className="rounded-b-[28px]" />
      </div>

      {/* Search card, pulled up to float over the map's bottom edge —
          real complaint fixed earlier this session: a map popup used to
          open ON TOP of this card; both pickers now expand inline here
          instead. */}
      <div className="relative z-10 -mt-7 bg-white rounded-2xl shadow-[0_-6px_20px_rgba(0,0,0,.1)] p-3.5 flex flex-col gap-2.5">
        {showOriginPicker ? (
          <LocationPickerSheet
            title={t('mb.fromPlaceholder')}
            initial={origin ? { lat: origin.lat, lng: origin.lng, label: origin.name } : null}
            defaultCenter={origin ? [origin.lat, origin.lng] : [SITE.lat, SITE.lng]}
            inline
            onClose={() => setShowOriginPicker(false)}
            onConfirm={(loc) => { setOrigin({ lat: loc.lat, lng: loc.lng, name: loc.label, id: 'custom' }); setShowOriginPicker(false) }}
          />
        ) : showDestPicker ? (
          <LocationPickerSheet
            title={t('mb.toPlaceholder')}
            initial={destPin}
            defaultCenter={origin ? [origin.lat, origin.lng] : [SITE.lat, SITE.lng]}
            inline
            onClose={() => setShowDestPicker(false)}
            onConfirm={confirmDestPin}
          />
        ) : showGoHome ? (
          <>
            <div className="flex items-center justify-between">
              <p className="font-bold text-[15px] text-[#005A36] flex items-center gap-1.5"><HomeIcon size={16} /> {t('mb.goHomeHeading')}</p>
              <button onClick={() => setShowGoHome(false)} className="font-sans text-[12px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
            </div>
            {!goHomeCity ? (
              <>
                <p className="font-sans text-[12.5px] text-[#64748b]">{t('mb.pickYourCityHint')}</p>
                <div className="flex gap-1.5 flex-wrap">
                  {cities.map((c) => (
                    <button key={c.id} onClick={() => pickGoHomeCity(c)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border border-[#e5e2d0] text-[#334155] bg-white">
                      📍 {isUrdu && c.name_ur ? c.name_ur : c.name}
                    </button>
                  ))}
                </div>
              </>
            ) : goHomeLoading ? (
              <div className="py-6 text-center"><Loader2 size={20} className="animate-spin text-[#166534] mx-auto" /></div>
            ) : (
              <>
                <button onClick={() => setGoHomeCity(null)} className="font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer text-start">← {isUrdu && goHomeCity.name_ur ? goHomeCity.name_ur : goHomeCity.name}</button>
                {(goHomeResults?.length ?? 0) === 0 ? (
                  <p className="font-sans text-[13px] text-[#94a3b8] text-center py-4">{t('mb.noRidesHomeFound')}</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {goHomeResults!.map((r) => (
                      <div key={`${r.kind}-${r.id}`} className="border border-[#e5e2d0] rounded-xl p-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-sans text-[12.5px] font-bold text-[#1e293b] truncate">{r.owner_name} · {r.vehicle_type}</p>
                          <p className="font-sans text-[11px] text-[#64748b]">{fmt(r.approx_fare_pkr)} {t('mk.perSeat')} · {r.seats_available} {t('mk.seatsLabel')}</p>
                        </div>
                        <button onClick={() => bookRideHome(r)} disabled={bookingId === r.id} className="shrink-0 px-3 py-1.5 rounded-lg text-[11.5px] font-bold text-white cursor-pointer bg-[#166534] disabled:opacity-50">
                          {bookingId === r.id ? t('action.saving') : t('mv.bookReturnSeatBtn')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <p className="font-bold text-[15px] text-[#005A36]">{t('mb.whereToHeading')}</p>
            <div className="flex flex-col border border-[#e5e2d0] rounded-2xl overflow-hidden">
              <button onClick={() => setShowOriginPicker(true)} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer text-start">
                <span className="shrink-0 w-2.5 h-2.5 rounded-full border-2 border-[#166534]" />
                <span className="flex-1 min-w-0 text-[13px] font-semibold text-[#334155] truncate">{origin?.name ?? t('mb.fromPlaceholder')}</span>
              </button>
              <div className="h-px bg-[#f1f5f9] ms-8" />
              <button onClick={() => setShowDestPicker(true)} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer text-start">
                <span className="shrink-0 w-2.5 h-2.5 rounded-sm bg-[#D4AF37]" />
                <span className={`flex-1 min-w-0 text-[13px] truncate ${(toCity || destPin) ? 'font-bold text-[#1e293b]' : 'text-[#94a3b8]'}`}>{destPin ? destPin.label : toCity ? (isUrdu && toCity.name_ur ? toCity.name_ur : toCity.name) : t('mb.toPlaceholder')}</span>
                <Search size={13} className="shrink-0 text-[#94a3b8]" />
              </button>
            </div>

            <div className="-mx-3.5 px-3.5 overflow-x-auto">
              <div className="flex gap-1.5 w-max">
                {cities.map((c) => {
                  const on = toCity?.id === c.id
                  return (
                    <button key={c.id} onClick={() => { setToCity(c); setDestPin(null) }}
                      className="shrink-0 px-2.5 py-1 rounded-full text-[9.5px] font-semibold whitespace-nowrap cursor-pointer border"
                      style={{ background: on ? '#166534' : '#fff', color: on ? '#fff' : '#334155', borderColor: on ? '#166534' : '#e2e8f0' }}>
                      📍 {isUrdu && c.name_ur ? c.name_ur : c.name}
                    </button>
                  )
                })}
              </div>
            </div>

            <button onClick={findVehicles} disabled={!toCity} className="w-full bg-[#166534] disabled:bg-[#166534]/40 text-white rounded-xl py-2.5 font-bold text-[13px] cursor-pointer disabled:cursor-not-allowed">
              {t('mb.findVehiclesBtn')}
            </button>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowNearStop(true)} className="flex-1 border border-[#e5e2d0] text-[#166534] rounded-xl py-2 font-bold text-[12.5px] cursor-pointer">
                📍 {t('mv.findRideNearMeBtn')}
              </button>
              <button onClick={openGoHome} className="flex-1 border border-[#D4AF37] text-[#0f172a] bg-[#FFFBEB] rounded-xl py-2 font-bold text-[12.5px] cursor-pointer flex items-center justify-center gap-1.5">
                <HomeIcon size={13} /> {t('mb.goHomeBtn')}
              </button>
            </div>
            <button onClick={() => router.push('/portal/marketplace/weekly-commute')} className="w-full border border-[#e5e2d0] text-[#166534] rounded-xl py-2 font-bold text-[12.5px] cursor-pointer flex items-center justify-center gap-1.5">
              <Briefcase size={13} /> {t('mb.weeklyCommuteBtn')}
            </button>
          </>
        )}
      </div>
      {showNearStop && <FindRideNearStopSheet onClose={() => setShowNearStop(false)} />}
    </div>
  )
}
