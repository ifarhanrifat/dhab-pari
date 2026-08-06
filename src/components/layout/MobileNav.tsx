'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X, UserCircle2 } from 'lucide-react'

interface MobileNavProps {
  open: boolean
  onClose: () => void
  navLinks: { href: string; label: string }[]
  isPortalUser?: boolean
}

export function MobileNav({ open, onClose, navLinks, isPortalUser }: MobileNavProps) {
  const pathname = usePathname()

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-[60] lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        className={`fixed top-0 left-0 h-full w-[280px] bg-dp-primary z-[70] lg:hidden transform transition-transform duration-300 ease-in-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <span className="font-heading text-[24px] font-bold text-white">
            Dhab Pari
          </span>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white p-1"
            aria-label="Close menu"
          >
            <X size={24} />
          </button>
        </div>

        {/* Links */}
        <nav className="flex flex-col py-4">
          {navLinks.map((link) => {
            const isActive = pathname === link.href
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={onClose}
                className={`px-6 py-3 text-[16px] font-sans transition-colors ${
                  isActive
                    ? 'bg-dp-secondary-container text-dp-on-secondary-container font-bold mx-2 rounded-lg'
                    : 'text-white/80 hover:bg-dp-primary-container hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            )
          })}
        </nav>

        {/* Portal entry point */}
        <div className="px-4 mb-2">
          <Link
            href={isPortalUser ? '/portal' : '/portal/login'}
            onClick={onClose}
            className="flex items-center gap-2 bg-dp-secondary text-white px-4 py-2.5 rounded-lg font-sans text-[14px] font-semibold justify-center"
          >
            <UserCircle2 size={17} />
            {isPortalUser ? 'My Portal' : 'Donor / Consumer Log In'}
          </Link>
        </div>

        {/* Language Toggle */}
        <div className="px-6 mt-4">
          <button className="w-full text-white/80 hover:text-white border border-dp-outline-variant px-4 py-2 rounded-lg text-[14px] font-sans font-semibold tracking-[0.05em] transition-colors">
            EN / اردو
          </button>
        </div>
      </div>
    </>
  )
}
