import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { AppealBar } from '@/components/layout/AppealBar'
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
      {/* Below the header, not above it: an appeal should sit against the page
          content it interrupts, and the announcement ticker keeps the top slot
          it has always had. */}
      <AppealBar source="public" />
      <main className="flex-1">{children}</main>
      <Footer />
      <BottomNav />
      {/* Bottom padding on mobile so content isn't hidden behind bottom nav */}
      <div className="h-16 md:hidden" />
    </MobileNavProvider>
  )
}
