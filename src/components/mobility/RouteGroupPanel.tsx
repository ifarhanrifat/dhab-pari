'use client'

// The permanent route group — chat + live location + member roster,
// shared by both the driver and every rider who's ever booked this
// route (auto-joined on first booking via place_ride_booking, or by
// tapping Join here). One group, not a fresh one per day's run — a
// real, explicit ask, since riders of a regular commute recognize each
// other and want one ongoing place to coordinate, not a new thread
// every single day.
//
// Deliberately reuses useLiveLocation (src/hooks/useLiveLocation.ts)
// rather than a hand-rolled watchPosition loop — it already has the
// native-background-geolocation + screen-wake-lock handling the
// bilateral trip-location page needed, and there's no reason this
// group's own sharing should be any less reliable than that one.

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Send, Radio, Users, LogOut, PlayCircle, StopCircle, Loader2, MapPin, Flag } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'
import { haversineKm } from '@/lib/roadRoute'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

// A4 polish — this panel's own button treatment (kept local on purpose,
// not a shared Button component). Matches RideLifecycleSheet: rounded-xl,
// bold label, inline spinner while busy, and hover/press/disabled states
// on every control instead of only opacity on some of them.
const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 rounded-xl font-sans font-bold cursor-pointer transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100'
const BTN_PRIMARY = `w-full ${BTN_BASE} py-3 text-[14px] bg-[#166534] text-white hover:bg-[#14532d]`
const HINT = 'font-sans text-[11px] text-[#64748b] leading-snug'

interface Participant { portal_user_id: string; name: string; sharing_location: boolean }
interface Message { id: string; sender_portal_user_id: string; sender_name: string; is_own: boolean; body: string; created_at: string }
interface LiveLoc { portal_user_id: string; name: string; is_own: boolean; is_owner: boolean; lat: number; lng: number; updated_at: string }
interface StopRow { id: string; label: string; label_ur: string | null; lat: number; lng: number }
interface ActiveRun { id: string; started_at: string; direction: 'outbound' | 'return'; outbound_arrived_at: string | null }
interface TodaysRun { id: string; direction: 'outbound' | 'return'; started_at: string; ended_at: string | null }
interface RosterRow { subscription_id: string; name: string; present: boolean }
interface OutboundBookingRow { booking_id: string; name: string; seats: number; offboarded: boolean }
interface RouteInfo {
  vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  origin_lat: number | null; origin_lng: number | null; destination_lat: number | null; destination_lng: number | null
}
interface Detail {
  is_owner: boolean; is_member: boolean; sharing_location: boolean
  owner_portal_user_id: string; route_path: { lat: number; lng: number }[] | null; route_duration_min: number | null
  is_two_way: boolean; return_wait_minutes: number | null; return_seats_available_today: number | null
  active_run: ActiveRun | null; todays_runs: TodaysRun[]; stops: StopRow[]; roster_today: RosterRow[]
  todays_outbound_bookings: OutboundBookingRow[]
  participants: Participant[]; messages: Message[]; live_locations: LiveLoc[]
}

// Live, moving ETA per stop — not the static schedule guess. Projects
// forward from the driver's own most recent ping using the chosen
// road path's real OSRM pace (duration/distance), measuring how far
// along that same path the driver has actually gotten. A stop whose
// nearest path point sits behind the driver's own nearest point has
// already been passed. On the return leg the driver travels the same
// path in reverse — "the last stop is now its first stop" — so a stop
// counts as ahead when its own path position is BEHIND the driver's,
// not ahead of it.
function computeLiveEtas(path: { lat: number; lng: number }[], durationMin: number | null, driverPos: { lat: number; lng: number } | null, stops: StopRow[], direction: 'outbound' | 'return'): Record<string, { minutesAway: number; passed: boolean } | undefined> {
  const result: Record<string, { minutesAway: number; passed: boolean } | undefined> = {}
  if (path.length < 2 || !durationMin || !driverPos) return result
  const cum: number[] = [0]
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversineKm(path[i - 1], path[i]))
  const total = cum[cum.length - 1] || 1
  const minPerKm = durationMin / total
  const nearestIdx = (p: { lat: number; lng: number }) => {
    let best = 0, bestDist = Infinity
    path.forEach((pt, i) => { const d = haversineKm(pt, p); if (d < bestDist) { bestDist = d; best = i } })
    return best
  }
  const driverIdx = nearestIdx(driverPos)
  for (const s of stops) {
    const stopIdx = nearestIdx({ lat: s.lat, lng: s.lng })
    const remainingKm = direction === 'return' ? cum[driverIdx] - cum[stopIdx] : cum[stopIdx] - cum[driverIdx]
    result[s.id] = remainingKm < 0 ? { minutesAway: 0, passed: true } : { minutesAway: Math.round(remainingKm * minPerKm), passed: false }
  }
  return result
}

export function RouteGroupPanel({ routeId, onClose }: { routeId: string; onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [sharingBusy, setSharingBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    const { data } = await supabase.rpc('route_group_detail', { p_route_id: routeId })
    const d = data as Detail | null
    if (d) { setDetail(d); setSharing(d.sharing_location) }
    setLoading(false)
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 12000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [detail?.messages.length])

  const { error: geoError } = useLiveLocation({
    enabled: sharing,
    minIntervalMs: 12000,
    backgroundTitle: t('cm.liveShareNotifTitle'),
    backgroundMessage: t('cm.liveShareNotifBody'),
    onFix: async ({ lat, lng }) => {
      const { error } = await supabase.rpc('ping_route_location', { p_route_id: routeId, p_lat: lat, p_lng: lng })
      if (error) setSharing(false)
    },
  })

  const [runBusy, setRunBusy] = useState(false)
  const [showRoster, setShowRoster] = useState(false)
  const [rosterChecks, setRosterChecks] = useState<Record<string, boolean>>({})
  const [stakeInfo, setStakeInfo] = useState<{ applies: boolean; stake_pkr: number; balance_pkr: number; can_afford: boolean } | null>(null)

  // Real ask, 2026-10-26: "this will be notified before he click the
  // save button" — same stake shown on the trip-offer post form, here
  // for starting a route's daily run instead.
  //
  // The route's own endpoints are read here too (vehicle_routes is
  // publicly readable) — route_group_detail returns only via-stops, so a
  // route with none used to leave the live stop list completely blank.
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null)
  useEffect(() => {
    supabase.from('vehicle_routes')
      .select('vehicle_id, origin, origin_ur, destination, destination_ur, origin_lat, origin_lng, destination_lat, destination_lng')
      .eq('id', routeId).maybeSingle()
      .then(({ data }) => setRouteInfo((data as RouteInfo | null) ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])
  useEffect(() => {
    if (!detail?.is_owner || !routeInfo?.vehicle_id) return
    supabase.rpc('vehicle_ride_stake_info', { p_vehicle_id: routeInfo.vehicle_id }).then(({ data: s }) => setStakeInfo(s ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.is_owner, detail?.active_run?.id, routeInfo?.vehicle_id])

  // "Now what is the procedure of starting the ride back home?" — a
  // day's return leg is just a second run on the same route, opposite
  // direction. Cycles outbound → return → outbound based on today's
  // last run, so this never gets stuck after the first round trip.
  const nextDirection: 'outbound' | 'return' = (() => {
    const runs = detail?.todays_runs ?? []
    if (runs.length === 0) return 'outbound'
    return runs[runs.length - 1].direction === 'outbound' ? 'return' : 'outbound'
  })()

  const openStartFlow = () => {
    if (nextDirection === 'outbound' && (detail?.roster_today.length ?? 0) > 0) {
      setRosterChecks(Object.fromEntries((detail?.roster_today ?? []).map((r) => [r.subscription_id, r.present])))
      setShowRoster(true)
    } else {
      startRun(nextDirection)
    }
  }

  const startRun = async (direction: 'outbound' | 'return') => {
    setRunBusy(true)
    if (direction === 'outbound' && (detail?.roster_today.length ?? 0) > 0) {
      const presentIds = Object.entries(rosterChecks).filter(([, present]) => present).map(([id]) => id)
      const { error: attErr } = await supabase.rpc('take_attendance', { p_route_id: routeId, p_run_date: new Date().toISOString().slice(0, 10), p_present_subscription_ids: presentIds })
      if (attErr) { setRunBusy(false); toast.error(friendlyError(attErr, undefined, isUrdu)); return }
    }
    const { error } = await supabase.rpc('start_route_run', { p_route_id: routeId, p_direction: direction })
    setRunBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setShowRoster(false)
    load()
  }

  const endRun = async () => {
    setRunBusy(true)
    const { error } = await supabase.rpc('end_route_run', { p_route_id: routeId })
    setRunBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    load()
  }

  // Real ask, 2026-10-21: "the vehicle will leave on its time and then
  // the driver can off board the rider who is late" — arriving starts
  // the wait window; offboarding during it releases that one rider's
  // seat for the return leg only, which is what makes a standalone
  // one-way return booking (and the alert to nearby riders) possible.
  const [offboardBusy, setOffboardBusy] = useState<string | null>(null)
  const markArrived = async () => {
    if (!detail?.active_run) return
    setRunBusy(true)
    const { error } = await supabase.rpc('mark_run_arrived', { p_run_id: detail.active_run.id })
    setRunBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    load()
  }
  const offboard = async (bookingId: string) => {
    if (!detail?.active_run) return
    setOffboardBusy(bookingId)
    const { error } = await supabase.rpc('offboard_rider', { p_run_id: detail.active_run.id, p_booking_id: bookingId })
    setOffboardBusy(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.riderOffboardedToast'))
    load()
  }

  const join = async () => {
    setJoining(true)
    const { error } = await supabase.rpc('join_route_group', { p_route_id: routeId })
    setJoining(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    load()
  }

  const leave = async () => {
    setLeaving(true)
    const { error } = await supabase.rpc('leave_route_group', { p_route_id: routeId })
    setLeaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setSharing(false)
    load()
  }

  const toggleSharing = async () => {
    setSharingBusy(true)
    const { error } = await supabase.rpc('set_route_location_sharing', { p_route_id: routeId, p_on: !sharing })
    setSharingBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setSharing(!sharing)
  }

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setSending(true)
    const { error } = await supabase.rpc('send_route_message', { p_route_id: routeId, p_body: body })
    setSending(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setText('')
    load()
  }

  const placeName = (en: string, ur: string | null) => (isUrdu && ur ? ur : en)
  const activeRun = detail?.active_run ?? null
  const legLabel = routeInfo && activeRun
    ? activeRun.direction === 'return'
      ? `${placeName(routeInfo.destination, routeInfo.destination_ur)} → ${placeName(routeInfo.origin, routeInfo.origin_ur)}`
      : `${placeName(routeInfo.origin, routeInfo.origin_ur)} → ${placeName(routeInfo.destination, routeInfo.destination_ur)}`
    : null
  const liveSince = activeRun ? t('mv.liveSinceLabel').replace('{time}', new Date(activeRun.started_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) : null
  const driverPos = detail?.live_locations.find((l) => l.is_owner) ?? null

  return (
    <MobilityBottomSheet title={t('mv.routeGroupHeading')} onClose={onClose}>
      {loading ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : !detail?.is_member ? (
        <div className="flex flex-col items-center gap-2.5 py-4 text-center">
          <Users size={28} className="text-[#166534]" />
          <p className="font-sans text-[13px] text-[#64748b]">{t('mv.joinGroupHint')}</p>
          <button onClick={join} disabled={joining} className={BTN_PRIMARY}>
            {joining && <Loader2 size={15} className="animate-spin" />} {joining ? t('action.saving') : t('mv.joinGroupBtn')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] flex items-center gap-1"><Users size={12} className="shrink-0" /> <span className="truncate">{t('mv.membersLabel')} ({detail.participants.length})</span></p>
            <button onClick={leave} disabled={leaving} className="shrink-0 inline-flex items-center gap-1 min-h-[30px] px-2 -me-2 rounded-lg font-sans text-[11px] font-semibold text-[#b91c1c] cursor-pointer transition hover:bg-rose-50 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed">
              {leaving ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />} {t('mv.leaveGroupBtn')}
            </button>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {detail.participants.map((p) => (
              <span key={p.portal_user_id} className="max-w-full flex items-center gap-1 px-2 py-1 rounded-full bg-[#F9F9F6] border border-[#e5e2d0] font-sans text-[11px] text-[#334155]">
                {p.sharing_location && <Radio size={9} className="shrink-0 text-[#166534] animate-pulse" />} <span className="truncate">{p.name}</span>
              </span>
            ))}
          </div>

          {/* Real ask, 2026-10-21: "the return ride button... when driver is
              starting a return ride... it should" show something — the
              driver (owner) used to get no feedback beyond the button
              flipping from gold to red. A4: now a real status card shown
              to everyone in the group, owner included, placed ABOVE the
              action button (status first, then what you can do about it —
              same order as RideLifecycleSheet), with which way the van is
              heading and since when, so "heading back" is unmistakable. */}
          {activeRun && (
            <div className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 bg-[#F0FDF4] border border-[#bbf7d0]">
              <span className="relative shrink-0 mt-[5px] w-2.5 h-2.5">
                <span className="absolute inset-0 rounded-full bg-[#16a34a] opacity-60 animate-ping" />
                <span className="absolute inset-0 rounded-full bg-[#16a34a]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-sans text-[13px] font-bold text-[#166534] leading-snug">
                  {activeRun.direction === 'return' ? t('mv.rideLiveReturnLabel') : t('mv.rideLiveNowLabel')}
                </p>
                <p className="font-sans text-[11px] text-[#475569] mt-0.5 leading-snug break-words">
                  {legLabel ? `${legLabel} · ` : ''}<span className="ltr-num">{liveSince}</span>
                </p>
              </div>
            </div>
          )}

          {detail.is_owner && showRoster && (
            <div className="flex flex-col gap-1.5 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
              <p className="font-sans text-[11.5px] font-bold text-amber-900">{t('mv.takeAttendanceLabel')}</p>
              {(detail.roster_today ?? []).map((r) => (
                <label key={r.subscription_id} className="flex items-center gap-2 min-h-[32px] font-sans text-[12.5px] text-[#1e293b] cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 accent-[#166534] shrink-0" checked={rosterChecks[r.subscription_id] ?? true}
                    onChange={(e) => setRosterChecks((rows) => ({ ...rows, [r.subscription_id]: e.target.checked }))} />
                  <span className="min-w-0 truncate">{r.name}</span>
                </label>
              ))}
              {stakeInfo?.applies && (
                <p className={`font-sans text-[10.5px] rounded-lg px-2 py-1 ${stakeInfo.can_afford ? 'bg-white text-[#64748b]' : 'bg-rose-50 text-rose-700 font-semibold'}`}>
                  {t('mv.startingStakeNote').replace('{stake}', String(stakeInfo.stake_pkr)).replace('{balance}', String(Math.round(stakeInfo.balance_pkr)))}
                </p>
              )}
              <div className="flex gap-1.5 mt-1">
                <button type="button" onClick={() => setShowRoster(false)} className={`flex-1 min-w-0 ${BTN_BASE} py-2.5 text-[13px] font-semibold border border-[#e5e2d0] bg-white text-[#64748b] hover:bg-[#F9F9F6]`}>
                  {t('action.cancel')}
                </button>
                <button type="button" onClick={() => startRun('outbound')} disabled={runBusy || (stakeInfo?.applies && !stakeInfo.can_afford)} className={`flex-1 min-w-0 ${BTN_BASE} py-2.5 text-[13px] bg-[#D4AF37] text-[#0f172a] hover:brightness-95`}>
                  {runBusy && <Loader2 size={14} className="animate-spin" />} <span className="truncate">{runBusy ? t('action.saving') : t('mv.confirmAndStartBtn')}</span>
                </button>
              </div>
            </div>
          )}
          {detail.is_owner && !showRoster && !activeRun && stakeInfo?.applies && (
            <p className={`font-sans text-[10.5px] rounded-lg px-2.5 py-1.5 ${stakeInfo.can_afford ? 'bg-[#F9F9F6] text-[#64748b]' : 'bg-rose-50 text-rose-700 font-semibold'}`}>
              {t('mv.startingStakeNote').replace('{stake}', String(stakeInfo.stake_pkr)).replace('{balance}', String(Math.round(stakeInfo.balance_pkr)))}
            </p>
          )}
          {detail.is_owner && !showRoster && (
            <button type="button" onClick={activeRun ? endRun : openStartFlow} disabled={runBusy || (!activeRun && stakeInfo?.applies && !stakeInfo.can_afford)}
              className={`w-full ${BTN_BASE} py-3 text-[14px] ${activeRun ? 'bg-[#b91c1c] text-white hover:bg-[#991b1b]' : 'bg-[#D4AF37] text-[#0f172a] hover:brightness-95'}`}>
              {runBusy ? <Loader2 size={15} className="animate-spin" /> : activeRun ? <StopCircle size={16} /> : <PlayCircle size={16} />}
              {activeRun
                ? t('mv.endRideBtn')
                : nextDirection === 'return' ? t('mv.startReturnTripBtn') : t('mv.startRideBtn')}
            </button>
          )}

          {/* Real ask, 2026-10-21: "the vehicle will leave on its time and
              then the driver can off board the rider who is late" — the
              owner marks arrival, which opens a wait window (the route's
              own return_wait_minutes), and can release a specific
              outbound rider's seat for the return leg during that window. */}
          {detail.is_owner && detail.is_two_way && activeRun?.direction === 'outbound' && !activeRun.outbound_arrived_at && (
            <button type="button" onClick={markArrived} disabled={runBusy} className={`w-full ${BTN_BASE} py-3 text-[14px] border border-[#166534] bg-white text-[#166534] hover:bg-[#F0FDF4]`}>
              {runBusy ? <Loader2 size={15} className="animate-spin" /> : <Flag size={15} />} {t('mv.markArrivedBtn')}
            </button>
          )}
          {detail.is_owner && activeRun?.direction === 'outbound' && activeRun.outbound_arrived_at && (() => {
            const elapsedMin = (Date.now() - new Date(activeRun.outbound_arrived_at).getTime()) / 60000
            const remainingMin = detail.return_wait_minutes != null ? Math.max(0, Math.round(detail.return_wait_minutes - elapsedMin)) : null
            return (
              <div className="flex flex-col gap-1.5">
                {remainingMin != null && (
                  <p className="font-sans text-[12px] font-semibold text-[#64748b] bg-[#F9F9F6] rounded-lg px-2.5 py-1.5 text-center">
                    {remainingMin > 0 ? t('mv.returnOpensInLabel').replace('{n}', String(remainingMin)) : t('mv.returnWaitOverLabel')}
                  </p>
                )}
                {detail.todays_outbound_bookings.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b]">{t('mv.offboardRosterLabel')}</p>
                    {detail.todays_outbound_bookings.map((b) => (
                      <div key={b.booking_id} className="flex items-center justify-between gap-2 rounded-lg bg-[#F9F9F6] ps-2.5 pe-1.5 py-1">
                        <span className="min-w-0 font-sans text-[12px] font-semibold text-[#1e293b] truncate">{b.name} {b.seats > 1 ? `(${b.seats})` : ''}</span>
                        {b.offboarded ? (
                          <span className="shrink-0 font-sans text-[11px] text-[#94a3b8] px-1.5">{t('mv.offboardedLabel')}</span>
                        ) : (
                          <button type="button" onClick={() => offboard(b.booking_id)} disabled={offboardBusy === b.booking_id}
                            className={`shrink-0 ${BTN_BASE} min-h-[30px] px-2.5 text-[11px] border border-[#fecaca] bg-white text-[#b91c1c] hover:bg-rose-50`}>
                            {offboardBusy === b.booking_id ? <Loader2 size={11} className="animate-spin" /> : null} {offboardBusy === b.booking_id ? t('action.saving') : t('mv.offboardBtn')}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
          {detail.is_two_way && detail.return_seats_available_today != null && detail.return_seats_available_today > 0 && (
            <p className="font-sans text-[11.5px] font-bold text-[#166534] bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg px-2.5 py-1.5 text-center">
              {t('mv.returnSeatsOpenNote').replace('{n}', String(detail.return_seats_available_today))}
            </p>
          )}

          {/* A4: with no via-stops configured this slot used to be empty
              (or a "no stops" note) — the commonest case for an ordinary
              route, and a big part of why a started return trip "looked
              like going back empty". The route's own two endpoints now
              stand in as a minimal 2-point list, in travel order for this
              leg, with a live ETA to the far end when one can be worked
              out. An ETA that can't be computed (driver not sharing yet)
              now shows "—" instead of a "Loading..." that never ended. */}
          {activeRun && (() => {
            const endpoints: StopRow[] = routeInfo ? [
              { id: '__origin', label: routeInfo.origin, label_ur: routeInfo.origin_ur, lat: Number(routeInfo.origin_lat), lng: Number(routeInfo.origin_lng) },
              { id: '__destination', label: routeInfo.destination, label_ur: routeInfo.destination_ur, lat: Number(routeInfo.destination_lat), lng: Number(routeInfo.destination_lng) },
            ] : []
            const usingEndpoints = detail.stops.length === 0
            const baseStops = usingEndpoints ? endpoints : detail.stops
            if (baseStops.length === 0) {
              return <p className={`${HINT} text-center py-2`}>{t('mv.noStopsConfiguredNote')}</p>
            }
            const etaCandidates = baseStops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && !(s.lat === 0 && s.lng === 0))
            const etas = computeLiveEtas(detail.route_path ?? [], detail.route_duration_min, driverPos ? { lat: driverPos.lat, lng: driverPos.lng } : null, etaCandidates, activeRun.direction)
            // "the last stop is now its first stop" — same stops, shown
            // in the order they're actually reached on this leg.
            const orderedStops = activeRun.direction === 'return' ? [...baseStops].reverse() : baseStops
            return (
              <div className="flex flex-col gap-1">
                {usingEndpoints && <p className={HINT}>{t('mv.directRouteNote')}</p>}
                {orderedStops.map((s, i) => {
                  const e = etas[s.id]
                  const isEnd = i === orderedStops.length - 1
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-[#F9F9F6] px-2.5 py-1.5">
                      <span className="min-w-0 flex items-center gap-1.5">
                        {usingEndpoints
                          ? <MapPin size={12} className={`shrink-0 ${isEnd ? 'text-[#D4AF37]' : 'text-[#166534]'}`} />
                          : <span className="shrink-0 w-4 h-4 rounded-full bg-[#166534] text-white text-[9px] font-bold flex items-center justify-center"><span className="ltr-num leading-none">{i + 1}</span></span>}
                        <span className="min-w-0 font-sans text-[12px] font-semibold text-[#1e293b] truncate">{placeName(s.label, s.label_ur)}</span>
                      </span>
                      {e ? (
                        <span className={`shrink-0 font-sans text-[11px] font-bold ltr-num ${e.passed ? 'text-[#94a3b8]' : 'text-[#166534]'}`}>
                          {e.passed ? t('mv.stopPassedLabel') : `${e.minutesAway} ${t('mv.minAwaySuffix')}`}
                        </span>
                      ) : (
                        <span className="shrink-0 font-sans text-[11px] text-[#94a3b8]">—</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}

          <button type="button" role="switch" aria-checked={sharing} onClick={toggleSharing} disabled={sharingBusy}
            className={`${BTN_BASE} w-fit max-w-full min-h-[34px] px-3 rounded-full text-[12px] font-semibold ${sharing ? 'bg-[#166534] text-white hover:bg-[#14532d]' : 'border border-[#e5e2d0] bg-white text-[#64748b] hover:border-[#166534]'}`}>
            {sharingBusy ? <Loader2 size={12} className="animate-spin" /> : <Radio size={12} className={sharing ? 'animate-pulse' : ''} />} <span className="truncate">{t('mv.shareMyLocationLabel')}</span>
          </button>
          {sharing && geoError && <p className="font-sans text-[11px] text-amber-700">{geoError}</p>}

          {/* A4: the map slot used to collapse to nothing for the owner
              whenever no live position existed yet. It now always says
              what's missing: the owner gets a direct "turn on sharing"
              prompt (with the switch right in it) or a "waiting for GPS"
              note once it's on; a rider sees the same waiting message the
              1:1 trip popup uses. */}
          {detail.live_locations.length > 0 ? (
            <LeafletMap
              pins={detail.live_locations.map((l) => ({ lat: l.lat, lng: l.lng, label: l.name, color: l.is_own ? '#D4AF37' : '#166534', emoji: '🚗' }))}
              height={150} className="rounded-xl"
            />
          ) : activeRun && (
            detail.is_owner && !sharing ? (
              <div className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
                <Radio size={16} className="shrink-0 text-amber-700" />
                <p className="flex-1 min-w-0 font-sans text-[12px] font-semibold text-amber-900 leading-snug">{t('mv.turnOnSharingOwnerPrompt')}</p>
                <button type="button" onClick={toggleSharing} disabled={sharingBusy}
                  className={`shrink-0 ${BTN_BASE} min-h-[34px] px-3 text-[12px] bg-[#166534] text-white hover:bg-[#14532d] whitespace-nowrap`}>
                  {sharingBusy && <Loader2 size={12} className="animate-spin" />} {t('mv.turnOnSharingBtn')}
                </button>
              </div>
            ) : (
              <p className={`${HINT} text-center bg-[#F9F9F6] rounded-xl px-2.5 py-2.5`}>
                {detail.is_owner ? t('mv.waitingForYourGpsNote') : t('cm.waitingForDriverLocation')}
              </p>
            )
          )}

          <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-2xl p-3 min-h-[220px] max-h-[40vh] overflow-y-auto flex flex-col gap-2">
            {detail.messages.length === 0 && <p className="text-center text-[11.5px] text-[#94a3b8] italic py-4">{t('mv.noMessagesYet')}</p>}
            {detail.messages.map((m) => {
              const alignEnd = isUrdu ? !m.is_own : m.is_own
              return (
                <div key={m.id} className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[78%] min-w-0 px-3 py-2" style={{
                    borderRadius: alignEnd ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                    background: m.is_own ? '#166534' : '#fff', color: m.is_own ? '#fff' : '#1e293b',
                    border: m.is_own ? 'none' : '1px solid #e5e2d0',
                  }}>
                    {!m.is_own && <p className="text-[9.5px] font-bold opacity-70 mb-0.5 truncate">{m.sender_name}</p>}
                    <p className="text-[13px] break-words [overflow-wrap:anywhere]">{m.body}</p>
                    <p className="text-[9.5px] mt-0.5 opacity-70">{new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-center gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send() }}
              placeholder={t('mn.typeMessage')} className="flex-1 min-w-0 dp2-input" />
            <button onClick={send} disabled={sending || !text.trim()} aria-label={t('mn.typeMessage')}
              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-[#166534] text-white cursor-pointer transition hover:bg-[#14532d] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100">
              {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      )}
    </MobilityBottomSheet>
  )
}
