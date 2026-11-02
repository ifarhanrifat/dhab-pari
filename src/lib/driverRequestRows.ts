// Every "a new job is waiting on you" row a driver can receive, built
// once with each service's own details — so the incoming-request popup
// (PendingRequestOverlay), and the same popup opened from the Jobs or
// Requests list, always show the same thing for the same job.
//
// Real ask, 2026-10-30: "there are different drivers with different
// vehicles and the requests should contain the features which those
// services already have." Each kind below reads only what that
// service's own RPC/table already returns — no new backend:
//   hourly      hours, included km, payment, note, customer trust
//   rental      from → to, one-way/return, km, wait hours, payment, note, trust
//   equipment   machinery / tractor (+ the farm service asked for) / loader
//               (+ material, trips), schedule, rate, delivery fee, payment, note
//   shadi       car class, event date, distance to venue, note, trust
//   route/adda  route or adda, travel date + departure, seats, payment —
//               and, for a lump-sum vehicle, no Accept at all: only the
//               committee can confirm those (confirm_ride_booking), so
//               the driver sees "committee is verifying payment" instead
//   ride        pickup → drop-off, category, rider village + trust
//   dispatch    shop, city, tier, delivery address, customer trust
//   city buy    urgency, city, pickup, destination
//   parcel      pickup → drop-off, city
//   delivery    shop → customer address, village, delivery fee

import type { createClient } from '@/lib/supabase/client'
import type { QuickActionKind, QuickActionRow } from '@/components/mobility/JobQuickActionSheet'

type Supabase = ReturnType<typeof createClient>
type Fact = NonNullable<QuickActionRow['facts']>[number]
type Trust = QuickActionRow['riderTrust']
export interface RowCtx { t: (key: string) => string; isUrdu: boolean; commissionMode: string | null }

const n = (ctx: RowCtx, key: string, v: number | string) => ctx.t(key).replace('{n}', String(v))
const pkr = (v: number) => `₨${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
const loc = (ctx: RowCtx, en: string | null | undefined, ur: string | null | undefined) => (ctx.isUrdu && ur ? ur : en) ?? ''

function payFact(ctx: RowCtx, method: string | null | undefined): Fact[] {
  if (method === 'cash') return [{ icon: 'wallet', text: ctx.t('rq.cash') }]
  if (method === 'credit') return [{ icon: 'wallet', text: ctx.t('rq.credit') }]
  return []
}
function whenFact(ctx: RowCtx, date: string | null | undefined, time: string | null | undefined): Fact[] {
  if (!date) return []
  const d = new Date(`${date.slice(0, 10)}T${time ? time.slice(0, 5) : '00:00'}:00`)
  if (isNaN(d.getTime())) return []
  const l = ctx.isUrdu ? 'ur-PK' : 'en-PK'
  const day = d.toLocaleDateString(l, { weekday: 'short', day: 'numeric', month: 'short' })
  return [{ icon: 'calendar', text: time ? `${day} · ${d.toLocaleTimeString(l, { hour: 'numeric', minute: '2-digit' })}` : day }]
}
const when = (cond: unknown, f: Fact | Fact[]): Fact[] => (cond ? (Array.isArray(f) ? f : [f]) : [])

export async function fetchPendingRequestRows(supabase: Supabase, kind: QuickActionKind, vehicleId: string, ctx: RowCtx): Promise<QuickActionRow[]> {
  if (kind === 'hourly') {
    const { data } = await supabase.rpc('vehicle_hourly_bookings', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { id: string; status: string; customer_name: string; pickup_address: string; base_amount_pkr: number; total_amount_pkr: number | null; hours: number | null; included_km: number | null; notes: string | null; payment_method: string | null; customer_trust: Trust }[])
      .filter((b) => b.status === 'requested')
      .map((b) => ({
        id: b.id, type: 'hourly', title: b.customer_name, subtitle: b.pickup_address, amount: b.total_amount_pkr ?? b.base_amount_pkr, href: '/portal/my-vehicle/hourly', needsAction: true,
        riderTrust: b.customer_trust ?? null, note: b.notes,
        facts: [
          ...when(b.hours, { icon: 'clock', text: n(ctx, 'rq.hours', b.hours!) }),
          ...when(b.included_km, { icon: 'distance', text: n(ctx, 'rq.includedKm', b.included_km!) }),
          ...payFact(ctx, b.payment_method),
        ],
      }))
  }
  if (kind === 'rental') {
    const { data } = await supabase.rpc('vehicle_rental_bookings', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { id: string; status: string; customer_name: string; from_address: string; to_address: string; total_amount_pkr: number; trip_type: string | null; km: number | null; wait_hours: number | null; notes: string | null; payment_method: string | null; customer_trust: Trust }[])
      .filter((b) => b.status === 'requested')
      .map((b) => ({
        id: b.id, type: 'rental', title: b.customer_name, subtitle: `${b.from_address} → ${b.to_address}`, amount: b.total_amount_pkr, href: '/portal/my-vehicle/rental', needsAction: true,
        from: b.from_address, to: b.to_address, riderTrust: b.customer_trust ?? null, note: b.notes,
        facts: [
          { icon: 'repeat', text: ctx.t(b.trip_type === 'return' ? 'rq.returnTrip' : 'rq.oneWay') },
          ...when(b.km, { icon: 'distance', text: n(ctx, 'rq.km', Math.round(b.km ?? 0)) }),
          ...when(b.wait_hours, { icon: 'wait', text: n(ctx, 'rq.waitHours', b.wait_hours!) }),
          ...payFact(ctx, b.payment_method),
        ],
      }))
  }
  if (kind === 'equipment') {
    const [{ data }, { data: services }] = await Promise.all([
      supabase.rpc('vehicle_equipment_bookings', { p_vehicle_id: vehicleId }),
      supabase.from('tractor_services').select('service_key, name_en, name_ur').eq('vehicle_id', vehicleId),
    ])
    const serviceName = (key: string | null) => {
      const s = ((services ?? []) as { service_key: string; name_en: string; name_ur: string }[]).find((x) => x.service_key === key)
      return s ? loc(ctx, s.name_en, s.name_ur) : null
    }
    return ((data ?? []) as { id: string; kind: 'machinery' | 'tractor' | 'loader'; service_key: string | null; status: string; customer_name: string; site_address: string; pickup_address: string | null; rate_pkr: number; mobilization_fee_pkr: number | null; total_amount_pkr: number | null; requested_hours: number | null; travel_km?: number; travel_charge_pkr?: number; advance_pct?: number; advance_amount_pkr?: number; trip_count: number | null; scheduled_date: string | null; scheduled_time: string | null; material: string | null; notes: string | null; payment_method: string | null }[])
      .filter((b) => b.status === 'requested')
      .map((b) => {
        const service = b.kind === 'tractor' ? serviceName(b.service_key) : null
        return {
          id: b.id, type: 'equipment' as const, subKind: b.kind, title: b.customer_name, subtitle: b.site_address, amount: b.total_amount_pkr ?? b.rate_pkr, href: '/portal/my-vehicle/equipment', needsAction: true,
          ...(b.pickup_address ? { from: b.pickup_address, to: b.site_address } : {}),
          note: b.notes,
          facts: [
            ...when(service, { icon: 'service', text: service ?? '' }),
            ...when(b.kind === 'loader' && b.material, { icon: 'service', text: b.material ?? '' }),
            ...whenFact(ctx, b.scheduled_date, b.scheduled_time),
            ...(b.kind === 'loader'
              ? when(b.trip_count, { icon: 'repeat', text: n(ctx, 'rq.trips', b.trip_count ?? 1) })
              : when(b.requested_hours, { icon: 'clock', text: n(ctx, 'rq.hours', b.requested_hours!) })),
            { icon: 'rate', text: n(ctx, b.kind === 'loader' ? 'rq.perTrip' : 'rq.perHour', pkr(b.rate_pkr)) },
            ...when(b.mobilization_fee_pkr, { icon: 'truck', text: n(ctx, 'rq.deliveryCharge', pkr(b.mobilization_fee_pkr ?? 0)) }),
            ...when(b.travel_charge_pkr, { icon: 'distance', text: ctx.t('rq.travelCharge').replace('{km}', String(Math.round(Number(b.travel_km ?? 0)))).replace('{amount}', pkr(b.travel_charge_pkr ?? 0)) }),
            ...when(b.advance_pct, { icon: 'wallet', text: ctx.t('rq.advanceAfterAccept').replace('{pct}', String(b.advance_pct)).replace('{amount}', pkr(b.advance_amount_pkr ?? 0)) }),
            ...payFact(ctx, b.payment_method),
          ] as Fact[],
        }
      })
  }
  if (kind === 'shadi') {
    const [{ data }, { data: classes }] = await Promise.all([
      supabase.rpc('vehicle_shadi_requests', { p_vehicle_id: vehicleId }),
      supabase.rpc('shadi_vehicle_classes_list'),
    ])
    const className = (key: string) => {
      const c = ((classes ?? []) as { class_key: string; name_en: string; name_ur: string }[]).find((x) => x.class_key === key)
      return c ? loc(ctx, c.name_en, c.name_ur) : null
    }
    return ((data ?? []) as { id: string; status: string; class_key: string; customer_name: string; venue_address: string; full_day_rate_pkr: number; event_date: string | null; distance_km: number | null; notes: string | null; customer_trust: Trust; travel_charge_pkr?: number }[])
      .filter((r) => r.status === 'requested')
      .map((r) => {
        const cls = className(r.class_key)
        return {
          id: r.id, type: 'shadi' as const, title: r.customer_name, subtitle: r.venue_address, amount: r.full_day_rate_pkr, href: '/portal/my-vehicle/shadi', needsAction: true,
          riderTrust: r.customer_trust ?? null, note: r.notes,
          facts: [
            ...when(cls, { icon: 'service', text: cls ?? '' }),
            ...whenFact(ctx, r.event_date, null),
            { icon: 'clock', text: ctx.t('rq.fullDay') },
            ...when(r.distance_km, { icon: 'distance', text: n(ctx, 'rq.kmAway', Math.round(r.distance_km ?? 0)) }),
          ] as Fact[],
        }
      })
  }
  if (kind === 'dispatch') {
    const { data } = await supabase.rpc('my_dispatch_invitations', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { call_id: string; item: string; address: string; goods_budget_pkr: number; tier: number | null; shop_name: string | null; city_name: string | null; customer_trust: Trust }[])
      .map((d) => ({
        id: d.call_id, type: 'dispatch', title: d.item, subtitle: d.address, amount: d.goods_budget_pkr, href: '/portal/my-vehicle/requests', needsAction: true,
        to: d.address, ...(d.shop_name ? { from: [d.shop_name, d.city_name].filter(Boolean).join(', ') } : {}),
        riderTrust: d.customer_trust ?? null,
        facts: [
          ...when(d.city_name, { icon: 'shop', text: d.city_name ?? '' }),
          ...when(d.tier, { icon: 'rate', text: n(ctx, 'rq.tier', d.tier ?? 1) }),
        ],
      }))
  }
  if (kind === 'city_purchase') {
    const { data } = await supabase.rpc('my_city_purchase_invitations', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { request_id: string; item: string; goods_budget_pkr: number; pickup_label: string | null; reference_destination: string | null; urgency: string | null; city_name: string | null; city_name_ur: string | null }[])
      .map((c) => {
        const city = loc(ctx, c.city_name, c.city_name_ur)
        const urgencyKey = c.urgency === 'urgent' ? 'rq.urgent' : c.urgency === '1hr' ? 'rq.within1hr' : c.urgency === '2hr' ? 'rq.within2hr' : null
        return {
          id: c.request_id, type: 'city_purchase' as const, title: c.item, subtitle: c.pickup_label ?? city, amount: c.goods_budget_pkr, href: `/portal/marketplace/city-purchase/${c.request_id}`, needsAction: true,
          ...(c.pickup_label && c.reference_destination ? { from: c.pickup_label, to: c.reference_destination } : {}),
          facts: [
            ...when(urgencyKey, { icon: 'urgent', text: urgencyKey ? ctx.t(urgencyKey) : '' }),
            ...when(city, { icon: 'shop', text: city }),
          ] as Fact[],
        }
      })
  }
  if (kind === 'parcel') {
    const { data } = await supabase.rpc('my_parcel_delivery_invitations', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { delivery_id: string; description: string; pickup_label: string | null; dropoff_label: string | null; city_name: string | null; city_name_ur: string | null }[])
      .map((p) => {
        const city = loc(ctx, p.city_name, p.city_name_ur)
        return {
          id: p.delivery_id, type: 'parcel' as const, title: p.description, subtitle: p.pickup_label ?? city, amount: null, href: `/portal/marketplace/parcel/${p.delivery_id}`, needsAction: true,
          ...(p.pickup_label && p.dropoff_label ? { from: p.pickup_label, to: p.dropoff_label } : {}),
          facts: city ? [{ icon: 'shop', text: city } as Fact] : [],
        }
      })
  }
  if (kind === 'delivery') {
    const { data } = await supabase.rpc('my_shop_delivery_invitations', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { order_id: string; shop_name: string; shop_name_ur: string | null; delivery_address: string; village_name: string | null; village_name_ur: string | null; delivery_fee_pkr: number }[])
      .map((i) => {
        const shop = loc(ctx, i.shop_name, i.shop_name_ur)
        const village = loc(ctx, i.village_name, i.village_name_ur)
        return {
          id: i.order_id, type: 'delivery' as const, title: shop, subtitle: i.delivery_address, amount: i.delivery_fee_pkr, href: '/portal/my-vehicle/deliveries', needsAction: true,
          from: shop, to: i.delivery_address,
          facts: village ? [{ icon: 'shop', text: village } as Fact] : [],
        }
      })
  }
  if (kind === 'ride_dispatch') {
    const { data } = await supabase.rpc('my_pending_ride_dispatch_requests', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { id: string; pickup_label: string; dropoff_label: string; fare_pkr: number; pickup_lat: number | null; pickup_lng: number | null; driver_lat: number | null; driver_lng: number | null; category_emoji: string; category_name: string; category_name_ur: string | null; rider_trust: Trust; rider_tenant_name: string }[])
      .map((r) => ({
        id: r.id, type: 'ride_dispatch', title: `${r.category_emoji} ${loc(ctx, r.category_name, r.category_name_ur)}`, subtitle: `${r.pickup_label} → ${r.dropoff_label}`,
        amount: r.fare_pkr, href: `/portal/marketplace/ride-dispatch/${r.id}`, needsAction: true,
        from: r.pickup_label, to: r.dropoff_label, pickupLat: r.pickup_lat, pickupLng: r.pickup_lng, driverLat: r.driver_lat, driverLng: r.driver_lng,
        riderTrust: r.rider_trust, riderVillage: r.rider_tenant_name, facts: [],
      }))
  }

  // 'route' — route-based and adda-based ride_bookings, same two-query
  // split as the Jobs list. Only a per_order vehicle's own driver may
  // confirm/reject these (confirm_ride_booking / reject_ride_booking);
  // a lump-sum vehicle's seats are confirmed by the committee after
  // checking the rider's payment, so there's nothing for the driver to
  // press — an Accept there would only ever fail "Not authorized".
  const driverDecides = ctx.commissionMode === 'per_order'
  const [routeRes, addaRes] = await Promise.all([
    supabase.from('ride_bookings').select('id, seats, travel_date, total_amount_pkr, announced_method, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur, departure_time)').eq('vehicle_routes.vehicle_id', vehicleId).eq('status', 'announced'),
    supabase.from('ride_bookings').select('id, seats, travel_date, total_amount_pkr, announced_method, adda_queue_entries!inner(vehicle_id, addas(name, name_ur))').eq('adda_queue_entries.vehicle_id', vehicleId).eq('status', 'announced'),
  ])
  const seatFacts = (seats: number, date: string, time: string | null, method: string | null | undefined): Fact[] => [
    ...whenFact(ctx, date, time),
    { icon: 'seat', text: n(ctx, 'rq.seats', seats) },
    ...when(method === 'direct', { icon: 'wallet', text: ctx.t('rq.payDriver') }),
  ]
  const out: QuickActionRow[] = []
  for (const b of (routeRes.data ?? []) as unknown as { id: string; seats: number; travel_date: string; total_amount_pkr: number; announced_method: string | null; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; departure_time: string | null } }[]) {
    const r = b.vehicle_routes
    const from = loc(ctx, r.origin, r.origin_ur), to = loc(ctx, r.destination, r.destination_ur)
    out.push({
      id: b.id, type: 'route', title: `${from} → ${to}`, subtitle: ctx.t('mv.tab.routes'), amount: b.total_amount_pkr, href: '/portal/my-vehicle/routes',
      needsAction: driverDecides, infoNote: driverDecides ? null : ctx.t('rq.committeeVerifiesNote'),
      from, to, facts: seatFacts(b.seats, b.travel_date, r.departure_time, b.announced_method),
    })
  }
  for (const b of (addaRes.data ?? []) as unknown as { id: string; seats: number; travel_date: string; total_amount_pkr: number; announced_method: string | null; adda_queue_entries: { addas: { name: string; name_ur: string | null } | null } }[]) {
    const adda = b.adda_queue_entries.addas
    const name = adda ? loc(ctx, adda.name, adda.name_ur) : ctx.t('mv.tab.adda')
    out.push({
      id: b.id, type: 'route', title: name, subtitle: name, amount: b.total_amount_pkr, href: '/portal/my-vehicle/adda',
      needsAction: driverDecides, infoNote: driverDecides ? null : ctx.t('rq.committeeVerifiesNote'),
      facts: seatFacts(b.seats, b.travel_date, null, b.announced_method),
    })
  }
  return out
}

export const ALL_REQUEST_KINDS: QuickActionKind[] = ['hourly', 'rental', 'equipment', 'shadi', 'dispatch', 'city_purchase', 'parcel', 'delivery', 'route', 'ride_dispatch']
