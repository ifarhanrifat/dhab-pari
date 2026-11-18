'use client'

// 2026-11-17: booking wizard rebuild Phase B — the map-pin pickup
// feature from SAFAR_Admin_Dashboard_Professional_Booking-4.html's
// real wizard JS (initBookingPickupMaps/setPickupPin). Deliberately a
// separate component from TerminalStopPicker, not a variant of it:
// that one offers a plain list of this route's real named/terminal
// stops — the whole point here is a free GPS pin anywhere along the
// route, which is what a passenger boarding off the official stop
// list actually needs. Reuses LeafletMap's existing onMapClick/route
// props as-is; no changes to LeafletMap itself.

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import type { MapPin } from '@/components/shared/LeafletMap'
import type { PickableStop } from '@/components/mobility/TerminalStopPicker'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Props {
  stops: PickableStop[]
  lat: number | null
  lng: number | null
  onChange: (lat: number, lng: number) => void
  onClose: () => void
}

export function PickupPinMapPicker({ stops, lat, lng, onChange, onClose }: Props) {
  const { t } = useLocale()
  const [latInput, setLatInput] = useState(lat != null ? String(lat) : '')
  const [lngInput, setLngInput] = useState(lng != null ? String(lng) : '')

  const setFromInputs = () => {
    const la = Number(latInput), ln = Number(lngInput)
    if (!Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) return
    onChange(la, ln)
  }

  const handleMapClick = (clickLat: number, clickLng: number) => {
    setLatInput(clickLat.toFixed(6)); setLngInput(clickLng.toFixed(6))
    onChange(clickLat, clickLng)
  }

  const routeLine = stops.map((s) => ({ lat: s.lat, lng: s.lng }))
  const pins: MapPin[] = [
    ...stops.map((s): MapPin => ({ lat: s.lat, lng: s.lng, label: s.label, color: '#166534', emoji: '🚏' })),
    ...(lat != null && lng != null ? [{ lat, lng, label: t('mv.pickupPinLabel'), color: '#b91c1c', emoji: '📍' } as MapPin] : []),
  ]

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-[480px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 pb-2">
          <p className="font-sans text-[14px] font-bold text-[#1e293b]">{t('mv.choosePickupPinHeading')}</p>
          <button onClick={onClose} className="p-1 text-[#64748b] cursor-pointer"><X size={18} /></button>
        </div>
        <p className="font-sans text-[11.5px] text-[#64748b] px-4 pb-2">{t('mv.tapPickupOnMapHint')}</p>
        <div className="px-4">
          <LeafletMap pins={pins} route={routeLine} height={320} className="rounded-xl" onMapClick={handleMapClick} />
        </div>
        <div className="p-4 flex flex-col gap-2.5">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block font-sans text-[10.5px] font-bold text-[#64748b] mb-0.5">{t('mv.latitudeLabel')}</label>
              <input type="number" step="0.000001" value={latInput} onChange={(e) => setLatInput(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
            </div>
            <div className="flex-1">
              <label className="block font-sans text-[10.5px] font-bold text-[#64748b] mb-0.5">{t('mv.longitudeLabel')}</label>
              <input type="number" step="0.000001" value={lngInput} onChange={(e) => setLngInput(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
            </div>
          </div>
          <button type="button" onClick={setFromInputs} className="w-full px-3 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold text-[#334155] cursor-pointer">
            {t('mv.setPinFromCoordsBtn')}
          </button>
          {lat != null && lng != null && (
            <>
              <p className="font-sans text-[10.5px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5">{t('mv.pickupApprovalNeededHint')}</p>
              <button onClick={onClose} className="w-full px-3 py-2.5 rounded-lg bg-[#166534] text-white font-sans text-[13px] font-bold cursor-pointer">
                {t('action.save')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
