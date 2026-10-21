'use client'

// Real ask, 2026-10-21: "the rider once sent the request and the same
// request popup kept displaying... until the driver accepted that
// request." JobQuickActionSheet (built 2026-10-20) already is that
// popup and already calls every vertical's real accept/decline RPC —
// it just only ever opened when the driver manually tapped a row they
// went and found on the Jobs list. This mounts it at the driver-portal
// layout level (my-vehicle/layout.tsx) instead, so it's alive no matter
// which screen the driver is on, and auto-opens the instant a new
// request's portal_notifications row lands — the same Realtime
// pattern PortalNotificationBell.tsx already proves out in production
// (postgres_changes INSERT + a poll fallback), just filtered to the
// handful of event_types that mean "something is waiting on you,"
// rather than every notification.
//
// Deliberately re-queries each vertical's own real "pending" RPC/table
// instead of trying to parse a specific booking id out of the
// notification row — several of those rows (hourly/rental/equipment/
// shadi) only ever linked to a generic page, never a specific booking
// id, so there is nothing reliable to parse. In practice there is
// almost always exactly one new pending row per notification; the
// 20s poll fallback (same interval DriverJobsBadgeContext already
// polls at) re-scans everything regardless and catches anything the
// realtime channel missed or that got dismissed without a decision —
// a pending row never just silently disappears, it comes back.

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useDriverJobsBadge } from '@/components/mobility/DriverJobsBadgeContext'
import { JobQuickActionSheet, type QuickActionKind, type QuickActionRow } from '@/components/mobility/JobQuickActionSheet'

interface VehicleFlags { offers_hourly: boolean; offers_shadi: boolean; offers_equipment: boolean; offers_rental: boolean; delivers: boolean }

// Every "a new request needs your response" event_type this app's
// booking RPCs already insert into portal_notifications, mapped to the
// vertical whose own pending-rows query should be re-run. Adda-based
// seat bookings reuse the 'route' kind — same as the Jobs list does —
// since JobQuickActionSheet's accept/decline for 'route' already calls
// confirm_ride_booking/reject_ride_booking, which works for either.
const EVENT_TO_KIND: Record<string, QuickActionKind> = {
  hourly_booking_requested: 'hourly',
  rental_booking_requested: 'rental',
  equipment_booking_requested: 'equipment',
  shadi_request_received: 'shadi',
  dispatch_invited: 'dispatch',
  city_purchase_invited: 'city_purchase',
  parcel_delivery_invited: 'parcel',
  route_seat_booked: 'route',
  adda_seat_booked: 'route',
}

async function fetchPendingRows(supabase: ReturnType<typeof createClient>, kind: QuickActionKind, vehicleId: string): Promise<QuickActionRow[]> {
  if (kind === 'hourly') {
    const { data } = await supabase.rpc('vehicle_hourly_bookings', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { id: string; status: string; customer_name: string; pickup_address: string; base_amount_pkr: number; total_amount_pkr: number | null }[])
      .filter((b) => b.status === 'requested')
      .map((b) => ({ id: b.id, type: 'hourly', title: b.customer_name, subtitle: b.pickup_address, amount: b.total_amount_pkr ?? b.base_amount_pkr, href: '/portal/my-vehicle/hourly', needsAction: true }))
  }
  if (kind === 'rental') {
    const { data } = await supabase.rpc('vehicle_rental_bookings', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { id: string; status: string; customer_name: string; from_address: string; to_address: string; total_amount_pkr: number }[])
      .filter((b) => b.status === 'requested')
      .map((b) => ({ id: b.id, type: 'rental', title: b.customer_name, subtitle: `${b.from_address} → ${b.to_address}`, amount: b.total_amount_pkr, href: '/portal/my-vehicle/rental', needsAction: true }))
  }
  if (kind === 'equipment') {
    const { data } = await supabase.rpc('vehicle_equipment_bookings', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { id: string; status: string; customer_name: string; site_address: string; rate_pkr: number; total_amount_pkr: number | null }[])
      .filter((b) => b.status === 'requested')
      .map((b) => ({ id: b.id, type: 'equipment', title: b.customer_name, subtitle: b.site_address, amount: b.total_amount_pkr ?? b.rate_pkr, href: '/portal/my-vehicle/equipment', needsAction: true }))
  }
  if (kind === 'shadi') {
    const { data } = await supabase.rpc('vehicle_shadi_requests', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { id: string; status: string; customer_name: string; venue_address: string; full_day_rate_pkr: number }[])
      .filter((r) => r.status === 'requested')
      .map((r) => ({ id: r.id, type: 'shadi', title: r.customer_name, subtitle: r.venue_address, amount: r.full_day_rate_pkr, href: '/portal/my-vehicle/shadi', needsAction: true }))
  }
  if (kind === 'dispatch') {
    const { data } = await supabase.rpc('my_dispatch_invitations', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { call_id: string; item: string; address: string; goods_budget_pkr: number }[])
      .map((d) => ({ id: d.call_id, type: 'dispatch', title: d.item, subtitle: d.address, amount: d.goods_budget_pkr, href: '/portal/my-vehicle/requests', needsAction: true }))
  }
  if (kind === 'city_purchase') {
    const { data } = await supabase.rpc('my_city_purchase_invitations', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { request_id: string; item: string; goods_budget_pkr: number; pickup_label: string | null }[])
      .map((c) => ({ id: c.request_id, type: 'city_purchase', title: c.item, subtitle: c.pickup_label ?? '', amount: c.goods_budget_pkr, href: '/portal/my-vehicle/requests', needsAction: true }))
  }
  if (kind === 'parcel') {
    const { data } = await supabase.rpc('my_parcel_delivery_invitations', { p_vehicle_id: vehicleId })
    return ((data ?? []) as { delivery_id: string; description: string; pickup_label: string | null }[])
      .map((p) => ({ id: p.delivery_id, type: 'parcel', title: p.description, subtitle: p.pickup_label ?? '', amount: null, href: '/portal/my-vehicle/requests', needsAction: true }))
  }
  // 'route' — covers both route-based and adda-based ride_bookings, same
  // two-query split as the Jobs list (see its own comment on why).
  const [routeRes, addaRes] = await Promise.all([
    supabase.from('ride_bookings').select('id, status, total_amount_pkr, vehicle_routes!inner(vehicle_id, origin, destination)').eq('vehicle_routes.vehicle_id', vehicleId).eq('status', 'announced'),
    supabase.from('ride_bookings').select('id, status, total_amount_pkr, adda_queue_entries!inner(vehicle_id, addas(name))').eq('adda_queue_entries.vehicle_id', vehicleId).eq('status', 'announced'),
  ])
  const out: QuickActionRow[] = []
  for (const b of (routeRes.data ?? []) as unknown as { id: string; total_amount_pkr: number; vehicle_routes: { origin: string; destination: string } }[]) {
    out.push({ id: b.id, type: 'route', title: `${b.vehicle_routes.origin} → ${b.vehicle_routes.destination}`, subtitle: 'Route', amount: b.total_amount_pkr, href: '/portal/my-vehicle/routes', needsAction: true })
  }
  for (const b of (addaRes.data ?? []) as unknown as { id: string; total_amount_pkr: number; adda_queue_entries: { addas: { name: string } } }[]) {
    out.push({ id: b.id, type: 'route', title: b.adda_queue_entries.addas.name, subtitle: 'Adda', amount: b.total_amount_pkr, href: '/portal/my-vehicle/adda', needsAction: true })
  }
  return out
}

const ALL_KINDS: QuickActionKind[] = ['hourly', 'rental', 'equipment', 'shadi', 'dispatch', 'city_purchase', 'parcel', 'route']

export function PendingRequestOverlay({ vehicleId, vehicle }: { vehicleId: string; vehicle: VehicleFlags }) {
  const { t } = useLocale()
  const supabase = createClient()
  const { refresh: refreshBadge } = useDriverJobsBadge()
  const [portalUserId, setPortalUserId] = useState<string | null>(null)
  // No permanent "seen" set on purpose — a row that was decided
  // (accepted/declined) naturally stops matching its vertical's own
  // 'requested'/'announced' status filter on the next scan, and a row
  // merely dismissed without a decision still matches it, so it's free
  // to reappear. Dedup below is only against what's in `queue` right
  // now, to avoid adding the same still-pending row twice.
  const [queue, setQueue] = useState<QuickActionRow[]>([])

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).single()
      if (data) setPortalUserId(data.id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const kindsToScan = useCallback((): QuickActionKind[] => ALL_KINDS.filter((k) =>
    k !== 'hourly' || vehicle.offers_hourly).filter((k) =>
    k !== 'shadi' || vehicle.offers_shadi).filter((k) =>
    k !== 'equipment' || vehicle.offers_equipment).filter((k) =>
    k !== 'rental' || vehicle.offers_rental
  ), [vehicle.offers_hourly, vehicle.offers_shadi, vehicle.offers_equipment, vehicle.offers_rental])

  const scanAll = useCallback(async () => {
    const results = await Promise.all(kindsToScan().map((k) => fetchPendingRows(supabase, k, vehicleId)))
    const fresh = results.flat()
    if (fresh.length === 0) return
    setQueue((cur) => {
      const curKeys = new Set(cur.map((r) => `${r.type}-${r.id}`))
      return [...cur, ...fresh.filter((r) => !curKeys.has(`${r.type}-${r.id}`))]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, kindsToScan])

  const scanOneKind = useCallback(async (kind: QuickActionKind) => {
    const fresh = await fetchPendingRows(supabase, kind, vehicleId)
    if (fresh.length === 0) return
    setQueue((cur) => {
      const curKeys = new Set(cur.map((r) => `${r.type}-${r.id}`))
      return [...cur, ...fresh.filter((r) => !curKeys.has(`${r.type}-${r.id}`))]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId])

  // Realtime: near-instant pop the moment a qualifying request lands.
  useEffect(() => {
    if (!portalUserId) return
    const channel = supabase
      .channel(`pending_requests:${portalUserId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_notifications', filter: `portal_user_id=eq.${portalUserId}` },
        (payload) => {
          const eventType = (payload.new as { event_type: string }).event_type
          const kind = EVENT_TO_KIND[eventType]
          if (kind) scanOneKind(kind)
        })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portalUserId, scanOneKind])

  // Poll fallback — catches anything the realtime channel missed, and
  // (deliberately) re-surfaces a request that was dismissed without a
  // decision rather than letting it vanish for good.
  useEffect(() => {
    scanAll()
    const iv = setInterval(scanAll, 20000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanAll])

  const current = queue[0] ?? null

  // JobQuickActionSheet calls onDone() then onClose() on a real decision
  // (see its own act()), but only onClose() on a plain dismiss — so the
  // queue must advance exactly once, from onClose alone, every time.
  // onDone here is purely "a decision was made, refresh the badge count."
  const closeCurrent = () => setQueue((cur) => cur.slice(1))

  return (
    <>
      {queue.length > 1 && (
        <div className="fixed top-3 inset-x-0 flex justify-center z-[110] pointer-events-none">
          <span className="bg-[#0f172a] text-white text-[11.5px] font-sans font-bold px-3 py-1 rounded-full shadow-lg">
            1 {t('mv.pendingQueueOfLabel')} {queue.length} {t('mv.pendingQueueWaitingLabel')}
          </span>
        </div>
      )}
      {current && (
        <JobQuickActionSheet
          row={current}
          vehicleId={vehicleId}
          onClose={closeCurrent}
          onDone={refreshBadge}
        />
      )}
    </>
  )
}
