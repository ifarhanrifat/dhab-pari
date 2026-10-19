'use client'

// The rider-side twin of TripLiveShareToggle — same shape, applied to
// the post-booking bilateral location table (vehicle_trip_locations,
// migration 400) instead of the driver's pre-booking one. Real ask:
// "the rider can stop sharing his location if he wants and he will no
// longer be seen to driver" — turning off deletes the rider's row
// server-side (set_rider_trip_location_sharing), not just stops pinging.
// Scoped to a confirmed return-leg booking only.

import { useState } from 'react'
import { Radio, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'

interface Props {
  tripBookingId: string
  sharing: boolean
  onSharingChange: (on: boolean) => void
}

export function RiderLiveShareToggle({ tripBookingId, sharing, onSharingChange }: Props) {
  const { t } = useLocale()
  const supabase = createClient()
  const [busy, setBusy] = useState(false)

  const { error, isNative } = useLiveLocation({
    enabled: sharing,
    minIntervalMs: 12000,
    backgroundTitle: t('cm.liveShareNotifTitle'),
    backgroundMessage: t('cm.liveShareNotifBody'),
    onFix: async ({ lat, lng }) => {
      const { error: pingErr } = await supabase.rpc('ping_trip_location', { p_trip_booking_id: tripBookingId, p_lat: lat, p_lng: lng })
      if (pingErr) onSharingChange(false)
    },
  })

  const toggle = async () => {
    setBusy(true)
    const { error: toggleErr } = await supabase.rpc('set_rider_trip_location_sharing', { p_trip_booking_id: tripBookingId, p_on: !sharing })
    setBusy(false)
    if (toggleErr) { toast.error(friendlyError(toggleErr)); return }
    onSharingChange(!sharing)
    if (!sharing) toast.success(t('cm.liveShareOnToast'))
  }

  return (
    <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
      <p className="font-sans text-[11.5px] font-semibold text-[#1e293b] mb-1">{t('cm.readyForPickupToggleLabel')}</p>
      <button type="button" onClick={toggle} disabled={busy}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-sans font-semibold cursor-pointer transition-all disabled:opacity-50 ${sharing ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
        <Radio size={12} className={sharing ? 'animate-pulse' : ''} /> {sharing ? t('cm.liveSharingOnBtn') : t('cm.liveShareOffBtn')}
      </button>
      {sharing && error && (
        <p className="flex items-center gap-1 font-sans text-[11px] text-amber-700 mt-1.5"><AlertCircle size={11} /> {error}</p>
      )}
      {sharing && !error && (
        <p className="font-sans text-[11px] text-[#64748b] mt-1.5">
          {isNative ? t('cm.liveShareActiveHintNative') : t('cm.liveShareActiveHint')}
        </p>
      )}
      {!sharing && (
        <p className="font-sans text-[11px] text-[#64748b] mt-1.5">{t('cm.readyForPickupHint')}</p>
      )}
    </div>
  )
}
