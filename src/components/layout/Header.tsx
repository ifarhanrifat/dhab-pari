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
                Village Transparency Portal
              </p>
            </div>
          </div>

          {/* Desktop Nav
              flex-1 + min-w-0 + scroll: adding an 11th link (Blood) pushed the
              row past the 1200px container at lg, and because the logo block is
              shrink-0 the nav ran underneath it — "Home" disappeared behind
              "Dhab Pari". Now the nav takes the space that is left and scrolls
              inside itself rather than overlapping its neighbours. */}
          <nav className="hidden lg:flex flex-1 min-w-0 justify-end items-center gap-3.5 xl:gap-5 overflow-x-auto hide-scrollbar relative z-0 ps-3">
            {navLinks.map((link) => {
              const isActive = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    isActive
                      ? 'text-[#86f8c9] font-bold border-b-2 border-[#86f8c9] pb-1 text-[13.5px] font-sans tracking-[0.02em] whitespace-nowrap'
                      : 'text-white/80 hover:text-white transition-colors text-[13.5px] font-sans tracking-[0.02em] whitespace-nowrap'
                  }
                >
                  {t(link.tKey, link.label)}
                </Link>
              )
            })}
          </nav>

          {/* Right Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {isPortalUser ? (
              <Link
                href="/portal"
                className="hidden md:flex items-center gap-1.5 bg-amber-500 text-white px-3 py-1.5 rounded-lg font-sans text-[13px] font-semibold tracking-[0.02em] hover:bg-amber-600 transition-all active:scale-95 whitespace-nowrap"
              >
                <UserCircle2 size={16} />
                {t('site.myPortal')}
              </Link>
            ) : (
              <Link
                href="/portal/login"
                className="hidden md:flex items-center gap-2 text-white/80 hover:text-white text-[13px] font-sans font-semibold tracking-[0.02em] transition-colors whitespace-nowrap"
              >
                {t('site.login')}
              </Link>
            )}
            {/* WhatsApp's own brand green (#25D366) — deliberately distinct
                from the site's teal so it reads as "this opens WhatsApp",
                not as another site action. Joins the committee's community
                group (not a 1:1 chat) — the floating button on every page
                is the direct "chat with us" contact instead. */}
            <a
              href={SITE.whatsappGroupLink}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:flex items-center gap-1.5 bg-[#25D366] text-white px-3 py-1.5 rounded-lg font-sans text-[13px] font-semibold tracking-[0.02em] hover:bg-[#1ebe5a] transition-all active:scale-95 whitespace-nowrap"
            >
              <MessageCircle size={16} />
              {t('site.joinGroup')}
            </a>
            {/* Facebook's own brand blue, icon-only — lucide dropped brand
                icons, so this is the official mark as inline SVG. Kept
                icon-only deliberately: the header nav is already at its
                width limit (adding "Jobs" once pushed it onto two rows),
                and the f mark is universally recognized without a label. */}
            <a
              href={SITE.facebookLink}
              target="_blank"
              rel="noopener noreferrer"
              title="Follow us on Facebook"
              aria-label="Follow us on Facebook"
              className="hidden md:flex items-center justify-center bg-[#1877F2] text-white w-[30px] h-[30px] rounded-lg hover:bg-[#0f66d0] transition-all active:scale-95 shrink-0"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.412c0-3.025 1.792-4.696 4.533-4.696 1.313 0 2.686.236 2.686.236v2.971H15.83c-1.491 0-1.956.93-1.956 1.886v2.264h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z" />
              </svg>
            </a>
            {/* Sits where the old dead "EN/UR" placeholder was, so the
                control is where people were already looking for it — that one
                had no handler and never switched anything. Hidden on the
                narrowest phones, where the mobile drawer carries its own. */}
            <span className="hidden sm:block"><LanguageToggle compact /></span>
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
