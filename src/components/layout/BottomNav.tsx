'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, FolderKanban, Heart, Video, MoreHorizontal } from 'lucide-react'
import { useMobileNav } from './MobileNavContext'

const tabs = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/donate', label: 'Donate', icon: Heart },
  { href: '/videos', label: 'Videos', icon: Video },
]

export function BottomNav() {
  const pathname = usePathname()
  const { setOpen } = useMobileNav()

  return (
    <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-2 py-3 md:hidden bg-dp-primary border-t border-dp-outline-variant shadow-lg">
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
              {tab.label}
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
        <span className="text-[10px] font-sans font-semibold tracking-[0.05em] mt-0.5">More</span>
      </button>
    </nav>
  )
}
