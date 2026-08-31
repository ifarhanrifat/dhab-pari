'use client'

// Admin sets a route's two map pins by clicking a free OpenStreetMap —
// no geocoding service, no typing coordinates by hand. Click once for
// origin (green), again for destination (red); click either existing pin
// again to clear and redo it.

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMapType, Marker } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Props {
  originLat: number | null; originLng: number | null
  destinationLat: number | null; destinationLng: number | null
  onChange: (pins: { originLat: number | null; originLng: number | null; destinationLat: number | null; destinationLng: number | null }) => void
}

function dotIcon(L: typeof import('leaflet'), color: string) {
  return L.divIcon({
    className: '', html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  })
}

export default function LeafletPinPicker({ originLat, originLng, destinationLat, destinationLng, onChange }: Props) {
  const { t } = useLocale()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMapType | null>(null)
  const originMarker = useRef<Marker | null>(null)
  const destMarker = useRef<Marker | null>(null)
  const [ready, setReady] = useState(false)
  const stateRef = useRef({ originLat, originLng, destinationLat, destinationLng })
  stateRef.current = { originLat, originLng, destinationLat, destinationLng }

  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const map = L.map(containerRef.current).setView(
        originLat && originLng ? [originLat, originLng] : [30.3753, 69.3451],
        originLat && originLng ? 12 : 5,
      )
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map)
      map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
        const s = stateRef.current
        if (s.originLat == null) {
          onChange({ ...s, originLat: e.latlng.lat, originLng: e.latlng.lng })
        } else if (s.destinationLat == null) {
          onChange({ ...s, destinationLat: e.latlng.lat, destinationLng: e.latlng.lng })
        }
        // Both already set — ignore further clicks; use the clear buttons below the map instead of guessing intent.
      })
      mapRef.current = map
      setReady(true)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready || !mapRef.current) return
    import('leaflet').then((L) => {
      const map = mapRef.current!
      originMarker.current?.remove(); originMarker.current = null
      destMarker.current?.remove(); destMarker.current = null
      if (originLat != null && originLng != null) originMarker.current = L.marker([originLat, originLng], { icon: dotIcon(L, '#16a34a') }).addTo(map)
      if (destinationLat != null && destinationLng != null) destMarker.current = L.marker([destinationLat, destinationLng], { icon: dotIcon(L, '#dc2626') }).addTo(map)
      const pts: [number, number][] = []
      if (originLat != null && originLng != null) pts.push([originLat, originLng])
      if (destinationLat != null && destinationLng != null) pts.push([destinationLat, destinationLng])
      if (pts.length === 2) map.fitBounds(pts, { padding: [40, 40] })
    })
  }, [ready, originLat, originLng, destinationLat, destinationLng])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  return (
    <div>
      <div ref={containerRef} className="rounded-lg overflow-hidden border border-dp-outline-variant" style={{ height: 220 }} />
      <div className="flex items-center gap-3 mt-2">
        <button type="button" onClick={() => onChange({ originLat: null, originLng: null, destinationLat, destinationLng })}
          className="text-[12px] font-sans font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer disabled:opacity-40" disabled={originLat == null}>
          ● {t('cm.clearOriginPin')}
        </button>
        <button type="button" onClick={() => onChange({ originLat, originLng, destinationLat: null, destinationLng: null })}
          className="text-[12px] font-sans font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer disabled:opacity-40" disabled={destinationLat == null}>
          ● {t('cm.clearDestinationPin')}
        </button>
      </div>
    </div>
  )
}
