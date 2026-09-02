'use client'

// "Going Home" — a rider outside the village marks where he is (GPS or a
// manual pin) and sees everything relevant to getting home from right
// there: nearby adda stands with their live queue (fixed-fare public
// transport, via nearby_addas() + adda_board() per adda found) and
// nearby freeform vehicles — rickshaws/bikes/cars sharing their live
// position (nearby_open_trips(), 414/415), discovery only — tapping a
// freeform card's fare row proposes a fare via the same propose_trip_
// fare/respond_trip_fare_offer negotiation (migration 400) the rest of
// the return-trip flow already uses; adda seats are booked on the full
// board page this links out to, not duplicated here.
//
// Map-first layout, same shape as a ride-hailing app: the map fills the
// screen, the results panel is a real sidebar — fixed on a wide screen,
// a slide-in drawer (open by default) on a phone, not a bottom sheet.
// Breaks out of the portal shell's own padding (-m-6/-m-10, canceling
// <main>'s p-6/p-10) since a "full page map" can't sit inside a padded
// card.
//
// Kept as its own page rather than a tab on /portal/marketplace/trips —
// this screen asks for a location permission and runs a live poll loop
// the moment it opens; a rider who only wanted the trips list shouldn't
// be prompted for GPS access just for landing on the same page.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, LocateFixed, MapPinned, Phone, Loader2, Radio, Signpost, ChevronRight, List, X } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getCurrentPositionOnce, classifyLocationError, type LiveLocationPosition, type LocationErrorReason } from '@/hooks/useLiveLocation'
import { LocationSettingsModal } from '@/components/portal/LocationSettingsModal'
import type { MapPin, LeafletMapHandle } from '@/components/shared/LeafletMap'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })
const LeafletSinglePinPicker = dynamic(() => import('@/components/shared/LeafletSinglePinPicker'), { ssr: false })

interface NearbyTrip {
  trip_offer_id: string; vehicle_id: string; owner_name: string; owner_mobile: string | null
  vehicle_type: string; vehicle_number: string | null
  origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; seats_available: number; listed_fare_per_seat_pkr: number
  lat: number; lng: number; updated_at: string; distance_km: number | null
}
interface NearbyAdda {
  id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null
  operating_start_time: string | null; operating_end_time: string | null; distance_km: number | null
}
interface AddaBoardEntry {
  entry_id: string; status: string; seats_available: number; fare_mode: string; fixed_fare_per_seat_pkr: number | null
  owner_name: string; vehicle_type: string
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function vehicleEmoji(vehicleType: string) {
  const t = vehicleType.toLowerCase()
  if (t.includes('rickshaw') || t.includes('riksha')) return '🛺'
  if (t.includes('bike') || t.includes('motor')) return '🏍️'
  return '🚐' // Suzuki-style van/wagon — the overwhelming majority of this marketplace's vehicles
}
// A distinct color family per vehicle type, not just a distinct emoji —
// used on every vehicle card's icon badge (both the adda queue cards and
// the freeform ones) so the type reads at a glance before you even see
// the label text.
function vehicleColors(vehicleType: string) {
  const t = vehicleType.toLowerCase()
  if (t.includes('rickshaw') || t.includes('riksha')) return { bg: 'bg-amber-50', border: 'border-amber-200' }
  if (t.includes('bike') || t.includes('motor')) return { bg: 'bg-purple-50', border: 'border-purple-200' }
  return { bg: 'bg-emerald-50', border: 'border-emerald-200' }
}
function minutesAgo(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}
// "07:00:00" (Postgres time, as supabase-js hands it back) → "7:00 AM"
function formatTime(t: string) {
  const [hStr, mStr] = t.split(':')
  const h = Number(hStr); const m = Number(mStr)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}
// Leaflet popups are raw HTML outside React's tree — escape anything
// interpolated into one (an adda's own name/hours, admin-entered but
// still worth not trusting blindly) so it can't break the markup.
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export default function NearbyOpenTripsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const mapRef = useRef<LeafletMapHandle>(null)
  // A React portal needs `document` to exist, so the drawer render only
  // happens after mount (see the createPortal call below for why this
  // has to be a portal at all, not just a higher z-index).
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const [myPos, setMyPos] = useState<LiveLocationPosition | null>(null)
  const [locating, setLocating] = useState(false)
  const [pickingOnMap, setPickingOnMap] = useState(false)
  const [pickedPin, setPickedPin] = useState<{ lat: number; lng: number } | null>(null)
  const [locationModalReason, setLocationModalReason] = useState<Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'> | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [activeAddaId, setActiveAddaId] = useState<string | null>(null)

  const [trips, setTrips] = useState<NearbyTrip[]>([])
  const [addas, setAddas] = useState<NearbyAdda[]>([])
  const [addaBoards, setAddaBoards] = useState<Record<string, AddaBoardEntry[]>>({})
  const [loading, setLoading] = useState(true)
  const [seats, setSeats] = useState<Record<string, number>>({})
  const [fare, setFare] = useState<Record<string, number>>({})
  const [actionId, setActionId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    const [{ data: tripData, error: tripErr }, { data: addaData }] = await Promise.all([
      supabase.rpc('nearby_open_trips', { p_destination: null, p_lat: myPos?.lat ?? null, p_lng: myPos?.lng ?? null, p_radius_km: 50 }),
      supabase.rpc('nearby_addas', { p_lat: myPos?.lat ?? null, p_lng: myPos?.lng ?? null, p_radius_km: 50 }),
    ])
    if (!tripErr) setTrips(tripData ?? [])
    setAddas(addaData ?? [])
    // Default the selected tab to the nearest adda (nearby_addas already
    // sorts by distance) the first time addas load — never overrides a
    // choice the rider already made by tapping a different tab.
    setActiveAddaId((prev) => prev ?? (addaData && addaData.length > 0 ? addaData[0].id : null))
    if (addaData && addaData.length > 0) {
      const entries = await Promise.all(
        (addaData as NearbyAdda[]).map((a) => supabase.rpc('adda_board', { p_adda_id: a.id }).then(({ data }) => [a.id, data] as const))
      )
      const boards: Record<string, AddaBoardEntry[]> = {}
      for (const [addaId, board] of entries) {
        const b = board as { entries?: AddaBoardEntry[] } | null
        boards[addaId] = (b?.entries ?? []).filter((e) => ['waiting', 'current'].includes(e.status))
      }
      setAddaBoards(boards)
    } else setAddaBoards({})
    setLoading(false)
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(load, 15000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPos])

  const useMyLocation = async () => {
    setPickingOnMap(false)
    setLocating(true)
    try {
      const pos = await getCurrentPositionOnce()
      setMyPos(pos)
    } catch (err) {
      const reason = classifyLocationError(err)
      // 'unavailable' is the classifier's honest "couldn't tell" bucket,
      // but in practice on Android that's very often GPS being off
      // reported through a generic code some OEMs use instead of the
      // specific one — so it gets the same settings shortcut rather than
      // a dead-end toast. Only a genuine timeout has no settings screen
      // that would fix it.
      if (reason === 'timeout') toast.error(t('af.locationTimeoutHint'))
      else setLocationModalReason(reason === 'permission_denied' ? 'permission_denied' : 'services_disabled')
    } finally {
      setLocating(false)
    }
  }

  const confirmPickedPin = () => {
    if (!pickedPin) return
    setMyPos(pickedPin)
    setPickingOnMap(false)
  }

  const proposeFare = async (trip: NearbyTrip) => {
    const s = seats[trip.trip_offer_id] || 1
    const f = fare[trip.trip_offer_id]
    if (!f) { toast.error(t('af.enterFareFirst')); return }
    setActionId(trip.trip_offer_id)
    const { error } = await supabase.rpc('propose_trip_fare', { p_trip_offer_id: trip.trip_offer_id, p_seats_requested: s, p_proposed_fare_per_seat_pkr: f })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.fareProposedToast'))
  }

  const visibleAddas = addas.filter((a) => a.lat != null && a.lng != null)
  const activeAdda = visibleAddas.find((a) => a.id === activeAddaId) ?? visibleAddas[0] ?? null

  // "You" pin last, not first — Leaflet stacks later-added markers on
  // top, and a rider testing from (or near) the village can genuinely be
  // close enough on screen to an adda pin for one to sit right on top of
  // the other. Also upgraded from a small 18px dot to the same
  // emoji-marker size as everything else — the small dot could get fully
  // hidden behind a bigger adda/vehicle pin even before the ordering
  // fix, since a same-size overlap still lets edges peek through but a
  // big-over-small one doesn't.
  const pins: MapPin[] = [
    ...visibleAddas.map((a) => {
      const name = escapeHtml(isUrdu && a.name_ur ? a.name_ur : a.name)
      const distanceLine = a.distance_km != null ? `${a.distance_km} ${escapeHtml(t('af.kmAway'))}` : ''
      const hoursLine = a.operating_start_time && a.operating_end_time ? escapeHtml(`${formatTime(a.operating_start_time)} – ${formatTime(a.operating_end_time)}`) : ''
      const subLine = [distanceLine, hoursLine].filter(Boolean).join(' · ')
      // A real <a href> — Leaflet's popup DOM sits outside React, so a
      // plain browser navigation is simpler and more robust here than
      // wiring a click handler back into React state.
      return {
        lat: a.lat!, lng: a.lng!, color: '#7c3aed', emoji: '🚏',
        // dir="ltr" on the distance/hours line only, not the whole popup —
        // "7:30 AM – 7:00 PM" rendered inside an RTL-context element
        // otherwise gets its segments visually reordered by the browser
        // (found by actually looking at a screenshot: it rendered as
        // "AM – 7:00 PM 7:30"). Same "flip the data, not the screen"
        // convention this app's <T>/ltr-num already use for numbers.
        popupHtml: `<div style="min-width:170px">`
          + `<p style="margin:0;font-weight:700;font-size:13px;color:#1f2937;">${name}</p>`
          + (subLine ? `<p dir="ltr" style="margin:3px 0 0;font-size:11px;color:#6b7280;text-align:${isUrdu ? 'right' : 'left'};">${subLine}</p>` : '')
          + `<a href="/portal/marketplace/adda?adda=${a.id}" style="display:inline-block;margin-top:8px;padding:5px 11px;background:var(--color-dp-secondary,#006c4e);color:#fff;border-radius:6px;font-size:11.5px;font-weight:700;text-decoration:none;">${escapeHtml(t('af.viewFullBoardBtn'))} →</a>`
          + `</div>`,
      }
    }),
    ...trips.map((tr) => ({
      lat: tr.lat, lng: tr.lng, color: '#16a34a', emoji: vehicleEmoji(tr.vehicle_type),
      label: `${tr.owner_name} — ${isUrdu && tr.destination_ur ? tr.destination_ur : tr.destination}`,
    })),
    ...(myPos ? [{ lat: myPos.lat, lng: myPos.lng, label: t('af.youPinLabel'), color: '#2563eb', emoji: '📍' }] : []),
  ]
  const addaPinIndex = (a: NearbyAdda) => visibleAddas.findIndex((x) => x.id === a.id)
  const tripPinIndex = (tr: NearbyTrip) => visibleAddas.length + trips.findIndex((x) => x.trip_offer_id === tr.trip_offer_id)

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const locationControls = (
    <>
      {!myPos && !pickingOnMap && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={useMyLocation} disabled={locating} className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg font-sans text-[13px] font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50 shadow-sm">
            {locating ? <Loader2 size={14} className="animate-spin" /> : <LocateFixed size={14} />} {t('af.useMyLocationBtn')}
          </button>
          <button onClick={() => setPickingOnMap(true)} className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg font-sans text-[13px] font-semibold cursor-pointer border border-dp-outline-variant bg-white text-dp-on-surface hover:bg-dp-surface-container shadow-sm">
            <MapPinned size={14} /> {t('af.markOnMapBtn')}
          </button>
        </div>
      )}
      {myPos && !pickingOnMap && (
        <div className="flex items-center justify-between gap-2 bg-dp-secondary-container/30 border border-dp-secondary/20 rounded-lg px-3.5 py-2.5">
          <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface flex items-center gap-1.5 min-w-0"><LocateFixed size={13} className="text-dp-secondary shrink-0" /> <span className="truncate">{t('af.positionSetHint')}</span></span>
          <button onClick={() => { setMyPos(null); setPickedPin(null) }} className="shrink-0 font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer flex items-center gap-1"><X size={12} /> {t('af.changePositionBtn')}</button>
        </div>
      )}
    </>
  )

  const addaCard = (e: AddaBoardEntry) => {
    const c = vehicleColors(e.vehicle_type)
    return (
      <div key={e.entry_id} className={`flex items-center gap-3 bg-white border border-dp-outline-variant rounded-xl p-3 shadow-sm hover:border-dp-secondary transition-colors`}>
        <div className={`shrink-0 w-11 h-11 rounded-full ${c.bg} border ${c.border} flex items-center justify-center text-[19px]`}>{vehicleEmoji(e.vehicle_type)}</div>
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[13.5px] font-bold text-dp-on-surface truncate">{e.owner_name}</p>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant truncate">{e.vehicle_type} · {e.seats_available} {t('af.seatsFreeLabel')}</p>
        </div>
        <span className="shrink-0 font-sans text-[13px] font-bold text-dp-secondary ltr-num">{e.fare_mode === 'fixed' ? fmt(e.fixed_fare_per_seat_pkr ?? 0) : t('af.rideRequestMode')}</span>
      </div>
    )
  }

  const resultsList = (
    <>
      {/* ─── Public transport (adda stands) — a tab per nearby adda, ─────
          full card list for whichever one's selected ────────────────── */}
      <div className="mb-6">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Signpost size={13} /> {t('af.publicTransportHeading')}</p>
        {visibleAddas.length === 0 ? (
          <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('af.noNearbyAddas')}</p>
        ) : (
          <>
            {visibleAddas.length > 1 && (
              <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1">
                {visibleAddas.map((a) => {
                  const active = a.id === activeAdda?.id
                  return (
                    <button key={a.id} onClick={() => { setActiveAddaId(a.id); const idx = addaPinIndex(a); if (idx >= 0) mapRef.current?.focusPin(idx) }}
                      className={`shrink-0 px-3.5 py-2 rounded-full font-sans text-[12.5px] font-bold cursor-pointer transition-colors ${active ? 'bg-dp-secondary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface hover:bg-dp-surface-container'}`}>
                      🚏 {isUrdu && a.name_ur ? a.name_ur : a.name}
                    </button>
                  )
                })}
              </div>
            )}
            {activeAdda && (() => {
              const a = activeAdda
              const available = addaBoards[a.id] ?? []
              return (
                <div className="bg-white border border-dp-outline-variant rounded-xl p-3.5 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-sans text-[14.5px] font-bold text-dp-on-surface truncate">{isUrdu && a.name_ur ? a.name_ur : a.name}</p>
                    {a.distance_km != null && <span className="shrink-0 font-sans text-[11px] font-bold text-dp-secondary ltr-num bg-dp-secondary-container/40 px-2 py-0.5 rounded-full">{a.distance_km} {t('af.kmAway')}</span>}
                  </div>
                  {a.operating_start_time && a.operating_end_time && (
                    <p dir="ltr" className={`font-sans text-[11.5px] text-dp-on-surface-variant mt-1 ${isUrdu ? 'text-right' : 'text-left'}`}>{formatTime(a.operating_start_time)} – {formatTime(a.operating_end_time)}</p>
                  )}
                  <div className="mt-3 space-y-2">
                    {available.length === 0 ? (
                      <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('af.noVehiclesRightNow')}</p>
                    ) : available.map(addaCard)}
                  </div>
                  <Link href={`/portal/marketplace/adda?adda=${a.id}`} className="mt-3 inline-flex items-center gap-0.5 font-sans text-[12.5px] font-bold text-dp-secondary hover:underline">
                    {t('af.viewFullBoardBtn')} <ChevronRight size={13} className={isUrdu ? 'rotate-180' : ''} />
                  </Link>
                </div>
              )
            })()}
          </>
        )}
      </div>

      {/* ─── Freeform: rickshaws, bikes, cars sharing live location ── */}
      <div>
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Radio size={13} /> {t('af.vehiclesNearbyHeading')}</p>
        {trips.length === 0 ? (
          <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('af.noNearbyTrips')}</p>
        ) : (
          <div className="space-y-2.5">
            {trips.map((tr) => {
              const idx = tripPinIndex(tr)
              const c = vehicleColors(tr.vehicle_type)
              return (
                <div key={tr.trip_offer_id} onClick={() => idx >= 0 && mapRef.current?.focusPin(idx)} className="bg-white border border-dp-outline-variant rounded-xl p-3.5 shadow-sm cursor-pointer hover:border-dp-secondary transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`shrink-0 w-11 h-11 rounded-full ${c.bg} border ${c.border} flex items-center justify-center text-[19px]`}>{vehicleEmoji(tr.vehicle_type)}</div>
                    <div className="min-w-0 flex-1">
                      <p className="font-sans text-[14px] font-bold text-dp-on-surface truncate">{tr.owner_name}</p>
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant truncate">{tr.vehicle_type}{tr.vehicle_number ? ` · ${tr.vehicle_number}` : ''}</p>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {tr.distance_km != null && <span className="font-sans text-[11px] font-bold text-dp-secondary ltr-num bg-dp-secondary-container/40 px-2 py-0.5 rounded-full">{tr.distance_km} {t('af.kmAway')}</span>}
                      <span className="inline-flex items-center gap-1 font-sans text-[10px] text-emerald-600 font-semibold"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" /> {t('af.updatedMinutesAgo').replace('{n}', String(minutesAgo(tr.updated_at)))}</span>
                    </div>
                  </div>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-2.5 truncate">{isUrdu && tr.origin_ur ? tr.origin_ur : tr.origin} → {isUrdu && tr.destination_ur ? tr.destination_ur : tr.destination} · {tr.seats_available} {t('mk.seatsLabel')} {t('af.stillFree')}</p>
                  {tr.owner_mobile && <a href={`tel:${tr.owner_mobile}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary hover:underline mt-1 ltr-num" dir="ltr"><Phone size={11} /> {tr.owner_mobile}</a>}
                  {tr.listed_fare_per_seat_pkr > 0 ? (
                    // A fixed, system-set fare (an adda departure, most
                    // likely already en route) is informational here —
                    // the real seat booking happened at the adda board
                    // before it left; this is "here's where he is / call
                    // to check", not a live negotiation.
                    <p className="font-sans text-[12.5px] font-bold text-white bg-dp-secondary inline-block mt-2.5 px-2.5 py-1 rounded-full">{t('af.fixedFareInfoLabel').replace('{amount}', fmt(tr.listed_fare_per_seat_pkr))}</p>
                  ) : (
                    <div onClick={(e) => e.stopPropagation()} className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                      <input type="number" min={1} max={tr.seats_available} value={seats[tr.trip_offer_id] ?? 1} onChange={(e) => setSeats((s) => ({ ...s, [tr.trip_offer_id]: +e.target.value }))} className="input-field !w-16 !py-1.5" />
                      <input type="number" value={fare[tr.trip_offer_id] ?? ''} onChange={(e) => setFare((s) => ({ ...s, [tr.trip_offer_id]: +e.target.value }))} placeholder={t('cm.counterPlaceholder')} className="input-field !w-24 !py-1.5" />
                      <button onClick={() => proposeFare(tr)} disabled={actionId === tr.trip_offer_id} className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('af.proposeFareBtn')}</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )

  const panelInner = (
    <>
      <div className="p-5 pb-4 border-b border-dp-outline-variant/60 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <Link href="/portal/marketplace" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}</Link>
          <button onClick={() => setPanelOpen(false)} className="lg:hidden shrink-0 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1"><X size={18} /></button>
        </div>
        <h1 className="font-heading text-[22px] font-bold leading-[28px] text-dp-primary mb-1">{t('af.nearbyPageTitle')}</h1>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('af.nearbyPageHint')}</p>
        {locationControls}
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? <p className="text-center py-8"><LoadingDots /></p> : resultsList}
      </div>
    </>
  )

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="-m-6 md:-m-10">
      <div className="relative lg:flex h-[calc(100dvh-160px)] min-h-[420px] lg:h-[calc(100dvh-100px)] lg:min-h-0">

        {/* Desktop: a static sidebar in normal flex flow, right next to the
            map — no z-index/stacking concerns since nothing overlaps it. */}
        <div className="hidden lg:flex lg:flex-col lg:w-[400px] lg:shrink-0 lg:h-full lg:bg-white lg:border-e lg:border-dp-outline-variant">
          {panelInner}
        </div>

        {/* Mobile: a slide-in drawer, rendered via a portal straight into
            <body> rather than in its normal spot in this page's own DOM
            tree. A high z-index alone was not enough — the map (Leaflet
            manages a lot of internal layered DOM of its own) kept
            rendering on top of the panel regardless of the z-index given
            to it here. Escaping to a portal removes any ambiguity about
            which stacking context either one belongs to; it's the
            standard, reliable fix for exactly this class of bug, the
            same reason most drawer/modal libraries default to portals.
            `dir` has to be set explicitly here — a portaled node is a
            child of <body>, not of this page's own dir="rtl" wrapper. */}
        {mounted && createPortal(
          <div dir={isUrdu ? 'rtl' : 'ltr'}>
            {panelOpen && <div onClick={() => setPanelOpen(false)} className="lg:hidden fixed inset-0 z-[9998] bg-black/40" />}
            <div className={`lg:hidden fixed inset-y-0 start-0 z-[9999] w-[86%] max-w-[380px] h-full bg-white shadow-2xl transition-transform duration-300 ease-out flex flex-col ${panelOpen ? 'translate-x-0' : isUrdu ? 'translate-x-full' : '-translate-x-full'}`}>
              {panelInner}
            </div>
          </div>,
          document.body
        )}

        {/* ─── Map fills everything else ─── */}
        <div className="relative w-full h-full lg:flex-1">
          {pickingOnMap ? (
            <div className="h-full flex flex-col p-4 bg-dp-surface-container-low overflow-y-auto">
              <Link href="/portal/marketplace" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3 lg:hidden"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}</Link>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-2">{t('af.tapMapHint')}</p>
              <LeafletSinglePinPicker lat={pickedPin?.lat ?? null} lng={pickedPin?.lng ?? null} onChange={(p) => setPickedPin(p)} />
              <div className="flex items-center gap-2 mt-2.5">
                <button onClick={confirmPickedPin} disabled={!pickedPin} className="px-3.5 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('af.confirmPinBtn')}</button>
                <button onClick={() => { setPickingOnMap(false); setPickedPin(null) }} className="px-3.5 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer border border-dp-outline-variant hover:bg-dp-surface-container">{t('action.cancel')}</button>
              </div>
            </div>
          ) : (
            <>
              <LeafletMap ref={mapRef} pins={pins} height="100%" className="w-full h-full" extraPadding={{ top: 70 }} />

              {/* Floating "show list" button — mobile only, shown once the
                  drawer's been closed (it's the only way back to it besides
                  a full page reload). */}
              {!panelOpen && (
                <button onClick={() => setPanelOpen(true)} className="lg:hidden absolute top-3 z-[400] flex items-center gap-1.5 px-3.5 py-2.5 rounded-full bg-white shadow-lg font-sans text-[13px] font-semibold text-dp-on-surface cursor-pointer hover:bg-dp-surface-container-low" style={isUrdu ? { right: 12 } : { left: 12 }}>
                  <List size={16} /> {t('af.showListBtn')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {locationModalReason && <LocationSettingsModal reason={locationModalReason} onClose={() => setLocationModalReason(null)} />}
    </div>
  )
}
