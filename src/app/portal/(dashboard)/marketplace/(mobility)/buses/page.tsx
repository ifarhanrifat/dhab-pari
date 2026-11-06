'use client'

// Real ask, 2026-10-30: "for the sharing ride I want a tab for the
// riders who can browse these saved sharing routes — like a complete bus
// booking system, where the driver can chat with the bookers and confirm
// when and where the vehicle will leave... with beautiful cards for each
// city's vehicles." Every piece already existed but was scattered: the
// drivers' saved weekly routes (vehicle_routes), one-off shared trips
// (vehicle_trip_offers), seat booking + the route's own group chat and
// live departure status (route/[routeId], RouteGroupPanel), the rider's
// own seats (ride_bookings). This is the one place to browse them all,
// grouped by destination city, as bus-ticket style cards — booking and
// the group chat stay on the route's own page, one tap away.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Bus, Search, Clock, Users, MessageCircle, ArrowRight, CalendarDays, Repeat } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { FarePolicyCard } from '@/components/mobility/FarePolicyCard'

interface VehicleLite { owner_name: string; vehicle_type: string; model: string | null; color: string | null; total_seats: number | null; has_ac: boolean | null; vehicle_number: string | null }
interface RouteRow {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  fare_per_seat_pkr: number | null; departure_time: string | null; return_departure_time: string | null; days_of_week: number[] | null
  is_two_way: boolean | null; is_monthly_fixed: boolean | null; distance_km: number | null; route_duration_min: number | null
  vehicles: VehicleLite | null
}
interface TripRow {
  id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  travel_date: string; departure_time_estimate: string | null; seats_available: number; listed_fare_per_seat_pkr: number; trip_type: string | null
  vehicles: VehicleLite | null
}
interface MySeat {
  id: string; status: string; seats: number; travel_date: string; route_id: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; departure_time: string | null } | null
}

const PALETTE = [
  ['#065f46', '#10b981'], ['#1e3a8a', '#3b82f6'], ['#7c2d12', '#f97316'], ['#581c87', '#a855f7'], ['#0f766e', '#2dd4bf'], ['#9d174d', '#ec4899'],
]
function hashIdx(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % PALETTE.length }
type VehicleGroup = 'shared' | 'auto' | 'bike' | 'car'
function vehicleGroupFor(type: string | undefined): VehicleGroup {
  const t = (type ?? '').toLowerCase()
  if (/coaster|bus|hiace|van|wagon|bolan|carry/.test(t)) return 'shared'
  if (/rickshaw|qingqi|loader/.test(t)) return 'auto'
  if (/bike|motor/.test(t)) return 'bike'
  return 'car'
}
function emojiFor(type: string | undefined) {
  const g = vehicleGroupFor(type)
  if (g === 'shared') return '🚐'
  if (g === 'auto') return '🛺'
  if (g === 'bike') return '🏍️'
  return '🚗'
}
function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function BusesPage() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const [routes, setRoutes] = useState<RouteRow[]>([])
  const [trips, setTrips] = useState<TripRow[]>([])
  const [mine, setMine] = useState<MySeat[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [city, setCity] = useState<string | null>(null)
  const [vehicleGroup, setVehicleGroup] = useState<VehicleGroup | null>(null)

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    const today = new Date().toISOString().slice(0, 10)
    const veh = 'vehicles(owner_name, vehicle_type, model, color, total_seats, has_ac, vehicle_number)'
    Promise.all([
      supabase.from('vehicle_routes').select(`id, origin, origin_ur, destination, destination_ur, fare_per_seat_pkr, departure_time, return_departure_time, days_of_week, is_two_way, is_monthly_fixed, distance_km, route_duration_min, ${veh}`).eq('is_active', true).order('departure_time'),
      supabase.from('vehicle_trip_offers').select(`id, origin, origin_ur, destination, destination_ur, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, trip_type, ${veh}`).eq('status', 'open').gte('travel_date', today).order('travel_date'),
      supabase.from('ride_bookings').select('id, status, seats, travel_date, route_id, vehicle_routes(origin, origin_ur, destination, destination_ur, departure_time)').eq('portal_user_id', user.id).in('status', ['announced', 'confirmed']).gte('travel_date', today).order('travel_date'),
    ]).then(([r, o, m]) => {
      setRoutes((r.data ?? []) as unknown as RouteRow[])
      setTrips((o.data ?? []) as unknown as TripRow[])
      setMine((m.data ?? []) as unknown as MySeat[])
      setLoading(false)
    })
  }, [user])

  const nm = (en: string, ur: string | null) => (isUrdu && ur ? ur : en)
  const timeLabel = (tm: string | null) => {
    if (!tm) return '—'
    const [h, m] = tm.split(':').map(Number)
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(isUrdu ? 'ur-PK' : 'en-PK', { hour: 'numeric', minute: '2-digit' })
  }
  const dayNames = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((d) => new Date(2023, 0, 1 + d).toLocaleDateString(isUrdu ? 'ur-PK' : 'en-PK', { weekday: 'narrow' })), [isUrdu])
  const todayDow = new Date().getDay()

  // Group every route and trip by destination city.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (a: string, b: string | null, c: string, d: string | null) =>
      !q || [a, b, c, d].some((x) => x && x.toLowerCase().includes(q))
    const groupOk = (type: string | undefined) => !vehicleGroup || vehicleGroupFor(type) === vehicleGroup
    const map = new Map<string, { key: string; label: string; routes: RouteRow[]; trips: TripRow[] }>()
    const add = (dest: string, destUr: string | null) => {
      const key = dest.trim().toLowerCase()
      if (!map.has(key)) map.set(key, { key, label: nm(dest, destUr), routes: [], trips: [] })
      return map.get(key)!
    }
    for (const r of routes) if (match(r.origin, r.origin_ur, r.destination, r.destination_ur) && groupOk(r.vehicles?.vehicle_type)) add(r.destination, r.destination_ur).routes.push(r)
    for (const o of trips) if (match(o.origin, o.origin_ur, o.destination, o.destination_ur) && groupOk(o.vehicles?.vehicle_type)) add(o.destination, o.destination_ur).trips.push(o)
    return Array.from(map.values()).sort((a, b) => (b.routes.length + b.trips.length) - (a.routes.length + a.trips.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, trips, query, vehicleGroup, isUrdu])
  const shown = city ? groups.filter((g) => g.key === city) : groups

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-4 pb-6">
      <div className="rounded-[24px] p-4 text-white" style={{ backgroundImage: 'linear-gradient(140deg,#0f3d2e,#166534 55%,#15803d)' }}>
        <p className="flex items-center gap-2 font-sans text-[20px] font-extrabold"><Bus size={22} /> {t('bus.title')}</p>
        <p className="font-sans text-[12.5px] text-white/85 mt-1">{t('bus.subtitle')}</p>
        <div className="mt-3 flex items-center gap-2 bg-white rounded-2xl px-3 h-11">
          <Search size={16} className="text-[#64748b] shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('bus.searchPlaceholder')}
            className="flex-1 min-w-0 bg-transparent outline-none font-sans text-[14px] text-[#0f172a]" />
        </div>
      </div>

      {mine.length > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-[#64748b] mb-2">{t('bus.mySeats')}</p>
          <div className="flex gap-2.5 overflow-x-auto hide-scrollbar pb-1">
            {mine.map((s) => {
              const r = s.vehicle_routes
              return (
                <Link key={s.id} href={s.route_id ? `/portal/marketplace/route/${s.route_id}` : '/portal/marketplace/trips'}
                  className="shrink-0 w-[230px] rounded-2xl bg-white border border-[#e5e7eb] p-3 shadow-sm">
                  <p className="font-sans text-[13px] font-bold text-[#0f172a] truncate">{r ? `${nm(r.origin, r.origin_ur)} → ${nm(r.destination, r.destination_ur)}` : '—'}</p>
                  <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5 ltr-num">{s.travel_date} · {r ? timeLabel(r.departure_time) : ''} · {t('rw.seats').replace('{n}', String(s.seats))}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full ${s.status === 'confirmed' ? 'bg-[#dcfce7] text-[#166534]' : 'bg-[#fef3c7] text-[#92400e]'}`}>
                      {s.status === 'confirmed' ? t('bus.confirmed') : t('bus.awaiting')}
                    </span>
                    <span className="flex items-center gap-1 text-[11.5px] font-bold text-[#166534]"><MessageCircle size={13} /> {t('bus.groupChat')}</span>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto hide-scrollbar">
        {([null, 'shared', 'car', 'auto', 'bike'] as const).map((g) => (
          <button key={g ?? 'all'} onClick={() => setVehicleGroup(g)}
            className={`shrink-0 h-9 px-3.5 rounded-full font-sans text-[12.5px] font-bold border ${vehicleGroup === g ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>
            {g === null ? t('bus.filterAll') : g === 'shared' ? t('bus.filterShared') : g === 'car' ? t('bus.filterCar') : g === 'auto' ? t('bus.filterAuto') : t('bus.filterBike')}
          </button>
        ))}
      </div>

      {groups.length > 1 && (
        <div className="flex gap-2 overflow-x-auto hide-scrollbar">
          <button onClick={() => setCity(null)} className={`shrink-0 h-9 px-3.5 rounded-full font-sans text-[12.5px] font-bold border ${!city ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>{t('bus.allCities')}</button>
          {groups.map((g) => (
            <button key={g.key} onClick={() => setCity(g.key)} className={`shrink-0 h-9 px-3.5 rounded-full font-sans text-[12.5px] font-bold border ${city === g.key ? 'bg-[#166534] text-white border-[#166534]' : 'bg-white text-[#334155] border-[#e5e7eb]'}`}>
              <bdi>{g.label}</bdi> <span className="opacity-70 ltr-num">{g.routes.length + g.trips.length}</span>
            </button>
          ))}
        </div>
      )}

      <FarePolicyCard service="seat" defaultOpen={false} />

      {shown.length === 0 && <p className="text-center font-sans text-[13px] text-[#64748b] py-10">{t('bus.empty')}</p>}

      {shown.map((g) => (
        <section key={g.key} className="flex flex-col gap-2.5">
          <p className="flex items-center gap-2 font-sans text-[16px] font-extrabold text-[#0f172a]"><span className="w-1.5 h-5 rounded-full bg-[#16a34a]" /> <bdi>{g.label}</bdi></p>

          {g.routes.map((r) => {
            const [c1, c2] = PALETTE[hashIdx(r.destination)]
            const runsToday = (r.days_of_week ?? []).includes(todayDow)
            return (
              <Link key={r.id} href={`/portal/marketplace/route/${r.id}`} className="block rounded-[22px] overflow-hidden bg-white border border-[#e5e7eb] shadow-[0_8px_24px_-14px_rgba(15,23,42,0.35)] active:scale-[0.99] transition-transform">
                <div className="relative px-4 pt-3.5 pb-4 text-white" style={{ backgroundImage: `linear-gradient(135deg, ${c1}, ${c2})` }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[11px] font-semibold text-white/80">{t('bus.departs')}</p>
                      <p className="font-sans text-[24px] font-black leading-none mt-0.5"><span className="ltr-num">{timeLabel(r.departure_time)}</span></p>
                    </div>
                    <span className="text-[34px] leading-none">{emojiFor(r.vehicles?.vehicle_type)}</span>
                  </div>
                  <div className="mt-3 flex items-center gap-2 font-sans text-[14px] font-bold">
                    <bdi className="truncate">{nm(r.origin, r.origin_ur)}</bdi>
                    <ArrowRight size={15} className="shrink-0 rtl:rotate-180" />
                    <bdi className="truncate">{nm(r.destination, r.destination_ur)}</bdi>
                  </div>
                  <div className="mt-2.5 flex gap-1">
                    {dayNames.map((d, i) => (
                      <span key={i} className={`w-6 h-6 rounded-full flex items-center justify-center text-[10.5px] font-bold ${(r.days_of_week ?? []).includes(i) ? 'bg-white text-[#0f172a]' : 'bg-white/15 text-white/60'}`}>{d}</span>
                    ))}
                  </div>
                </div>
                <div className="px-4 py-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-sans text-[13px] font-bold text-[#0f172a] truncate">{r.vehicles ? vehicleDisplayName(r.vehicles.vehicle_type, r.vehicles.model) : '—'}</p>
                    <p className="font-sans text-[11.5px] text-[#64748b] truncate">{r.vehicles?.owner_name}{r.vehicles?.has_ac ? ' · AC' : ''}{r.vehicles?.total_seats ? ` · ${r.vehicles.total_seats} ${t('bus.seatsShort')}` : ''}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {runsToday && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[#dcfce7] text-[#166534]">{t('bus.today')}</span>}
                      {r.is_two_way && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[#e0f2fe] text-[#075985] inline-flex items-center gap-1"><Repeat size={10} /> {t('bus.twoWay')}{r.return_departure_time ? ` · ${timeLabel(r.return_departure_time)}` : ''}</span>}
                      {r.is_monthly_fixed && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[#f3e8ff] text-[#6b21a8]">{t('bus.monthly')}</span>}
                      {r.route_duration_min && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[#f1f5f9] text-[#334155] inline-flex items-center gap-1"><Clock size={10} /> <span className="ltr-num">{Math.round(r.route_duration_min)} min</span></span>}
                    </div>
                  </div>
                  <div className="text-end shrink-0">
                    {r.fare_per_seat_pkr != null && <p className="font-sans text-[18px] font-black text-[#14532d]"><span className="ltr-num">₨{fmt(r.fare_per_seat_pkr)}</span></p>}
                    <p className="font-sans text-[10.5px] text-[#64748b]">{t('bus.perSeat')}</p>
                    <span className="mt-1.5 inline-flex items-center gap-1 h-8 px-3 rounded-full bg-[#15803d] text-white font-sans text-[12px] font-bold">{t('bus.book')}</span>
                  </div>
                </div>
              </Link>
            )
          })}

          {g.trips.map((o) => (
            <Link key={o.id} href={`/portal/marketplace/shared`} className="block rounded-[22px] bg-white border border-dashed border-[#94a3b8] p-3.5 active:scale-[0.99] transition-transform">
              <div className="flex items-center gap-3">
                <span className="w-12 h-12 rounded-2xl bg-[#f1f5f9] flex items-center justify-center text-[26px] shrink-0">{emojiFor(o.vehicles?.vehicle_type)}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-[10.5px] font-bold text-[#7c3aed] flex items-center gap-1"><CalendarDays size={11} /> {t('bus.oneOffTrip')} · <span className="ltr-num">{o.travel_date}</span> · {timeLabel(o.departure_time_estimate)}</p>
                  <p className="font-sans text-[13.5px] font-bold text-[#0f172a] truncate"><bdi>{nm(o.origin, o.origin_ur)}</bdi> → <bdi>{nm(o.destination, o.destination_ur)}</bdi></p>
                  <p className="font-sans text-[11.5px] text-[#64748b] truncate flex items-center gap-1"><Users size={11} /> {o.seats_available} {t('bus.seatsLeft')} · {o.vehicles?.owner_name}</p>
                </div>
                <p className="font-sans text-[16px] font-black text-[#14532d] shrink-0"><span className="ltr-num">₨{fmt(o.listed_fare_per_seat_pkr)}</span></p>
              </div>
            </Link>
          ))}
        </section>
      ))}
    </div>
  )
}
