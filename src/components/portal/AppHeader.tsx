'use client'

import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { usePortalUser } from '@/hooks/usePortalUser'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import { PortalNotificationBell } from '@/components/portal/PortalNotificationBell'

// Phase 6: replaces both PortalHeader and MobilityHeader with one header
// for the whole portal shell. There is no more hamburger/sidebar to
// toggle (BottomTabBar is the only nav now), and no more risk of two
// live PortalNotificationBell instances colliding (MobilityHeader's own
// comment explains why it used a static bell link instead) since only
// one header ever mounts per screen. `title`/`subtitle` let a section
// override the default tenant-name/user-name pair — e.g. "My Vehicle ›
// Earnings" — the same job MobilityHeader's per-section subtitle did.
interface AppHeaderProps {
  title?: string
  subtitle?: string
}

export function AppHeader({ title, subtitle }: AppHeaderProps) {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const { user } = usePortalUser()

  return (
    <header className="bg-dp2-primary text-white px-3.5 py-2.5">
      <div dir="ltr" className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="shrink-0 relative w-[38px] h-[38px] rounded-full overflow-hidden bg-dp2-gold shadow-[0_0_0_2px_rgba(212,175,55,.5)]">
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
            <h1 className="font-sans text-[13px] font-bold leading-tight truncate">{title ?? (isUrdu ? site.nameUrdu : site.name)}</h1>
            <p className="text-[9.5px] leading-tight text-[#bbf7d0] truncate">{subtitle ?? (user?.full_name ?? t('y.donorPortal'))}</p>
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
