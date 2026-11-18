'use client'

// Village stops along a posted route. Real gap found live, 2026-10-20:
// "neither any village stop appear on that route automatically" —
// villages_near_path only ever matches villages that already have
// lat/lng, and in practice almost none do yet (most committees have
// never recorded a village's coordinates at all, only its name and
// flat delivery fee). Relying on that alone left "automatic" suggesting
// nothing for anyone. Fixed by sampling real points along the driver's
// own chosen road path and reverse-geocoding each one via Photon (the
// same free geocoder LocationPickerSheet already uses) — this needs no
// pre-existing village data at all, so a real automatic suggestion
// shows up the very first time, for every committee. villages_near_path
// still runs alongside it and wins when it has a real match (so
// confirming a stop against a known village still backfills that
// village's coordinates, same as before) — Photon fills the gap, it
// doesn't replace that path.
//
// Each stop — added or still-suggested — now also shows its approx.
// arrival time, same calculation the rider's own stop board uses
// (estimateArrivalTime, src/lib/roadRoute.ts), so a driver can see
// before confirming a stop whether its timing actually makes sense.
//
// 2026-11-19: real terminal model (918) — a long-distance route's real
// stops are terminals (fleet_counters: city + optional name, already
// built "for when a city has more than one counter"), with a real
// scheduled arrival/departure, not just a free-text label + pin. A
// vehicle inside a fleet can now link a stop to one of that fleet's
// own terminals and set its schedule; a solo vehicle with no fleet
// keeps exactly the village/Photon flow above, unchanged.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { MapPin, Plus, Building2, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LocationPickerSheet, type PickedLocation, geocodeReverse } from '@/components/mobility/LocationPickerSheet'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { haversineKm, estimateArrivalTime, estimateReturnArrivalTime } from '@/lib/roadRoute'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Stop {
  id: string; label: string; label_ur: string | null; lat: number; lng: number; stop_order: number
  counter_id: string | null; arrival_time: string | null; departure_time: string | null
}
interface NearbyVillage { village_id: string; name: string; name_ur: string | null; lat: number; lng: number; distance_km: number }
interface Suggestion { key: string; label: string; lat: number; lng: number; villageId: string | null; nameUr: string | null }
interface Terminal { id: string; city: string; name: string | null; lat: number | null; lng: number | null }

const DEDUPE_KM = 0.6

export function RouteStopsEditor({ routeId, vehicleId, routePath, departureTime, durationMin, returnDepartureTime, onClose }: {
  routeId: string; vehicleId?: string | null; routePath: { lat: number; lng: number }[] | null; departureTime?: string | null; durationMin?: number | null; returnDepartureTime?: string | null; onClose: () => void
}) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [stops, setStops] = useState<Stop[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [schedulingStop, setSchedulingStop] = useState<Stop | 'new' | null>(null)
  const [scheduleTerminalId, setScheduleTerminalId] = useState('')
  const [scheduleArrival, setScheduleArrival] = useState('')
  const [scheduleDeparture, setScheduleDeparture] = useState('')
  const [savingSchedule, setSavingSchedule] = useState(false)

  const buildSuggestions = async (currentStops: Stop[]) => {
    if (!routePath || routePath.length < 2) { setSuggestions([]); return }
    setSuggestionsLoading(true)

    const { data: v } = await supabase.rpc('villages_near_path', { p_path: routePath, p_max_km: 2 })
    const fromVillages: Suggestion[] = ((v as NearbyVillage[] | null) ?? []).map((row) => ({
      key: `village:${row.village_id}`, label: row.name, nameUr: row.name_ur, lat: row.lat, lng: row.lng, villageId: row.village_id,
    }))

    // Sample points along the path (skip the very start/end — those
    // are the route's own origin/destination already) and reverse-
    // geocode each via Photon for a real place name. Real gap found
    // live: rural Pakistan has very sparse OSM coverage — Photon
    // genuinely returns zero features for a real point in the middle
    // of farmland (confirmed directly), which left the whole
    // suggestion list empty for exactly the routes most likely to need
    // it. A point with no nearby named feature still becomes a
    // suggestion — just with a generic "Stop N" label instead of a
    // real place name — so there is always something to tap and
    // confirm, never a dead end; the driver can still rename it (the
    // label field stays editable everywhere else in this app too).
    const cum: number[] = [0]
    for (let i = 1; i < routePath.length; i++) cum.push(cum[i - 1] + haversineKm(routePath[i - 1], routePath[i]))
    const total = cum[cum.length - 1] || 1
    const fractions = [0.2, 0.4, 0.6, 0.8]
    const samplePoints = fractions.map((f) => {
      const targetDist = f * total
      let idx = 0
      for (; idx < cum.length; idx++) if (cum[idx] >= targetDist) break
      return routePath[Math.min(idx, routePath.length - 1)]
    })
    const geocoded = await Promise.all(samplePoints.map((p) => geocodeReverse(p.lat, p.lng, isUrdu).then((label) => ({ label, p }))))
    const fromPhoton: Suggestion[] = geocoded.map((g, i) => ({
      key: `photon:${i}`, label: g.label || t('mv.genericStopLabel').replace('{n}', String(i + 1)), nameUr: null, lat: g.p.lat, lng: g.p.lng, villageId: null,
    }))

    // De-dupe by real proximity (not exact label text) against both
    // already-added stops and each other — a village match and a
    // Photon-geocoded point for the same spot shouldn't both show up.
    const seen: { lat: number; lng: number }[] = currentStops.map((s) => ({ lat: s.lat, lng: s.lng }))
    const result: Suggestion[] = []
    for (const s of [...fromVillages, ...fromPhoton]) {
      const isDupe = seen.some((p) => haversineKm(p, s) < DEDUPE_KM)
      if (!isDupe) { result.push(s); seen.push({ lat: s.lat, lng: s.lng }) }
    }
    setSuggestions(result)
    setSuggestionsLoading(false)
  }

  const load = async () => {
    const { data } = await supabase.from('route_stops').select('id, label, label_ur, lat, lng, stop_order, counter_id, arrival_time, departure_time').eq('route_id', routeId).order('stop_order')
    const rows = (data ?? []) as Stop[]
    setStops(rows)
    setLoading(false)
    buildSuggestions(rows)
  }

  useEffect(() => { load() }, [routeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Terminal picking only applies when this vehicle actually belongs
  // to a fleet (fleet_counters.fleet_id) — a solo vehicle has no
  // terminal network to pick from, and keeps the village/Photon flow
  // above exactly as it already works.
  useEffect(() => {
    if (!vehicleId) return
    supabase.from('vehicles').select('fleet_id').eq('id', vehicleId).single().then(({ data }) => {
      const fleetId = (data as { fleet_id: string | null } | null)?.fleet_id
      if (!fleetId) return
      supabase.rpc('my_fleet_counters', { p_fleet_id: fleetId }).then(({ data: c }) =>
        setTerminals(((c ?? []) as Terminal[])))
    })
  }, [vehicleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const addSuggestion = async (s: Suggestion) => {
    setAdding(true)
    const { error } = await supabase.rpc('create_route_stop', {
      p_route_id: routeId, p_label: s.label, p_label_ur: s.nameUr, p_lat: s.lat, p_lng: s.lng, p_village_id: s.villageId, p_stop_order: stops.length + 1,
    })
    setAdding(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.stopAddedToast'))
    load()
  }

  const addManualStop = async (loc: PickedLocation) => {
    setShowPicker(false)
    setAdding(true)
    const { error } = await supabase.rpc('create_route_stop', {
      p_route_id: routeId, p_label: loc.label, p_label_ur: null, p_lat: loc.lat, p_lng: loc.lng, p_village_id: null, p_stop_order: stops.length + 1,
    })
    setAdding(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.stopAddedToast'))
    load()
  }

  const openNewTerminalStop = () => { setSchedulingStop('new'); setScheduleTerminalId(''); setScheduleArrival(''); setScheduleDeparture('') }
  const openEditStopSchedule = (s: Stop) => { setSchedulingStop(s); setScheduleTerminalId(s.counter_id ?? ''); setScheduleArrival(s.arrival_time?.slice(0, 5) ?? ''); setScheduleDeparture(s.departure_time?.slice(0, 5) ?? '') }

  const saveSchedule = async () => {
    if (schedulingStop === 'new') {
      const terminal = terminals.find((x) => x.id === scheduleTerminalId)
      if (!terminal) { toast.error(t('mv.pickTerminalError')); return }
      setSavingSchedule(true)
      const { error } = await supabase.rpc('create_route_stop', {
        p_route_id: routeId, p_label: terminal.name ? `${terminal.city} · ${terminal.name}` : terminal.city, p_label_ur: null,
        p_lat: terminal.lat, p_lng: terminal.lng, p_village_id: null, p_stop_order: stops.length + 1,
        p_counter_id: terminal.id, p_arrival_time: scheduleArrival || null, p_departure_time: scheduleDeparture || null,
      })
      setSavingSchedule(false)
      if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
      toast.success(t('mv.stopAddedToast'))
      setSchedulingStop(null); load()
    } else if (schedulingStop) {
      setSavingSchedule(true)
      const { error } = await supabase.rpc('update_route_stop_schedule', {
        p_stop_id: schedulingStop.id, p_counter_id: scheduleTerminalId || null, p_arrival_time: scheduleArrival || null, p_departure_time: scheduleDeparture || null,
      })
      setSavingSchedule(false)
      if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
      toast.success(t('action.saved', 'Saved'))
      setSchedulingStop(null); load()
    }
  }

  const etaFor = (p: { lat: number; lng: number }) => routePath ? estimateArrivalTime(routePath, durationMin ?? null, departureTime ?? null, p) : null
  const returnEtaFor = (p: { lat: number; lng: number }) => routePath ? estimateReturnArrivalTime(routePath, durationMin ?? null, returnDepartureTime ?? null, p) : null

  if (schedulingStop) {
    return (
      <MobilityBottomSheet title={schedulingStop === 'new' ? t('mv.addTerminalStopBtn') : t('mv.editStopScheduleHeading')} onClose={() => setSchedulingStop(null)}>
        <div className="flex flex-col gap-2.5">
          <label className="block font-sans text-[11.5px] font-bold text-[#64748b]">{t('mv.terminalLabel')}</label>
          <select value={scheduleTerminalId} onChange={(e) => setScheduleTerminalId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
            <option value="">{schedulingStop === 'new' ? t('mv.selectTerminalPlaceholder') : t('mv.noTerminalLinkOption')}</option>
            {terminals.map((term) => <option key={term.id} value={term.id}>{term.city}{term.name ? ` · ${term.name}` : ''}</option>)}
          </select>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block font-sans text-[11px] font-bold text-[#64748b] mb-1">{t('mv.stopArrivesLabel')}</label>
              <input type="time" value={scheduleArrival} onChange={(e) => setScheduleArrival(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
            <div className="flex-1">
              <label className="block font-sans text-[11px] font-bold text-[#64748b] mb-1">{t('mv.stopDepartsLabel')}</label>
              <input type="time" value={scheduleDeparture} onChange={(e) => setScheduleDeparture(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </div>
          </div>
          <button onClick={saveSchedule} disabled={savingSchedule} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {savingSchedule ? t('action.loading') : t('action.save')}
          </button>
        </div>
      </MobilityBottomSheet>
    )
  }

  return (
    <MobilityBottomSheet title={t('mv.manageStopsHeading')} onClose={onClose}>
      {loading ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : showPicker ? (
        <LocationPickerSheet title={t('mv.addStopManuallyBtn')} inline onClose={() => setShowPicker(false)} onConfirm={addManualStop} />
      ) : (
        <div className="flex flex-col gap-2.5">
          <p className="font-sans text-[11.5px] text-[#64748b]">{t('mv.manageStopsHint')}</p>

          {(stops.length > 0 || (routePath && routePath.length > 0)) && (
            <LeafletMap
              pins={stops.map((s) => ({ lat: s.lat, lng: s.lng, label: isUrdu && s.label_ur ? s.label_ur : s.label, color: '#166534', emoji: '📍' }))}
              route={routePath ?? undefined}
              height={150} className="rounded-xl"
            />
          )}

          {stops.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {stops.map((s, i) => {
                const eta = etaFor(s)
                const returnEta = returnEtaFor(s)
                const terminal = terminals.find((x) => x.id === s.counter_id)
                return (
                  <div key={s.id} className="flex items-center gap-2 rounded-lg bg-[#f0fdf4] px-2.5 py-1.5">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-[#166534] text-white text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <span className="block font-sans text-[12px] font-semibold text-[#166534] truncate">{isUrdu && s.label_ur ? s.label_ur : s.label}</span>
                      {(terminal || s.arrival_time || s.departure_time) && (
                        <span className="block font-sans text-[9.5px] text-[#64748b] truncate ltr-num">
                          {terminal ? `${terminal.city}${terminal.name ? ` · ${terminal.name}` : ''} · ` : ''}
                          {s.arrival_time ? `${t('mv.stopArrivesLabel')} ${s.arrival_time.slice(0, 5)}` : ''}
                          {s.arrival_time && s.departure_time ? ' · ' : ''}
                          {s.departure_time ? `${t('mv.stopDepartsLabel')} ${s.departure_time.slice(0, 5)}` : ''}
                        </span>
                      )}
                    </div>
                    <button type="button" onClick={() => openEditStopSchedule(s)} className="shrink-0 p-1 text-[#64748b] cursor-pointer"><Clock size={13} /></button>
                    <span className="shrink-0 flex flex-col items-end font-sans text-[10px] font-bold text-[#64748b] ltr-num">
                      {eta && <span>🕒 {eta}</span>}
                      {returnEta && <span>↩️ {returnEta}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div>
            <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] mb-1.5">{t('mv.suggestedStopsLabel')}</p>
            {suggestionsLoading ? (
              <p className="font-sans text-[11.5px] text-[#94a3b8]">{t('action.loading')}</p>
            ) : suggestions.length === 0 ? (
              <p className="font-sans text-[11.5px] text-[#94a3b8]">{t('mv.noSuggestedStops')}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {suggestions.map((s) => {
                  const eta = etaFor(s)
                  return (
                    <button key={s.key} onClick={() => addSuggestion(s)} disabled={adding}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50 text-start">
                      <Plus size={12} className="shrink-0" />
                      <span className="flex-1 min-w-0 truncate">{s.label}</span>
                      {eta && <span className="shrink-0 text-[#64748b] ltr-num">{t('mp.approxTimePrefix')} {eta}</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {terminals.length > 0 && (
            <button onClick={openNewTerminalStop} className="flex items-center justify-center gap-1.5 w-full border border-[#166534] rounded-xl py-2.5 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer">
              <Building2 size={14} /> {t('mv.addTerminalStopBtn')}
            </button>
          )}
          <button onClick={() => setShowPicker(true)} className="flex items-center justify-center gap-1.5 w-full border border-[#e5e2d0] rounded-xl py-2.5 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer">
            <MapPin size={14} /> {t('mv.addStopManuallyBtn')}
          </button>
        </div>
      )}
    </MobilityBottomSheet>
  )
}
