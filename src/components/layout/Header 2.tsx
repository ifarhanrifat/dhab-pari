'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { MessageCircle, Menu, UserCircle2 } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { MobileNav } from './MobileNav'
import { createClient } from '@/lib/supabase/client'

const navLinks = [
  { href: '/', label: 'Home' },
  { href: '/water', label: 'Water Bill' },
  { href: '/projects', label: 'Projects' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/donate', label: 'Donate' },
  { href: '/news', label: 'News' },
  { href: '/videos', label: 'Videos' },
  { href: '/gallery', label: 'Gallery' },
  { href: '/about', label: 'Committee' },
]

export function Header() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
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
          {/* Logo — tagline only shows once there's room to spare (xl+),
              so it never competes with the nav for space at lg. */}
          <div className="shrink-0">
            <Link href="/" className="font-heading text-[28px] font-bold leading-[34px] text-white tracking-tight">
              Dhab Pari
            </Link>
            <p className="text-white/60 text-[12px] font-sans hidden xl:block">
              Village Transparency Portal
            </p>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden lg:flex items-center gap-4 xl:gap-5">
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
                  {link.label}
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
                My Portal
              </Link>
            ) : (
              <Link
                href="/portal/login"
                className="hidden md:flex items-center gap-2 text-white/80 hover:text-white text-[13px] font-sans font-semibold tracking-[0.02em] transition-colors whitespace-nowrap"
              >
                Log In
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
              Join our Group
            </a>
            <button className="text-white/80 hover:text-white border border-dp-outline-variant px-2 py-1 rounded text-[12.5px] font-sans font-semibold tracking-[0.02em] hidden md:block transition-colors">
              EN/UR
            </button>
            <button
              className="lg:hidden text-white p-1"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={24} />
            </button>
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
