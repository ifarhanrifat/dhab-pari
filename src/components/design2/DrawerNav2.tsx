'use client'
import Link from 'next/link'
import {
  Home, Droplet, HeartCrack, FolderKanban, Briefcase, ShoppingBag, Wheat, HandHeart, HandCoins,
  Newspaper, Video, Image as ImageIcon, Users, PhoneCall, Search, AlertTriangle, Megaphone, Siren,
  BookOpen, MapPin, Trophy, Landmark, CalendarDays, Moon, Sparkles, GraduationCap, School,
  MessageSquare, HeartCrack as HeartIcon, X, ShieldCheck, LogOut,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'

// Phase 1 of the card-based redesign, 2026-10-12. The new design's side
// drawer, built from the SAME real navLinks the current Header.tsx
// already gates by site.waterSupplyEnabled/donorsEnabled -- not a
// hand-typed copy of the template's own 13-item list -- plus a "More"
// section covering every public page that has neither a top-nav link
// nor a homepage quick-tile today (the missing-feature audit from the
// redesign plan), so nothing existing becomes unreachable just because
// the new design's own screenshots didn't happen to show it.
const MAIN_LINKS: { href: string; label: string; tKey: string; icon: typeof Home; system?: 'water_supply' | 'donors_projects' }[] = [
  { href: '/', label: 'Home', tKey: 'site.home', icon: Home },
  { href: '/water', label: 'Water Bill', tKey: 'site.waterBill', icon: Droplet, system: 'water_supply' },
  { href: '/blood', label: 'Blood', tKey: 'site.blood', icon: HeartCrack, system: 'donors_projects' },
  { href: '/projects', label: 'Projects', tKey: 'site.projects', icon: FolderKanban, system: 'donors_projects' },
  { href: '/jobs', label: 'Jobs', tKey: 'site.jobs', icon: Briefcase, system: 'donors_projects' },
  { href: '/marketplace', label: 'Marketplace', tKey: 'site.accounts', icon: ShoppingBag, system: 'donors_projects' },
  { href: '/agriculture', label: 'Agriculture', tKey: 'ag.pageTitle', icon: Wheat, system: 'donors_projects' },
  { href: '/donate', label: 'Donate', tKey: 'site.donate', icon: HandCoins, system: 'donors_projects' },
  { href: '/welfare', label: 'Welfare', tKey: 'site.welfare', icon: HandHeart, system: 'donors_projects' },
  { href: '/news', label: 'News', tKey: 'site.news', icon: Newspaper, system: 'donors_projects' },
  { href: '/videos', label: 'Videos', tKey: 'site.videos', icon: Video, system: 'donors_projects' },
  { href: '/gallery', label: 'Gallery', tKey: 'site.gallery', icon: ImageIcon, system: 'donors_projects' },
  { href: '/about', label: 'Committee', tKey: 'site.committee', icon: Users },
]

const MORE_LINKS: { href: string; label: string; tKey: string; icon: typeof Home; system?: 'water_supply' | 'donors_projects' }[] = [
  { href: '/contacts', label: 'Important Contacts', tKey: 'ic.pageTitle', icon: PhoneCall, system: 'donors_projects' },
  { href: '/lost-found', label: 'Lost & Found', tKey: 'lf.pageTitle', icon: Search, system: 'donors_projects' },
  { href: '/civic-reports', label: 'Village Problems', tKey: 'cr.pageTitle', icon: AlertTriangle, system: 'donors_projects' },
  { href: '/notice-board', label: 'Notice Board', tKey: 'nb.pageTitle', icon: Megaphone, system: 'donors_projects' },
  { href: '/emergency', label: 'Emergency', tKey: 'em.pageTitle', icon: Siren, system: 'donors_projects' },
  { href: '/classifieds', label: 'Buy & Sell', tKey: 'cl.pageTitle', icon: ShoppingBag, system: 'donors_projects' },
  { href: '/directory', label: 'Directory', tKey: 'dir.pageTitle', icon: BookOpen, system: 'donors_projects' },
  { href: '/weather', label: 'Weather', tKey: 'wx.pageTitle', icon: CalendarDays },
  { href: '/village-map', label: 'Village Map', tKey: 'vm.pageTitle', icon: MapPin, system: 'donors_projects' },
  { href: '/sports', label: 'Sports', tKey: 'sp.pageTitle', icon: Trophy, system: 'donors_projects' },
  { href: '/talent', label: 'Talent Showcase', tKey: 'tal.pageTitle', icon: Sparkles, system: 'donors_projects' },
  { href: '/education', label: 'Institute Directory', tKey: 'edu.pageTitle', icon: School, system: 'donors_projects' },
  { href: '/achievements', label: 'Achievements', tKey: 'ach.pageTitle', icon: Trophy, system: 'donors_projects' },
  { href: '/moon-finder', label: 'Moon Finder', tKey: 'mf.pageTitle', icon: Moon },
  { href: '/sadqa-jariya', label: 'Sadqa Jariya', tKey: 'sj.pageTitle', icon: Landmark, system: 'donors_projects' },
  { href: '/death-announcements', label: 'Death Announcements', tKey: 'da.pageTitle', icon: HeartIcon, system: 'donors_projects' },
  { href: '/entertainment', label: 'Entertainment', tKey: 'ent.pageTitle', icon: GraduationCap, system: 'donors_projects' },
  { href: '/suggestions', label: 'Suggestions', tKey: 'sug.pageTitle', icon: MessageSquare, system: 'donors_projects' },
]

export function DrawerNav2({
  open, onClose, isPortalUser, isStaffUser,
}: {
  open: boolean
  onClose: () => void
  isPortalUser: boolean
  isStaffUser: boolean
}) {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const visible = (l: { system?: 'water_supply' | 'donors_projects' }) =>
    l.system === 'water_supply' ? site.waterSupplyEnabled : l.system === 'donors_projects' ? site.donorsEnabled : true

  if (!open) return null

  return (
    <div dir="ltr" onClick={onClose} className="absolute inset-0 z-[55] bg-slate-900/55 flex justify-start animate-in fade-in duration-200">
      <aside
        dir={isUrdu ? 'rtl' : 'ltr'}
        onClick={(e) => e.stopPropagation()}
        className="w-[80%] max-w-[330px] h-full bg-[#033a22] text-white flex flex-col overflow-y-auto shadow-[8px_0_30px_rgba(0,0,0,.35)] animate-in slide-in-from-left duration-250"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 w-8 h-8 rounded-full bg-dp2-gold text-[#033a22] flex items-center justify-center font-urdu font-bold text-[14px]">
              {(isUrdu ? site.nameUrdu : site.name).charAt(0)}
            </span>
            <span className="text-[13px] font-bold truncate">{isUrdu ? site.nameUrdu : site.name}</span>
          </div>
          <button onClick={onClose} aria-label="close" className="shrink-0 w-8 h-8 flex items-center justify-center cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <nav className="flex flex-col gap-0.5 px-2.5 py-2">
          {MAIN_LINKS.filter(visible).map((link) => (
            <Link key={link.href} href={link.href} onClick={onClose}
              className="flex items-center gap-2.5 w-full rounded-xl px-3 py-2 text-[13px] font-medium hover:bg-white/10 transition-colors">
              <link.icon size={16} className="shrink-0" />
              {t(link.tKey, link.label)}
            </Link>
          ))}
        </nav>

        <div className="px-4 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-white/40">
          {t('y.moreServices', 'More')}
        </div>
        <nav className="flex flex-col gap-0.5 px-2.5 pb-2">
          {MORE_LINKS.filter(visible).map((link) => (
            <Link key={link.href} href={link.href} onClick={onClose}
              className="flex items-center gap-2.5 w-full rounded-xl px-3 py-1.5 text-[12px] font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors">
              <link.icon size={14} className="shrink-0" />
              {t(link.tKey, link.label)}
            </Link>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2 px-3.5 pt-3 pb-5 border-t border-white/10">
          {isStaffUser ? (
            <Link href="/admin" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2 bg-sky-600 text-white text-[13px] font-bold">
              <ShieldCheck size={15} /> {t('site.adminPanel')}
            </Link>
          ) : isPortalUser ? (
            <Link href="/portal" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2 bg-dp2-gold text-[#0f172a] text-[13px] font-bold">
              <ShieldCheck size={15} /> {t('site.myPortal')}
            </Link>
          ) : (
            <Link href="/portal/login" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2 border border-white/30 text-white text-[13px] font-bold">
              <LogOut size={15} /> {t('site.login')}
            </Link>
          )}
          <Link href="/admin" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2 border border-white/20 text-white/80 text-[12px] font-semibold">
            {t('y.staffLogIn')}
          </Link>
        </div>
      </aside>
    </div>
  )
}
