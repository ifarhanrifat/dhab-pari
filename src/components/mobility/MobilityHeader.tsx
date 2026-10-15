'use client'

// Header for the new "Dhab Pari Mobility" design (imported from
// Dhab Pari Mobility.dc.html) — logo circle, brand name, language
// toggle. Stacked below the portal's own generic root header
// (portal/(dashboard)/layout.tsx), same precedent my-vehicle/layout.tsx
// already established: a section gets its own header on top of the
// shared one, not instead of it.
//
// Real bug, confirmed live: the design's own bell belongs here too, but
// PortalHeader.tsx already renders <PortalNotificationBell embedded />
// above every portal page including this one — a second instance here
// opened a second Supabase Realtime channel for the same
// portal_notifications:<id> name, and .channel() + .subscribe() on an
// already-subscribed channel name throws ("cannot add postgres_changes
// callbacks ... after subscribe()"), crashing the whole page. The root
// header's bell is already visible above this one; no second bell needed.
//
// Colors are the design file's own literal hex values (#005A36 etc),
// not the app-wide --color-dp-* tokens — a different palette, kept
// exact per direct instruction ("exactly like the provided html file").

import { useLocale } from '@/lib/i18n/LocaleProvider'

export function MobilityHeader() {
  const { t, isUrdu, setLocale } = useLocale()

  return (
    <header dir={isUrdu ? 'rtl' : 'ltr'} className="bg-[#005A36] text-white px-3.5 py-2.5 flex items-center justify-between gap-2 shadow-[0_4px_10px_rgba(0,0,0,.15)] relative z-20">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="shrink-0 w-[38px] h-[38px] rounded-full bg-[#D4AF37] flex items-center justify-center text-[17px] shadow-[0_0_0_2px_rgba(212,175,55,.5)]">🚐</div>
        <div className="min-w-0">
          <p className="font-bold text-[13px] leading-tight whitespace-nowrap">{t('mb.appName')}</p>
          <p className="text-[9.5px] leading-tight text-[#bbf7d0] whitespace-nowrap overflow-hidden text-ellipsis">{t('mb.headerSubtitle')}</p>
        </div>
      </div>
      <button onClick={() => setLocale(isUrdu ? 'en' : 'ur')} className="shrink-0 bg-[#166534] text-[#fbbf24] border border-[#D4AF37]/40 px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold cursor-pointer">
        🌐 {isUrdu ? 'English' : 'اردو'}
      </button>
    </header>
  )
}
