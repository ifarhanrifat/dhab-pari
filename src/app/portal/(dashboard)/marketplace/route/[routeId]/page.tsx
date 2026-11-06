'use client'

// This page's full content now lives in RouteDetailPanel — extracted
// 2026-11-06 so the identical logic renders either standalone here
// (kept alive: dozens of server-side notifications across this app
// deep-link straight to this URL) or inside a popup opened from a
// card tap/the floating button, which is now the primary in-app flow
// (RouteBookingSheet). This file is just the page chrome.

import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomNav } from '@/components/mobility/MobilityBottomNav'
import { RouteDetailPanel } from '@/components/mobility/RouteDetailPanel'

export default function RouteDetailPage() {
  const { t, isUrdu } = useLocale()
  const params = useParams<{ routeId: string }>()
  const router = useRouter()

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <button onClick={() => router.push('/portal/marketplace')} className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13.5px] font-semibold hover:underline cursor-pointer mb-4">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}
      </button>
      <RouteDetailPanel routeId={params.routeId} />
      <MobilityBottomNav />
    </div>
  )
}
