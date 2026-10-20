'use client'

// Home screen of the new "Dhab Pari Mobility" design — rebuilt here
// (replacing the old marketplace/travel tile-list hub, not the
// top-level /marketplace two-pillar page, which stays untouched so
// Shops access isn't dropped). Visual/structural fidelity to the design
// file's own v.rHome: a service-tile belt, a from/to search card, city
// quick-chips, and the live adda departure board — all wired to real
// data (cities, addas/adda_board, vehicle_routes), not the design's own
// demo formulas/seed data.
//
// "Find vehicles" navigates to /portal/marketplace/results with the
// picked destination as a query param, a real route rather than the
// design's in-memory view-toggle, matching this app's own established
// preference for real routes per screen (see my-vehicle's 7-screen split).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Search, Bus, MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityServiceTile } from '@/components/mobility/MobilityServiceTile'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { FindRideNearStopSheet } from '@/components/mobility/FindRideNearStopSheet'
import type { MapPin as LeafletPin } from '@/components/shared/LeafletMap'

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface City { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_per_seat_pkr: number; is_monthly_fixed: boolean; monthly_reference_fee_pkr: number | null
}
interface AddaBoardEntry {
  entry_id: string; status: string; position: number
  turn_expires_at: string | null; seats_total: number; seats_available: number
  fare_mode: string; fixed_fare_per_seat_pkr: number | null; owner_name: string; vehicle_type: string
}
interface Adda { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null }
interface AddaBoard { adda: Adda; entries: AddaBoardEntry[] }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

const SERVICES = [
  { key: 'adda', emoji: '🚐', tint: '#dcfce7', href: '/portal/marketplace/adda' },
  { key: 'shared', emoji: '👥', tint: '#e0f2fe', href: '/portal/marketplace/shared' },
  { key: 'rental', emoji: '🚗', tint: '#f3e8ff', href: '/portal/marketplace/rental' },
  { key: 'purchase', emoji: '🛍️', tint: '#ffe4e6', href: '/portal/marketplace/city-purchase' },
  { key: 'parcel', emoji: '📦', tint: '#fef3c7', href: '/portal/marketplace/parcel' },
  { key: 'hourly', emoji: '⏱️', tint: '#e0e7ff', href: '/portal/marketplace/hourly' },
  { key: 'tractor', emoji: '🚜', tint: '#d1fae5', href: '/portal/marketplace/tractor' },
  { key: 'machine', emoji: '🏗️', tint: '#fde68a', href: '/portal/marketplace/machinery' },
  { key: 'wedding', emoji: '💍', tint: '#fce7f3', href: '/portal/marketplace/shadi' },
  { key: 'loading', emoji: '🚚', tint: '#ffedd5', href: '/portal/marketplace/loader' },
] as const

export default function MobilityHomePage() {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const supabase = createClient()

  const [cities, setCities] = useState<City[]>([])
  const [origin, setOrigin] = useState<{ lat: number; lng: number; name: string; id: string } | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [toCity, setToCity] = useState<City | null>(null)
  const [mainAdda, setMainAdda] = useState<Adda | null>(null)
  const [board, setBoard] = useState<AddaBoard | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [destPin, setDestPin] = useState<PickedLocation | null>(null)
  const [showOriginPicker, setShowOriginPicker] = useState(false)
  const [showDestPicker, setShowDestPicker] = useState(false)
  const [showNearStop, setShowNearStop] = useState(false)

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
    supabase.from('addas').select('id, name, name_ur, lat, lng').eq('is_active', true).order('name').then(async ({ data }) => {
      const main = data?.[0] ?? null
      setMainAdda(main)
      if (main?.lat && main?.lng) setOrigin({ lat: main.lat, lng: main.lng, name: isUrdu && main.name_ur ? main.name_ur : main.name, id: main.id })
      if (main) {
        const { data: b } = await supabase.rpc('adda_board', { p_adda_id: main.id })
        if (b) setBoard(b)
      }
      setLoading(false)
    })
    supabase.from('vehicle_routes').select('id, vehicle_id, origin, origin_ur, destination, destination_ur, classification, fare_per_seat_pkr, is_monthly_fixed, monthly_reference_fee_pkr').eq('is_active', true).order('origin')
      .then(({ data }) => setRoutes(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])
  useEffect(() => {
    if (!mainAdda) return
    const iv = setInterval(() => supabase.rpc('adda_board', { p_adda_id: mainAdda.id }).then(({ data }) => data && setBoard(data)), 15000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainAdda])

  const current = board?.entries.find((e) => e.status === 'current')
  const secondsLeft = current?.turn_expires_at ? Math.max(0, Math.floor((new Date(current.turn_expires_at).getTime() - now) / 1000)) : null
  const mm = secondsLeft != null ? String(Math.floor(secondsLeft / 60)).padStart(2, '0') : '--'
  const ss = secondsLeft != null ? String(secondsLeft % 60).padStart(2, '0') : '--'

  const findVehicles = () => {
    if (!toCity) return
    const params = new URLSearchParams({ to: toCity.id })
    if (origin) { params.set('from_lat', String(origin.lat)); params.set('from_lng', String(origin.lng)); params.set('from_name', origin.name) }
    router.push(`/portal/marketplace/results?${params.toString()}`)
  }

  const pins: LeafletPin[] = []
  if (origin) pins.push({ lat: origin.lat, lng: origin.lng, label: origin.name, color: '#005A36' })
  for (const c of cities) if (c.lat != null && c.lng != null) pins.push({ lat: c.lat, lng: c.lng, label: isUrdu && c.name_ur ? c.name_ur : c.name, color: c.id === toCity?.id ? '#D4AF37' : '#166534' })
  if (destPin) pins.push({ lat: destPin.lat, lng: destPin.lng, label: destPin.label, color: '#D4AF37' })

  const confirmDestPin = (loc: PickedLocation) => {
    setDestPin(loc)
    setShowDestPicker(false)
    const withCoords = cities.filter((c) => c.lat != null && c.lng != null)
    if (withCoords.length === 0) return
    const nearest = withCoords.reduce((best, c) => haversineKm(loc, { lat: c.lat!, lng: c.lng! }) < haversineKm(loc, { lat: best.lat!, lng: best.lng! }) ? c : best)
    setToCity(nearest)
  }

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3.5">
      {/* Services belt — exact shape: horizontal scroll of tinted pills. */}
      <div className="-mx-3.5 px-3.5 overflow-x-auto">
        <div className="flex gap-1.5 w-max pb-0.5">
          {SERVICES.map((s) => (
            <MobilityServiceTile key={s.key} href={s.href} emoji={s.emoji} tint={s.tint} name={t(`mb.svc.${s.key}`)} />
          ))}
        </div>
      </div>

      {pins.length > 0 && <LeafletMap pins={pins} height={190} className="rounded-2xl" />}

      {/* Search card — real complaint: a map popup opening on top of this
          card "is wrong"; it now expands inline in the same card. */}
      <div className="bg-white rounded-2xl shadow-[0_-6px_20px_rgba(0,0,0,.08)] p-3.5 flex flex-col gap-2.5">
        {showOriginPicker ? (
          <LocationPickerSheet
            title={t('mb.fromPlaceholder')}
            initial={origin ? { lat: origin.lat, lng: origin.lng, label: origin.name } : null}
            defaultCenter={origin ? [origin.lat, origin.lng] : undefined}
            inline
            onClose={() => setShowOriginPicker(false)}
            onConfirm={(loc) => { setOrigin({ lat: loc.lat, lng: loc.lng, name: loc.label, id: 'custom' }); setShowOriginPicker(false) }}
          />
        ) : showDestPicker ? (
          <LocationPickerSheet
            title={t('mb.toPlaceholder')}
            initial={destPin}
            defaultCenter={origin ? [origin.lat, origin.lng] : undefined}
            inline
            onClose={() => setShowDestPicker(false)}
            onConfirm={confirmDestPin}
          />
        ) : (
          <>
            <p className="font-bold text-[15px] text-[#005A36]">{t('mb.whereToHeading')}</p>
            <div className="flex flex-col border border-[#e5e2d0] rounded-2xl overflow-hidden">
              <button onClick={() => setShowOriginPicker(true)} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer text-start">
                <span className="shrink-0 w-2.5 h-2.5 rounded-full border-2 border-[#166534]" />
                <span className="flex-1 min-w-0 text-[13px] font-semibold text-[#334155] truncate">{origin?.name ?? t('mb.fromPlaceholder')}</span>
              </button>
              <div className="h-px bg-[#f1f5f9] ms-8" />
              <button onClick={() => setShowDestPicker(true)} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer text-start">
                <span className="shrink-0 w-2.5 h-2.5 rounded-sm bg-[#D4AF37]" />
                <span className={`flex-1 min-w-0 text-[13px] truncate ${(toCity || destPin) ? 'font-bold text-[#1e293b]' : 'text-[#94a3b8]'}`}>{destPin ? destPin.label : toCity ? (isUrdu && toCity.name_ur ? toCity.name_ur : toCity.name) : t('mb.toPlaceholder')}</span>
                <Search size={13} className="shrink-0 text-[#94a3b8]" />
              </button>
            </div>

            <div className="-mx-3.5 px-3.5 overflow-x-auto">
              <div className="flex gap-1.5 w-max">
                {cities.map((c) => {
                  const on = toCity?.id === c.id
                  return (
                    <button key={c.id} onClick={() => { setToCity(c); setDestPin(null) }}
                      className="shrink-0 px-2.5 py-1 rounded-full text-[9.5px] font-semibold whitespace-nowrap cursor-pointer border"
                      style={{ background: on ? '#166534' : '#fff', color: on ? '#fff' : '#334155', borderColor: on ? '#166534' : '#e2e8f0' }}>
                      📍 {isUrdu && c.name_ur ? c.name_ur : c.name}
                    </button>
                  )
                })}
              </div>
            </div>

            <button onClick={findVehicles} disabled={!toCity} className="w-full bg-[#166534] disabled:bg-[#166534]/40 text-white rounded-xl py-2.5 font-bold text-[13px] cursor-pointer disabled:cursor-not-allowed">
              {t('mb.findVehiclesBtn')}
            </button>
            <button onClick={() => setShowNearStop(true)} className="w-full border border-[#e5e2d0] text-[#166534] rounded-xl py-2 font-bold text-[12.5px] cursor-pointer">
              📍 {t('mv.findRideNearMeBtn')}
            </button>
          </>
        )}
      </div>
      {showNearStop && <FindRideNearStopSheet onClose={() => setShowNearStop(false)} />}

      {/* Adda departure board — exact flap/seat-dots shape */}
      {board && (
        <div className="bg-[#145040] rounded-2xl p-3.5 text-white">
          <div className="flex items-center justify-between mb-2">
            <p className="font-bold text-[13px] flex items-center gap-1.5"><Bus size={14} /> {t('mb.addaBoardHeading')}</p>
            <Link href="/portal/marketplace/adda" className="text-[10.5px] font-semibold text-[#bbf7d0] underline">{t('mb.viewFullBoardBtn')}</Link>
          </div>
          {current ? (
            <>
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-[13px] truncate">{current.owner_name}</p>
                  <p className="text-[11px] text-[#bbf7d0] truncate">{current.vehicle_type}</p>
                </div>
                <div dir="ltr" className="shrink-0 flex items-center gap-0.5 font-mono text-[18px] font-extrabold">
                  <span className="bg-black/20 rounded px-1.5">{mm}</span>:<span className="bg-black/20 rounded px-1.5">{ss}</span>
                </div>
              </div>
              <div className="flex gap-1 mt-2">
                {Array.from({ length: current.seats_total }, (_, i) => (
                  <span key={i} className="w-3.5 h-3.5 rounded-sm" style={{ background: i < current.seats_total - current.seats_available ? '#D4AF37' : 'rgba(255,255,255,.15)' }} />
                ))}
              </div>
              <p className="text-[11px] text-[#bbf7d0] mt-1.5">
                {current.seats_available > 0
                  ? `${current.seats_available} ${t('mb.seatsFreeLabel')}`
                  : t('mb.vanFullLabel')}
                {' · '}{current.fare_mode === 'fixed' ? fmt(current.fixed_fare_per_seat_pkr ?? 0) : t('af.rideRequestMode')}
              </p>
            </>
          ) : (
            <p className="text-[12px] text-[#bbf7d0]">{t('af.noCurrentVehicle')}</p>
          )}
        </div>
      )}

      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] mb-2 flex items-center gap-1.5"><MapPin size={12} /> {t('mb.routesHeading')}</p>
        {routes.length === 0 && <p className="text-[13px] text-[#64748b]">{t('mp.noRoutesListed')}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {routes.map((r) => (
            <Link key={r.id} href={`/portal/marketplace/route/${r.id}`} className="bg-white border border-[#e5e2d0] rounded-xl p-3">
              <p className="text-[13px] font-semibold text-[#1e293b]">{isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}</p>
              {r.is_monthly_fixed ? (
                <p className="text-[12px] font-bold text-amber-700 mt-1">✅ {t('mv.monthlyFixedBadge')} · {fmt(r.monthly_reference_fee_pkr ?? 0)}</p>
              ) : (
                <p className="text-[13px] font-bold text-[#005A36] mt-1">{fmt(r.fare_per_seat_pkr)} <span className="font-normal text-[#64748b] text-[11px]">{t('mk.perSeat')}</span></p>
              )}
            </Link>
          ))}
        </div>
      </div>

    </div>
  )
}
