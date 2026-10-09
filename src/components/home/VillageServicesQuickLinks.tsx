'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  PhoneCall, Search, AlertTriangle, Megaphone, Siren, ShoppingBag, BookOpen, CalendarDays, MapPin, Trophy, Wheat, Landmark,
  Droplet, HeartHandshake, Newspaper, ChevronDown, ChevronUp,
} from 'lucide-react'
import { T } from '@/components/i18n/T'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'

// Real gap, 2026-09-30: these public pages (Contacts, Lost & Found, Civic
// Reports, Notice Board, Buy & Sell) only ever linked from the footer --
// easy to miss for the actual audience (village residents, not people who
// habitually scroll to a footer). One row of tappable tiles, right where
// eyes actually land on the homepage, on every screen size.
//
// Real ask, 2026-10-05: this grid and the separate phone-only
// HomeMobileQuickActions stack (Water Bill / Blood / Welfare / News) sat
// right next to each other and read as two competing button clusters
// doing overlapping jobs. Merged into one: the 4 busiest destinations show
// by default, everything else — including what used to live only in that
// other component — sits behind "View All".
//
// Real gap found 2026-10-08: none of these were module-tagged -- a
// water-supply-only tenant saw every tile here regardless. Only /water
// is water_supply; everything else bundles under donors_projects, same
// classification as the header nav and footer (fixed the same day).
const PRIMARY_LINKS = [
  { href: '/water', icon: Droplet, key: 'home.payWaterBill', tone: 'bg-sky-50 text-sky-700', system: 'water_supply' as const },
  { href: '/chanda', icon: Landmark, key: 'ch.pageTitle', tone: 'bg-emerald-50 text-emerald-700', system: 'donors_projects' as const },
  { href: '/contacts', icon: PhoneCall, key: 'ic.pageTitle', tone: 'bg-red-50 text-red-600', system: 'donors_projects' as const },
  { href: '/classifieds', icon: ShoppingBag, key: 'cl.pageTitle', tone: 'bg-violet-50 text-violet-600', system: 'donors_projects' as const },
]

const MORE_LINKS = [
  { href: '/blood', icon: Droplet, key: 'home.requestBlood', tone: 'bg-rose-50 text-rose-600', system: 'donors_projects' as const },
  { href: '/welfare', icon: HeartHandshake, key: 'home.needHelp', tone: 'bg-pink-50 text-pink-600', system: 'donors_projects' as const },
  { href: '/lost-found', icon: Search, key: 'lf.pageTitle', tone: 'bg-amber-50 text-amber-600', system: 'donors_projects' as const },
  { href: '/civic-reports', icon: AlertTriangle, key: 'cr.pageTitle', tone: 'bg-sky-50 text-sky-600', system: 'donors_projects' as const },
  { href: '/notice-board', icon: Megaphone, key: 'nb.pageTitle', tone: 'bg-orange-50 text-orange-600', system: 'donors_projects' as const },
  { href: '/news', icon: Newspaper, key: 'home.villageNews', tone: 'bg-slate-100 text-slate-700', system: 'donors_projects' as const },
  { href: '/directory', icon: BookOpen, key: 'dir.pageTitle', tone: 'bg-teal-50 text-teal-600', system: 'donors_projects' as const },
  { href: '/events', icon: CalendarDays, key: 've.pageTitle', tone: 'bg-indigo-50 text-indigo-600', system: 'donors_projects' as const },
  { href: '/village-map', icon: MapPin, key: 'vm.pageTitle', tone: 'bg-rose-50 text-rose-600', system: 'donors_projects' as const },
  { href: '/sports', icon: Trophy, key: 'sp.pageTitle', tone: 'bg-amber-50 text-amber-700', system: 'donors_projects' as const },
  { href: '/agriculture', icon: Wheat, key: 'ag.pageTitle', tone: 'bg-lime-50 text-lime-700', system: 'donors_projects' as const },
]

function Tile({ href, icon: Icon, labelKey, tone }: { href: string; icon: typeof PhoneCall; labelKey: string; tone: string }) {
  const { isUrdu } = useLocale()
  return (
    <Link href={href} dir={isUrdu ? 'rtl' : 'ltr'}
      className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center gap-3 hover:border-dp-secondary transition-all">
      <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${tone}`}>
        <Icon size={18} />
      </span>
      {/* min-w-0 stops this flex child from refusing to shrink below its
          text's content width (the default min-width:auto). rtl-text is
          the other half, per globals.css's own note: <T>'s dir fixes how
          the characters within the line read, not where the line sits in
          its box — without the ancestor's own text-align:right, a long
          label hugs the left edge and overflows past the tile instead of
          wrapping flush right. */}
      <span className="min-w-0 font-sans text-[13.5px] font-semibold text-dp-on-surface leading-tight break-words rtl-text">
        <T k={labelKey} />
      </span>
    </Link>
  )
}

export function VillageServicesQuickLinks() {
  const [expanded, setExpanded] = useState(false)
  const site = useSite()
  const { isUrdu } = useLocale()
  const isVisible = (l: { system: 'water_supply' | 'donors_projects' }) =>
    l.system === 'water_supply' ? site.waterSupplyEnabled : site.donorsEnabled
  const primaryLinks = PRIMARY_LINKS.filter(isVisible)
  const moreLinks = MORE_LINKS.filter(isVisible)

  return (
    <div className="mb-4 lg:mb-6">
      {/* Phase 2, 2026-09-30 — "a big Emergency button", per the vision doc,
          on its own row above the other quick links so it's never mistaken
          for just another utility link. */}
      <Link href="/emergency" dir={isUrdu ? 'rtl' : 'ltr'}
        className="flex items-center justify-center gap-2 bg-red-600 text-white rounded-lg py-3.5 font-sans text-[15px] font-bold hover:bg-red-700 transition-all mb-3">
        <Siren size={20} /> <T k="em.pageTitle" />
      </Link>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {primaryLinks.map((l) => (
          <Tile key={l.href} href={l.href} icon={l.icon} labelKey={l.key} tone={l.tone} />
        ))}
      </div>

      {expanded && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-3">
          {moreLinks.map((l) => (
            <Tile key={l.href} href={l.href} icon={l.icon} labelKey={l.key} tone={l.tone} />
          ))}
        </div>
      )}

      {moreLinks.length > 0 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          dir={isUrdu ? 'rtl' : 'ltr'}
          className="w-full flex items-center justify-center gap-1.5 mt-3 py-2 font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer"
        >
          <T k={expanded ? 'home.showLess' : 'home.viewAll'} />
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      )}
    </div>
  )
}
