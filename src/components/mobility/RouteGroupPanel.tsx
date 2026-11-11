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
import { Send, Radio, Users, LogOut, PlayCircle, StopCircle, MapPin as MapPinIcon, Maximize2, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'
import { haversineKm } from '@/lib/roadRoute'
import { isStale, minutesSince } from '@/lib/liveStaleness'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { LeafletMapHandle, MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
function minutesAgoCount(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
}

interface Participant { portal_user_id: string; name: string; sharing_location: boolean }
interface Message { id: string; sender_portal_user_id: string; sender_name: string; is_own: boolean; body: string; created_at: string }
interface LiveLoc { portal_user_id: string; name: string; is_own: boolean; is_owner: boolean; lat: number; lng: number; updated_at: string }
interface StopRow { id: string; label: string; label_ur: string | null; lat: number; lng: number }
interface ActiveRun { id: string; started_at: string; direction: 'outbound' | 'return'; outbound_arrived_at: string | null }
interface TodaysRun { id: string; direction: 'outbound' | 'return'; started_at: string; ended_at: string | null }
interface RosterRow { subscription_id: string; name: string; present: boolean; on_leave_today: boolean }
interface OutboundBookingRow { booking_id: string; name: string; seats: number; offboarded: boolean }
interface AdHocBookingRow {
  id: string; name: string; seats: number; boarded_at: string | null; dropped_off_at: string | null; board_stop_id: string | null; seat_accepted_at?: string | null
  // 850: a "catch" booking has no board_stop_id — it's the rider's own
  // raw live GPS instead, held here until boarded/declined/cancelled.
  is_mid_route_catch?: boolean; catch_lat?: number | null; catch_lng?: number | null; catch_updated_at?: string | null
}
interface PendingSeatRequest { id: string; name: string; seats: number; travel_date: string; direction: 'outbound' | 'return'; total_amount_pkr: number; announced_method: string | null; announced_proof_url: string | null }
interface PendingMonthlyApplication { id: string; name: string; monthly_fee_pkr: number; stop_label: string | null; applied_at: string; deposit_pkr: number | null; proof_url: string | null; payment_method: string | null }
interface Detail {
  is_owner: boolean; is_member: boolean; sharing_location: boolean
  owner_portal_user_id: string; route_path: { lat: number; lng: number }[] | null; route_duration_min: number | null
  is_two_way: boolean; return_wait_minutes: number | null; return_seats_available_today: number | null
  active_run: ActiveRun | null; todays_runs: TodaysRun[]; stops: StopRow[]; roster_today: RosterRow[]
  todays_outbound_bookings: OutboundBookingRow[]
  pending_seat_requests: PendingSeatRequest[]; pending_monthly_applications: PendingMonthlyApplication[]
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

export function RouteGroupPanel({ routeId, onClose, departureTime }: { routeId: string; onClose: () => void; departureTime?: string | null }) {
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
  const mapRef = useRef<LeafletMapHandle>(null)
  const fullscreenMapRef = useRef<LeafletMapHandle>(null)
  const [fullscreen, setFullscreen] = useState(false)

  const [adHocBookings, setAdHocBookings] = useState<AdHocBookingRow[]>([])
  const [adHocChecks, setAdHocChecks] = useState<Record<string, boolean>>({})

  const load = async () => {
    const [{ data }, { data: adHoc }] = await Promise.all([
      supabase.rpc('route_group_detail', { p_route_id: routeId }),
      supabase.rpc('route_today_ad_hoc_bookings', { p_route_id: routeId }),
    ])
    const d = data as Detail | null
    if (d) { setDetail(d); setSharing(d.sharing_location) }
    setAdHocBookings((adHoc ?? []) as AdHocBookingRow[])
    setLoading(false)
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 12000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [detail?.messages.length])

  // Real ask, 2026-11-07: "after the ride starts... the driver will
  // also view the rider position live" — this used to require BOTH
  // sides to remember to manually tap "Share my location" with no
  // prompt telling them to, so in practice nobody's dot ever showed up.
  // Auto-shares once per run (driver and rider alike) the moment this
  // panel sees that run go active; the manual toggle stays available
  // to opt back out for this one trip.
  const autoSharedRunIdRef = useRef<string | null>(null)
  useEffect(() => {
    const runId = detail?.active_run?.id
    if (!runId || sharing || autoSharedRunIdRef.current === runId) return
    autoSharedRunIdRef.current = runId
    supabase.rpc('set_route_location_sharing', { p_route_id: routeId, p_on: true }).then(({ error }) => {
      if (!error) setSharing(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.active_run?.id])

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
  useEffect(() => {
    if (!detail?.is_owner) return
    supabase.from('vehicle_routes').select('vehicle_id').eq('id', routeId).single().then(({ data: r }) => {
      if (!r) return
      supabase.rpc('vehicle_ride_stake_info', { p_vehicle_id: r.vehicle_id }).then(({ data: s }) => setStakeInfo(s ?? null))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.is_owner, detail?.active_run])

  // "Now what is the procedure of starting the ride back home?" — a
  // day's return leg is just a second run on the same route, opposite
  // direction. Cycles outbound → return → outbound based on today's
  // last run, so this never gets stuck after the first round trip.
  const nextDirection: 'outbound' | 'return' = (() => {
    const runs = detail?.todays_runs ?? []
    if (runs.length === 0) return 'outbound'
    return runs[runs.length - 1].direction === 'outbound' ? 'return' : 'outbound'
  })()

  const unboardedAdHoc = adHocBookings.filter((b) => !b.boarded_at)

  const stopLabel = (stopId: string | null) => {
    if (!stopId) return null
    const s = detail?.stops.find((st) => st.id === stopId)
    if (!s) return null
    return isUrdu && s.label_ur ? s.label_ur : s.label
  }

  const openStartFlow = () => {
    if (nextDirection === 'outbound' && ((detail?.roster_today.length ?? 0) > 0 || unboardedAdHoc.length > 0)) {
      setRosterChecks(Object.fromEntries((detail?.roster_today ?? []).map((r) => [r.subscription_id, r.present])))
      // Real bug, 2026-11-07: every rider used to default to checked
      // (boarded) the instant the driver tapped Start, regardless of
      // where they'd actually booked to get on — a mid-route rider got
      // marked present at the origin before the van had even moved.
      // Only a rider with no specific board stop (boarding at the
      // origin itself) defaults to checked now; anyone with a real stop
      // waits for the driver to board them there, during the trip.
      setAdHocChecks(Object.fromEntries(unboardedAdHoc.map((b) => [b.id, !b.board_stop_id])))
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
    if (direction === 'outbound') {
      const boardIds = Object.entries(adHocChecks).filter(([, on]) => on).map(([id]) => id)
      if (boardIds.length > 0) {
        const { error: boardErr } = await supabase.rpc('board_ride_bookings', { p_booking_ids: boardIds })
        if (boardErr) { setRunBusy(false); toast.error(friendlyError(boardErr, undefined, isUrdu)); return }
      }
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
  const [boardingId, setBoardingId] = useState<string | null>(null)
  const boardOne = async (bookingId: string) => {
    setBoardingId(bookingId)
    const { error } = await supabase.rpc('board_ride_bookings', { p_booking_ids: [bookingId] })
    setBoardingId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    load()
  }
  const [noShowId, setNoShowId] = useState<string | null>(null)
  const markNoShow = async (bookingId: string) => {
    if (!window.confirm(t('mv.noShowConfirmPrompt'))) return
    setNoShowId(bookingId)
    const { error } = await supabase.rpc('mark_rider_no_show', { p_booking_id: bookingId })
    setNoShowId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.noShowMarkedToast'))
    load()
  }
  const [seatActionId, setSeatActionId] = useState<string | null>(null)
  const acceptSeatRequest = async (bookingId: string) => {
    setSeatActionId(bookingId)
    const { error } = await supabase.rpc('accept_ride_booking_seat', { p_booking_id: bookingId })
    setSeatActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.seatAcceptedToast'))
    load()
  }
  const declineSeatRequest = async (bookingId: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setSeatActionId(bookingId)
    const { error } = await supabase.rpc('decline_ride_booking_seat', { p_booking_id: bookingId, p_reason: reason || null })
    setSeatActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.seatDeclinedToast'))
    load()
  }
  const [monthlyActionId, setMonthlyActionId] = useState<string | null>(null)
  const acceptMonthlyApplication = async (subscriptionId: string) => {
    setMonthlyActionId(subscriptionId)
    const { error } = await supabase.rpc('confirm_monthly_subscription', { p_subscription_id: subscriptionId })
    setMonthlyActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.seatAcceptedToast'))
    load()
  }
  const declineMonthlyApplication = async (subscriptionId: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setMonthlyActionId(subscriptionId)
    const { error } = await supabase.rpc('reject_monthly_subscription', { p_subscription_id: subscriptionId, p_reason: reason || null })
    setMonthlyActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.seatDeclinedToast'))
    load()
  }
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

  const [nudging, setNudging] = useState(false)
  const nudgeDriver = async () => {
    setNudging(true)
    const { error } = await supabase.rpc('nudge_route_driver', { p_route_id: routeId })
    setNudging(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.driverNudgedToast'))
  }
  const departurePassed = (() => {
    if (!departureTime) return false
    const [h, m] = departureTime.split(':').map(Number)
    const target = new Date(); target.setHours(h, m, 0, 0)
    return Date.now() > target.getTime() + 10 * 60000
  })()

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

  // One combined map for the whole live picture — stops, the driver,
  // and every rider currently sharing location — instead of stops as a
  // plain list and the map showing only live dots. Real ask, 2026-11-06:
  // "all stops will be shown like icons... same like google map like
  // all the stops and riders will be visible on the map along with the
  // vehicle position."
  const mapData = (() => {
    if (!detail?.active_run) return null
    const orderedStops = detail.active_run.direction === 'return' ? [...detail.stops].reverse() : detail.stops
    // 857: route_group_detail's live_locations has no built-in
    // freshness filter (unlike nearby_open_trips/check_catch_
    // feasibility, which both drop anything >5min old server-side) —
    // a stale position here must not drive real ETAs, and must not
    // render as if it were still live.
    const driverPosRaw = detail.live_locations.find((l) => l.is_owner)
    const driverPos = driverPosRaw && !isStale(driverPosRaw.updated_at) ? driverPosRaw : null
    const etas = computeLiveEtas(detail.route_path ?? [], detail.route_duration_min, driverPos ? { lat: driverPos.lat, lng: driverPos.lng } : null, detail.stops, detail.active_run.direction)
    const stopPins: MapPin[] = orderedStops.map((s) => {
      const name = isUrdu && s.label_ur ? s.label_ur : s.label
      const e = etas[s.id]
      const etaLine = e ? (e.passed ? t('mv.stopPassedLabel') : `${e.minutesAway} ${t('mv.minAwaySuffix')}`) : ''
      return { lat: s.lat, lng: s.lng, emoji: '📍', color: '#f59e0b', popupHtml: `<div style="font-family:sans-serif;min-width:140px"><b>${escapeHtml(name)}</b>${etaLine ? `<br/><span style="color:#166534;font-weight:600">${escapeHtml(etaLine)}</span>` : ''}</div>` }
    })
    const livePins: MapPin[] = detail.live_locations.map((l) => {
      const stale = isStale(l.updated_at)
      const minsAgo = minutesSince(l.updated_at)
      return {
        lat: l.lat, lng: l.lng, color: stale ? '#94a3b8' : (l.is_own ? '#D4AF37' : '#166534'), emoji: l.is_owner ? '🚐' : '🧍', isVehicle: l.is_owner,
        label: stale ? `${l.name} — ${t('mv.lastSeenMinAgoSuffix').replace('{n}', String(minsAgo))}` : l.name,
      }
    })
    // 850: riders trying to catch this departed run, plotted so the
    // driver can see at a glance whether they're actually near the road.
    const catchPins: MapPin[] = unboardedAdHoc
      .filter((b) => b.is_mid_route_catch && b.catch_lat != null && b.catch_lng != null)
      .map((b) => ({
        lat: b.catch_lat!, lng: b.catch_lng!, emoji: '🙋', color: '#dc2626',
        popupHtml: `<div style="font-family:sans-serif;min-width:140px"><b>${escapeHtml(b.name)}</b><br/><span style="color:#dc2626;font-weight:600">${escapeHtml(t('mv.tryingToCatchLabel'))}</span></div>`,
      }))
    return { pins: [...stopPins, ...livePins, ...catchPins], orderedStops, etas }
  })()

  if (fullscreen && detail && mapData) {
    return (
      <div className="fixed inset-0 z-[150] bg-white flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e2d0]" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
          <p className="font-sans text-[13px] font-bold text-[#1e293b] truncate">{t('mv.routeGroupHeading')}</p>
          <button type="button" onClick={() => setFullscreen(false)} className="shrink-0 p-2 cursor-pointer text-[#1e293b]" aria-label={t('cm.collapseMapBtn')}>
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 min-h-0 relative">
          <LeafletMap ref={fullscreenMapRef} pins={mapData.pins} route={detail.route_path ?? undefined} height="100%" zoom={13} />
          {mapData.orderedStops.length > 0 && (
            <div className="absolute bottom-0 left-0 right-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 px-3 bg-gradient-to-t from-black/40 to-transparent">
              <div className="flex gap-2 overflow-x-auto hide-scrollbar">
                {mapData.orderedStops.map((s, i) => {
                  const e = mapData.etas[s.id]
                  return (
                    <button key={s.id} type="button" onClick={() => fullscreenMapRef.current?.focusPin(i)}
                      className="shrink-0 bg-white rounded-xl shadow-lg px-3 py-2 min-w-[130px] text-start cursor-pointer">
                      <p className="font-sans text-[12px] font-bold text-[#1e293b] truncate">{isUrdu && s.label_ur ? s.label_ur : s.label}</p>
                      <p className={`font-sans text-[11px] font-bold ltr-num ${e?.passed ? 'text-[#94a3b8]' : 'text-[#166534]'}`}>
                        {e ? (e.passed ? t('mv.stopPassedLabel') : `${e.minutesAway} ${t('mv.minAwaySuffix')}`) : t('action.loading')}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    )
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

  return (
    <MobilityBottomSheet title={t('mv.routeGroupHeading')} onClose={onClose}>
      {loading ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : !detail?.is_member ? (
        <div className="flex flex-col items-center gap-2.5 py-4 text-center">
          <Users size={28} className="text-[#166534]" />
          <p className="font-sans text-[13px] text-[#64748b]">{t('mv.joinGroupHint')}</p>
          <button onClick={join} disabled={joining} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
            {joining ? t('action.saving') : t('mv.joinGroupBtn')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] flex items-center gap-1"><Users size={12} /> {t('mv.membersLabel')} ({detail.participants.length})</p>
            <button onClick={leave} disabled={leaving} className="flex items-center gap-1 font-sans text-[11px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50">
              <LogOut size={11} /> {t('mv.leaveGroupBtn')}
            </button>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {detail.participants.map((p) => (
              <span key={p.portal_user_id} className="flex items-center gap-1 px-2 py-1 rounded-full bg-[#F9F9F6] border border-[#e5e2d0] font-sans text-[11px] text-[#334155]">
                {p.sharing_location && <Radio size={9} className="text-[#166534] animate-pulse" />} {p.name}
              </span>
            ))}
          </div>

          {detail.is_owner && showRoster && (
            <div className="flex flex-col gap-1.5 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
              <p className="font-sans text-[11.5px] font-bold text-amber-900">{t('mv.takeAttendanceLabel')}</p>
              {(detail.roster_today ?? []).map((r) => (
                <label key={r.subscription_id} className="flex items-center gap-2 font-sans text-[12.5px] text-[#1e293b] cursor-pointer">
                  <input type="checkbox" checked={rosterChecks[r.subscription_id] ?? true}
                    onChange={(e) => setRosterChecks((rows) => ({ ...rows, [r.subscription_id]: e.target.checked }))} />
                  {r.name}
                  {r.on_leave_today && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">{t('mv.onLeaveTodayTag')}</span>}
                </label>
              ))}
              {unboardedAdHoc.map((b) => (
                <label key={b.id} className="flex items-center gap-2 font-sans text-[12.5px] text-[#1e293b] cursor-pointer">
                  <input type="checkbox" checked={adHocChecks[b.id] ?? !b.board_stop_id}
                    onChange={(e) => setAdHocChecks((rows) => ({ ...rows, [b.id]: e.target.checked }))} />
                  {b.name}{b.seats > 1 ? ` (${b.seats})` : ''}
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-800">{t('mv.oneOffRiderTag')}</span>
                  {b.board_stop_id && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 truncate">📍 {stopLabel(b.board_stop_id)}</span>
                  )}
                </label>
              ))}
              {unboardedAdHoc.some((b) => b.board_stop_id) && (
                <p className="font-sans text-[10.5px] text-amber-700">{t('mv.stopRidersBoardLaterHint')}</p>
              )}
              {stakeInfo?.applies && (
                <p className={`font-sans text-[10.5px] rounded-lg px-2 py-1 ${stakeInfo.can_afford ? 'bg-white text-[#64748b]' : 'bg-rose-50 text-rose-700 font-semibold'}`}>
                  {t('mv.startingStakeNote').replace('{stake}', String(stakeInfo.stake_pkr)).replace('{balance}', String(Math.round(stakeInfo.balance_pkr)))}
                </p>
              )}
              <div className="flex gap-1.5 mt-1">
                <button type="button" onClick={() => setShowRoster(false)} className="flex-1 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b]">
                  {t('action.cancel')}
                </button>
                <button type="button" onClick={() => startRun('outbound')} disabled={runBusy || (stakeInfo?.applies && !stakeInfo.can_afford)} className="flex-1 py-1.5 rounded-lg text-[12px] font-sans font-bold cursor-pointer bg-[#D4AF37] text-[#0f172a] disabled:opacity-50">
                  {runBusy ? t('action.saving') : t('mv.confirmAndStartBtn')}
                </button>
              </div>
            </div>
          )}
          {detail.is_owner && !showRoster && !detail.active_run && stakeInfo?.applies && (
            <p className={`font-sans text-[10.5px] rounded-lg px-2.5 py-1.5 ${stakeInfo.can_afford ? 'bg-[#F9F9F6] text-[#64748b]' : 'bg-rose-50 text-rose-700 font-semibold'}`}>
              {t('mv.startingStakeNote').replace('{stake}', String(stakeInfo.stake_pkr)).replace('{balance}', String(Math.round(stakeInfo.balance_pkr)))}
            </p>
          )}
          {/* Real ask, 2026-11-09: "driver must have to confirm all these
              seats... only the confirmed riders will be part of groups"
              — a pending request (any future travel date, not just
              today) stays here, with the rider's submitted payment
              method/proof, until the driver explicitly accepts or
              declines it. Shown regardless of active_run/showRoster so
              a driver can clear these without having to start a run. */}
          {detail.is_owner && (detail.pending_seat_requests.length > 0 || detail.pending_monthly_applications.length > 0) && (
            <div className="flex flex-col gap-2 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.05em] text-amber-900">{t('mv.pendingRequestsHeading')}</p>
              {detail.pending_seat_requests.map((r) => (
                <div key={r.id} className="flex flex-col gap-1 rounded-lg bg-white px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">
                      {r.name}{r.seats > 1 ? ` (${r.seats})` : ''} · {new Date(r.travel_date).toLocaleDateString('en-GB')}
                      {r.direction === 'return' && <span className="ms-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">{t('cm.tripTypeReturn')}</span>}
                    </span>
                    <span className="shrink-0 font-sans text-[12.5px] font-bold text-[#166534] ltr-num">₨{Number(r.total_amount_pkr).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[11px] text-[#64748b]">
                      {r.announced_method ? `${t('w.paymentMethod')}: ${r.announced_method}` : ''}
                      {r.announced_proof_url && <a href={r.announced_proof_url} target="_blank" rel="noopener noreferrer" className="ms-1.5 font-bold text-sky-700 underline">{t('mv.viewReceiptLink')}</a>}
                    </span>
                    <div className="shrink-0 flex items-center gap-1.5">
                      <button type="button" onClick={() => declineSeatRequest(r.id)} disabled={seatActionId === r.id} className="px-2.5 py-1 rounded-lg text-[11px] font-sans font-bold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">{t('mp.rejectBtn')}</button>
                      <button type="button" onClick={() => acceptSeatRequest(r.id)} disabled={seatActionId === r.id} className="px-2.5 py-1 rounded-lg text-[11px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{seatActionId === r.id ? t('action.saving') : t('mv.acceptSeatBtn')}</button>
                    </div>
                  </div>
                </div>
              ))}
              {detail.pending_monthly_applications.map((a) => (
                <div key={a.id} className="flex flex-col gap-1 rounded-lg bg-white px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[12.5px] font-semibold text-[#1e293b] truncate">
                      {a.name} <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">{t('mv.monthlyFixedBadge')}</span>
                      {a.stop_label && <span className="text-[10.5px] text-amber-700 font-semibold"> · 📍 {a.stop_label}</span>}
                    </span>
                    <span className="shrink-0 font-sans text-[12.5px] font-bold text-[#166534] ltr-num">₨{Number(a.monthly_fee_pkr).toLocaleString()}/mo</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[11px] text-[#64748b]">
                      {a.deposit_pkr != null && a.deposit_pkr > 0 ? `${t('mv.advanceDueLabel')}: ₨${Number(a.deposit_pkr).toLocaleString()}` : ''}
                      {a.proof_url && <a href={a.proof_url} target="_blank" rel="noopener noreferrer" className="ms-1.5 font-bold text-sky-700 underline">{t('mv.viewReceiptLink')}</a>}
                    </span>
                    <div className="shrink-0 flex items-center gap-1.5">
                      <button type="button" onClick={() => declineMonthlyApplication(a.id)} disabled={monthlyActionId === a.id} className="px-2.5 py-1 rounded-lg text-[11px] font-sans font-bold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">{t('mp.rejectBtn')}</button>
                      <button type="button" onClick={() => acceptMonthlyApplication(a.id)} disabled={monthlyActionId === a.id} className="px-2.5 py-1 rounded-lg text-[11px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{monthlyActionId === a.id ? t('action.saving') : t('mv.acceptSeatBtn')}</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Real ask, 2026-11-07: "before starting the ride the driver
              was not aware who has booked his ride, he should completely
              know who booked his ride before he start the ride" — a
              plain, always-visible manifest, not just buried inside the
              Start checklist the driver has to remember to read closely. */}
          {detail.is_owner && !detail.active_run && !showRoster && (detail.roster_today.length > 0 || adHocBookings.length > 0) && (
            <div className="flex flex-col gap-1 bg-[#F9F9F6] border border-[#e5e2d0] rounded-xl p-2.5">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('mv.todaysBookingsHeading')}</p>
              {detail.roster_today.map((r) => (
                <p key={r.subscription_id} className="font-sans text-[12px] text-[#1e293b] flex items-center gap-1.5">
                  <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">{t('mv.monthlyFixedBadge')}</span>
                  {r.name}
                </p>
              ))}
              {adHocBookings.map((b) => (
                <p key={b.id} className="font-sans text-[12px] text-[#1e293b] flex items-center gap-1.5 flex-wrap">
                  <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-800">{t('mv.oneOffRiderTag')}</span>
                  {!b.seat_accepted_at && <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">{t('mp.awaitingStatus')}</span>}
                  {b.name}{b.seats > 1 ? ` (${b.seats})` : ''}
                  {b.board_stop_id && <span className="text-[10.5px] text-amber-700 font-semibold">📍 {stopLabel(b.board_stop_id)}</span>}
                </p>
              ))}
            </div>
          )}
          {/* Real ask, 2026-11-09: "can't you do this only pushing the end
              ride button? the more we build the more difficult for the
              driver" — collapsed the two stacked buttons (End Ride +
              Arrived on Destination, both visible at once on a two-way
              route's outbound leg) into one button slot that changes
              label/action by state, so the driver only ever has one
              decision to make at a time: Start → Arrived at Destination
              (opens the wait window) → End Ride → Start Return Trip. All
              the wait-window/offboard/standalone-return-seat machinery
              below is unchanged — only the button that triggers the
              arrival step moved into this same slot. */}
          {detail.is_owner && !showRoster && (() => {
            const needsArrival = !!detail.active_run && detail.is_two_way && detail.active_run.direction === 'outbound' && !detail.active_run.outbound_arrived_at
            const onClick = !detail.active_run ? openStartFlow : needsArrival ? markArrived : endRun
            const label = !detail.active_run
              ? (nextDirection === 'return' ? t('mv.startReturnTripBtn') : t('mv.startRideBtn'))
              : needsArrival ? t('mv.markArrivedBtn') : t('mv.endRideBtn')
            const colorCls = !detail.active_run ? 'bg-[#D4AF37] text-[#0f172a]' : needsArrival ? 'bg-[#166534] text-white' : 'bg-[#b91c1c] text-white'
            return (
              <button type="button" onClick={onClick} disabled={runBusy || (!detail.active_run && stakeInfo?.applies && !stakeInfo.can_afford)}
                className={`flex items-center justify-center gap-1.5 w-full py-2 rounded-xl text-[13px] font-sans font-bold cursor-pointer disabled:opacity-50 ${colorCls}`}>
                {!detail.active_run ? <PlayCircle size={15} /> : needsArrival ? <MapPinIcon size={15} /> : <StopCircle size={15} />}
                {label}
              </button>
            )
          })()}
          {/* Real ask, 2026-10-21: "the return ride button... when driver is
              starting a return ride... it should" show something — the
              driver (owner) used to get NO feedback at all beyond the
              button itself flipping from gold to red; this same "Live
              now" status already existed for riders, just never for the
              one person who most needs to know their own tap registered. */}
          {detail.active_run && (
            <p className="flex items-center gap-1.5 font-sans text-[12px] font-bold text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5">
              <Radio size={12} className="animate-pulse" /> {detail.active_run.direction === 'return' ? t('mv.rideLiveReturnLabel') : t('mv.rideLiveNowLabel')}
            </p>
          )}

          {/* Real ask, 2026-11-07: "he should onboard him when he reached
              his stop" — a rider with a specific mid-route board stop is
              no longer auto-boarded at the origin (see openStartFlow);
              this is where the driver actually boards them, with the
              stop name and a live ETA right there, while the run is on. */}
          {detail.is_owner && detail.active_run?.direction === 'outbound' && unboardedAdHoc.length > 0 && (
            <div className="flex flex-col gap-1 bg-sky-50 border border-sky-200 rounded-xl p-2.5">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.05em] text-sky-900">{t('mv.stillBoardingHeading')}</p>
              {unboardedAdHoc.map((b) => {
                const eta = b.board_stop_id ? mapData?.etas[b.board_stop_id] : undefined
                return (
                  <div key={b.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="font-sans text-[12px] font-semibold text-[#1e293b] block truncate">{b.name}{b.seats > 1 ? ` (${b.seats})` : ''}</span>
                      <span className="font-sans text-[10.5px] text-sky-700 block truncate">
                        {b.is_mid_route_catch ? (
                          <>🙋 {t('mv.tryingToCatchLabel')}{b.catch_updated_at && ` · ${t('mv.updatedMinAgoSuffix').replace('{n}', String(minutesAgoCount(b.catch_updated_at)))}`}</>
                        ) : (
                          <>📍 {b.board_stop_id ? stopLabel(b.board_stop_id) : t('mv.originStopLabel')}
                          {eta && !eta.passed && ` · ${eta.minutesAway} ${t('mv.minAwaySuffix')}`}</>
                        )}
                      </span>
                    </span>
                    <div className="shrink-0 flex items-center gap-1">
                      <button type="button" onClick={() => markNoShow(b.id)} disabled={noShowId === b.id || boardingId === b.id}
                        className="px-2 py-1 rounded-lg text-[10.5px] font-sans font-bold cursor-pointer border border-[#e5e2d0] text-[#b91c1c] disabled:opacity-50">
                        {t('mv.noShowBtn')}
                      </button>
                      <button type="button" onClick={() => boardOne(b.id)} disabled={boardingId === b.id || noShowId === b.id}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-sans font-bold cursor-pointer bg-[#166534] text-white disabled:opacity-50">
                        {boardingId === b.id ? t('action.saving') : t('mv.boardNowBtn')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {!detail.is_owner && !detail.active_run && detail.todays_runs.length === 0 && departurePassed && (
            <button type="button" onClick={nudgeDriver} disabled={nudging}
              className="w-full py-2 rounded-xl text-[12.5px] font-sans font-bold cursor-pointer border border-amber-300 bg-amber-50 text-amber-800 disabled:opacity-50">
              {nudging ? t('action.saving') : t('mv.nudgeDriverBtn')}
            </button>
          )}

          {/* Real ask, 2026-10-21: "the vehicle will leave on its time and
              then the driver can off board the rider who is late" — the
              owner marks arrival (now via the single button above), which
              opens a wait window (the route's own return_wait_minutes),
              and can release a specific outbound rider's seat for the
              return leg during that window. */}
          {detail.is_owner && detail.active_run?.direction === 'outbound' && detail.active_run.outbound_arrived_at && (() => {
            const elapsedMin = (Date.now() - new Date(detail.active_run.outbound_arrived_at).getTime()) / 60000
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
                      <div key={b.booking_id} className="flex items-center justify-between gap-2 rounded-lg bg-[#F9F9F6] px-2.5 py-1.5">
                        <span className="font-sans text-[12px] font-semibold text-[#1e293b] truncate">{b.name} {b.seats > 1 ? `(${b.seats})` : ''}</span>
                        {b.offboarded ? (
                          <span className="shrink-0 font-sans text-[11px] text-[#94a3b8]">{t('mv.offboardedLabel')}</span>
                        ) : (
                          <button type="button" onClick={() => offboard(b.booking_id)} disabled={offboardBusy === b.booking_id}
                            className="shrink-0 font-sans text-[11px] font-bold text-[#b91c1c] cursor-pointer disabled:opacity-50">
                            {offboardBusy === b.booking_id ? t('action.saving') : t('mv.offboardBtn')}
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

          {detail.active_run && detail.stops.length === 0 && (
            <p className="font-sans text-[11.5px] text-[#94a3b8] text-center py-2">{t('mv.noStopsConfiguredNote')}</p>
          )}

          <button type="button" onClick={toggleSharing} disabled={sharingBusy}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer transition-all disabled:opacity-50 w-fit ${sharing ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
            <Radio size={12} className={sharing ? 'animate-pulse' : ''} /> {t('mv.shareMyLocationLabel')}
          </button>
          {sharing && geoError && <p className="font-sans text-[11px] text-amber-700">{geoError}</p>}

          {mapData && (mapData.pins.length > 0 ? (
            <div className="relative">
              <LeafletMap ref={mapRef} pins={mapData.pins} route={detail.route_path ?? undefined} height={190} className="rounded-xl" />
              <button type="button" onClick={() => setFullscreen(true)}
                className="absolute top-2 right-2 z-[60] bg-white shadow-md rounded-lg p-2 cursor-pointer" aria-label={t('cm.expandMapBtn')}>
                <Maximize2 size={15} className="text-[#1e293b]" />
              </button>
            </div>
          ) : !sharing && (
            <p className="font-sans text-[11.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-2.5 py-2 text-center">{t('mv.turnOnSharingNote')}</p>
          ))}

          {mapData && mapData.orderedStops.length > 0 && (
            <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-1">
              {mapData.orderedStops.map((s, i) => {
                const e = mapData.etas[s.id]
                return (
                  <button key={s.id} type="button" onClick={() => mapRef.current?.focusPin(i)}
                    className="shrink-0 bg-[#F9F9F6] border border-[#e5e2d0] rounded-xl px-2.5 py-1.5 min-w-[120px] text-start cursor-pointer">
                    <p className="font-sans text-[11.5px] font-semibold text-[#1e293b] truncate">{isUrdu && s.label_ur ? s.label_ur : s.label}</p>
                    <p className={`font-sans text-[10.5px] font-bold ltr-num ${e?.passed ? 'text-[#94a3b8]' : 'text-[#166534]'}`}>
                      {e ? (e.passed ? t('mv.stopPassedLabel') : `${e.minutesAway} ${t('mv.minAwaySuffix')}`) : t('action.loading')}
                    </p>
                  </button>
                )
              })}
            </div>
          )}

          <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-2xl p-3 min-h-[220px] max-h-[40vh] overflow-y-auto flex flex-col gap-2">
            {detail.messages.length === 0 && <p className="text-center text-[11.5px] text-[#94a3b8] italic py-4">{t('mv.noMessagesYet')}</p>}
            {detail.messages.map((m) => {
              const alignEnd = isUrdu ? !m.is_own : m.is_own
              return (
                <div key={m.id} className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[78%] px-3 py-2" style={{
                    borderRadius: alignEnd ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                    background: m.is_own ? '#166534' : '#fff', color: m.is_own ? '#fff' : '#1e293b',
                    border: m.is_own ? 'none' : '1px solid #e5e2d0',
                  }}>
                    {!m.is_own && <p className="text-[9.5px] font-bold opacity-70 mb-0.5">{m.sender_name}</p>}
                    <p className="text-[13px]">{m.body}</p>
                    <p className="text-[9.5px] mt-0.5 opacity-70">{new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-center gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send() }}
              placeholder={t('mn.typeMessage')} className="flex-1 dp2-input" />
            <button onClick={send} disabled={sending || !text.trim()} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-[#166534] text-white cursor-pointer disabled:opacity-50"><Send size={15} /></button>
          </div>
        </div>
      )}
    </MobilityBottomSheet>
  )
}
