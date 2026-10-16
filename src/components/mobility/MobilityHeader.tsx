'use client'

// Header for the new "Dhab Pari Mobility" design (imported from
// Dhab Pari Mobility.dc.html) — logo circle, brand name, language
// toggle, bell. The design's own header has no hamburger/sidebar at all
// (bottom-nav covers every mobility screen), so the root portal layout
// now skips PortalHeader/PortalSidebar entirely on these routes instead
// of stacking a second header under this one (a real visual bug found
// auditing against the design: two logos, two language toggles).
//
// The bell here is a plain link to the notifications screen, not
// <PortalNotificationBell>, deliberately: that component opens a live
// Supabase Realtime channel, and a second instance of it alongside
// PortalHeader's embedded one crashed the page outright (duplicate
// .channel().subscribe() on the same channel name). Since PortalHeader
// no longer renders on these routes there's no live instance to collide
// with any more, but this still stays a static link rather than
// resurrecting a second live subscription for no real benefit — the
// notifications screen itself fetches the list on load regardless.
//
// Colors are the design file's own literal hex values (#005A36 etc),
// not the app-wide --color-dp-* tokens — a different palette, kept
// exact per direct instruction ("exactly like the provided html file").

import Link from 'next/link'
import { Bell, Menu } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { usePortalMobileNavToggle } from '@/components/portal/PortalMobileNavContext'

export function MobilityHeader() {
  const { t, isUrdu, setLocale } = useLocale()
  const openMobileNav = usePortalMobileNavToggle()

  return (
    <header dir={isUrdu ? 'rtl' : 'ltr'} className="bg-[#005A36] text-white px-3.5 py-2.5 flex items-center justify-between gap-2 shadow-[0_4px_10px_rgba(0,0,0,.15)] relative z-20">
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Only the sidebar's own trigger -- hidden on md+ where the
            sidebar already shows permanently, same breakpoint it uses. */}
        {openMobileNav && (
          <button onClick={openMobileNav} className="md:hidden shrink-0 w-8 h-8 rounded-full bg-[#166534] flex items-center justify-center" aria-label="Toggle menu">
            <Menu size={16} />
          </button>
        )}
        <div className="shrink-0 w-[38px] h-[38px] rounded-full bg-[#D4AF37] flex items-center justify-center text-[17px] shadow-[0_0_0_2px_rgba(212,175,55,.5)]">🚐</div>
        <div className="min-w-0">
          <p className="font-bold text-[13px] leading-tight whitespace-nowrap">{t('mb.appName')}</p>
          <p className="text-[9.5px] leading-tight text-[#bbf7d0] whitespace-nowrap overflow-hidden text-ellipsis">{t('mb.headerSubtitle')}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => setLocale(isUrdu ? 'en' : 'ur')} className="shrink-0 bg-[#166534] text-[#fbbf24] border border-[#D4AF37]/40 px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold cursor-pointer">
          🌐 {isUrdu ? 'English' : 'اردو'}
        </button>
        <Link href="/portal/marketplace/notifications" className="shrink-0 w-8 h-8 rounded-full bg-[#166534] flex items-center justify-center" aria-label={t('g.notifications')}>
          <Bell size={15} />
        </Link>
      </div>
    </header>
  )
}
