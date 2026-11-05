'use client'

// Real ask, 2026-10-30: "there will be proper fare rules displayed in
// the booking window of the app popup for riders for all kinds of
// booking windows of all kinds of vehicles, which will have the fare
// policy in the backend — also the driver needs to see this." One card,
// fed by the committee's own service_fare_policies (776), shown in every
// rider booking sheet and on the driver's service pages, so both sides
// read the same rules the server actually charges by.

import { useEffect, useState } from 'react'
import { ChevronDown, Receipt, Loader2, AlertTriangle, Route } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useFarePolicy, type FareService, type TravelQuote } from '@/lib/farePolicy'

export interface FareVehicleRates {
  hourlyRate?: number | null
  includedKmPerHour?: number | null
  overagePerKm?: number | null
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function FarePolicyCard({ service, audience = 'rider', vehicle, defaultOpen = true }: {
  service: FareService | 'seat' | 'ride'
  audience?: 'rider' | 'driver'
  vehicle?: FareVehicleRates
  defaultOpen?: boolean
}) {
  const { t, isUrdu } = useLocale()
  const [open, setOpen] = useState(defaultOpen)
  const policy = useFarePolicy(service === 'seat' || service === 'ride' ? null : service)
  const r = (key: string, vars: Record<string, string | number> = {}) =>
    Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key))

  const lines: string[] = []
  if (service === 'seat') lines.push(t('fp.seat'))
  else if (service === 'ride') lines.push(t('fp.ride'))
  else if (policy) {
    if (service === 'hourly') {
      lines.push(vehicle?.hourlyRate ? r('fp.hourly.baseRate', { rate: fmt(vehicle.hourlyRate) }) : t('fp.hourly.base'))
      lines.push(vehicle?.includedKmPerHour != null && vehicle.overagePerKm != null
        ? r('fp.hourly.kmRate', { km: fmt(vehicle.includedKmPerHour), rate: fmt(vehicle.overagePerKm) })
        : t('fp.hourly.km'))
      lines.push(r('fp.hourly.overtime', { grace: policy.overtime_grace_minutes, block: policy.overtime_block_minutes, pct: fmt(policy.overtime_rate_pct) }))
      if (policy.max_distance_km) lines.push(r('fp.maxPickup', { max: fmt(policy.max_distance_km) }))
    } else if (service === 'rental') {
      lines.push(t('fp.rental.fixed'))
      lines.push(t('fp.rental.legs'))
      if (policy.max_distance_km) lines.push(r('fp.maxTrip', { max: fmt(policy.max_distance_km) }))
    } else {
      if (service === 'shadi') lines.push(r('fp.shadi.day', { hours: fmt(policy.full_day_hours ?? 12) }))
      else lines.push(t(`fp.${service}.base`))
      if (policy.travel_rate_per_km_pkr > 0) lines.push(r('fp.travel', { free: fmt(policy.free_radius_km), rate: fmt(policy.travel_rate_per_km_pkr) }))
      if (policy.max_distance_km) lines.push(r('fp.max', { max: fmt(policy.max_distance_km) }))
      if (policy.advance_pct > 0) lines.push(r(service === 'shadi' ? 'fp.shadi.advance' : 'fp.eq.advance', { pct: fmt(policy.advance_pct) }))
    }
    // Real gap found 2026-11-05 comparing against a competitor's policy
    // screen: tolls/parking/the driver's own food and overnight stay on
    // a long outstation trip were never disclosed anywhere — the fare
    // shown here is the vehicle's charge only, not these out-of-pocket
    // costs, and the rider should know that before booking, not after.
    lines.push(t('fp.tollsFood'))
    const note = isUrdu ? (policy.notes_ur ?? policy.notes_en) : (policy.notes_en ?? policy.notes_ur)
    if (note) lines.push(note)
  }
  if (audience === 'driver') lines.push(t('fp.driverCommission'))

  if (lines.length === 0) return null
  return (
    <div className="rounded-2xl border border-[#dbe7df] bg-[#f6faf7]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 cursor-pointer">
        <span className="flex items-center gap-2 font-sans text-[13px] font-bold text-[#14532d]"><Receipt size={15} /> {audience === 'driver' ? t('fp.titleDriver') : t('fp.title')}</span>
        <ChevronDown size={16} className={`text-[#14532d] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="px-3.5 pb-3 flex flex-col gap-1.5">
          {lines.map((l, i) => (
            <li key={i} className="flex gap-2 font-sans text-[12.5px] leading-snug text-[#334155]">
              <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-[#16a34a] shrink-0" /><span><bdi>{l}</bdi></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// One chosen vehicle + place: the server's own travel quote (the same
// fare_travel_quote the booking insert uses), so the rider sees the
// travel charge — or that the place is too far — before sending.
export function TravelQuoteLine({ service, vehicleId, lat, lng, onQuote }: {
  service: FareService; vehicleId: string | null; lat: number | null | undefined; lng: number | null | undefined
  onQuote?: (q: TravelQuote | null) => void
}) {
  const { t } = useLocale()
  const [quote, setQuote] = useState<TravelQuote | null>(null)
  // Which point the current quote belongs to — "loading" is simply
  // "the last answer was for a different point".
  const [quotedFor, setQuotedFor] = useState<string | null>(null)
  const pointKey = lat == null || lng == null ? null : `${service}:${vehicleId}:${lat}:${lng}`
  const loading = pointKey !== null && quotedFor !== pointKey

  useEffect(() => {
    if (lat == null || lng == null) return
    let live = true
    createClient().rpc('fare_travel_quote', { p_service: service, p_vehicle_id: vehicleId, p_lat: lat, p_lng: lng }).then(({ data }) => {
      if (!live) return
      const q = (data ?? null) as TravelQuote | null
      setQuote(q); setQuotedFor(`${service}:${vehicleId}:${lat}:${lng}`); onQuote?.(q)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, vehicleId, lat, lng])

  if (lat == null || lng == null) return null
  if (loading) return <p className="flex items-center gap-1.5 font-sans text-[12px] text-[#64748b]"><Loader2 size={12} className="animate-spin" /> {t('fp.quoting')}</p>
  if (!quote || !quote.known) return null
  if (quote.too_far) {
    return (
      <div className="rounded-xl bg-[#fef2f2] border border-[#fecaca] p-2.5 flex gap-2">
        <AlertTriangle size={15} className="text-[#b91c1c] shrink-0 mt-0.5" />
        <p className="font-sans text-[12.5px] text-[#7f1d1d] leading-snug">
          {t('fp.tooFar').replace('{km}', fmt(quote.road_km ?? 0)).replace('{max}', fmt(quote.max_distance_km ?? 0))}
        </p>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-[#F9F9F6] px-3 py-2">
      <span className="flex items-center gap-1.5 font-sans text-[12px] text-[#475569] min-w-0">
        <Route size={13} className="shrink-0" />
        <span className="truncate">
          {quote.travel_km > 0
            ? t('fp.travelLine').replace('{km}', fmt(quote.road_km ?? 0)).replace('{extra}', fmt(quote.travel_km)).replace('{rate}', fmt(quote.travel_rate_per_km_pkr))
            : t('fp.travelFree').replace('{km}', fmt(quote.road_km ?? 0))}
        </span>
      </span>
      <span className="font-sans text-[13px] font-bold text-[#1e293b] shrink-0"><span className="ltr-num">₨{fmt(quote.travel_charge_pkr)}</span></span>
    </div>
  )
}
