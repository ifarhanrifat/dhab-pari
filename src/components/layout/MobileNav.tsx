'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X, UserCircle2, ShieldCheck } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface MobileNavProps {
  open: boolean
  onClose: () => void
  navLinks: { href: string; label: string }[]
  isPortalUser?: boolean
}

export function MobileNav({ open, onClose, navLinks, isPortalUser }: MobileNavProps) {
  const { t } = useLocale()
  const pathname = usePathname()

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="bg-black/50 z-[95] lg:hidden"
          style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0 }}
          onClick={onClose}
        />
      )}

      {/* Drawer. z-[100] puts it above the install banner (z-80) and the
          floating WhatsApp button (z-70), which were previously drawn on top
          of the menu and hid several links. flex + overflow-y-auto so every
          item stays reachable on a short screen — the staff login button at
          the bottom used to be cut off with no way to scroll to it. */}
      <div
        style={{
          position: 'fixed', top: 0, left: 0, right: 'auto',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
        }}
        className="h-full w-[280px] max-w-[85vw] bg-dp-primary z-[100] lg:hidden flex flex-col overflow-y-auto transition-transform duration-300 ease-in-out"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <span className="font-heading text-[24px] font-bold text-white">
            {SITE.name}
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
          <div className="px-4 pb-3"><LanguageToggle compact /></div>
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

        {/* Staff entry point. Nothing on the public site linked to /admin at
            all, so once the app is installed a committee member, accountant
            or administrator had no way to reach the dashboard short of typing
            the URL. Points at /admin, not /admin/login: middleware sends an
            unauthenticated visitor to the login page and an already-signed-in
            staff member straight through, so one link serves both. */}
        <div className="px-4">
          <Link
            href="/admin"
            onClick={onClose}
            className="flex items-center gap-2 border border-white/25 text-white/85 px-4 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold justify-center hover:bg-white/10 transition-colors"
          >
            <ShieldCheck size={16} />
            {t('y.committeeStaffLogin')}
          </Link>
        </div>

        {/* Language Toggle */}
        <div className="px-6 mt-4 pb-6">
          <button className="w-full text-white/80 hover:text-white border border-dp-outline-variant px-4 py-2 rounded-lg text-[14px] font-sans font-semibold tracking-[0.05em] transition-colors">
            EN / اردو
          </button>
        </div>
      </div>
    </>
  )
}
