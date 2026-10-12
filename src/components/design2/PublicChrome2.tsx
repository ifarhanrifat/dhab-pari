'use client'
import { useState, type ReactNode } from 'react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Header2 } from './Header2'
import { Footer2 } from './Footer2'
import { BottomNav2 } from './BottomNav2'
import { DrawerNav2 } from './DrawerNav2'

// Phase 2 of the card-based redesign, 2026-10-12. The shared chrome every
// re-skinned public page (other than the homepage, which builds its own
// copy inline in Home2) mounts via (public2)/layout.tsx -- same
// Header2/Footer2/BottomNav2/DrawerNav2 Phase 1 already built and
// verified, just reused instead of re-authored per page.
export function PublicChrome2({ children }: { children: ReactNode }) {
  const { isUrdu } = useLocale()
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-h-full flex flex-col bg-dp2-surface relative">
      <Header2 />
      <main className="flex-1 pb-20 lg:pb-8">
        <div className="max-w-[1200px] mx-auto px-3.5 lg:px-8 py-3.5 flex flex-col gap-4">
          {children}
          <Footer2 />
        </div>
      </main>
      <BottomNav2 onOpenMore={() => setDrawerOpen(true)} />
      <DrawerNav2 open={drawerOpen} onClose={() => setDrawerOpen(false)} isPortalUser={false} isStaffUser={false} />
    </div>
  )
}
