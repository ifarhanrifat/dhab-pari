'use client'

// Real report, 2026-09-30: the Windy iframe embed had a menu/sidebar panel
// that couldn't be closed — an inherent limit of their free embed widget,
// not something controllable via query params. Replaced with our own
// Leaflet map (same library + pattern as LeafletMap.tsx, used all over
// this app already) plus a RainViewer radar tile overlay — free, no API
// key, and since we own every pixel of the UI, there's no foreign panel
// that can get stuck open.
import { useEffect, useRef } from 'react'
import 'leaflet/dist/leaflet.css'

interface Props {
  lat: number
  lng: number
  height?: number | string
  className?: string
}

export function WeatherRadarMap({ lat, lng, height = 320, className = '' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<import('leaflet').Map | null>(null)

  useEffect(() => {
    let cancelled = false
    import('leaflet').then(async (L) => {
      if (cancelled || !containerRef.current) return
      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, { attributionControl: true })
      }
      const map = mapRef.current
      map.setView([lat, lng], 8)
      map.eachLayer((layer) => map.removeLayer(layer))

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap contributors',
      }).addTo(map)

      L.circleMarker([lat, lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#0284c7', fillOpacity: 1 }).addTo(map)

      // Latest available radar frame — RainViewer's own public, keyless API.
      try {
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json')
        const data = await res.json()
        const frame = data?.radar?.past?.at(-1)
        if (frame && !cancelled) {
          L.tileLayer(`https://tilecache.rainviewer.com/v2/radar/${frame.time}/256/{z}/{x}/{y}/2/1_1.png`, {
            opacity: 0.6, maxZoom: 12,
          }).addTo(map)
        }
      } catch {
        // Radar overlay is a nice-to-have — the base map still works fine
        // without it if RainViewer's API is ever unreachable.
      }

      setTimeout(() => map.invalidateSize(), 100)
    })
    return () => { cancelled = true }
  }, [lat, lng])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  return <div ref={containerRef} className={`overflow-hidden ${className}`} style={{ height }} />
}
