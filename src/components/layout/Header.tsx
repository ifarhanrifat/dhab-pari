'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { MessageCircle, Menu } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { MobileNav } from './MobileNav'

const navLinks = [
  { href: '/', label: 'Home' },
  { href: '/water', label: 'Water Bill' },
  { href: '/projects', label: 'Projects' },
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

  return (
    <>
      <header className="bg-dp-primary sticky top-0 z-50 w-full">
        <div className="max-w-[1200px] mx-auto w-full px-6 py-4 flex items-center justify-between">
          {/* Logo */}
          <div>
            <Link href="/" className="font-heading text-[32px] font-bold leading-[40px] text-white tracking-tight">
              Dhab Pari
            </Link>
            <p className="text-white/60 text-[12px] font-sans hidden md:block">
              Village Transparency Portal
            </p>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden lg:flex items-center gap-6">
            {navLinks.map((link) => {
              const isActive = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    isActive
                      ? 'text-[#86f8c9] font-bold border-b-2 border-[#86f8c9] pb-1 text-[14px] font-sans tracking-[0.05em]'
                      : 'text-white/80 hover:text-white transition-colors text-[14px] font-sans tracking-[0.05em]'
                  }
                >
                  {link.label}
                </Link>
              )
            })}
          </nav>

          {/* Right Actions */}
          <div className="flex items-center gap-4">
            <a
              href={SITE.whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:flex items-center gap-2 bg-dp-secondary text-white px-4 py-2 rounded-lg font-sans text-[14px] font-semibold tracking-[0.05em] hover:bg-dp-secondary-container hover:text-dp-on-secondary-container transition-all active:scale-95"
            >
              <MessageCircle size={18} />
              WhatsApp
            </a>
            <button className="text-white/80 hover:text-white border border-dp-outline-variant px-3 py-1 rounded text-[14px] font-sans font-semibold tracking-[0.05em] hidden md:block transition-colors">
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
      />
    </>
  )
}
