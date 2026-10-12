'use client'
import { usePathname, useRouter } from 'next/navigation'
import { Home, FolderKanban, HandCoins, Video, Menu } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'

// Phase 1 of the card-based redesign, 2026-10-12. The new design's
// 5-item bottom nav (Home/Projects/Donate/Videos/More), real routes,
// gated the same as everything else by site.donorsEnabled -- a
// water-only tenant gets Water Bill in Projects' place instead of a
// dead donors_projects link.
export function BottomNav2({ onOpenMore }: { onOpenMore: () => void }) {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const pathname = usePathname()
  const router = useRouter()

  const items = [
    { href: '/', tKey: 'site.home', label: 'Home', icon: Home },
    site.donorsEnabled
      ? { href: '/projects', tKey: 'site.projects', label: 'Projects', icon: FolderKanban }
      : { href: '/water', tKey: 'site.waterBill', label: 'Water Bill', icon: FolderKanban },
    { href: '/donate', tKey: 'site.donate', label: 'Donate', icon: HandCoins, system: 'donors_projects' as const },
    { href: '/videos', tKey: 'site.videos', label: 'Videos', icon: Video, system: 'donors_projects' as const },
  ].filter((i) => i.system !== 'donors_projects' || site.donorsEnabled)

  return (
    <nav dir={isUrdu ? 'rtl' : 'ltr'} className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-dp2-card-border flex justify-around items-center py-1.5 pb-[calc(6px+env(safe-area-inset-bottom,0px))] shadow-[0_-4px_10px_rgba(0,0,0,.05)] z-30">
      {items.map((item) => {
        const active = pathname === item.href
        return (
          <button
            key={item.href}
            onClick={() => router.push(item.href)}
            className="flex flex-col items-center gap-0.5 px-1.5 py-0.5 cursor-pointer"
            style={{ color: active ? '#005A36' : '#94a3b8' }}
          >
            <item.icon size={17} strokeWidth={active ? 2.5 : 2} />
            <span className="text-[9px]" style={{ fontWeight: active ? 700 : 500 }}>{t(item.tKey, item.label)}</span>
          </button>
        )
      })}
      <button onClick={onOpenMore} className="flex flex-col items-center gap-0.5 px-1.5 py-0.5 text-slate-400 cursor-pointer">
        <Menu size={17} />
        <span className="text-[9px] font-medium">{t('y.more', 'More')}</span>
      </button>
    </nav>
  )
}
