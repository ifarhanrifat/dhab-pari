'use client'

// A pin fixed at the screen's center, map slides underneath it — the same
// "confirm your location" pattern ride-hailing/maps apps use (Careem,
// Uber, Google Maps' address picker), swapped in for the old tap-to-drop
// picker. Tap-to-place asks for a precise single tap to land exactly on
// the right spot, which is fiddly on a small phone screen and especially
// hard for a rider trying to mark their own position on foot; dragging
// the map under a pin that never moves lets you pan and pinch-zoom your
// way to the exact spot instead, then read the result straight off the
// pin's fixed position.
//
// The pin itself is a plain absolutely-positioned DOM element overlaid on
// the map container, not a Leaflet marker — it never needs to be added/
// removed/repositioned as a Leaflet object since it visually never moves;
// only the map underneath it does. onChange fires from the map's own
// 'move' event (continuously, so the little floating banner discussed in
// the caller UI can track live) — not just 'moveend' — for a real-time
// feel while dragging.

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMapType } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Props {
  lat: number | null
  lng: number | null
  onChange: (pin: { lat: number; lng: number } | null) => void
}

export default function LeafletSinglePinPicker({ lat, lng, onChange }: Props) {
  const { t } = useLocale()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMapType | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [dragging, setDragging] = useState(false)
  const [hasMoved, setHasMoved] = useState(lat != null && lng != null)

  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      // center/zoom passed as constructor options, not a follow-up
      // .setView() call — the latter fires 'move'/'moveend' immediately,
      // which would wrongly report the Pakistan-wide default center as a
      // genuine user pick before any real interaction happened.
      const map = L.map(containerRef.current, { center: lat && lng ? [lat, lng] : [30.3753, 69.3451], zoom: lat && lng ? 15 : 5 })
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map)

      const emitCenter = () => {
        const c = map.getCenter()
        onChangeRef.current({ lat: c.lat, lng: c.lng })
      }
      map.on('movestart', () => setDragging(true))
      map.on('move', emitCenter)
      map.on('moveend', () => { setDragging(false); setHasMoved(true); emitCenter() })

      mapRef.current = map
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  const clearPin = () => {
    setHasMoved(false)
    onChange(null)
    mapRef.current?.setView([30.3753, 69.3451], 5)
  }

  return (
    <div>
      <div className="relative rounded-lg overflow-hidden border border-dp-outline-variant" style={{ height: 260 }}>
        <div ref={containerRef} className="w-full h-full" />
        {/* The fixed pin — never moves; the map pans underneath it. A tiny
            lift-and-drop motion while dragging (translateY + a shrinking
            shadow) is the same visual cue those ride-hailing apps use to
            read as "this pin is picking a spot," not "this is decoration." */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-[500]" style={{ marginTop: -18 }}>
          <div className={`transition-transform duration-150 ${dragging ? '-translate-y-2' : 'translate-y-0'}`}>
            <svg width="34" height="42" viewBox="0 0 34 42" fill="none">
              <path d="M17 0C7.6 0 0 7.6 0 17c0 12.75 17 25 17 25s17-12.25 17-25C34 7.6 26.4 0 17 0z" fill="#2563eb" />
              <circle cx="17" cy="17" r="6.5" fill="white" />
            </svg>
          </div>
          <div className={`absolute rounded-full bg-black/25 transition-all duration-150 ${dragging ? 'w-2.5 h-1 opacity-40' : 'w-4 h-1.5 opacity-60'}`} style={{ marginTop: 44 }} />
        </div>
      </div>
      <div className="flex items-center justify-between mt-2">
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{hasMoved ? t('cm.dragMapHint') : t('cm.panToStartHint')}</p>
        <button type="button" onClick={clearPin} disabled={!hasMoved}
          className="text-[12px] font-sans font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer disabled:opacity-40">
          ● {t('cm.clearPin')}
        </button>
      </div>
    </div>
  )
}
