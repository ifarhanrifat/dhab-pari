'use client'

// Real ask, 2026-11-02: "there would be not whatsapp button for the
// vehicle screens, also the new floating buttons which appeared after
// the bookings must be adjusted... make it one button where will be
// appearing the numbers of booking on it and when we click on that
// then the list will appear... along with the remaining time of
// travel if the ride is scheduled or shared."
//
// Replaces the two separate floating widgets that used to compete for
// the same corner — OngoingRideFab (today's single live trip) and
// ActiveRequestsDock (every pending request) — with one button in one
// spot. One item: tapping it opens that item's own flow directly, same
// as before. Two or more: the button carries a count badge and opens a
// list popup of everything, each row still opening its own existing
// flow unchanged. A scheduled/shared seat booking that has a real
// departure time (vehicle_routes.departure_time + the booking's
// travel_date) gets a live countdown pill on its row; anything without
// a real target time keeps its plain status text instead of a fake
// countdown.
//
// The WhatsApp floating button living on top of this corner (see
// FloatingWhatsAppButton's own pathname check) is turned off on these
// same vehicle/marketplace screens so this is the only floating control
// a driver or rider sees here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { RequestWaitingSheet, type WaitingKind, type WaitingSummary } from '@/components/mobility/RequestWaitingSheet'
import { RideLifecycleSheet } from '@/components/portal/RideLifecycleSheet'
import { BookingLifecycleSheet, type LifecycleKind } from '@/components/mobility/BookingLifecycleSheet'
import { RouteBookingSheet } from '@/components/mobility/RouteBookingSheet'
import { RouteGroupPanel } from '@/components/mobility/RouteGroupPanel'

type ItemState = 'ongoing' | 'searching' | 'action' | 'waiting'

interface HubItem {
  key: string
  emoji: string
  label: string
  state: ItemState
  since: string
  countdownTarget?: number // epoch ms — only set when a real scheduled time is known
  sheet?: { kind: WaitingKind; id: string; summary: WaitingSummary; viewHref: string }
  rideSheetBookingId?: string // ongoing ride-dispatch: opens RideLifecycleSheet directly
  // The driver's OWN accepted/in-progress job for hourly/rental/
  // equipment — opens the same BookingLifecycleSheet the driver's own
  // my-vehicle pages use, not the rider-facing RequestWaitingSheet.
  driverLifecycle?: { kind: LifecycleKind; id: string; vehicleId: string; commissionMode: string }
  // A rider's own booked seat on a route — opens RouteBookingSheet
  // directly (book/cancel/reschedule), same popup the browse screen
  // now uses, instead of a page navigation.
  routeSheetId?: string
  // The driver's own route needing attention (roster to review, or
  // already live) — opens RouteGroupPanel directly, the same popup
  // already used for day-to-day route management.
  routeGroupId?: string
  href?: string
  // Real ask, 2026-11-05: "show the number of bookings on these saved
  // return rides... floating button will show alert types in numeric
  // 1.2.3.4 seats already booked" — a dedicated count distinct from the
  // generic multi-item `total` badge below. Set only where a concrete
  // "N people are counting on this" number exists (today: return-offer
  // seats booked); stays on the item (so stays on the badge) for as
  // long as the item itself is on the hub — i.e. from the offer going
  // pending/activated through to the driver cancelling it (803).
  badgeCount?: number
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [enabled])
  return now
}

function Countdown({ target, now, label }: { target: number; now: number; label: string }) {
  const diff = Math.max(0, Math.round((target - now) / 1000))
  const past = target <= now
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  const text = past ? label : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-sans text-[10.5px] font-bold ltr-num shrink-0 ${past ? 'bg-[#dcfce7] text-[#166534]' : 'bg-[#fff7ed] text-[#c2410c]'}`}>
      {!past && <span className="w-1.5 h-1.5 rounded-full bg-[#f97316] animate-pulse" />}
      {text}
    </span>
  )
}

const DRAG_STORAGE_KEY = 'dp.floatingHub.pos.v1'
const BUTTON_SIZE = 56

// Real ask, 2026-11-02: "those floating button must be move able up and
// down etc" — the button can be dragged anywhere on screen; its last
// spot is remembered per-device (localStorage, a per-viewer convenience,
// never shared/critical state) so it comes back where it was left. A
// release that never moved more than a few pixels still counts as a
// plain tap, not a drag, so the existing open-item/open-list behavior
// is unaffected for anyone who never touches the drag handle.
function useDraggablePosition() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(DRAG_STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch { return null } // private window / blocked storage — falls back to the default corner
  })
  const dragging = useRef(false)
  const moved = useRef(false)
  const start = useRef({ x: 0, y: 0, posX: 0, posY: 0 })

  const clamp = (x: number, y: number) => {
    const margin = 8
    const w = typeof window !== 'undefined' ? window.innerWidth : 400
    const h = typeof window !== 'undefined' ? window.innerHeight : 800
    return { x: Math.min(Math.max(x, margin), w - BUTTON_SIZE - margin), y: Math.min(Math.max(y, margin), h - BUTTON_SIZE - margin) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true
    moved.current = false
    const rect = e.currentTarget.getBoundingClientRect()
    start.current = { x: e.clientX, y: e.clientY, posX: rect.left, posY: rect.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    // Real bug found live, 2026-11-04: 5px worked fine for a mouse
    // (near-zero jitter) but misread a real finger tap on Android as a
    // drag — a touch naturally wanders more than a cursor click does
    // even when the intent is just "tap." 10px matches the touch-slop
    // range Android/Chrome's own tap-vs-drag heuristics use.
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved.current = true
    if (moved.current) setPos(clamp(start.current.posX + dx, start.current.posY + dy))
  }
  // Real bug found live, 2026-11-04, two rounds: first in a Firefox tab
  // (worked in the native app, not there), then — after moving the tap
  // action into the pointer-events handlers themselves to dodge that —
  // in the native Android app itself, confirmed with a zero-movement
  // synthetic tap via adb (ruling out touch-jitter thresholds
  // entirely): Pointer Events plainly aren't reaching this handler
  // reliably in that Capacitor WebView, so a tap-action built purely on
  // onPointerUp has no safety net there at all.
  //
  // The actually robust fix: stop trying to make Pointer Events solely
  // responsible for the tap, and go back to the one event every engine
  // (WebView included) reliably delivers — onClick — but attach it to
  // THIS div (the one that calls setPointerCapture), not a descendant
  // button. Firefox retargets a captured pointer's synthetic click to
  // the capturing element itself, so a handler sitting on a child never
  // sees it; a handler sitting on the capturing element does. Pointer
  // events now only ever drive the optional drag-reposition feature;
  // they're no longer load-bearing for "did the user tap this."
  const finishDrag = () => {
    dragging.current = false
    if (moved.current) {
      setPos((cur) => {
        try { if (cur) localStorage.setItem(DRAG_STORAGE_KEY, JSON.stringify(cur)) } catch { /* ignore */ }
        return cur
      })
    }
  }
  const onPointerUp = () => finishDrag()
  // A cancelled gesture (browser took over, multi-touch, etc.) is never
  // a tap, regardless of how little the pointer moved before cancelling.
  const onPointerCancel = () => finishDrag()

  return { pos, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, wasDragged: () => moved.current }
}

export function FloatingBookingsHub() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const router = useRouter()
  const [items, setItems] = useState<HubItem[]>([])
  const [openSheet, setOpenSheet] = useState<HubItem['sheet'] | null>(null)
  const [openRideSheetId, setOpenRideSheetId] = useState<string | null>(null)
  const [openDriverLifecycle, setOpenDriverLifecycle] = useState<HubItem['driverLifecycle'] | null>(null)
  const [openRouteSheetId, setOpenRouteSheetId] = useState<string | null>(null)
  const [openGroupRouteId, setOpenGroupRouteId] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const drag = useDraggablePosition()

  const load = useCallback(async () => {
    const supabase = createClient()
    const [vehicleRes, ongoing, hourly, rental, equipment, seats, rides, purchases, parcels] = await Promise.all([
      supabase.from('vehicles').select('id, commission_mode, offers_hourly, offers_rental, offers_shadi, offers_machinery, offers_tractor, offers_loader').eq('portal_user_id', user!.id).maybeSingle(),
      supabase.rpc('my_ongoing_ride'),
      supabase.rpc('my_hourly_bookings'),
      supabase.rpc('my_rental_bookings'),
      supabase.rpc('my_equipment_bookings'),
      // Real bug found 2026-11-07: filtering to 'announced' only meant a
      // booking vanished from the floating button the instant the driver
      // confirmed it — exactly the moment a rider most wants a quick way
      // back into it. 'confirmed' now stays in, bounded to today/future
      // so a long-past booking doesn't linger forever.
      supabase.from('ride_bookings').select('id, route_id, seats, travel_date, total_amount_pkr, created_at, vehicle_routes(origin, origin_ur, destination, destination_ur, departure_time), adda_queue_entries(addas(name, name_ur))').eq('portal_user_id', user!.id).in('status', ['announced', 'confirmed']).gte('travel_date', new Date().toISOString().slice(0, 10)),
      supabase.from('ride_dispatch_requests').select('id, pickup_label, dropoff_label, fare_pkr, created_at').eq('initiator_portal_user_id', user!.id).eq('status', 'open'),
      supabase.rpc('my_city_purchase_requests'),
      supabase.rpc('my_parcel_deliveries'),
    ])
    const out: HubItem[] = []
    const nm = (en: string | null | undefined, ur: string | null | undefined) => (isUrdu && ur ? ur : en) ?? ''

    // Real bug found 2026-11-04: "driver accepted the ride and heading
    // towards the rider destination... no floating button." This hub
    // already renders on driver screens too (mounted at the root portal
    // layout), but every query above is rider-facing ("bookings I made
    // as a customer") — my_ongoing_ride() is the only one with a
    // driver-role branch (ride_dispatch/trip-share). Hourly/rental/
    // equipment never surfaced the DRIVER's own accepted/in-progress
    // job here at all. Mirrors that same dual-role coverage for these
    // three, opening the driver's own BookingLifecycleSheet instead of
    // the rider-facing RequestWaitingSheet.
    const vehicle = vehicleRes.data as { id: string; commission_mode: string; offers_hourly: boolean; offers_rental: boolean; offers_shadi: boolean; offers_machinery: boolean; offers_tractor: boolean; offers_loader: boolean } | null
    const [driverHourly, driverRental, driverEquipment, driverShadi, driverReturnOffers, driverRouteAddaLive, driverTripInProgress] = vehicle ? await Promise.all([
      vehicle.offers_hourly ? supabase.rpc('vehicle_hourly_bookings', { p_vehicle_id: vehicle.id }) : Promise.resolve({ data: [] }),
      vehicle.offers_rental ? supabase.rpc('vehicle_rental_bookings', { p_vehicle_id: vehicle.id }) : Promise.resolve({ data: [] }),
      (vehicle.offers_machinery || vehicle.offers_tractor || vehicle.offers_loader) ? supabase.rpc('vehicle_equipment_bookings', { p_vehicle_id: vehicle.id }) : Promise.resolve({ data: [] }),
      vehicle.offers_shadi ? supabase.rpc('vehicle_shadi_requests', { p_vehicle_id: vehicle.id }) : Promise.resolve({ data: [] }),
      vehicle.offers_rental ? supabase.rpc('vehicle_rental_return_offers', { p_vehicle_id: vehicle.id }) : Promise.resolve({ data: [] }),
      // Real bug found 2026-11-06: this hub never queried routes/adda by
      // vehicle ownership at all — only by the viewer's own
      // portal_user_id as a rider, so a driver who owns the vehicle but
      // didn't personally book a seat saw nothing. These two feed the
      // real per-rider onboarding this session built (817).
      supabase.rpc('vehicle_route_adda_live_status', { p_vehicle_id: vehicle.id }),
      supabase.from('vehicle_trip_bookings').select('id, trip_offer_id, vehicle_trip_offers(origin, origin_ur, destination, destination_ur)').eq('vehicle_id', vehicle.id).eq('status', 'in_progress'),
    ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }]

    if (vehicle) {
      for (const b of (driverHourly.data ?? []) as { id: string; status: string; hours: number; customer_name: string; requested_at: string }[]) {
        if (!['accepted', 'in_progress'].includes(b.status)) continue
        out.push({ key: `dh-${b.id}`, emoji: '⏱️', label: `${t('rq.kind.hourly')} · ${b.customer_name}`, state: 'ongoing', since: b.requested_at,
          driverLifecycle: { kind: 'hourly', id: b.id, vehicleId: vehicle.id, commissionMode: vehicle.commission_mode } })
      }
      for (const b of (driverRental.data ?? []) as { id: string; status: string; vehicle_id: string | null; to_address: string; customer_name: string; requested_at: string }[]) {
        if (b.vehicle_id !== vehicle.id || !['accepted', 'in_progress'].includes(b.status)) continue
        out.push({ key: `dr-${b.id}`, emoji: '🚗', label: `${t('rq.kind.rental')} · ${b.customer_name}`, state: 'ongoing', since: b.requested_at,
          driverLifecycle: { kind: 'rental', id: b.id, vehicleId: vehicle.id, commissionMode: vehicle.commission_mode } })
      }
      for (const b of (driverEquipment.data ?? []) as { id: string; kind: 'machinery' | 'tractor' | 'loader'; status: string; customer_name: string; requested_at: string }[]) {
        if (!['accepted', 'in_progress'].includes(b.status)) continue
        out.push({ key: `de-${b.id}`, emoji: b.kind === 'tractor' ? '🚜' : b.kind === 'loader' ? '🚚' : '🏗️', label: `${t(`rq.kind.equipment.${b.kind}`)} · ${b.customer_name}`, state: 'ongoing', since: b.requested_at,
          driverLifecycle: { kind: 'equipment', id: b.id, vehicleId: vehicle.id, commissionMode: vehicle.commission_mode } })
      }
      // Shadi has no shared BookingLifecycleSheet (its own dedicated
      // my-vehicle/shadi page handles start/finish) — same href-based
      // pattern the hub already uses for ride_dispatch/city_purchase
      // rather than another sheet integration.
      for (const r of (driverShadi.data ?? []) as { id: string; status: string; customer_name: string; event_date: string }[]) {
        if (r.status !== 'accepted') continue
        out.push({ key: `ds-${r.id}`, emoji: '💐', label: `${t('rq.kind.shadi')} · ${r.customer_name}`, state: 'ongoing', since: r.event_date, href: '/portal/my-vehicle/shadi' })
      }
      // Real ask, 2026-11-04: "when we have a floating button then why
      // not we used it for this purpose too" — a driver's own return-leg
      // offer (796/797) only ever lived on my-vehicle/rental's own
      // banner; it never showed up here even though it's exactly the
      // same "something needs you" shape as every other row in this
      // hub. 'pending' counts down to the moment it activates (the
      // original one-way trip finishing); 'activated' is already live,
      // so it's 'ongoing' — the driver should be heading back now.
      for (const o of (driverReturnOffers.data ?? []) as { id: string; status: string; to_address: string; expected_arrival_at: string; bookings: { id: string }[] }[]) {
        const seatsBooked = o.bookings.length
        out.push({
          key: `dro-${o.id}`, emoji: '🔄',
          label: `${t('rq.kind.rentalReturn')} · ${o.to_address}`,
          state: o.status === 'activated' ? 'ongoing' : 'waiting',
          since: o.expected_arrival_at,
          countdownTarget: o.status === 'pending' ? new Date(o.expected_arrival_at).getTime() : undefined,
          href: '/portal/my-vehicle/rental',
          badgeCount: seatsBooked > 0 ? seatsBooked : undefined,
        })
      }

      for (const item of (driverRouteAddaLive.data ?? []) as Array<
        | { kind: 'route_ongoing'; route_id: string; origin: string; destination: string; started_at: string }
        | { kind: 'route_action'; route_id: string; origin: string; destination: string; pending_count: number }
        | { kind: 'route_idle'; route_id: string; origin: string; destination: string }
        | { kind: 'adda_ongoing'; entry_id: string; adda_name: string; adda_name_ur: string | null }
        | { kind: 'adda_action'; entry_id: string; adda_name: string; adda_name_ur: string | null; pending_count: number }
      >) {
        if (item.kind === 'route_ongoing') {
          out.push({ key: `rto-${item.route_id}`, emoji: '🚌', label: `${nm(item.origin, null)} → ${nm(item.destination, null)}`, state: 'ongoing', since: item.started_at, routeGroupId: item.route_id })
        } else if (item.kind === 'route_action') {
          out.push({ key: `rta-${item.route_id}`, emoji: '🚌', label: `${nm(item.origin, null)} → ${nm(item.destination, null)}`, state: 'action', since: new Date().toISOString(), routeGroupId: item.route_id, badgeCount: item.pending_count })
        } else if (item.kind === 'route_idle') {
          // Real bug found 2026-11-07: a permanent, scheduled-today route
          // used to vanish from the hub the instant its run ended and
          // nothing was left pending — unlike the rider's own seat item,
          // which never disappears just because nothing needs action
          // right now. Same quiet 'waiting' styling, still one tap into
          // the route group (chat/roster/prep for tomorrow).
          out.push({ key: `rti-${item.route_id}`, emoji: '🚌', label: `${nm(item.origin, null)} → ${nm(item.destination, null)}`, state: 'waiting', since: new Date().toISOString(), routeGroupId: item.route_id })
        } else if (item.kind === 'adda_ongoing') {
          out.push({ key: `ado-${item.entry_id}`, emoji: '🚐', label: `${nm(item.adda_name, item.adda_name_ur)}`, state: 'ongoing', since: new Date().toISOString(), href: '/portal/my-vehicle/adda' })
        } else {
          out.push({ key: `ada-${item.entry_id}`, emoji: '🚐', label: `${nm(item.adda_name, item.adda_name_ur)}`, state: 'action', since: new Date().toISOString(), href: '/portal/my-vehicle/adda', badgeCount: item.pending_count })
        }
      }

      // Dedupe against my_ongoing_ride()'s own single driver-side trip-
      // share item (today only) — this query covers every OTHER
      // in_progress trip-share booking regardless of date.
      const ongoingBookingId = (ongoing.data as { booking_id: string | null } | null)?.booking_id
      for (const tb of (driverTripInProgress.data ?? []) as unknown as { id: string; vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null }[]) {
        if (tb.id === ongoingBookingId) continue
        const o2 = tb.vehicle_trip_offers
        out.push({ key: `dtb-${tb.id}`, emoji: '🚖', label: o2 ? `${nm(o2.origin, o2.origin_ur)} → ${nm(o2.destination, o2.destination_ur)}` : t('rq.kind.ride_dispatch'), state: 'ongoing', since: new Date().toISOString(), href: '/portal/my-vehicle/trips' })
      }
    }

    // city_purchase and parcel delivery: both already have a dual-role
    // RPC (as_role keyed off accepted_vehicle_id ownership, same shape
    // my_ongoing_ride() uses for ride_dispatch) — covers the driver
    // actually doing the job, not just whoever requested it.
    for (const c of (purchases.data ?? []) as { id: string; item: string; status: string; created_at: string; as_role: string }[]) {
      if (c.as_role === 'user') {
        if (!['ringing', 'no_answer', 'priced', 'approved', 'purchased', 'delivered'].includes(c.status)) continue
        const ongoing = ['approved', 'purchased', 'delivered'].includes(c.status)
        out.push({ key: `c-${c.id}`, emoji: '🛍️', label: `${t('rq.kind.city_purchase')} · ${c.item}`,
          state: ongoing ? 'ongoing' : c.status === 'priced' ? 'action' : c.status === 'no_answer' ? 'waiting' : 'searching',
          since: c.created_at, href: `/portal/marketplace/city-purchase/${c.id}` })
      } else if (vehicle && ['approved', 'purchased', 'delivered'].includes(c.status)) {
        out.push({ key: `dc-${c.id}`, emoji: '🛍️', label: `${t('rq.kind.city_purchase')} · ${c.item}`, state: 'ongoing', since: c.created_at, href: `/portal/marketplace/city-purchase/${c.id}` })
      }
    }
    for (const p of (parcels.data ?? []) as { id: string; description: string; status: string; created_at: string; as_role: string }[]) {
      if (p.as_role === 'user') {
        if (!['ringing', 'no_answer', 'approved', 'picked_up', 'delivered'].includes(p.status)) continue
        const ongoing = ['approved', 'picked_up', 'delivered'].includes(p.status)
        out.push({ key: `pc-${p.id}`, emoji: '📦', label: `${t('rq.kind.parcel')} · ${p.description}`,
          state: ongoing ? 'ongoing' : p.status === 'no_answer' ? 'waiting' : 'searching',
          since: p.created_at, href: `/portal/marketplace/parcel/${p.id}` })
      } else if (vehicle && ['approved', 'picked_up', 'delivered'].includes(p.status)) {
        out.push({ key: `dp-${p.id}`, emoji: '📦', label: `${t('rq.kind.parcel')} · ${p.description}`, state: 'ongoing', since: p.created_at, href: `/portal/marketplace/parcel/${p.id}` })
      }
    }

    const o = ongoing.data as { role: 'driver' | 'rider'; label: string; link: string; booking_id: string | null; is_ride_dispatch: boolean } | null
    if (o) {
      out.push({
        key: 'ongoing', emoji: '🚖', label: o.label, state: 'ongoing', since: new Date().toISOString(),
        ...(o.is_ride_dispatch && o.booking_id ? { rideSheetBookingId: o.booking_id } : { href: o.link }),
      })
    }

    // Real bug found 2026-11-04: these three only ever kept a 'requested'
    // row — the instant a driver accepted, the item vanished from the
    // hub entirely instead of switching to an "ongoing" state, exactly
    // while the rider most wants a quick way back into it.
    for (const b of (hourly.data ?? []) as { id: string; status: string; hours: number; pickup_address: string; base_amount_pkr: number; total_amount_pkr: number | null; requested_at: string; owner_name: string; vehicle_type: string; model: string | null }[]) {
      if (!['requested', 'accepted', 'in_progress'].includes(b.status)) continue
      const ongoing = b.status !== 'requested'
      out.push({ key: `h-${b.id}`, emoji: '⏱️', label: `${t('rq.kind.hourly')} · ${vehicleDisplayName(b.vehicle_type, b.model)}`, state: ongoing ? 'ongoing' : 'searching', since: b.requested_at,
        sheet: { kind: 'hourly', id: b.id, viewHref: '/portal/marketplace/hourly', summary: { vehicleLabel: vehicleDisplayName(b.vehicle_type, b.model), driverName: b.owner_name, from: b.pickup_address, amount: b.total_amount_pkr ?? b.base_amount_pkr, facts: [t('rw.hours').replace('{n}', String(b.hours))] } } })
    }
    for (const b of (rental.data ?? []) as { id: string; status: string; from_address: string; to_address: string; total_amount_pkr: number; requested_at: string; owner_name: string; vehicle_type: string; model: string | null }[]) {
      if (!['requested', 'accepted', 'in_progress'].includes(b.status)) continue
      const ongoing = b.status !== 'requested'
      out.push({ key: `r-${b.id}`, emoji: '🚗', label: `${t('rq.kind.rental')} · ${b.to_address}`, state: ongoing ? 'ongoing' : 'searching', since: b.requested_at,
        sheet: { kind: 'rental', id: b.id, viewHref: '/portal/marketplace/rental', summary: { vehicleLabel: vehicleDisplayName(b.vehicle_type, b.model), driverName: b.owner_name, from: b.from_address, to: b.to_address, amount: b.total_amount_pkr } } })
    }
    for (const b of (equipment.data ?? []) as { id: string; kind: 'machinery' | 'tractor' | 'loader'; status: string; site_address: string; rate_pkr: number; total_amount_pkr: number | null; requested_at: string; owner_name: string; vehicle_type: string; model: string | null; advance_status?: string }[]) {
      const payAdvance = b.status === 'accepted' && ['due', 'rejected'].includes(b.advance_status ?? '')
      const ongoing = !payAdvance && b.status !== 'requested'
      if (!['requested', 'accepted', 'in_progress'].includes(b.status) && !payAdvance) continue
      out.push({ key: `e-${b.id}`, emoji: b.kind === 'tractor' ? '🚜' : b.kind === 'loader' ? '🚚' : '🏗️', label: `${t(`rq.kind.equipment.${b.kind}`)} · ${payAdvance ? t('eqa.payBtn') : b.site_address}`,
        state: payAdvance ? 'action' : ongoing ? 'ongoing' : 'searching', since: b.requested_at,
        sheet: { kind: 'equipment', id: b.id, viewHref: `/portal/marketplace/${b.kind}`, summary: { vehicleLabel: vehicleDisplayName(b.vehicle_type, b.model), driverName: b.owner_name, from: b.site_address, amount: b.total_amount_pkr ?? b.rate_pkr } } })
    }
    const seatRows = (seats.data ?? []) as unknown as { id: string; route_id: string | null; seats: number; travel_date: string; total_amount_pkr: number; created_at: string; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; departure_time: string | null } | null; adda_queue_entries: { addas: { name: string; name_ur: string | null } | null } | null }[]
    // Real ask, 2026-11-06: "when rider click on the floating button
    // then it will view everything in real time... along with full
    // chat" — if the van for one of these routes is actually live right
    // now, jump straight to the live map/chat (RouteGroupPanel) instead
    // of the booking popup.
    const seatRouteIds = [...new Set(seatRows.map((b) => b.route_id).filter((id): id is string => !!id))]
    const activeRunRouteIds = seatRouteIds.length > 0
      ? new Set(((await supabase.from('route_runs').select('route_id').in('route_id', seatRouteIds).is('ended_at', null)).data ?? []).map((r) => r.route_id))
      : new Set<string>()
    for (const b of seatRows) {
      const r = b.vehicle_routes
      const adda = b.adda_queue_entries?.addas
      const title = r ? `${nm(r.origin, r.origin_ur)} → ${nm(r.destination, r.destination_ur)}` : nm(adda?.name, adda?.name_ur)
      // A fixed route has a real scheduled clock time to count down to; an
      // adda (turn-based queue) has no fixed departure, so it keeps its
      // plain "waiting" status instead of a fabricated countdown.
      const countdownTarget = r?.departure_time ? new Date(`${b.travel_date}T${r.departure_time}+05:00`).getTime() : undefined
      const isLive = !!b.route_id && activeRunRouteIds.has(b.route_id)
      // A route booking opens the same popup (book/cancel/reschedule)
      // the browse screen now uses, directly — unless the van is
      // already live, which opens the group/live-map view instead — an
      // adda booking (no route_id) falls back to the existing
      // waiting-sheet pattern.
      out.push({ key: `s-${b.id}`, emoji: '🚌', label: `${t('rq.kind.route')} · ${title}`, state: isLive ? 'ongoing' : 'waiting', since: b.created_at, countdownTarget: isLive ? undefined : countdownTarget,
        ...(isLive && b.route_id
          ? { routeGroupId: b.route_id }
          : b.route_id
          ? { routeSheetId: b.route_id }
          : { sheet: { kind: 'seat', id: b.id, viewHref: '/portal/marketplace/trips', summary: { vehicleLabel: title, from: nm(adda?.name, adda?.name_ur), to: null, amount: b.total_amount_pkr, facts: [b.travel_date, t('rw.seats').replace('{n}', String(b.seats))] } } }) })
    }
    for (const d of (rides.data ?? []) as { id: string; pickup_label: string; dropoff_label: string; fare_pkr: number; created_at: string }[]) {
      out.push({ key: `d-${d.id}`, emoji: '🚕', label: `${t('rq.kind.ride_dispatch')} · ${d.dropoff_label}`, state: 'searching', since: d.created_at, href: `/portal/marketplace/ride-dispatch/${d.id}` })
    }
    // Live-now first, then needs-you, then newest.
    out.sort((a, b) =>
      (a.state === 'ongoing' ? 0 : 1) - (b.state === 'ongoing' ? 0 : 1) ||
      (a.state === 'action' ? 0 : 1) - (b.state === 'action' ? 0 : 1) ||
      b.since.localeCompare(a.since))
    setItems(out)
  }, [user, t, isUrdu])

  useEffect(() => {
    if (!user) return
    let live = true
    const run = () => { if (live) load() }
    const first = setTimeout(run, 0)
    const iv = setInterval(run, 20000)
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { live = false; clearTimeout(first); clearInterval(iv); document.removeEventListener('visibilitychange', onVisible) }
  }, [user, load])

  const hasCountdown = useMemo(() => items.some((i) => i.countdownTarget != null), [items])
  const now = useNow(hasCountdown)

  const openItem = (it: HubItem) => {
    setListOpen(false)
    if (it.rideSheetBookingId) setOpenRideSheetId(it.rideSheetBookingId)
    else if (it.driverLifecycle) setOpenDriverLifecycle(it.driverLifecycle)
    else if (it.routeSheetId) setOpenRouteSheetId(it.routeSheetId)
    else if (it.routeGroupId) setOpenGroupRouteId(it.routeGroupId)
    else if (it.sheet) setOpenSheet(it.sheet)
    else if (it.href) router.push(it.href)
  }

  const renderSheet = () => {
    if (openRideSheetId) return <RideLifecycleSheet bookingId={openRideSheetId} onClose={() => { setOpenRideSheetId(null); load() }} />
    if (openRouteSheetId) return <RouteBookingSheet routeId={openRouteSheetId} onClose={() => { setOpenRouteSheetId(null); load() }} />
    if (openGroupRouteId) return <RouteGroupPanel routeId={openGroupRouteId} onClose={() => { setOpenGroupRouteId(null); load() }} />
    if (openDriverLifecycle) {
      return (
        <BookingLifecycleSheet
          kind={openDriverLifecycle.kind} bookingId={openDriverLifecycle.id} vehicleId={openDriverLifecycle.vehicleId} commissionMode={openDriverLifecycle.commissionMode}
          onClose={() => { setOpenDriverLifecycle(null); load() }}
          onChanged={load}
        />
      )
    }
    if (!openSheet) return null
    return (
      <RequestWaitingSheet kind={openSheet.kind} bookingId={openSheet.id} summary={openSheet.summary}
        onClose={() => { setOpenSheet(null); load() }}
        onViewBooking={() => { const href = openSheet.viewHref; setOpenSheet(null); router.push(href) }} />
    )
  }

  if (!user || items.length === 0) return renderSheet()

  const badgeColor = (s: ItemState) => (s === 'ongoing' ? '#166534' : s === 'action' ? '#f59e0b' : '#16a34a')
  const dotBg = (s: ItemState) => (s === 'ongoing' ? '#dcfce7' : s === 'action' ? '#fef3c7' : '#dcfce7')

  const Row = ({ it }: { it: HubItem }) => (
    <button onClick={() => openItem(it)}
      className="w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl bg-white border border-[#e8eaee] active:scale-[0.98] transition-transform cursor-pointer text-start">
      <span className="relative shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-[18px]" style={{ background: dotBg(it.state) }}>
        {(it.state === 'searching' || it.state === 'ongoing') && <span className="absolute inset-0 rounded-full border-2 animate-ping [animation-duration:2s]" style={{ borderColor: `${badgeColor(it.state)}80` }} />}
        {it.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] leading-none" style={{ color: badgeColor(it.state) }}>
          {it.state === 'ongoing' ? t('cm.ongoingFabRiderLabel') : t(`dock.state.${it.state}`)}
        </span>
        <span className="block font-sans text-[13px] font-semibold text-[#0f172a] truncate leading-tight mt-0.5"><bdi>{it.label}</bdi></span>
      </span>
      {it.badgeCount != null && (
        <span aria-label={t('dock.seatsBookedAlt').replace('{n}', String(it.badgeCount))}
          className="shrink-0 min-w-[20px] h-5 px-1 rounded-full bg-[#f59e0b] text-[#0f172a] font-sans text-[10.5px] font-black flex items-center justify-center ltr-num">
          {it.badgeCount}
        </span>
      )}
      {it.countdownTarget != null && <Countdown target={it.countdownTarget} now={now} label={it.key.startsWith('dro-') ? t('dock.readyNow') : t('dock.departed')} />}
      {it.state === 'action' && it.countdownTarget == null && <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b] shrink-0" />}
    </button>
  )

  const total = items.length
  const primary = items[0]
  // The multi-item count and a specific "N seats booked" alert are
  // different signals — when the top item itself is carrying a real
  // booked-seat count, that's the more actionable number to put on the
  // button, even if other unrelated items also happen to be waiting.
  const cornerBadge = primary.badgeCount ?? (total > 1 ? total : null)
  return (
    <>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className={`fixed z-[70] print:hidden ${drag.pos ? '' : 'bottom-[90px] right-4 md:bottom-6 md:right-6'}`}
        style={drag.pos ? { left: drag.pos.x, top: drag.pos.y, touchAction: 'none' } : { touchAction: 'none' }}
        onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove} onPointerUp={drag.onPointerUp} onPointerCancel={drag.onPointerCancel}
        onClick={() => { if (drag.wasDragged()) return; if (total === 1) openItem(primary); else setListOpen(true) }}>
        <button
          className="relative flex items-center gap-2 pl-3 pr-4 h-12 rounded-full text-white shadow-lg hover:scale-105 active:scale-95 transition-all max-w-[230px] cursor-grab active:cursor-grabbing"
          style={{ background: primary.state === 'ongoing' ? '#166534' : '#0f172a' }}>
          <span className="shrink-0 w-6 h-6 rounded-full bg-white/15 flex items-center justify-center text-[14px]">{primary.emoji}</span>
          <span className="min-w-0 text-start">
            <span className="block font-sans text-[10px] font-bold uppercase tracking-[0.05em] text-white/70 leading-none">
              {total > 1 ? t('dock.multipleLabel').replace('{n}', String(total)) : (primary.state === 'ongoing' ? t('cm.ongoingFabRiderLabel') : t(`dock.state.${primary.state}`))}
            </span>
            <span className="block font-sans text-[12px] font-bold truncate leading-tight mt-0.5">{primary.label}</span>
          </span>
          {cornerBadge != null && (
            <span aria-label={primary.badgeCount != null ? t('dock.seatsBookedAlt').replace('{n}', String(cornerBadge)) : undefined}
              className="absolute -top-1.5 -end-1.5 min-w-[22px] h-[22px] px-1 rounded-full bg-[#f59e0b] text-[#0f172a] font-sans text-[11px] font-black flex items-center justify-center shadow-md ltr-num border-2 border-white">
              {cornerBadge}
            </span>
          )}
        </button>
      </div>

      {listOpen && (
        <div className="fixed inset-0 bg-black/55 z-[100] flex items-end sm:items-center justify-center animate-in fade-in duration-200" onClick={() => setListOpen(false)}>
          <div dir={isUrdu ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}
            className="bg-[#f8fafc] w-full sm:max-w-[420px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[85vh] shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 duration-300 flex flex-col">
            <div className="px-5 pt-5 pb-3 flex items-center justify-between shrink-0">
              <p className="font-sans text-[16px] font-extrabold text-[#0f172a]">{t('dock.listTitle').replace('{n}', String(total))}</p>
              <button onClick={() => setListOpen(false)} aria-label="Close" className="w-8 h-8 rounded-full bg-[#e2e8f0] flex items-center justify-center cursor-pointer">
                <ChevronDown size={16} />
              </button>
            </div>
            <div className="px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-2 overflow-y-auto">
              {items.map((it) => <Row key={it.key} it={it} />)}
            </div>
          </div>
        </div>
      )}

      {renderSheet()}
    </>
  )
}
