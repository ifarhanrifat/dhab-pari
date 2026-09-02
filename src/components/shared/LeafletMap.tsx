'use client'

// Free map rendering — OpenStreetMap tiles via Leaflet, no API key, no
// Google Cloud billing account, no possibility of ever being charged.
// Used both for a route's static origin/destination pins and for live
// two-party location tracking on an accepted return trip. Always loaded
// via next/dynamic with ssr:false wherever it's used — Leaflet touches
// `window` at import time and can't run during Next's server render pass.

import { useEffect, useRef } from 'react'
import type { Map as LeafletMapType, Marker } from 'leaflet'
import 'leaflet/dist/leaflet.css'

// `emoji` is additive and optional — every existing caller (route pins,
// two-party trip tracking) keeps rendering the plain colored dot exactly
// as before; only a pin that opts in with `emoji` gets the bigger
// vehicle-style marker (used by the nearby-open-trips live map).
export interface MapPin { lat: number; lng: number; label?: string; color?: string; emoji?: string }

interface Props {
  pins: MapPin[]
  height?: number
  zoom?: number
  className?: string
}

// Leaflet's default marker icon references image paths relative to its
// own CSS, which breaks under a bundler unless repointed — the standard,
// documented workaround is to point straight at the same version's
// images on a CDN instead of trying to resolve them through webpack.
function emojiIcon(L: typeof import('leaflet'), emoji: string, color?: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${color ?? '#16a34a'};border:3px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1">${emoji}</div>`,
    iconSize: [34, 34], iconAnchor: [17, 17],
  })
}

function coloredIcon(L: typeof import('leaflet'), color?: string) {
  if (!color) {
    return L.icon({
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
    })
  }
  return L.divIcon({
    className: '', html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  })
}

export default function LeafletMap({ pins, height = 220, zoom = 12, className = '' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMapType | null>(null)
  const markersRef = useRef<Marker[]>([])

  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current) return
      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, { attributionControl: true })
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '© OpenStreetMap contributors',
        }).addTo(mapRef.current)
      }
      const map = mapRef.current
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []

      if (pins.length === 0) { map.setView([30.3753, 69.3451], 5); return } // Pakistan-wide fallback
      pins.forEach((p) => {
        const marker = L.marker([p.lat, p.lng], { icon: p.emoji ? emojiIcon(L, p.emoji, p.color) : coloredIcon(L, p.color) }).addTo(map)
        if (p.label) marker.bindPopup(p.label)
        markersRef.current.push(marker)
      })
      if (pins.length === 1) map.setView([pins[0].lat, pins[0].lng], zoom)
      else map.fitBounds(pins.map((p) => [p.lat, p.lng] as [number, number]), { padding: [30, 30] })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pins)])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  return <div ref={containerRef} className={`rounded-lg overflow-hidden ${className}`} style={{ height }} />
}
