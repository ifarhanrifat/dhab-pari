'use client'

// Bookings screen (v.rTrips) — the real, nav-linked "Bookings" tab
// (MobilityBottomNav → /portal/marketplace/trips). A unified list
// merging every vertical's own real "my bookings" source into one
// normalized shape. No new backend: every source here is an RPC/table
// that already existed before this page.
// dispatch_calls (order-city) is deliberately left out — there's no
// "my calls" listing anywhere in this app today, and its negotiation
// side already shows up in Chat (kind='fetch'/'pro').
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

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { BookingQuickViewSheet, type QuickViewKind } from '@/components/mobility/BookingQuickViewSheet'

type Kind = 'trip' | 'hourly' | 'equipment' | 'ride' | 'shadi' | 'cityPurchase'
interface BookingRow { id: string; rawId: string; kind: Kind; title: string; subtitle: string; amount: number | null; status: 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'completed'; date: string; href: string | null }
// Real ask: hourly/equipment/ride rows used to send the rider to a
// generic, unscoped browse page instead of their own booking — these 3
// now pop up that one booking's own status/actions instead (see
// BookingQuickViewSheet). trip/shadi/cityPurchase go to real, rich
// detail pages and keep navigating there, deliberately.
const QUICK_VIEW_KINDS = new Set<Kind>(['hourly', 'equipment', 'ride'])
function isQuickViewKind(k: Kind): k is QuickViewKind { return QUICK_VIEW_KINDS.has(k) }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
const STATUS_STYLE: Record<BookingRow['status'], { bg: string; fg: string }> = {
  pending: { bg: '#fef3c7', fg: '#92400e' }, confirmed: { bg: '#dcfce7', fg: '#166534' },
  declined: { bg: '#fee2e2', fg: '#b91c1c' }, cancelled: { bg: '#f1f5f9', fg: '#64748b' }, completed: { bg: '#e0f2fe', fg: '#0369a1' },
}
function mapStatus(s: string): BookingRow['status'] {
  if (s === 'completed') return 'completed'
  if (s === 'cancelled') return 'cancelled'
  if (['declined', 'rejected'].includes(s)) return 'declined'
  if (['confirmed', 'accepted', 'announced', 'in_progress'].includes(s)) return 'confirmed'
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

  const reloadMine = async () => {
    const [tripShare, hourly, equipment, ride, shadi, cityPurchase] = await Promise.all([
      supabase.rpc('my_trip_bookings'),
      supabase.rpc('my_hourly_bookings'),
      supabase.rpc('my_equipment_bookings'),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, travel_date, vehicle_routes(origin, origin_ur, destination, destination_ur)').order('created_at', { ascending: false }).limit(20),
      supabase.rpc('my_shadi_events'),
      supabase.rpc('my_city_purchase_requests'),
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

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Receipt size={19} /> {t('mb.myBookingsHeading')}</h1>

      <div className="flex flex-col gap-2">
        {(rows?.length ?? 0) === 0 && <p className="text-center py-10 text-[#94a3b8] text-[13.5px]">{t('vp.noEquipmentBookingsHint')}</p>}
        {rows?.map((r) => {
          const style = STATUS_STYLE[r.status]
          const content = (
            <>
              <div className="min-w-0">
                <p className="text-[13.5px] font-bold text-[#1e293b] truncate">{r.title}</p>
                <p className="text-[12px] text-[#64748b] truncate mt-0.5">{r.subtitle}</p>
              </div>
              <div className="shrink-0 text-end">
                {r.amount != null && <p className="text-[13.5px] font-extrabold text-[#005A36] ltr-num">{fmt(r.amount)}</p>}
                <span className="text-[9.5px] font-bold px-2 py-0.5 rounded-full" style={{ background: style.bg, color: style.fg }}>{t(statusKey(r.kind, r.status))}</span>
              </div>
            </>
          )
          if (isQuickViewKind(r.kind)) {
            return (
              <button key={r.id} onClick={() => setOpenRow(r)} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center justify-between gap-3 text-start cursor-pointer hover:border-[#166534]">{content}</button>
            )
          }
          return r.href ? (
            <Link key={r.id} href={r.href} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center justify-between gap-3 cursor-pointer hover:border-[#166534]">{content}</Link>
          ) : (
            <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center justify-between gap-3">{content}</div>
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
