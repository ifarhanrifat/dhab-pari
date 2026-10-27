'use client'

// Real ask, 2026-10-27: "a floating button from where rider can view his
// ongoing booking and driver can now view and start his return ride and
// view his riders location" — neither role had one single, always-
// visible place to jump back into whatever's live right now; they had
// to remember which page it was on. Driven entirely by my_ongoing_ride()
// (745) — one RPC checks both roles (driver's own open trip today, or a
// confirmed booking today) and hands back exactly one thing to link to.
//
// Stacked directly above the existing FloatingWhatsAppButton (same
// right-edge column, same z-index family) rather than picking a new
// corner — two floating buttons in two different corners reads as
// visual clutter; one stack reads as "the floating controls."

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Navigation } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface OngoingRide { role: 'driver' | 'rider'; label: string; link: string }

export function OngoingRideFab() {
  const { t } = useLocale()
  const { user } = usePortalUser()
  const supabase = createClient()
  const [ride, setRide] = useState<OngoingRide | null>(null)

  useEffect(() => {
    if (!user) { setRide(null); return }
    let cancelled = false
    const load = () => supabase.rpc('my_ongoing_ride').then(({ data }) => { if (!cancelled) setRide((data as OngoingRide) ?? null) })
    load()
    const id = setInterval(load, 60000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ride) return null

  return (
    <Link href={ride.link}
      className="fixed z-[70] bottom-[158px] right-4 md:bottom-[90px] md:right-6 flex items-center gap-2 pl-3 pr-4 h-12 rounded-full bg-[#166534] text-white shadow-lg hover:bg-[#145a2c] hover:scale-105 active:scale-95 transition-all print:hidden max-w-[220px]">
      <span className="shrink-0 w-6 h-6 rounded-full bg-white/15 flex items-center justify-center animate-pulse"><Navigation size={13} /></span>
      <span className="min-w-0">
        <span className="block font-sans text-[10px] font-bold uppercase tracking-[0.05em] text-white/70 leading-none">{ride.role === 'driver' ? t('cm.ongoingFabDriverLabel') : t('cm.ongoingFabRiderLabel')}</span>
        <span className="block font-sans text-[12px] font-bold truncate leading-tight mt-0.5">{ride.label}</span>
      </span>
    </Link>
  )
}
