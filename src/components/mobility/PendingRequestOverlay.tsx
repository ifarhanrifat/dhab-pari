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
import { BookingLifecycleSheet, type LifecycleKind } from '@/components/mobility/BookingLifecycleSheet'
import { RideLifecycleSheet } from '@/components/portal/RideLifecycleSheet'
import { fetchPendingRequestRows, ALL_REQUEST_KINDS, type RowCtx } from '@/lib/driverRequestRows'

interface VehicleFlags { offers_hourly: boolean; offers_shadi: boolean; offers_equipment: boolean; offers_rental: boolean; delivers: boolean; commission_mode?: string | null }

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
  ride_dispatch_requested: 'ride_dispatch',
  // Shop deliveries were never listened for (or scanned) here, so a
  // driver who delivers for shops never got the popup for them.
  shop_delivery_invited: 'delivery',
}

export function PendingRequestOverlay({ vehicleId, vehicle }: { vehicleId: string; vehicle: VehicleFlags }) {
  const { t, isUrdu } = useLocale()
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
  // Lives independently of `queue` — see JobQuickActionSheet's own
  // onAcceptedLifecycle prop comment for why this has to be separate.
  const [activeLifecycle, setActiveLifecycle] = useState<{ kind: LifecycleKind; id: string } | null>(null)
  // Same reasoning, for ride_dispatch's own stay-open sheet.
  const [activeRideBookingId, setActiveRideBookingId] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).single()
      if (data) setPortalUserId(data.id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const kindsToScan = useCallback((): QuickActionKind[] => ALL_REQUEST_KINDS.filter((k) =>
    k !== 'hourly' || vehicle.offers_hourly).filter((k) =>
    k !== 'shadi' || vehicle.offers_shadi).filter((k) =>
    k !== 'equipment' || vehicle.offers_equipment).filter((k) =>
    k !== 'rental' || vehicle.offers_rental).filter((k) =>
    k !== 'delivery' || vehicle.delivers
  ), [vehicle.offers_hourly, vehicle.offers_shadi, vehicle.offers_equipment, vehicle.offers_rental, vehicle.delivers])

  // Only rows the driver can actually act on pop up — a lump-sum
  // vehicle's seat booking waits on the committee, not on them.
  const fetchActionable = useCallback(async (kind: QuickActionKind) => {
    const ctx: RowCtx = { t, isUrdu, commissionMode: vehicle.commission_mode ?? null }
    return (await fetchPendingRequestRows(supabase, kind, vehicleId, ctx)).filter((r) => r.needsAction)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, isUrdu, vehicle.commission_mode])

  // Real bug found live, 2026-11-03: a ride-dispatch request's fare can
  // rise on its own while a driver already has its popup open (the
  // auto-escalation sweep, 789) — the old merge only ever ADDED rows
  // whose key wasn't already queued, so an already-queued row's amount
  // (and anything else about it) never actually updated, even though
  // this scan runs again every 20s and on every matching realtime
  // notification. Now replaces each scanned kind's queue entries with
  // the fresh data (same key = updated in place, not re-added; a key
  // no longer present = removed, e.g. someone else already accepted
  // it) instead of only ever appending.
  const mergeQueue = useCallback((kinds: QuickActionKind[], fresh: QuickActionRow[]) => {
    setQueue((cur) => {
      const freshKeys = new Set(fresh.map((r) => `${r.type}-${r.id}`))
      const kept = cur.filter((r) => !kinds.includes(r.type) || freshKeys.has(`${r.type}-${r.id}`))
      const keptKeys = new Set(kept.map((r) => `${r.type}-${r.id}`))
      const updated = kept.map((r) => fresh.find((f) => f.type === r.type && f.id === r.id) ?? r)
      const brandNew = fresh.filter((f) => !keptKeys.has(`${f.type}-${f.id}`))
      return [...updated, ...brandNew]
    })
  }, [])

  const scanAll = useCallback(async () => {
    const kinds = kindsToScan()
    const results = await Promise.all(kinds.map((k) => fetchActionable(k)))
    mergeQueue(kinds, results.flat())
  }, [kindsToScan, fetchActionable, mergeQueue])

  const scanOneKind = useCallback(async (kind: QuickActionKind) => {
    const fresh = await fetchActionable(kind)
    mergeQueue([kind], fresh)
  }, [fetchActionable, mergeQueue])

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
      {activeLifecycle ? (
        <BookingLifecycleSheet
          kind={activeLifecycle.kind} bookingId={activeLifecycle.id} vehicleId={vehicleId}
          commissionMode={vehicle.commission_mode ?? 'monthly_lumpsum'}
          onClose={() => setActiveLifecycle(null)}
          onChanged={refreshBadge}
        />
      ) : activeRideBookingId ? (
        <RideLifecycleSheet bookingId={activeRideBookingId} onClose={() => setActiveRideBookingId(null)} />
      ) : current && (
        <JobQuickActionSheet
          key={`${current.type}-${current.id}`}
          row={current}
          vehicleId={vehicleId}
          onClose={closeCurrent}
          onDone={refreshBadge}
          onAcceptedLifecycle={(kind, id) => setActiveLifecycle({ kind, id })}
          onAcceptedRide={(id) => setActiveRideBookingId(id)}
        />
      )}
    </>
  )
}
