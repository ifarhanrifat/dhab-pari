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
import { Send, Radio, Users, LogOut, PlayCircle, StopCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'
import { haversineKm } from '@/lib/roadRoute'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Participant { portal_user_id: string; name: string; sharing_location: boolean }
interface Message { id: string; sender_portal_user_id: string; sender_name: string; is_own: boolean; body: string; created_at: string }
interface LiveLoc { portal_user_id: string; name: string; is_own: boolean; is_owner: boolean; lat: number; lng: number; updated_at: string }
interface StopRow { id: string; label: string; label_ur: string | null; lat: number; lng: number }
interface ActiveRun { id: string; started_at: string; direction: 'outbound' | 'return' }
interface TodaysRun { id: string; direction: 'outbound' | 'return'; started_at: string; ended_at: string | null }
interface RosterRow { subscription_id: string; name: string; present: boolean }
interface Detail {
  is_owner: boolean; is_member: boolean; sharing_location: boolean
  owner_portal_user_id: string; route_path: { lat: number; lng: number }[] | null; route_duration_min: number | null
  active_run: ActiveRun | null; todays_runs: TodaysRun[]; stops: StopRow[]; roster_today: RosterRow[]
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
                </label>
              ))}
              <div className="flex gap-1.5 mt-1">
                <button type="button" onClick={() => setShowRoster(false)} className="flex-1 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b]">
                  {t('action.cancel')}
                </button>
                <button type="button" onClick={() => startRun('outbound')} disabled={runBusy} className="flex-1 py-1.5 rounded-lg text-[12px] font-sans font-bold cursor-pointer bg-[#D4AF37] text-[#0f172a] disabled:opacity-50">
                  {runBusy ? t('action.saving') : t('mv.confirmAndStartBtn')}
                </button>
              </div>
            </div>
          )}
          {detail.is_owner && !showRoster && (
            <button type="button" onClick={detail.active_run ? endRun : openStartFlow} disabled={runBusy}
              className={`flex items-center justify-center gap-1.5 w-full py-2 rounded-xl text-[13px] font-sans font-bold cursor-pointer disabled:opacity-50 ${detail.active_run ? 'bg-[#b91c1c] text-white' : 'bg-[#D4AF37] text-[#0f172a]'}`}>
              {detail.active_run ? <StopCircle size={15} /> : <PlayCircle size={15} />}
              {detail.active_run
                ? t('mv.endRideBtn')
                : nextDirection === 'return' ? t('mv.startReturnTripBtn') : t('mv.startRideBtn')}
            </button>
          )}
          {detail.active_run && !detail.is_owner && (
            <p className="flex items-center gap-1.5 font-sans text-[12px] font-bold text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5">
              <Radio size={12} className="animate-pulse" /> {detail.active_run.direction === 'return' ? t('mv.rideLiveReturnLabel') : t('mv.rideLiveNowLabel')}
            </p>
          )}

          {detail.active_run && detail.stops.length > 0 && (() => {
            const driverPos = detail.live_locations.find((l) => l.is_owner)
            const etas = computeLiveEtas(detail.route_path ?? [], detail.route_duration_min, driverPos ? { lat: driverPos.lat, lng: driverPos.lng } : null, detail.stops, detail.active_run.direction)
            // "the last stop is now its first stop" — same stops, shown
            // in the order they're actually reached on this leg.
            const orderedStops = detail.active_run.direction === 'return' ? [...detail.stops].reverse() : detail.stops
            return (
              <div className="flex flex-col gap-1">
                {orderedStops.map((s) => {
                  const e = etas[s.id]
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-[#F9F9F6] px-2.5 py-1.5">
                      <span className="font-sans text-[12px] font-semibold text-[#1e293b] truncate">{isUrdu && s.label_ur ? s.label_ur : s.label}</span>
                      {e ? (
                        <span className={`shrink-0 font-sans text-[11px] font-bold ltr-num ${e.passed ? 'text-[#94a3b8]' : 'text-[#166534]'}`}>
                          {e.passed ? t('mv.stopPassedLabel') : `${e.minutesAway} ${t('mv.minAwaySuffix')}`}
                        </span>
                      ) : (
                        <span className="shrink-0 font-sans text-[11px] text-[#94a3b8]">{t('action.loading')}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}

          <button type="button" onClick={toggleSharing} disabled={sharingBusy}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer transition-all disabled:opacity-50 w-fit ${sharing ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
            <Radio size={12} className={sharing ? 'animate-pulse' : ''} /> {t('mv.shareMyLocationLabel')}
          </button>
          {sharing && geoError && <p className="font-sans text-[11px] text-amber-700">{geoError}</p>}

          {detail.live_locations.length > 0 && (
            <LeafletMap
              pins={detail.live_locations.map((l) => ({ lat: l.lat, lng: l.lng, label: l.name, color: l.is_own ? '#D4AF37' : '#166534', emoji: '🚗' }))}
              height={150} className="rounded-xl"
            />
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
