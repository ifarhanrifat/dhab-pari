'use client'

// One-pin version of LeafletPinPicker — an adda is a single physical
// stand, not an origin+destination pair, so it needs its own click-to-set
// picker rather than trying to bend the two-pin component (whose click
// handler *is* an origin-then-destination sequence) into a shape it
// wasn't built for.

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMapType, Marker } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Props {
  lat: number | null
  lng: number | null
  onChange: (pin: { lat: number; lng: number } | null) => void
}

function dotIcon(L: typeof import('leaflet'), color: string) {
  return L.divIcon({
    className: '', html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  })
}

export default function LeafletSinglePinPicker({ lat, lng, onChange }: Props) {
  const { t } = useLocale()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMapType | null>(null)
  const marker = useRef<Marker | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const map = L.map(containerRef.current).setView(lat && lng ? [lat, lng] : [30.3753, 69.3451], lat && lng ? 13 : 5)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map)
      map.on('click', (e: { latlng: { lat: number; lng: number } }) => onChange({ lat: e.latlng.lat, lng: e.latlng.lng }))
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
      marker.current?.remove(); marker.current = null
      if (lat != null && lng != null) {
        marker.current = L.marker([lat, lng], { icon: dotIcon(L, '#2563eb') }).addTo(map)
        map.setView([lat, lng], map.getZoom() < 10 ? 13 : map.getZoom())
      }
    })
  }, [ready, lat, lng])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  return (
    <div>
      <div ref={containerRef} className="rounded-lg overflow-hidden border border-dp-outline-variant" style={{ height: 220 }} />
      <button type="button" onClick={() => onChange(null)} disabled={lat == null}
        className="mt-2 text-[12px] font-sans font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer disabled:opacity-40">
        ● {t('cm.clearPin')}
      </button>
    </div>
  )
}
