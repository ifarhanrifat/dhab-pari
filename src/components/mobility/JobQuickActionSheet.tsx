'use client'

// Real ask, 2026-10-20: "the vehical system should work like real app
// style like a popup window like the request appear in the screen with
// same like other modern apps." The driver's Jobs tab was the one clear
// gap — every row navigated to a whole separate page just to accept or
// decline a single request, exactly the "incoming ride request" moment
// every real driver app (Uber/Careem/inDrive) shows as a popup over
// whatever screen you're already on. This is that popup: Accept/Decline
// call the exact same RPCs each vertical's own page already uses — no
// new backend, no change to those pages. Anything beyond accept/decline
// (starting a trip needs the PIN modal already built on that vertical's
// page, chat needs the full thread) still goes through "View full
// details" — a deliberate step deeper, not the only option any more.
//
// city_purchase is the one kind that can't be a plain accept/decline —
// the driver sets their own service fee within the committee's min/max
// band (same real distinction the self-invite fix earlier this session
// already respected) — so it gets one extra input, same recipe as the
// city-purchase detail page's own "ringing" block.
//
// Real ask, 2026-10-30: "make the request which received by the driver
// look like a professional and modern like the other modern apps... we
// have different drivers of different vehicals." Redesigned as a
// ride-hailing style request card: each job kind gets its own colour
// and icon (a tractor job never looks like a wedding booking), the fare
// is the biggest thing on screen, pickup → drop-off reads as a route
// line, and the job's facts (hours, km, date, payment) are chips instead
// of a single grey sentence. Logic and RPCs are unchanged.

import { useEffect, useState, type ComponentType } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import {
  Check, X as XIcon, Loader2, Clock, Car, CarFront, Bus, Tractor, PartyPopper, Truck, ShoppingCart, Package, ShoppingBag,
  CalendarClock, Gauge, Wallet, Hourglass, Zap, Store, MapPin, Repeat, MessageSquareQuote, ChevronRight, User,
  Construction, Wrench, Tag, Armchair, Info,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { TrustPill, type Trust } from '@/components/shared/TrustBadge'
import { fetchPendingRequestRows } from '@/lib/driverRequestRows'
import { RideLifecycleSheet } from '@/components/portal/RideLifecycleSheet'
import { haversineKm, fetchRoadRoute } from '@/lib/roadRoute'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

export type QuickActionKind = 'hourly' | 'rental' | 'equipment' | 'shadi' | 'route' | 'dispatch' | 'city_purchase' | 'parcel' | 'delivery' | 'ride_dispatch'
export type QuickActionFactIcon = 'clock' | 'calendar' | 'distance' | 'wallet' | 'wait' | 'urgent' | 'shop' | 'repeat' | 'service' | 'rate' | 'truck' | 'seat'
export interface QuickActionRow {
  id: string
  type: QuickActionKind
  title: string
  subtitle: string
  amount: number | null
  href: string
  needsAction: boolean
  // Only populated for 'ride_dispatch' — "who is asking" is the one
  // real gap this card had for a broadcast request, which never had a
  // deliberate per-vehicle invite to vet a requester against.
  riderTrust?: Trust | null
  riderVillage?: string
  // Optional richer detail for the request card. Callers that don't
  // pass these still render: from/to fall back to splitting an
  // "A → B" subtitle/title, and the facts/note sections just hide.
  from?: string
  to?: string
  // ride_dispatch only — the rider's real pickup point, shown as a
  // small map preview on the request card, and the driver's own last-
  // known position so the card can show how far that pickup actually
  // is before the driver decides to accept (2026-11-02 ask).
  pickupLat?: number | null
  pickupLng?: number | null
  driverLat?: number | null
  driverLng?: number | null
  customerName?: string
  facts?: { icon: QuickActionFactIcon; text: string }[]
  note?: string | null
  // equipment only — machinery / tractor / loader each get their own
  // icon and label instead of one generic "machinery job".
  subKind?: 'machinery' | 'tractor' | 'loader'
  // Shown in place of Accept/Decline when the driver isn't the one who
  // decides (e.g. a lump-sum vehicle's seat booking, which the
  // committee confirms after checking the rider's payment).
  infoNote?: string | null
  // Real ask, 2026-11-03: "we can't allow the rider to pick up a
  // separate vehicle from the catalog... send the calls to all drivers
  // nearby so everyone gets a chance." hourly/rental requests now
  // broadcast to every matching vehicle (787) — set when this row is
  // still unassigned, so there's an Accept but no Decline (declining
  // an open broadcast just means another driver gets it, nothing to
  // "decline" specifically).
  isBroadcast?: boolean
}
// dispatch/city_purchase/parcel/delivery all gate accept/decline on the
// caller owning the given vehicle_id — hourly/rental/equipment/shadi/
// route don't take one at all (ownership is derived from the booking's
// own vehicle_id server-side), so this is only threaded through where
// it's actually needed.
const NEEDS_VEHICLE_ID = new Set<QuickActionKind>(['dispatch', 'city_purchase', 'parcel', 'delivery'])

// Kinds whose row title is the customer's name rather than the job
// itself — for these the card's headline is the job kind and the name
// moves to its own "customer" line.
const PERSON_TITLE_KINDS = new Set<QuickActionKind>(['hourly', 'rental', 'equipment', 'shadi'])

type IconType = ComponentType<{ size?: number; className?: string; strokeWidth?: number }>
const THEME: Record<QuickActionKind, { icon: IconType; from: string; to: string; amountKey: string }> = {
  ride_dispatch: { icon: CarFront, from: '#065f46', to: '#10b981', amountKey: 'rq.fare' },
  route: { icon: Bus, from: '#115e59', to: '#14b8a6', amountKey: 'rq.fare' },
  hourly: { icon: Clock, from: '#1e3a8a', to: '#3b82f6', amountKey: 'rq.fare' },
  rental: { icon: Car, from: '#3730a3', to: '#6366f1', amountKey: 'rq.fare' },
  equipment: { icon: Tractor, from: '#92400e', to: '#f59e0b', amountKey: 'rq.fare' },
  shadi: { icon: PartyPopper, from: '#9d174d', to: '#ec4899', amountKey: 'rq.fare' },
  dispatch: { icon: Truck, from: '#5b21b6', to: '#8b5cf6', amountKey: 'rq.goodsBudget' },
  city_purchase: { icon: ShoppingCart, from: '#155e75', to: '#06b6d4', amountKey: 'rq.goodsBudget' },
  parcel: { icon: Package, from: '#9a3412', to: '#f97316', amountKey: 'rq.fare' },
  delivery: { icon: ShoppingBag, from: '#166534', to: '#22c55e', amountKey: 'rq.deliveryFee' },
}
const FACT_ICON: Record<QuickActionFactIcon, IconType> = {
  clock: Clock, calendar: CalendarClock, distance: Gauge, wallet: Wallet, wait: Hourglass, urgent: Zap, shop: Store, repeat: Repeat,
  service: Wrench, rate: Tag, truck: Truck, seat: Armchair,
}
const EQUIPMENT_ICON: Record<NonNullable<QuickActionRow['subKind']>, IconType> = { machinery: Construction, tractor: Tractor, loader: Truck }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

function splitRoute(s: string): [string, string] | null {
  const parts = s.split(' → ')
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null
}

async function respond(kind: QuickActionKind, id: string, vehicleId: string | null, accept: boolean, feePkr?: number) {
  const supabase = createClient()
  switch (kind) {
    case 'hourly': return supabase.rpc('respond_hourly_booking', { p_booking_id: id, p_accept: accept })
    case 'rental': return supabase.rpc('respond_rental_booking', { p_booking_id: id, p_accept: accept })
    case 'equipment': return supabase.rpc('respond_equipment_booking', { p_booking_id: id, p_accept: accept })
    case 'shadi': return supabase.rpc('respond_shadi_request', { p_request_id: id, p_accept: accept })
    case 'route': return accept
      ? supabase.rpc('confirm_ride_booking', { p_booking_id: id })
      : supabase.rpc('reject_ride_booking', { p_booking_id: id })
    case 'dispatch': return accept
      ? supabase.rpc('accept_dispatch_call', { p_call_id: id, p_vehicle_id: vehicleId })
      : supabase.rpc('decline_dispatch_call', { p_call_id: id, p_vehicle_id: vehicleId })
    case 'parcel': return accept
      ? supabase.rpc('accept_parcel_delivery', { p_delivery_id: id, p_vehicle_id: vehicleId })
      : supabase.rpc('decline_parcel_delivery_invitation', { p_delivery_id: id, p_vehicle_id: vehicleId })
    case 'delivery': return accept
      ? supabase.rpc('accept_shop_delivery', { p_order_id: id, p_vehicle_id: vehicleId })
      : supabase.rpc('decline_shop_delivery', { p_order_id: id, p_vehicle_id: vehicleId })
    case 'city_purchase': return accept
      ? supabase.rpc('accept_city_purchase_request', { p_request_id: id, p_vehicle_id: vehicleId, p_addon_fee_pkr: feePkr })
      : supabase.rpc('decline_city_purchase_invitation', { p_request_id: id, p_vehicle_id: vehicleId })
    // A broadcast request, not a per-vehicle invitation — there's
    // nothing to "decline" (other drivers can still take it), so this
    // is accept-only; dismissing without deciding already means "not
    // this one," same as every other kind's dismiss-without-decide path.
    case 'ride_dispatch': return accept
      ? supabase.rpc('accept_ride_dispatch', { p_request_id: id })
      : Promise.resolve({ data: null, error: null })
  }
}

interface Props { row: QuickActionRow; vehicleId: string | null; onClose: () => void; onDone: () => void }

export function JobQuickActionSheet({ row: baseRow, vehicleId, onClose, onDone }: Props) {
  const { t, isUrdu } = useLocale()
  // Opened from the Jobs or Requests list, a row only carries its title
  // and amount — fetch the same full details the incoming-request popup
  // shows, so the card looks the same wherever it's opened from.
  const [detail, setDetail] = useState<QuickActionRow | null>(null)
  useEffect(() => {
    if (baseRow.facts !== undefined || !baseRow.needsAction || !vehicleId) return
    const supabase = createClient()
    let live = true
    supabase.from('vehicles').select('commission_mode').eq('id', vehicleId).maybeSingle().then(({ data: v }) =>
      fetchPendingRequestRows(supabase, baseRow.type, vehicleId, { t, isUrdu, commissionMode: (v as { commission_mode: string } | null)?.commission_mode ?? null })
    ).then((rows) => { if (live) setDetail(rows.find((r) => r.id === baseRow.id) ?? null) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRow.type, baseRow.id, vehicleId])
  // Only ever merge details fetched for THIS row — the overlay reuses
  // one sheet for a queue of requests, so a previous row's details must
  // never bleed into the next one.
  const row: QuickActionRow = detail && detail.id === baseRow.id && detail.type === baseRow.type ? { ...baseRow, ...detail } : baseRow
  const router = useRouter()
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [fee, setFee] = useState('')
  // Real ask, 2026-11-02: accepting a ride-dispatch request used to
  // navigate to the Trips list, which the driver then had to find the
  // row on and tap "Open Ride" just to reach this same popup —
  // completely bypassed now by opening it directly off the back of
  // accept_ride_dispatch's own result (my_ongoing_ride() resolves to
  // the booking it just created, same RPC OngoingRideFab/
  // FloatingBookingsHub already trust for this).
  const [rideBookingId, setRideBookingId] = useState<string | null>(null)
  // City purchase: what this driver would actually earn — carry-back
  // (one leg) if he's already going there, else a special trip (777).
  const [cpQuote, setCpQuote] = useState<{ trip_mode: string; total_fare_pkr: number; deliver_within_hours: number; on_route: boolean } | null>(null)
  // Real ask, 2026-11-03: "there is no distance or route showing on
  // this request map, driver own location is not visible there too
  // neither the route map was showing" — the map only ever drew the
  // rider's pickup pin. Now draws both the driver's last-known position
  // (vehicles.current_lat/lng, kept fresh by useVehicleLocationRefresh)
  // and a real OSRM road path between them, same source
  // results/page.tsx's own trip-preview map already uses.
  const [driverRoute, setDriverRoute] = useState<{ lat: number; lng: number }[] | null>(null)
  useEffect(() => {
    if (baseRow.pickupLat == null || baseRow.pickupLng == null || baseRow.driverLat == null || baseRow.driverLng == null) return
    let live = true
    fetchRoadRoute({ lat: baseRow.driverLat, lng: baseRow.driverLng }, { lat: baseRow.pickupLat, lng: baseRow.pickupLng })
      .then((r) => { if (live) setDriverRoute(r.path) })
      .catch(() => { if (live) setDriverRoute(null) })
    return () => { live = false }
  }, [baseRow.pickupLat, baseRow.pickupLng, baseRow.driverLat, baseRow.driverLng])
  useEffect(() => {
    if (baseRow.type !== 'city_purchase' || !baseRow.needsAction || !vehicleId) return
    let live = true
    const id = setTimeout(() => {
      createClient().rpc('city_purchase_quote_for_vehicle', { p_request_id: baseRow.id, p_vehicle_id: vehicleId, p_addon_fee_pkr: fee ? Number(fee) : null })
        .then(({ data }) => { if (live && data) setCpQuote(data as typeof cpQuote) })
    }, 300)
    return () => { live = false; clearTimeout(id) }
  }, [baseRow.type, baseRow.id, baseRow.needsAction, vehicleId, fee])

  // A short buzz when a new request pops up, like every driver app —
  // the driver is often holding the phone with the screen on a map.
  // No-op where the Vibration API isn't available.
  useEffect(() => {
    if (row.needsAction && typeof navigator !== 'undefined') navigator.vibrate?.([180, 90, 180])
  }, [row.id, row.needsAction])

  const act = async (accept: boolean) => {
    if (row.type === 'city_purchase' && accept && !fee.trim()) { toast.error(t('vp.yourServiceFeePlaceholder')); return }
    setBusy(accept ? 'accept' : 'decline')
    const { error } = await respond(row.type, row.id, NEEDS_VEHICLE_ID.has(row.type) ? vehicleId : null, accept, row.type === 'city_purchase' ? Number(fee) : undefined)
    setBusy(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(accept ? t('vp.jobAcceptedToast') : t('vp.jobDeclinedToast'))
    onDone()
    // A ride-dispatch acceptance opens its own ride popup directly
    // below instead of closing — every other kind closes as before.
    if (row.type === 'ride_dispatch' && accept) {
      const { data } = await createClient().rpc('my_ongoing_ride')
      const bookingId = (data as { booking_id: string | null } | null)?.booking_id
      if (bookingId) { setRideBookingId(bookingId); return }
    }
    onClose()
    // Dispatch calls already had this redirect when accepted via the
    // requests page (live tracking lives there) — kept consistent
    // regardless of which entry point the driver accepted from.
    if (row.type === 'dispatch' && accept) router.push(`/portal/marketplace/dispatch/${row.id}`)
  }

  const theme = THEME[row.type]
  const Icon = row.subKind ? EQUIPMENT_ICON[row.subKind] : theme.icon
  const kindLabel = t(row.subKind ? `rq.kind.equipment.${row.subKind}` : `rq.kind.${row.type}`)
  const personTitle = PERSON_TITLE_KINDS.has(row.type)
  const headline = personTitle ? kindLabel : row.title
  const customer = row.customerName ?? (personTitle ? row.title : null)
  const route = row.from && row.to
    ? [row.from, row.to] as const
    : row.from || row.to ? null : splitRoute(row.subtitle) ?? splitRoute(row.title)
  // One known place (an adda, a site) is a single pin, not a route with
  // an empty end. The subtitle is only worth a line of its own when it
  // isn't already shown as the route or the headline.
  const singlePlace = route ? null : (row.from || row.to || (row.subtitle && row.subtitle !== row.title ? row.subtitle : null))
  // Real ask, 2026-11-02: "how far is the rider" should be visible
  // before the driver decides to accept, not discovered after — decided
  // against folding it into the fare (not how Uber/Careem/inDrive do
  // it), so this is purely informational, shown right next to the fare.
  const pickupDistanceKm = row.pickupLat != null && row.pickupLng != null && row.driverLat != null && row.driverLng != null
    ? haversineKm({ lat: row.driverLat, lng: row.driverLng }, { lat: row.pickupLat, lng: row.pickupLng })
    : null

  if (rideBookingId) return <RideLifecycleSheet bookingId={rideBookingId} onClose={() => { setRideBookingId(null); onClose() }} />

  return (
    <div className="fixed inset-0 bg-black/55 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div
        dir={isUrdu ? 'rtl' : 'ltr'}
        className="bg-white w-full sm:max-w-[400px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[94vh] overflow-y-auto shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero — the job kind's own colour, icon, and the fare */}
        <div className="relative px-5 pt-2.5 pb-9 text-white" style={{ backgroundImage: `linear-gradient(135deg, ${theme.from}, ${theme.to})` }}>
          <div className="w-10 h-1 rounded-full bg-white/40 mx-auto sm:hidden" />
          <div className="flex items-center justify-between mt-3">
            {row.needsAction ? (
              <span className="inline-flex items-center gap-1.5 bg-white/20 backdrop-blur px-2.5 py-1 rounded-full font-sans text-[11.5px] font-bold">
                <span className="relative flex w-2 h-2">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-white opacity-75 animate-ping" />
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-white" />
                </span>
                {t('rq.newRequest')}
              </span>
            ) : <span />}
            <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center cursor-pointer">
              <XIcon size={16} />
            </button>
          </div>

          <div className="flex items-center gap-3.5 mt-4">
            <div className="relative shrink-0">
              {row.needsAction && <span className="absolute inset-0 rounded-2xl bg-white/30 animate-ping [animation-duration:1.8s]" />}
              <div className="relative w-14 h-14 rounded-2xl bg-white/20 ring-1 ring-white/30 flex items-center justify-center">
                <Icon size={28} strokeWidth={2} />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              {!personTitle && <p className="font-sans text-[11.5px] font-semibold text-white/80">{kindLabel}</p>}
              <p className="font-sans text-[18px] font-extrabold leading-tight line-clamp-2"><bdi>{headline}</bdi></p>
            </div>
          </div>

          <div className="flex items-end justify-between mt-4 gap-3">
            {row.amount != null && (
              <div className="min-w-0">
                <p className="font-sans text-[11.5px] font-semibold text-white/80">{t(theme.amountKey)}</p>
                <p className="font-sans text-[32px] font-black leading-none mt-1"><span className="ltr-num">₨{fmt(row.amount)}</span></p>
              </div>
            )}
            {pickupDistanceKm != null && (
              <span className="shrink-0 inline-flex items-center gap-1 bg-white/20 backdrop-blur px-2.5 py-1.5 rounded-full font-sans text-[12.5px] font-bold">
                <MapPin size={13} /> <span className="ltr-num">{pickupDistanceKm < 1 ? `${Math.round(pickupDistanceKm * 1000)} m` : `${pickupDistanceKm.toFixed(1)} km`}</span> {t('rq.pickupDistanceSuffix')}
              </span>
            )}
          </div>
        </div>

        {/* Body sits over the hero's bottom edge, like a card pulled up */}
        <div className="relative -mt-5 bg-white rounded-t-[24px] px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-4">
          {(customer || row.riderVillage || row.riderTrust) && (
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full flex items-center justify-center font-sans text-[16px] font-bold text-white shrink-0" style={{ backgroundColor: theme.from }}>
                {customer?.trim() ? customer.trim().charAt(0).toUpperCase() : <User size={20} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-sans text-[14.5px] font-bold text-[#0f172a] truncate"><bdi>{customer ?? t('rq.customer')}</bdi></p>
                {row.riderVillage && <p className="font-sans text-[12px] text-[#64748b] truncate">{t('mb.riderFromVillageLabel').replace('{village}', row.riderVillage)}</p>}
              </div>
              {row.riderTrust !== undefined && <TrustPill trust={row.riderTrust} />}
            </div>
          )}

          {route && (
            <div className="rounded-2xl border border-[#e8eaee] p-3.5">
              <div className="flex gap-3">
                <div className="flex flex-col items-center pt-1">
                  <span className="w-3 h-3 rounded-full border-[3px] border-[#16a34a] bg-white" />
                  <span className="w-0.5 flex-1 my-1 bg-[repeating-linear-gradient(to_bottom,#cbd5e1_0_4px,transparent_4px_8px)]" />
                  <span className="w-3 h-3 rounded-[3px] bg-[#0f172a]" />
                </div>
                <div className="min-w-0 flex-1 flex flex-col gap-3">
                  <div>
                    <p className="font-sans text-[11px] font-semibold text-[#94a3b8]">{t('rq.pickup')}</p>
                    <p className="font-sans text-[14px] font-semibold text-[#0f172a] leading-snug"><bdi>{route[0] || '—'}</bdi></p>
                  </div>
                  <div>
                    <p className="font-sans text-[11px] font-semibold text-[#94a3b8]">{t('rq.dropoff')}</p>
                    <p className="font-sans text-[14px] font-semibold text-[#0f172a] leading-snug"><bdi>{route[1] || '—'}</bdi></p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Real ask, 2026-11-02: "the location of the rider will be
              also shown on the request in a clear beautiful stylish
              way" — a real pin beats another line of address text a
              driver has to read while deciding. Only ride_dispatch
              carries real coordinates (779); every other kind keeps
              its plain text-only card above. */}
          {row.pickupLat != null && row.pickupLng != null && (
            <div className="rounded-2xl overflow-hidden border border-[#e8eaee] relative">
              <LeafletMap
                height="150px"
                zoom={14}
                center={[row.pickupLat, row.pickupLng]}
                route={driverRoute ?? undefined}
                pins={[
                  { lat: row.pickupLat, lng: row.pickupLng, label: t('rq.riderLocationLabel'), emoji: '📍', color: '#16a34a' } as LeafletPin,
                  ...(row.driverLat != null && row.driverLng != null
                    ? [{ lat: row.driverLat, lng: row.driverLng, label: t('rq.yourLocationLabel'), isVehicle: true } as LeafletPin]
                    : []),
                ]}
              />
              <span className="absolute top-2 start-2 bg-white/95 backdrop-blur px-2 py-0.5 rounded-full font-sans text-[10.5px] font-bold text-[#166534] shadow-sm flex items-center gap-1">
                <MapPin size={11} /> {t('rq.riderLocationLabel')}
              </span>
              {row.driverLat == null && (
                <span className="absolute bottom-2 start-2 end-2 bg-amber-50/95 backdrop-blur px-2.5 py-1 rounded-lg font-sans text-[10.5px] font-semibold text-amber-800 shadow-sm">
                  {t('rq.yourLocationUnknownNote')}
                </span>
              )}
            </div>
          )}

          {singlePlace && (
            <div className="rounded-2xl border border-[#e8eaee] p-3.5 flex items-start gap-3">
              <span className="w-8 h-8 rounded-full bg-[#f1f5f9] flex items-center justify-center shrink-0"><MapPin size={16} className="text-[#0f172a]" /></span>
              <div className="min-w-0">
                <p className="font-sans text-[11px] font-semibold text-[#94a3b8]">{t('rq.location')}</p>
                <p className="font-sans text-[14px] font-semibold text-[#0f172a] leading-snug"><bdi>{singlePlace}</bdi></p>
              </div>
            </div>
          )}

          {row.facts && row.facts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {row.facts.map((f, i) => {
                const FactIcon = FACT_ICON[f.icon]
                return (
                  <span key={i} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full font-sans text-[12.5px] font-semibold ${f.icon === 'urgent' ? 'bg-[#fef2f2] text-[#b91c1c]' : 'bg-[#f1f5f9] text-[#334155]'}`}>
                    <FactIcon size={14} /> <bdi>{f.text}</bdi>
                  </span>
                )
              })}
            </div>
          )}

          {row.note && (
            <div className="rounded-2xl bg-[#fffbeb] border border-[#fde68a] p-3 flex gap-2.5">
              <MessageSquareQuote size={16} className="text-[#b45309] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-sans text-[11px] font-semibold text-[#b45309]">{t('rq.customerNote')}</p>
                <p className="font-sans text-[13px] text-[#451a03] leading-snug break-words"><bdi>{row.note}</bdi></p>
              </div>
            </div>
          )}

          {row.needsAction ? (
            <>
              {row.type === 'city_purchase' && (
                <div>
                  <input type="number" inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} placeholder={t('vp.yourServiceFeePlaceholder')} className="dp2-input" />
                  <p className="font-sans text-[11px] text-[#64748b] mt-1">{t('vp.serviceFeeBandHint')}</p>
                  {cpQuote && (
                    <div className="mt-2 flex items-center justify-between rounded-xl bg-[#f0fdf4] border border-[#bbf7d0] px-3 py-2">
                      <span className="font-sans text-[12px] font-semibold text-[#166534]">
                        {cpQuote.trip_mode === 'carry_back' ? `🚗↩ ${t('cpx.carryTitle')}` : `🚗⇄ ${t('cpx.dedicatedTitle')}`} · {t('cpx.withinHours').replace('{h}', String(cpQuote.deliver_within_hours))}
                      </span>
                      <span className="font-sans text-[14px] font-extrabold text-[#14532d]"><span className="ltr-num">₨{fmt(cpQuote.total_fare_pkr)}</span></span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2.5">
                {row.type !== 'ride_dispatch' && !row.isBroadcast && (
                  <button onClick={() => act(false)} disabled={busy !== null}
                    className="flex-1 h-[52px] flex items-center justify-center gap-1.5 rounded-2xl bg-[#fef2f2] text-[#b91c1c] font-sans text-[14.5px] font-bold cursor-pointer active:scale-[0.98] transition-transform disabled:opacity-50">
                    {busy === 'decline' ? <Loader2 size={17} className="animate-spin" /> : <XIcon size={17} />} {t('vp.declineBtn')}
                  </button>
                )}
                <button onClick={() => act(true)} disabled={busy !== null}
                  className="flex-[1.6] h-[52px] flex items-center justify-center gap-1.5 rounded-2xl bg-[#15803d] text-white font-sans text-[15px] font-bold shadow-[0_8px_20px_-6px_rgba(21,128,61,0.6)] cursor-pointer active:scale-[0.98] transition-transform disabled:opacity-50">
                  {busy === 'accept' ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} strokeWidth={3} />} {t('vp.acceptBtn')}
                </button>
              </div>
            </>
          ) : row.infoNote ? (
            <div className="rounded-2xl bg-[#eff6ff] border border-[#bfdbfe] p-3 flex gap-2.5">
              <Info size={16} className="text-[#1d4ed8] shrink-0 mt-0.5" />
              <p className="font-sans text-[13px] text-[#1e3a8a] leading-snug">{row.infoNote}</p>
            </div>
          ) : (
            <p className="text-center font-sans text-[12.5px] text-[#64748b]">{t('vp.openFullDetailsHint')}</p>
          )}

          <Link href={row.href} onClick={onClose} className="flex items-center justify-center gap-1 font-sans text-[13px] font-semibold text-[#475569] py-1">
            {t('vp.viewFullDetailsBtn')} <ChevronRight size={15} className="rtl:rotate-180" />
          </Link>
        </div>
      </div>
    </div>
  )
}
