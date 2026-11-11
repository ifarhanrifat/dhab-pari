'use client'

// Driver Home — the design file's own `driver:home` screen.
//
// Two real mismatches found auditing against the actual design (not the
// plain prototype used earlier by mistake):
// 1. The profile/toggle/stats/wallet were split across several separate
//    white cards. The design renders all of it as ONE green gradient
//    hero card (#005A36→#166534) — name/vehicle/plate/toggle, a status
//    dot+line, a 2x2 stats grid (today's earnings/total jobs/rating/
//    committee-fee-or-plan-validity), and the gold wallet button, all
//    inside that single card. Rebuilt to match exactly.
// 2. "Publish a shared ride" (📢 اعلان کریں) used to be a condensed
//    inline quick-poster here, separate from the richer /my-vehicle/
//    trips page and from Routes entirely. Real ask, 2026-11-11: "two
//    buttons will replace the current existing creating route setup" —
//    the quick-poster panel is retired (its one real capability, a
//    true one-off single-day post, now lives inside Regular Sharing
//    Route's own "just once" mode, see routes/page.tsx). /my-vehicle/
//    trips and everything riders use against it are untouched — a
//    separate, larger retirement, not this pass.
//
// City-presence is this app's own real addition (the design has no
// multi-city driver concept) — kept as its own card, not merged into
// the hero, since it isn't part of the design's card at all.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MapPin, Bus, Users2, CalendarClock, ChevronRight, AlertCircle, CalendarDays, Repeat } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { useDriverJobsBadge } from '@/components/mobility/DriverJobsBadgeContext'
import { getCurrentPositionOnce } from '@/hooks/useLiveLocation'
import { CityReturnDemandCard } from '@/components/mobility/CityReturnDemandCard'

interface Vehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string; is_online: boolean; total_seats: number }
interface Summary {
  today_earnings_pkr: number; today_jobs_count: number; pending_bookings_count: number
  avg_rating: number | null; balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null; commission_pct: number
}
interface City { id: string; name: string; name_ur: string | null }
interface Presence { city_id: string }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() }

export default function MyVehicleHomePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const { count: jobsBadge, refresh: refreshBadge } = useDriverJobsBadge()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [cities, setCities] = useState<City[]>([])
  const [presence, setPresence] = useState<Presence | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [rideEligible, setRideEligible] = useState(false)
  // Real ask, 2026-11-07: "where the route is saving in the main page of
  // the driver" — this card used to be a static "Post a Route" pitch
  // that never changed even once the driver already had one live, giving
  // no sense the feature actually did anything. Now reflects the real
  // route once one exists.
  const [myActiveRoute, setMyActiveRoute] = useState<{ id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; departure_time: string | null; is_monthly_fixed: boolean } | null>(null)

  const reloadPresence = async (vehicleId: string) => {
    const { data: p } = await supabase.from('vehicle_city_presence').select('city_id').eq('vehicle_id', vehicleId).eq('is_active', true).maybeSingle()
    setPresence(p ?? null)
  }
  const reloadMyRoute = async (vehicleId: string) => {
    const { data } = await supabase.from('vehicle_routes')
      .select('id, origin, origin_ur, destination, destination_ur, departure_time, is_monthly_fixed')
      .eq('vehicle_id', vehicleId).eq('is_active', true).maybeSingle()
    setMyActiveRoute(data ?? null)
  }

  useEffect(() => {
    if (!user) return
    const VEHICLE_FIELDS = 'id, owner_name, vehicle_type, vehicle_number, is_online, total_seats'
    Promise.all([
      supabase.from('vehicles').select(VEHICLE_FIELDS).eq('portal_user_id', user.id).maybeSingle(),
      supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order'),
    ]).then(async ([{ data: ownV }, { data: c }]) => {
      setCities(c ?? [])
      // Real gap found live, 2026-11-11: a fleet owner/staff with no
      // vehicle of their own (844/854) saw this whole page render
      // nothing at all — same fallback now applied here as the layout
      // (my-vehicle/layout.tsx) and routes/equipment pages already use:
      // fall back to the first fleet vehicle so the home screen (and
      // its "Manage my fleet" link) actually renders for them.
      let v = ownV
      if (!v) {
        const { data: fleet } = await supabase.rpc('my_fleet_vehicles')
        const firstFleetId = (fleet as { id: string }[] | null)?.[0]?.id
        if (firstFleetId) {
          const { data: fv } = await supabase.from('vehicles').select(VEHICLE_FIELDS).eq('id', firstFleetId).maybeSingle()
          v = fv
        }
      }
      if (v) {
        setVehicle(v)
        const [{ data: sc }, { data: offers }] = await Promise.all([
          supabase.from('service_classes').select('id, ride_eligible').eq('is_active', true),
          supabase.from('vehicle_service_offers').select('service_class_id').eq('vehicle_id', v.id).eq('is_active', true),
          supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: v.id }).then(({ data: s }) => setSummary(s as unknown as Summary)),
          reloadPresence(v.id),
          reloadMyRoute(v.id),
        ])
        const mine = new Set((offers ?? []).map((o) => o.service_class_id))
        const myClasses = (sc ?? []).filter((cl) => mine.has(cl.id))
        setRideEligible(myClasses.length === 0 || myClasses.some((cl) => cl.ride_eligible))
      }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic refresh (useVehicleLocationRefresh) now lives at the
  // my-vehicle/layout.tsx level, not here — see that hook's own header
  // comment for why it was moved and why it now uses the Capacitor-
  // aware getCurrentPositionOnce() below instead of raw navigator.geolocation.

  const toggleOnline = async () => {
    if (!vehicle) return
    const goingOnline = !vehicle.is_online
    setSaving(true)

    // Real ask, 2026-10-17: "why is there a manual 'where are you now'
    // button, why not the system just knows" -- going online now grabs
    // one GPS fix automatically instead. Best-effort only: a denied
    // permission or a timeout still lets the driver go online, just
    // without a location on file for that session (same as before this
    // change existed at all) -- never block the actual toggle on it.
    let lat: number | null = null, lng: number | null = null
    if (goingOnline) {
      try {
        const pos = await getCurrentPositionOnce()
        lat = pos.lat
        lng = pos.lng
      } catch { /* denied/unavailable — go online anyway, without a location */ }
    }

    const { error } = await supabase.rpc('set_vehicle_online_status', {
      p_vehicle_id: vehicle.id, p_is_online: goingOnline, p_lat: lat, p_lng: lng,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, is_online: goingOnline })
    toast.success(goingOnline ? t('vp.wentOnlineToast') : t('vp.wentOfflineToast'))
  }

  const pickCity = async (cityId: string) => {
    if (!vehicle) return
    setSaving(true)
    const { error } = presence?.city_id === cityId
      ? await supabase.rpc('vehicle_check_out_city', { p_vehicle_id: vehicle.id })
      : await supabase.rpc('vehicle_check_in_city', { p_vehicle_id: vehicle.id, p_city_id: cityId })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reloadPresence(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return null // layout's own guard already handled the no-vehicle case

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl text-white p-3.5 flex flex-col gap-2.5" style={{ background: 'linear-gradient(to right,#005A36,#166534)', border: '1px solid rgba(212,175,55,.2)' }}>
        <div className="flex items-center gap-2.5">
          <span className="shrink-0 w-[42px] h-[42px] rounded-full bg-[#D4AF37] flex items-center justify-center font-bold text-[18px] text-[#0f172a]">{initials(vehicle.owner_name)}</span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[14.5px] font-bold truncate">{vehicle.owner_name}</p>
            <p className="font-sans text-[10.5px] text-[#dcfce7] truncate">{vehicle.vehicle_type} · <span className="ltr-num">{vehicle.vehicle_number}</span></p>
          </div>
          <button onClick={toggleOnline} disabled={saving} className="relative shrink-0 w-[46px] h-[26px] rounded-full border-0 cursor-pointer disabled:opacity-50 transition-colors" style={{ background: vehicle.is_online ? 'rgba(74,222,128,.9)' : 'rgba(255,255,255,.25)' }}>
            <span className="absolute top-[3px] w-5 h-5 rounded-full bg-white shadow transition-all" style={{ insetInlineStart: vehicle.is_online ? '23px' : '3px' }} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[#dcfce7]">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: vehicle.is_online ? '#4ade80' : '#94a3b8' }} />
          {vehicle.is_online ? t('vp.onlineLabel') : t('vp.offlineLabel')}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold ltr-num leading-tight">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{t('mv.todayLabel')}</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold ltr-num leading-tight">{summary?.today_jobs_count ?? 0}</p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{t('mv.jobsSuffix')}</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold leading-tight">{summary?.avg_rating != null ? `⭐ ${summary.avg_rating}` : '—'}</p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{t('vp.ratingLabel')}</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <p className="font-sans text-[13.5px] font-extrabold ltr-num leading-tight">
              {summary?.commission_mode === 'monthly_lumpsum' ? fmt(summary?.lumpsum_fee_pkr ?? 0) : `${summary?.commission_pct ?? 0}%`}
            </p>
            <p className="font-sans text-[8.5px] text-[#dcfce7]">{summary?.commission_mode === 'monthly_lumpsum' ? t('mv.lumpsumModeLabel') : t('mv.perOrderModeLabel')}</p>
          </div>
        </div>
        <Link href="/portal/my-vehicle/earnings" className="flex items-center gap-2 rounded-xl px-2.5 py-1.5" style={{ background: '#D4AF37', color: '#0f172a' }}>
          <span className="shrink-0 text-[15px]">💼</span>
          <span className="flex-1 font-sans text-[10.5px] font-bold">{t('vp.walletSummaryLabel')}</span>
          <ChevronRight size={14} className={`shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      </section>

      {/* Real ask, 2026-11-11: "two buttons... monthly fix route and
          regular sharing routes... beautiful" — replaces both the old
          inline quick-poster above and the single plain "Post daily
          route" link below with one pair of prominent, matched cards.
          If a route already exists, create_vehicle_route_self (844+)
          blocks a second one anyway, so the summary card below takes
          over instead of showing these. */}
      {rideEligible && !myActiveRoute && (
        <div className="grid grid-cols-2 gap-2.5">
          <Link href="/portal/my-vehicle/routes?mode=monthly" className="flex flex-col gap-2 rounded-2xl p-3.5 text-white" style={{ background: 'linear-gradient(135deg,#D4AF37,#b8932c)' }}>
            <span className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center"><CalendarDays size={18} /></span>
            <span className="font-sans text-[13.5px] font-extrabold leading-tight">{t('mv.monthlyFixRouteBtn')}</span>
            <span className="font-sans text-[10px] text-white/85 leading-tight">{t('mv.monthlyFixRouteHint')}</span>
          </Link>
          <Link href="/portal/my-vehicle/routes?mode=regular" className="flex flex-col gap-2 rounded-2xl p-3.5 text-white" style={{ background: 'linear-gradient(135deg,#166534,#0f4c2a)' }}>
            <span className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center"><Repeat size={18} /></span>
            <span className="font-sans text-[13.5px] font-extrabold leading-tight">{t('mv.regularSharingRouteBtn')}</span>
            <span className="font-sans text-[10px] text-white/85 leading-tight">{t('mv.regularSharingRouteHint')}</span>
          </Link>
        </div>
      )}

      {/* 853: self-service fleet management — reachable by everyone,
          not just rideEligible, since a machinery/equipment-only owner
          with multiple machines needs this too. */}
      <Link href="/portal/my-vehicle/fleet" className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-2.5 hover:border-[#166534]">
        <span className="shrink-0 w-9 h-9 rounded-full bg-[#F0FDF4] flex items-center justify-center"><Users2 size={16} className="text-[#166534]" /></span>
        <span className="font-sans text-[13px] font-bold text-[#1e293b]">{t('mv.manageMyFleetBtn')}</span>
        <ChevronRight size={14} className={`shrink-0 ms-auto ${isUrdu ? 'rotate-180' : ''}`} />
      </Link>

      {myActiveRoute && (
        <Link href="/portal/my-vehicle/routes" className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center gap-3 hover:border-[#166534]">
          <span className="shrink-0 w-10 h-10 rounded-full bg-[#F0FDF4] flex items-center justify-center"><Repeat size={18} className="text-[#166534]" /></span>
          <span className="flex-1 min-w-0">
            <span className="block font-sans text-[13px] font-bold text-[#005A36] truncate">
              {isUrdu && myActiveRoute.origin_ur ? myActiveRoute.origin_ur : myActiveRoute.origin} → {isUrdu && myActiveRoute.destination_ur ? myActiveRoute.destination_ur : myActiveRoute.destination}
            </span>
            <span className="block font-sans text-[10.5px] text-[#64748b] mt-0.5 ltr-num">
              {myActiveRoute.is_monthly_fixed && `✅ ${t('mv.monthlyFixedBadge')} · `}
              {myActiveRoute.departure_time ? `🕒 ${myActiveRoute.departure_time.slice(0, 5)}` : t('mk.noFixedTime')}
            </span>
          </span>
          <ChevronRight size={16} className={`shrink-0 text-[#166534] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      )}

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('vp.cityPresenceLabel')}</p>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5">
          {cities.map((c) => {
            const active = presence?.city_id === c.id
            return (
              <button key={c.id} onClick={() => pickCity(c.id)} disabled={saving} className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer disabled:opacity-50"
                style={{ background: active ? '#166534' : '#fff', color: active ? '#fff' : '#64748b', border: `1px solid ${active ? '#166534' : '#e5e2d0'}` }}>
                {active && <MapPin size={11} className="inline me-1 -mt-0.5" />}
                {isUrdu && c.name_ur ? c.name_ur : c.name}
              </button>
            )
          })}
        </div>
      </div>

      <CityReturnDemandCard />

      {jobsBadge > 0 && (
        <Link href="/portal/my-vehicle/jobs" onClick={() => refreshBadge()} className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-2xl p-3">
          <AlertCircle size={18} className="text-amber-700 shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block font-sans text-[13px] font-bold text-amber-900">{t('vp.newJobsBannerTitle').replace('{n}', String(jobsBadge))}</span>
            <span className="block font-sans text-[11.5px] text-amber-700">{t('vp.newJobsBannerBody')}</span>
          </span>
          <ChevronRight size={16} className={`text-amber-700 shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      )}

      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mt-1">{t('vp.moreServicesHeading')}</p>
      <div className="grid grid-cols-2 gap-2.5">
        <Link href="/portal/my-vehicle/adda" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Bus size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.adda')}</span>
        </Link>
        <Link href="/portal/my-vehicle/trips" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Users2 size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.trips')}</span>
        </Link>
        <Link href="/portal/my-vehicle/weekend" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><CalendarClock size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.weekend')}</span>
        </Link>
      </div>
    </div>
  )
}
