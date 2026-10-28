'use client'

// The platform fleet-zone editor (750): same fixed-pin-while-the-map-
// pans-underneath interaction LeafletSinglePinPicker already proved
// out, plus a real-scale circle (drawn in actual kilometres, not a
// fixed-pixel dot) that grows/shrinks live with the radius slider —
// and, read-only, every OTHER tenant's already-drawn zone, so the
// super-admin can see overlaps with a neighbouring village while
// still drawing this one, which is the whole reason this lives at the
// platform level instead of on each tenant's own admin screen.

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMapType, Circle } from 'leaflet'
import 'leaflet/dist/leaflet.css'

export interface OtherZone { lat: number; lng: number; radiusKm: number; color?: string; label?: string }

interface Props {
  lat: number | null
  lng: number | null
  radiusKm: number
  otherZones?: OtherZone[]
  onChange: (pin: { lat: number; lng: number }) => void
  onRadiusChange: (radiusKm: number) => void
}

export default function LeafletRadiusPicker({ lat, lng, radiusKm, otherZones, onChange, onRadiusChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMapType | null>(null)
  const circleRef = useRef<Circle | null>(null)
  const otherCirclesRef = useRef<Circle[]>([])
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const map = L.map(containerRef.current, { center: lat && lng ? [lat, lng] : [32.9, 72.85], zoom: lat && lng ? 12 : 7 })
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map)

      circleRef.current = L.circle(map.getCenter(), { radius: radiusKm * 1000, color: '#166534', weight: 2, fillOpacity: 0.15 }).addTo(map)

      const emitCenter = () => {
        const c = map.getCenter()
        circleRef.current?.setLatLng(c)
        onChangeRef.current({ lat: c.lat, lng: c.lng })
      }
      map.on('movestart', () => setDragging(true))
      map.on('move', emitCenter)
      map.on('moveend', () => { setDragging(false); emitCenter() })

      mapRef.current = map
      setTimeout(() => map.invalidateSize(), 100)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Radius changes (slider) redraw this zone's own circle without
  // waiting for a map move.
  useEffect(() => { circleRef.current?.setRadius(radiusKm * 1000) }, [radiusKm])

  // Other tenants' zones — static context layer, rebuilt whenever the
  // list itself changes (not on every drag/radius tick).
  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !mapRef.current) return
      otherCirclesRef.current.forEach((c) => c.remove())
      otherCirclesRef.current = (otherZones ?? []).map((z) => {
        const c = L.circle([z.lat, z.lng], { radius: z.radiusKm * 1000, color: z.color ?? '#94a3b8', weight: 1.5, dashArray: '5,5', fillOpacity: 0.05 }).addTo(mapRef.current!)
        if (z.label) c.bindTooltip(z.label)
        return c
      })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(otherZones)])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  return (
    <div>
      <div className="relative rounded-lg overflow-hidden isolate border border-dp-outline-variant" style={{ height: 300 }}>
        <div ref={containerRef} className="w-full h-full" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-[500]" style={{ marginTop: -18 }}>
          <div className={`transition-transform duration-150 ${dragging ? '-translate-y-2' : 'translate-y-0'}`}>
            <svg width="28" height="34" viewBox="0 0 34 42" fill="none">
              <path d="M17 0C7.6 0 0 7.6 0 17c0 12.75 17 25 17 25s17-12.25 17-25C34 7.6 26.4 0 17 0z" fill="#166534" />
              <circle cx="17" cy="17" r="6.5" fill="white" />
            </svg>
          </div>
        </div>
      </div>
      <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">Pan the map to move the zone's center — the dashed grey circles are other tenants' existing zones.</p>
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
    </div>
  )
}
