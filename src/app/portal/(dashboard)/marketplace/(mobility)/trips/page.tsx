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
import { Receipt, Users, Clock, Wrench, Bus, Sparkles, ShoppingBag, Car, Package, Phone, Store } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { BookingQuickViewSheet, type QuickViewKind } from '@/components/mobility/BookingQuickViewSheet'

type Kind = 'trip' | 'hourly' | 'equipment' | 'ride' | 'shadi' | 'cityPurchase' | 'rental' | 'parcel' | 'dispatch' | 'shop'
interface BookingRow { id: string; rawId: string; kind: Kind; title: string; subtitle: string; amount: number | null; status: 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'completed'; date: string; href: string | null }
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
  cityPurchase: ShoppingBag, rental: Car, parcel: Package, dispatch: Phone, shop: Store,
}
const KIND_TINT: Record<Kind, string> = {
  trip: '#e0f2fe', hourly: '#fef9c3', equipment: '#fde68a', ride: '#dcfce7', shadi: '#fce7f3',
  cityPurchase: '#ffe4e6', rental: '#f3e8ff', parcel: '#ffedd5', dispatch: '#e0e7ff', shop: '#fff7ed',
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
  if (['declined', 'rejected', 'no_answer'].includes(s)) return 'declined'
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
  const [seg, setSeg] = useState<'active' | 'past'>('active')

  const reloadMine = async () => {
    const [tripShare, hourly, equipment, ride, shadi, cityPurchase, rental, parcel, dispatch, shop] = await Promise.all([
      supabase.rpc('my_trip_bookings'),
      supabase.rpc('my_hourly_bookings'),
      supabase.rpc('my_equipment_bookings'),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, travel_date, vehicle_routes(origin, origin_ur, destination, destination_ur)').order('created_at', { ascending: false }).limit(20),
      supabase.rpc('my_shadi_events'),
      supabase.rpc('my_city_purchase_requests'),
      supabase.rpc('my_rental_bookings'),
      supabase.rpc('my_parcel_deliveries'),
      supabase.rpc('my_dispatch_calls'),
      supabase.from('shop_orders').select('id, status, total_amount_pkr, fulfillment_status, created_at, shops(name, name_ur)').eq('portal_user_id', user!.id).order('created_at', { ascending: false }).limit(20),
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
    for (const b of (ride.data ?? []) as unknown as Array<{ id: string; status: string; total_amount_pkr: number; travel_date: string; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null }>) {
      const vr = b.vehicle_routes
      out.push({ id: `ride-${b.id}`, rawId: b.id, kind: 'ride', title: t('af.addaBoardPageTitle'), subtitle: vr ? `${isUrdu && vr.origin_ur ? vr.origin_ur : vr.origin} → ${isUrdu && vr.destination_ur ? vr.destination_ur : vr.destination}` : '—', amount: b.total_amount_pkr, status: mapStatus(b.status), date: b.travel_date, href: '/portal/marketplace' })
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

    out.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    setRows(out)
  }

  useEffect(() => {
    if (!user) return
    reloadMine().then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  const active = (rows ?? []).filter((r) => !['completed', 'cancelled', 'declined'].includes(r.status))
  const past = (rows ?? []).filter((r) => ['completed', 'cancelled', 'declined'].includes(r.status))
  const shown = seg === 'active' ? active : past

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Receipt size={19} /> {t('mb.myBookingsHeading')}</h1>

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
                <span className="text-[9.5px] font-bold px-2 py-0.5 rounded-full" style={{ background: style.bg, color: style.fg }}>{t(statusKey(r.kind, r.status))}</span>
                <span dir="ltr" className="flex items-center gap-[3px]">
                  {[0, 1, 2].map((i) => <span key={i} className="w-[18px] h-1 rounded-full" style={{ background: cancelled ? '#fecaca' : i <= step ? '#16a34a' : '#e5e2d0' }} />)}
                  {r.date && <span className="font-sans text-[9px] text-[#94a3b8] ms-1 ltr-num">{new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                </span>
              </span>
            </>
          )
          const cls = 'w-full text-start bg-white border border-[#e5e2d0] rounded-2xl p-3 flex flex-col gap-2 cursor-pointer hover:border-[#166534]'
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
    </div>
  )
}
