'use client'

import Link from 'next/link'
import { PhoneCall, Search, AlertTriangle, Megaphone, Siren, ShoppingBag, BookOpen, CalendarDays, MapPin, Trophy, Wheat } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Real gap, 2026-09-30: these public pages (Contacts, Lost & Found, Civic
// Reports, Notice Board, Buy & Sell) only ever linked from the footer --
// easy to miss for the actual audience (village residents, not people who
// habitually scroll to a footer). One row of tappable tiles, right where
// eyes actually land on the homepage, on every screen size (unlike
// HomeMobileQuickActions, which is phone-only).
const links = [
  { href: '/contacts', icon: PhoneCall, key: 'ic.pageTitle', tone: 'bg-red-50 text-red-600' },
  { href: '/classifieds', icon: ShoppingBag, key: 'cl.pageTitle', tone: 'bg-violet-50 text-violet-600' },
  { href: '/lost-found', icon: Search, key: 'lf.pageTitle', tone: 'bg-amber-50 text-amber-600' },
  { href: '/civic-reports', icon: AlertTriangle, key: 'cr.pageTitle', tone: 'bg-sky-50 text-sky-600' },
  { href: '/notice-board', icon: Megaphone, key: 'nb.pageTitle', tone: 'bg-emerald-50 text-emerald-600' },
  { href: '/directory', icon: BookOpen, key: 'dir.pageTitle', tone: 'bg-teal-50 text-teal-600' },
  { href: '/events', icon: CalendarDays, key: 've.pageTitle', tone: 'bg-indigo-50 text-indigo-600' },
  { href: '/village-map', icon: MapPin, key: 'vm.pageTitle', tone: 'bg-rose-50 text-rose-600' },
  { href: '/sports', icon: Trophy, key: 'sp.pageTitle', tone: 'bg-amber-50 text-amber-700' },
  { href: '/agriculture', icon: Wheat, key: 'ag.pageTitle', tone: 'bg-lime-50 text-lime-700' },
]

export function VillageServicesQuickLinks() {
  const { t } = useLocale()
  return (
    <div className="mb-4 lg:mb-6">
      {/* Phase 2, 2026-09-30 — "a big Emergency button", per the vision doc,
          on its own row above the other quick links so it's never mistaken
          for just another utility link. */}
      <Link href="/emergency"
        className="flex items-center justify-center gap-2 bg-red-600 text-white rounded-lg py-3.5 font-sans text-[15px] font-bold hover:bg-red-700 transition-all mb-3">
        <Siren size={20} /> {t('em.pageTitle')}
      </Link>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {links.map((l) => (
          <Link key={l.href} href={l.href}
            className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center gap-3 hover:border-dp-secondary transition-all">
            <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${l.tone}`}>
              <l.icon size={18} />
            </span>
            <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface leading-tight">{t(l.key)}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
