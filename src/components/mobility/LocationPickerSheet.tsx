'use client'

// Real map-tap location picker — the design file's own `openPicker`
// (dhab-pari-mobility.html): every booking sheet resolves pickup/
// drop-off/venue/site through this, never a typed address alone. Found
// missing in a full re-audit against the design: hourly pickup, shadi
// venue, and equipment site were all free-text only, no coordinates, so
// a driver had nothing but a sentence to find the spot by. This is the
// one shared sheet every one of those forms now opens instead — tap the
// map (or use GPS) to drop a pin, then a short label for what it is.
//
// Real gap found live, 2026-10-20: no way to search for a destination
// by name, and dropping a pin never filled in what that place actually
// is — the rider had to type a label from scratch every time with zero
// help. Added free OpenStreetMap Nominatim search (type a name, see
// matches, tap one to set both the pin and the label) and reverse
// geocoding (dropping a pin or using GPS now looks up and fills the
// label automatically) — the label field stays a plain, editable input
// either way, exactly as asked ("it can be editable so people can
// choose this manually"), never locked to what geocoding returned.
//
// Real complaint, same day: "the popup of the map again when user click
// on the start point or destination is wrong... make this request page
// big enough to display the map on that too." Opening this as ANOTHER
// sheet stacked over the page the rider was already filling in (one
// popup launching another) read as broken, not modern. `inline` renders
// the exact same search/map/GPS/label UI directly in the page's own
// flow instead — no scrim, no fixed overlay, just expands the page in
// place where the From/To button was. The sheet variant stays available
// for anything that genuinely wants a modal (none of this session's
// callers do any more, but the component still supports it).
//
// Real gap found live, 2026-10-20: "the map search is not working, not
// finding any city or place." Confirmed directly — nominatim.openstreetmap.org
// now hard-blocks this app's requests outright (403 "Access denied",
// reproducible from a plain curl, same result with every User-Agent/
// Referer tried — this is their own anti-abuse policy rejecting the
// traffic, not a quota or a code bug). Switched both search and reverse-
// geocode to Photon (photon.komoot.io, komoot's free OSM-based geocoder,
// no API key, confirmed CORS-open and working live) — same free, no-
// billing OSM ecosystem as the map tiles and OSRM routing, just a
// provider that actually answers.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'
import { Target, Loader2, Search, ArrowLeft, Bookmark } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { createClient } from '@/lib/supabase/client'
import { getCurrentPositionOnce, classifyLocationError, type LocationErrorReason } from '@/hooks/useLiveLocation'
import { LocationSettingsModal } from '@/components/portal/LocationSettingsModal'

export interface PickedLocation { lat: number; lng: number; label: string }

interface Props {
  title: string
  initial?: { lat: number; lng: number; label?: string } | null
  defaultCenter?: [number, number]
  onConfirm: (loc: PickedLocation) => void
  onClose: () => void
  /** Render directly in the page's own flow instead of as a popup sheet. */
  inline?: boolean
}

interface SearchResult { lat: number; lng: number; displayName: string }

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface PhotonProps { name?: string; street?: string; city?: string; county?: string; state?: string }
interface PhotonFeature { geometry: { coordinates: [number, number] }; properties: PhotonProps }
function photonLabel(p: PhotonProps): string {
  return [p.name, p.street, p.city, p.county, p.state].filter(Boolean).join(', ')
}

// Real ask, 2026-10-26: "try to display the addresses in Urdu and not
// English." Both calls go through /api/geocode (a thin server-side
// Photon proxy — see that route for the full why) instead of hitting
// photon.komoot.io directly, because getting Urdu out of Photon means
// setting its Accept-Language header, and a browser `fetch()` can't be
// made to send a different Accept-Language than the device's own OS/
// Chrome locale — confirmed live, the same coordinate returns
// "Punjab"/"Pakistan" or "پنجاب"/"پاکستان" purely based on that header,
// and client-side JS has no way to override it. A server-side fetch can
// set any header it wants, so the proxy does the one thing the browser
// itself refuses to.
//
// Search ranking is the other half of why Urdu isn't simply "always
// ask for it": confirmed live, a `q=Chakwal` search ranks an Indian
// village first under an Urdu/no-language request but correctly ranks
// Pakistan's Chakwal first under `lang=en` — Photon's own `lang` query
// param changes its whole relevance score, not just which name field
// comes back. So the search call always asks the proxy for `lang=en`
// (good ranking, Latin-script names), then each result's coordinate
// gets a second, Urdu-mode reverse lookup to resolve its real local
// label for display — the same reverse call already used for pin-drop/
// GPS, just run once per result in parallel.
async function geocodeSearch(query: string, isUrdu: boolean): Promise<SearchResult[]> {
  const res = await fetch(`/api/geocode?mode=search&q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const data = (await res.json()) as { features: PhotonFeature[] }
  const results = data.features
    .map((f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], displayName: photonLabel(f.properties) }))
    .filter((r) => r.displayName)
  if (!isUrdu) return results
  return Promise.all(results.map(async (r) => ({ ...r, displayName: (await geocodeReverse(r.lat, r.lng, true)) ?? r.displayName })))
}
export async function geocodeReverse(lat: number, lng: number, isUrdu: boolean): Promise<string | null> {
  const res = await fetch(`/api/geocode?mode=reverse&lat=${lat}&lon=${lng}&lang=${isUrdu ? 'ur' : 'en'}`)
  if (!res.ok) return null
  const data = (await res.json()) as { features: PhotonFeature[] }
  const label = data.features[0] ? photonLabel(data.features[0].properties) : ''
  return label || null
}

interface QuickCity { id: string; name: string; name_ur: string | null; lat: number; lng: number }
const HOME_STORAGE_KEY = 'dp-mobility-home'

function LocationPickerBody({ title, initial, defaultCenter, onConfirm, onClose, inline }: Props) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(initial ? { lat: initial.lat, lng: initial.lng } : null)
  const [label, setLabel] = useState(initial?.label ?? '')
  const [locating, setLocating] = useState(false)
  const [locationModalReason, setLocationModalReason] = useState<Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'> | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [reverseLookingUp, setReverseLookingUp] = useState(false)
  const labelEditedRef = useRef(false)
  // Portals to document.body below need a real DOM to exist first —
  // false during SSR/the first client render, true right after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Quick city chips, same row the reference design's own picker has
  // below the search bar — the same `cities` table the home page's own
  // destination pills already read from, fetched here too since this
  // sheet is reused from several callers that don't otherwise have it.
  const [cities, setCities] = useState<QuickCity[]>([])
  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, lat, lng').then(({ data }) => setCities(((data ?? []) as QuickCity[]).filter((c) => c.lat != null && c.lng != null)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "Save this place as My Home" — same localStorage-only bookmark the
  // reference design uses (dp-mobility-home), no backend needed for a
  // single-device convenience shortcut.
  const [savedHome, setSavedHome] = useState<{ lat: number; lng: number; label: string } | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HOME_STORAGE_KEY)
      if (raw) setSavedHome(JSON.parse(raw))
    } catch { /* ignore — just means no quick-jump chip for it */ }
  }, [])
  const saveAsHome = () => {
    if (!pin) return
    const home = { lat: pin.lat, lng: pin.lng, label: label.trim() || t('mb.myHomeChip') }
    try { localStorage.setItem(HOME_STORAGE_KEY, JSON.stringify(home)) } catch { /* private-mode/blocked storage — button just won't persist */ }
    setSavedHome(home)
    toast.success(t('mb.myHomeSavedToast'))
  }

  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) { setResults([]); return }
    setSearching(true)
    const handle = setTimeout(() => {
      geocodeSearch(q, isUrdu).then(setResults).catch(() => setResults([])).finally(() => setSearching(false))
    }, 400)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const setPinAndReverseGeocode = (lat: number, lng: number) => {
    setPin({ lat, lng })
    labelEditedRef.current = false
    setReverseLookingUp(true)
    geocodeReverse(lat, lng, isUrdu).then((name) => {
      if (name && !labelEditedRef.current) setLabel(name)
    }).finally(() => setReverseLookingUp(false))
  }

  const jumpTo = (lat: number, lng: number, placeLabel: string) => {
    setPin({ lat, lng })
    labelEditedRef.current = true
    setLabel(placeLabel)
    setQuery(''); setResults([])
  }

  const pickSearchResult = (r: SearchResult) => jumpTo(r.lat, r.lng, r.displayName)

  const useGps = async () => {
    setLocating(true)
    try {
      const pos = await getCurrentPositionOnce()
      setPinAndReverseGeocode(pos.lat, pos.lng)
    } catch (err) {
      const reason = classifyLocationError(err)
      if (reason === 'timeout' || reason === 'unavailable') setPin(null)
      else setLocationModalReason(reason)
    } finally {
      setLocating(false)
    }
  }

  const canConfirm = !!pin && label.trim().length > 0

  // Real ask, 2026-10-21: "make this exactly like that provided html,
  // this current app of our selection method is garbage" — the design's
  // own destination-picker is a full-screen takeover (the map fills the
  // whole screen, nothing else above it), not a card embedded below the
  // header/ticker/category-pills in the page's own scroll flow. The
  // `inline` embed (built for an earlier, different complaint — see
  // this file's older comments above) made the confirm bar/locate
  // button require scrolling past a very tall page to even reach, which
  // is exactly the "garbage" being pointed at. Every caller now gets
  // this same fixed, full-viewport overlay regardless of `inline` — one
  // screen, map-dominant, floating search/back over its top edge, a
  // floating locate-me button on the map itself, and a confirm bar
  // floating over its bottom edge, matching the design file exactly.
  const body = (
    <div className="fixed inset-0 z-[200] flex flex-col bg-[#F9F9F6]" style={{ height: '100dvh' }}>
      <div className="relative flex-1 min-h-0">
        <LeafletMap
          pins={pin ? [{ lat: pin.lat, lng: pin.lng, color: '#166534', openPopup: true, popupHtml: `<b>${label || t('mb.locationLabelPlaceholder')}</b><br/><span style="font-family:monospace;font-size:11px;color:#64748b">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</span>` }] : []}
          center={defaultCenter}
          height="100%"
          zoom={14}
          className="isolate"
          onMapClick={(lat, lng) => setPinAndReverseGeocode(lat, lng)}
        />

        {/* Search + back, floating over the map's top edge. */}
        <div className="absolute top-3 inset-x-3 z-10 flex flex-col gap-2">
          <button onClick={onClose} className="flex items-center gap-1.5 font-sans text-[13px] font-bold text-[#166534] bg-white/95 backdrop-blur-sm w-fit px-2.5 py-1 rounded-full shadow cursor-pointer">
            <ArrowLeft size={14} /> {title}
          </button>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#94a3b8]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('mb.searchLocationPlaceholder')} className="dp2-input ps-9 shadow-md" />
            {searching && <Loader2 size={13} className="absolute top-1/2 -translate-y-1/2 end-3 text-[#94a3b8] animate-spin" />}
            {results.length > 0 && (
              <div className="absolute z-20 top-full mt-1 inset-x-0 border border-[#e5e2d0] rounded-xl overflow-hidden bg-white shadow-lg max-h-[180px] overflow-y-auto">
                {results.map((r, i) => (
                  <button key={i} type="button" onClick={() => pickSearchResult(r)} className="w-full text-start px-3 py-2 font-sans text-[12.5px] cursor-pointer hover:bg-[#F9F9F6] border-b border-[#f1f5f9] last:border-0">
                    {r.displayName}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Quick city chips, matching the reference design's own picker —
              a saved "My Home" chip (if any) plus every real committee
              city, so a common destination needs one tap instead of a
              typed search. */}
          {results.length === 0 && (cities.length > 0 || savedHome) && (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
              {savedHome && (
                <button onClick={() => jumpTo(savedHome.lat, savedHome.lng, savedHome.label)}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold whitespace-nowrap cursor-pointer bg-[#166534] text-white shadow">
                  🏠 {t('mb.myHomeChip')}
                </button>
              )}
              {cities.map((c) => (
                <button key={c.id} onClick={() => jumpTo(c.lat, c.lng, isUrdu && c.name_ur ? c.name_ur : c.name)}
                  className="shrink-0 px-2.5 py-1 rounded-full text-[11.5px] font-semibold whitespace-nowrap cursor-pointer bg-white/95 backdrop-blur-sm text-[#166534] border border-[#e5e2d0] shadow">
                  📍 {isUrdu && c.name_ur ? c.name_ur : c.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Locate-me, floating directly on the map like the design's own
            floating GPS button (bottom-start corner, clear of the confirm
            bar below it). */}
        <button onClick={useGps} disabled={locating}
          className="absolute bottom-3 start-3 z-10 w-11 h-11 rounded-full bg-white shadow-lg border border-[#e5e2d0] flex items-center justify-center text-[#166534] cursor-pointer disabled:opacity-50">
          {locating ? <Loader2 size={16} className="animate-spin" /> : <Target size={16} />}
        </button>
      </div>

      {/* Confirm bar — its own flex row now (not absolutely positioned
          over the map), so it always has real space on screen instead
          of floating past the bottom edge of a tall scrolling page. */}
      <div className="shrink-0 bg-white rounded-t-2xl shadow-[0_-6px_20px_rgba(0,0,0,.12)] p-3 flex flex-col gap-2">
        {!pin && <p className="font-sans text-[11.5px] text-[#64748b] text-center">{t('mb.tapMapToPinHint')}</p>}
        <div className="relative">
          <input value={label} onChange={(e) => { labelEditedRef.current = true; setLabel(e.target.value) }} placeholder={t('mb.locationLabelPlaceholder')} className="dp2-input" />
          {reverseLookingUp && <Loader2 size={13} className="absolute top-1/2 -translate-y-1/2 end-3 text-[#94a3b8] animate-spin" />}
        </div>
        {canConfirm && !(savedHome && savedHome.lat === pin?.lat && savedHome.lng === pin?.lng) && (
          <button onClick={saveAsHome} className="w-full flex items-center justify-center gap-1.5 bg-[#D4AF37] text-[#0f172a] rounded-xl py-2 font-sans font-semibold text-[12.5px] cursor-pointer">
            <Bookmark size={13} /> {t('mb.saveAsMyHomeBtn')}
          </button>
        )}
        <button onClick={() => pin && onConfirm({ lat: pin.lat, lng: pin.lng, label: label.trim() })} disabled={!canConfirm}
          className="w-full bg-[#166534] text-white rounded-xl py-3 font-sans font-semibold text-[14px] cursor-pointer disabled:opacity-40">
          {t('mb.confirmLocationBtn')}
        </button>
      </div>
    </div>
  )

  // Portaled straight to <body> — this is a `fixed inset-0` full-screen
  // takeover, and real devices/browsers sometimes have a transformed or
  // containing-block-creating ancestor somewhere up the tree (an
  // animation wrapper, a card with its own stacking context) that would
  // otherwise re-scope "fixed" to that ancestor instead of the real
  // viewport — exactly the bug this caused live: the app's own sticky
  // header kept rendering on top of this picker's floating back/search
  // bar. A portal sidesteps that entirely, the same fix every overlay
  // library reaches for.
  if (!mounted) return null
  const shell: ReactNode = createPortal(
    <>
      {body}
      {locationModalReason && <LocationSettingsModal reason={locationModalReason} onClose={() => setLocationModalReason(null)} />}
    </>,
    document.body
  )

  return shell
}

export function LocationPickerSheet(props: Props) {
  return <LocationPickerBody {...props} />
}
