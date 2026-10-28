'use client'

// Driver Jobs — the design file's own `driver:jobs` screen: one queue,
// segmented New / Active / Done (`U.seg.jobs`, `driverNeeds()` in
// dhab-pari-mobility.html), merged the same way Phase 3's rider "My
// Bookings" aggregator merged 6 booking types client-side — one small
// read per real booking vertical this vehicle can receive, since no
// single SQL view spans all of them. Tapping a row opens that
// vertical's own existing page (hourly/shadi/equipment/routes/requests/
// deliveries/trips) — each already has the real accept/decline/start/
// finish actions for its type; this screen only has to get you to the
// right one fast.

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Clock3, Bus, Wrench, Users2, ShoppingBag, Package, Route as RouteIcon, Navigation, Car } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { useDriverJobsBadge } from '@/components/mobility/DriverJobsBadgeContext'
import { JobQuickActionSheet, type QuickActionKind, type QuickActionRow } from '@/components/mobility/JobQuickActionSheet'

interface Vehicle { id: string; offers_hourly: boolean; offers_shadi: boolean; offers_equipment: boolean; offers_rental: boolean; delivers: boolean }
interface Row {
  id: string; type: 'hourly' | 'shadi' | 'equipment' | 'rental' | 'route' | 'dispatch' | 'city_purchase' | 'delivery' | 'parcel' | 'ride_dispatch'
  title: string; subtitle: string; amount: number | null; at: string; needsAction: boolean; done: boolean; href: string
  riderTrust?: QuickActionRow['riderTrust']; riderVillage?: string
}
// Every kind here now pops up instead of navigating away — dispatch/
// parcel/delivery are plain accept/decline same as the first 5;
// city_purchase gets its own fee-input step inside the same sheet
// (JobQuickActionSheet handles that one difference). ride_dispatch is
// accept-only (JobQuickActionSheet hides Decline for it) — it's a
// broadcast, not a per-vehicle invitation.
const QUICK_ACTION_KINDS = new Set<Row['type']>(['hourly', 'rental', 'equipment', 'shadi', 'route', 'dispatch', 'city_purchase', 'parcel', 'delivery', 'ride_dispatch'])
function isQuickActionKind(t: Row['type']): t is QuickActionKind { return QUICK_ACTION_KINDS.has(t) }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function MyVehicleJobsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const { refresh: refreshBadge } = useDriverJobsBadge()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [seg, setSeg] = useState<'new' | 'active' | 'done'>('new')
  const [openJob, setOpenJob] = useState<Row | null>(null)

  const reload = useCallback(async (v: Vehicle) => {
    const out: Row[] = []

    if (v.offers_hourly) {
      const { data } = await supabase.rpc('vehicle_hourly_bookings', { p_vehicle_id: v.id })
      for (const b of (data ?? []) as { id: string; status: string; customer_name: string; pickup_address: string; base_amount_pkr: number; total_amount_pkr: number | null; requested_at: string }[]) {
        out.push({ id: b.id, type: 'hourly', title: b.customer_name, subtitle: b.pickup_address, amount: b.total_amount_pkr ?? b.base_amount_pkr, at: b.requested_at, needsAction: b.status === 'requested', done: ['completed', 'declined', 'cancelled'].includes(b.status), href: '/portal/my-vehicle/hourly' })
      }
    }
    if (v.offers_shadi) {
      const { data } = await supabase.rpc('vehicle_shadi_requests', { p_vehicle_id: v.id })
      for (const r of (data ?? []) as { id: string; status: string; customer_name: string; venue_address: string; full_day_rate_pkr: number; event_date: string }[]) {
        out.push({ id: r.id, type: 'shadi', title: r.customer_name, subtitle: r.venue_address, amount: r.full_day_rate_pkr, at: r.event_date, needsAction: r.status === 'requested', done: ['declined', 'cancelled', 'withdrawn'].includes(r.status), href: '/portal/my-vehicle/shadi' })
      }
    }
    if (v.offers_equipment) {
      const { data } = await supabase.rpc('vehicle_equipment_bookings', { p_vehicle_id: v.id })
      for (const b of (data ?? []) as { id: string; status: string; customer_name: string; site_address: string; rate_pkr: number; total_amount_pkr: number | null; requested_at: string }[]) {
        out.push({ id: b.id, type: 'equipment', title: b.customer_name, subtitle: b.site_address, amount: b.total_amount_pkr ?? b.rate_pkr, at: b.requested_at, needsAction: b.status === 'requested', done: ['completed', 'declined', 'cancelled'].includes(b.status), href: '/portal/my-vehicle/equipment' })
      }
    }
    if (v.offers_rental) {
      const { data } = await supabase.rpc('vehicle_rental_bookings', { p_vehicle_id: v.id })
      for (const b of (data ?? []) as { id: string; status: string; customer_name: string; from_address: string; to_address: string; total_amount_pkr: number; requested_at: string }[]) {
        out.push({ id: b.id, type: 'rental', title: b.customer_name, subtitle: `${b.from_address} → ${b.to_address}`, amount: b.total_amount_pkr, at: b.requested_at, needsAction: b.status === 'requested', done: ['completed', 'declined', 'cancelled'].includes(b.status), href: '/portal/my-vehicle/rental' })
      }
    }
    {
      const { data } = await supabase.from('ride_bookings').select('id, status, total_amount_pkr, travel_date, vehicle_routes!inner(vehicle_id, origin, destination)').eq('vehicle_routes.vehicle_id', v.id).order('created_at', { ascending: false }).limit(30)
      for (const b of (data ?? []) as unknown as { id: string; status: string; total_amount_pkr: number; travel_date: string; vehicle_routes: { origin: string; destination: string } }[]) {
        out.push({ id: b.id, type: 'route', title: `${b.vehicle_routes.origin} → ${b.vehicle_routes.destination}`, subtitle: t('mv.tab.routes'), amount: b.total_amount_pkr, at: b.travel_date, needsAction: b.status === 'announced', done: b.status === 'rejected' || b.status === 'cancelled', href: '/portal/my-vehicle/routes' })
      }
    }
    {
      // Adda-based bookings have route_id NULL (adda_queue_entry_id set instead) —
      // the route query above's !inner join on vehicle_routes has nothing to
      // match for these, so they need their own query against adda_queue_entries
      // or they silently never appear in this unified list at all.
      const { data } = await supabase.from('ride_bookings').select('id, status, total_amount_pkr, travel_date, adda_queue_entries!inner(vehicle_id, addas(name, name_ur))').eq('adda_queue_entries.vehicle_id', v.id).order('created_at', { ascending: false }).limit(30)
      for (const b of (data ?? []) as unknown as { id: string; status: string; total_amount_pkr: number; travel_date: string; adda_queue_entries: { addas: { name: string; name_ur: string } | null } }[]) {
        const addas = b.adda_queue_entries.addas
        const addaName = addas ? (isUrdu ? (addas.name_ur || addas.name) : addas.name) : t('mv.tab.adda')
        out.push({ id: b.id, type: 'route', title: addaName, subtitle: t('mv.tab.adda'), amount: b.total_amount_pkr, at: b.travel_date, needsAction: b.status === 'announced', done: b.status === 'rejected' || b.status === 'cancelled', href: '/portal/my-vehicle/adda' })
      }
    }
    {
      const [{ data: dispatch }, { data: cp }, { data: parcels }] = await Promise.all([
        supabase.rpc('my_dispatch_invitations', { p_vehicle_id: v.id }),
        supabase.rpc('my_city_purchase_invitations', { p_vehicle_id: v.id }),
        supabase.rpc('my_parcel_delivery_invitations', { p_vehicle_id: v.id }),
      ])
      for (const d of (dispatch ?? []) as { call_id: string; item: string; address: string; goods_budget_pkr: number; shop_name: string }[]) {
        out.push({ id: d.call_id, type: 'dispatch', title: d.item, subtitle: d.address, amount: d.goods_budget_pkr, at: new Date().toISOString(), needsAction: true, done: false, href: '/portal/my-vehicle/requests' })
      }
      for (const c of (cp ?? []) as { request_id: string; item: string; goods_budget_pkr: number; pickup_label: string | null }[]) {
        out.push({ id: c.request_id, type: 'city_purchase', title: c.item, subtitle: c.pickup_label ?? '', amount: c.goods_budget_pkr, at: new Date().toISOString(), needsAction: true, done: false, href: '/portal/my-vehicle/requests' })
      }
      for (const p of (parcels ?? []) as { delivery_id: string; description: string; pickup_label: string | null }[]) {
        out.push({ id: p.delivery_id, type: 'parcel', title: p.description, subtitle: p.pickup_label ?? '', amount: null, at: new Date().toISOString(), needsAction: true, done: false, href: '/portal/my-vehicle/requests' })
      }
    }
    {
      const { data } = await supabase.rpc('my_pending_ride_dispatch_requests', { p_vehicle_id: v.id })
      for (const r of (data ?? []) as { id: string; pickup_label: string; dropoff_label: string; fare_pkr: number; category_emoji: string; category_name: string; created_at: string; rider_trust: QuickActionRow['riderTrust']; rider_tenant_name: string }[]) {
        out.push({
          id: r.id, type: 'ride_dispatch', title: `${r.category_emoji} ${r.category_name}`, subtitle: `${r.pickup_label} → ${r.dropoff_label}`,
          amount: r.fare_pkr, at: r.created_at, needsAction: true, done: false, href: `/portal/marketplace/ride-dispatch/${r.id}`,
          riderTrust: r.rider_trust, riderVillage: r.rider_tenant_name,
        })
      }
    }
    {
      // Real gap found live, 2026-10-26: once a driver accepts a City
      // Purchase invitation above, the request falls out of
      // my_city_purchase_invitations (status moves past 'ringing') but
      // never appeared anywhere else in this list either — an accepted
      // job just vanished from the driver's own Jobs screen with nowhere
      // to go start/complete it. my_city_purchase_requests() already
      // includes driver-accepted rows (as_role: 'driver'), it just
      // wasn't being read from here yet.
      const { data: myCp } = await supabase.rpc('my_city_purchase_requests')
      for (const r of (myCp ?? []) as { id: string; item: string; status: string; estimated_fee_pkr: number | null; total_fare_pkr: number | null; pickup_label: string | null; delivery_label: string | null; created_at: string; as_role: string }[]) {
        if (r.as_role !== 'driver') continue
        out.push({
          id: r.id, type: 'city_purchase', title: r.item,
          subtitle: r.pickup_label && r.delivery_label ? `${r.pickup_label} → ${r.delivery_label}` : (r.pickup_label ?? r.delivery_label ?? ''),
          amount: r.total_fare_pkr ?? r.estimated_fee_pkr, at: r.created_at,
          needsAction: false, done: ['completed', 'cancelled'].includes(r.status),
          href: `/portal/marketplace/city-purchase/${r.id}`,
        })
      }
    }
    if (v.delivers) {
      const { data } = await supabase.rpc('my_shop_delivery_invitations', { p_vehicle_id: v.id })
      for (const i of (data ?? []) as { order_id: string; shop_name: string; delivery_address: string; delivery_fee_pkr: number; invited_at: string }[]) {
        out.push({ id: i.order_id, type: 'delivery', title: i.shop_name, subtitle: i.delivery_address, amount: i.delivery_fee_pkr, at: i.invited_at, needsAction: true, done: false, href: '/portal/my-vehicle/deliveries' })
      }
    }

    out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    setRows(out)
    setLoading(false)
    refreshBadge()
  }, [supabase, t]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, offers_hourly, offers_shadi, offers_rental, offers_machinery, offers_tractor, offers_loader, delivers').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      if (!data) { setLoading(false); return }
      const v: Vehicle = { id: data.id, offers_hourly: data.offers_hourly, offers_shadi: data.offers_shadi, offers_rental: data.offers_rental, offers_equipment: !!(data.offers_machinery || data.offers_tractor || data.offers_loader), delivers: data.delivers }
      setVehicle(v)
      reload(v)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!vehicle) return
    const iv = setInterval(() => reload(vehicle), 20000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle])

  const ICONS: Record<Row['type'], typeof Bus> = { hourly: Clock3, shadi: Users2, equipment: Wrench, rental: Navigation, route: RouteIcon, dispatch: ShoppingBag, city_purchase: ShoppingBag, delivery: Package, parcel: Package, ride_dispatch: Car }
  // Was flat #F9F9F6 — identical to the page background, so the icon badge
  // had no visible boundary. Tinted per job type, same pattern already
  // fixed on the equipment browse cards.
  const TINTS: Record<Row['type'], string> = { hourly: '#fef9c3', shadi: '#fce7f3', equipment: '#fde68a', rental: '#f3e8ff', route: '#dcfce7', dispatch: '#e0e7ff', city_purchase: '#ffe4e6', delivery: '#ffedd5', parcel: '#ffedd5', ride_dispatch: '#dbeafe' }

  const groups = { new: rows.filter((r) => r.needsAction), active: rows.filter((r) => !r.needsAction && !r.done), done: rows.filter((r) => r.done) }
  const list = groups[seg]

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] text-[#005A36]">{t('mb.navJobs')}</h1>

      <div className="flex items-center gap-1 bg-white border border-[#e5e2d0] rounded-full p-1 w-fit">
        {(['new', 'active', 'done'] as const).map((k) => (
          <button key={k} onClick={() => setSeg(k)} className="px-3.5 py-1.5 rounded-full text-[12px] font-sans font-bold cursor-pointer whitespace-nowrap"
            style={{ background: seg === k ? '#166534' : 'transparent', color: seg === k ? '#fff' : '#64748b' }}>
            {t(`vp.jobsSeg.${k}`)} ({groups[k].length})
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t(`vp.jobsEmpty.${seg}`)}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((r) => {
            const Icon = ICONS[r.type]
            const content = (
              <>
                <span className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: TINTS[r.type] }}><Icon size={17} className="text-[#1e293b]/70" /></span>
                <span className="flex-1 min-w-0">
                  <span className="block font-sans text-[13.5px] font-bold text-[#1e293b] truncate">{r.title}</span>
                  <span className="block font-sans text-[12px] text-[#64748b] truncate">{r.subtitle}</span>
                </span>
                {r.amount != null && <span className="shrink-0 font-sans text-[13.5px] font-bold text-[#1e293b] ltr-num">{fmt(r.amount)}</span>}
              </>
            )
            const rowStyle = r.needsAction ? { borderInlineStart: '4px solid #D4AF37' } : undefined
            return isQuickActionKind(r.type) ? (
              <button key={`${r.type}-${r.id}`} onClick={() => setOpenJob(r)} className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3 text-start cursor-pointer" style={rowStyle}>
                {content}
              </button>
            ) : (
              <Link key={`${r.type}-${r.id}`} href={r.href} className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3" style={rowStyle}>
                {content}
              </Link>
            )
          })}
        </div>
      )}

      {openJob && isQuickActionKind(openJob.type) && (
        <JobQuickActionSheet
          row={{ id: openJob.id, type: openJob.type, title: openJob.title, subtitle: openJob.subtitle, amount: openJob.amount, href: openJob.href, needsAction: openJob.needsAction, riderTrust: openJob.riderTrust, riderVillage: openJob.riderVillage }}
          vehicleId={vehicle?.id ?? null}
          onClose={() => setOpenJob(null)}
          onDone={() => vehicle && reload(vehicle)}
        />
      )}
    </div>
  )
}
