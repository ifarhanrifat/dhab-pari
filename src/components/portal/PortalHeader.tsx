'use client'

import { Menu } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { usePortalUser } from '@/hooks/usePortalUser'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import { PortalNotificationBell } from '@/components/portal/PortalNotificationBell'

interface PortalHeaderProps {
  onMenuToggle?: () => void
}

// Real ask, live on device: "why did not you change the portal top bar
// like the website was having, profile and alert etc" — this used to be
// a bare green bar with just a hamburger and the word "Donor Portal", no
// branding/identity and the notification bell floating disconnected from
// it as a separate white circle. Rebuilt onto the same logo-circle +
// name / language-toggle + bell shape Header2 already uses on the public
// site, with the bell now rendered inline inside this bar (embedded)
// instead of floating on top of the page.
export function PortalHeader({ onMenuToggle }: PortalHeaderProps) {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const { user } = usePortalUser()
  return (
    <header className="bg-dp2-primary text-white px-4 pt-2.5 pb-3">
      <div dir="ltr" className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Desktop already has the fixed sidebar always open (see
              PortalSidebar) -- this toggles its mobile slide-in drawer,
              so it only needs to exist below that breakpoint. */}
          <button onClick={onMenuToggle} className="md:hidden shrink-0 w-[34px] h-[34px] rounded-[10px] border border-white/15 bg-white/8 flex items-center justify-center cursor-pointer" aria-label="Toggle menu">
            <Menu size={18} />
          </button>
          <div className="shrink-0 relative w-10 h-10 rounded-full overflow-hidden bg-dp2-gold shadow-[0_0_0_2px_rgba(212,175,55,.5)]">
            {site.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={site.logoUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center font-urdu font-bold text-[17px] text-[#033a22]">
                {(isUrdu ? site.nameUrdu : site.name).charAt(0)}
              </span>
            )}
          </div>
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-w-0 text-start">
            <h1 className="font-heading text-[15px] font-bold leading-tight truncate">{t('y.donorPortal')}</h1>
            <p className="text-[11px] leading-[1.6] text-green-100 truncate">{user?.full_name ?? ''}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <LanguageToggle compact />
          <PortalNotificationBell embedded />
        </div>
      </div>
    </header>
  )
}
