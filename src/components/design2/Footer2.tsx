'use client'
import Link from 'next/link'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'

// Phase 1 of the card-based redesign, 2026-10-12. Same real content as
// Footer.tsx's quickLinks (gated by site.donorsEnabled) and office/
// contact fields, restyled into the new design's chip-list footer.
//
// Real bug found live on device, 2026-10-12: these were plain <span>
// text, no href at all -- inert chips that looked clickable and weren't.
// Fixed to real <Link>s, and expanded to also cover every page just
// trimmed off DrawerNav2's "More" section (Lost & Found, Weather,
// Village Map, Sports, Talent Showcase, Institute Directory,
// Achievements, Moon Finder, Sadqa Jariya, Death Announcements,
// Entertainment, Suggestions) -- the drawer got shorter, nothing got
// unreachable.
const QUICK_LINKS: { href: string; tKey: string; label: string; system?: 'donors_projects' }[] = [
  { href: '/about', tKey: 'x.villageHistory', label: 'Village History' },
  { href: '/projects', tKey: 'site.projects', label: 'Projects', system: 'donors_projects' },
  { href: '/about', tKey: 'site.committee', label: 'Committee' },
  { href: '/news', tKey: 'site.news', label: 'News', system: 'donors_projects' },
  { href: '/contacts', tKey: 'ic.pageTitle', label: 'Important Contacts', system: 'donors_projects' },
  { href: '/lost-found', tKey: 'lf.pageTitle', label: 'Lost & Found', system: 'donors_projects' },
  { href: '/notice-board', tKey: 'nb.pageTitle', label: 'Notice Board', system: 'donors_projects' },
  { href: '/directory', tKey: 'dir.pageTitle', label: 'Directory', system: 'donors_projects' },
  { href: '/weather', tKey: 'wx.pageTitle', label: 'Weather' },
  { href: '/village-map', tKey: 'vm.pageTitle', label: 'Village Map', system: 'donors_projects' },
  { href: '/sports', tKey: 'sp.pageTitle', label: 'Sports', system: 'donors_projects' },
  { href: '/talent', tKey: 'talent.title', label: 'Talent Showcase', system: 'donors_projects' },
  { href: '/education', tKey: 'x.educationCorner', label: 'Institute Directory', system: 'donors_projects' },
  { href: '/achievements', tKey: 'x.ourAchievements', label: 'Achievements', system: 'donors_projects' },
  { href: '/moon-finder', tKey: 'mf.title', label: 'Moon Finder' },
  { href: '/sadqa-jariya', tKey: 'sj.title', label: 'Sadqa Jariya', system: 'donors_projects' },
  { href: '/death-announcements', tKey: 'da.pageTitle', label: 'Death Announcements', system: 'donors_projects' },
  { href: '/entertainment', tKey: 'x.communityCorner', label: 'Entertainment', system: 'donors_projects' },
  { href: '/suggestions', tKey: 'x.communityInput', label: 'Suggestions', system: 'donors_projects' },
]

export function Footer2() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const links = QUICK_LINKS.filter((l) => l.system !== 'donors_projects' || site.donorsEnabled)

  return (
    <footer dir={isUrdu ? 'rtl' : 'ltr'} className="flex flex-col gap-2 px-1 pt-1.5 pb-2.5">
      <div className="font-bold text-[15px] text-dp2-primary">{isUrdu ? site.nameUrdu : site.name}</div>
      <p className="text-[12px] leading-[1.5] text-slate-500">
        {isUrdu ? site.taglineUrdu : `Dedicated to the prosperity and welfare of ${site.name} village through transparent management, modern water systems, and communal support.`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <Link key={l.tKey + l.href} href={l.href} className="px-2.5 py-1 rounded-full bg-white border border-dp2-card-border text-[11.5px] font-medium text-slate-600 hover:border-dp2-primary-dark hover:text-dp2-primary-dark transition-colors">
            {t(l.tKey, l.label)}
          </Link>
        ))}
      </div>
      {(site.location || site.officeHours) && (
        <div className="text-[10.5px] leading-[1.5] text-slate-500">
          {site.location && <>📍 {site.location}<br /></>}
          {site.officeHours && <>🕘 <span dir="ltr">{site.officeHours}</span></>}
        </div>
      )}
      <div className="pt-2 border-t border-dp2-card-border text-[11px] text-slate-400">
        © {new Date().getFullYear()} {isUrdu ? site.fullNameUrdu : site.fullName}. {t('y.allRightsReserved')}
      </div>
    </footer>
  )
}
