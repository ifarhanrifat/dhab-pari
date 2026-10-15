'use client'

// Real map-tap location picker — the design file's own `openPicker`
// (dhab-pari-mobility.html): every booking sheet resolves pickup/
// drop-off/venue/site through this, never a typed address alone. Found
// missing in a full re-audit against the design: hourly pickup, shadi
// venue, and equipment site were all free-text only, no coordinates, so
// a driver had nothing but a sentence to find the spot by. This is the
// one shared sheet every one of those forms now opens instead — tap the
// map (or use GPS) to drop a pin, then a short label for what it is.

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Target, Loader2 } from 'lucide-react'
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

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

export function LocationPickerSheet({ title, initial, defaultCenter, onConfirm, onClose }: Props) {
  const { t } = useLocale()
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(initial ? { lat: initial.lat, lng: initial.lng } : null)
  const [label, setLabel] = useState(initial?.label ?? '')
  const [locating, setLocating] = useState(false)
  const [locationModalReason, setLocationModalReason] = useState<Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'> | null>(null)

  const useGps = async () => {
    setLocating(true)
    try {
      const pos = await getCurrentPositionOnce()
      setPin({ lat: pos.lat, lng: pos.lng })
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
          <LeafletMap
            pins={pin ? [{ lat: pin.lat, lng: pin.lng, color: '#166534' }] : []}
            center={defaultCenter}
            height={240}
            zoom={14}
            className="rounded-xl border border-[#e5e2d0]"
            onMapClick={(lat, lng) => setPin({ lat, lng })}
          />
          <button onClick={useGps} disabled={locating} className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-[#e5e2d0] text-[#166534] font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
            {locating ? <Loader2 size={13} className="animate-spin" /> : <Target size={13} />} {t('mb.useMyLocationBtn')}
          </button>
          <p className="font-sans text-[11.5px] text-[#64748b] text-center -mt-1">{t('mb.tapMapToPinHint')}</p>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mb.locationLabelField')}</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('mb.locationLabelPlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
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
