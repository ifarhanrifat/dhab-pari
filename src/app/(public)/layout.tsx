import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { BottomNav } from '@/components/layout/BottomNav'
import { MobileNavProvider } from '@/components/layout/MobileNavContext'

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <MobileNavProvider>
      <AnnouncementBar />
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
      <BottomNav />
      {/* Bottom padding on mobile so content isn't hidden behind bottom nav —
          matches BottomNav's own safe-area-aware height (viewport.viewportFit
          'cover' in the root layout is what makes the env() value non-zero
          on an iPhone's home-indicator area). */}
      <div className="md:hidden" style={{ height: 'calc(3.5rem + max(0.75rem, env(safe-area-inset-bottom)))' }} />
    </MobileNavProvider>
  )
}
