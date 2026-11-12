'use client'

// Bookings screen (v.rTrips) — the real, nav-linked "Bookings" tab
// (MobilityBottomNav → /portal/marketplace/trips). A unified list
// merging every vertical's own real "my bookings" source into one
// normalized shape. No new backend: every source here is an RPC/table
// that already existed before this page.
//
// 2026-10-17: this page used to also have its own "Browse" tab running
// the OLD trip-share propose/counter-offer negotiation flow
// (propose_trip_fare etc.) — a second, stale entry point into exactly
// the bug the Shared Ride screen (/portal/marketplace/shared) was just
// fixed to not have any more (fixed fares, instant booking,
// book_trip_offer). Removed entirely rather than re-built twice;
// browsing/booking a shared ride now only happens on that one screen.
// Also fixed here: every row in this list used the same
// equipment/owner-centric status labels ("Waiting for owner") even for
// vehicle bookings that should say "driver", and only the trip-share
// row type ever got a working tap-through to a detail page even though
// shadi and city-purchase both have real detail pages of their own.
//
// Real ask, 2026-10-21: "a real app doesn't save a booking in a
// separate option" — rental, parcel, and dispatch calls previously had
// NO entry here at all (rental only lived on its own creation page's
// "mine" tab; parcel and dispatch calls had no index at all), so a
// confirmed booking of those three types genuinely was stuck somewhere
// a rider would never think to look. my_rental_bookings/
// my_parcel_deliveries/my_dispatch_calls already existed as real RPCs —
// this just merges them in the same way every other kind here already
// is. dispatch_calls' "as_role" field is read here but currently
// unused (always 'user' for a rider on this page) — kept for when a
// driver-facing view of this same list gets built.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { Receipt, Users, Clock, Wrench, Bus, Sparkles, ShoppingBag, Car, Package, Phone, Store, Navigation, CalendarDays, AlertCircle, Search } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { BookingQuickViewSheet, type QuickViewKind } from '@/components/mobility/BookingQuickViewSheet'
import { RouteBookingSheet } from '@/components/mobility/RouteBookingSheet'
import { RideLifecycleSheet } from '@/components/portal/RideLifecycleSheet'

type Kind = 'trip' | 'hourly' | 'equipment' | 'ride' | 'shadi' | 'cityPurchase' | 'rental' | 'parcel' | 'dispatch' | 'shop' | 'rideDispatch' | 'monthly'
interface BookingRow { id: string; rawId: string; kind: Kind; title: string; subtitle: string; amount: number | null; status: 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'completed'; date: string; href: string | null; note?: string; routeId?: string | null; proofUrl?: string | null }
// Real ask: hourly/equipment/ride rows used to send the rider to a
// generic, unscoped browse page instead of their own booking — these 3
// now pop up that one booking's own status/actions instead (see
// BookingQuickViewSheet). trip/shadi/cityPurchase go to real, rich
// detail pages and keep navigating there, deliberately.
const QUICK_VIEW_KINDS = new Set<Kind>(['hourly', 'equipment', 'ride', 'rental'])
function isQuickViewKind(k: Kind): k is QuickViewKind { return QUICK_VIEW_KINDS.has(k) }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
const STATUS_STYLE: Record<BookingRow['status'], { bg: string; fg: string }> = {
  pending: { bg: '#fef3c7', fg: '#92400e' }, confirmed: { bg: '#dcfce7', fg: '#166534' },
  declined: { bg: '#fee2e2', fg: '#b91c1c' }, cancelled: { bg: '#f1f5f9', fg: '#64748b' }, completed: { bg: '#e0f2fe', fg: '#0369a1' },
}
// Per-kind icon + tint for each row's leading badge, matching the reference
// design's tinted-icon-circle pattern on its own bookings list — reuses the
// same tint tokens the rest of the app's category belt/service tiles use.
const KIND_ICON: Record<Kind, typeof Users> = {
  trip: Users, hourly: Clock, equipment: Wrench, ride: Bus, shadi: Sparkles,
  cityPurchase: ShoppingBag, rental: Car, parcel: Package, dispatch: Phone, shop: Store, rideDispatch: Navigation, monthly: CalendarDays,
}
const KIND_TINT: Record<Kind, string> = {
  trip: '#e0f2fe', hourly: '#fef9c3', equipment: '#fde68a', ride: '#dcfce7', shadi: '#fce7f3',
  cityPurchase: '#ffe4e6', rental: '#f3e8ff', parcel: '#ffedd5', dispatch: '#e0e7ff', shop: '#fff7ed', rideDispatch: '#dbeafe', monthly: '#ccfbf1',
}
// Our status model has 3 real stages (pending → confirmed → completed), not the
// reference's 4 (requested/accepted/ontheway/completed) — every kind here only
// ever actually passes through 3, so the progress dots stay honest to that
// instead of padding in a 4th step nothing ever reaches.
const STEP: Record<BookingRow['status'], number> = { pending: 0, confirmed: 1, completed: 2, declined: 0, cancelled: 0 }
// dispatch_calls/parcel_deliveries add a few statuses the original 4-kind
// mapping never had to handle: 'no_answer' (nobody picked up — a dead end,
// same bucket as declined), 'approved'/'picked_up'/'delivered' (driver
// committed, trip under way — same bucket as 'accepted'/'in_progress').
function mapStatus(s: string): BookingRow['status'] {
  if (s === 'completed') return 'completed'
  if (s === 'cancelled') return 'cancelled'
  if (['declined', 'rejected', 'no_answer', 'expired'].includes(s)) return 'declined'
  if (['confirmed', 'accepted', 'announced', 'in_progress', 'approved', 'picked_up', 'delivered'].includes(s)) return 'confirmed'
  return 'pending'
}
// Equipment/machinery bookings are keyed to an "owner"; every other
// kind here is a vehicle booking and should read "driver" instead.
function statusKey(kind: Kind, status: BookingRow['status']): string {
  if (kind === 'equipment') return `vp.equipmentStatus.${status === 'confirmed' ? 'accepted' : status === 'pending' ? 'requested' : status}`
  return `vp.vehicleBookingStatus.${status}`
}

export default function TripsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [rows, setRows] = useState<BookingRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [openRow, setOpenRow] = useState<BookingRow | null>(null)
  const [openRouteId, setOpenRouteId] = useState<string | null>(null)
  const [openTripBookingId, setOpenTripBookingId] = useState<string | null>(null)
  const [seg, setSeg] = useState<'active' | 'past'>('active')
  const [disputedIds, setDisputedIds] = useState<Set<string>>(new Set())
  const [disputingRow, setDisputingRow] = useState<BookingRow | null>(null)
  const [disputeAmount, setDisputeAmount] = useState('')
  const [disputeNote, setDisputeNote] = useState('')
  const [filingDispute, setFilingDispute] = useState(false)

  const reloadMine = async () => {
    const [tripShare, hourly, equipment, ride, shadi, cityPurchase, rental, parcel, dispatch, shop, rideDispatch, monthly] = await Promise.all([
      supabase.rpc('my_trip_bookings'),
      supabase.rpc('my_hourly_bookings'),
      supabase.rpc('my_equipment_bookings'),
      // Filtered to the signed-in rider: ride_bookings' keeper policy also
      // lets a driver read every booking on their own routes, which landed
      // other people's seats in the driver's own "My Bookings".
      supabase.from('ride_bookings').select('id, route_id, status, total_amount_pkr, travel_date, announced_proof_url, dropped_off_at, vehicle_routes(origin, origin_ur, destination, destination_ur)').eq('portal_user_id', user!.id).order('created_at', { ascending: false }).limit(20),
      supabase.rpc('my_shadi_events'),
      supabase.rpc('my_city_purchase_requests'),
      supabase.rpc('my_rental_bookings'),
      supabase.rpc('my_parcel_deliveries'),
      supabase.rpc('my_dispatch_calls'),
      supabase.from('shop_orders').select('id, status, total_amount_pkr, fulfillment_status, created_at, shops(name, name_ur)').eq('portal_user_id', user!.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('ride_dispatch_requests').select('id, status, fare_pkr, pickup_label, dropoff_label, created_at').eq('initiator_portal_user_id', user!.id).order('created_at', { ascending: false }).limit(20),
      // Monthly "Teacher Van" seats (723) — a parent's or office worker's
      // standing booking used to be reachable only by finding the route
      // again; now it sits here with everything else, plus any fee due.
      supabase.from('route_subscriptions').select('id, route_id, status, monthly_fee_pkr, applied_at, vehicle_routes(origin, origin_ur, destination, destination_ur, departure_time), route_subscription_charges(amount_pkr, status)').eq('portal_user_id', user!.id).neq('status', 'cancelled').order('applied_at', { ascending: false }),
    ])
    if (tripShare.error) toast.error(friendlyError(tripShare.error, undefined, isUrdu))

    const out: BookingRow[] = []
    for (const b of (tripShare.data ?? []) as Array<{ id: string; status: string; total_amount_pkr: number; created_at: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; travel_date: string }>) {
      out.push({ id: `trip-${b.id}`, rawId: b.id, kind: 'trip', title: t('vp.sharedRideHeading'), subtitle: `${isUrdu && b.origin_ur ? b.origin_ur : b.origin} → ${isUrdu && b.destination_ur ? b.destination_ur : b.destination}`, amount: b.total_amount_pkr, status: mapStatus(b.status), date: b.travel_date, href: `/portal/marketplace/trip/${b.id}` })
    }
    for (const b of (hourly.data ?? []) as Array<{ id: string; model: string | null; vehicle_type: string; total_amount_pkr: number | null; base_amount_pkr: number; status: string; requested_at: string }>) {
      out.push({ id: `hourly-${b.id}`, rawId: b.id, kind: 'hourly', title: t('vp.hourlyPageTitle'), subtitle: vehicleDisplayName(b.vehicle_type, b.model), amount: b.total_amount_pkr ?? b.base_amount_pkr, status: mapStatus(b.status), date: b.requested_at, href: '/portal/marketplace/hourly' })
    }
    for (const b of (equipment.data ?? []) as Array<{ id: string; kind: string; model: string | null; vehicle_type: string; total_amount_pkr: number | null; rate_pkr: number; status: string; requested_at: string }>) {
      out.push({ id: `equip-${b.id}`, rawId: b.id, kind: 'equipment', title: t(`vp.${b.kind}PageTitle`), subtitle: vehicleDisplayName(b.vehicle_type, b.model), amount: b.total_amount_pkr ?? b.rate_pkr, status: mapStatus(b.status), date: b.requested_at, href: `/portal/marketplace/${b.kind}` })
    }
    for (const b of (ride.data ?? []) as unknown as Array<{ id: string; route_id: string | null; status: string; total_amount_pkr: number; travel_date: string; announced_proof_url: string | null; dropped_off_at: string | null; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null }>) {
      const vr = b.vehicle_routes
      // Real bug reported live: a seat already boarded AND dropped off
      // (end_route_run) kept showing in the Active tab forever — status
      // alone only ever tracks payment ('announced'/'confirmed'), never
      // the physical trip, so dropped_off_at is the real completion signal.
      out.push({ id: `ride-${b.id}`, rawId: b.id, kind: 'ride', title: vr ? t('mv.tab.routes') : t('af.addaBoardPageTitle'), subtitle: vr ? `${isUrdu && vr.origin_ur ? vr.origin_ur : vr.origin} → ${isUrdu && vr.destination_ur ? vr.destination_ur : vr.destination}` : '—', amount: b.total_amount_pkr, status: b.dropped_off_at ? 'completed' : mapStatus(b.status), date: b.travel_date, href: '/portal/marketplace', routeId: b.route_id, proofUrl: b.announced_proof_url })
    }
    for (const e of (shadi.data ?? []) as Array<{ id: string; event_date: string; venue_address: string; status: string; advance_amount_pkr: number | null; created_at: string }>) {
      out.push({ id: `shadi-${e.id}`, rawId: e.id, kind: 'shadi', title: t('vp.shadiPageTitle'), subtitle: e.venue_address, amount: e.advance_amount_pkr, status: mapStatus(e.status), date: e.event_date || e.created_at, href: `/portal/marketplace/shadi/${e.id}` })
    }
    for (const r of (cityPurchase.data ?? []) as Array<{ id: string; item: string; status: string; total_fare_pkr: number | null; created_at: string; city_name: string; city_name_ur: string | null }>) {
      out.push({ id: `cp-${r.id}`, rawId: r.id, kind: 'cityPurchase', title: t('vp.cityPurchasePageTitle'), subtitle: `${r.item} · ${isUrdu && r.city_name_ur ? r.city_name_ur : r.city_name}`, amount: r.total_fare_pkr, status: mapStatus(r.status), date: r.created_at, href: `/portal/marketplace/city-purchase/${r.id}` })
    }
    for (const b of (rental.data ?? []) as Array<{ id: string; vehicle_type: string; model: string | null; total_amount_pkr: number | null; base_amount_pkr: number; status: string; requested_at: string; from_address: string; to_address: string }>) {
      out.push({ id: `rental-${b.id}`, rawId: b.id, kind: 'rental', title: t('vp.rentalPageTitle'), subtitle: `${b.from_address} → ${b.to_address}`, amount: b.total_amount_pkr ?? b.base_amount_pkr, status: mapStatus(b.status), date: b.requested_at, href: null })
    }
    for (const p of (parcel.data ?? []) as Array<{ id: string; description: string; status: string; total_fare_pkr: number | null; created_at: string; city_name: string; city_name_ur: string | null }>) {
      out.push({ id: `parcel-${p.id}`, rawId: p.id, kind: 'parcel', title: t('vp.parcelPageTitle'), subtitle: `${p.description} · ${isUrdu && p.city_name_ur ? p.city_name_ur : p.city_name}`, amount: p.total_fare_pkr, status: mapStatus(p.status), date: p.created_at, href: `/portal/marketplace/parcel/${p.id}` })
    }
    for (const d of (dispatch.data ?? []) as Array<{ id: string; item: string; status: string; total_pkr: number | null; created_at: string; shop_name: string }>) {
      out.push({ id: `dispatch-${d.id}`, rawId: d.id, kind: 'dispatch', title: t('vp.dispatchPageTitle'), subtitle: `${d.item} · ${d.shop_name}`, amount: d.total_pkr, status: mapStatus(d.status), date: d.created_at, href: `/portal/marketplace/dispatch/${d.id}` })
    }
    for (const o of (shop.data ?? []) as unknown as Array<{ id: string; status: string; total_amount_pkr: number; fulfillment_status: string; created_at: string; shops: { name: string; name_ur: string | null } | null }>) {
      out.push({ id: `shop-${o.id}`, rawId: o.id, kind: 'shop', title: isUrdu && o.shops?.name_ur ? o.shops.name_ur : o.shops?.name ?? '—', subtitle: o.fulfillment_status, amount: o.total_amount_pkr, status: mapStatus(o.status), date: o.created_at, href: `/portal/marketplace/order/${o.id}` })
    }
    for (const r of (rideDispatch.data ?? []) as Array<{ id: string; status: string; fare_pkr: number; pickup_label: string; dropoff_label: string; created_at: string }>) {
      out.push({ id: `rd-${r.id}`, rawId: r.id, kind: 'rideDispatch', title: t('vp.rideDispatchPageTitle'), subtitle: `${r.pickup_label} → ${r.dropoff_label}`, amount: r.fare_pkr, status: mapStatus(r.status), date: r.created_at, href: `/portal/marketplace/ride-dispatch/${r.id}` })
    }

    for (const m of (monthly.data ?? []) as unknown as Array<{ id: string; route_id: string; status: string; monthly_fee_pkr: number; applied_at: string; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; departure_time: string | null } | null; route_subscription_charges: { amount_pkr: number; status: string }[] | null }>) {
      const vr = m.vehicle_routes
      const route = vr ? `${isUrdu && vr.origin_ur ? vr.origin_ur : vr.origin} → ${isUrdu && vr.destination_ur ? vr.destination_ur : vr.destination}${vr.departure_time ? ` · ${vr.departure_time.slice(0, 5)}` : ''}` : '—'
      const due = (m.route_subscription_charges ?? []).filter((c) => c.status === 'due').reduce((sum, c) => sum + Number(c.amount_pkr), 0)
      out.push({
        id: `monthly-${m.id}`, rawId: m.id, kind: 'monthly', title: t('mb.monthlySeatTitle'),
        subtitle: route, note: due > 0 ? t('mb.feeDueLabel').replace('{amount}', fmt(due)) : undefined,
        amount: m.monthly_fee_pkr, status: m.status === 'waitlisted' ? 'pending' : 'confirmed',
        date: m.applied_at, href: `/portal/marketplace/route/${m.route_id}`,
      })
    }

    out.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    setRows(out)

    const { data: disputes } = await supabase.from('disputes').select('ref_id').eq('ref_type', 'ride_booking').eq('filed_by_portal_user_id', user!.id)
    setDisputedIds(new Set(((disputes ?? []) as { ref_id: string }[]).map((d) => d.ref_id)))
  }

  useEffect(() => {
    if (!user) return
    reloadMine().then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const fileUnrefundedDispute = async () => {
    if (!disputingRow || !disputeNote.trim()) { toast.error(t('mp.disputeNoteRequiredError')); return }
    setFilingDispute(true)
    const { error } = await supabase.rpc('file_dispute', {
      p_kind: 'unrefunded_payment', p_ref_type: 'ride_booking', p_ref_id: disputingRow.rawId,
      p_claimed_amount_pkr: disputeAmount ? Number(disputeAmount) : disputingRow.amount, p_note: disputeNote.trim(),
    })
    setFilingDispute(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.disputeFiledToast'))
    setDisputedIds((prev) => new Set(prev).add(disputingRow.rawId))
    setDisputingRow(null); setDisputeAmount(''); setDisputeNote('')
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  const active = (rows ?? []).filter((r) => !['completed', 'cancelled', 'declined'].includes(r.status))
  const past = (rows ?? []).filter((r) => ['completed', 'cancelled', 'declined'].includes(r.status))
  const shown = seg === 'active' ? active : past

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Receipt size={19} /> {t('mb.myBookingsHeading')}</h1>

      <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#f2f1e8]">
        {(['active', 'past'] as const).map((k) => (
          <button key={k} onClick={() => setSeg(k)}
            className="rounded-[9px] py-1.5 text-[12.5px] font-bold cursor-pointer"
            style={{ background: seg === k ? '#166534' : 'transparent', color: seg === k ? '#fff' : '#64748b', boxShadow: seg === k ? '0 1px 2px rgba(0,0,0,.1)' : 'none' }}>
            {k === 'active' ? `${t('mb.bookingsActiveTab')} (${active.length})` : t('mb.bookingsPastTab')}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {shown.length === 0 && <p className="text-center py-10 text-[#94a3b8] text-[13.5px]">{t('vp.noEquipmentBookingsHint')}</p>}
        {shown.map((r) => {
          const style = STATUS_STYLE[r.status]
          const Icon = KIND_ICON[r.kind]
          const step = STEP[r.status]
          const cancelled = r.status === 'cancelled' || r.status === 'declined'
          const content = (
            <>
              <span className="flex items-center gap-2.5 w-full">
                <span className="shrink-0 w-[34px] h-[34px] rounded-[11px] flex items-center justify-center" style={{ background: KIND_TINT[r.kind] }}><Icon size={16} className="text-[#1e293b]/70" /></span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] font-bold text-[#1e293b] truncate">{r.title}</span>
                  <span className="block text-[12px] text-[#64748b] truncate mt-0.5">{r.subtitle}</span>
                </span>
                {r.amount != null && <span className="shrink-0 font-extrabold text-[13px] text-[#005A36] ltr-num">{fmt(r.amount)}</span>}
              </span>
              <span className="flex items-center justify-between gap-2 w-full">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[9.5px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ background: style.bg, color: style.fg }}>{t(statusKey(r.kind, r.status))}</span>
                  {r.note && <span className="text-[9.5px] font-bold px-2 py-0.5 rounded-full truncate bg-amber-100 text-amber-800">{r.note}</span>}
                </span>
                <span dir="ltr" className="flex items-center gap-[3px]">
                  {[0, 1, 2].map((i) => <span key={i} className="w-[18px] h-1 rounded-full" style={{ background: cancelled ? '#fecaca' : i <= step ? '#16a34a' : '#e5e2d0' }} />)}
                  {r.date && <span className="font-sans text-[9px] text-[#94a3b8] ms-1 ltr-num">{new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                </span>
              </span>
            </>
          )
          const cls = 'w-full text-start bg-white border border-[#e5e2d0] rounded-2xl p-3 flex flex-col gap-2 cursor-pointer hover:border-[#166534]'
          // A route-based seat booking opens the real, rich popup (map,
          // stops, cancel/reschedule) this session built — not the old
          // plain quick-view, which has no map at all. An adda-based ride
          // booking (no route_id) has no route to map, so it keeps the
          // quick-view as before.
          if (r.kind === 'ride' && r.routeId) {
            // Real gap reported live: a rider who paid the driver
            // directly (the whole seat system is direct P2P payment, no
            // platform escrow) then had to cancel before the driver
            // confirmed had no way to escalate "I paid and wasn't
            // refunded" — only shown once there's a real receipt
            // attached to dispute about.
            const showDisputeAction = r.status === 'cancelled' && !!r.proofUrl
            return (
              <div key={r.id} className="flex flex-col gap-1.5">
                <button onClick={() => setOpenRouteId(r.routeId!)} className={cls}>{content}</button>
                {r.status === 'cancelled' && (
                  <div className="flex gap-1.5 px-1">
                    {showDisputeAction && (
                      disputedIds.has(r.rawId) ? (
                        <span className="flex-1 text-center font-sans text-[11px] font-semibold text-[#64748b] bg-[#f1f5f9] rounded-lg py-1.5">{t('mp.disputeAlreadyFiledHint')}</span>
                      ) : (
                        <button onClick={() => { setDisputingRow(r); setDisputeAmount(r.amount != null ? String(r.amount) : ''); setDisputeNote('') }}
                          className="flex-1 flex items-center justify-center gap-1 font-sans text-[11px] font-semibold text-[#b91c1c] bg-red-50 border border-red-200 rounded-lg py-1.5 cursor-pointer">
                          <AlertCircle size={12} /> {t('mp.reportUnrefundedBtn')}
                        </button>
                      )
                    )}
                    <Link href="/portal/marketplace/buses" className="flex-1 flex items-center justify-center gap-1 font-sans text-[11px] font-semibold text-[#166534] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg py-1.5">
                      <Search size={12} /> {t('mp.findAnotherRideBtn')}
                    </Link>
                  </div>
                )}
                {disputingRow?.id === r.id && (
                  <div className="bg-white border border-[#e5e2d0] rounded-xl p-3 flex flex-col gap-2">
                    <label className="block font-sans text-[10.5px] font-bold text-[#64748b]">{t('mp.claimedAmountLabel')}</label>
                    <input type="number" value={disputeAmount} onChange={(e) => setDisputeAmount(e.target.value)} className="px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12.5px] ltr-num" />
                    <label className="block font-sans text-[10.5px] font-bold text-[#64748b]">{t('mp.disputeNoteLabel')}</label>
                    <textarea value={disputeNote} onChange={(e) => setDisputeNote(e.target.value)} rows={2} placeholder={t('mp.disputeNotePlaceholder')} className="px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12.5px]" />
                    <div className="flex gap-2">
                      <button onClick={fileUnrefundedDispute} disabled={filingDispute} className="flex-1 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12px] font-bold cursor-pointer disabled:opacity-50">{filingDispute ? t('action.loading') : t('mp.submitDisputeBtn')}</button>
                      <button onClick={() => setDisputingRow(null)} className="flex-1 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
                    </div>
                  </div>
                )}
              </div>
            )
          }
          // Real fix, 2026-11-08: this used to navigate to the old
          // primitive, page-only tracking screen (no background
          // geolocation). Opens the same rich RideLifecycleSheet the
          // driver's and the Shared Ride browse screen's own bookings
          // now use instead.
          if (r.kind === 'trip') {
            return (
              <button key={r.id} onClick={() => setOpenTripBookingId(r.rawId)} className={cls}>{content}</button>
            )
          }
          if (isQuickViewKind(r.kind)) {
            return (
              <button key={r.id} onClick={() => setOpenRow(r)} className={cls}>{content}</button>
            )
          }
          return r.href ? (
            <Link key={r.id} href={r.href} className={cls}>{content}</Link>
          ) : (
            <div key={r.id} className={cls.replace(' cursor-pointer hover:border-[#166534]', '')}>{content}</div>
          )
        })}
      </div>

      {openRow && isQuickViewKind(openRow.kind) && (
        <BookingQuickViewSheet
          kind={openRow.kind}
          rawId={openRow.rawId}
          onClose={() => setOpenRow(null)}
          onChanged={reloadMine}
        />
      )}
      {openRouteId && (
        <RouteBookingSheet routeId={openRouteId} onClose={() => { setOpenRouteId(null); reloadMine() }} />
      )}
      {openTripBookingId && (
        <RideLifecycleSheet bookingId={openTripBookingId} onClose={() => { setOpenTripBookingId(null); reloadMine() }} />
      )}
    </div>
  )
}
