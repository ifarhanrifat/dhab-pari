'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  PhoneCall, Search, AlertTriangle, Megaphone, Siren, ShoppingBag, BookOpen, CalendarDays, MapPin, Trophy, Wheat, Landmark,
  Droplet, HeartHandshake, Newspaper, ChevronDown, ChevronUp,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

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
const PRIMARY_LINKS = [
  { href: '/water', icon: Droplet, key: 'home.payWaterBill', tone: 'bg-sky-50 text-sky-700' },
  { href: '/chanda', icon: Landmark, key: 'ch.pageTitle', tone: 'bg-emerald-50 text-emerald-700' },
  { href: '/contacts', icon: PhoneCall, key: 'ic.pageTitle', tone: 'bg-red-50 text-red-600' },
  { href: '/classifieds', icon: ShoppingBag, key: 'cl.pageTitle', tone: 'bg-violet-50 text-violet-600' },
]

const MORE_LINKS = [
  { href: '/blood', icon: Droplet, key: 'home.requestBlood', tone: 'bg-rose-50 text-rose-600' },
  { href: '/welfare', icon: HeartHandshake, key: 'home.needHelp', tone: 'bg-pink-50 text-pink-600' },
  { href: '/lost-found', icon: Search, key: 'lf.pageTitle', tone: 'bg-amber-50 text-amber-600' },
  { href: '/civic-reports', icon: AlertTriangle, key: 'cr.pageTitle', tone: 'bg-sky-50 text-sky-600' },
  { href: '/notice-board', icon: Megaphone, key: 'nb.pageTitle', tone: 'bg-orange-50 text-orange-600' },
  { href: '/news', icon: Newspaper, key: 'home.villageNews', tone: 'bg-slate-100 text-slate-700' },
  { href: '/directory', icon: BookOpen, key: 'dir.pageTitle', tone: 'bg-teal-50 text-teal-600' },
  { href: '/events', icon: CalendarDays, key: 've.pageTitle', tone: 'bg-indigo-50 text-indigo-600' },
  { href: '/village-map', icon: MapPin, key: 'vm.pageTitle', tone: 'bg-rose-50 text-rose-600' },
  { href: '/sports', icon: Trophy, key: 'sp.pageTitle', tone: 'bg-amber-50 text-amber-700' },
  { href: '/agriculture', icon: Wheat, key: 'ag.pageTitle', tone: 'bg-lime-50 text-lime-700' },
]

function Tile({ href, icon: Icon, label, tone }: { href: string; icon: typeof PhoneCall; label: string; tone: string }) {
  return (
    <Link href={href}
      className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center gap-3 hover:border-dp-secondary transition-all">
      <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${tone}`}>
        <Icon size={18} />
      </span>
      <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface leading-tight">{label}</span>
    </Link>
  )
}

export function VillageServicesQuickLinks() {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-4 lg:mb-6">
      {/* Phase 2, 2026-09-30 — "a big Emergency button", per the vision doc,
          on its own row above the other quick links so it's never mistaken
          for just another utility link. */}
      <Link href="/emergency"
        className="flex items-center justify-center gap-2 bg-red-600 text-white rounded-lg py-3.5 font-sans text-[15px] font-bold hover:bg-red-700 transition-all mb-3">
        <Siren size={20} /> {t('em.pageTitle')}
      </Link>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {PRIMARY_LINKS.map((l) => (
          <Tile key={l.href} href={l.href} icon={l.icon} label={t(l.key)} tone={l.tone} />
        ))}
      </div>

      {expanded && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-3">
          {MORE_LINKS.map((l) => (
            <Tile key={l.href} href={l.href} icon={l.icon} label={t(l.key)} tone={l.tone} />
          ))}
        </div>
      )}

      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-center gap-1.5 mt-3 py-2 font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer"
      >
        {expanded ? t('home.showLess') : t('home.viewAll')}
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    </div>
  )
}
