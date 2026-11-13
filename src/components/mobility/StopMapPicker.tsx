'use client'

// 875: the last deferred piece of the ticketing redesign — real spec
// given live: "the same selected bus will present all the routes and
// stops there and now booking officer will click on the position from
// where rider want to enter". Every stop picker in the app before this
// was a plain <select> dropdown (RouteDetailPanel.tsx) — this is the
// first map-click version, built for the counter officer's boarding-stop
// choice specifically.
//
// LeafletMap has no per-pin click callback (only a whole-map
// onMapClick(lat,lng), built for free-point picking) — extending that
// API would touch every existing caller, so instead this snaps a click
// to the nearest stop pin within a real tolerance (300m), which matches
// "click the exact position" without any LeafletMap changes at all.

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

export interface PickableStop { id: string; label: string; label_ur: string | null; lat: number; lng: number }

const SNAP_TOLERANCE_KM = 0.3

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371
  const dLat = (bLat - aLat) * Math.PI / 180
  const dLng = (bLng - aLng) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(s))
}

interface Props {
  stops: PickableStop[]
  value: string | null
  onChange: (stopId: string | null) => void
  originLabel: string
  onClose: () => void
}

export function StopMapPicker({ stops, value, onChange, originLabel, onClose }: Props) {
  const { t, isUrdu } = useLocale()
  const [missTap, setMissTap] = useState(false)

  const handleMapClick = (lat: number, lng: number) => {
    let nearest: PickableStop | null = null
    let nearestKm = Infinity
    for (const s of stops) {
      const d = haversineKm(lat, lng, s.lat, s.lng)
      if (d < nearestKm) { nearestKm = d; nearest = s }
    }
    if (nearest && nearestKm <= SNAP_TOLERANCE_KM) {
      onChange(nearest.id)
      setMissTap(false)
    } else {
      setMissTap(true)
    }
  }

  const pins: MapPin[] = stops.map((s) => ({
    lat: s.lat, lng: s.lng, label: isUrdu && s.label_ur ? s.label_ur : s.label,
    color: s.id === value ? '#b45309' : '#166534', emoji: s.id === value ? '📍' : '🚏',
  }))

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-[480px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 pb-2">
          <p className="font-sans text-[14px] font-bold text-[#1e293b]">{t('mv.pickBoardStopHeading')}</p>
          <button onClick={onClose} className="p-1 text-[#64748b] cursor-pointer"><X size={18} /></button>
        </div>
        <p className="font-sans text-[11.5px] text-[#64748b] px-4 pb-2">{t('mv.tapStopOnMapHint')}</p>
        <div className="px-4">
          <LeafletMap pins={pins} height={320} className="rounded-xl" onMapClick={handleMapClick} />
        </div>
        {missTap && <p className="font-sans text-[11px] text-[#b91c1c] px-4 pt-2">{t('mv.tapCloserToStopHint')}</p>}
        <div className="p-4 flex flex-col gap-2">
          <button onClick={() => { onChange(null); onClose() }}
            className="w-full px-3 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#334155] cursor-pointer">
            {t('mv.boardAtOriginBtn')} ({originLabel})
          </button>
          {value && (
            <button onClick={onClose} className="w-full px-3 py-2.5 rounded-lg bg-[#166534] text-white font-sans text-[13px] font-bold cursor-pointer">
              {t('action.save')}: {stops.find((s) => s.id === value) ? (isUrdu && stops.find((s) => s.id === value)!.label_ur ? stops.find((s) => s.id === value)!.label_ur : stops.find((s) => s.id === value)!.label) : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
