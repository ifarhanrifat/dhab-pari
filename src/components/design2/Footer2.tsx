'use client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'

// Phase 1 of the card-based redesign, 2026-10-12. Same real content as
// Footer.tsx's quickLinks (gated by site.donorsEnabled) and office/
// contact fields, restyled into the new design's chip-list footer.
const QUICK_LINKS: { tKey: string; label: string; system?: 'donors_projects' }[] = [
  { tKey: 'x.villageHistory', label: 'Village History' },
  { tKey: 'site.projects', label: 'Projects', system: 'donors_projects' },
  { tKey: 'site.committee', label: 'Committee' },
  { tKey: 'site.news', label: 'News', system: 'donors_projects' },
  { tKey: 'ic.pageTitle', label: 'Important Contacts', system: 'donors_projects' },
  { tKey: 'lf.pageTitle', label: 'Lost & Found', system: 'donors_projects' },
  { tKey: 'nb.pageTitle', label: 'Notice Board', system: 'donors_projects' },
  { tKey: 'dir.pageTitle', label: 'Directory', system: 'donors_projects' },
]

export function Footer2() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const links = QUICK_LINKS.filter((l) => l.system !== 'donors_projects' || site.donorsEnabled)

  return (
    <footer dir={isUrdu ? 'rtl' : 'ltr'} className="flex flex-col gap-2 px-1 pt-1.5 pb-2.5">
      <div className="font-bold text-[13px] text-dp2-primary">{isUrdu ? site.nameUrdu : site.name}</div>
      <p className="text-[10px] leading-[1.5] text-slate-500">
        {isUrdu ? site.taglineUrdu : `Dedicated to the prosperity and welfare of ${site.name} village through transparent management, modern water systems, and communal support.`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <span key={l.tKey} className="px-2.5 py-px rounded-full bg-white border border-dp2-card-border text-[9.5px] font-medium text-slate-600">
            {t(l.tKey, l.label)}
          </span>
        ))}
      </div>
      {(site.location || site.officeHours) && (
        <div className="text-[9.5px] leading-[1.5] text-slate-500">
          {site.location && <>📍 {site.location}<br /></>}
          {site.officeHours && <>🕘 <span dir="ltr">{site.officeHours}</span></>}
        </div>
      )}
      <div className="pt-2 border-t border-dp2-card-border text-[10px] text-slate-400">
        © {new Date().getFullYear()} {isUrdu ? site.fullNameUrdu : site.fullName}. {t('y.allRightsReserved')}
      </div>
    </footer>
  )
}
