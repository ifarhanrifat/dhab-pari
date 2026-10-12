'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Menu, Bell, Globe } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { DrawerNav2 } from './DrawerNav2'
import { OnlineUsersBadge } from '@/components/layout/OnlineUsersBadge'

// Phase 1 of the card-based redesign, 2026-10-12. Replaces Header.tsx on
// the public site: same real login-state detection (portal vs staff vs
// anonymous) and the same real AnnouncementBar (news_ticker + appeals),
// restyled into the new deep-green header + drawer-trigger.
export function Header2() {
  const { t, isUrdu, setLocale, locale } = useLocale()
  const site = useSite()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [isPortalUser, setIsPortalUser] = useState(false)
  const [isStaffUser, setIsStaffUser] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const [{ data: pu }, { data: au }] = await Promise.all([
        supabase.from('portal_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle(),
        supabase.from('admin_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle(),
      ])
      if (pu) setIsPortalUser(true)
      if (au) setIsStaffUser(true)
    })
  }, [])

  return (
    <>
      {/* Real ask, live on device: the ticker belt, the hamburger and the
          rest of the header chrome should all stay put while the page
          scrolls underneath, not scroll away with the content -- one
          sticky wrapper around both the belt and the header bar so they
          move (or rather, don't move) as a single unit. */}
      <div className="sticky top-0 z-30">
        <AnnouncementBar source="public" />

        <header className="bg-dp2-primary text-white px-4 pt-2.5 pb-3 shadow-[0_4px_10px_rgba(0,0,0,.15)] relative z-20">
        {/* dir="ltr" pinned here deliberately, in both languages -- real
            ask, live on device: the hamburger (and the drawer it opens)
            should always dock to the physical left and the language
            toggle/bell/online-badge to the physical right, not mirror
            under Urdu the way the rest of this page does. */}
        <div dir="ltr" className="max-w-[1200px] mx-auto flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="menu"
              className="shrink-0 w-[34px] h-[34px] rounded-[10px] border border-white/15 bg-white/8 flex items-center justify-center cursor-pointer"
            >
              <Menu size={18} />
            </button>
            <div className="shrink-0 relative w-10 h-10 rounded-full overflow-hidden bg-dp2-gold shadow-[0_0_0_2px_rgba(212,175,55,.5)]">
              {site.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={site.logoUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center font-urdu font-bold text-[18px] text-[#033a22]">
                  {(isUrdu ? site.nameUrdu : site.name).charAt(0)}
                </span>
              )}
            </div>
            <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-w-0 text-start">
              <div className="flex items-center gap-1.5 font-bold text-[14px] leading-tight whitespace-nowrap">
                <Link href="/" className="truncate">{isUrdu ? site.nameUrdu : site.name}</Link>
                <span className="font-sans bg-dp2-primary-dark text-dp2-amber text-[10px] leading-[1.4] px-1.5 py-px rounded border border-dp2-gold/30 shrink-0">
                  {t('y.portalChip', 'Portal')}
                </span>
              </div>
              <div className="text-[10.5px] leading-[1.75] text-green-100 whitespace-nowrap truncate">
                {isUrdu ? site.committeeUrdu || site.fullNameUrdu : site.shortCommittee}
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-0.5 shrink-0">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setLocale(locale === 'ur' ? 'en' : 'ur')}
                className="flex items-center gap-1 bg-dp2-primary-dark text-dp2-amber border border-dp2-gold/40 px-2.5 py-1 rounded-full text-[11px] font-semibold cursor-pointer"
              >
                <Globe size={11} /> {locale === 'ur' ? 'English' : 'اردو'}
              </button>
              <Link href="/notice-board" aria-label="notifications" className="relative p-1.5 text-green-100">
                <Bell size={20} />
                <span className="absolute top-[5px] end-[5px] w-2 h-2 rounded-full bg-red-500 animate-ping" />
                <span className="absolute top-[5px] end-[5px] w-2 h-2 rounded-full bg-red-500" />
              </Link>
            </div>
            <div dir={isUrdu ? 'rtl' : 'ltr'} className="text-[10.5px] leading-[1.4] text-green-100 whitespace-nowrap">
              <OnlineUsersBadge />
            </div>
          </div>
        </div>
        </header>
      </div>

      <DrawerNav2 open={drawerOpen} onClose={() => setDrawerOpen(false)} isPortalUser={isPortalUser} isStaffUser={isStaffUser} />
    </>
  )
}
