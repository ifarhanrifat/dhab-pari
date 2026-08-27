'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, FolderKanban, Heart, Video, MoreHorizontal } from 'lucide-react'
import { useMobileNav } from './MobileNavContext'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const tabs = [
  { href: '/', tKey: 'site.home', label: 'Home', icon: Home },
  { href: '/projects', tKey: 'site.projects', label: 'Projects', icon: FolderKanban },
  { href: '/donate', tKey: 'site.donate', label: 'Donate', icon: Heart },
  { href: '/videos', tKey: 'site.videos', label: 'Videos', icon: Video },
]

export function BottomNav() {
  const { t } = useLocale()
  const pathname = usePathname()
  const { setOpen } = useMobileNav()

  return (
    <nav
      className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-2 pt-3 md:hidden bg-dp-primary border-t border-dp-outline-variant shadow-lg"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      {tabs.map((tab) => {
        const isActive = pathname === tab.href
        const Icon = tab.icon
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex flex-col items-center justify-center transition-transform active:scale-95 ${
              isActive
                ? 'bg-dp-secondary-container text-dp-on-secondary-container rounded-full px-4 py-1'
                : 'text-white/70'
            }`}
          >
            <Icon size={20} fill={isActive ? 'currentColor' : 'none'} />
            <span className="text-[10px] font-sans font-semibold tracking-[0.05em] mt-0.5">
              {t(tab.tKey, tab.label)}
            </span>
          </Link>
        )
      })}

      {/* Opens the same slide-out menu as the header's button. This used to be
          a <Link href="/more"> to a page that does not exist, so tapping it
          404'd — and Next.js prefetched that 404 on every page load. */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="flex flex-col items-center justify-center text-white/70 transition-transform active:scale-95 cursor-pointer"
      >
        <MoreHorizontal size={20} />
        <span className="text-[10px] font-sans font-semibold tracking-[0.05em] mt-0.5">{t('y.more')}</span>
      </button>
    </nav>
  )
}
