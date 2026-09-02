'use client'

// One toggle, dropped into a driver's "My trip offers" card on
// /portal/my-vehicle for whichever offer is still open — flips
// share_live_location on the offer and, while it's on, keeps pinging
// this vehicle's position via useLiveLocation so riders browsing
// /portal/marketplace/nearby can see it before a fare's even agreed.
// Kept as its own component (not inlined into my-vehicle/page.tsx) so
// that already-366-line page doesn't grow another block of geolocation
// plumbing for what's really a self-contained concern.

import { useState } from 'react'
import { Radio, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'

interface Props {
  tripOfferId: string
  sharing: boolean
  onSharingChange: (on: boolean) => void
}

export function TripLiveShareToggle({ tripOfferId, sharing, onSharingChange }: Props) {
  const { t } = useLocale()
  const supabase = createClient()
  const [busy, setBusy] = useState(false)

  const { error, isNative } = useLiveLocation({
    enabled: sharing,
    minIntervalMs: 12000,
    backgroundTitle: t('cm.liveShareNotifTitle'),
    backgroundMessage: t('cm.liveShareNotifBody'),
    onFix: async ({ lat, lng }) => {
      const { error: pingErr } = await supabase.rpc('ping_trip_offer_location', { p_trip_offer_id: tripOfferId, p_lat: lat, p_lng: lng })
      // The RPC raises if sharing got switched off elsewhere (e.g. the
      // offer closed) — that's the client's signal to stop, not just a
      // failed ping to retry.
      if (pingErr) onSharingChange(false)
    },
  })

  const toggle = async () => {
    setBusy(true)
    const { error: toggleErr } = await supabase.rpc('set_trip_offer_live_sharing', { p_trip_offer_id: tripOfferId, p_on: !sharing })
    setBusy(false)
    if (toggleErr) { toast.error(friendlyError(toggleErr)); return }
    onSharingChange(!sharing)
    if (!sharing) toast.success(t('cm.liveShareOnToast'))
  }

  return (
    <div className="mt-2 pt-2 border-t border-dp-outline-variant/60">
      <button type="button" onClick={toggle} disabled={busy}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-sans font-semibold cursor-pointer transition-all disabled:opacity-50 ${sharing ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container'}`}>
        <Radio size={12} className={sharing ? 'animate-pulse' : ''} /> {sharing ? t('cm.liveSharingOnBtn') : t('cm.liveShareOffBtn')}
      </button>
      {sharing && error && (
        <p className="flex items-center gap-1 font-sans text-[11px] text-amber-700 mt-1.5"><AlertCircle size={11} /> {error}</p>
      )}
      {sharing && !error && (
        <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1.5">
          {isNative ? t('cm.liveShareActiveHintNative') : t('cm.liveShareActiveHint')}
        </p>
      )}
    </div>
  )
}
