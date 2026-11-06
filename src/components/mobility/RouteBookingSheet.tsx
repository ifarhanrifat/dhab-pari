'use client'

// The popup entry point for Routes — tapping a card or a floating-
// button item opens this instead of navigating to the standalone
// route detail page. Same content (RouteDetailPanel), just reached
// without ever leaving the screen the rider was already on.

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { RouteDetailPanel } from '@/components/mobility/RouteDetailPanel'

export function RouteBookingSheet({ routeId, onClose }: { routeId: string; onClose: () => void }) {
  const { t } = useLocale()
  return (
    <MobilityBottomSheet title={t('mv.routeDetailsHeading')} onClose={onClose}>
      <RouteDetailPanel routeId={routeId} />
    </MobilityBottomSheet>
  )
}
