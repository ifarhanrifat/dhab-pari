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

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Target, Loader2, Search } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { getCurrentPositionOnce, classifyLocationError, type LocationErrorReason } from '@/hooks/useLiveLocation'
import { LocationSettingsModal } from '@/components/portal/LocationSettingsModal'

export interface PickedLocation { lat: number; lng: number; label: string }

interface Props {
  title: string
  initial?: { lat: number; lng: number; label?: string } | null
  defaultCenter?: [number, number]
  onConfirm: (loc: PickedLocation) => void
  onClose: () => void
}

interface SearchResult { lat: number; lng: number; displayName: string }

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

// Nominatim (OpenStreetMap's free geocoder, same no-API-key/no-billing
// ecosystem the map tiles and OSRM routing already use elsewhere in
// this app) — a descriptive User-Agent header is its own usage policy's
// one real requirement.
async function nominatimSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&countrycodes=pk`, {
    headers: { 'Accept-Language': 'en,ur' },
  })
  if (!res.ok) return []
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>
  return data.map((d) => ({ lat: parseFloat(d.lat), lng: parseFloat(d.lon), displayName: d.display_name }))
}
async function nominatimReverse(lat: number, lng: number): Promise<string | null> {
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16`, {
    headers: { 'Accept-Language': 'en,ur' },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { display_name?: string }
  return data.display_name ?? null
}

export function LocationPickerSheet({ title, initial, defaultCenter, onConfirm, onClose }: Props) {
  const { t } = useLocale()
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(initial ? { lat: initial.lat, lng: initial.lng } : null)
  const [label, setLabel] = useState(initial?.label ?? '')
  const [locating, setLocating] = useState(false)
  const [locationModalReason, setLocationModalReason] = useState<Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'> | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [reverseLookingUp, setReverseLookingUp] = useState(false)
  const labelEditedRef = useRef(false)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) { setResults([]); return }
    setSearching(true)
    const handle = setTimeout(() => {
      nominatimSearch(q).then(setResults).catch(() => setResults([])).finally(() => setSearching(false))
    }, 400)
    return () => clearTimeout(handle)
  }, [query])

  const setPinAndReverseGeocode = (lat: number, lng: number) => {
    setPin({ lat, lng })
    labelEditedRef.current = false
    setReverseLookingUp(true)
    nominatimReverse(lat, lng).then((name) => {
      if (name && !labelEditedRef.current) setLabel(name)
    }).finally(() => setReverseLookingUp(false))
  }

  const pickSearchResult = (r: SearchResult) => {
    setPin({ lat: r.lat, lng: r.lng })
    labelEditedRef.current = true
    setLabel(r.displayName)
    setQuery(''); setResults([])
  }

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

  return (
    <>
      <MobilityBottomSheet title={title} onClose={onClose}>
        <div className="flex flex-col gap-2.5">
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#94a3b8]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('mb.searchLocationPlaceholder')} className="dp2-input ps-9" />
            {searching && <Loader2 size={13} className="absolute top-1/2 -translate-y-1/2 end-3 text-[#94a3b8] animate-spin" />}
            {results.length > 0 && (
              <div className="absolute z-10 top-full mt-1 inset-x-0 border border-[#e5e2d0] rounded-xl overflow-hidden bg-white shadow-lg max-h-[180px] overflow-y-auto">
                {results.map((r, i) => (
                  <button key={i} type="button" onClick={() => pickSearchResult(r)} className="w-full text-start px-3 py-2 font-sans text-[12.5px] cursor-pointer hover:bg-[#F9F9F6] border-b border-[#f1f5f9] last:border-0">
                    {r.displayName}
                  </button>
                ))}
              </div>
            )}
          </div>
          <LeafletMap
            pins={pin ? [{ lat: pin.lat, lng: pin.lng, color: '#166534' }] : []}
            center={defaultCenter}
            height={240}
            zoom={14}
            className="rounded-xl border border-[#e5e2d0]"
            onMapClick={(lat, lng) => setPinAndReverseGeocode(lat, lng)}
          />
          <button onClick={useGps} disabled={locating} className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-[#e5e2d0] text-[#166534] font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
            {locating ? <Loader2 size={13} className="animate-spin" /> : <Target size={13} />} {t('mb.useMyLocationBtn')}
          </button>
          <p className="font-sans text-[11.5px] text-[#64748b] text-center -mt-1">{t('mb.tapMapToPinHint')}</p>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mb.locationLabelField')}</label>
            <div className="relative">
              <input value={label} onChange={(e) => { labelEditedRef.current = true; setLabel(e.target.value) }} placeholder={t('mb.locationLabelPlaceholder')} className="dp2-input" />
              {reverseLookingUp && <Loader2 size={13} className="absolute top-1/2 -translate-y-1/2 end-3 text-[#94a3b8] animate-spin" />}
            </div>
          </div>
          <button onClick={() => pin && onConfirm({ lat: pin.lat, lng: pin.lng, label: label.trim() })} disabled={!canConfirm}
            className="w-full bg-[#166534] text-white rounded-xl py-3 font-sans font-semibold text-[14px] cursor-pointer disabled:opacity-40">
            {t('mb.confirmLocationBtn')}
          </button>
        </div>
      </MobilityBottomSheet>
      {locationModalReason && <LocationSettingsModal reason={locationModalReason} onClose={() => setLocationModalReason(null)} />}
    </>
  )
}
