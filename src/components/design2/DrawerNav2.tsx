'use client'
import { useEffect } from 'react'
import Link from 'next/link'
import {
  Home, Droplet, HeartCrack, FolderKanban, Briefcase, ShoppingBag, Wheat, HandHeart, HandCoins,
  Newspaper, Video, Image as ImageIcon, Users, PhoneCall, AlertTriangle, Megaphone, Siren,
  BookOpen, X, ShieldCheck, LogOut,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'

// Phase 1 of the card-based redesign, 2026-10-12. The new design's side
// drawer, built from the SAME real navLinks the current Header.tsx
// already gates by site.waterSupplyEnabled/donorsEnabled -- not a
// hand-typed copy of the template's own 13-item list -- plus a "More"
// section for the handful of other pages worth one tap from the primary
// menu. Trimmed down 2026-10-12 (real ask, live on device: "unwanted
// links... too long") from the original every-remaining-page list -- see
// Footer2 for where the rest of those pages now live instead.
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

// Trimmed down to the handful actually reached for often, real ask live
// on device -- the rest (Lost & Found, Weather, Village Map, Sports,
// Talent Showcase, Institute Directory, Achievements, Moon Finder, Sadqa
// Jariya, Death Announcements, Entertainment, Suggestions) still have a
// real path: Footer2's own quick-links list, fixed the same day to be
// actual <Link>s instead of inert text chips, covers every one of them --
// nothing here is actually unreachable, just off the primary menu.
const MORE_LINKS: { href: string; label: string; tKey: string; icon: typeof Home; system?: 'water_supply' | 'donors_projects' }[] = [
  { href: '/contacts', label: 'Important Contacts', tKey: 'ic.pageTitle', icon: PhoneCall, system: 'donors_projects' },
  { href: '/civic-reports', label: 'Village Problems', tKey: 'cr.pageTitle', icon: AlertTriangle, system: 'donors_projects' },
  { href: '/notice-board', label: 'Notice Board', tKey: 'nb.pageTitle', icon: Megaphone, system: 'donors_projects' },
  { href: '/emergency', label: 'Emergency', tKey: 'em.pageTitle', icon: Siren, system: 'donors_projects' },
  { href: '/classifieds', label: 'Buy & Sell', tKey: 'cl.pageTitle', icon: ShoppingBag, system: 'donors_projects' },
  { href: '/directory', label: 'Directory', tKey: 'dir.pageTitle', icon: BookOpen, system: 'donors_projects' },
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

  // Real bug found live on device: the page behind the drawer kept
  // scrolling along with it (two real symptoms at once -- the backdrop
  // was `absolute inset-0`, sized against its positioned ancestor, which
  // is Home2's own root div, not the viewport. That root div is as tall
  // as the ENTIRE scrollable homepage, so the drawer -- and the huge
  // empty gap above its login buttons, pushed by mt-auto to the bottom
  // of that same oversized box -- both trace back to the same mistake.
  // `fixed inset-0` pins both to the actual viewport instead, and the
  // body-scroll lock stops the page under it moving at all.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  // Real ask, live on device: the drawer should always dock to the
  // physical left and slide in from there, in both languages -- not the
  // reading-start edge (which would put it on the right under Urdu).
  // dir="ltr" has to be explicit here, not just omitted -- this div sits
  // inside Home2's own dir={isUrdu?'rtl':'ltr'} root, so leaving it
  // un-dir'd still inherits rtl under Urdu and justify-start docks right
  // anyway (confirmed live: that's exactly what omitting it did). Only
  // the drawer's own inner content gets dir= for correct RTL text/icon
  // order once it's open.
  return (
    <div dir="ltr" onClick={onClose} className="fixed inset-0 z-[55] bg-slate-900/55 flex justify-start animate-in fade-in duration-200">
      <aside
        dir={isUrdu ? 'rtl' : 'ltr'}
        onClick={(e) => e.stopPropagation()}
        // Real bug, live on device: this is `fixed`/viewport-pinned (via its
        // `h-full` + the backdrop's `fixed inset-0` parent), and a fixed
        // element does NOT inherit an ancestor's safe-area padding — same
        // bug already fixed on PortalSidebar/AdminSidebar's mobile drawers.
        // Without its own top inset, the header row (title + close button)
        // renders partly under the phone's status bar.
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        className="w-[62%] max-w-[230px] h-full bg-[#033a22] text-white flex flex-col overflow-y-auto shadow-[8px_0_30px_rgba(0,0,0,.35)] animate-in slide-in-from-left duration-250"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 w-8 h-8 rounded-full bg-dp2-gold text-[#033a22] flex items-center justify-center font-urdu font-bold text-[16px]">
              {(isUrdu ? site.nameUrdu : site.name).charAt(0)}
            </span>
            <span className="text-[15px] font-bold truncate">{isUrdu ? site.nameUrdu : site.name}</span>
          </div>
          <button onClick={onClose} aria-label="close" className="shrink-0 w-8 h-8 flex items-center justify-center cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <nav className="flex flex-col gap-0.5 px-2 py-2">
          {MAIN_LINKS.filter(visible).map((link) => (
            <Link key={link.href} href={link.href} onClick={onClose}
              className="flex items-center gap-2.5 w-full rounded-xl px-2.5 py-2.5 text-[16px] font-medium hover:bg-white/10 transition-colors">
              <link.icon size={19} className="shrink-0" />
              {t(link.tKey, link.label)}
            </Link>
          ))}
        </nav>

        <div className="px-3.5 pt-1.5 pb-2 text-[13px] font-bold uppercase tracking-wide text-white/40">
          {isUrdu ? 'مزید' : 'More'}
        </div>
        <nav className="flex flex-col gap-0.5 px-2 pb-2">
          {MORE_LINKS.filter(visible).map((link) => (
            <Link key={link.href} href={link.href} onClick={onClose}
              className="flex items-center gap-2.5 w-full rounded-xl px-2.5 py-2 text-[15px] font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors">
              <link.icon size={17} className="shrink-0" />
              {t(link.tKey, link.label)}
            </Link>
          ))}
        </nav>

        {/* Two fully independent entry points, real ask 2026-10-17: a
            person can hold a portal account, a staff account, both, or
            neither -- each button reflects only its own login state (filled
            gold when that one is actually signed in, outlined when it
            isn't), rather than one button's state deciding what the other
            one shows. Previously the staff-login link was hardcoded with
            no login-state check at all, so it always looked "empty" even
            when staff was actually signed in. */}
        <div className="mt-4 flex flex-col gap-2 px-3 pt-3 pb-5 border-t border-white/10">
          {isPortalUser ? (
            <Link href="/portal" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2.5 bg-dp2-gold text-[#0f172a] text-[15px] font-bold">
              <ShieldCheck size={16} /> {t('site.myPortal')}
            </Link>
          ) : (
            <Link href="/portal/login" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2.5 border border-white/30 text-white text-[15px] font-bold">
              <LogOut size={16} /> {t('site.login')}
            </Link>
          )}
          {isStaffUser ? (
            <Link href="/admin" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2.5 bg-dp2-gold text-[#0f172a] text-[15px] font-bold">
              <ShieldCheck size={16} /> {t('site.adminPanel')}
            </Link>
          ) : (
            <Link href="/admin/login" onClick={onClose} className="flex items-center justify-center gap-2 rounded-xl py-2.5 border border-white/20 text-white/80 text-[14px] font-semibold">
              {t('y.staffLogIn')}
            </Link>
          )}
        </div>
      </aside>
    </div>
  )
}
