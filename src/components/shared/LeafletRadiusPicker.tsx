'use client'

// The platform fleet-zone editor (750, extended 754). Two ways to mark
// a territory: the original fixed-pin-while-the-map-pans-underneath
// circle (radius in real kilometres, not a fixed-pixel dot), or —
// real ask, 2026-10-28, "i can draw a manually zone around the village
// with dots" — tap-to-drop-points boundary tracing for a real,
// irregular shape instead of a rough circle approximation. Also real
// asks from the same message: a satellite layer toggle (street-map
// tiles alone don't show enough to place a village precisely) and a
// name search (city list first, OpenStreetMap's free Nominatim for
// anything else — no API key, same no-billing posture every map in
// this app already keeps). Every OTHER tenant's already-drawn zone
// still renders read-only underneath, so the super-admin can see
// overlaps with a neighbouring village while drawing this one.

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMapType, Circle, CircleMarker, Polyline, Polygon, TileLayer } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Search, Satellite, Map as MapIcon, Undo2, Trash2 } from 'lucide-react'

export interface OtherZone { lat: number; lng: number; radiusKm: number; areaType?: 'circle' | 'polygon'; points?: { lat: number; lng: number }[]; color?: string; label?: string }
export interface CityOption { id: string; name: string; lat: number | null; lng: number | null }
export type ZonePoint = { lat: number; lng: number }

const STREET_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

interface Props {
  lat: number | null
  lng: number | null
  radiusKm: number
  areaType: 'circle' | 'polygon'
  points: ZonePoint[]
  otherZones?: OtherZone[]
  cities?: CityOption[]
  onChange: (pin: { lat: number; lng: number }) => void
  onRadiusChange: (radiusKm: number) => void
  onAreaTypeChange: (areaType: 'circle' | 'polygon') => void
  onPointsChange: (points: ZonePoint[]) => void
}

export default function LeafletRadiusPicker({ lat, lng, radiusKm, areaType, points, otherZones, cities, onChange, onRadiusChange, onAreaTypeChange, onPointsChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMapType | null>(null)
  const tileLayerRef = useRef<TileLayer | null>(null)
  const circleRef = useRef<Circle | null>(null)
  const otherShapesRef = useRef<(Circle | Polygon)[]>([])
  const vertexMarkersRef = useRef<CircleMarker[]>([])
  const vertexLineRef = useRef<Polyline | null>(null)
  const vertexPolygonRef = useRef<Polygon | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const pointsRef = useRef(points)
  pointsRef.current = points
  const onPointsChangeRef = useRef(onPointsChange)
  onPointsChangeRef.current = onPointsChange
  const areaTypeRef = useRef(areaType)
  areaTypeRef.current = areaType

  const [dragging, setDragging] = useState(false)
  const [satellite, setSatellite] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)

  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const map = L.map(containerRef.current, { center: lat && lng ? [lat, lng] : [32.9, 72.85], zoom: lat && lng ? 12 : 7 })
      tileLayerRef.current = L.tileLayer(STREET_TILES, { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map)

      circleRef.current = L.circle(map.getCenter(), { radius: radiusKm * 1000, color: '#166534', weight: 2, fillOpacity: 0.15 }).addTo(map)

      const emitCenter = () => {
        if (areaTypeRef.current !== 'circle') return
        const c = map.getCenter()
        circleRef.current?.setLatLng(c)
        onChangeRef.current({ lat: c.lat, lng: c.lng })
      }
      map.on('movestart', () => setDragging(true))
      map.on('move', emitCenter)
      map.on('moveend', () => { setDragging(false); emitCenter() })

      // Polygon mode only — each tap drops the next vertex. Ignored
      // entirely in circle mode (that mode reads the fixed center pin
      // instead), so the same map instance serves both without needing
      // two Leaflet maps.
      map.on('click', (e) => {
        if (areaTypeRef.current !== 'polygon') return
        onPointsChangeRef.current([...pointsRef.current, { lat: e.latlng.lat, lng: e.latlng.lng }])
      })

      mapRef.current = map
      setTimeout(() => map.invalidateSize(), 100)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Satellite/street toggle — swap the one tile layer in place rather
  // than tearing down the whole map.
  useEffect(() => {
    if (!mapRef.current) return
    import('leaflet').then((L) => {
      if (!mapRef.current) return
      tileLayerRef.current?.remove()
      tileLayerRef.current = L.tileLayer(satellite ? SATELLITE_TILES : STREET_TILES, { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(mapRef.current)
    })
  }, [satellite])

  // Radius changes (slider) redraw this zone's own circle without
  // waiting for a map move. Circle layer itself only shows in circle mode.
  useEffect(() => {
    circleRef.current?.setRadius(radiusKm * 1000)
    circleRef.current?.setStyle({ opacity: areaType === 'circle' ? 1 : 0, fillOpacity: areaType === 'circle' ? 0.15 : 0 })
  }, [radiusKm, areaType])

  // Draw the in-progress polygon (vertex dots + connecting line +
  // translucent fill once closed) every time the point list changes.
  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !mapRef.current) return
      vertexMarkersRef.current.forEach((m) => m.remove()); vertexMarkersRef.current = []
      vertexLineRef.current?.remove(); vertexLineRef.current = null
      vertexPolygonRef.current?.remove(); vertexPolygonRef.current = null
      if (areaType !== 'polygon') return

      points.forEach((p) => {
        vertexMarkersRef.current.push(L.circleMarker([p.lat, p.lng], { radius: 6, color: '#166534', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(mapRef.current!))
      })
      if (points.length >= 2) {
        vertexLineRef.current = L.polyline(points.map((p) => [p.lat, p.lng]), { color: '#166534', weight: 2, dashArray: points.length >= 3 ? undefined : '4,4' }).addTo(mapRef.current)
      }
      if (points.length >= 3) {
        vertexPolygonRef.current = L.polygon(points.map((p) => [p.lat, p.lng]), { color: '#166534', weight: 2, fillOpacity: 0.15 }).addTo(mapRef.current)
      }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(points), areaType])

  // Other tenants' zones — static context layer, rebuilt whenever the
  // list itself changes (not on every drag/radius/point tick).
  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !mapRef.current) return
      otherShapesRef.current.forEach((s) => s.remove())
      otherShapesRef.current = (otherZones ?? []).map((z) => {
        const shape = z.areaType === 'polygon' && z.points && z.points.length >= 3
          ? L.polygon(z.points.map((p) => [p.lat, p.lng]), { color: z.color ?? '#94a3b8', weight: 1.5, dashArray: '5,5', fillOpacity: 0.05 }).addTo(mapRef.current!)
          : L.circle([z.lat, z.lng], { radius: z.radiusKm * 1000, color: z.color ?? '#94a3b8', weight: 1.5, dashArray: '5,5', fillOpacity: 0.05 }).addTo(mapRef.current!)
        if (z.label) shape.bindTooltip(z.label)
        return shape
      })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(otherZones)])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  const runSearch = async () => {
    const q = query.trim()
    if (!q || !mapRef.current) return
    setSearchError(false)
    const local = (cities ?? []).find((c) => c.lat != null && c.lng != null && c.name.toLowerCase().includes(q.toLowerCase()))
    if (local) { mapRef.current.setView([local.lat!, local.lng!], 14); return }
    setSearching(true)
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pk&q=${encodeURIComponent(q)}`)
      const results = await res.json()
      if (results?.[0]) mapRef.current.setView([Number(results[0].lat), Number(results[0].lon)], 14)
      else setSearchError(true)
    } catch { setSearchError(true) } finally { setSearching(false) }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={() => onAreaTypeChange('circle')}
          className="flex-1 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer border"
          style={{ background: areaType === 'circle' ? '#166534' : '#fff', color: areaType === 'circle' ? '#fff' : '#1e293b', borderColor: areaType === 'circle' ? '#166534' : '#e2e8f0' }}>
          Circle (radius)
        </button>
        <button type="button" onClick={() => onAreaTypeChange('polygon')}
          className="flex-1 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer border"
          style={{ background: areaType === 'polygon' ? '#166534' : '#fff', color: areaType === 'polygon' ? '#fff' : '#1e293b', borderColor: areaType === 'polygon' ? '#166534' : '#e2e8f0' }}>
          Draw boundary
        </button>
      </div>

      <div className="flex items-center gap-1.5 mb-2">
        <input
          type="text" value={query} onChange={(e) => { setQuery(e.target.value); setSearchError(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch() } }}
          placeholder="Search a city or village name..."
          className="flex-1 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] focus:border-dp-secondary focus:ring-0"
        />
        <button type="button" onClick={runSearch} disabled={searching || !query.trim()}
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-[#1a1f2e] text-white cursor-pointer disabled:opacity-40">
          <Search size={15} />
        </button>
      </div>
      {searchError && <p className="font-sans text-[11.5px] text-dp-error -mt-1 mb-2">No match found — try panning the map by hand instead.</p>}

      <div className="relative rounded-lg overflow-hidden isolate border border-dp-outline-variant" style={{ height: 320 }}>
        <div ref={containerRef} className="w-full h-full" />

        <button type="button" onClick={() => setSatellite((s) => !s)}
          className="absolute top-2 end-2 z-[500] w-9 h-9 flex items-center justify-center rounded-lg bg-white shadow cursor-pointer text-dp-on-surface">
          {satellite ? <MapIcon size={16} /> : <Satellite size={16} />}
        </button>

        {areaType === 'circle' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-[500]" style={{ marginTop: -18 }}>
            <div className={`transition-transform duration-150 ${dragging ? '-translate-y-2' : 'translate-y-0'}`}>
              <svg width="28" height="34" viewBox="0 0 34 42" fill="none">
                <path d="M17 0C7.6 0 0 7.6 0 17c0 12.75 17 25 17 25s17-12.25 17-25C34 7.6 26.4 0 17 0z" fill="#166534" />
                <circle cx="17" cy="17" r="6.5" fill="white" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {areaType === 'circle' ? (
        <>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">Pan the map to move the zone's center — the dashed grey shapes are other tenants' existing zones.</p>
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1">
              <label className="text-[13px] font-semibold text-dp-on-surface-variant font-sans">Radius</label>
              <span className="text-[13px] font-bold text-dp-on-surface font-sans">{radiusKm} km</span>
            </div>
            <input
              type="range" min={1} max={60} step={1} value={radiusKm}
              onChange={(e) => onRadiusChange(Number(e.target.value))}
              className="w-full cursor-pointer"
            />
          </div>
        </>
      ) : (
        <>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">
            Tap the map to drop points around the real boundary ({points.length} so far{points.length < 3 ? ', need at least 3' : ''}) — the dashed grey shapes are other tenants' existing zones.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button type="button" onClick={() => onPointsChange(points.slice(0, -1))} disabled={points.length === 0}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dp-outline-variant text-[12.5px] font-sans font-semibold cursor-pointer disabled:opacity-40">
              <Undo2 size={14} /> Undo last point
            </button>
            <button type="button" onClick={() => onPointsChange([])} disabled={points.length === 0}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dp-outline-variant text-dp-error text-[12.5px] font-sans font-semibold cursor-pointer disabled:opacity-40">
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </>
      )}
    </div>
  )
}
