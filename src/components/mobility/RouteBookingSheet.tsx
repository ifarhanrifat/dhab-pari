'use client'

// The popup entry point for Routes — tapping a card or a floating-
// button item opens this instead of navigating to the standalone
// route detail page. Same content (RouteDetailPanel), just reached
// without ever leaving the screen the rider was already on.

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { RouteDetailPanel } from '@/components/mobility/RouteDetailPanel'

export function RouteBookingSheet({ routeId, onClose, initialDate, initialSeats, onBooked, compact }: { routeId: string; onClose: () => void; initialDate?: string; initialSeats?: number; onBooked?: () => void; compact?: boolean }) {
  const { t } = useLocale()
  return (
    <MobilityBottomSheet title={t('mv.routeDetailsHeading')} onClose={onClose}>
      <RouteDetailPanel routeId={routeId} initialDate={initialDate} initialSeats={initialSeats} onBooked={onBooked} compact={compact} />
    </MobilityBottomSheet>
  )
}
