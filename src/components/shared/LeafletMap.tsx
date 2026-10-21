'use client'

// Free map rendering — OpenStreetMap tiles via Leaflet, no API key, no
// Google Cloud billing account, no possibility of ever being charged.
// Used both for a route's static origin/destination pins and for live
// two-party location tracking on an accepted return trip. Always loaded
// via next/dynamic with ssr:false wherever it's used — Leaflet touches
// `window` at import time and can't run during Next's server render pass.

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { Map as LeafletMapType, Marker } from 'leaflet'
import 'leaflet/dist/leaflet.css'

// `emoji` is additive and optional — a pin with no emoji keeps
// rendering the plain colored dot exactly as before. A pin WITH an
// emoji now matches the original design source's own two marker shapes
// (.design_ref/app_source.jsx's pin()/veh() helpers) exactly: a fixed
// point (pickup, destination, shop, adda) renders as a colored teardrop
// with the emoji upright inside; `isVehicle: true` (a moving driver/
// vehicle marker) renders as veh()'s white circle with a green border
// instead, anchored at its center rather than its bottom point.
//
// `popupHtml`, if set, replaces the plain-text `label` popup with raw
// HTML — used for the adda pins on the Going Home map to show a real
// styled banner (name + distance + a "View board" link) instead of
// Leaflet's bare default popup. It's plain HTML rather than React
// content on purpose: Leaflet manages this DOM itself outside React's
// tree, and a plain <a href="..."> inside it navigates via the browser
// natively — no click-handler wiring back into React needed at all.
export interface MapPin { lat: number; lng: number; label?: string; popupHtml?: string; color?: string; emoji?: string; isVehicle?: boolean }

export interface LeafletMapHandle {
  // Pan/zoom to a pin by its index in the same `pins` array the caller
  // passed in, and open its popup — lets a result-list row "select" its
  // marker on the map without the list needing to know anything about
  // Leaflet internals. Index-based rather than lat/lng-matching since
  // floating point equality across a prop round-trip is fragile.
  focusPin: (index: number, zoom?: number) => void
}

interface Props {
  pins: MapPin[]
  height?: number | string
  zoom?: number
  className?: string
  // Extra fitBounds padding per edge, on top of the base 30px — for a
  // caller with its own floating chrome over the map (a bottom sheet, a
  // top search bar) so pins don't land centered into the area that
  // chrome actually covers. Found the hard way: a rider on the Going
  // Home page couldn't tap an adda pin because it had fitBounds-landed
  // directly underneath the results bottom sheet, which then visibly
  // intercepted the click.
  extraPadding?: { top?: number; right?: number; bottom?: number; left?: number }
  // Where to open the view when `pins` is empty and there's nothing to
  // fitBounds against — e.g. a city's own lat/lng, so a "tap to mark a
  // spot" map opens already looking at the right city instead of all
  // of Pakistan. Ignored once there's at least one real pin.
  center?: [number, number]
  // Turns the map into a point-picker: a click/tap anywhere reports the
  // lat/lng back to the caller, which is expected to re-render with that
  // point added to `pins` (a plain read-only display otherwise stays
  // read-only — every pre-existing caller passes neither of these two
  // props and is completely unaffected).
  onMapClick?: (lat: number, lng: number) => void
  // A real road path to draw between two pins (from OSRM — see
  // `src/lib/roadRoute.ts`) instead of leaving the two markers
  // disconnected. Real gap found live, 2026-10-20: this app never drew
  // an actual route anywhere, which read as "not finding the route" —
  // every caller that now has a real road path passes it here.
  route?: { lat: number; lng: number }[]
}

// Leaflet's default marker icon references image paths relative to its
// own CSS, which breaks under a bundler unless repointed — the standard,
// documented workaround is to point straight at the same version's
// images on a CDN instead of trying to resolve them through webpack.
// Matches .design_ref/app_source.jsx's pin(e, c) exactly: a teardrop
// (classic Google-Maps-style map pin) for a fixed point, anchored at
// its bottom tip so it "points at" the real coordinate.
function teardropIcon(L: typeof import('leaflet'), emoji: string, color?: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color ?? '#166534'};border:3px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);font-size:13px;line-height:1">${emoji}</span></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30],
  })
}

// Matches .design_ref/app_source.jsx's veh(e) exactly: a plain white
// circle with a green border for a moving driver/vehicle marker,
// anchored at its own center (not a bottom point) since it isn't
// "pointing at" a fixed spot the way a pin does.
function vehicleIcon(L: typeof import('leaflet'), emoji: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;border-radius:50%;background:#fff;border:2px solid #166534;box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1">${emoji}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
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

const LeafletMap = forwardRef<LeafletMapHandle, Props>(function LeafletMap({ pins, height = 220, zoom = 12, className = '', extraPadding, center, onMapClick, route }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMapType | null>(null)
  const markersRef = useRef<Marker[]>([])
  const routeLineRef = useRef<import('leaflet').Polyline | null>(null)
  // Always-current ref so the click listener (bound once, at map
  // creation) never goes stale when the caller passes a fresh closure
  // each render — the map itself is only ever built once per mount.
  const onMapClickRef = useRef(onMapClick)
  useEffect(() => { onMapClickRef.current = onMapClick })

  useImperativeHandle(ref, () => ({
    focusPin: (index, focusZoom) => {
      const map = mapRef.current
      const marker = markersRef.current[index]
      if (!map || !marker) return
      map.setView(marker.getLatLng(), focusZoom ?? Math.max(map.getZoom(), 14))
      marker.openPopup()
    },
  }), [])

  useEffect(() => {
    let cancelled = false
    import('leaflet').then((L) => {
      if (cancelled || !containerRef.current) return
      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, { attributionControl: true })
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19, attribution: 'Tiles © Esri',
        }).addTo(mapRef.current)
        mapRef.current.on('click', (e) => onMapClickRef.current?.(e.latlng.lat, e.latlng.lng))
      }
      const map = mapRef.current
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      routeLineRef.current?.remove()
      routeLineRef.current = null

      if (route && route.length > 1) {
        routeLineRef.current = L.polyline(route.map((p) => [p.lat, p.lng]), { color: '#166534', weight: 4, opacity: 0.85 }).addTo(map)
      }

      if (pins.length === 0 && !route?.length) { map.setView(center ?? [30.3753, 69.3451], center ? zoom : 5); return } // Pakistan-wide fallback, or a given center
      pins.forEach((p) => {
        const marker = L.marker([p.lat, p.lng], { icon: p.emoji ? (p.isVehicle ? vehicleIcon(L, p.emoji) : teardropIcon(L, p.emoji, p.color)) : coloredIcon(L, p.color) }).addTo(map)
        if (p.popupHtml) marker.bindPopup(p.popupHtml, { minWidth: 180 })
        else if (p.label) marker.bindPopup(p.label)
        markersRef.current.push(marker)
      })
      const boundsPoints = [...pins.map((p) => [p.lat, p.lng] as [number, number]), ...(route ?? []).map((p) => [p.lat, p.lng] as [number, number])]
      if (boundsPoints.length === 1) map.setView(boundsPoints[0], zoom)
      else if (boundsPoints.length > 1) map.fitBounds(boundsPoints, {
        paddingTopLeft: [30 + (extraPadding?.left ?? 0), 30 + (extraPadding?.top ?? 0)],
        paddingBottomRight: [30 + (extraPadding?.right ?? 0), 30 + (extraPadding?.bottom ?? 0)],
      })

      // A full-bleed map container's real pixel size can settle a frame
      // or two after Leaflet's own init measurement (a flex/grid layout
      // resolving, a bottom sheet animating) — without this the tile
      // grid can be born wrong-sized and show grey gaps until the next
      // manual interaction.
      setTimeout(() => map.invalidateSize(), 100)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pins), JSON.stringify(route)])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  // Real ask, 2026-10-21: "almost on all pages where map is displaying
  // its displaying over all the popups" — Leaflet's own internal panes
  // (tiles, markers, popups, controls) use very high z-index values
  // that escape a normal CSS stacking context, so the map rendered
  // above a bottom sheet/modal's overlay (z-[100]+) no matter how high
  // that overlay's own z-index was set. `isolate` (CSS `isolation:
  // isolate`) traps Leaflet's panes inside their own stacking context
  // rooted at this div, so nothing it draws can ever escape above
  // whatever a caller stacks on top of it. Previously only applied
  // ad-hoc on one caller (LocationPickerSheet) instead of here, in the
  // one shared component every map in the app actually renders through
  // — every other page still had the bug.
  return <div ref={containerRef} className={`overflow-hidden isolate ${className}`} style={{ height }} />
})

export default LeafletMap
