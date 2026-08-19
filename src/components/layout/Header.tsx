'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { MessageCircle, Menu, UserCircle2 } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { MobileNav } from './MobileNav'
import { useMobileNav } from './MobileNavContext'
import { createClient } from '@/lib/supabase/client'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const navLinks: { href: string; label: string; tKey: string }[] = [
  { href: '/', label: 'Home', tKey: 'site.home' },
  { href: '/water', label: 'Water Bill', tKey: 'site.waterBill' },
  // High in the list on purpose: someone looking for this is looking for it in
  // an emergency, and will not hunt through a sidebar card to find it.
  { href: '/blood', label: 'Blood', tKey: 'site.blood' },
  { href: '/projects', label: 'Projects', tKey: 'site.projects' },
  { href: '/jobs', label: 'Jobs', tKey: 'site.jobs' },
  { href: '/accounts', label: 'Accounts', tKey: 'site.accounts' },
  { href: '/donate', label: 'Donate', tKey: 'site.donate' },
  { href: '/welfare', label: 'Welfare', tKey: 'site.welfare' },
  { href: '/news', label: 'News', tKey: 'site.news' },
  { href: '/videos', label: 'Videos', tKey: 'site.videos' },
  { href: '/gallery', label: 'Gallery', tKey: 'site.gallery' },
  { href: '/about', label: 'Committee', tKey: 'site.committee' },
]

export function Header() {
  const { t } = useLocale()
  const pathname = usePathname()
  const { open: mobileOpen, setOpen: setMobileOpen } = useMobileNav()
  const [isPortalUser, setIsPortalUser] = useState(false)

  // A registered donor/consumer is a website user too — surface a single
  // "My Portal" entry point when logged in, rather than duplicating the
  // portal's own navigation into the public site's header.
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle()
      if (data) setIsPortalUser(true)
    })
  }, [])

  return (
    <>
      <header className="bg-dp-primary sticky top-0 z-50 w-full">
        <div className="max-w-[1200px] mx-auto w-full px-6 py-3.5 flex items-center justify-between gap-3">
          {/* Menu button sits on the LEFT, next to the logo, so it points at
              the drawer that slides in from the left — it used to be on the
              far right, which made the panel appear to come from nowhere. */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              className="lg:hidden text-white p-1.5 -ms-1.5 shrink-0"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={26} />
            </button>
            {/* Logo — tagline only shows once there's room to spare (xl+),
                so it never competes with the nav for space at lg. */}
            <div className="shrink-0 relative z-10 bg-dp-primary pe-2">
              <Link href="/" className="font-heading text-[28px] font-bold leading-[34px] text-white tracking-tight">
                {SITE.name}
              </Link>
              <p className="text-white/60 text-[12px] font-sans hidden xl:block">
                {t('y.villageTransparency')}
              </p>
            </div>
          </div>

          {/* Desktop Nav — every link rendered directly, no "More" trigger.
              flex-1 + min-w-0 + scroll is still the fallback if this ever
              doesn't fit (justify-start means overflow pushes off the END
              of the list, scrollable, not hidden under the logo like
              before) — but the real fix for actually fitting is freeing up
              width elsewhere: Facebook is gone and the WhatsApp button's
              text is shorter (see Right Actions below), and the gap here
              is tighter than it was. */}
          <nav className="hidden lg:flex flex-1 min-w-0 justify-start items-center gap-2 xl:gap-3.5 overflow-x-auto hide-scrollbar relative z-0 ps-3">
            {navLinks.map((link) => {
              const isActive = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    isActive
                      ? 'text-[#86f8c9] font-bold border-b-2 border-[#86f8c9] pb-1 text-[12.5px] xl:text-[13.5px] font-sans tracking-[0.02em] whitespace-nowrap'
                      : 'text-white/80 hover:text-white transition-colors text-[12.5px] xl:text-[13.5px] font-sans tracking-[0.02em] whitespace-nowrap'
                  }
                >
                  {t(link.tKey, link.label)}
                </Link>
              )
            })}
          </nav>

          {/* Right Actions — Login/My Portal is deliberately last, the true
              rightmost item, not sandwiched between the nav and the
              WhatsApp/language buttons. The corner a visitor already
              expects their own identity in on any site. Facebook's own
              icon button used to sit here too; dropped to give the nav
              row more width to work with. */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* WhatsApp's own brand green (#25D366) — deliberately distinct
                from the site's teal so it reads as "this opens WhatsApp",
                not as another site action. Joins the committee's community
                group (not a 1:1 chat) — the floating button on every page
                is the direct "chat with us" contact instead. Sized down
                (padding, icon, text) to give the nav row more room. */}
            <a
              href={SITE.whatsappGroupLink}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:flex items-center gap-1 bg-[#25D366] text-white px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-semibold tracking-[0.02em] hover:bg-[#1ebe5a] transition-all active:scale-95 whitespace-nowrap"
            >
              <MessageCircle size={14} />
              {t('site.joinGroup')}
            </a>
            {/* Sits where the old dead "EN/UR" placeholder was, so the
                control is where people were already looking for it — that one
                had no handler and never switched anything. Hidden on the
                narrowest phones, where the mobile drawer carries its own. */}
            <span className="hidden sm:block"><LanguageToggle compact /></span>
            {isPortalUser ? (
              <Link
                href="/portal"
                className="hidden md:flex items-center gap-1 bg-amber-500 text-white px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-semibold tracking-[0.02em] hover:bg-amber-600 transition-all active:scale-95 whitespace-nowrap"
              >
                <UserCircle2 size={14} />
                {t('site.myPortal')}
              </Link>
            ) : (
              <Link
                href="/portal/login"
                className="hidden md:flex items-center gap-2 text-white/80 hover:text-white text-[12px] font-sans font-semibold tracking-[0.02em] transition-colors whitespace-nowrap"
              >
                {t('site.login')}
              </Link>
            )}
          </div>
        </div>
      </header>

      <MobileNav
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        navLinks={navLinks}
        isPortalUser={isPortalUser}
      />
    </>
  )
}
